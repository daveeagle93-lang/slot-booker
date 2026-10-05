import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../core/identity";
import { generateSchedule } from "../core/schedule";
import { isValidToken } from "../core/slug";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../test/db";
import { addBooking, clearBooking, moveBooking, swapBookings, type Failure } from "./admin-bookings";
import { createBooking, validateBookingInput } from "./bookings";
import { loadEventBySlug } from "./events";

const IDEM = "abcdefghijklmnopqrstuv";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const caught = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("expected a failure");
};

/** 2026-10-24 (BST) 09:00-12:00, 15-minute sessions, lunch 10:00-10:30: ten slots. s[i] are their UTC starts. */
async function seed(over: Parameters<typeof insertEvent>[1] = {}) {
  const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, ...over });
  await insertBreak(t.env.DB, e.id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
  const event = (await loadEventBySlug(t.env.DB, e.slug))!;
  const s = generateSchedule({ start: event.startUtc, end: event.endUtc, sessionMinutes: 15, gapMinutes: 0, breaks: event.breaks }).slots.map((x) => x.start);
  return { ...e, event, s };
}

const rows = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT * FROM bookings WHERE event_id = ? ORDER BY id").bind(eventId).all()).results;
const slotsOf = async (eventId: number) =>
  Object.fromEntries((await t.env.DB.prepare("SELECT id, slot_start_utc FROM bookings WHERE event_id = ?").bind(eventId).all<{ id: number; slot_start_utc: string }>())
    .results.map((r) => [r.id, r.slot_start_utc]));

const failed = (r: unknown): Failure => {
  if (!r || typeof r !== "object" || "ok" in r) throw new Error(`expected a failure, got ${JSON.stringify(r)}`);
  return r as Failure;
};
const ok = <T>(r: { ok: T } | Failure): T => {
  if (!("ok" in r)) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r.ok;
};

describe("addBooking", () => {
  it("adds the booking with a generated token, no idempotency key and identity keys, names trimmed", async () => {
    const e = await seed();
    const b = ok(await addBooking(t.env.DB, e.event, { slot: e.s[2], dogName: "  Rex ", handlerName: "Sam  Smith" }));
    expect(b).toEqual({ id: expect.any(Number), slotStart: e.s[2], dogName: "Rex", handlerName: "Sam  Smith" });
    const row = (await rows(e.id))[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      id: b.id, slot_start_utc: e.s[2], dog_name: "Rex", handler_name: "Sam  Smith",
      dog_key: identityKey("Rex"), handler_key: identityKey("Sam Smith"), idempotency_key: null,
    });
    expect(isValidToken(row.token as string)).toBe(true);
  });

  it("gives each booking its own token", async () => {
    const e = await seed();
    await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "A", handlerName: "H" });
    await addBooking(t.env.DB, e.event, { slot: e.s[1], dogName: "B", handlerName: "H" });
    const tokens = (await rows(e.id)).map((r) => (r as { token: string }).token);
    expect(new Set(tokens).size).toBe(2);
  });

  it("reports a taken slot with who holds it, and writes nothing", async () => {
    const e = await seed();
    const holder = await insertBooking(t.env.DB, e.id, e.s[3], "Rex", "Sam Smith");
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[3], dogName: "Bella", handlerName: "Alex Jones" }));
    expect(f).toMatchObject({ status: 409, code: "slot_taken", extra: { booking: { id: holder, dogName: "Rex", handlerName: "Sam Smith" } } });
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("reports the same dog and handler as a duplicate, naming the existing booking, whatever the case, spacing or Unicode form", async () => {
    const e = await seed();
    const first = ok(await addBooking(t.env.DB, e.event, { slot: e.s[4], dogName: "Zoë", handlerName: "Sam Smith" }));
    for (const [dog, handler] of [["ZOË", "sam smith"], ["  zoë ", "SAM   SMITH"], ["Zoë", "Ｓam Smith"]]) {
      const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[5], dogName: dog, handlerName: handler }));
      expect(f, `${dog}/${handler}`).toMatchObject({
        status: 409, code: "duplicate_booking",
        extra: { booking: { id: first.id, slotStart: e.s[4], dogName: "Zoë", handlerName: "Sam Smith" } },
      });
    }
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("reports a repeat that hides an invisible character as a duplicate, and stores the display names as entered", async () => {
    const e = await seed();
    const first = ok(await addBooking(t.env.DB, e.event, { slot: e.s[4], dogName: "Rex \u2764\uFE0F", handlerName: "Sam Smith" }));
    for (const [dog, handler] of [["Rex \u2764", "Sam Smith"], ["Rex\u3164 \u2764\uFE0F", "Sam\uFE0F Smith"]]) {
      const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[5], dogName: dog, handlerName: handler }));
      expect(f, `${dog}/${handler}`).toMatchObject({
        status: 409, code: "duplicate_booking",
        extra: { booking: { id: first.id, slotStart: e.s[4], dogName: "Rex \u2764\uFE0F", handlerName: "Sam Smith" } },
      });
    }
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("refuses a name with no letter or number, writing nothing", async () => {
    const e = await seed();
    for (const dogName of ["\u3164", "\u2800", "\uFE0F", "\u{1F436}"]) {
      expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName, handlerName: "Sam" })), dogName).toMatchObject({
        status: 400, code: "invalid_input", extra: { fields: { dogName: "The dog's name must contain at least one letter or number." } },
      });
    }
    expect(await rows(e.id)).toHaveLength(0);
  });

  it("answers a clash on the same slot with the same pair as a duplicate, and a different pair as slot_taken even if that pair booked elsewhere", async () => {
    const e = await seed();
    const rex = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Rex", handlerName: "Sam" }));
    const bella = ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], dogName: "Bella", handlerName: "Alex" }));
    expect(failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "rex", handlerName: "sam" })).code).toBe("duplicate_booking");
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Bella", handlerName: "Alex" }));
    expect(f).toMatchObject({ code: "slot_taken", extra: { booking: { id: rex.id } } });
    expect(bella.id).not.toBe(rex.id);
  });

  it("lets one handler book several slots with different dogs, and one dog name with different handlers", async () => {
    const e = await seed();
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Rex", handlerName: "Sam" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[1], dogName: "Bella", handlerName: "Sam" }));
    ok(await addBooking(t.env.DB, e.event, { slot: e.s[2], dogName: "Rex", handlerName: "Pat" }));
  });

  it("rejects a time that is not a slot of the schedule (a break, an off-grid time, a made-up date, another event's slot)", async () => {
    const e = await seed();
    for (const slot of ["2026-10-24T09:00:00Z", "2026-10-24T08:05:00Z", "2026-10-25T08:00:00Z", "nonsense", ""]) {
      expect(failed(await addBooking(t.env.DB, e.event, { slot, dogName: "Rex", handlerName: "Sam" })), slot).toMatchObject({ status: 400, code: "invalid_slot" });
    }
    expect(await rows(e.id)).toHaveLength(0);
  });

  it("validates the names exactly as the public form does, and asks for a slot", async () => {
    const e = await seed();
    const odd = [undefined, 5, "", "   ", "x".repeat(81), "a​b", "tab\there", "lone\uD800", "‮evil"];
    for (const dog of odd) {
      for (const handler of ["Sam", ...odd.slice(0, 3)]) {
        const input = { slot: e.s[0], dogName: dog, handlerName: handler };
        const publicFields = (validateBookingInput({ ...input, idempotencyKey: IDEM }) as { fields?: Record<string, string> }).fields ?? {};
        const f = failed(await addBooking(t.env.DB, e.event, input));
        expect(f.code).toBe("invalid_input");
        expect((f.extra as { fields: unknown }).fields, JSON.stringify(input)).toEqual(publicFields);
      }
    }
    expect(failed(await addBooking(t.env.DB, e.event, { dogName: "Rex", handlerName: "Sam" })).extra).toEqual({ fields: { slot: "Choose a slot." } });
    expect(ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "x".repeat(80), handlerName: `a${"😀".repeat(79)}` })).dogName).toHaveLength(80);
    expect(await rows(e.id)).toHaveLength(1);
  });

  it("books past slots, after the cut-off, and on an archived event: it is an admin override", async () => {
    const e = await seed({ startUtc: "2020-03-07T09:00:00Z", endUtc: "2020-03-07T10:00:00Z", archived: true });
    const b = ok(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Late", handlerName: "Lee" }));
    expect(b.slotStart).toBe(e.s[0]);
    expect(e.event.archived).toBe(true);
  });

  it("aborts, writing nothing, when the event was edited between the read and the write", async () => {
    const e = await seed();
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Rex", handlerName: "Sam" }, {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET end_utc = '2026-10-24T10:00:00Z' WHERE id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed", message: "The event was edited while you were working. Reload the page." });
    expect(await rows(e.id)).toHaveLength(0);
  });

  it("aborts when a break was added after the read", async () => {
    const e = await seed();
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Rex", handlerName: "Sam" }, {
      afterRead: async () => { await insertBreak(t.env.DB, e.id, "2026-10-24T10:30:00Z", "2026-10-24T10:40:00Z"); },
    }));
    expect(f.code).toBe("event_changed");
    expect(await rows(e.id)).toHaveLength(0);
  });
});

describe("an event deleted between the read and the write", () => {
  const strayRows = async (): Promise<number> => (await t.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id NOT IN (SELECT id FROM events))
          + (SELECT COUNT(*) FROM breaks WHERE event_id NOT IN (SELECT id FROM events)) AS n`,
  ).first<{ n: number }>())!.n;
  const deleteIt = (id: number) => async () => {
    await t.env.DB.batch([
      t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ?").bind(id),
      t.env.DB.prepare("DELETE FROM breaks WHERE event_id = ?").bind(id),
      t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id),
    ]);
  };

  it("add answers a clean 409 event_changed, never an error, and inserts nothing", async () => {
    const e = await seed();
    const f = failed(await addBooking(t.env.DB, e.event, { slot: e.s[0], dogName: "Rex", handlerName: "Sam" }, { afterRead: deleteIt(e.id) }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await rows(e.id)).toHaveLength(0);
    expect(await strayRows()).toBe(0);
  });

  it("move answers a clean 409 event_changed and leaves no stray rows", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const f = failed(await moveBooking(t.env.DB, e.event, a, { fromSlot: e.s[0], toSlot: e.s[5] }, { afterRead: deleteIt(e.id) }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await strayRows()).toBe(0);
  });

  it("swap answers a clean 409 event_changed and leaves no stray rows", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    const f = failed(await swapBookings(t.env.DB, e.event, { a: { id: a, slot: e.s[0] }, b: { id: b, slot: e.s[1] } }, { afterRead: deleteIt(e.id) }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await strayRows()).toBe(0);
  });

  it("clear answers not_found once the event and its bookings are gone", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    await deleteIt(e.id)();
    expect(failed(await clearBooking(t.env.DB, e.event, a))).toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("clearBooking", () => {
  it("removes only that booking and returns it", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    expect(ok(await clearBooking(t.env.DB, e.event, a))).toEqual({ id: a, slotStart: e.s[0], dogName: "Rex", handlerName: "Sam" });
    expect(Object.keys(await slotsOf(e.id))).toEqual([String(b)]);
  });

  it("answers not_found the second time, with no error state", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    ok(await clearBooking(t.env.DB, e.event, a));
    expect(failed(await clearBooking(t.env.DB, e.event, a))).toMatchObject({ status: 404, code: "not_found" });
  });

  it("does not touch a booking of another event", async () => {
    const e = await seed();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, other.s[0], "Rex", "Sam");
    expect(failed(await clearBooking(t.env.DB, e.event, theirs)).status).toBe(404);
    expect(await slotsOf(other.id)).toEqual({ [theirs]: other.s[0] });
  });

  it("clears an orphan whose slot is not in the schedule", async () => {
    const e = await seed();
    const orphan = await insertBooking(t.env.DB, e.id, "2026-10-24T06:00:00Z", "Lost", "Lou");
    expect(ok(await clearBooking(t.env.DB, e.event, orphan)).dogName).toBe("Lost");
  });
});

describe("moveBooking", () => {
  const move = (e: Awaited<ReturnType<typeof seed>>, id: number, fromSlot: unknown, toSlot: unknown, hooks = {}) =>
    moveBooking(t.env.DB, e.event, id, { fromSlot, toSlot }, hooks);

  it("moves the booking to a free slot and leaves everything else alone", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const other = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    expect(ok(await move(e, a, e.s[0], e.s[5]))).toEqual({ id: a, slotStart: e.s[5], dogName: "Rex", handlerName: "Sam" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[5], [other]: e.s[1] });
  });

  it("refuses a taken slot, naming its holder, and changes nothing", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    const before = await rows(e.id);
    expect(failed(await move(e, a, e.s[0], e.s[1]))).toMatchObject({ status: 409, code: "slot_taken", extra: { booking: { id: b, dogName: "Bella", handlerName: "Alex" } } });
    expect(await rows(e.id)).toEqual(before);
  });

  it("refuses a slot that is not in the schedule (400 invalid_slot), moving to the same slot (400 same_slot) and non-string slots", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(failed(await move(e, a, e.s[0], "2026-10-24T09:00:00Z"))).toMatchObject({ status: 400, code: "invalid_slot" });
    expect(failed(await move(e, a, e.s[0], e.s[0]))).toMatchObject({ status: 400, code: "same_slot" });
    expect(failed(await move(e, a, undefined, e.s[3])).code).toBe("invalid_input");
    expect(failed(await move(e, a, e.s[0], 5)).code).toBe("invalid_input");
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[0] });
  });

  it("answers 409 changed when the booking is no longer at fromSlot", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(failed(await move(e, a, e.s[2], e.s[5]))).toMatchObject({ status: 409, code: "changed" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[0] });
  });

  it("answers 404 for a booking of another event or one that does not exist", async () => {
    const e = await seed();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, other.s[0], "Rex", "Sam");
    expect(failed(await move(e, theirs, other.s[0], e.s[5])).status).toBe(404);
    expect(failed(await move(e, 999999, e.s[0], e.s[5])).status).toBe(404);
    expect(await slotsOf(other.id)).toEqual({ [theirs]: other.s[0] });
  });

  it("moves into past or closed slots and on an archived event (admin override), and moves an orphan into the schedule", async () => {
    const e = await seed({ startUtc: "2020-03-07T09:00:00Z", endUtc: "2020-03-07T10:00:00Z", archived: true });
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    expect(ok(await move(e, a, e.s[0], e.s[2])).slotStart).toBe(e.s[2]);
    const orphan = await insertBooking(t.env.DB, e.id, "2020-03-07T06:00:00Z", "Lost", "Lou");
    expect(ok(await move(e, orphan, "2020-03-07T06:00:00Z", e.s[1])).slotStart).toBe(e.s[1]);
  });

  it("lets exactly one of two simultaneous moves into the same free slot win; the loser stays put", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const b = await insertBooking(t.env.DB, e.id, e.s[1], "Bella", "Alex");
    const [ra, rb] = await Promise.all([move(e, a, e.s[0], e.s[5]), move(e, b, e.s[1], e.s[5])]);
    const results = [ra, rb];
    expect(results.filter((r) => "ok" in r)).toHaveLength(1);
    const loser = failed(results.find((r) => !("ok" in r)));
    expect(loser).toMatchObject({ status: 409, code: "slot_taken" });
    const held = await slotsOf(e.id);
    expect(Object.values(held).sort()).toHaveLength(2);
    expect(Object.values(held).filter((s) => s === e.s[5])).toHaveLength(1);
    const winnerId = "ok" in ra ? a : b;
    expect(held[winnerId]).toBe(e.s[5]);
    expect(held[winnerId === a ? b : a]).toBe(winnerId === a ? e.s[1] : e.s[0]);
  });

  it("lets exactly one of a public booking and a move into the same free slot win", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const now = new Date("2026-10-01T12:00:00Z");
    const [moved, booked] = await Promise.all([
      move(e, a, e.s[0], e.s[5]),
      createBooking(t.env.DB, e.event, { start: e.s[5], end: e.s[5] }, { slot: e.s[5], dogName: "Pub", handlerName: "Lic", idempotencyKey: IDEM }, now),
    ]);
    expect(("ok" in moved ? 1 : 0) + (booked.kind === "created" ? 1 : 0)).toBe(1);
    if ("ok" in moved) expect(booked.kind).toBe("slot_taken");
    else expect(moved).toMatchObject({ status: 409, code: "slot_taken", extra: { booking: { dogName: "Pub" } } });
    expect(Object.values(await slotsOf(e.id)).filter((s) => s === e.s[5])).toHaveLength(1);
    expect(await rows(e.id)).toHaveLength(2);
  });

  it("aborts, writing nothing, when the event was edited between the read and the write", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[0], "Rex", "Sam");
    const f = failed(await move(e, a, e.s[0], e.s[5], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET session_minutes = 10 WHERE id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[0] });
  });
});

describe("swapBookings", () => {
  const swap = (e: Awaited<ReturnType<typeof seed>>, a: [number, string], b: [number, string], hooks = {}) =>
    swapBookings(t.env.DB, e.event, { a: { id: a[0], slot: a[1] }, b: { id: b[0], slot: b[1] } }, hooks);
  const PARKING = "0001-01-01T00:00:00Z";

  async function pair() {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam Smith");
    const b = await insertBooking(t.env.DB, e.id, e.s[6], "Bella", "Alex Jones");
    return { e, a, b };
  }

  it("swaps the slots of two bookings from different dogs and handlers, leaving the people with their bookings", async () => {
    const { e, a, b } = await pair();
    expect(ok(await swap(e, [a, e.s[1]], [b, e.s[6]]))).toEqual({ a: { id: a, slotStart: e.s[6] }, b: { id: b, slotStart: e.s[1] } });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[6], [b]: e.s[1] });
    const names = (await rows(e.id)).map((r) => (r as { id: number; dog_name: string }).dog_name);
    expect(names).toEqual(["Rex", "Bella"]);
  });

  it("swaps back and forth without leaving anything on the parking slot", async () => {
    const { e, a, b } = await pair();
    ok(await swap(e, [a, e.s[1]], [b, e.s[6]]));
    ok(await swap(e, [a, e.s[6]], [b, e.s[1]]));
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [b]: e.s[6] });
  });

  it("refuses to swap an orphan with a booking in the schedule, in either order, and changes nothing", async () => {
    const e = await seed();
    const a = await insertBooking(t.env.DB, e.id, e.s[1], "Rex", "Sam");
    const orphanSlot = "2026-10-24T06:00:00Z";
    const orphan = await insertBooking(t.env.DB, e.id, orphanSlot, "Lost", "Lou");
    const before = await rows(e.id);
    for (const [x, y] of [[[a, e.s[1]], [orphan, orphanSlot]], [[orphan, orphanSlot], [a, e.s[1]]]] as [number, string][][]) {
      expect(failed(await swap(e, x, y)), `${x} ${y}`).toMatchObject({ status: 400, code: "invalid_slot", message: "That time isn't one of this event's slots." });
    }
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [orphan]: orphanSlot });
    expect(await rows(e.id)).toEqual(before);
  });

  it("refuses to swap two orphans", async () => {
    const e = await seed();
    const x = await insertBooking(t.env.DB, e.id, "2026-10-24T06:00:00Z", "Lost", "Lou");
    const y = await insertBooking(t.env.DB, e.id, "2026-10-24T06:15:00Z", "Gone", "Gus");
    expect(failed(await swap(e, [x, "2026-10-24T06:00:00Z"], [y, "2026-10-24T06:15:00Z"])).code).toBe("invalid_slot");
    expect(await slotsOf(e.id)).toEqual({ [x]: "2026-10-24T06:00:00Z", [y]: "2026-10-24T06:15:00Z" });
  });

  it("refuses with 409 changed, writing nothing, when either booking is no longer where the admin saw it", async () => {
    const { e, a, b } = await pair();
    const before = await rows(e.id);
    expect(failed(await swap(e, [a, e.s[2]], [b, e.s[6]])).code).toBe("changed");
    expect(failed(await swap(e, [a, e.s[1]], [b, e.s[7]])).code).toBe("changed");
    expect(failed(await swap(e, [a, e.s[6]], [b, e.s[1]])).code).toBe("changed");
    expect(await rows(e.id)).toEqual(before);
  });

  it("refuses a booking swapped with itself (400)", async () => {
    const { e, a } = await pair();
    expect(failed(await swap(e, [a, e.s[1]], [a, e.s[1]]))).toMatchObject({ status: 400, code: "same_booking" });
  });

  it("answers 404 for another event's booking, alone or mixed with its own, and writes nothing", async () => {
    const { e, a } = await pair();
    const other = await seed();
    const theirs = await insertBooking(t.env.DB, other.id, other.s[3], "Foreign", "Fred");
    const before = [await rows(e.id), await rows(other.id)];
    expect(failed(await swap(e, [a, e.s[1]], [theirs, other.s[3]])).status).toBe(404);
    expect(failed(await swap(e, [theirs, other.s[3]], [a, e.s[1]])).status).toBe(404);
    expect(failed(await swap(e, [a, e.s[1]], [999999, e.s[4]])).status).toBe(404);
    expect([await rows(e.id), await rows(other.id)]).toEqual(before);
  });

  it("validates the body shape", async () => {
    const { e } = await pair();
    for (const raw of [{}, { a: 1, b: 2 }, { a: { id: "1", slot: "x" }, b: { id: 2, slot: "y" } }, { a: { id: 1, slot: "x" }, b: { id: -2, slot: "y" } }, { a: null, b: null }]) {
      expect(failed(await swapBookings(t.env.DB, e.event, raw as Record<string, unknown>)).code).toBe("invalid_input");
    }
  });

  it("rolls back completely when its last statement fails: both bookings exactly where they were, nothing parked", async () => {
    const { e, a, b } = await pair();
    const before = await rows(e.id);
    // Fires only on the third UPDATE (the one that takes the first booking off the parking slot), so the first two have already run.
    await t.env.DB.prepare(
      `CREATE TRIGGER force_swap_failure BEFORE UPDATE ON bookings WHEN OLD.slot_start_utc = '${PARKING}'
       BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
    ).run();
    try {
      const err = await caught(swap(e, [a, e.s[1]], [b, e.s[6]]));
      expect(err.message).toContain("forced failure");
    } finally {
      await t.env.DB.prepare("DROP TRIGGER force_swap_failure").run();
    }
    expect(await rows(e.id)).toEqual(before);
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [b]: e.s[6] });
    const parked = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE slot_start_utc = ?").bind(PARKING).first<{ n: number }>();
    expect(parked!.n).toBe(0);
    // And the swap works once the failure is gone.
    ok(await swap(e, [a, e.s[1]], [b, e.s[6]]));
  });

  it("refuses to run when a booking already holds the parking slot, writing nothing", async () => {
    const { e, a, b } = await pair();
    const squatter = await insertBooking(t.env.DB, e.id, PARKING, "Squat", "Sue");
    const before = await rows(e.id);
    expect(failed(await swap(e, [a, e.s[1]], [b, e.s[6]])).status).toBe(409);
    expect(await rows(e.id)).toEqual(before);
    expect((await slotsOf(e.id))[squatter]).toBe(PARKING);
  });

  it("aborts with event_changed, writing nothing, when the event was edited between the read and the write", async () => {
    const { e, a, b } = await pair();
    const before = await rows(e.id);
    const f = failed(await swap(e, [a, e.s[1]], [b, e.s[6]], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET gap_minutes = 5 WHERE id = ?").bind(e.id).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "event_changed" });
    expect(await rows(e.id)).toEqual(before);
  });

  it("answers changed, writing nothing, when a booking moves between the read and the write", async () => {
    const { e, a, b } = await pair();
    const f = failed(await swap(e, [a, e.s[1]], [b, e.s[6]], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = ? WHERE id = ?").bind(e.s[8], b).run(); },
    }));
    expect(f).toMatchObject({ status: 409, code: "changed" });
    expect(await slotsOf(e.id)).toEqual({ [a]: e.s[1], [b]: e.s[8] });
  });

  it("keeps a valid permutation, no row stuck on the parking slot and no lost booking, when two overlapping swaps race", async () => {
    for (let round = 0; round < 5; round++) {
      const e = await seed();
      const a = await insertBooking(t.env.DB, e.id, e.s[0], "A", "H1");
      const b = await insertBooking(t.env.DB, e.id, e.s[1], "B", "H2");
      const c = await insertBooking(t.env.DB, e.id, e.s[2], "C", "H3");
      const [x, y] = await Promise.all([swap(e, [a, e.s[0]], [b, e.s[1]]), swap(e, [b, e.s[1]], [c, e.s[2]])]);
      expect([x, y].some((r) => "ok" in r)).toBe(true);
      for (const r of [x, y]) if (!("ok" in r)) expect(r.code).toBe("changed");
      const held = await slotsOf(e.id);
      expect(Object.keys(held).map(Number).sort()).toEqual([a, b, c].sort());
      expect(Object.values(held).sort()).toEqual([e.s[0], e.s[1], e.s[2]]);
    }
  });
});

