import { parsePasswordHash, verifyPassword, type PasswordHash } from "./crypto";
import { clearedSessionCookie, issueSession, readSession, sessionCookie } from "./session";
import type { AdminAuth, AdminSession, AuthDeps } from "./types";

export const MIN_SESSION_SECRET_LENGTH = 32;

export interface PasswordAuth extends AdminAuth {
  readonly kind: "password";
  checkPassword(password: string): Promise<boolean>;
  /** A new session and the Set-Cookie header value that carries it. */
  startSession(): Promise<{ session: AdminSession; setCookie: string }>;
  clearCookie(): string;
}

export interface PasswordConfig { hash: PasswordHash; sessionSecret: string }

/** The usable settings, or a reason fit for logs (never a value) why not. */
export function parsePasswordConfig(
  env: { ADMIN_PASSWORD_HASH?: string; ADMIN_SESSION_SECRET?: string },
): PasswordConfig | string {
  const hash = parsePasswordHash(env.ADMIN_PASSWORD_HASH);
  if (!hash) return "ADMIN_PASSWORD_HASH is missing or malformed (or its iteration count is above 100000)";
  const sessionSecret = env.ADMIN_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    return `ADMIN_SESSION_SECRET is missing or shorter than ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return { hash, sessionSecret };
}

export function createPasswordAuth({ hash, sessionSecret }: PasswordConfig, deps: AuthDeps = {}): PasswordAuth {
  const now = deps.now ?? Date.now;
  return {
    kind: "password",
    checkPassword: (password) => verifyPassword(password, hash),
    async startSession() {
      const { value, sid } = await issueSession(sessionSecret, now());
      return { session: { identity: "admin", csrfBinding: sid }, setCookie: sessionCookie(value) };
    },
    clearCookie: clearedSessionCookie,
    async authenticate(request) {
      try {
        const sid = await readSession(sessionSecret, request.headers.get("Cookie"), now());
        return sid === null ? null : { identity: "admin", csrfBinding: sid };
      } catch {
        return null;
      }
    },
  };
}
