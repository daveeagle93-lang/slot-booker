import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256, utf8 } from "./auth/crypto";
import { d1Env, SETUP_CODE } from "./auth/test-harness";
import { createTestEnv, type TestEnv } from "../test/db";
import { MIN_SETUP_CODE_LENGTH, setupCodeMatches, setupState } from "./setup";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => { await t.env.DB.prepare("DELETE FROM admin_credentials").run(); });

/** A database that fails the test if anything uses it: the states that never look at credentials must not. */
const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`The database was used (${String(key)})`); } }) as D1Database;

const HASH = `hmac-sha256$${"A".repeat(22)}$${"B".repeat(43)}`;
const putRow = (firstLoginAt: string | null) =>
  t.env.DB.prepare("INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at, first_login_at) VALUES (1, ?, ?, ?, ?)")
    .bind(HASH, "s".repeat(43), "2026-10-05T10:00:00.000Z", firstLoginAt).run();

describe("setupState: closed", () => {
  it("is closed unless ADMIN_AUTH is exactly password, without reading the database", async () => {
    for (const ADMIN_AUTH of [undefined, "", "access", "none", "Password", "password ", "ACCESS"]) {
      expect(await setupState(d1Env(noDb, { ADMIN_AUTH })), String(ADMIN_AUTH)).toBe("closed");
    }
  });

  it("is closed in env mode, when either ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET is set, without reading the database", async () => {
    expect(await setupState(d1Env(noDb, { ADMIN_PASSWORD_HASH: HASH }))).toBe("closed");
    expect(await setupState(d1Env(noDb, { ADMIN_SESSION_SECRET: "s".repeat(40) }))).toBe("closed");
    expect(await setupState(d1Env(noDb, { ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: "s".repeat(40) }))).toBe("closed");
    expect(await setupState(d1Env(noDb, { ADMIN_PASSWORD_HASH: "garbage" }))).toBe("closed"); // fail closed, even if unusable
    expect(await setupState(d1Env(noDb, { ADMIN_SESSION_SECRET: "x", SETUP_CODE: undefined }))).toBe("closed");
  });

  it("treats an empty ADMIN_PASSWORD_HASH or ADMIN_SESSION_SECRET as not set", async () => {
    expect(await setupState(d1Env(t.env.DB, { ADMIN_PASSWORD_HASH: "", ADMIN_SESSION_SECRET: "" }))).toBe("open");
  });

  it("is closed once the first sign-in has happened, even if SETUP_CODE has gone", async () => {
    await putRow("2026-10-05T11:00:00.000Z");
    expect(await setupState(d1Env(t.env.DB))).toBe("closed");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: undefined }))).toBe("closed");
  });
});

describe("setupState: not_ready", () => {
  it("needs a SETUP_CODE of at least 12 characters once trimmed (enforced at runtime)", async () => {
    expect(MIN_SETUP_CODE_LENGTH).toBe(12);
    for (const SETUP_CODE of [undefined, "", "   ", "short", "12345678901", "   12345678901   ", "​​12345678901​"]) {
      expect(await setupState(d1Env(t.env.DB, { SETUP_CODE })), JSON.stringify(SETUP_CODE)).toBe("not_ready");
    }
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: "123456789012" }))).toBe("open");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: "  123456789012  " }))).toBe("open");
  });

  it("is not_ready with a row awaiting its first sign-in too, if the code has gone", async () => {
    await putRow(null);
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: undefined }))).toBe("not_ready");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: "short" }))).toBe("not_ready");
  });
});

describe("setupState: open", () => {
  it("is open with no credentials yet", async () => {
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
  });

  it("is open while a row has not been used to sign in, so setup can be run again", async () => {
    await putRow(null);
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
  });

  it("reopens when the row is deleted (the recovery path), and still needs SETUP_CODE", async () => {
    await putRow("2026-10-05T11:00:00.000Z");
    expect(await setupState(d1Env(t.env.DB))).toBe("closed");
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    expect(await setupState(d1Env(t.env.DB))).toBe("open");
    expect(await setupState(d1Env(t.env.DB, { SETUP_CODE: undefined }))).toBe("not_ready");
  });
});

describe("setupCodeMatches", () => {
  it("compares SHA-256 digests (equal length, whatever the input), never the raw strings", async () => {
    const equal = vi.fn((a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]));
    expect(await setupCodeMatches("club-setup-phrase", "club-setup-phrase", equal)).toBe(true);
    expect(await setupCodeMatches("x", "club-setup-phrase", equal)).toBe(false);
    expect(await setupCodeMatches("x".repeat(256), "club-setup-phrase", equal)).toBe(false);
    expect(equal).toHaveBeenCalledTimes(3);
    expect(equal.mock.calls[0][0]).toEqual(await sha256(utf8("club-setup-phrase")));
    expect(equal.mock.calls[0][1]).toEqual(await sha256(utf8("club-setup-phrase")));
    expect(equal.mock.calls[1][0]).toEqual(await sha256(utf8("x")));
    for (const [a, b] of equal.mock.calls) {
      expect(a).toBeInstanceOf(Uint8Array);
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
  });

  it("uses the constant-time compare by default", async () => {
    expect(await setupCodeMatches(SETUP_CODE, SETUP_CODE)).toBe(true);
    expect(await setupCodeMatches(SETUP_CODE, `${SETUP_CODE}!`)).toBe(false);
    expect(await setupCodeMatches("", SETUP_CODE)).toBe(false);
  });
});

