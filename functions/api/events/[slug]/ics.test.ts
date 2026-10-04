import ICAL from "ical.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../../../../src/core/identity";
import { createTestEnv, insertBreak, insertEvent, type TestEnv } from "../../../../src/test/db";
import { onRequestPost } from "./bookings";
import { onRequestGet } from "./ics";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const SLOT = "2026-06-13T08:15:00Z";

const getUrl = (slug: string, url: string): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(url),
      env: t.env,
      params: { slug },
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

const query = (q: Record<string, string>): string => new URLSearchParams(q).toString();

const getIcs = (slug: string, slot: string | null, dog: string | null, handler: string | null): Promise<Response> => {
  const q: Record<string, string> = {};
  if (slot !== null) q.slot = slot;
  if (dog !== null) q.dog = dog;
  if (handler !== null) q.handler = handler;
  return getUrl(slug, `http://localhost/api/events/${slug}/ics?${query(q)}`);
};

async function book(eventId: number, slot: string, dog: string, handler: string, createdAt?: string): Promise<void> {
  await t.env.DB.prepare(
    `INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key${createdAt ? ", created_at" : ""})
     VALUES (?, ?, ?, ?, ?, ?${createdAt ? ", ?" : ""})`,
  )
    .bind(eventId, slot, dog, handler, identityKey(dog), identityKey(handler), ...(createdAt ? [createdAt] : []))
    .run();
}

function vevent(ics: string): ICAL.Event {
  const root = new ICAL.Component(ICAL.parse(ics));
  return new ICAL.Event(root.getFirstSubcomponent("vevent")!);
}

const uidOf = (ics: string): string => vevent(ics).uid;

describe("GET /api/events/:slug/ics", () => {
  it("returns the .ics for an existing booking, with headers and parseable content", async () => {
    const { id, slug } = await insertEvent(t.env.DB, {
      name: "Summer show", costPence: 1250, venuePostcode: "SW1A 1AA", details: "Bring water",
    });
    await book(id, SLOT, "Rex", "Sam Jones");
    const res = await getIcs(slug, SLOT, "Rex", "Sam Jones");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="booking.ics"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ev = vevent(await res.text());
    expect(ev.summary).toContain("Rex");
    expect(ev.summary).toContain("Summer show");
    expect(ev.location).toBe("SW1A 1AA");
    expect(ev.description).toContain("£12.50");
    expect(ev.description).toContain("Bring water");
    expect(ev.description).toContain("Sam Jones");
    expect(ev.startDate.toJSDate().toISOString()).toBe("2026-06-13T08:15:00.000Z");
    expect(ev.endDate.toJSDate().toISOString()).toBe("2026-06-13T08:30:00.000Z");
  });

  it("is byte-identical on two fetches", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, SLOT, "Rex", "Sam Jones");
    const a = await (await getIcs(slug, SLOT, "Rex", "Sam Jones")).text();
    const b = await (await getIcs(slug, SLOT, "Rex", "Sam Jones")).text();
    expect(a).toBe(b);
  });

  it("uses the booking's created_at as DTSTAMP", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, SLOT, "Rex", "Sam Jones", "2026-05-01T12:34:56Z");
    const text = await (await getIcs(slug, SLOT, "Rex", "Sam Jones")).text();
    expect(text).toContain("\r\nDTSTAMP:20260501T123456Z\r\n");
    const { results } = await t.env.DB.prepare("SELECT created_at FROM bookings WHERE event_id = ?").bind(id).all<{ created_at: string }>();
    expect(results[0].created_at).toBe("2026-05-01T12:34:56Z");
  });

  it("has a stable UID: same for identity variants, different across events and identities", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    await book(a.id, SLOT, "Zoë", "Sam Jones");
    await book(a.id, "2026-06-13T08:30:00Z", "Rex", "Sam Jones");
    await book(b.id, SLOT, "Zoë", "Sam Jones");
    const uidA = uidOf(await (await getIcs(a.slug, SLOT, "Zoë", "Sam Jones")).text());
    expect(uidA).toMatch(/^[0-9a-f]{32}@slot-booker$/);
    // Variants of the same identity find the same booking and give the same UID.
    expect(uidOf(await (await getIcs(a.slug, SLOT, "ZOË", " sam   jones ")).text())).toBe(uidA);
    expect(uidOf(await (await getIcs(a.slug, SLOT, "Zoë", "SAM JONES")).text())).toBe(uidA);
    expect(uidOf(await (await getIcs(b.slug, SLOT, "Zoë", "Sam Jones")).text())).not.toBe(uidA);
    expect(uidOf(await (await getIcs(a.slug, "2026-06-13T08:30:00Z", "Rex", "Sam Jones")).text())).not.toBe(uidA);
  });

  it("keeps the UID when the booking's slot is moved by an admin", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, SLOT, "Rex", "Sam Jones");
    const before = uidOf(await (await getIcs(slug, SLOT, "Rex", "Sam Jones")).text());
    await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = ? WHERE event_id = ?").bind("2026-06-13T09:00:00Z", id).run();
    const after = uidOf(await (await getIcs(slug, "2026-06-13T09:00:00Z", "Rex", "Sam Jones")).text());
    expect(after).toBe(before);
  });

  it("shows the names as entered, and survives commas, semicolons and emoji", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { name: "Fun; games, etc." });
    const dog = "Rex, the 2nd; 🐕 (good boy)";
    await book(id, SLOT, dog, "Sam \\ Jones, Esq.");
    const ev = vevent(await (await getIcs(slug, SLOT, dog, "Sam \\ Jones, Esq.")).text());
    expect(ev.summary).toBe(`${dog} – Fun; games, etc.`);
    expect(ev.description).toContain(`Dog: ${dog}`);
    expect(ev.description).toContain("Handler: Sam \\ Jones, Esq.");
  });

  it("never contains other bookings' names", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, SLOT, "Rex", "Sam Jones");
    await book(id, "2026-06-13T08:30:00Z", "Zxqotherdog", "Zxqotherhandler");
    const text = await (await getIcs(slug, SLOT, "Rex", "Sam Jones")).text();
    expect(text).not.toMatch(/Zxq/);
  });

  it("still serves an archived event's existing booking", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { archived: true });
    await book(id, SLOT, "Rex", "Sam Jones");
    expect((await getIcs(slug, SLOT, "Rex", "Sam Jones")).status).toBe(200);
  });

  it("returns an identical generic 404 for everything that is not an existing booking", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const other = await insertEvent(t.env.DB);
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    await book(id, SLOT, "Rex", "Sam Jones");
    await book(id, "2026-06-13T09:00:00Z", "Orphan", "Slot"); // in a break: not in the schedule
    await book(other.id, "2026-06-13T10:00:00Z", "Fido", "Ann Lee");
    const cases: [string, Promise<Response>][] = [
      ["unknown event", getIcs("unknownslug0123456789", SLOT, "Rex", "Sam Jones")],
      ["malformed slug", getIcs("short", SLOT, "Rex", "Sam Jones")],
      ["unknown booking", getIcs(slug, SLOT, "Nobody", "Sam Jones")],
      ["wrong slot", getIcs(slug, "2026-06-13T08:30:00Z", "Rex", "Sam Jones")],
      ["wrong handler", getIcs(slug, SLOT, "Rex", "Ann Lee")],
      ["wrong dog", getIcs(slug, SLOT, "Fido", "Sam Jones")],
      ["booking in another event", getIcs(slug, "2026-06-13T10:00:00Z", "Fido", "Ann Lee")],
      ["slot no longer in the schedule", getIcs(slug, "2026-06-13T09:00:00Z", "Orphan", "Slot")],
      ["missing slot", getIcs(slug, null, "Rex", "Sam Jones")],
      ["missing dog", getIcs(slug, SLOT, null, "Sam Jones")],
      ["missing handler", getIcs(slug, SLOT, "Rex", null)],
      ["blank dog", getIcs(slug, SLOT, "   ", "Sam Jones")],
      ["blank handler", getIcs(slug, SLOT, "Rex", "")],
      ["no query at all", getUrl(slug, `http://localhost/api/events/${slug}/ics`)],
    ];
    const bodies = new Set<string>();
    for (const [label, pending] of cases) {
      const res = await pending;
      expect(res.status, label).toBe(404);
      expect(res.headers.get("content-type"), label).toContain("application/json");
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      expect(res.headers.get("content-disposition"), label).toBeNull();
      const text = await res.text();
      expect(JSON.parse(text).error.code, label).toBe("not_found");
      bodies.add(text);
    }
    expect(bodies.size).toBe(1);
  });

  it("is offered by POST as icsUrl, and following it returns the booking just made", async () => {
    const { slug } = await insertEvent(t.env.DB, { venuePostcode: "SW1A 1AA" });
    const res = await Promise.resolve(
      onRequestPost({
        request: new Request(`http://localhost/api/events/${slug}/bookings`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: SLOT, dogName: "  Zoë & Co ", handlerName: "Sam #1 " }),
        }),
        env: t.env,
        params: { slug },
      } as unknown as Parameters<typeof onRequestPost>[0]),
    );
    expect(res.status).toBe(201);
    const { icsUrl } = (await res.json()) as { icsUrl: string };
    expect(icsUrl).toBe(
      `/api/events/${slug}/ics?slot=2026-06-13T08%3A15%3A00Z&dog=Zo%C3%AB%20%26%20Co&handler=Sam%20%231`,
    );
    const followed = await getUrl(slug, new URL(icsUrl, "http://localhost").href);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(vevent(await followed.text()).summary).toContain("Zoë & Co");
  });
});
