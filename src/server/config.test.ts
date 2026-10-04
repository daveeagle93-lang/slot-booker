import { afterEach, describe, expect, it, vi } from "vitest";
import { bookingCutoffOffsetMinutes, DEFAULT_PRIVACY_NOTICE, privacyNotice } from "./config";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

describe("bookingCutoffOffsetMinutes", () => {
  it.each([
    ["0", 0], ["30", 30], ["-30", -30], ["+45", 45], [" 15 ", 15], ["007", 7],
    ["10080", 10080], ["-10080", -10080],
  ])("accepts %j as %d without warning", (raw, expected) => {
    expect(bookingCutoffOffsetMinutes(raw)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults to 0, silently, when unset", () => {
    expect(bookingCutoffOffsetMinutes(undefined)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "abc", "1.5", "30m", "1e2", "0x10", "--5", "10081", "-10081", "99999999999999999999", "NaN", "Infinity"])(
    "falls back to 0 and warns once, naming the variable, for %j",
    (raw) => {
      expect(bookingCutoffOffsetMinutes(raw)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("BOOKING_CUTOFF_OFFSET_MINUTES");
    },
  );
});

describe("privacyNotice", () => {
  it("has a British English default that makes no promise of a deletion date", () => {
    expect(DEFAULT_PRIVACY_NOTICE).toBe(
      "We store your name, your dog's name and the slot you choose so the club can run the event. "
      + "The club's organisers can see these details; other people using this page only see which slots are taken. "
      + "The club deletes booking details after the event.",
    );
  });

  it.each([undefined, "", "   ", "\n\n \t\n"])("uses the default for %j", (raw) => {
    expect(privacyNotice(raw)).toBe(DEFAULT_PRIVACY_NOTICE);
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a custom notice, trimmed, keeping blank lines between paragraphs", () => {
    expect(privacyNotice("  First paragraph.\n\nSecond paragraph.\n ")).toBe("First paragraph.\n\nSecond paragraph.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a notice of exactly 1000 code points", () => {
    const exact = "é".repeat(1000);
    expect(privacyNotice(exact)).toBe(exact);
    expect(warn).not.toHaveBeenCalled();
  });

  it("truncates to 1000 code points, not UTF-16 units, and warns once", () => {
    const long = "🐕".repeat(1001);
    const result = privacyNotice(long);
    expect([...result]).toHaveLength(1000);
    expect(result.isWellFormed()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("PRIVACY_NOTICE");
  });
});
