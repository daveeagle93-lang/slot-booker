import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "../../test/db";
import type { AppEnv } from "../env";
import { saveCredentials } from "./credentials";
import { generateAdminSecret, hashAdminSecret } from "./crypto";
import { adminAuthFor } from "./index";
import { issueSession, SESSION_COOKIE } from "./session";

let hash: string;
let t: TestEnv;
beforeAll(async () => { hash = await hashAdminSecret(generateAdminSecret()); t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });
beforeEach(async () => { await t.env.DB.prepare("DELETE FROM admin_credentials").run(); });
// A database with no credentials row, and nothing else, for the settings that must not need one.
const noRow = { prepare: () => ({ first: async () => null }) } as unknown as D1Database;
const env = (over: Partial<AppEnv>): AppEnv => ({ DB: noRow, ...over });
/** A database that fails the test if anything uses it. */
const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`The database was used (${String(key)})`); } }) as D1Database;
const SECRET = "s".repeat(32);

describe("adminAuthFor", () => {
  it("selects Access when it is configured", async () => {
    const r = await adminAuthFor(env({ ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" }));
    expect("auth" in r && r.auth.kind).toBe("access");
  });

  it("selects the password provider when it is configured", async () => {
    const r = await adminAuthFor(env({ ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect("auth" in r && r.auth.kind).toBe("password");
  });

  it("fails closed for anything else", async () => {
    const good = { ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET, ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
    for (const ADMIN_AUTH of [undefined, "", "none", "off", "Password", "ACCESS", " access", "password ", "true", "access,password"]) {
      expect(await adminAuthFor(env({ ...good, ADMIN_AUTH })), String(ADMIN_AUTH)).toMatchObject({ error: "not_configured" });
    }
  });

  it("fails closed when the chosen provider is misconfigured", async () => {
    const access = { ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
    const password = { ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET };
    for (const bad of [
      { ...access, ACCESS_TEAM_DOMAIN: "evil.example" }, { ...access, ACCESS_AUD: "" }, { ADMIN_AUTH: "access" },
      { ...password, ADMIN_PASSWORD_HASH: undefined }, { ...password, ADMIN_PASSWORD_HASH: "pbkdf2-sha256$100000$x$y" },
      { ...password, ADMIN_PASSWORD_HASH: hash.replace(/^hmac-sha256/, "pbkdf2-sha256") },
      { ...password, ADMIN_PASSWORD_HASH: hash.slice(0, -1) },
      { ...password, ADMIN_SESSION_SECRET: "s".repeat(31) }, { ...password, ADMIN_SESSION_SECRET: undefined },
      { ADMIN_AUTH: "password" },
    ]) {
      expect(await adminAuthFor(env(bad)), JSON.stringify(bad)).toMatchObject({ error: "not_configured" });
    }
  });

  it("does not fall back to the other provider's settings", async () => {
    const r = await adminAuthFor(env({ ADMIN_AUTH: "access", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect(r).toMatchObject({ error: "not_configured" });
  });

  it("reuses the Access instance for the same settings, but not when dependencies are injected", async () => {
    const e = env({ ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "reuse.cloudflareaccess.com", ACCESS_AUD: "aud" });
    const a = await adminAuthFor(e);
    const b = await adminAuthFor(e);
    const c = await adminAuthFor(e, { fetch: (async () => new Response("")) as typeof fetch });
    expect("auth" in a && "auth" in b && a.auth === b.auth).toBe(true);
    expect("auth" in c && "auth" in a && c.auth !== a.auth).toBe(true);
  });
});

const H_SECRET = "s".repeat(43);
const NOW_MS = Date.UTC(2026, 9, 5, 12, 0, 0);
const cookieFor = async (secret: string) => `${SESSION_COOKIE}=${(await issueSession(secret, NOW_MS)).value}`;
const requestWith = (cookie: string) => new Request("https://club.example/api/admin/session", { headers: { Cookie: cookie } });

describe("adminAuthFor with credentials in D1", () => {
  it("is used when ADMIN_AUTH is password and neither ADMIN_PASSWORD_HASH nor ADMIN_SESSION_SECRET is set: the stored hash checks passwords and the stored session secret signs the cookie", async () => {
    const secret = generateAdminSecret();
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(secret), sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const r = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }), { now: () => NOW_MS });
    if (!("auth" in r) || r.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await r.auth.checkPassword(secret)).toBe(true);
    expect(await r.auth.checkPassword(generateAdminSecret())).toBe(false);
    const { session } = await r.auth.startSession();
    expect(session.identity).toBe("admin");
    expect(await r.auth.authenticate(requestWith(await cookieFor(H_SECRET)))).not.toBeNull();
    expect(await r.auth.authenticate(requestWith(await cookieFor("t".repeat(43))))).toBeNull();
  });

  it("is not_configured, marked as awaiting setup, when there is no row", async () => {
    expect(await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }))).toMatchObject({ error: "not_configured", awaitingSetup: true });
  });

  it("reads the row on each call, so a replaced or deleted row takes effect at once (no cached secrets)", async () => {
    const first = generateAdminSecret();
    const second = generateAdminSecret();
    const e = env({ DB: t.env.DB, ADMIN_AUTH: "password" });
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(first), sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(second), sessionSecret: "u".repeat(43), createdAt: "2026-10-05T10:01:00.000Z" });
    const r = await adminAuthFor(e);
    if (!("auth" in r) || r.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await r.auth.checkPassword(first)).toBe(false);
    expect(await r.auth.checkPassword(second)).toBe(true);
    await t.env.DB.prepare("DELETE FROM admin_credentials").run();
    expect(await adminAuthFor(e)).toMatchObject({ error: "not_configured", awaitingSetup: true });
  });

  it("is never used in env mode: either variable set means both must be valid, and a stored row is ignored", async () => {
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(generateAdminSecret()), sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    for (const over of [{ ADMIN_PASSWORD_HASH: hash }, { ADMIN_SESSION_SECRET: "s".repeat(32) }, { ADMIN_PASSWORD_HASH: "junk", ADMIN_SESSION_SECRET: "s".repeat(32) }]) {
      const r = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password", ...over }));
      expect(r, JSON.stringify(over)).toMatchObject({ error: "not_configured" });
      expect(r, JSON.stringify(over)).not.toHaveProperty("awaitingSetup");
    }
  });

  it("does not touch the database in env mode, or for Access, or when ADMIN_AUTH is something else", async () => {
    const both = { ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: "s".repeat(32) };
    const r = await adminAuthFor(env({ DB: noDb, ADMIN_AUTH: "password", ...both }));
    expect("auth" in r && r.auth.kind).toBe("password");
    expect(await adminAuthFor(env({ DB: noDb, ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" }))).toHaveProperty("auth");
    expect(await adminAuthFor(env({ DB: noDb, ADMIN_AUTH: undefined }))).toMatchObject({ error: "not_configured" });
  });

  it("has a confirmSignIn that does nothing and succeeds in env mode, and marks the first sign-in in D1 mode", async () => {
    const envMode = await adminAuthFor(env({ DB: noDb, ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: "s".repeat(32) }));
    if (!("auth" in envMode) || envMode.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await envMode.auth.confirmSignIn()).toBe(true);

    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const d1 = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }), { now: () => NOW_MS });
    if (!("auth" in d1) || d1.auth.kind !== "password") throw new Error("expected the password provider");
    expect(await d1.auth.confirmSignIn()).toBe(true);
    const row = await t.env.DB.prepare("SELECT first_login_at FROM admin_credentials WHERE id = 1").first();
    expect(row).toEqual({ first_login_at: new Date(NOW_MS).toISOString() });
  });

  it("refuses to confirm a sign-in verified against a secret that setup has since replaced, and marks nothing", async () => {
    await saveCredentials(t.env.DB, { secretHash: hash, sessionSecret: H_SECRET, createdAt: "2026-10-05T10:00:00.000Z" });
    const d1 = await adminAuthFor(env({ DB: t.env.DB, ADMIN_AUTH: "password" }));
    if (!("auth" in d1) || d1.auth.kind !== "password") throw new Error("expected the password provider");
    await saveCredentials(t.env.DB, { secretHash: await hashAdminSecret(generateAdminSecret()), sessionSecret: "u".repeat(43), createdAt: "2026-10-05T10:05:00.000Z" });
    expect(await d1.auth.confirmSignIn()).toBe(false);
    expect(await t.env.DB.prepare("SELECT first_login_at FROM admin_credentials WHERE id = 1").first()).toEqual({ first_login_at: null });
  });
});
