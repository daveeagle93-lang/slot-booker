import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessEnv, accessJwt, jwksFetch, NOW, newAccessKey, ORIGIN, passwordEnv, TEST_PASSWORD, adminApp,
} from "../server/auth/test-harness";
import type { AppEnv } from "../server/env";
import { createTestEnv, type TestEnv } from "../test/db";
import { guardAdminPage } from "./guards";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

/** Runs the pages guard. `reached` means it let the request on to the static file server (it returned null). */
async function visit(env: AppEnv, path: string, headers: Record<string, string> = {}, deps = { now: () => NOW }) {
  const refused = await guardAdminPage(new Request(`${ORIGIN}${path}`, { headers }), env, deps);
  return { res: refused ?? new Response("<html>static</html>", { headers: { "Content-Type": "text/html" } }), reached: refused === null };
}

const PAGES = ["/admin", "/admin/", "/admin/index.html", "/admin/events/new", "/admin/x.js", "/admin/login/", "/admin/login.css", "/admin/Login"];

describe("admin pages with the password provider", () => {
  it("redirects every unauthenticated page request to the login page without serving it", async () => {
    const env = await passwordEnv(t.env.DB);
    for (const path of PAGES) {
      const { res, reached } = await visit(env, path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/admin/login");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(reached, path).toBe(false);
    }
  });

  it("serves only the login page and its script unauthenticated", async () => {
    const env = await passwordEnv(t.env.DB);
    for (const path of ["/admin/login", "/admin/login.html", "/admin/login.js"]) {
      const { res, reached } = await visit(env, path);
      expect(res.status, path).toBe(200);
      expect(reached, path).toBe(true);
    }
  });

  it("serves every page to a signed-in admin, and still refuses a forged cookie", async () => {
    const env = await passwordEnv(t.env.DB);
    const app = adminApp({ now: () => NOW });
    const login = await app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.18.0.9" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const path of PAGES) expect((await visit(env, path, { Cookie: cookie })).reached, path).toBe(true);
    const forged = cookie.replace(/\.[^.]+$/, ".AAAA");
    expect((await visit(env, "/admin/", { Cookie: forged })).res.status).toBe(302);
  });
});

describe("admin pages with the Access provider", () => {
  it("answers 401 text/plain unauthenticated, including for the login page, which does not exist", async () => {
    const env = accessEnv(t.env.DB);
    const deps = { now: () => NOW, fetch: jwksFetch(() => []) as unknown as typeof fetch };
    for (const path of [...PAGES, "/admin/login", "/admin/login.html", "/admin/login.js"]) {
      const { res, reached } = await visit(env, path, {}, deps);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(reached, path).toBe(false);
    }
  });

  it("serves pages to a request with a valid Access token, and not to the unsigned email header alone", async () => {
    const key = await newAccessKey("k");
    const env = accessEnv(t.env.DB);
    const deps = { now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch };
    expect((await visit(env, "/admin/", { "Cf-Access-Jwt-Assertion": await accessJwt(key) }, deps)).reached).toBe(true);
    expect((await visit(env, "/admin/", { "Cf-Access-Authenticated-User-Email": "admin@club.example" }, deps)).res.status).toBe(401);
  });
});

describe("admin pages when unconfigured", () => {
  it("answers 503 text/plain for every page and never calls next", async () => {
    const good = await passwordEnv(t.env.DB);
    for (const env of [{ ...good, ADMIN_AUTH: undefined }, { ...good, ADMIN_AUTH: "none" }, { ...good, ADMIN_AUTH: "Password" }, { ...good, ADMIN_SESSION_SECRET: "short" }]) {
      for (const path of [...PAGES, "/admin/login", "/admin/login.js"]) {
        const { res, reached } = await visit(env, path);
        expect(res.status, path).toBe(503);
        expect(res.headers.get("content-type")).toContain("text/plain");
        expect(reached).toBe(false);
      }
    }
  });
});
