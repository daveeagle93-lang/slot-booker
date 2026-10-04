import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { londonToUtc } from "../core/london";
import { generateSchedule } from "../core/schedule";
import { generateSlug } from "../core/slug";
import { countRows, createTestEnv, type TestEnv } from "../test/db";
import { insertEventWithBreaks, parseEventDraft, previewSchedule, type EventDraft } from "./admin-events";

const NOW = new Date("2026-10-01T12:00:00Z");

/** A valid input: BST day, 09:00-12:00, quarter-hour sessions, no breaks. */
const valid = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00",
  sessionMinutes: 15, gapMinutes: 0, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water", breaks: [],
  ...over,
});

const parse = (over: Record<string, unknown> = {}, requireFuture = true) =>
  parseEventDraft(valid(over), { now: NOW, requireFuture });

/** The field errors for an input, or fails the test if it was accepted. */
function fieldsOf(over: Record<string, unknown>, requireFuture = true): Record<string, string> {
  const r = parse(over, requireFuture);
  if (!("fields" in r)) throw new Error(`accepted: ${JSON.stringify(over)}`);
  return r.fields;
}

function draftOf(over: Record<string, unknown> = {}, requireFuture = true): EventDraft {
  const r = parse(over, requireFuture);
  if (!("draft" in r)) throw new Error(`rejected: ${JSON.stringify(r.fields)}`);
  return r.draft;
}

const ok = (over: Record<string, unknown>, requireFuture = true): boolean => "draft" in parse(over, requireFuture);

describe("parseEventDraft: accepted input", () => {
  it("returns London strings and UTC instants (BST: 09:00 is 08:00Z)", () => {
    expect(draftOf({ breaks: [{ start: "10:00", end: "10:30" }] })).toEqual({
      name: "Saturday trial day", date: "2026-10-24", start: "09:00", end: "12:00",
      sessionMinutes: 15, gapMinutes: 0, costPence: 1500, venuePostcode: "AB1 2CD", details: "Bring water",
      startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z",
      breaks: [{ start: "10:00", end: "10:30", startUtc: "2026-10-24T09:00:00Z", endUtc: "2026-10-24T09:30:00Z" }],
    });
  });

  it("converts GMT correctly (2026-10-31: 09:00 is 09:00Z)", () => {
    expect(draftOf({ date: "2026-10-31" })).toMatchObject({ startUtc: "2026-10-31T09:00:00Z", endUtc: "2026-10-31T12:00:00Z" });
  });

  it("ignores unknown keys", () => {
    expect("draft" in parse({ colour: "red", id: 7 })).toBe(true);
  });

  it("never throws on junk, and reports every field", () => {
    for (const junk of [{}, { name: 1, date: 2, start: [], end: {}, sessionMinutes: "x", gapMinutes: null, costPence: true, venuePostcode: 0, details: 0, breaks: "no" }]) {
      const r = parseEventDraft(junk, { now: NOW, requireFuture: true });
      expect("fields" in r && Object.keys(r.fields).sort()).toEqual([
        "breaks", "costPence", "date", "details", "end", "gapMinutes", "name", "sessionMinutes", "start", "venuePostcode",
      ]);
    }
  });
});

describe("parseEventDraft: name", () => {
  it("trims, and accepts 1 to 100 code points", () => {
    expect(draftOf({ name: "  x  " }).name).toBe("x");
    expect(draftOf({ name: "😀".repeat(100) }).name).toBe("😀".repeat(100));
    expect(fieldsOf({ name: "😀".repeat(101) }).name).toMatch(/at most 100/);
  });

  it.each([["empty", ""], ["blank", "  \t "], ["a number", 5], ["missing", undefined]])("rejects %s", (_n, name) => {
    expect(fieldsOf({ name }).name).toBe("Enter the event name.");
  });

  it.each([
    ["a control character", "a\u0007b", /control/],
    ["a newline", "a\nb", /control/],
    ["a zero-width space", "a​b", /invisible/],
    ["a right-to-left override", "a‮b", /invisible/],
    ["a lone surrogate", "a\uD800b", /unpaired/],
  ])("rejects %s", (_n, name, message) => {
    expect(fieldsOf({ name }).name).toMatch(message);
  });

  it("allows an emoji joiner", () => {
    expect(ok({ name: "👩‍🐕" })).toBe(true);
  });
});

describe("parseEventDraft: date", () => {
  it.each(["2026-02-30", "2026-13-01", "2026-10-4", "24/10/2026", "", 20261024, undefined])("rejects %j", (date) => {
    expect(fieldsOf({ date }).date).toBe("Enter a real date.");
  });

  it("still checks the times' shape when the date is bad", () => {
    expect(fieldsOf({ date: "nope", start: "9:00" })).toEqual({ date: "Enter a real date.", start: "Enter a time as HH:MM." });
  });

  it("must start strictly after now when requireFuture (event starts 2026-10-24T08:00:00Z)", () => {
    const at = (iso: string) => parseEventDraft(valid(), { now: new Date(iso), requireFuture: true });
    expect("draft" in at("2026-10-24T07:59:59Z")).toBe(true);
    expect("fields" in at("2026-10-24T08:00:00Z") && (at("2026-10-24T08:00:00Z") as { fields: Fields }).fields.date).toBe("The event must start in the future.");
    expect("fields" in at("2026-10-24T08:00:01Z")).toBe(true);
  });

  it("may be in the past when not requireFuture", () => {
    expect(ok({ date: "2020-01-01" }, false)).toBe(true);
    expect(fieldsOf({ date: "2020-01-01" }).date).toBe("The event must start in the future.");
  });

  it("is at most 730 days ahead of now (start exactly 730 days ahead is fine)", () => {
    const start = Date.parse("2026-10-24T08:00:00Z");
    const at = (ms: number) => parseEventDraft(valid(), { now: new Date(start - ms), requireFuture: true });
    const day = 86_400_000;
    expect("draft" in at(730 * day)).toBe(true);
    const over = at(730 * day + 1000);
    expect("fields" in over && over.fields.date).toMatch(/more than two years/);
    expect("draft" in parseEventDraft(valid(), { now: new Date(start - 730 * day - 1000), requireFuture: false })).toBe(true);
  });
});

type Fields = Record<string, string>;

describe("parseEventDraft: start and end", () => {
  it.each(["9:00", "24:00", "09:60", "0900", "09:00:00", "", 900, undefined])("rejects start %j", (start) => {
    expect(fieldsOf({ start }).start).toBe("Enter a time as HH:MM.");
  });
  it.each(["12:5", "25:00", null])("rejects end %j", (end) => {
    expect(fieldsOf({ end }).end).toBe("Enter a time as HH:MM.");
  });

  it("needs the end after the start on the same date", () => {
    expect(ok({ start: "09:00", end: "09:15" })).toBe(true);
    expect(fieldsOf({ start: "09:00", end: "09:00" }).end).toBe("The end must be after the start.");
    expect(fieldsOf({ start: "09:00", end: "08:59" }).end).toBe("The end must be after the start.");
    expect(fieldsOf({ start: "09:00", end: "00:00" }).end).toBe("The end must be after the start.");
    expect(ok({ start: "00:00", end: "23:59" })).toBe(true);
  });

  it("rejects a time the clocks skip (2026-03-29 01:30) and one they repeat (2026-10-25 01:30)", () => {
    expect(fieldsOf({ date: "2026-03-29", start: "01:30", end: "05:00" }).start).toBe("That time doesn't exist in London on that date (the clocks go forward).");
    expect(fieldsOf({ date: "2026-03-29", start: "00:00", end: "01:59" }).end).toMatch(/doesn't exist/);
    expect(fieldsOf({ date: "2026-10-25", start: "01:30", end: "05:00" }).start).toBe("That time happens twice in London on that date (the clocks go back).");
    expect(fieldsOf({ date: "2026-10-25", start: "00:00", end: "01:00" }).end).toMatch(/happens twice/);
  });

  it("accepts the times either side of the clock changes", () => {
    // These dates are before NOW, so only check them as previews.
    expect(draftOf({ date: "2026-03-29", start: "00:00", end: "02:00" }, false)).toMatchObject({
      startUtc: "2026-03-29T00:00:00Z", endUtc: "2026-03-29T01:00:00Z",
    });
    expect(draftOf({ date: "2026-10-25", start: "00:00", end: "02:00" })).toMatchObject({
      startUtc: "2026-10-24T23:00:00Z", endUtc: "2026-10-25T02:00:00Z",
    });
  });
});

describe("parseEventDraft: numbers", () => {
  const cases: [string, number, number][] = [["sessionMinutes", 1, 480], ["gapMinutes", 0, 120], ["costPence", 0, 100_000]];
  for (const [field, min, max] of cases) {
    it(`${field} accepts ${min} to ${max} and rejects either side, fractions, strings and null`, () => {
      // A 480-minute session needs a long day; a 1-minute one would make too many slots on one.
      expect(ok({ [field]: min })).toBe(true);
      expect(ok({ start: "00:00", end: "23:59", [field]: max })).toBe(true);
      expect(fieldsOf({ [field]: min - 1 })[field]).toBeDefined();
      expect(fieldsOf({ [field]: max + 1 })[field]).toBeDefined();
      for (const bad of [min + 0.5, String(min), null, NaN, undefined]) expect(fieldsOf({ [field]: bad })[field], String(bad)).toBeDefined();
    });
  }
});

describe("parseEventDraft: venue postcode", () => {
  it("tidies: trimmed, one space, upper case", () => {
    expect(draftOf({ venuePostcode: "  sw1a \t 1aa " }).venuePostcode).toBe("SW1A 1AA");
  });
  it("accepts 2 to 10 characters", () => {
    expect(ok({ venuePostcode: "AB" })).toBe(true);
    expect(ok({ venuePostcode: "ABCDE FGHI" })).toBe(true);
    expect(fieldsOf({ venuePostcode: "A" }).venuePostcode).toBeDefined();
    expect(fieldsOf({ venuePostcode: "ABCDE FGHIJ" }).venuePostcode).toBeDefined();
    expect(fieldsOf({ venuePostcode: "   " }).venuePostcode).toBeDefined();
  });
  it("rejects other characters, including ones that upper-case into ASCII", () => {
    for (const venuePostcode of ["AB-1 2CD", "AB1 2C!", "ßß1", "ab1\u00002cd", 5]) {
      expect(fieldsOf({ venuePostcode }).venuePostcode, String(venuePostcode)).toBeDefined();
    }
  });
});

describe("parseEventDraft: details", () => {
  it("may be empty, and is up to 2000 code points", () => {
    expect(draftOf({ details: "" }).details).toBe("");
    expect(ok({ details: "😀".repeat(2000) })).toBe(true);
    expect(fieldsOf({ details: "😀".repeat(2001) }).details).toMatch(/at most 2000/);
  });
  it("keeps newlines and normalises CRLF", () => {
    expect(draftOf({ details: "a\r\nb\nc" }).details).toBe("a\nb\nc");
  });
  it.each([["tab", "a\tb"], ["lone CR", "a\rb"], ["NUL", "a\u0000b"], ["escape", "a\u001Bb"]])("rejects %s", (_n, details) => {
    expect(fieldsOf({ details }).details).toMatch(/control/);
  });
  it("rejects a lone surrogate and non-strings", () => {
    expect(fieldsOf({ details: "a\uD800" }).details).toMatch(/unpaired/);
    expect(fieldsOf({ details: undefined }).details).toBeDefined();
    expect(fieldsOf({ details: 3 }).details).toBeDefined();
  });
});

describe("parseEventDraft: breaks", () => {
  const brk = (start: string, end: string) => ({ start, end });

  it("must be a list of at most 20", () => {
    expect(fieldsOf({ breaks: "x" }).breaks).toBe("Breaks must be a list.");
    expect(fieldsOf({ breaks: undefined }).breaks).toBe("Breaks must be a list.");
    const many = (n: number) => Array.from({ length: n }, () => brk("10:00", "10:05"));
    expect(ok({ breaks: many(20) })).toBe(true);
    expect(fieldsOf({ breaks: many(21) }).breaks).toBe("You can add at most 20 breaks.");
  });

  it("each break must be an object", () => {
    expect(fieldsOf({ breaks: [brk("10:00", "10:30"), "x", null, [1]] })).toEqual({
      "breaks.1": "Each break needs a start and an end.", "breaks.2": "Each break needs a start and an end.",
      "breaks.3": "Each break needs a start and an end.",
    });
  });

  it("keys time errors by index and side", () => {
    expect(fieldsOf({ breaks: [brk("10:00", "10:30"), { start: "9:00", end: 5 }] })).toEqual({
      "breaks.1.start": "Enter a time as HH:MM.", "breaks.1.end": "Enter a time as HH:MM.",
    });
  });

  it("must end after it starts", () => {
    expect(fieldsOf({ breaks: [brk("10:00", "10:00")] })["breaks.0.end"]).toBe("The break must end after it starts.");
    expect(fieldsOf({ breaks: [brk("10:30", "10:00")] })["breaks.0.end"]).toBe("The break must end after it starts.");
    expect(ok({ breaks: [brk("10:00", "10:01")] })).toBe(true);
  });

  it("must lie within the event (09:00-12:00); touching the edges is fine", () => {
    expect(ok({ breaks: [brk("09:00", "09:30")] })).toBe(true);
    expect(ok({ breaks: [brk("11:30", "12:00")] })).toBe(true);
    expect(fieldsOf({ breaks: [brk("08:59", "09:30")] })["breaks.0.start"]).toBe("The break must start within the event.");
    expect(fieldsOf({ breaks: [brk("11:30", "12:01")] })["breaks.0.end"]).toBe("The break must end within the event.");
  });

  it("may overlap or touch each other", () => {
    expect(ok({ breaks: [brk("10:00", "10:30"), brk("10:15", "10:45"), brk("10:45", "11:00")] })).toBe(true);
  });

  it("a break time in the autumn overlap is rejected under its own key", () => {
    const f = fieldsOf({ date: "2026-10-25", start: "00:00", end: "06:00", breaks: [brk("00:30", "00:45"), brk("01:30", "03:00")] });
    expect(f).toEqual({ "breaks.1.start": "That time happens twice in London on that date (the clocks go back)." });
    expect(fieldsOf({ date: "2026-03-29", start: "00:00", end: "06:00", breaks: [brk("00:30", "01:30")] })["breaks.0.end"]).toMatch(/doesn't exist/);
  });
});

describe("parseEventDraft: slot count", () => {
  it("needs at least one session", () => {
    expect(ok({ start: "09:00", end: "09:15" })).toBe(true);
    expect(fieldsOf({ start: "09:00", end: "09:14" })).toEqual({ end: "No sessions fit between the start and end." });
    expect(fieldsOf({ breaks: [{ start: "09:00", end: "12:00" }] })).toEqual({ end: "No sessions fit between the start and end." });
  });

  it("allows 500 slots and rejects 501", () => {
    expect(previewSchedule(draftOf({ start: "09:00", end: "17:20", sessionMinutes: 1 })).slots).toHaveLength(500);
    expect(fieldsOf({ start: "09:00", end: "17:21", sessionMinutes: 1 })).toEqual({ sessionMinutes: "That would make more than 500 slots." });
  });
});

describe("previewSchedule", () => {
  // 15 minute sessions from 09:00 with no gap: slots at :00 :15 :30 :45. A break 12:05-13:00 is overrun
  // by the 12:00-12:15 session by 10 minutes, the near-miss limit, so the engine offers to move it to
  // 12:15-13:10 (same 55 minutes), after the dropped session.
  const day = { date: "2026-10-24", start: "09:00", end: "17:00" };

  it("returns the engine's own slots", () => {
    const d = draftOf({ ...day, gapMinutes: 5, breaks: [{ start: "12:00", end: "13:00" }] });
    const engine = generateSchedule({
      start: d.startUtc, end: d.endUtc, sessionMinutes: 15, gapMinutes: 5, breaks: [{ start: londonToUtc("2026-10-24", "12:00"), end: londonToUtc("2026-10-24", "13:00") }],
    });
    expect(previewSchedule(d).slots).toEqual(engine.slots);
    expect(previewSchedule(d).slots[0]).toEqual({ start: "2026-10-24T08:00:00Z", end: "2026-10-24T08:15:00Z" });
  });

  it("suggests moving a near-miss break later, with the break's index and London times", () => {
    const d = draftOf({ ...day, breaks: [{ start: "12:05", end: "13:00" }] });
    expect(previewSchedule(d).suggestions).toEqual([{
      breakIndex: 0,
      droppedSlot: { start: "2026-10-24T11:00:00Z", end: "2026-10-24T11:15:00Z" },
      overrunMinutes: 10,
      suggestedBreak: { start: "2026-10-24T11:15:00Z", end: "2026-10-24T12:10:00Z" },
      suggestedLocal: { start: "12:15", end: "13:10" },
    }]);
    expect(previewSchedule(d).slots.map((s) => s.start)).not.toContain("2026-10-24T11:00:00Z");
  });

  it("gives no suggestion when the overrun is 11 minutes", () => {
    expect(previewSchedule(draftOf({ ...day, breaks: [{ start: "12:04", end: "13:00" }] })).suggestions).toEqual([]);
  });

  it("points each suggestion at its own break, whatever order the breaks were given in", () => {
    const d = draftOf({ ...day, breaks: [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00" }] });
    const { suggestions } = previewSchedule(d);
    expect(suggestions.map((s) => [s.breakIndex, s.suggestedLocal])).toEqual([
      [1, { start: "12:15", end: "13:10" }],
      [0, { start: "14:45", end: "14:50" }],
    ]);
    for (const s of suggestions) {
      const b = d.breaks[s.breakIndex];
      expect(b.startUtc > s.droppedSlot.start && b.startUtc < s.droppedSlot.end).toBe(true);
    }
  });

  it("applying suggestedLocal to the form removes the suggestion and keeps the session", () => {
    const before = previewSchedule(draftOf({ ...day, breaks: [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00" }] }));
    const first = before.suggestions[0];
    const breaks = [{ start: "14:35", end: "14:40" }, { start: "12:05", end: "13:00" }];
    breaks[first.breakIndex] = first.suggestedLocal;
    const after = previewSchedule(draftOf({ ...day, breaks }));
    expect(after.suggestions.map((s) => s.breakIndex)).toEqual([0]); // only the other break's suggestion remains
    expect(before.slots.map((s) => s.start)).not.toContain(first.droppedSlot.start);
    expect(after.slots.map((s) => s.start)).toContain(first.droppedSlot.start);
    expect(after.slots.map((s) => s.start)).not.toContain("2026-10-24T11:15:00Z"); // inside the moved break
  });

  it("leaves out a suggestion whose London time the form cannot express (autumn overlap)", () => {
    // 00:55-02:00 on 2026-10-25 starts in BST. The 00:45 session ends at 01:00 BST (00:00Z) and overruns it
    // by 5 minutes, so the engine would move the break to start at "01:00", which happens twice that night.
    const d = draftOf({ date: "2026-10-25", start: "00:00", end: "06:00", breaks: [{ start: "00:55", end: "02:00" }] });
    const engine = generateSchedule({
      start: d.startUtc, end: d.endUtc, sessionMinutes: 15, gapMinutes: 0, breaks: [{ start: d.breaks[0].startUtc, end: d.breaks[0].endUtc }],
    });
    expect(engine.suggestions).toHaveLength(1);
    expect(previewSchedule(d).suggestions).toEqual([]);
    expect(previewSchedule(d).slots).toEqual(engine.slots);
  });
});

describe("insertEventWithBreaks", () => {
  let t: TestEnv;
  beforeAll(async () => { t = await createTestEnv(); });
  afterAll(async () => { await t.dispose(); });

  it("stores the event and every break", async () => {
    const d = draftOf({ breaks: [{ start: "10:00", end: "10:15" }, { start: "11:00", end: "11:15" }] });
    const slug = generateSlug();
    await insertEventWithBreaks(t.env.DB, slug, d);
    const row = await t.env.DB.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first<Record<string, unknown>>();
    expect(row).toMatchObject({
      name: "Saturday trial day", start_utc: "2026-10-24T08:00:00Z", end_utc: "2026-10-24T11:00:00Z",
      session_minutes: 15, gap_minutes: 0, cost_pence: 1500, venue_postcode: "AB1 2CD", details: "Bring water", archived: 0,
    });
    const { results } = await t.env.DB.prepare("SELECT start_utc, end_utc FROM breaks WHERE event_id = ? ORDER BY start_utc").bind(row!.id).all();
    expect(results).toEqual([
      { start_utc: "2026-10-24T09:00:00Z", end_utc: "2026-10-24T09:15:00Z" },
      { start_utc: "2026-10-24T10:00:00Z", end_utc: "2026-10-24T10:15:00Z" },
    ]);
  });

  it("is atomic: a break the database refuses after the event insert leaves no event and no breaks", async () => {
    const d = draftOf({ breaks: [{ start: "10:00", end: "10:15" }, { start: "11:00", end: "11:15" }] });
    // Bypass validation: a malformed instant fails the breaks table's CHECK on the second break.
    const bad: EventDraft = { ...d, breaks: [d.breaks[0], { ...d.breaks[1], startUtc: "not a time" }] };
    const events = await countRows(t.env.DB, "events");
    const breaks = await countRows(t.env.DB, "breaks");
    const slug = generateSlug();
    await expect(insertEventWithBreaks(t.env.DB, slug, bad)).rejects.toThrow();
    expect(await countRows(t.env.DB, "events")).toBe(events);
    expect(await countRows(t.env.DB, "breaks")).toBe(breaks);
    expect(await t.env.DB.prepare("SELECT 1 FROM events WHERE slug = ?").bind(slug).first()).toBeNull();
  });
});
