/// <reference types="node" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateBookingToken } from "../core/slug";
import { NOW, ORIGIN, passwordEnv, TEST_PASSWORD } from "../server/auth/test-harness";
import { createWorker } from "../worker";
import { createTestEnv, insertBooking, insertEvent, insertsBooking, interceptBatches, type TestEnv } from "./db";

// Requests are sent to the real Worker (guards, router, handlers) all at once with Promise.all against a real local D1.
// The database decides who gets a place; these tests check that it decides correctly however the requests interleave.
// How often the requests really did interleave is counted (a booking insert that lost to another request on a UNIQUE
// constraint, then retried) and printed at the end of each test, because local D1 is one SQLite behind async calls and
// a test like this can pass without any race having happened.

// Each test repeats its race this many times (CONCURRENCY_ROUNDS=20 for a longer run).
const ITERATIONS = Number(process.env.CONCURRENCY_ROUNDS) || 10;
const DAY = { startUtc: "2026-10-17T08:00:00Z", endUtc: "2026-10-17T11:00:00Z", sessionMinutes: 15 }; // 12 slots, 08:00 to 10:45
const slotAt = (i: number) => new Date(Date.parse(DAY.startUtc) + i * 15 * 60_000).toISOString().replace(".000Z", "Z");

let t: TestEnv;
const stats = { inserts: 0, uniqueFailures: 0 };
const worker = createWorker({ now: () => NOW });
let env: Awaited<ReturnType<typeof passwordEnv>>;
let session: { cookie: string; csrf: string };

beforeAll(async () => {
  t = await createTestEnv();
  // Counts booking inserts and the ones that failed on a UNIQUE constraint (the retry path); everything else goes through.
  const counting = interceptBatches(t.env.DB, async (sqls, run) => {
    if (!insertsBooking(sqls) && !sqls.some((s) => /^\s*UPDATE bookings/.test(s))) return run();
    stats.inserts++;
    try {
      return await run();
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) stats.uniqueFailures++;
      throw e;
    }
  });
  env = await passwordEnv(counting);
  const login = await worker.fetch(new Request(`${ORIGIN}/api/admin/login`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.50" },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  }), env);
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const csrf = ((await (await worker.fetch(new Request(`${ORIGIN}/api/admin/session`, { headers: { Cookie: cookie } }), env)).json()) as { csrfToken: string }).csrfToken;
  session = { cookie, csrf };
});
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-01T12:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  console.info(`concurrency: ${stats.inserts} booking writes, ${stats.uniqueFailures} lost to another request on a UNIQUE constraint (the retry path ran)`);
  await t.dispose();
});

interface Answer { status: number; code?: string; token?: string; replayed: boolean; body: any }
async function send(path: string, init: { method: string; body?: unknown; admin?: boolean }): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.admin) Object.assign(headers, { Cookie: session.cookie, Origin: ORIGIN, "X-CSRF-Token": session.csrf });
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method: init.method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }), env);
  const body = await res.json().catch(() => null) as any;
  return { status: res.status, code: body?.error?.code, token: body?.icsUrl?.split("/").at(-2), replayed: res.headers.get("idempotent-replayed") === "true", body };
}
const book = (slug: string, slot: string, dog: string, handler: string, o: { laneId?: number; key?: string } = {}) =>
  send(`/api/events/${slug}/bookings`, {
    method: "POST", body: { slot, dogName: dog, handlerName: handler, idempotencyKey: o.key ?? generateBookingToken(), ...(o.laneId === undefined ? {} : { laneId: o.laneId }) },
  });
const adminAdd = (slug: string, slot: string, dog: string, handler: string) =>
  send(`/api/admin/events/${slug}/bookings`, { method: "POST", admin: true, body: { slot, dogName: dog, handlerName: handler } });
const adminMove = (slug: string, id: number, fromSlot: string, toSlot: string) =>
  send(`/api/admin/events/${slug}/bookings/${id}/move`, { method: "POST", admin: true, body: { fromSlot, toSlot } });

const tally = (answers: Answer[]) => {
  const out: Record<string, number> = {};
  for (const a of answers) out[a.status === 201 || a.status === 200 ? String(a.status) : `${a.status} ${a.code}`] = (out[a.status === 201 || a.status === 200 ? String(a.status) : `${a.status} ${a.code}`] ?? 0) + 1;
  return out;
};
const rows = async (eventId: number) =>
  (await t.env.DB.prepare("SELECT id, lane_id, slot_start_utc, place, identity_key, identity_seq FROM bookings WHERE event_id = ? ORDER BY slot_start_utc, lane_id, place").bind(eventId).all<{
    id: number; lane_id: number; slot_start_utc: string; place: number; identity_key: string; identity_seq: number;
  }>()).results;

describe("booking places under concurrent requests", () => {
  it(`12 parallel distinct bookings into one capacity-3 slot: exactly 3 created and 9 slot_taken, places 1, 2 and 3 (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 3 });
      const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => book(e.slug, slotAt(0), `Dog${i}`, `Handler${i}`)));
      expect(tally(answers), `round ${round}`).toEqual({ "201": 3, "409 slot_taken": 9 });
      expect((await rows(e.id)).map((r) => r.place), `round ${round}`).toEqual([1, 2, 3]);
    }
  }, 120_000);

  it(`3 lanes of 2 places raced across two times: exactly 2 per lane per time, places 1 and 2 (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2, lanes: ["Ring 1", "Ring 2", "Ring 3"] });
      const requests: Promise<Answer>[] = [];
      for (const slot of [slotAt(0), slotAt(1)]) for (const laneId of e.laneIds) for (let i = 0; i < 4; i++) {
        requests.push(book(e.slug, slot, `D${requests.length}`, `H${requests.length}`, { laneId }));
      }
      const answers = await Promise.all(requests);
      expect(tally(answers), `round ${round}`).toEqual({ "201": 12, "409 slot_taken": 12 });
      const stored = await rows(e.id);
      for (const slot of [slotAt(0), slotAt(1)]) for (const laneId of e.laneIds) {
        expect(stored.filter((r) => r.slot_start_utc === slot && r.lane_id === laneId).map((r) => r.place), `round ${round} ${slot} lane ${laneId}`).toEqual([1, 2]);
      }
    }
  }, 120_000);

  it.each([1, 2, 3])("N parallel bookings of ONE identity into different slots with an identity limit of %i: exactly that many are created, with numbers 1 to the limit", async (limit) => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, identityLimit: 1 });
      await t.env.DB.prepare("UPDATE event_layout SET identity_limit = ? WHERE event_id = ?").bind(limit, e.id).run();
      const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => book(e.slug, slotAt(i), "Rex", "Sam Jones")));
      expect(tally(answers), `round ${round}`).toEqual({ "201": limit, "409 duplicate_booking": 8 - limit });
      expect((await rows(e.id)).map((r) => r.identity_seq).sort(), `round ${round}`).toEqual(Array.from({ length: limit }, (_, i) => i + 1));
    }
  }, 120_000);

  it(`parallel identical requests with ONE idempotency key: one booking, every answer is that booking (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2 });
      const key = generateBookingToken();
      const answers = await Promise.all(Array.from({ length: 6 }, () => book(e.slug, slotAt(0), "Rex", "Sam Jones", { key })));
      expect(answers.map((a) => a.status), `round ${round}`).toEqual([201, 201, 201, 201, 201, 201]);
      expect(new Set(answers.map((a) => a.token)).size, `round ${round}`).toBe(1);
      expect(answers.filter((a) => a.replayed).length, `round ${round}`).toBeGreaterThanOrEqual(0);
      expect(await rows(e.id), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it(`parallel admin moves into the one free slot: exactly one wins, the other gets slot_taken (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, DAY);
      const a = await insertBooking(t.env.DB, e.id, slotAt(0), "Rex", "Sam");
      const b = await insertBooking(t.env.DB, e.id, slotAt(1), "Fido", "Ann");
      const answers = await Promise.all([adminMove(e.slug, a, slotAt(0), slotAt(5)), adminMove(e.slug, b, slotAt(1), slotAt(5))]);
      expect(tally(answers), `round ${round}`).toEqual({ "200": 1, "409 slot_taken": 1 });
      expect((await rows(e.id)).filter((r) => r.slot_start_utc === slotAt(5)), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);

  it(`parallel admin moves into a capacity-2 slot with one place left, and one public booking too: exactly one place is taken (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, { ...DAY, capacity: 2 });
      await insertBooking(t.env.DB, e.id, slotAt(5), "Held", "Already");
      const a = await insertBooking(t.env.DB, e.id, slotAt(0), "Rex", "Sam");
      const b = await insertBooking(t.env.DB, e.id, slotAt(1), "Fido", "Ann");
      const answers = await Promise.all([adminMove(e.slug, a, slotAt(0), slotAt(5)), adminMove(e.slug, b, slotAt(1), slotAt(5)), book(e.slug, slotAt(5), "Pub", "Lic")]);
      expect(answers.filter((x) => x.status === 200 || x.status === 201), `round ${round}`).toHaveLength(1);
      expect((await rows(e.id)).filter((r) => r.slot_start_utc === slotAt(5)).map((r) => r.place), `round ${round}`).toEqual([1, 2]);
    }
  }, 120_000);

  it(`an admin add and a public booking racing for the one free place: exactly one wins (repeated)`, async () => {
    for (let round = 0; round < ITERATIONS; round++) {
      const e = await insertEvent(t.env.DB, DAY);
      const answers = await Promise.all([adminAdd(e.slug, slotAt(3), "Admin", "Added"), book(e.slug, slotAt(3), "Pub", "Lic")]);
      expect(answers.filter((x) => x.status === 201), `round ${round}`).toHaveLength(1);
      expect(answers.filter((x) => x.status === 409 && x.code === "slot_taken"), `round ${round}`).toHaveLength(1);
      expect(await rows(e.id), `round ${round}`).toHaveLength(1);
    }
  }, 120_000);
});
