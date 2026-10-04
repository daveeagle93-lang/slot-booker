import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../../test/db";
import { clearAttempts, clientKey, countAttempt } from "./ratelimit";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const T0 = 1_800_000_000;
const rows = async () => (await t.env.DB.prepare("SELECT * FROM login_attempts ORDER BY key").all<{ key: string; attempts: number; window_start: number }>()).results;

describe("clientKey", () => {
  it("is the hex SHA-256 of the address, with one shared key when there is none", async () => {
    expect(await clientKey("203.0.113.9")).toMatch(/^[0-9a-f]{64}$/);
    expect(await clientKey("203.0.113.9")).toBe(await clientKey("203.0.113.9"));
    expect(await clientKey("203.0.113.9")).not.toBe(await clientKey("203.0.113.10"));
    expect(await clientKey(null)).toBe(await clientKey(null));
    expect(await clientKey("203.0.113.9")).not.toBe("203.0.113.9");
  });
});

describe("countAttempt", () => {
  it("allows five attempts per window, then refuses with the seconds left", async () => {
    const key = await clientKey("198.51.100.1");
    for (let i = 1; i <= 5; i++) expect((await countAttempt(t.env.DB, key, T0 + i)).allowed, `attempt ${i}`).toBe(true);
    const sixth = await countAttempt(t.env.DB, key, T0 + 100);
    expect(sixth).toEqual({ allowed: false, retryAfterSeconds: 900 - 99 });
    expect((await countAttempt(t.env.DB, key, T0 + 899)).allowed).toBe(false);
  });

  it("starts a new window exactly 900 s after the first attempt of the old one", async () => {
    const key = await clientKey("198.51.100.2");
    for (let i = 0; i < 6; i++) await countAttempt(t.env.DB, key, T0);
    expect((await countAttempt(t.env.DB, key, T0 + 899)).allowed).toBe(false);
    expect((await countAttempt(t.env.DB, key, T0 + 900)).allowed).toBe(true);
    const row = (await rows()).find((r) => r.key === key)!;
    expect(row).toEqual({ key, attempts: 1, window_start: T0 + 900 });
  });

  it("counts per key", async () => {
    const a = await clientKey("198.51.100.3");
    const b = await clientKey("198.51.100.4");
    for (let i = 0; i < 6; i++) await countAttempt(t.env.DB, a, T0);
    expect((await countAttempt(t.env.DB, a, T0)).allowed).toBe(false);
    expect((await countAttempt(t.env.DB, b, T0)).allowed).toBe(true);
  });

  it("never lets parallel attempts exceed the limit", async () => {
    const key = await clientKey("198.51.100.5");
    const results = await Promise.all(Array.from({ length: 12 }, () => countAttempt(t.env.DB, key, T0)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("clearAttempts forgets a client", async () => {
    const key = await clientKey("198.51.100.6");
    for (let i = 0; i < 6; i++) await countAttempt(t.env.DB, key, T0);
    await clearAttempts(t.env.DB, key);
    expect((await rows()).some((r) => r.key === key)).toBe(false);
    expect((await countAttempt(t.env.DB, key, T0)).allowed).toBe(true);
  });

  it("purges rows whose window ended more than a day ago, and keeps the rest", async () => {
    const old = await clientKey("198.51.100.7");
    const recent = await clientKey("198.51.100.8");
    await countAttempt(t.env.DB, old, T0);
    await countAttempt(t.env.DB, recent, T0 + 86_400);
    await countAttempt(t.env.DB, await clientKey("198.51.100.9"), T0 + 86_400 + 900); // window of `old` ended exactly a day ago
    expect((await rows()).some((r) => r.key === old)).toBe(true);
    await countAttempt(t.env.DB, await clientKey("198.51.100.9"), T0 + 86_400 + 901);
    const keys = (await rows()).map((r) => r.key);
    expect(keys).not.toContain(old);
    expect(keys).toContain(recent);
  });

  it("stores only hashes", async () => {
    await countAttempt(t.env.DB, await clientKey("192.0.2.77"), T0);
    expect(JSON.stringify(await rows())).not.toContain("192.0.2.77");
  });
});
