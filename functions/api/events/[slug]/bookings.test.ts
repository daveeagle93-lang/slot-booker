import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { identityKey } from "../../../../src/core/identity";
import { createTestEnv, insertBreak, insertEvent, type TestEnv } from "../../../../src/test/db";
import { onRequestPost } from "./bookings";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const SLOT = "2026-06-13T08:00:00Z";

interface PostOptions { contentType?: string | null; raw?: string; env?: { DB: D1Database } }

const post = (slug: string, body: unknown, o: PostOptions = {}): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (o.contentType !== null) headers["Content-Type"] = o.contentType ?? "application/json";
  return Promise.resolve(
    onRequestPost({
      request: new Request(`http://localhost/api/events/${slug}/bookings`, {
        method: "POST", headers, body: o.raw ?? JSON.stringify(body),
      }),
      env: o.env ?? t.env,
      params: { slug },
    } as unknown as Parameters<typeof onRequestPost>[0]),
  );
};

const entry = (slot: string, dogName: string, handlerName: string) => ({ slot, dogName, handlerName });

interface ErrorBody {
  error: { code: string; message: string };
  fields?: Record<string, string>;
  freeSlots?: { start: string; end: string }[];
}

async function rows(eventId: number): Promise<Record<string, unknown>[]> {
  const { results } = await t.env.DB.prepare("SELECT * FROM bookings WHERE event_id = ? ORDER BY slot_start_utc")
    .bind(eventId)
    .all<Record<string, unknown>>();
  return results;
}

/** Quarter-hour slots 08:00 to 10:45, as the default test event generates them. */
const quarterSlots = (): { start: string; end: string }[] =>
  Array.from({ length: 12 }, (_, i) => {
    const at = (m: number) => `2026-06-13T${String(8 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00Z`;
    return { start: at(i * 15), end: at(i * 15 + 15) };
  });

describe("POST /api/events/:slug/bookings", () => {
  it("books a slot: 201, payload shape, row stored as entered (trimmed) with identity keys", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { name: "Summer show", costPence: 1250, details: "Bring water" });
    const res = await post(slug, entry("2026-06-13T08:15:00Z", "  Zoë ", "Sam   Jones\t"));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      booking: {
        slot: { start: "2026-06-13T08:15:00Z", end: "2026-06-13T08:30:00Z" },
        dogName: "Zoë", handlerName: "Sam   Jones",
      },
      event: {
        slug, name: "Summer show", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z",
        costPence: 1250, venuePostcode: "AB1 2CD", details: "Bring water", archived: false,
      },
      icsUrl: `/api/events/${slug}/ics?slot=2026-06-13T08%3A15%3A00Z&dog=Zo%C3%AB&handler=Sam%20%20%20Jones`,
    });
    const stored = await rows(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      event_id: id, slot_start_utc: "2026-06-13T08:15:00Z", dog_name: "Zoë", handler_name: "Sam   Jones",
      dog_key: identityKey("Zoë"), handler_key: identityKey("Sam Jones"),
    });
    expect(stored[0].dog_key).toBe("zoë");
    expect(stored[0].handler_key).toBe("sam jones");
  });

  describe("concurrency (the database is the referee)", () => {
    it("20 parallel bookings for one slot: exactly one wins, nineteen get slot_taken", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(slug, entry(SLOT, `Dog${i}`, `Handler${i}`))),
      );
      const tally: Record<string, number> = {};
      for (const r of responses) {
        const code = r.status === 201 ? "201" : `${r.status} ${((await r.json()) as ErrorBody).error.code}`;
        tally[code] = (tally[code] ?? 0) + 1;
      }
      console.info("one slot, 20 pairs:", JSON.stringify(tally));
      expect(tally).toEqual({ "201": 1, "409 slot_taken": 19 });
      const stored = await rows(id);
      expect(stored).toHaveLength(1);
      expect(stored[0].slot_start_utc).toBe(SLOT);
    });

    it("10 parallel bookings of one dog+handler to 10 slots: exactly one wins, nine get duplicate_booking", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const slots = quarterSlots().slice(0, 10);
      const responses = await Promise.all(slots.map((s) => post(slug, entry(s.start, "Rex", "Sam Jones"))));
      const tally: Record<string, number> = {};
      for (const r of responses) {
        const code = r.status === 201 ? "201" : `${r.status} ${((await r.json()) as ErrorBody).error.code}`;
        tally[code] = (tally[code] ?? 0) + 1;
      }
      console.info("one pair, 10 slots:", JSON.stringify(tally));
      expect(tally).toEqual({ "201": 1, "409 duplicate_booking": 9 });
      expect(await rows(id)).toHaveLength(1);
    });
  });

  describe("identity", () => {
    it("rejects the same dog+handler again, including case, Unicode and whitespace variants", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      expect((await post(slug, entry("2026-06-13T08:00:00Z", "Zoë", "Sam Jones"))).status).toBe(201);
      for (const [dog, handler] of [
        ["ZOË", " sam   jones "],
        ["Zoë", "SAM JONES"], // decomposed ë
        ["Zoë", "Sam Jones"],
      ]) {
        const res = await post(slug, entry("2026-06-13T08:15:00Z", dog, handler));
        expect(res.status).toBe(409);
        expect(((await res.json()) as ErrorBody).error.code).toBe("duplicate_booking");
      }
      expect(await rows(id)).toHaveLength(1);
    });

    it("allows the same handler with a different dog, and the same pair in a different event", async () => {
      const a = await insertEvent(t.env.DB);
      const b = await insertEvent(t.env.DB);
      expect((await post(a.slug, entry("2026-06-13T08:00:00Z", "Rex", "Sam Jones"))).status).toBe(201);
      expect((await post(a.slug, entry("2026-06-13T08:15:00Z", "Fido", "Sam Jones"))).status).toBe(201);
      expect((await post(b.slug, entry("2026-06-13T08:00:00Z", "Rex", "Sam Jones"))).status).toBe(201);
      expect(await rows(a.id)).toHaveLength(2);
      expect(await rows(b.id)).toHaveLength(1);
    });

    it("gives duplicate_booking priority when the slot is also taken, without naming anyone or any slot", async () => {
      const { slug } = await insertEvent(t.env.DB);
      await post(slug, entry(SLOT, "Rex", "Sam Jones"));
      const res = await post(slug, entry(SLOT, "rex", "sam jones"));
      expect(res.status).toBe(409);
      const text = await res.text();
      const body = JSON.parse(text) as ErrorBody;
      expect(body.error).toEqual({
        code: "duplicate_booking", message: "That dog and handler already have a booking for this event.",
      });
      expect(body.freeSlots).toBeUndefined();
      expect(text).not.toMatch(/Rex|Sam|2026-06-13T08/i);
    });
  });

  describe("slot_taken", () => {
    it("returns exactly the current free slots, only start/end, and no other people's names", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
      expect((await post(slug, entry(SLOT, "Zxqdogname", "Zxqhandlername"))).status).toBe(201);
      expect((await post(slug, entry("2026-06-13T10:00:00Z", "Other", "Person"))).status).toBe(201);
      const res = await post(slug, entry(SLOT, "Fido", "Ann Lee"));
      expect(res.status).toBe(409);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      const body = JSON.parse(text) as ErrorBody;
      expect(body.error).toEqual({ code: "slot_taken", message: "That slot's just gone." });
      const taken = new Set([SLOT, "2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z", "2026-06-13T10:00:00Z"]);
      const expected = quarterSlots().filter((s) => !taken.has(s.start));
      expect(expected).toHaveLength(8);
      expect(body.freeSlots).toEqual(expected);
      expect(Object.keys(body).sort()).toEqual(["error", "freeSlots"]);
      for (const secret of ["Zxqdogname", "Zxqhandlername", "Other", "Person", "Fido", "Ann", "key", "\"id\""]) {
        expect(text).not.toContain(secret);
      }
      expect(await rows(id)).toHaveLength(2);
    });
  });

  describe("rejections", () => {
    it("returns 404 for an unknown or malformed slug", async () => {
      for (const slug of ["unknownslug0123456789", "short", "../etc/passwd"]) {
        const res = await post(slug, entry(SLOT, "Rex", "Sam"));
        expect(res.status).toBe(404);
        expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
      }
    });

    it("returns 410 for an archived event and inserts nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { archived: true });
      const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"));
      expect(res.status).toBe(410);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "event_archived", message: "This event is closed to bookings.",
      });
      expect(await rows(id)).toHaveLength(0);
    });

    it("checks the event before the body: archived beats a bad content type", async () => {
      const { slug } = await insertEvent(t.env.DB, { archived: true });
      expect((await post(slug, {}, { contentType: "text/plain" })).status).toBe(410);
    });

    it("returns 400 invalid_slot for times that are not slots, and inserts nothing", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
      for (const slot of [
        "2026-06-13T09:00:00Z", // inside a break
        "2026-06-13T09:15:00Z", // inside a break
        "2026-06-13T08:07:00Z", // off the grid
        "2026-06-13T11:00:00Z", // at the end
        "2026-06-13T12:00:00Z", // after the end
        "2026-06-13T08:00:00.000Z", // not the canonical form
        "2026-06-13 08:00", "not a time", "",
      ]) {
        const res = await post(slug, entry(slot, "Rex", "Sam Jones"));
        expect(res.status, slot).toBe(400);
        expect(((await res.json()) as ErrorBody).error, slot).toEqual({
          code: "invalid_slot", message: "That time isn't one of this event's slots.",
        });
      }
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 400 invalid_input for a missing or non-string slot", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const body of [{ dogName: "Rex", handlerName: "Sam" }, { ...entry(SLOT, "Rex", "Sam"), slot: 123 }]) {
        const res = await post(slug, body);
        expect(res.status).toBe(400);
        const parsed = (await res.json()) as ErrorBody;
        expect(parsed.error.code).toBe("invalid_input");
        expect(Object.keys(parsed.fields ?? {})).toEqual(["slot"]);
      }
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 400 invalid_json for bad JSON and non-objects", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const raw of ["{nope", "", "null", "[]", "\"text\"", "42"]) {
        const res = await post(slug, undefined, { raw });
        expect(res.status, raw).toBe(400);
        expect(((await res.json()) as ErrorBody).error.code, raw).toBe("invalid_json");
      }
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 415 unless the content type is application/json", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
        const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { contentType });
        expect(res.status, String(contentType)).toBe(415);
        expect(((await res.json()) as ErrorBody).error.code).toBe("unsupported_media_type");
      }
      expect(await rows(id)).toHaveLength(0);
      const ok = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { contentType: "Application/JSON; charset=utf-8" });
      expect(ok.status).toBe(201);
    });

    it("returns 413 for a body over 4 KB", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const res = await post(slug, { ...entry(SLOT, "Rex", "Sam Jones"), padding: "x".repeat(4096) });
      expect(res.status).toBe(413);
      expect(((await res.json()) as ErrorBody).error.code).toBe("payload_too_large");
      expect(await rows(id)).toHaveLength(0);
    });

    it("returns 400 invalid_input naming each bad name field", async () => {
      const { id, slug } = await insertEvent(t.env.DB);
      const cases: [string, Record<string, unknown>, string[]][] = [
        ["missing dog", { slot: SLOT, handlerName: "Sam" }, ["dogName"]],
        ["missing handler", { slot: SLOT, dogName: "Rex" }, ["handlerName"]],
        ["both missing", { slot: SLOT }, ["dogName", "handlerName"]],
        ["non-string", entry(SLOT, "Rex", 7 as unknown as string), ["handlerName"]],
        ["blank", entry(SLOT, "   ", "Sam"), ["dogName"]],
        ["too long (81 chars)", entry(SLOT, "Rex", "a".repeat(81)), ["handlerName"]],
        ["80 characters after trim is fine", entry(SLOT, "Rex", ` ${"a".repeat(80)} `), []],
        ["control character", entry(SLOT, "Re\u0000x", "Sam"), ["dogName"]],
        ["newline inside", entry(SLOT, "Rex", "Sam\nJones"), ["handlerName"]],
        ["both bad", entry(SLOT, "", "\u0007"), ["dogName", "handlerName"]],
      ];
      for (const [label, body, bad] of cases) {
        const res = await post(slug, body);
        if (bad.length === 0) {
          expect(res.status, label).toBe(201);
          continue;
        }
        expect(res.status, label).toBe(400);
        const parsed = (await res.json()) as ErrorBody;
        expect(parsed.error.code, label).toBe("invalid_input");
        expect(Object.keys(parsed.fields ?? {}).sort(), label).toEqual(bad);
        for (const message of Object.values(parsed.fields ?? {})) expect(message).toEqual(expect.any(String));
      }
      expect(await rows(id)).toHaveLength(1);
    });

    it("counts the 80-character limit in code points, not UTF-16 units", async () => {
      const { slug } = await insertEvent(t.env.DB);
      expect((await post(slug, entry(SLOT, "🐕".repeat(80), "Sam"))).status).toBe(201);
      expect((await post(slug, entry("2026-06-13T08:15:00Z", "🐕".repeat(81), "Sam"))).status).toBe(400);
    });
  });

  describe("unexpected failures", () => {
    it("returns a generic 500 and logs, without leaking SQL, when the insert fails for another reason", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const failing = {
        prepare: (sql: string) =>
          sql.startsWith("INSERT INTO bookings")
            ? { bind: () => ({ run: () => Promise.reject(new Error("D1_ERROR: SECRET sql detail")) }) }
            : t.env.DB.prepare(sql),
      } as unknown as D1Database;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await post(slug, entry(SLOT, "Rex", "Sam Jones"), { env: { DB: failing } });
        expect(res.status).toBe(500);
        const text = await res.text();
        expect((JSON.parse(text) as ErrorBody).error.code).toBe("internal_error");
        expect(text).not.toMatch(/SECRET|D1_ERROR|INSERT/);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
