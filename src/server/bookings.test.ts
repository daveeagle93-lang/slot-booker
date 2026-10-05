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

  it.each(ORDINARY_NAMES)("still accepts %s", (name) => {
    expect(input({ dogName: name, handlerName: name })).toMatchObject({ dogName: name, handlerName: name });
  });
});
