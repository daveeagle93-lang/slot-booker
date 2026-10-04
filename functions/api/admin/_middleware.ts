import { adminAuthFor, type AdminData, type AuthDeps } from "../../../src/server/auth";
import { csrfFailure, hasSameOrigin } from "../../../src/server/auth/csrf";
import { noStore } from "../../../src/server/bookings";
import type { AppEnv } from "../../../src/server/env";
import { errorResponse } from "../../../src/server/http";

const LOGIN_PATH = "/api/admin/login";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The single choke point for /api/admin/*, including paths no route handles: every request must be
 * authenticated, and every state-changing one must pass the CSRF checks, before anything else runs.
 * The only exemption is POST /api/admin/login with the password provider, which gets the origin check but no token.
 */
export const createAdminMiddleware = (deps?: AuthDeps): PagesFunction<AppEnv, string, AdminData> => async (context) => {
  const { request, env } = context;
  const resolved = adminAuthFor(env, deps);
  if ("error" in resolved) {
    console.error(`Admin auth is not configured: ${resolved.reason}`);
    return errorResponse(503, "admin_not_configured", "Admin sign-in isn't set up.", {}, noStore);
  }
  const { auth } = resolved;
  if (new URL(request.url).pathname === LOGIN_PATH) {
    if (auth.kind === "access") return errorResponse(404, "not_found", "Not found.", {}, noStore);
    if (request.method === "POST") {
      if (!hasSameOrigin(request)) return errorResponse(403, "csrf_failed", "That request was refused. Reload the page and try again.", {}, noStore);
      return context.next();
    }
  }
  const session = await auth.authenticate(request);
  if (!session) return errorResponse(401, "unauthenticated", "Sign in to continue.", { provider: auth.kind }, noStore);
  if (!SAFE_METHODS.has(request.method)) {
    const refused = await csrfFailure(request, session.csrfBinding);
    if (refused) return refused;
  }
  context.data.admin = session;
  return context.next();
};

export const onRequest = createAdminMiddleware();
