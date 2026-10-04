import { beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../env";
import { hashPassword } from "./crypto";
import { adminAuthFor } from "./index";

let hash: string;
beforeAll(async () => { hash = await hashPassword("a long enough password"); });
const env = (over: Partial<AppEnv>): AppEnv => ({ DB: {} as D1Database, ...over });
const SECRET = "s".repeat(32);

describe("adminAuthFor", () => {
  it("selects Access when it is configured", () => {
    const r = adminAuthFor(env({ ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" }));
    expect("auth" in r && r.auth.kind).toBe("access");
  });

  it("selects the password provider when it is configured", () => {
    const r = adminAuthFor(env({ ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect("auth" in r && r.auth.kind).toBe("password");
  });

  it("fails closed for anything else", () => {
    const good = { ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET, ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
    for (const ADMIN_AUTH of [undefined, "", "none", "off", "Password", "ACCESS", " access", "password ", "true", "access,password"]) {
      expect(adminAuthFor(env({ ...good, ADMIN_AUTH })), String(ADMIN_AUTH)).toMatchObject({ error: "not_configured" });
    }
  });

  it("fails closed when the chosen provider is misconfigured", () => {
    const access = { ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "club.cloudflareaccess.com", ACCESS_AUD: "aud" };
    const password = { ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET };
    for (const bad of [
      { ...access, ACCESS_TEAM_DOMAIN: "evil.example" }, { ...access, ACCESS_AUD: "" }, { ADMIN_AUTH: "access" },
      { ...password, ADMIN_PASSWORD_HASH: undefined }, { ...password, ADMIN_PASSWORD_HASH: "pbkdf2-sha512$600000$x$y" },
      { ...password, ADMIN_PASSWORD_HASH: hash.replace(/^pbkdf2-sha512\$100000/, "pbkdf2-sha512$600000") },
      { ...password, ADMIN_SESSION_SECRET: "s".repeat(31) }, { ...password, ADMIN_SESSION_SECRET: undefined },
      { ADMIN_AUTH: "password" },
    ]) {
      expect(adminAuthFor(env(bad)), JSON.stringify(bad)).toMatchObject({ error: "not_configured" });
    }
  });

  it("does not fall back to the other provider's settings", () => {
    const r = adminAuthFor(env({ ADMIN_AUTH: "access", ADMIN_PASSWORD_HASH: hash, ADMIN_SESSION_SECRET: SECRET }));
    expect(r).toMatchObject({ error: "not_configured" });
  });

  it("reuses the Access instance for the same settings, but not when dependencies are injected", () => {
    const e = env({ ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: "reuse.cloudflareaccess.com", ACCESS_AUD: "aud" });
    const a = adminAuthFor(e);
    const b = adminAuthFor(e);
    const c = adminAuthFor(e, { fetch: (async () => new Response("")) as typeof fetch });
    expect("auth" in a && "auth" in b && a.auth === b.auth).toBe(true);
    expect("auth" in c && "auth" in a && c.auth !== a.auth).toBe(true);
  });
});
