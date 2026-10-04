import { describe, expect, it } from "vitest";
import { generateSlug, isValidSlug } from "./slug";

describe("generateSlug", () => {
  it("is 22 base64url characters", () => {
    expect(generateSlug()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("is unique across 1000 calls", () => {
    expect(new Set(Array.from({ length: 1000 }, generateSlug)).size).toBe(1000);
  });
});

describe("isValidSlug", () => {
  it("accepts generated slugs", () => {
    for (let i = 0; i < 100; i++) expect(isValidSlug(generateSlug())).toBe(true);
  });

  it("accepts the 16 and 64 character bounds", () => {
    expect(isValidSlug("a".repeat(16))).toBe(true);
    expect(isValidSlug("a".repeat(64))).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["short", "abc"],
    ["15 characters", "a".repeat(15)],
    ["spaces", "a".repeat(15) + " b"],
    ["path traversal", "../x" + "a".repeat(16)],
    ["unicode", "é".repeat(20)],
    ["over 64 characters", "a".repeat(65)],
    ["trailing newline", "a".repeat(22) + "\n"],
  ])("rejects %s", (_label, s) => {
    expect(isValidSlug(s)).toBe(false);
  });
});
