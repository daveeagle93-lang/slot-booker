import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64urlDecode, base64urlEncode, generateAdminSecret, hashAdminSecret, isCanonicalAdminSecret, parseAdminSecretHash,
  timingSafeEqual, verifyAdminSecret,
} from "./crypto";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("base64url", () => {
  it("round-trips every length without padding or +/ characters", () => {
    for (let n = 0; n < 40; n++) {
      const data = crypto.getRandomValues(new Uint8Array(n));
      const text = base64urlEncode(data);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64urlDecode(text)).toEqual(data);
    }
    expect(base64urlEncode(bytes(251, 255, 254))).toBe("-__-");
  });

  it("refuses anything that is not base64url", () => {
    for (const bad of ["a=", "a b", "a+b/", "a", "ab\n", "é"]) expect(base64urlDecode(bad)).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical bytes", () => {
    expect(timingSafeEqual(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true);
    expect(timingSafeEqual(bytes(), bytes())).toBe(true);
    expect(timingSafeEqual(bytes(9, 2, 3), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqual(bytes(1, 2, 9), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqual(bytes(1, 2), bytes(1, 2, 3))).toBe(false);
    expect(timingSafeEqual(bytes(1, 2, 3), bytes(1, 2))).toBe(false);
  });
});

describe("generated admin secrets", () => {
  it("are 43 base64url characters of 32 random bytes, and differ each time", () => {
    const a = generateAdminSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64urlDecode(a)?.length).toBe(32);
    expect(isCanonicalAdminSecret(a)).toBe(true);
    expect(generateAdminSecret()).not.toBe(a);
  });

  it("have exactly one accepted spelling: the last character only carries 4 bits", () => {
    const secret = base64urlEncode(new Uint8Array(32)); // 43 x "A"
    expect(secret).toBe("A".repeat(43));
    expect(isCanonicalAdminSecret(secret)).toBe(true);
    // "B", "C" and "D" differ from "A" only in the 2 unused bits, so they decode to the same 32 bytes,
    // but are not what the generator writes. ("E" differs in a used bit, so it is simply a different secret.)
    for (const last of "BCD") {
      const variant = secret.slice(0, 42) + last;
      expect(base64urlDecode(variant)).toEqual(base64urlDecode(secret));
      expect(isCanonicalAdminSecret(variant), variant).toBe(false);
    }
    expect(base64urlDecode(secret.slice(0, 42) + "E")).not.toEqual(base64urlDecode(secret));
    expect(isCanonicalAdminSecret(secret.slice(0, 42) + "E")).toBe(true);
  });

  it("are refused when the wrong length, charset or shape", () => {
    const good = generateAdminSecret();
    for (const bad of [
      "", good.slice(1), good.slice(0, 42), `${good}A`, `${good} `, ` ${good}`, `${good}\n`, `${good.slice(0, 42)}=`,
      `${good.slice(0, 42)}+`, `${good.slice(0, 42)}/`, `${good.slice(0, 42)}\u00e9`, `${good.slice(0, 42)}\u0000`,
    ]) expect(isCanonicalAdminSecret(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("admin secret hashes", () => {
  const salt = new Uint8Array(16).fill(7);

  it("hashes in the documented format and verifies the right secret only", async () => {
    const secret = generateAdminSecret();
    const stored = await hashAdminSecret(secret, salt);
    const [prefix, s, m, ...rest] = stored.split("$");
    expect(prefix).toBe("hmac-sha256");
    expect(rest).toEqual([]);
    expect(base64urlDecode(s)).toEqual(salt);
    expect(base64urlDecode(m)?.length).toBe(32);
    const parsed = parseAdminSecretHash(stored)!;
    expect(parsed).not.toBeNull();
    expect(await verifyAdminSecret(secret, parsed)).toBe(true);
    expect(await verifyAdminSecret(generateAdminSecret(), parsed)).toBe(false);
    expect(await verifyAdminSecret("", parsed)).toBe(false);
  });

  it("is HMAC-SHA-256 keyed with the salt over the UTF-8 secret", async () => {
    const secret = generateAdminSecret();
    const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(secret)));
    expect((await hashAdminSecret(secret, salt)).split("$")[2]).toBe(base64urlEncode(expected));
  });

  it("uses a random salt by default", async () => {
    const secret = generateAdminSecret();
    expect(await hashAdminSecret(secret)).not.toBe(await hashAdminSecret(secret));
  });

  it("fails when any single character of the secret is changed", async () => {
    const secret = generateAdminSecret();
    const parsed = parseAdminSecretHash(await hashAdminSecret(secret, salt))!;
    for (let i = 0; i < secret.length; i++) {
      const other = secret[i] === "A" ? "B" : "A";
      expect(await verifyAdminSecret(secret.slice(0, i) + other + secret.slice(i + 1), parsed), `position ${i}`).toBe(false);
    }
  });

  describe("refuses a badly shaped secret before any hashing", () => {
    afterEach(() => vi.restoreAllMocks());

    it("without touching crypto.subtle", async () => {
      const secret = generateAdminSecret();
      const parsed = parseAdminSecretHash(await hashAdminSecret(secret, salt))!;
      const spies = (["importKey", "sign", "digest", "verify", "deriveBits"] as const)
        .map((name) => vi.spyOn(crypto.subtle, name));
      const tooShort = secret.slice(0, 42);
      const tooLong = `${secret}A`;
      const nonCanonical = base64urlEncode(new Uint8Array(32)).slice(0, 42) + "B";
      for (const bad of ["", "x", tooShort, tooLong, nonCanonical, ` ${secret}`, `${secret.slice(0, 42)}!`]) {
        expect(await verifyAdminSecret(bad, parsed), JSON.stringify(bad)).toBe(false);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(await verifyAdminSecret(secret, parsed)).toBe(true);
      expect(spies[0]).toHaveBeenCalledTimes(1);
      expect(spies[1]).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects the old pbkdf2 formats as malformed", () => {
    const s = base64urlEncode(new Uint8Array(16));
    const h = base64urlEncode(new Uint8Array(32));
    for (const old of [`pbkdf2-sha256$100000$${s}$${h}`, `pbkdf2-sha512$100000$${s}$${base64urlEncode(new Uint8Array(64))}`]) {
      expect(parseAdminSecretHash(old), old).toBeNull();
    }
  });

  it("rejects malformed stored hashes", () => {
    const s = base64urlEncode(new Uint8Array(16));
    const h = base64urlEncode(new Uint8Array(32));
    const bad = [
      undefined, "", "plain", `hmac-sha256$${s}`, `hmac-sha256$${s}$${h}$extra`, `hmac-sha256$${s}$${h}$`, `hmac-sha256$${s}$!!!`,
      `hmac-sha256$!!!$${h}`, `hmac-sha256$${s.slice(0, 10)}$${h}`, `hmac-sha256$${s}$${h.slice(0, 20)}`,
      `hmac-sha256$${s}$${base64urlEncode(new Uint8Array(64))}`, `hmac-sha512$${s}$${h}`, `HMAC-SHA256$${s}$${h}`,
      `$${s}$${h}`, `hmac-sha256$$${h}`, `hmac-sha256$${s}$`, ` hmac-sha256$${s}$${h}`,
    ];
    for (const stored of bad) expect(parseAdminSecretHash(stored), String(stored)).toBeNull();
    expect(parseAdminSecretHash(`hmac-sha256$${s}$${h}`)).not.toBeNull();
  });
});
