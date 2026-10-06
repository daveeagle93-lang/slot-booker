import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../test/db";
import { eventDetail, loadBookings, saveEventEdit } from "./admin-event-edit";
import { parseEventDraft, type EventDraft } from "./admin-events";
import { loadEventBySlug } from "./events";

const NOW = new Date("2026-10-01T12:00:00Z");

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

// 2026-10-24 (BST), 09:00-12:00 with a 10:00-10:30 break. Slot starts (Z): 08:00 08:15 08:30 08:45 | 09:30 ... 10:45.
async function seed() {
  const e = await insertEvent(t.env.DB, {
    startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z", sessionMinutes: 15, name: "Original",
  });
  await insertBreak(t.env.DB, e.id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
  const keep = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Alpha", "Ann");
  const b = await insertBooking(t.env.DB, e.id, "2026-10-24T10:30:00Z", "Bravo", "Bob");
  const c = await insertBooking(t.env.DB, e.id, "2026-10-24T10:45:00Z", "Charlie", "Cat");
  return { ...e, keep, b, c };
}

/** The edit that ends the event at 11:30 (10:30Z), dropping the 10:30Z and 10:45Z slots. */
function shortened(over: Record<string, unknown> = {}): EventDraft {
  const r = parseEventDraft({
    name: "Edited", date: "2026-10-24", start: "09:00", end: "11:30", sessionMinutes: 15, gapMinutes: 0, costPence: 1500,
    venuePostcode: "AB1 2CD", details: "", breaks: [{ start: "10:00", end: "10:30", label: "Renamed lunch" }], ...over,
  }, { now: NOW, requireFuture: false });
  if (!("draft" in r)) throw new Error(JSON.stringify(r.fields));
  return r.draft;
}

async function snapshot(eventId: number): Promise<string> {
  const q = async (sql: string) => (await t.env.DB.prepare(sql).bind(eventId).all()).results;
  return JSON.stringify([
    await q("SELECT * FROM events WHERE id = ?"), await q("SELECT * FROM breaks WHERE event_id = ? ORDER BY id"),
    await q("SELECT * FROM bookings WHERE event_id = ? ORDER BY id"),
  ]);
}

const load = async (slug: string) => (await loadEventBySlug(t.env.DB, slug))!;

describe("saveEventEdit: listed", () => {
  const listedOf = async (id: number) => (await t.env.DB.prepare("SELECT listed FROM events WHERE id = ?").bind(id).first<{ listed: number }>())!.listed;

  it("leaves listed as it is in the database when the draft omits it, even if it changed after the event was loaded", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET listed = 0 WHERE id = ?").bind(e.id).run(); },
    });
    expect(result.kind).toBe("saved");
    expect(await listedOf(e.id)).toBe(0);
  });

  it("still writes listed when the draft says it, either way", async () => {
    const e = await seed();
    await saveEventEdit(t.env.DB, await load(e.slug), shortened({ listed: false }), [e.b, e.c]);
    expect(await listedOf(e.id)).toBe(0);
    await saveEventEdit(t.env.DB, await load(e.slug), shortened({ listed: true }), []);
    expect(await listedOf(e.id)).toBe(1);
  });
});

describe("saveEventEdit: a booking lands between the read and the save", () => {
  it("aborts the whole batch, writing nothing, and returns the fresh list including the newcomer", async () => {
    const e = await seed();
    // Bravo cancels, so the 10:30Z slot is free; only Charlie (10:45Z) is affected and confirmed.
    await t.env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(e.b).run();
    const was = JSON.parse(await snapshot(e.id)) as unknown[][];
    let newcomer = 0;
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.c], {
      // Delta books the 10:30Z slot after the read: the edit removes that slot too, but Delta was never confirmed.
      afterRead: async () => { newcomer = await insertBooking(t.env.DB, e.id, "2026-10-24T10:30:00Z", "Delta", "Dee"); },
    });
    expect(result).toEqual({
      kind: "bookings_affected",
      affected: [
        { id: newcomer, slotStart: "2026-10-24T10:30:00Z", dogName: "Delta", handlerName: "Dee" },
        { id: e.c, slotStart: "2026-10-24T10:45:00Z", dogName: "Charlie", handlerName: "Cat" },
      ],
    });
    // Event fields not updated, breaks not replaced, the confirmed booking not deleted: only the newcomer is new.
    const after = JSON.parse(await snapshot(e.id)) as unknown[][];
    expect(after[0]).toEqual(was[0]);
    expect(after[1]).toEqual(was[1]);
    expect((after[2] as { id: number }[]).map((b) => b.id)).toEqual([e.keep, e.c, newcomer]);
    expect(after[2].slice(0, 2)).toEqual(was[2]);
  });

  it("saves normally when the booking lands on a slot that stays", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], {
      afterRead: async () => { await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Echo", "Eli"); },
    });
    expect(result.kind).toBe("saved");
    const names = (await t.env.DB.prepare("SELECT value_1 FROM bookings WHERE event_id = ? ORDER BY slot_start_utc").bind(e.id).all<{ value_1: string }>()).results;
    expect(names.map((r) => r.value_1)).toEqual(["Alpha", "Echo"]);
  });

  it("aborts with every confirmed booking still in place when a newcomer takes another removed slot", async () => {
    const e = await seed();
    // The deeper cut (end 11:15) also removes the 10:15Z slot, which Foxtrot books after the read.
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened({ end: "11:15" }), [e.b, e.c], {
      afterRead: async () => { await insertBooking(t.env.DB, e.id, "2026-10-24T10:15:00Z", "Foxtrot", "Fay"); },
    });
    expect(result.kind === "bookings_affected" && result.affected.map((a) => a.dogName)).toEqual(["Foxtrot", "Bravo", "Charlie"]);
    const names = (await t.env.DB.prepare("SELECT value_1 FROM bookings WHERE event_id = ? ORDER BY slot_start_utc").bind(e.id).all<{ value_1: string }>()).results;
    expect(names.map((r) => r.value_1)).toEqual(["Alpha", "Foxtrot", "Bravo", "Charlie"]);
    expect((await load(e.slug)).name).toBe("Original");
  });

  it("lets two identical confirmed saves both succeed, removing each booking once", async () => {
    const e = await seed();
    const event = await load(e.slug);
    const [one, two] = await Promise.all([
      saveEventEdit(t.env.DB, event, shortened(), [e.b, e.c]),
      saveEventEdit(t.env.DB, event, shortened(), [e.b, e.c]),
    ]);
    expect(one.kind).toBe("saved");
    expect(two.kind).toBe("saved");
    const removed = [one, two].flatMap((r) => (r.kind === "saved" ? r.removed.map((b) => b.id) : [])).sort();
    expect(removed).toEqual([e.b, e.c].sort());
  });
});

describe("saveEventEdit: the event is deleted between the read and the save", () => {
  const strayRows = async (): Promise<number> => (await t.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bookings WHERE event_id NOT IN (SELECT id FROM events))
          + (SELECT COUNT(*) FROM breaks WHERE event_id NOT IN (SELECT id FROM events)) AS n`,
  ).first<{ n: number }>())!.n;
  const deleteIt = (id: number) => async () => { await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run(); };

  it("answers not_found and writes nothing, for a draft with breaks (which would insert rows for a missing event)", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], { afterRead: deleteIt(e.id) });
    expect(result).toEqual({ kind: "not_found" });
    expect(await snapshot(e.id)).toBe(JSON.stringify([[], [], []]));
    expect(await strayRows()).toBe(0);
  });

  it("answers not_found, not saved, for a draft with no breaks (nothing else would fail)", async () => {
    const e = await seed();
    const result = await saveEventEdit(t.env.DB, await load(e.slug), shortened({ breaks: [] }), [e.b, e.c], { afterRead: deleteIt(e.id) });
    expect(result).toEqual({ kind: "not_found" });
    expect(await strayRows()).toBe(0);
  });

  it("leaves another event untouched", async () => {
    const e = await seed();
    const other = await seed();
    const before = await snapshot(other.id);
    await saveEventEdit(t.env.DB, await load(e.slug), shortened(), [e.b, e.c], { afterRead: deleteIt(e.id) });
    expect(await snapshot(other.id)).toBe(before);
  });
});

describe("bookings of an event with several lanes and places", () => {
  it("loadBookings lists them by slot, then lane position, then place", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    const [l1, l2] = e.laneIds;
    const late = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Late", "H", { laneId: l1 });
    const r2p1 = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "R2P1", "H", { laneId: l2, place: 1 });
    const r1p2 = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "R1P2", "H", { laneId: l1, place: 2 });
    const r1p1 = await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "R1P1", "H", { laneId: l1, place: 1 });
    expect((await loadBookings(t.env.DB, e.id)).map((b) => b.id)).toEqual([r1p1, r1p2, r2p1, late]);
  });

  it("the schedule detail shows one booking per slot for now: the first by lane and place", async () => {
    const e = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T08:30:00Z", capacity: 2, lanes: ["Ring 1", "Ring 2"] });
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Second", "H", { laneId: e.laneIds[1], place: 1 });
    await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "First", "H", { laneId: e.laneIds[0], place: 1 });
    const detail = await eventDetail(t.env.DB, (await loadEventBySlug(t.env.DB, e.slug))!);
    expect(detail.slots.map((s) => s.booking?.dogName ?? null)).toEqual(["First", null]);
  });
});
