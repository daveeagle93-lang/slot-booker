import { describe, expect, it } from "vitest";
import { identityKey } from "./identity";

describe("identityKey", () => {
  it("folds case beyond ASCII", () => {
    expect(identityKey("Zoë")).toBe(identityKey("ZOË"));
  });

  it("treats precomposed and decomposed accents as equal", () => {
    expect(identityKey("Zoë")).toBe(identityKey("Zoë"));
  });

  it("folds NFKC compatibility characters", () => {
    expect(identityKey("Ｒｅｘ")).toBe("rex");
  });

  it("trims and collapses internal whitespace", () => {
    expect(identityKey("  Sam   Jones ")).toBe("sam jones");
  });

  it("collapses tab, newline and NBSP to a single space", () => {
    expect(identityKey("Sam\t\n Jones")).toBe("sam jones");
  });

  it("keeps different names different", () => {
    expect(identityKey("ab")).not.toBe(identityKey("a b"));
  });

  it("does not special-case Turkish dotted/dotless I", () => {
    expect(identityKey("I")).toBe("i");
    expect(identityKey("İ")).not.toBe("i");
  });

  it("ignores invisible default-ignorable characters, so variation-selector variants collide", () => {
    expect(identityKey("Rex\uFE0F")).toBe("rex");
    expect(identityKey("Rex\u{E0100}")).toBe("rex");
    expect(identityKey("\uFE0Fr\uFE0Fex")).toBe("rex");
    expect(identityKey("Rex \u2764\uFE0F")).toBe(identityKey("Rex \u2764"));
  });

  it("ignores Hangul fillers, including after NFKC turns U+3164 and U+FFA0 into U+1160", () => {
    expect(identityKey("Rex\u3164")).toBe("rex");
    expect(identityKey("Rex\uFFA0")).toBe("rex");
    expect(identityKey("Rex\u115F\u1160")).toBe("rex");
    expect(identityKey("\u3164")).toBe("");
  });

  it("makes e + combining grapheme joiner + acute collide with the precomposed letter", () => {
    expect(identityKey("e\u034F\u0301")).toBe(identityKey("\u00E9"));
  });

  it("leaves ASCII names as before", () => {
    expect(identityKey("Rex")).toBe("rex");
    expect(identityKey("Sam Jones")).toBe("sam jones");
  });
});
