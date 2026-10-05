import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { identityKey } from "../../../../src/core/identity";
import { utcToLondon } from "../../../../src/core/london";
import { generateBookingToken } from "../../../../src/core/slug";
import type { AppEnv } from "../../../../src/server/env";
import { countRows, createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../src/test/db";
import { onRequestPost as book } from "../../events/[slug]/bookings";
import { onRequestGet as publicGet } from "../../events/[slug]/index";
import { onRequestGet, onRequestPost } from "./index";
import { onRequestPost as preview } from "./preview";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const NOW = "2026-10-01T12:00:00Z";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  vi.useFakeTimers({ toFake: ["Date"] });
});
beforeEach(() => { vi.setSystemTime(new Date(NOW)); });
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

interface PostOptions { contentType?: string | null; raw?: string; data?: unknown; env?: unknown }

const post = (body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request("http://localhost/api/admin/events", { method: "POST", headers, body: o.raw ?? JSON.stringify(body) }),
      env: o.env ?? t.env,
      data: "data" in o ? o.data : ADMIN,
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

/** Pass a second argument (even undefined) to replace the admin data. */
const list = (vars: Partial<AppEnv> = {}, ...data: unknown[]): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request("http://localhost/api/admin/events"),
      env: { DB: t.env.DB, ...vars },
      data: data.length > 0 ? data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

let keyCounter = 0;
/** A fresh valid idempotency key per call. */
const newKey = () => `admin-key-${String(++keyCounter).padStart(10, "0")}`;

const draft = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: newKey(),
  name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00", sessionMinutes: 15, gapMinutes: 0,
  costPence: 1500, venuePostcode: "ab1  2cd", details: "Bring water", breaks: [{ start: "10:00", end: "10:30" }], ...over,
});

interface Created {
  event: Record<string, unknown> & { slug: string };
  path: string; slotCount: number;
}
const create = async (over: Record<string, unknown> = {}): Promise<Created> => {
  const res = await post(draft(over));
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
};

const publicEvent = async (slug: string) =>
  (await (await publicGet({
    request: new Request(`http://localhost/api/events/${slug}`), env: { DB: t.env.DB }, params: { slug },
  } as unknown as Parameters<typeof publicGet>[0])).json()) as { slots: { start: string; end: string; status: string }[] };

describe("POST /api/admin/events", () => {
  it("creates the event and its breaks: 201, no internal ids, a path and the slot count", async () => {
    const res = await post(draft({ breaks: [{ start: "10:00", end: "10:30" }, { start: "11:00", end: "11:10" }] }));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Created;
    expect(body).toEqual({
      event: {
        slug: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), name: "Saturday trial day",
        startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, gapMinutes: 0,
        costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water",
      },
      path: `/e/${body.event.slug}`,
      slotCount: 9, // 09:00 09:15 09:30 09:45, then 10:30 10:45, then 11:10 11:25 11:40
    });
    const stored = await t.env.DB.prepare("SELECT * FROM events WHERE slug = ?").bind(body.event.slug).first<{ id: number }>();
    const { results } = await t.env.DB.prepare("SELECT start_utc, end_utc FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(stored!.id).all();
    expect(results).toEqual([
      { start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:30:00Z" },
      { start_utc: "2026-10-24T10:00:00Z", end_utc: "2026-10-24T10:10:00Z" },
    ]);
  });

  it("lists the event on the landing page by default, and unlisted when asked, either way still bookable by its link", async () => {
    const shown = (await create()).event.slug;
    const hidden = (await create({ listed: false })).event.slug;
    const { results } = await t.env.DB.prepare("SELECT slug, listed FROM events WHERE slug IN (?, ?) ORDER BY listed").bind(shown, hidden).all();
    expect(results).toEqual([{ slug: hidden, listed: 0 }, { slug: shown, listed: 1 }]);
    const slots = (await publicEvent(hidden)).slots;
    expect(slots.length).toBeGreaterThan(0);
    expect(slots).toEqual((await publicEvent(shown)).slots);
  });

  it("stores an explicit listed: true as listed", async () => {
    const { event } = await create({ listed: true });
    expect(await t.env.DB.prepare("SELECT listed FROM events WHERE slug = ?").bind(event.slug).first()).toEqual({ listed: 1 });
  });

  it.each([["a string", "no"], ["a number", 0], ["null", null]])("refuses `listed` as %s with 400 and fields.listed, writing nothing", async (_n, listed) => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ listed }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ listed: "Listed must be true or false." });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("stores each break's label, and an unnamed break as an empty one", async () => {
    const { event } = await create({ breaks: [{ start: "10:00", end: "10:30", label: "Lunch" }, { start: "11:00", end: "11:10" }] });
    const { results } = await t.env.DB.prepare(
      "SELECT label FROM breaks WHERE event_id = (SELECT id FROM events WHERE slug = ?) ORDER BY start_utc",
    ).bind(event.slug).all();
    expect(results).toEqual([{ label: "Lunch" }, { label: "" }]);
  });

  it("rejects an over-long break label under its own key, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ breaks: [{ start: "10:00", end: "10:30", label: "x".repeat(41) }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ "breaks.0.label": "The break name must be at most 40 characters." });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("makes a fresh slug each time", async () => {
    expect((await create()).event.slug).not.toBe((await create()).event.slug);
  });

  it("stores what the preview showed, and the public page offers exactly those slots", async () => {
    const body = draft({ breaks: [{ start: "10:05", end: "10:30" }] });
    const previewRes = await preview({
      request: new Request("http://localhost/p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      env: {}, data: ADMIN,
    } as unknown as Parameters<typeof preview>[0]);
    const previewed = (await previewRes.json()) as { slots: { start: string; end: string }[]; suggestions: unknown[] };
    expect(previewed.suggestions).toHaveLength(1);
    const res = await post(body);
    const created = (await res.json()) as Created;
    const { slots } = await publicEvent(created.event.slug);
    expect(slots.map(({ start, end }) => ({ start, end }))).toEqual(previewed.slots);
    expect(slots.every((s) => s.status === "free")).toBe(true);
    expect(created.slotCount).toBe(previewed.slots.length);
  });

  it("can then be booked through the public API", async () => {
    const { event } = await create();
    const { slots } = await publicEvent(event.slug);
    const slot = slots[3];
    const res = await book({
      request: new Request(`http://localhost/api/events/${event.slug}/bookings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: slot.start, dogName: "Rex", handlerName: "Sam Jones", idempotencyKey: generateBookingToken() }),
      }),
      env: t.env, params: { slug: event.slug },
    } as unknown as Parameters<typeof book>[0]);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { booking: { slot: unknown } }).booking.slot).toEqual({ start: slot.start, end: slot.end });
    expect((await publicEvent(event.slug)).slots[3].status).toBe("taken");
  });

  it("stores the right instants across the clock change: 2026-10-24 is BST, 2026-10-31 is GMT", async () => {
    const bst = await create({ date: "2026-10-24", start: "09:00", end: "10:00", breaks: [] });
    const gmt = await create({ date: "2026-10-31", start: "09:00", end: "10:00", breaks: [] });
    expect(bst.event).toMatchObject({ startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z" });
    expect(gmt.event).toMatchObject({ startUtc: "2026-10-31T09:00:00Z", endUtc: "2026-10-31T10:00:00Z" });
    for (const { event } of [bst, gmt]) {
      const { slots } = await publicEvent(event.slug);
      expect(slots.map((s) => utcToLondon(s.start).time)).toEqual(["09:00", "09:15", "09:30", "09:45"]);
    }
  });

  it("rejects a time in the autumn overlap with the right field key, and writes nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const breaks = await countRows(t.env.DB, "breaks");
    const res = await post(draft({ date: "2026-10-25", start: "00:00", end: "06:00", breaks: [{ start: "01:30", end: "03:00" }] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { "breaks.0.start": "That time happens twice in London on that date (the clocks go back)." },
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
    expect(await countRows(t.env.DB, "breaks")).toBe(breaks);
  });

  it("rejects direction-changing characters in the details, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ details: "Pay now\u202E" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      details: "The details can't contain invisible or direction-changing characters.",
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it.each([["U+2028", "\u2028"], ["U+2029", "\u2029"]])("rejects %s in the name, a break name and the details, writing nothing", async (_n, ch) => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ name: `Show${ch}09:00 free`, details: `a${ch}b`, breaks: [{ start: "10:00", end: "10:30", label: `Lunch${ch}` }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      name: "The event name can't contain line or paragraph separators.",
      details: "The details can't contain line or paragraph separators.",
      "breaks.0.label": "The break name can't contain line or paragraph separators.",
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("requires the event to be in the future (the preview does not), writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    const res = await post(draft({ date: "2026-09-30" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({ date: "The event must start in the future." });
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("returns a generic 500, without leaking the cause, when the batch fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The first batch is the idempotency lookup (a miss); the second is the insert, which fails.
      let batches = 0;
      const db = {
        batch: () => (batches++ === 0 ? Promise.resolve([{ results: [] }, { results: [] }]) : Promise.reject(new Error("D1_ERROR: secret detail"))),
        prepare: () => ({ bind: () => ({}) }),
      };
      const res = await post(draft(), { env: { DB: db } });
      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe("internal_error");
      expect(text).not.toContain("secret");
      expect(error).toHaveBeenCalled();
      expect(batches).toBe(2);
    } finally {
      error.mockRestore();
    }
  });

  it("refuses with 401 unless the middleware set an admin identity, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await post(draft(), { data });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  it("returns 415, 400 and 413 for bad bodies, writing nothing", async () => {
    const events = await countRows(t.env.DB, "events");
    expect((await post(draft(), { contentType: "text/plain" })).status).toBe(415);
    expect((await post(undefined, { raw: "{nope" })).status).toBe(400);
    expect((await post(undefined, { raw: "[]" })).status).toBe(400);
    const res = await post({ ...draft(), padding: "x".repeat(32768) });
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });
});

describe("POST /api/admin/events: idempotency key", () => {
  const eventRows = async (key: string) =>
    (await t.env.DB.prepare("SELECT id, slug FROM events WHERE idempotency_key = ?").bind(key).all<{ id: number; slug: string }>()).results;
  const breakRows = async (id: number) =>
    (await t.env.DB.prepare("SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(id).all()).results;
  const LUNCH = { start: "10:00", end: "10:30", label: "Lunch" };

  it("is stored with the event", async () => {
    const body = draft();
    const { event } = (await (await post(body)).json()) as Created;
    expect(await eventRows(body.idempotencyKey)).toEqual([{ id: expect.any(Number), slug: event.slug }]);
  });

  it.each([["missing", undefined], ["too short", "short"], ["too long", "k".repeat(65)], ["badly formed", "has spaces in it 123456"], ["a number", 1234567890123456]])(
    "refuses a %s key with 400 and fields.idempotencyKey, writing nothing", async (_n, idempotencyKey) => {
      const events = await countRows(t.env.DB, "events");
      const res = await post(draft({ idempotencyKey }));
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        error: { code: "invalid_input", message: "Check the highlighted fields." },
        fields: { idempotencyKey: "Reload the page and try again." },
      });
      expect(await countRows(t.env.DB, "events")).toBe(events);
    });

  it("reports a bad key together with the other field errors", async () => {
    const res = await post(draft({ idempotencyKey: undefined, name: "" }));
    expect(((await res.json()) as { fields: unknown }).fields).toEqual({
      name: "Enter the event name.", idempotencyKey: "Reload the page and try again.",
    });
  });

  it("is not needed by the preview, which stores nothing", async () => {
    const { idempotencyKey: _omitted, ...withoutKey } = draft();
    const res = await preview({
      request: new Request("http://localhost/p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(withoutKey) }),
      env: {}, data: ADMIN,
    } as unknown as Parameters<typeof preview>[0]);
    expect(res.status).toBe(200);
  });

  it("answers the same key and the same payload with the original event: 201, replayed, one event, one set of breaks", async () => {
    const body = draft({ breaks: [LUNCH, { start: "11:00", end: "11:10" }] });
    const first = await post(body);
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const created = await first.text();
    // The same request again, spelled differently where validation normalises (postcode, padding, break order).
    const again = await post({
      ...body, name: "  Saturday trial day ", venuePostcode: "AB1 2CD",
      breaks: [{ start: "11:00", end: "11:10" }, { ...LUNCH, label: " Lunch " }],
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.text()).toBe(created);
    const rows = await eventRows(body.idempotencyKey);
    expect(rows).toHaveLength(1);
    expect(await breakRows(rows[0].id)).toHaveLength(2);
  });

  it("treats the same key with a different `listed` as a changed request: 422, the original untouched", async () => {
    const body = draft({ listed: false });
    expect((await post(body)).status).toBe(201);
    const same = await post(body);
    expect(same.status).toBe(201);
    expect(same.headers.get("idempotent-replayed")).toBe("true");
    const changed = await post({ ...body, listed: true });
    expect(changed.status).toBe(422);
    expect(await t.env.DB.prepare("SELECT listed FROM events WHERE idempotency_key = ?").bind(body.idempotencyKey).first()).toEqual({ listed: 0 });
  });

  it("gives different keys different events", async () => {
    const a = await create();
    const b = await create();
    expect(a.event.slug).not.toBe(b.event.slug);
  });

  it.each([
    ["the name", { name: "Sunday trial day" }],
    ["a break time", { breaks: [{ ...LUNCH, end: "10:35" }] }],
    ["a break label", { breaks: [{ ...LUNCH, label: "Tea" }] }],
    ["a break label (removed)", { breaks: [{ start: "10:00", end: "10:30" }] }],
    ["the number of breaks", { breaks: [LUNCH, { start: "11:00", end: "11:10" }] }],
    ["the cost", { costPence: 1600 }],
    ["the session length", { sessionMinutes: 20 }],
    ["the details", { details: "Bring tea" }],
    ["the date", { date: "2026-10-25", start: "09:00", end: "12:00" }],
  ])("refuses the same key when %s changes: 422 with the original event, still one event", async (_n, changed) => {
    const body = draft({ breaks: [LUNCH] });
    const first = await post(body);
    const created = await first.text();
    const events = await countRows(t.env.DB, "events");
    const res = await post({ ...body, ...changed });
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect(await res.json()).toEqual({
      error: {
        code: "idempotency_key_reuse",
        message: "An earlier attempt with this key already saved an event, so this change wasn't applied.",
      },
      ...JSON.parse(created),
    });
    expect(await countRows(t.env.DB, "events")).toBe(events);
    const [row] = await eventRows(body.idempotencyKey);
    expect(await breakRows(row.id)).toEqual([{ start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:30:00Z", label: "Lunch" }]);
  });

  it("creates one event from two simultaneous requests with the same key, and both name the same slug", async () => {
    const body = draft({ breaks: [LUNCH] });
    const events = await countRows(t.env.DB, "events");
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a, b].filter((r) => r.headers.get("idempotent-replayed") === "true")).toHaveLength(1);
    const [ba, bb] = (await Promise.all([a.json(), b.json()])) as Created[];
    expect(ba).toEqual(bb);
    expect(await countRows(t.env.DB, "events")).toBe(events + 1);
    const rows = await eventRows(body.idempotencyKey);
    expect(rows.map((r) => r.slug)).toEqual([ba.event.slug]);
    expect(await breakRows(rows[0].id)).toHaveLength(1);
  });

  it("two simultaneous requests with the same key but different payloads: one wins, the other gets 422 with the winner", async () => {
    const key = newKey();
    const events = await countRows(t.env.DB, "events");
    const [a, b] = await Promise.all([post(draft({ idempotencyKey: key, name: "One" })), post(draft({ idempotencyKey: key, name: "Two" }))]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const [ba, bb] = (await Promise.all([a.json(), b.json()])) as Created[];
    expect(ba.event.slug).toBe(bb.event.slug);
    expect(await countRows(t.env.DB, "events")).toBe(events + 1);
  });

  it("recovers when the lookup missed but the insert hits the unique key (a simultaneous request won in between)", async () => {
    // The first batch is the lookup: pretend it ran just before the other request committed.
    const racing = () => {
      let batches = 0;
      const calls = () => batches;
      const db = {
        prepare: (q: string) => t.env.DB.prepare(q),
        batch: (statements: D1PreparedStatement[]) =>
          batches++ === 0 ? Promise.resolve([{ results: [] }, { results: [] }]) : t.env.DB.batch(statements),
      };
      return { db, calls };
    };
    const body = draft({ breaks: [LUNCH] });
    const created = await (await post(body)).text();
    const events = await countRows(t.env.DB, "events");

    const same = racing();
    const res = await post(body, { env: { DB: same.db } });
    expect(same.calls()).toBe(3); // lookup (stubbed), failed insert, lookup again
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.text()).toBe(created);

    const different = racing();
    const changed = await post({ ...body, name: "Other" }, { env: { DB: different.db } });
    expect(changed.status).toBe(422);
    expect(((await changed.json()) as Created).event.name).toBe("Saturday trial day");
    expect(await countRows(t.env.DB, "events")).toBe(events);
  });

  describe("after the event's start has passed", () => {
    it("still answers a replay of the same request with the original event", async () => {
      const body = draft({ date: "2026-10-24" });
      const created = await (await post(body)).text();
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      const res = await post(body);
      expect(res.status).toBe(201);
      expect(res.headers.get("idempotent-replayed")).toBe("true");
      expect(await res.text()).toBe(created);
    });

    it("answers a changed request with 422 and the original", async () => {
      const body = draft({ date: "2026-10-24" });
      await post(body);
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      expect((await post({ ...body, name: "Changed" })).status).toBe(422);
    });

    it("still refuses a new key for a past date, with the date error", async () => {
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      const events = await countRows(t.env.DB, "events");
      const res = await post(draft({ date: "2026-10-24" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: unknown }).fields).toEqual({ date: "The event must start in the future." });
      expect(await countRows(t.env.DB, "events")).toBe(events);
    });

    it("reports every error for a past date with other mistakes, whatever the key", async () => {
      const body = draft({ date: "2026-10-24", name: "" });
      await post(draft({ date: "2026-10-24", idempotencyKey: body.idempotencyKey }));
      vi.setSystemTime(new Date("2026-10-24T08:00:00Z"));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { fields: unknown }).fields).toEqual({ name: "Enter the event name.", date: "The event must start in the future." });
    });
  });
});

describe("GET /api/admin/events", () => {
  beforeEach(async () => { await t.env.DB.prepare("DELETE FROM events").run(); });

  const slugsOf = async (res: Response) => ((await res.json()) as { events: { slug: string }[] }).events.map((e) => e.slug);

  it("lists upcoming events soonest first; hides archived and finished ones", async () => {
    const day = (d: string, from: string, to: string) => ({ startUtc: `${d}T${from}:00Z`, endUtc: `${d}T${to}:00Z` });
    const later = await insertEvent(t.env.DB, day("2026-10-24", "08:00", "11:00"));
    const sooner = await insertEvent(t.env.DB, day("2026-10-10", "08:00", "11:00"));
    const running = await insertEvent(t.env.DB, day("2026-10-01", "11:00", "13:00"));
    await insertEvent(t.env.DB, { ...day("2026-10-20", "08:00", "11:00"), archived: true });
    await insertEvent(t.env.DB, day("2026-09-30", "08:00", "11:00"));
    await insertEvent(t.env.DB, day("2026-10-01", "11:00", "12:00")); // ends exactly now
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await slugsOf(res)).toEqual([running.slug, sooner.slug, later.slug]);
  });

  it("returns each event's summary, slot count, booked count, booking window and path", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { name: "Show", costPence: 900, venuePostcode: "ZZ9 9ZZ", details: "private notes" });
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    await insertEvent(t.env.DB, { startUtc: "2026-11-13T08:00:00Z", endUtc: "2026-11-13T09:00:00Z" });
    for (const [slot, dog] of [["2026-06-13T08:00:00Z", "Rex"], ["2026-06-13T08:15:00Z", "Moss"]]) {
      await t.env.DB.prepare("INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (?, ?, ?, 'Sam', ?, ?)")
        .bind(id, slot, dog, identityKey(dog), identityKey("Sam")).run();
    }
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const events = ((await (await list({ BOOKING_CUTOFF_OFFSET_MINUTES: "-60" })).json()) as { events: Record<string, unknown>[] }).events;
    expect(events[0]).toEqual({
      slug, name: "Show", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z", costPence: 900,
      venuePostcode: "ZZ9 9ZZ", slotCount: 10, bookedCount: 2, archived: false, listed: true, full: false,
      bookings: { open: true, closesAt: "2026-06-13T07:00:00Z" }, path: `/e/${slug}`,
    });
    expect(events[1]).toMatchObject({ slotCount: 4, bookedCount: 0 });
    vi.setSystemTime(new Date("2026-06-13T07:00:00Z"));
    const closed = ((await (await list({ BOOKING_CUTOFF_OFFSET_MINUTES: "-60" })).json()) as { events: { bookings: unknown }[] }).events;
    expect(closed[0].bookings).toEqual({ open: false, closesAt: "2026-06-13T07:00:00Z" });
  });

  it("says whether each event is listed", async () => {
    await insertEvent(t.env.DB, { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T09:00:00Z" });
    await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T09:00:00Z", listed: false });
    const events = ((await (await list()).json()) as { events: { listed: boolean }[] }).events;
    expect(events.map((e) => e.listed)).toEqual([true, false]);
  });

  it("keeps each event's breaks and booking counts to itself", async () => {
    const a = await insertEvent(t.env.DB, { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T09:00:00Z" });
    const b = await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T09:00:00Z" });
    await insertBreak(t.env.DB, b.id, "2026-10-11T08:00:00Z", "2026-10-11T08:30:00Z");
    const events = ((await (await list()).json()) as { events: { slug: string; slotCount: number }[] }).events;
    expect(events.map((e) => [e.slug, e.slotCount])).toEqual([[a.slug, 4], [b.slug, 2]]);
  });

  it("returns at most 100, the soonest", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD')",
    );
    const slugs = Array.from({ length: 101 }, (_, i) => `limit-test-slug-${String(i).padStart(3, "0")}`);
    await t.env.DB.batch(slugs.map((slug, i) => {
      const iso = (hour: number) => new Date(Date.UTC(2027, 0, 1 + i, hour)).toISOString().replace(".000Z", "Z");
      return statement.bind(slug, iso(8), iso(9));
    }));
    const got = await slugsOf(await list());
    expect(got).toHaveLength(100);
    expect(got).toEqual(slugs.slice(0, 100)); // slug i is the i-th soonest, so the latest one is dropped
  });

  it("marks an event full only when it has slots and every one is booked", async () => {
    const a = await insertEvent(t.env.DB, { startUtc: "2026-10-10T08:00:00Z", endUtc: "2026-10-10T08:30:00Z" }); // 2 slots
    const b = await insertEvent(t.env.DB, { startUtc: "2026-10-11T08:00:00Z", endUtc: "2026-10-11T08:30:00Z" });
    const c = await insertEvent(t.env.DB, { startUtc: "2026-10-12T08:00:00Z", endUtc: "2026-10-12T08:30:00Z" });
    await insertBooking(t.env.DB, a.id, "2026-10-10T08:00:00Z", "Rex", "Sam");
    await insertBooking(t.env.DB, a.id, "2026-10-10T08:15:00Z", "Moss", "Sam");
    await insertBooking(t.env.DB, b.id, "2026-10-11T08:00:00Z", "Rex", "Sam");
    // The whole event is one break, so there are no slots at all (not "full"). Inserted directly: the API refuses such a draft.
    const zero = await insertEvent(t.env.DB, { startUtc: "2026-10-13T08:00:00Z", endUtc: "2026-10-13T08:30:00Z" });
    await insertBreak(t.env.DB, zero.id, "2026-10-13T08:00:00Z", "2026-10-13T08:30:00Z");
    const events = ((await (await list()).json()) as { events: { slug: string; slotCount: number; bookedCount: number; full: boolean }[] }).events;
    expect(events.map((e) => [e.slug, e.slotCount, e.bookedCount, e.full])).toEqual([
      [a.slug, 2, 2, true], [b.slug, 2, 1, false], [c.slug, 2, 0, false], [zero.slug, 0, 0, false],
    ]);
  });

  it("refuses with 401 unless the middleware set an admin identity", async () => {
    for (const data of [undefined, {}, { admin: {} }]) {
      const res = await list({}, data);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("GET /api/admin/events: Past and Archived", () => {
  beforeEach(async () => { await t.env.DB.prepare("DELETE FROM events").run(); });

  interface Listing {
    events: { slug: string }[]; past: Record<string, unknown>[]; archived: Record<string, unknown>[];
    pastHasMore: boolean; archivedHasMore: boolean;
  }
  const listing = async (): Promise<Listing> => (await (await list()).json()) as Listing;
  const slugs = (xs: { slug?: unknown }[]) => xs.map((x) => x.slug);
  const at = (start: string, end: string, extra: Record<string, unknown> = {}) => ({ startUtc: start, endUtc: end, ...extra });

  it("puts every event in exactly one group, at the end_utc == now boundary (one second either side)", async () => {
    const before = await insertEvent(t.env.DB, at("2026-10-01T10:00:00Z", "2026-10-01T11:59:59Z"));
    const exactly = await insertEvent(t.env.DB, at("2026-10-01T10:00:00Z", "2026-10-01T12:00:00Z"));
    const after = await insertEvent(t.env.DB, at("2026-10-01T10:00:00Z", "2026-10-01T12:00:01Z"));
    const body = await listing();
    expect(slugs(body.events)).toEqual([after.slug]);
    expect(new Set(slugs(body.past))).toEqual(new Set([before.slug, exactly.slug]));
    expect(body.archived).toEqual([]);
    expect(body.pastHasMore).toBe(false);
    expect(body.archivedHasMore).toBe(false);
  });

  it("shows an archived event under Archived only, whether it is past or upcoming", async () => {
    const archivedPast = await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T11:00:00Z", { archived: true }));
    const archivedUpcoming = await insertEvent(t.env.DB, at("2026-11-01T08:00:00Z", "2026-11-01T11:00:00Z", { archived: true }));
    const body = await listing();
    expect(body.events).toEqual([]);
    expect(body.past).toEqual([]);
    expect(slugs(body.archived)).toEqual([archivedUpcoming.slug, archivedPast.slug]);
  });

  it("orders Past most recently started first and Archived most recently started first", async () => {
    const p1 = await insertEvent(t.env.DB, at("2026-08-01T08:00:00Z", "2026-08-01T09:00:00Z"));
    const p3 = await insertEvent(t.env.DB, at("2026-09-20T08:00:00Z", "2026-09-20T09:00:00Z"));
    const p2 = await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z"));
    const a1 = await insertEvent(t.env.DB, at("2026-01-01T08:00:00Z", "2026-01-01T09:00:00Z", { archived: true }));
    const a3 = await insertEvent(t.env.DB, at("2027-01-01T08:00:00Z", "2027-01-01T09:00:00Z", { archived: true }));
    const a2 = await insertEvent(t.env.DB, at("2026-06-01T08:00:00Z", "2026-06-01T09:00:00Z", { archived: true }));
    const body = await listing();
    expect(slugs(body.past)).toEqual([p3.slug, p2.slug, p1.slug]);
    expect(slugs(body.archived)).toEqual([a3.slug, a2.slug, a1.slug]);
  });

  it("gives each Past and Archived item exactly its summary fields, with the booked count and no schedule data", async () => {
    const past = await insertEvent(t.env.DB, { ...at("2026-09-01T08:00:00Z", "2026-09-01T11:00:00Z"), name: "Old show", venuePostcode: "ZZ9 9ZZ", details: "private" });
    const old = await insertEvent(t.env.DB, { ...at("2026-02-01T08:00:00Z", "2026-02-01T11:00:00Z"), name: "Filed", archived: true });
    await insertBooking(t.env.DB, past.id, "2026-09-01T08:00:00Z", "Rex", "Sam");
    await insertBooking(t.env.DB, past.id, "2026-09-01T08:15:00Z", "Moss", "Sam");
    await insertBooking(t.env.DB, old.id, "2026-02-01T08:00:00Z", "Rex", "Sam");
    const body = await listing();
    expect(body.past).toEqual([{
      slug: past.slug, name: "Old show", startUtc: "2026-09-01T08:00:00Z", endUtc: "2026-09-01T11:00:00Z",
      venuePostcode: "ZZ9 9ZZ", bookedCount: 2, archived: false, listed: true,
    }]);
    expect(body.archived).toEqual([{
      slug: old.slug, name: "Filed", startUtc: "2026-02-01T08:00:00Z", endUtc: "2026-02-01T11:00:00Z",
      venuePostcode: "AB1 2CD", bookedCount: 1, archived: true, listed: true,
    }]);
  });

  it("says whether each Past and Archived item is listed", async () => {
    await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z", { listed: false }));
    await insertEvent(t.env.DB, at("2026-02-01T08:00:00Z", "2026-02-01T09:00:00Z", { archived: true, listed: false }));
    const body = await listing();
    expect([body.past[0].listed, body.archived[0].listed]).toEqual([false, false]);
  });

  it("counts bookings per event, zero where there are none, and keeps them to their own event", async () => {
    const a = await insertEvent(t.env.DB, at("2026-09-02T08:00:00Z", "2026-09-02T09:00:00Z"));
    const b = await insertEvent(t.env.DB, at("2026-09-01T08:00:00Z", "2026-09-01T09:00:00Z"));
    await insertBooking(t.env.DB, a.id, "2026-09-02T08:00:00Z", "Rex", "Sam");
    expect((await listing()).past.map((e) => [e.slug, e.bookedCount])).toEqual([[a.slug, 1], [b.slug, 0]]);
  });

  it("returns 100 and sets the HasMore flag when 101 exist, for Past and for Archived, keeping the most recent", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode, archived) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD', ?)",
    );
    const iso = (i: number, hour: number) => new Date(Date.UTC(2025, 0, 1 + i, hour)).toISOString().replace(".000Z", "Z");
    const rows = (prefix: string, archived: number) => Array.from({ length: 101 }, (_, i) =>
      statement.bind(`${prefix}-${String(i).padStart(3, "0")}-padding-xx`, iso(i, 8), iso(i, 9), archived));
    await t.env.DB.batch([...rows("past", 0), ...rows("arch", 1)]);
    const body = await listing();
    expect(body.past).toHaveLength(100);
    expect(body.archived).toHaveLength(100);
    expect(body.pastHasMore).toBe(true);
    expect(body.archivedHasMore).toBe(true);
    expect(body.past[0].slug).toBe("past-100-padding-xx"); // most recent first; the oldest (000) is the one left out
    expect(slugs(body.past)).not.toContain("past-000-padding-xx");
    expect(body.archived[99].slug).toBe("arch-001-padding-xx");
  });

  it("does not flag HasMore at exactly 100", async () => {
    const statement = t.env.DB.prepare(
      "INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode) VALUES (?, 'E', ?, ?, 15, 'AB1 2CD')",
    );
    const iso = (i: number, hour: number) => new Date(Date.UTC(2025, 0, 1 + i, hour)).toISOString().replace(".000Z", "Z");
    await t.env.DB.batch(Array.from({ length: 100 }, (_, i) => statement.bind(`exact-${String(i).padStart(3, "0")}-padding-xx`, iso(i, 8), iso(i, 9))));
    const body = await listing();
    expect(body.past).toHaveLength(100);
    expect(body.pastHasMore).toBe(false);
  });
});
