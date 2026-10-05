import type { AuthDeps } from "./server/auth";
import { noStore } from "./server/bookings";
import type { AppEnv } from "./server/env";
import { errorResponse } from "./server/http";
import { guardAdminApi, guardAdminPage } from "./worker/guards";
import { withSecurityHeaders } from "./worker/headers";
import { resolveRoute } from "./worker/router";
import { createRoutes } from "./worker/routes";

/** Whether `pathname` is `prefix` or below it. Exact text, like the router: no case folding, decoding or slash tolerance. */
const under = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

const methodNotAllowed = (allow: string[]): Response =>
  errorResponse(405, "method_not_allowed", "Method not allowed.", {}, { ...noStore, Allow: allow.join(", ") });

/**
 * The whole app as one Worker: the guards, then the route table, then the static files (the ASSETS binding).
 * `deps` are for tests only (a fixed clock and a stubbed Access key fetch for the admin sign-in checks).
 */
export function createWorker(deps?: AuthDeps) {
  const routes = createRoutes(deps);

  async function handle(request: Request, env: AppEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    const readOnly = request.method === "GET" || request.method === "HEAD";
    const data: Record<string, unknown> = {};

    // Who may reach what is decided here, from the path, before any route is matched: the whole of /api/admin
    // (unknown paths included) and of /admin, whatever the table says.
    const adminApi = under(pathname, "/api/admin");
    if (adminApi) {
      const guarded = await guardAdminApi(request, env, deps);
      if (guarded instanceof Response) return guarded;
      Object.assign(data, guarded);
    } else if (under(pathname, "/admin")) {
      const refused = await guardAdminPage(request, env, deps);
      if (refused) return refused;
      if (!readOnly) return methodNotAllowed(["GET", "HEAD"]);
      if (!env.ASSETS) throw new Error("The ASSETS binding is missing (wrangler.jsonc assets.binding).");
      // The original request, not a copy: the asset service's redirects (clean URLs) have a relative Location that a fresh Request would lose.
      return env.ASSETS.fetch(request);
    }

    const found = resolveRoute(routes, request.method, pathname);
    if (found.kind === "method_not_allowed") return methodNotAllowed(found.allow);
    if (found.kind === "match") {
      // The table and the path test above must agree; if not, fail closed rather than run an admin handler unguarded.
      if (found.route.access === "admin" && !adminApi) throw new Error(`Admin route ${found.route.pattern} was reached without the admin guard.`);
      const response = await found.route.handler({ request, env, params: found.params, data });
      return request.method === "HEAD" && found.route.method === "GET" ? new Response(null, response) : response;
    }

    if (readOnly && !under(pathname, "/api")) {
      if (!env.ASSETS) throw new Error("The ASSETS binding is missing (wrangler.jsonc assets.binding).");
      return env.ASSETS.fetch(request);
    }
    return errorResponse(404, "not_found", "Not found.", {}, noStore);
  }

  return {
    async fetch(request: Request, env: AppEnv): Promise<Response> {
      try {
        return withSecurityHeaders(await handle(request, env));
      } catch (e) {
        console.error("Unhandled error:", e);
        return withSecurityHeaders(new Response("Something went wrong.", {
          status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        }));
      }
    },
  } satisfies ExportedHandler<AppEnv>;
}

export default createWorker();
