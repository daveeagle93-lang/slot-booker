import { adminAuthFor, type AuthDeps } from "../../src/server/auth";
import type { AppEnv } from "../../src/server/env";

// Only the password provider has a sign-in page, so only then may these be fetched unauthenticated.
const LOGIN_PAGES = new Set(["/admin/login", "/admin/login.html", "/admin/login.js"]);

const plain = (status: number, text: string, headers: HeadersInit = {}): Response =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });

/**
 * Guards the static admin pages. The pages hold no data and /api/admin/* is protected on its own, so this is
 * defence in depth, but a stranger should not get the admin UI either.
 */
export const createAdminPagesMiddleware = (deps?: AuthDeps): PagesFunction<AppEnv> => async (context) => {
  const resolved = adminAuthFor(context.env, deps);
  if ("error" in resolved) {
    console.error(`Admin auth is not configured: ${resolved.reason}`);
    return plain(503, "Admin sign-in isn't set up.");
  }
  const { auth } = resolved;
  if (auth.kind === "password" && LOGIN_PAGES.has(new URL(context.request.url).pathname)) return context.next();
  if (await auth.authenticate(context.request)) return context.next();
  if (auth.kind === "password") return new Response(null, { status: 302, headers: { Location: "/admin/login", "Cache-Control": "no-store" } });
  return plain(401, "Sign in with Cloudflare Access to use the admin pages.");
};

export const onRequest = createAdminPagesMiddleware();
