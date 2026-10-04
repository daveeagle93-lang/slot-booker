import { describe, expect, it } from "vitest";
import {
  base64urlDecode, base64urlEncode, hashPassword, parsePasswordHash, PBKDF2_ITERATIONS, timingSafeEqual,
  verifyPassword,
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

describe("password hashes", () => {
  const salt = new Uint8Array(16).fill(7);

  it("hashes in the documented format and verifies the right password only", async () => {
    const stored = await hashPassword("correct horse battery", salt);
    const [prefix, iterations, s, h] = stored.split("$");
    expect(prefix).toBe("pbkdf2-sha256");
    expect(iterations).toBe(String(PBKDF2_ITERATIONS));
    expect(PBKDF2_ITERATIONS).toBe(100_000);
    expect(base64urlDecode(s)).toEqual(salt);
    expect(base64urlDecode(h)?.length).toBe(32);
    const parsed = parsePasswordHash(stored)!;
    expect(parsed).not.toBeNull();
    expect(await verifyPassword("correct horse battery", parsed)).toBe(true);
    expect(await verifyPassword("correct horse batterY", parsed)).toBe(false);
    expect(await verifyPassword("", parsed)).toBe(false);
  });

  it("uses a random salt by default", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("rejects hashes in the old pbkdf2-sha512 format (64-byte output)", () => {
    const old = `pbkdf2-sha512$100000$${base64urlEncode(new Uint8Array(16))}$${base64urlEncode(new Uint8Array(64))}`;
    expect(parsePasswordHash(old)).toBeNull();
    // Even with the prefix fixed up, a 64-byte hash is the wrong length.
    expect(parsePasswordHash(old.replace("sha512", "sha256"))).toBeNull();
  });

  it("rejects malformed stored hashes", async () => {
    const good = await hashPassword("correct horse battery", salt);
    const [, , s, h] = good.split("$");
    const bad = [
      undefined, "", "plain", good.replace("pbkdf2-sha256", "pbkdf2-sha512"), `pbkdf2-sha256$100000$${s}`,
      `pbkdf2-sha256$100000$${s}$${h}$extra`, `pbkdf2-sha256$100000$${s}$!!!`, `pbkdf2-sha256$100000$!!!$${h}`,
      `pbkdf2-sha256$100000$${s.slice(0, 10)}$${h}`, `pbkdf2-sha256$100000$${s}$${h.slice(0, 20)}`,
      `pbkdf2-sha256$0$${s}$${h}`, `pbkdf2-sha256$100001$${s}$${h}`, `pbkdf2-sha256$600000$${s}$${h}`,
      `pbkdf2-sha256$abc$${s}$${h}`, `pbkdf2-sha256$1.5$${s}$${h}`, `pbkdf2-sha256$-5$${s}$${h}`,
      `pbkdf2-sha256$1e3$${s}$${h}`, `pbkdf2-sha256$ 5$${s}$${h}`, `pbkdf2-sha256$$${s}$${h}`,
    ];
    for (const stored of bad) expect(parsePasswordHash(stored), String(stored)).toBeNull();
    expect(parsePasswordHash(`pbkdf2-sha256$1000$${s}$${h}`)).not.toBeNull();
  });
});
