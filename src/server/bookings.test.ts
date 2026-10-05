import { describe, expect, it } from "vitest";
import { ANCHOR_CODE_POINTS, FORMAT_CODE_POINTS, hex, ORDINARY_NAMES } from "../test/format-chars";
import { readJsonObject, validateBookingInput } from "./bookings";

const request = (body: string): Request =>
  new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body });

/** A JSON object whose serialised form is exactly `bytes` bytes. */
const objectOfSize = (bytes: number): string => {
  const base = JSON.stringify({ p: "" });
  return JSON.stringify({ p: "x".repeat(bytes - base.length) });
};

describe("readJsonObject body cap", () => {
  it("defaults to 4096 bytes", async () => {
    expect(await readJsonObject(request(objectOfSize(4096)))).toEqual({ p: expect.any(String) });
    const over = await readJsonObject(request(objectOfSize(4097)));
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
  });

  it("takes a larger cap, and still enforces it", async () => {
    expect(await readJsonObject(request(objectOfSize(32768)), 32768)).toEqual({ p: expect.any(String) });
    const over = await readJsonObject(request(objectOfSize(32769)), 32768);
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
  });
});

describe("validateBookingInput: names", () => {
  const input = (over: Record<string, unknown>) =>
    validateBookingInput({ slot: "2026-10-24T09:00:00.000Z", dogName: "Fly", handlerName: "Pat", idempotencyKey: "k".repeat(16), ...over });
  const fieldsOf = (over: Record<string, unknown>) => {
    const r = input(over);
    return "fields" in r ? r.fields : null;
  };

  it("finds format characters to test", () => {
    expect(FORMAT_CODE_POINTS.length).toBeGreaterThan(100);
    expect(FORMAT_CODE_POINTS).toContain(0x061c);
  });

  it.each(ANCHOR_CODE_POINTS)("lists the known format character %#, and a dog's and a handler's name containing it is refused", (cp) => {
    expect(FORMAT_CODE_POINTS, hex(cp)).toContain(cp);
    for (const key of ["dogName", "handlerName"]) {
      expect(fieldsOf({ [key]: `a${String.fromCodePoint(cp)}b` })?.[key], `${hex(cp)} in ${key}`).toContain("invisible");
    }
  });

  it("rejects every Unicode format character (Cf) in a dog's name and a handler's name", () => {
    const accepted: string[] = [];
    for (const cp of FORMAT_CODE_POINTS) {
      const ch = String.fromCodePoint(cp);
      for (const key of ["dogName", "handlerName"]) {
        for (const value of [`a${ch}b`, `${ch}ab`, `ab${ch}`]) {
          if (!fieldsOf({ [key]: value })?.[key]?.includes("invisible")) accepted.push(`${hex(cp)} in ${key}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });

  it("rejects U+061C ARABIC LETTER MARK by name", () => {
    expect(fieldsOf({ dogName: "Fl\u061Cy" })?.dogName).toBe("The dog's name can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
    expect(fieldsOf({ handlerName: "P\u061Cat" })?.handlerName).toBe("The handler's name can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.");
  });

  it.each(["\u200C", "\u200D"])("rejects the joiner %j, which is Cf", (ch) => {
    expect(fieldsOf({ dogName: `a${ch}b` })).toHaveProperty("dogName");
  });

  // The shared list also holds a plain emoji ("🐕"), which event and club names accept but a dog's or handler's name does not.
  it.each(ORDINARY_NAMES.filter((n) => /[\p{L}\p{N}]/u.test(n)))("still accepts %s", (name) => {
    expect(input({ dogName: name, handlerName: name })).toMatchObject({ dogName: name, handlerName: name });
  });

  it.each([
    ["Hangul filler U+3164", "\u3164"],
    ["halfwidth Hangul filler U+FFA0", "\uFFA0"],
    ["braille blank U+2800", "\u2800"],
    ["variation selector-16", "\uFE0F"],
    ["a variation selector and a tag-range selector", "\uFE0F\u{E0100}"],
    ["combining grapheme joiner", "\u034F"],
    ["a plain emoji", "\u{1F436}"],
    ["an emoji and spaces", " \u{1F436} \u2764\uFE0F "],
    ["punctuation only", "-'.!"],
  ])("refuses a dog's and a handler's name with no letter or number in it: %s", (_what, name) => {
    for (const [key, label] of [["dogName", "dog's name"], ["handlerName", "handler's name"]]) {
      expect(fieldsOf({ [key]: name })?.[key], key).toBe(`The ${label} must contain at least one letter or number.`);
    }
  });

  const PRIVATE_USE_MESSAGE = (label: string) => `The ${label} can't contain private-use or blank-looking characters. Try plain text.`;

  it.each([
    ["private use, BMP start U+E000", "\uE000"],
    ["private use, BMP end U+F8FF", "\uF8FF"],
    ["private use, plane 15 U+F0000", "\u{F0000}"],
    ["private use, plane 16 U+10FFFD", "\u{10FFFD}"],
    ["braille blank U+2800", "\u2800"],
  ])("refuses %s beside a real letter, inside, at the start and at the end of a dog's and a handler's name", (_what, ch) => {
    expect(/^[\p{Co}\u2800]$/u.test(ch)).toBe(true);
    for (const make of [(n: string) => `${n}${ch}${n}`, (n: string) => `${ch}${n}`, (n: string) => `${n}${ch}`]) {
      expect(fieldsOf({ dogName: make("Rex"), handlerName: make("Sam") }), JSON.stringify(make("Rex")))
        .toEqual({ dogName: PRIVATE_USE_MESSAGE("dog's name"), handlerName: PRIVATE_USE_MESSAGE("handler's name") });
    }
  });

  it("does not refuse unassigned code points (Cn): a character a newer runtime has assigned (a new emoji) must not break names", () => {
    const unassigned = "\uFFFF"; // a noncharacter: category Cn, never to be assigned
    expect(/^\p{Cn}$/u.test(unassigned)).toBe(true);
    expect(input({ dogName: `Rex${unassigned}`, handlerName: `${unassigned}Sam` })).toMatchObject({ dogName: `Rex${unassigned}`, handlerName: `${unassigned}Sam` });
  });

  it("still says Enter the name for an empty or all-whitespace name", () => {
    expect(fieldsOf({ dogName: "   " })?.dogName).toBe("Enter the dog's name.");
    expect(fieldsOf({ handlerName: "" })?.handlerName).toBe("Enter the handler's name.");
  });

  it.each(["Rex \u2764\uFE0F", "Zo\u00EB", "7", "\uFF21\uFF4E\uFF4E", "Rex\uFE0F"])("accepts %j, which has a letter or number", (name) => {
    expect(input({ dogName: name, handlerName: name })).toMatchObject({ dogName: name.trim(), handlerName: name.trim() });
  });
});
