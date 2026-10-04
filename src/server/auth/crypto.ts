// WebCrypto helpers for admin auth. Deliberately no relative imports: scripts/hash-password.ts loads
// this file under plain Node, which needs explicit extensions that the type checker here refuses.

const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unpadded base64url only; null for anything else. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Node has no crypto.subtle.timingSafeEqual (workerd does), so: length check, then XOR over the whole length. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Password hashing: WebCrypto PBKDF2 is the only password KDF Workers provide natively (no scrypt, argon2 or
// bcrypt; a WASM or JS one would burn Worker CPU time and bundle size). Production Workers refuse more than
// 100,000 iterations (https://github.com/cloudflare/workerd/issues/1346), but local workerd and Node do not,
// so tests could pass with a count that fails when deployed. Hence the count is fixed at the cap here and
// the verifier refuses anything above it. SHA-512 because its 64-bit arithmetic suits GPUs less well than
// SHA-256 does. See docs/admin-auth.md for why this is still below the OWASP work factor.
export const PBKDF2_ITERATIONS = 100_000;
const HASH_PREFIX = "pbkdf2-sha512";
const SALT_BYTES = 16;
const HASH_BYTES = 64;

export interface PasswordHash { iterations: number; salt: Uint8Array; hash: Uint8Array }

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt, iterations }, key, HASH_BYTES * 8),
  );
}

/** `pbkdf2-sha512$<iterations>$<salt>$<hash>`, the last two base64url. */
export async function hashPassword(
  password: string, salt: Uint8Array = crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
): Promise<string> {
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return [HASH_PREFIX, PBKDF2_ITERATIONS, base64urlEncode(salt), base64urlEncode(hash)].join("$");
}

/** null if malformed, including any iteration count above what production Workers allow. */
export function parsePasswordHash(stored: string | undefined): PasswordHash | null {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX || !/^[1-9][0-9]{0,5}$/.test(parts[1])) return null;
  const iterations = Number(parts[1]);
  const salt = base64urlDecode(parts[2]);
  const hash = base64urlDecode(parts[3]);
  if (iterations > PBKDF2_ITERATIONS || salt?.length !== SALT_BYTES || hash?.length !== HASH_BYTES) return null;
  return { iterations, salt, hash };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  return timingSafeEqual(await derive(password, stored.salt, stored.iterations), stored.hash);
}
