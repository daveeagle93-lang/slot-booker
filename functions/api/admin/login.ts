import { adminAuthFor, type AuthDeps } from "../../../src/server/auth";
import { csrfToken } from "../../../src/server/auth/csrf";
import { clearAttempts, countAttempt } from "../../../src/server/auth/ratelimit";
import { declaresOversizeBody, noStore, payloadTooLarge, readJsonObject } from "../../../src/server/bookings";
import type { AppEnv } from "../../../src/server/env";
import { errorResponse, json } from "../../../src/server/http";

const MAX_BODY_BYTES = 1024;
const MAX_PASSWORD_LENGTH = 256;

/**
 * POST /api/admin/login, password provider only (_middleware.ts hides it otherwise and has already
 * checked the Origin). The attempt is counted before the password is checked, so a client over the
 * limit costs no PBKDF2 and parallel guesses cannot beat the limit. The same 401 answers every failure.
 */
export const createLoginHandler = (deps: AuthDeps = {}): PagesFunction<AppEnv> => async ({ request, env }) => {
  const resolved = adminAuthFor(env, deps);
  if ("error" in resolved || resolved.auth.kind !== "password") return errorResponse(404, "not_found", "Not found.", {}, noStore);
  const { auth } = resolved;

  if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) return payloadTooLarge();
  const body = await readJsonObject(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  const { password } = body;
  if (typeof password !== "string" || password.length < 1 || password.length > MAX_PASSWORD_LENGTH) {
    return errorResponse(400, "invalid_input", "Enter the password.", {}, noStore);
  }

  const key = await auth.clientKey(request.headers.get("CF-Connecting-IP"));
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  try {
    const attempt = await countAttempt(env.DB, key, nowSeconds);
    if (!attempt.allowed) {
      return errorResponse(429, "too_many_attempts", "Too many attempts. Try again later.", {}, {
        ...noStore, "Retry-After": String(attempt.retryAfterSeconds),
      });
    }
    if (!(await auth.checkPassword(password))) {
      return errorResponse(401, "invalid_credentials", "That password isn't right.", {}, noStore);
    }
    await clearAttempts(env.DB, key);
  } catch (e) {
    console.error("login failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
  const { session, setCookie } = await auth.startSession();
  return json({ identity: session.identity, csrfToken: await csrfToken(session.csrfBinding) }, 200, { ...noStore, "Set-Cookie": setCookie });
};

export const onRequestPost = createLoginHandler();
