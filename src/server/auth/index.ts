import type { AppEnv } from "../env";
import { createAccessAuth, parseAccessConfig, sharedAccessAuth, type AccessAuth } from "./access";
import { createPasswordAuth, parsePasswordConfig, type PasswordAuth } from "./password";
import type { AuthDeps } from "./types";

export type { AdminAuth, AdminData, AdminSession, AuthDeps } from "./types";
export type { PasswordAuth } from "./password";

/**
 * The one admin authenticator, chosen by ADMIN_AUTH. Fails closed: any other value, or settings the
 * chosen provider cannot use, is not_configured, and callers must then refuse every admin request.
 * With injected dependencies (tests) the Access provider is built fresh instead of shared.
 */
export function adminAuthFor(
  env: AppEnv, deps?: AuthDeps,
): { auth: AccessAuth | PasswordAuth } | { error: "not_configured"; reason: string } {
  if (env.ADMIN_AUTH === "access") {
    const config = parseAccessConfig(env);
    if (!config) return { error: "not_configured", reason: "ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com host and ACCESS_AUD must be set" };
    return { auth: (deps ? createAccessAuth(config, deps) : sharedAccessAuth(config)) };
  }
  if (env.ADMIN_AUTH === "password") {
    const config = parsePasswordConfig(env);
    if (typeof config === "string") return { error: "not_configured", reason: config };
    return { auth: createPasswordAuth(config, deps) };
  }
  return { error: "not_configured", reason: 'ADMIN_AUTH must be "access" or "password"' };
}
