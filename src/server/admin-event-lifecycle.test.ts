import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../test/db";
import { deleteEvent } from "./admin-event-lifecycle";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => { await t.env.DB.prepare("DELETE FROM events").run(); });

const count = async (table: string): Promise<number> => (await t.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const rows = async () => [await count("events"), await count("breaks"), await count("bookings")];

async function seed(name = "Show") {
  const e = await insertEvent(t.env.DB, { name, startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z" });
  await insertBreak(t.env.DB, e.id, "2026-10-24T08:30:00Z", "2026-10-24T08:40:00Z");
  await insertBooking(t.env.DB, e.id, "2026-10-24T08:00:00Z", "Alpha", "Ann");
  return e;
}

describe("deleteEvent: a request lands between the read and the batch", () => {
  it("deletes a booking added after the read too, counts it, and leaves no orphan rows", async () => {
    const e = await seed();
    let late = 0;
    const result = await deleteEvent(t.env.DB, e.slug, "Show", {
      afterRead: async () => { late = await insertBooking(t.env.DB, e.id, "2026-10-24T08:15:00Z", "Late", "Lee"); },
    });
    expect(late).toBeGreaterThan(0);
    expect(result).toEqual({ kind: "deleted", slug: e.slug, name: "Show", bookings: 2 });
    expect(await rows()).toEqual([0, 0, 0]);
  });

  it("answers not_found, deleting nothing else, when the event was deleted after the read (a second delete racing the first)", async () => {
    const e = await seed();
    const keep = await seed("Keeper");
    const result = await deleteEvent(t.env.DB, e.slug, "Show", {
      afterRead: async () => { await t.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(e.id).run(); },
    });
    expect(result).toEqual({ kind: "not_found" });
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM bookings WHERE event_id = ?").bind(keep.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("refuses, deleting nothing, when the event was renamed after the confirmation was read", async () => {
    const e = await seed();
    const result = await deleteEvent(t.env.DB, e.slug, "Show", {
      afterRead: async () => { await t.env.DB.prepare("UPDATE events SET name = 'Renamed' WHERE id = ?").bind(e.id).run(); },
    });
    expect(result).toEqual({ kind: "confirmation_mismatch" });
    expect(await rows()).toEqual([1, 1, 1]);
  });

  it("two simultaneous deletes: one deletes, the other gets not_found, and every row is gone", async () => {
    const e = await seed();
    const results = await Promise.all([deleteEvent(t.env.DB, e.slug, "Show"), deleteEvent(t.env.DB, e.slug, "Show")]);
    expect(results.map((r) => r.kind).sort()).toEqual(["deleted", "not_found"]);
    expect(await rows()).toEqual([0, 0, 0]);
  });
});
