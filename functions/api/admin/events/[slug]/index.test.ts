import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlug } from "../../../../../src/core/slug";
import { createTestEnv, insertBooking, insertBreak, insertEvent, type TestEnv } from "../../../../../src/test/db";
import { onRequestGet } from "./index";

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

/** Pass a second argument (even undefined) to replace the admin data. */
const get = (slug: string, ...data: unknown[]): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`http://localhost/api/admin/events/${slug}`), env: t.env, params: { slug }, data: data.length > 0 ? data[0] : ADMIN,
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

interface Detail {
  event: Record<string, unknown>;
  slots: { start: string; end: string; booking: { id: number; dogName: string; handlerName: string } | null }[];
  orphans: { id: number; slotStart: string; dogName: string; handlerName: string }[];
}
const detail = async (slug: string): Promise<Detail> => {
  const res = await get(slug);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
};

describe("GET /api/admin/events/[slug]", () => {
  it("returns the event as the form uses it, London-local on a BST date, with UTC alongside, no-store", async () => {
    const { id, slug } = await insertEvent(t.env.DB, {
      name: "Saturday trial day", startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z",
      sessionMinutes: 15, gapMinutes: 5, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water",
    });
    await insertBreak(t.env.DB, id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z", "Lunch");
    const res = await get(slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Detail;
    expect(body.event).toEqual({
      slug, name: "Saturday trial day", archived: false, date: "2026-10-24", start: "09:00", end: "12:00",
      sessionMinutes: 15, gapMinutes: 5, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water",
      startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z",
      breaks: [{ start: "10:00", end: "10:30", label: "Lunch", startUtc: "2026-10-24T09:00:00Z", endUtc: "2026-10-24T09:30:00Z" }],
    });
    expect(body.orphans).toEqual([]);
  });

  it("returns a GMT date as it is (2026-10-31: 09:00 is 09:00Z)", async () => {
    const { slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-31T09:00:00Z", endUtc: "2026-10-31T12:00:00Z" });
    expect((await detail(slug)).event).toMatchObject({ date: "2026-10-31", start: "09:00", end: "12:00" });
  });

  it("reads London times right across the clocks going forward (2026-03-29)", async () => {
    // 00:30 is GMT (00:30Z), 10:00 is BST (09:00Z); the break at 03:30-04:00 BST is 02:30Z-03:00Z.
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-03-29T00:30:00Z", endUtc: "2026-03-29T09:00:00Z", sessionMinutes: 30 });
    await insertBreak(t.env.DB, id, "2026-03-29T02:30:00Z", "2026-03-29T03:00:00Z");
    const { event } = await detail(slug);
    expect(event).toMatchObject({ date: "2026-03-29", start: "00:30", end: "10:00" });
    expect(event.breaks).toEqual([{ start: "03:30", end: "04:00", label: "", startUtc: "2026-03-29T02:30:00Z", endUtc: "2026-03-29T03:00:00Z" }]);
  });

  it("reads London times right across the clocks going back (2026-10-25)", async () => {
    // 00:30 is still BST, so it is 23:30Z the evening before; 10:00 is GMT (10:00Z); the break at 09:00 GMT is 09:00Z.
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T23:30:00Z", endUtc: "2026-10-25T10:00:00Z", sessionMinutes: 30 });
    await insertBreak(t.env.DB, id, "2026-10-25T09:00:00Z", "2026-10-25T09:30:00Z", "Tea");
    const { event } = await detail(slug);
    expect(event).toMatchObject({ date: "2026-10-25", start: "00:30", end: "10:00" });
    expect(event.breaks).toEqual([{ start: "09:00", end: "09:30", label: "Tea", startUtc: "2026-10-25T09:00:00Z", endUtc: "2026-10-25T09:30:00Z" }]);
  });

  it("lists breaks in time order with their labels, including a Unicode one", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z" });
    await insertBreak(t.env.DB, id, "2026-10-24T10:00:00Z", "2026-10-24T10:10:00Z", "Café ☕ 😀");
    await insertBreak(t.env.DB, id, "2026-10-24T09:00:00Z", "2026-10-24T09:30:00Z");
    expect((await detail(slug)).event.breaks).toMatchObject([{ start: "10:00", label: "" }, { start: "11:00", label: "Café ☕ 😀" }]);
  });

  it("lists every slot of the schedule with its booking or null", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    const bookingId = await insertBooking(t.env.DB, id, "2026-10-24T08:20:00Z", "Rex", "Sam Smith");
    const { slots, orphans } = await detail(slug);
    expect(slots).toEqual([
      { start: "2026-10-24T08:00:00Z", end: "2026-10-24T08:20:00Z", booking: null },
      { start: "2026-10-24T08:20:00Z", end: "2026-10-24T08:40:00Z", booking: { id: bookingId, dogName: "Rex", handlerName: "Sam Smith" } },
      { start: "2026-10-24T08:40:00Z", end: "2026-10-24T09:00:00Z", booking: null },
    ]);
    expect(orphans).toEqual([]);
  });

  it("surfaces bookings whose slot is not in the schedule as orphans instead of hiding them", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    await insertBooking(t.env.DB, id, "2026-10-24T08:05:00Z", "Zed", "Zoe");
    const orphanId = await insertBooking(t.env.DB, id, "2026-10-24T07:00:00Z", "Early", "Eve");
    const { slots, orphans } = await detail(slug);
    expect(slots.every((s) => s.booking === null)).toBe(true);
    expect(orphans.map((o) => o.dogName)).toEqual(["Early", "Zed"]);
    expect(orphans[0]).toEqual({ id: orphanId, slotStart: "2026-10-24T07:00:00Z", dogName: "Early", handlerName: "Eve" });
  });

  it("shows an archived event, flagged", async () => {
    const { slug } = await insertEvent(t.env.DB, { archived: true });
    expect((await detail(slug)).event.archived).toBe(true);
  });

  it("returns 404 for an unknown or malformed slug, no-store", async () => {
    for (const slug of [generateSlug(), "nope", "x".repeat(100), "preview"]) {
      const res = await get(slug);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
  });

  it("does not show another event's bookings", async () => {
    const a = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    const b = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T09:00:00Z", sessionMinutes: 20 });
    await insertBooking(t.env.DB, b.id, "2026-10-24T08:00:00Z", "Rex", "Sam");
    expect((await detail(a.slug)).slots.map((s) => s.booking)).toEqual([null, null, null]);
  });

  it("refuses with 401 unless the middleware set an admin identity", async () => {
    const { slug } = await insertEvent(t.env.DB);
    for (const data of [undefined, {}, { admin: { identity: "" } }]) {
      const res = await get(slug, data);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
