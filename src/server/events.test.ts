import { describe, expect, it } from "vitest";
import { bookingWindow, type EventRow } from "./events";

const START = "2026-06-13T08:00:00Z";
const event = (o: Partial<EventRow> = {}): EventRow => ({
  id: 1, slug: "x", name: "Test", startUtc: START, endUtc: "2026-06-13T11:00:00Z", sessionMinutes: 15, gapMinutes: 0,
  costPence: 0, venuePostcode: "AB1 2CD", details: "", archived: false, breaks: [], ...o,
});
const at = (iso: string) => new Date(iso);

describe("bookingWindow", () => {
  // [offset minutes, now, expected open, expected closesAt]
  it.each([
    [0, "2026-06-13T07:59:59Z", true, "2026-06-13T08:00:00Z"],
    [0, "2026-06-13T08:00:00Z", false, "2026-06-13T08:00:00Z"], // exactly at closing: closed
    [0, "2026-06-13T08:00:01Z", false, "2026-06-13T08:00:00Z"],
    [30, "2026-06-13T08:29:59Z", true, "2026-06-13T08:30:00Z"],
    [30, "2026-06-13T08:30:00Z", false, "2026-06-13T08:30:00Z"],
    [-30, "2026-06-13T07:29:59Z", true, "2026-06-13T07:30:00Z"],
    [-30, "2026-06-13T07:30:00Z", false, "2026-06-13T07:30:00Z"],
    [10080, "2026-06-20T07:59:59Z", true, "2026-06-20T08:00:00Z"],
    [-10080, "2026-06-06T08:00:00Z", false, "2026-06-06T08:00:00Z"],
  ])("offset %d at %s: open=%s", (offset, now, open, closesAt) => {
    expect(bookingWindow(event(), offset, at(now))).toEqual({ open, closesAt });
  });

  it("is never open for an archived event, whatever the time", () => {
    expect(bookingWindow(event({ archived: true }), 0, at("2026-01-01T00:00:00Z")))
      .toEqual({ open: false, closesAt: START });
  });
});
