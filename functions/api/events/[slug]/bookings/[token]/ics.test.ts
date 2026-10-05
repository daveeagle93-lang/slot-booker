import ICAL from "ical.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateBookingToken } from "../../../../../../src/core/slug";
import { identityKey } from "../../../../../../src/core/identity";
import { createTestEnv, insertBreak, insertEvent, type TestEnv } from "../../../../../../src/test/db";
import { bookingUid } from "../../../../../../src/server/ics";
import { saveSettings } from "../../../../../../src/server/settings";
import { onRequestPost } from "../../bookings";
import { onRequestGet } from "./ics";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  // The POST test books an event dated 2026-06-13, so the clock must be before it (Date only; timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
});
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

const SLOT = "2026-06-13T08:15:00Z";

const getIcs = (slug: string, token: string): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`http://localhost/api/events/${slug}/bookings/${token}/ics`),
      env: t.env,
      params: { slug, token },
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

/** Inserts a booking row directly and returns its token (pass token: null for a legacy row with none). */
async function book(
  eventId: number, slot: string, dog: string, handler: string,
  o: { createdAt?: string; token?: string | null } = {},
): Promise<string> {
  const token = o.token === undefined ? generateBookingToken() : o.token;
  await t.env.DB.prepare(
    `INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token${o.createdAt ? ", created_at" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?${o.createdAt ? ", ?" : ""})`,
  )
    .bind(eventId, slot, dog, handler, identityKey(dog), identityKey(handler), token, ...(o.createdAt ? [o.createdAt] : []))
    .run();
  return token as string;
}

function vevent(ics: string): ICAL.Event {
  const root = new ICAL.Component(ICAL.parse(ics));
  return new ICAL.Event(root.getFirstSubcomponent("vevent")!);
}

const uidOf = (ics: string): string => vevent(ics).uid;

describe("GET /api/events/:slug/bookings/:token/ics", () => {
  it("serves the .ics for a booking on an unlisted event", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { listed: false });
    const token = await book(id, SLOT, "Rex", "Sam");
    const res = await getIcs(slug, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
  });

  it("returns the .ics for an existing booking, with headers and parseable content", async () => {
    const { id, slug } = await insertEvent(t.env.DB, {
      name: "Summer show", costPence: 1250, venuePostcode: "SW1A 1AA", details: "Bring water",
    });
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const res = await getIcs(slug, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="booking.ics"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
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
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const a = await (await getIcs(slug, token)).text();
    const b = await (await getIcs(slug, token)).text();
    expect(a).toBe(b);
  });

  it("uses the booking's created_at as DTSTAMP", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones", { createdAt: "2026-05-01T12:34:56Z" });
    const text = await (await getIcs(slug, token)).text();
    expect(text).toContain("\r\nDTSTAMP:20260501T123456Z\r\n");
  });

  it("has a stable UID: same for identity variants, different across events and identities", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    const tokenA = await book(a.id, SLOT, "Zoë", "Sam Jones");
    const tokenOther = await book(a.id, "2026-06-13T08:30:00Z", "Rex", "Sam Jones");
    const tokenB = await book(b.id, SLOT, "Zoë", "Sam Jones");
    const uidA = uidOf(await (await getIcs(a.slug, tokenA)).text());
    expect(uidA).toBe(await bookingUid(a.slug, identityKey("Zoë"), identityKey("Sam Jones")));
    expect(uidA).toMatch(/^[0-9a-f]{32}@slot-booker$/);
    expect(uidOf(await (await getIcs(b.slug, tokenB)).text())).not.toBe(uidA);
    expect(uidOf(await (await getIcs(a.slug, tokenOther)).text())).not.toBe(uidA);
    // The same identity re-booked later (new token, differently typed) keeps its UID.
    await t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ? AND dog_key = ?").bind(a.id, identityKey("Zoë")).run();
    const tokenAgain = await book(a.id, "2026-06-13T09:00:00Z", "ZOË", " sam   jones ");
    expect(uidOf(await (await getIcs(a.slug, tokenAgain)).text())).toBe(uidA);
  });

  it("keeps the UID, and the same link, when the booking's slot is moved by an admin", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const before = uidOf(await (await getIcs(slug, token)).text());
    await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = ? WHERE event_id = ?").bind("2026-06-13T09:00:00Z", id).run();
    const moved = await getIcs(slug, token);
    expect(moved.status).toBe(200);
    const ev = vevent(await moved.text());
    expect(ev.uid).toBe(before);
    expect(ev.startDate.toJSDate().toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("shows the names as entered, and survives commas, semicolons and emoji", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { name: "Fun; games, etc." });
    const dog = "Rex, the 2nd; 🐕 (good boy)";
    const token = await book(id, SLOT, dog, "Sam \\ Jones, Esq.");
    const ev = vevent(await (await getIcs(slug, token)).text());
    expect(ev.summary).toBe(`${dog} – Fun; games, etc.`);
    expect(ev.description).toContain(`Dog: ${dog}`);
    expect(ev.description).toContain("Handler: Sam \\ Jones, Esq.");
  });

  it("starts the description with the club name when one is set, and is as before when it is not", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { details: "Bring water" });
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const before = await (await getIcs(slug, token)).text();
    const setClub = (clubName: string) => saveSettings(t.env.DB, { clubName, privacyContact: { name: "", email: "" }, website: "" });
    try {
      const name = "Hill, Dale; \\ Zoë 🐕 Club";
      await setClub(name);
      const text = await (await getIcs(slug, token)).text();
      expect(vevent(text).description.split("\n")[0]).toBe(name);
      expect(vevent(text).description).toContain("Dog: Rex");
      expect(text.replace(/\r\n /g, "")).toContain("DESCRIPTION:Hill\\, Dale\\; \\\\ Zoë 🐕 Club\\nDog: Rex");
      await setClub("");
      expect(await (await getIcs(slug, token)).text()).toBe(before);
    } finally {
      await setClub("");
    }
    expect(vevent(before).description.split("\n")[0]).toBe("Dog: Rex");
  });

  it("never contains other bookings' names", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    await book(id, "2026-06-13T08:30:00Z", "Zxqotherdog", "Zxqotherhandler");
    const text = await (await getIcs(slug, token)).text();
    expect(text).not.toMatch(/Zxq/);
  });

  it("still serves an archived event's existing booking", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { archived: true });
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    expect((await getIcs(slug, token)).status).toBe(200);
  });

  it("returns an identical generic 404 for everything that is not an existing booking", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const other = await insertEvent(t.env.DB);
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    const good = await book(id, SLOT, "Rex", "Sam Jones", { token: "AbCdEfGhIjKlMnOpQrStUv" });
    const orphan = await book(id, "2026-06-13T09:00:00Z", "Orphan", "Slot"); // in a break: not in the schedule
    const elsewhere = await book(other.id, "2026-06-13T10:00:00Z", "Fido", "Ann Lee");
    await book(id, "2026-06-13T10:15:00Z", "Legacy", "Row", { token: null });
    const cases: [string, Promise<Response>][] = [
      ["unknown event", getIcs("unknownslug0123456789", good)],
      ["malformed slug", getIcs("short", good)],
      ["valid-format but unknown token", getIcs(slug, generateBookingToken())],
      ["token with its case flipped", getIcs(slug, "aBcDeFgHiJkLmNoPqRsTuV")],
      ["token with a character added", getIcs(slug, `${good}A`)],
      ["token with a trailing newline", getIcs(slug, `${good}\n`)],
      ["malformed token: too short", getIcs(slug, "abc")],
      ["malformed token: path traversal", getIcs(slug, "../../etc/passwd")],
      ["malformed token: empty", getIcs(slug, "")],
      ["malformed token: unicode", getIcs(slug, "é".repeat(22))],
      ["another event's token", getIcs(slug, elsewhere)],
      ["slot no longer in the schedule", getIcs(slug, orphan)],
      ["a legacy NULL-token row, guessed as 'null'", getIcs(slug, "null".padEnd(22, "0"))],
      ["a legacy NULL-token row, guessed as 'NULL'", getIcs(slug, "NULL")],
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

  it("cannot reach a legacy booking row that has no token", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, SLOT, "Rex", "Sam Jones", { token: null });
    await book(id, "2026-06-13T08:30:00Z", "Fido", "Ann Lee", { token: null });
    const stored = await t.env.DB.prepare("SELECT count(*) AS n FROM bookings WHERE event_id = ? AND token IS NULL").bind(id).first<{ n: number }>();
    expect(stored?.n).toBe(2);
    for (const token of [generateBookingToken(), "null", "NULL", "undefined", "0".repeat(22)]) {
      expect((await getIcs(slug, token)).status, token).toBe(404);
    }
  });

  it("is offered by POST as an icsUrl with a token and no names or times, and following it returns the booking just made", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { venuePostcode: "SW1A 1AA" });
    const res = await Promise.resolve(
      onRequestPost({
        request: new Request(`http://localhost/api/events/${slug}/bookings`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: SLOT, dogName: "  Zoë & Co ", handlerName: "Sam #1 ", idempotencyKey: generateBookingToken() }),
        }),
        env: t.env,
        params: { slug },
      } as unknown as Parameters<typeof onRequestPost>[0]),
    );
    expect(res.status).toBe(201);
    const { icsUrl } = (await res.json()) as { icsUrl: string };
    const stored = await t.env.DB.prepare("SELECT token FROM bookings WHERE event_id = ?").bind(id).first<{ token: string }>();
    expect(stored?.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(icsUrl).toBe(`/api/events/${slug}/bookings/${stored!.token}/ics`);
    // Once the slug and token are removed, nothing but the fixed route skeleton is left: no names, no slot.
    expect(icsUrl.replace(slug, "").replace(stored!.token, "")).toBe("/api/events//bookings//ics");
    const followed = await getIcs(slug, stored!.token);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(vevent(await followed.text()).summary).toContain("Zoë & Co");
  });
});
