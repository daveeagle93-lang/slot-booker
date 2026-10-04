import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessClaims, accessEnv, accessJwt, adminApp, jwksFetch, NOW, newAccessKey, ORIGIN, passwordEnv, TEST_PASSWORD,
} from "../../../src/server/auth/test-harness";
import { csrfToken } from "../../../src/server/auth/csrf";
import { createTestEnv, type TestEnv } from "../../../src/test/db";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

describe("GET /api/admin/session", () => {
  it("with Access: the verified email, the provider and a token bound to the JWT", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const jwt = await accessJwt(key);
    const res = await app(accessEnv(t.env.DB), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ identity: "admin@club.example", provider: "access", csrfToken: await csrfToken(jwt) });
    // A refreshed JWT is a new binding, so the token changes: clients re-fetch on csrf_failed.
    const refreshed = await accessJwt(key, accessClaims({ exp: NOW / 1000 + 900 }));
    const again = (await (await app(accessEnv(t.env.DB), "/api/admin/session", { headers: { "Cf-Access-Jwt-Assertion": refreshed } })).json()) as { csrfToken: string };
    expect(again.csrfToken).not.toBe(await csrfToken(jwt));
  });

  it("with a password: 401 with no cookie", async () => {
    const app = adminApp({ now: () => NOW });
    const res = await app(await passwordEnv(t.env.DB), "/api/admin/session");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: "password" });
  });
});

describe("POST /api/admin/logout", () => {
  it("with a password: clears the cookie with the same attributes and Max-Age=0", async () => {
    const app = adminApp({ now: () => NOW });
    const env = await passwordEnv(t.env.DB);
    const login = await app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.1" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const { csrfToken: token } = (await login.json()) as { csrfToken: string };
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { Origin: ORIGIN, "Content-Type": "application/json", Cookie: cookie };
    expect((await app(env, "/api/admin/logout", { method: "POST", headers, body: "{}" })).status).toBe(403); // no token
    const res = await app(env, "/api/admin/logout", { method: "POST", headers: { ...headers, "X-CSRF-Token": token }, body: "{}" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe("__Host-sb_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("with Access: points at the Access logout URL and sets no cookie", async () => {
    const key = await newAccessKey("k");
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch });
    const env = accessEnv(t.env.DB);
    const jwt = await accessJwt(key);
    const res = await app(env, "/api/admin/logout", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": jwt, "X-CSRF-Token": await csrfToken(jwt) },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ logoutUrl: "/cdn-cgi/access/logout" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("requires a session", async () => {
    const app = adminApp({ now: () => NOW });
    const res = await app(await passwordEnv(t.env.DB), "/api/admin/logout", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
