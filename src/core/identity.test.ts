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
});
