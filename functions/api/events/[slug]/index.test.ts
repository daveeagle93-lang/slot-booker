import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../../../../src/core/identity";
import { createTestEnv, insertBreak, insertEvent, type TestEnv } from "../../../../src/test/db";
import { onRequestGet } from "./index";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

const get = (slug: string): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`http://localhost/api/events/${slug}`),
      env: t.env,
      params: { slug },
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

async function book(eventId: number, slotStart: string, dog: string, handler: string): Promise<void> {
  await t.env.DB.prepare(
    "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(eventId, slotStart, dog, handler, identityKey(dog), identityKey(handler))
    .run();
}

describe("GET /api/events/:slug", () => {
  it("maps the event details", async () => {
    const { slug } = await insertEvent(t.env.DB, {
      name: "Summer show", costPence: 1250, venuePostcode: "AB1 2CD", details: "Bring water",
    });
    const res = await get(slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { event: unknown };
    expect(body.event).toEqual({
      slug, name: "Summer show",
      startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T11:00:00Z",
      costPence: 1250, venuePostcode: "AB1 2CD", details: "Bring water", archived: false,
    });
  });

  it("lists sorted free slots and sets Cache-Control: no-store", async () => {
    const { slug } = await insertEvent(t.env.DB);
    const res = await get(slug);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { slots } = (await res.json()) as { slots: { start: string; end: string; status: string }[] };
    expect(slots).toHaveLength(12);
    expect(slots[0]).toEqual({ start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:15:00Z", status: "free" });
    expect(slots.map((s) => s.start)).toEqual([...slots.map((s) => s.start)].sort());
    expect(slots.every((s) => s.status === "free")).toBe(true);
  });

  it("offers no slots inside a break", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    const { slots } = (await (await get(slug)).json()) as { slots: { start: string }[] };
    const starts = slots.map((s) => s.start);
    expect(starts).toHaveLength(10);
    expect(starts).not.toContain("2026-06-13T09:00:00Z");
    expect(starts).not.toContain("2026-06-13T09:15:00Z");
    expect(starts).toContain("2026-06-13T09:30:00Z");
  });

  it("marks booked slots taken and the rest free; ignores bookings outside the schedule", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, "2026-06-13T08:15:00Z", "Rex", "Sam Jones");
    await book(id, "2026-06-13T08:07:00Z", "Fido", "Ann Lee");
    const { slots } = (await (await get(slug)).json()) as { slots: { start: string; status: string }[] };
    expect(slots).toHaveLength(12);
    expect(slots.filter((s) => s.status === "taken").map((s) => s.start)).toEqual(["2026-06-13T08:15:00Z"]);
  });

  it("returns 404 for an unknown slug", async () => {
    const res = await get("unknownslug0123456789");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("returns the same 404 for a malformed slug", async () => {
    const unknown = await get("unknownslug0123456789");
    const unknownBody = await unknown.json();
    for (const bad of ["short", "../etc/passwd", "a b c d e f g h i j k l", "é".repeat(20), "a".repeat(65)]) {
      const res = await get(bad);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(unknownBody);
    }
  });

  it("returns 200 with archived true and no slots for an archived event", async () => {
    const { slug } = await insertEvent(t.env.DB, { archived: true });
    const res = await get(slug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { archived: boolean }; slots: unknown[] };
    expect(body.event.archived).toBe(true);
    expect(body.slots).toEqual([]);
  });

  it("never leaks names, keys, ids or timestamps of bookings", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, "2026-06-13T08:00:00Z", "Zxqdogname", "Zxqhandlername");
    const res = await get(slug);
    const text = await res.text();
    expect(text).toContain('"taken"');
    for (const secret of ["Zxqdogname", "Zxqhandlername", "zxqdogname", "zxqhandlername", "dog", "handler", "key", "created"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["event", "slots"]);
    expect(Object.keys(body.event as object).sort()).toEqual(
      ["archived", "costPence", "details", "endUtc", "name", "slug", "startUtc", "venuePostcode"],
    );
    expect(text).not.toMatch(new RegExp(`"id"|"${id}"|:${id}[,}]`));
  });
});
