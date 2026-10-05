import { loadCredentials } from "./auth/credentials";
import { sha256, timingSafeEqual, trimAdminSecret, utf8 } from "./auth/crypto";
import { envCredentialsSet } from "./auth/password";
import type { AppEnv } from "./env";

/** Enforced at runtime, not only in the deploy prompt: a shorter SETUP_CODE leaves /setup not_ready. */
export const MIN_SETUP_CODE_LENGTH = 12;

/**
 * closed: 404 everywhere (not the password provider, credentials set by environment variables, or the first sign-in
 * has happened). not_ready: SETUP_CODE is missing or too short. open: a code may be entered.
 */
export type SetupState = "closed" | "not_ready" | "open";

/** SETUP_CODE trimmed the way a submitted code is, or null if it is missing or shorter than MIN_SETUP_CODE_LENGTH. */
export function expectedSetupCode(env: AppEnv): string | null {
  const code = trimAdminSecret(env.SETUP_CODE ?? "");
  return [...code].length >= MIN_SETUP_CODE_LENGTH ? code : null;
}

/** Reads D1 only in D1 mode (the password provider with neither ADMIN_PASSWORD_HASH nor ADMIN_SESSION_SECRET set). */
export async function setupState(env: AppEnv): Promise<SetupState> {
  if (env.ADMIN_AUTH !== "password" || envCredentialsSet(env)) return "closed";
  const stored = await loadCredentials(env.DB);
  if (stored?.firstLoginAt != null) return "closed";
  return expectedSetupCode(env) === null ? "not_ready" : "open";
}

/** Compares SHA-256 digests, which are always the same length, so neither the content nor the length of the code shows in the timing. */
export async function setupCodeMatches(submitted: string, expected: string, equal = timingSafeEqual): Promise<boolean> {
  return equal(await sha256(utf8(submitted)), await sha256(utf8(expected)));
}
