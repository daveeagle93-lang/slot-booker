import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accessEnv, NOW, ORIGIN, passwordEnv, TEST_PASSWORD, writeHeaders } from "../server/auth/test-harness";
import type { AppEnv } from "../server/env";
import { createTestEnv, type TestEnv } from "../test/db";
import { publicAssets } from "../test/assets";
import { createWorker } from "../worker";
import { SECURITY_HEADERS } from "./headers";
import { createRoutes } from "./routes";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const worker = createWorker({ now: () => NOW });
const table = createRoutes();
const adminRoutes = table.filter((r) => r.access === "admin");
const PUBLIC_DIR = join(import.meta.dirname, "../../public");

/** A database that fails the test if anything uses it: an unguarded handler would reach for it. */
const noDb = new Proxy({}, { get: (_t, key) => { throw new Error(`The database was used (${String(key)})`); } }) as D1Database;

/** An ASSETS stub that records every request it is given and answers 200 `asset:<path>`. */
const recordingAssets = () => {
  const seen: Request[] = [];
  const fetcher = { fetch: async (request: Request) => { seen.push(request); return new Response(`asset:${new URL(request.url).pathname}`, { headers: { "Content-Type": "text/html" } }); } };
  return { seen, fetcher: fetcher as unknown as Fetcher };
};

const send = (env: AppEnv, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

/** The path of a route with a made-up value for each :param. */
const fill = (pattern: string) => pattern.replace(/:\w+/g, "x");

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const hasSecurityHeaders = (res: Response) => Object.entries(SECURITY_HEADERS).every(([k, v]) => res.headers.get(k) !== null && (k === "Content-Security-Policy" || res.headers.get(k) === v));

/** Every file under public/admin/ the way a browser could ask for it: the file, its clean URL, and the directory for index.html. */
const adminPageUrls = (): string[] => {
  const files = readdirSync(join(PUBLIC_DIR, "admin"), { recursive: true, encoding: "utf8" }).map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.endsWith(".test.ts") && /\.\w+$/.test(f));
  const urls = new Set<string>();
  for (const f of files) {
    urls.add(`/admin/${f}`);
    if (f.endsWith(".html")) urls.add(`/admin/${f.slice(0, -".html".length)}`);
    if (f === "index.html") { urls.add("/admin/"); urls.add("/admin"); }
  }
  return [...urls].sort();
};
const LOGIN_PAGES = ["/admin/login", "/admin/login.html", "/admin/login.js"];

describe("the admin API is guarded whatever the route table says", () => {
  it("answers every admin route and every method with 401 when not signed in, before routing (so never 404 or 405)", async () => {
    const env = await passwordEnv(noDb);
    const { fetcher } = recordingAssets();
    let n = 0;
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        if (route.pattern === "/api/admin/login" && method === "POST") continue; // the one exemption; below
        const res = await send({ ...env, ASSETS: fetcher }, fill(route.pattern), { method, headers: writeHeaders("anything") });
        expect(res.status, `${method} ${route.pattern}`).toBe(401);
        if (method !== "HEAD") expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" }, provider: "password" });
        expect(hasSecurityHeaders(res)).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(150);
  });

  it("treats POST /api/admin/login as the only exemption: Origin is checked, the handler is reached, and it is the handler that refuses", async () => {
    const env = await passwordEnv(t.env.DB);
    expect((await send(env, "/api/admin/login", { method: "POST", body: "{}" })).status).toBe(403);
    const res = await send(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.1" }, body: JSON.stringify({ password: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_credentials" } });
  });

  it("answers every admin route and method with 401 under the Access provider (login does not exist there: 404 for any method)", async () => {
    const env = { ...accessEnv(noDb), ASSETS: recordingAssets().fetcher };
    const deaf = createWorker({ now: () => NOW, fetch: (async () => Response.json({ keys: [] })) as unknown as typeof fetch });
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        const res = await deaf.fetch(new Request(`${ORIGIN}${fill(route.pattern)}`, { method, headers: writeHeaders("anything") }), env);
        expect(res.status, `${method} ${route.pattern}`).toBe(route.pattern === "/api/admin/login" ? 404 : 401);
      }
    }
  });

  it("answers 503 for every admin route and method when ADMIN_AUTH is unset", async () => {
    const env = { ...(await passwordEnv(noDb)), ADMIN_AUTH: undefined };
    for (const route of adminRoutes) {
      for (const method of METHODS) {
        const res = await send(env, fill(route.pattern), { method, headers: writeHeaders("anything") });
        expect(res.status, `${method} ${route.pattern}`).toBe(503);
      }
    }
  });

  it("guards unknown paths and the bare prefix too: 401, never 404", async () => {
    const env = await passwordEnv(noDb);
    for (const path of ["/api/admin", "/api/admin/", "/api/admin/zzz", "/api/admin/zzz/yyy", "/api/admin/events/", "/api/admin/events/x/zzz", "/api/admin//events"]) {
      for (const method of ["GET", "POST", "DELETE"]) expect((await send(env, path, { method, headers: writeHeaders("x") })).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe("the admin pages are guarded whatever is in public/admin/", () => {
  const urls = adminPageUrls();

  it("sees the files it expects", () => {
    expect(urls).toEqual(expect.arrayContaining(["/admin", "/admin/", "/admin/index.html", "/admin/login.html", "/admin/login", "/admin/login.js", "/admin/settings", "/admin/api.js"]));
  });

  it("redirects every page to /admin/login when not signed in, except the three login pages, which go to ASSETS as the original request", async () => {
    const env = await passwordEnv(noDb);
    for (const path of urls) {
      const { seen, fetcher } = recordingAssets();
      const request = new Request(`${ORIGIN}${path}`);
      const res = await worker.fetch(request, { ...env, ASSETS: fetcher });
      if (LOGIN_PAGES.includes(path)) {
        expect(res.status, path).toBe(200);
        expect(seen, path).toHaveLength(1);
        expect(seen[0], path).toBe(request);
      } else {
        expect(res.status, path).toBe(302);
        expect(res.headers.get("location"), path).toBe("/admin/login");
        expect(seen, path).toHaveLength(0);
      }
      expect(hasSecurityHeaders(res), path).toBe(true);
    }
  });

  it("answers 401 for every page, the login pages included, under the Access provider", async () => {
    const deaf = createWorker({ now: () => NOW, fetch: (async () => Response.json({ keys: [] })) as unknown as typeof fetch });
    for (const path of urls) {
      const { seen, fetcher } = recordingAssets();
      const res = await deaf.fetch(new Request(`${ORIGIN}${path}`), { ...accessEnv(noDb), ASSETS: fetcher });
      expect(res.status, path).toBe(401);
      expect(seen, path).toHaveLength(0);
    }
  });

  it("answers 503 for every page when ADMIN_AUTH is unset", async () => {
    const env = { ...(await passwordEnv(noDb)), ADMIN_AUTH: undefined };
    for (const path of [...urls, "/admin/zzz"]) {
      const { seen, fetcher } = recordingAssets();
      expect((await send({ ...env, ASSETS: fetcher }, path)).status, path).toBe(503);
      expect(seen, path).toHaveLength(0);
    }
  });

  it("guards unknown paths too: a redirect, never a 404 or a file", async () => {
    const env = await passwordEnv(noDb);
    for (const path of ["/admin/zzz", "/admin/zzz/yyy", "/admin//settings", "/admin/settings/", "/admin/login/", "/admin/login.html/", "/admin/LOGIN"]) {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...env, ASSETS: fetcher }, path);
      expect(res.status, path).toBe(302);
      expect(seen, path).toHaveLength(0);
    }
  });

  it("lets only GET and HEAD through to the files, once signed in or not", async () => {
    const env = await passwordEnv(noDb);
    const { seen, fetcher } = recordingAssets();
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await send({ ...env, ASSETS: fetcher }, "/admin/login", { method })).status, method).toBe(405);
      expect((await send({ ...env, ASSETS: fetcher }, "/admin/settings", { method })).status, method).toBe(302);
    }
    expect(seen).toHaveLength(0);
  });
});

describe("variants of an admin path do not get past the guard", () => {
  // Each is guarded, or ends at the static files or a JSON 404; none may reach an admin handler. noDb makes a handler that did fail loudly.
  const variants = [
    "/api/admin", "/api/admin/", "/api/admin/events/", "//api/admin/events", "/api//admin/events", "/api/admin//events",
    "/api/%61dmin/events", "/api/%41dmin/events", "/api/admin%2Fevents", "/api%2Fadmin/events", "/api/admin%2fevents/x",
    "/API/admin/events", "/Api/Admin/Events", "/api/ADMIN/events",
    "/Admin/settings", "/ADMIN/settings.html", "/admin%2Fsettings", "/%61dmin/settings", "/%2561dmin/settings", "//admin/settings", "/admin//settings",
    "/api/events/../admin/events", "/api/events/%2e%2e/admin/events", "/api/events/%2E%2E/admin/events", "/api/./admin/events", "/admin/../admin/settings",
    "/api\\admin/events", "/admin\\settings", "/api/admin/events;x", "/api/admin/events%00", "/api/admin/events%20", "/admin/settings%00",
    "/api/admin/session/", "/api/admin/events/x/", "/api/admin/settings/logo/", "/api/events/x/../../admin/session",
  ];

  it.each(["GET", "HEAD", "POST", "DELETE"])("%s", async (method) => {
    const env = await passwordEnv(noDb);
    for (const path of variants) {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...env, ASSETS: fetcher }, path, { method, headers: writeHeaders("x") });
      const guarded = (res.status === 401 && method !== "HEAD" && ((await res.clone().json()) as { error?: { code?: string } }).error?.code === "unauthenticated")
        || (res.status === 401 && method === "HEAD") || (res.status === 302 && res.headers.get("location") === "/admin/login");
      if (guarded) continue;
      // Not guarded, so it must not have reached a handler: the static files (which 404 an unknown name) or a JSON 404/405.
      expect(res.status, `${method} ${path}`).not.toBe(500);
      expect([200, 404, 405], `${method} ${path}`).toContain(res.status);
      if (res.status === 200) {
        expect(seen, `${method} ${path}`).toHaveLength(1);
        expect(new URL(seen[0].url).pathname, `${method} ${path}`).not.toMatch(/^\/(api\/)?admin(\/|$)/);
        expect(await res.text(), `${method} ${path}`).toMatch(/^asset:/);
      } else if (method !== "HEAD") {
        expect(await res.json(), `${method} ${path}`).toMatchObject({ error: { code: expect.stringMatching(/^(not_found|method_not_allowed)$/) } });
      }
    }
  });

  it("the URL parser's own normalisation is what makes the dot-segment forms guarded", () => {
    expect(new URL("https://x.example/api/events/../admin/events").pathname).toBe("/api/admin/events");
    expect(new URL("https://x.example/api/events/%2e%2e/admin/events").pathname).toBe("/api/admin/events");
    expect(new URL("https://x.example/api%5Cadmin/events").pathname).toBe("/api%5Cadmin/events");
  });
});

describe("with a valid password session", () => {
  it("gets past the guard on every admin route and method it declares", async () => {
    const env = { ...(await passwordEnv(t.env.DB)), ASSETS: recordingAssets().fetcher };
    const login = await send(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.77" }, body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    let n = 0;
    for (const route of adminRoutes.filter((r) => r.pattern !== "/api/admin/login")) {
      const res = await send(env, fill(route.pattern), {
        method: route.method, headers: { ...writeHeaders(csrfToken), Cookie: cookie }, body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
      });
      expect([401, 403, 405, 503], `${label(route)} -> ${res.status}`).not.toContain(res.status);
      expect(res.status, label(route)).toBeLessThan(500);
      n++;
    }
    expect(n).toBe(adminRoutes.length - 1);
    expect((await send(env, "/api/admin/session", { headers: { Cookie: cookie } })).status).toBe(200);
    // Without the token a write is still refused by the guard, session or not.
    expect((await send(env, "/api/admin/events", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  });

  it("serves the admin pages to the files", async () => {
    const env = await passwordEnv(t.env.DB);
    const login = await send(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.78" }, body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const path of ["/admin", "/admin/", "/admin/settings", "/admin/zzz"]) {
      const { seen, fetcher } = recordingAssets();
      const res = await send({ ...env, ASSETS: fetcher }, path, { headers: { Cookie: cookie } });
      expect(res.status, path).toBe(200);
      expect(seen, path).toHaveLength(1);
    }
  });
});

const label = (r: { method: string; pattern: string }) => `${r.method} ${r.pattern}`;

describe("routing", () => {
  it("answers a path that matches a route but not its method with 405, an Allow header and no-store", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    const res = await send(env, "/api/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: { code: "method_not_allowed" } });
    expect((await send(env, "/api/events/x/bookings", { method: "GET" })).headers.get("allow")).toBe("POST");
    expect((await send(env, "/api/events", { method: "DELETE" })).status).toBe(405);
  });

  it("answers HEAD for a GET route with the same status and headers and no body", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    const get = await send(env, "/api/health");
    const head = await send(env, "/api/health", { method: "HEAD" });
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
    expect(await get.json()).toEqual({ ok: true });
  });

  it("answers a JSON 404 for an unknown /api/ path, any method", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      const res = await send(env, "/api/nothing/here", { method });
      expect(res.status, method).toBe(404);
      if (method !== "HEAD") expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
    for (const path of ["/api", "/api/", "/api/events/", "/api/events/x/bookings/", "/api/health/"]) expect((await send(env, path)).status, path).toBe(404);
  });

  it("passes the original request to ASSETS for any unmatched GET or HEAD (/ is the rewritten landing page: open-graph.test.ts), and answers other methods with JSON", async () => {
    const { seen, fetcher } = recordingAssets();
    const env = { DB: t.env.DB, ASSETS: fetcher } as AppEnv;
    for (const path of ["/style.css", "/lib.js", "/e/", "/e/a/b", "/nothing"]) {
      const request = new Request(`${ORIGIN}${path}`);
      const res = await worker.fetch(request, env);
      expect(res.status, path).toBe(200);
      expect(seen.at(-1), path).toBe(request);
    }
    expect((await send(env, "/nothing", { method: "POST" })).status).toBe(404);
    expect((await send(env, "/", { method: "POST" })).status).toBe(405);
    expect((await send(env, "/", { method: "HEAD" })).status).toBe(200);
  });

  it("serves /e/<slug> from the event page, keeping the method and headers", async () => {
    const { seen, fetcher } = recordingAssets();
    const env = { DB: t.env.DB, ASSETS: fetcher } as AppEnv;
    const res = await send(env, "/e/summer-show?x=1", { headers: { "Accept-Language": "en-GB" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset:/event");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].headers.get("accept-language")).toBe("en-GB");
    await send(env, "/e/summer-show", { method: "HEAD" });
    expect(seen[1].method).toBe("HEAD");
  });

  it("hands a route its decoded params", async () => {
    const env = { DB: t.env.DB } as AppEnv;
    const res = await send(env, "/api/events/not%20a%20real%20slug");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("response headers", () => {
  it("are on every kind of response, and a route's own CSP wins", async () => {
    const env = { ...(await passwordEnv(t.env.DB)), ASSETS: publicAssets() };
    for (const [path, init] of [
      ["/api/health", {}], ["/api/nothing", {}], ["/api/health", { method: "POST" }], ["/api/admin/session", {}], ["/admin/", {}],
      ["/", {}], ["/e/x", {}], ["/api/theme.css", {}], ["/favicon.ico", {}], ["/api/icon/180", {}], ["/api/logo", {}],
    ] as [string, RequestInit][]) {
      const res = await send(env, path, init);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        if (name === "Content-Security-Policy" && ["/favicon.ico", "/api/icon/180"].includes(path)) expect(res.headers.get(name), path).toBe("default-src 'none'; sandbox");
        else expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      }
    }
  });

  it("are kept on a redirect from ASSETS, with its Location", async () => {
    const env = { DB: t.env.DB, ASSETS: { fetch: async () => Response.redirect(`${ORIGIN}/event`, 307) } } as unknown as AppEnv;
    const res = await send(env, "/lib.js");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/event`);
    expect(hasSecurityHeaders(res)).toBe(true);
  });
});

describe("failures", () => {
  it("answers an unexpected error with a plain 500 that says nothing about it, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await send({ DB: t.env.DB } as AppEnv, "/"); // no ASSETS binding
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("Something went wrong.");
      expect(hasSecurityHeaders(res)).toBe(true);
      expect(log).toHaveBeenCalled();
      const throwing = { fetch: async () => { throw new Error("SECRET internals"); } } as unknown as Fetcher;
      const res2 = await send({ DB: t.env.DB, ASSETS: throwing } as AppEnv, "/style.css");
      expect(res2.status).toBe(500);
      expect(await res2.text()).not.toContain("SECRET");
    } finally {
      log.mockRestore();
    }
  });
});
