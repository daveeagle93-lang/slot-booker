// Test-only helpers: run a request through the admin middleware and then the matching route, as Pages would.
import { vi } from "vitest";
import { createAdminMiddleware } from "../../../functions/api/admin/_middleware";
import { createLoginHandler } from "../../../functions/api/admin/login";
import { onRequestPost as logout } from "../../../functions/api/admin/logout";
import { onRequestGet as session } from "../../../functions/api/admin/session";
import { json } from "../http";
import type { AppEnv } from "../env";
import { base64urlEncode, hashAdminSecret, utf8 } from "./crypto";
import type { AuthDeps } from "./types";

export const ORIGIN = "https://club.example";
export const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
// A fixed value in the generated form (43 base64url characters, canonical), so tests are repeatable.
export const TEST_PASSWORD = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw";
export const SESSION_SECRET = "test-only-session-secret-0123456789-abcdef";
export const ACCESS_TEAM = "club.cloudflareaccess.com";
export const ACCESS_AUD = "aud-tag-1234567890";

let hash: Promise<string> | undefined;
export const passwordEnv = async (db: D1Database): Promise<AppEnv> => ({
  DB: db, ADMIN_AUTH: "password", ADMIN_PASSWORD_HASH: await (hash ??= hashAdminSecret(TEST_PASSWORD)), ADMIN_SESSION_SECRET: SESSION_SECRET,
});
export const accessEnv = (db: D1Database): AppEnv => ({
  DB: db, ADMIN_AUTH: "access", ACCESS_TEAM_DOMAIN: ACCESS_TEAM, ACCESS_AUD,
});

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
export interface AccessKey { kid: string; pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string } }

export async function newAccessKey(kid: string): Promise<AccessKey> {
  const pair = (await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, pair, jwk: Object.assign(jwk, { kid }) };
}

export const jsonPart = (value: unknown): string => base64urlEncode(utf8(JSON.stringify(value)));

export const accessClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://${ACCESS_TEAM}`, aud: [ACCESS_AUD], email: "admin@club.example", exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, ...over,
});

export async function accessJwt(key: AccessKey, claims: unknown = accessClaims(), header: Record<string, unknown> = {}): Promise<string> {
  const input = `${jsonPart({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${jsonPart(claims)}`;
  const signature = await crypto.subtle.sign(RS256, key.pair.privateKey, utf8(input));
  return `${input}.${base64urlEncode(new Uint8Array(signature))}`;
}

/** A fetch that serves the given keys as Cloudflare's certs endpoint would. */
export const jwksFetch = (keys: () => AccessKey[]) =>
  vi.fn(async () => Response.json({ keys: keys().map((k) => k.jwk), public_cert: { kid: "x", cert: "x" }, public_certs: [] }));

/**
 * `/api/admin/whoami` is a stand-in for the other admin routes: it echoes what the middleware put in context.data.
 * Any other path the middleware lets through ends at a 404, as a missing static file would.
 */
export function adminApp(deps: AuthDeps = {}) {
  const middleware = createAdminMiddleware(deps);
  const login = createLoginHandler(deps);
  return (env: AppEnv, path: string, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(`${ORIGIN}${path}`, init);
    const data: Record<string, unknown> = {};
    const route = (): Response | Promise<Response> => {
      const { pathname } = new URL(request.url);
      const context = { request, env, data, params: {} } as never;
      if (pathname === "/api/admin/session" && request.method === "GET") return session(context);
      if (pathname === "/api/admin/login" && request.method === "POST") return login(context);
      if (pathname === "/api/admin/logout" && request.method === "POST") return logout(context);
      if (pathname === "/api/admin/whoami") return json({ data });
      return new Response("not found", { status: 404 });
    };
    return Promise.resolve(middleware({ request, env, data, params: {}, next: async () => route() } as never));
  };
}

/** Headers of a well-formed same-origin admin write. */
export const writeHeaders = (csrfToken: string, extra: Record<string, string> = {}): Record<string, string> => ({
  Origin: ORIGIN, "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...extra,
});
