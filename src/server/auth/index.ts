import type { AppEnv } from "../env";
import { createAccessAuth, parseAccessConfig, sharedAccessAuth, type AccessAuth } from "./access";
import { loadCredentials } from "./credentials";
import { createPasswordAuth, envCredentialsSet, parsePasswordConfig, type PasswordAuth } from "./password";
import type { AuthDeps } from "./types";

export type { AdminAuth, AdminData, AdminSession, AuthDeps } from "./types";
export type { PasswordAuth } from "./password";

/**
 * The one admin authenticator, chosen by ADMIN_AUTH. Fails closed: any other value, or settings the
 * chosen provider cannot use, is not_configured, and callers must then refuse every admin request.
 * With injected dependencies (tests) the Access provider is built fresh instead of shared.
 *
 * The password provider takes its secrets from ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET if either is set (both
 * must then be valid: it never falls back to D1), and otherwise from the admin_credentials row made on /setup, which
 * is read on every call (nothing is cached). `awaitingSetup` marks the case of no row yet.
 */
export async function adminAuthFor(
  env: AppEnv, deps?: AuthDeps,
): Promise<{ auth: AccessAuth | PasswordAuth } | { error: "not_configured"; reason: string; awaitingSetup?: true }> {
  if (env.ADMIN_AUTH === "access") {
    const config = parseAccessConfig(env);
    if (!config) return { error: "not_configured", reason: "ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com host and ACCESS_AUD must be set" };
    return { auth: (deps ? createAccessAuth(config, deps) : sharedAccessAuth(config)) };
  }
  if (env.ADMIN_AUTH === "password") {
    if (envCredentialsSet(env)) {
      const config = parsePasswordConfig(env);
      if (typeof config === "string") return { error: "not_configured", reason: config };
      return { auth: createPasswordAuth(config, deps) };
    }
    const stored = await loadCredentials(env.DB);
    if (!stored) return { error: "not_configured", reason: "no admin credentials yet: open /setup (SETUP_CODE must be set)", awaitingSetup: true };
    const config = parsePasswordConfig({ ADMIN_PASSWORD_HASH: stored.secretHash, ADMIN_SESSION_SECRET: stored.sessionSecret });
    if (typeof config === "string") return { error: "not_configured", reason: config };
    return { auth: createPasswordAuth(config, deps, { db: env.DB, secretHash: stored.secretHash }) };
  }
  return { error: "not_configured", reason: 'ADMIN_AUTH must be "access" or "password"' };
}
