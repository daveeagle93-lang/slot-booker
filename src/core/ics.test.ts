import ICAL from "ical.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildBookingIcs, type BookingIcsInput } from "./ics";

const base: BookingIcsInput = {
  uid: "booking-42@slot-booker",
  dtstamp: "2026-06-01T10:00:00Z",
  slot: { start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:20:00Z" },
  dogName: "Rex",
  handlerName: "Sam Jones",
  eventName: "Trial Day",
  venuePostcode: "SW1A 1AA",
  costPence: 1250,
  details: "Bring water.",
};
const make = (over: Partial<BookingIcsInput> = {}) => buildBookingIcs({ ...base, ...over });
const slotAt = (start: string, end: string) => ({ slot: { start, end } });

const octets = (s: string) => new TextEncoder().encode(s).length;
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function physicalLines(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  return ics.slice(0, -2).split("\r\n");
}

function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const line of physicalLines(ics)) {
    if (line.startsWith(" ")) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function prop(ics: string, name: string): string {
  const lines = unfold(ics);
  // Search the VEVENT only: the VTIMEZONE has its own DTSTART lines.
  const line = lines
    .slice(lines.indexOf("BEGIN:VEVENT"))
    .find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  if (!line) throw new Error(`no ${name} line`);
  return line;
}

function parse(ics: string) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const tz = root.getFirstSubcomponent("vtimezone");
  if (!tz) throw new Error("no VTIMEZONE");
  ICAL.TimezoneService.reset();
  ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  const vevents = root.getAllSubcomponents("vevent");
  expect(vevents).toHaveLength(1);
  return { root, event: new ICAL.Event(vevents[0]) };
}

function expectWellFormed(ics: string): void {
  // Strip every CRLF; any CR or LF left over is a bare line ending.
  expect(ics.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  const stack: string[] = [];
  for (const line of physicalLines(ics)) {
    expect(octets(line)).toBeLessThanOrEqual(75);
    // A split inside a UTF-8 sequence would leave an invalid fragment on one side.
    const bytes = new TextEncoder().encode(line);
    expect(() => strictDecoder.decode(bytes)).not.toThrow();
    const begin = /^BEGIN:(.+)$/.exec(line);
    const end = /^END:(.+)$/.exec(line);
    if (begin) stack.push(begin[1]);
    if (end) expect(stack.pop()).toBe(end[1]);
  }
  expect(stack).toEqual([]);
}

// Raw byte-level check: split the folded output at the octet level and make sure every
// physical line is valid UTF-8 on its own.
function expectLinesDecodeCleanly(ics: string): void {
  const bytes = new TextEncoder().encode(ics);
  let start = 0;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      expect(() => strictDecoder.decode(bytes.subarray(start, i))).not.toThrow();
      start = i + 2;
    }
  }
}

describe("buildBookingIcs structure", () => {
  const ics = make();

  it("uses CRLF throughout and ends with CRLF", () => {
    expectWellFormed(ics);
  });

  it("emits the generic calendar header", () => {
    const lines = physicalLines(ics);
    expect(lines.slice(0, 6)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//slot-booker//Booking//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VTIMEZONE",
    ]);
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  it("defines Europe/London with nested DAYLIGHT and STANDARD", () => {
    const lines = physicalLines(ics);
    const from = lines.indexOf("BEGIN:VTIMEZONE");
    const to = lines.indexOf("END:VTIMEZONE");
    expect(lines.slice(from, to + 1)).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Europe/London",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0100",
      "TZNAME:BST",
      "DTSTART:19700329T010000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0000",
      "TZNAME:GMT",
      "DTSTART:19701025T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("emits one VEVENT with the fixed properties", () => {
    expect(ics.match(/^BEGIN:VEVENT\r$/gm)).toHaveLength(1);
    expect(prop(ics, "UID")).toBe("UID:booking-42@slot-booker");
    expect(prop(ics, "DTSTAMP")).toBe("DTSTAMP:20260601T100000Z");
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Rex – Trial Day");
    expect(prop(ics, "LOCATION")).toBe("LOCATION:SW1A 1AA");
    expect(prop(ics, "STATUS")).toBe("STATUS:CONFIRMED");
    expect(prop(ics, "SEQUENCE")).toBe("SEQUENCE:0");
    expect(prop(ics, "TRANSP")).toBe("TRANSP:OPAQUE");
  });

  it("builds the description with dog, handler, London slot, cost and details", () => {
    expect(prop(ics, "DESCRIPTION")).toBe(
      "DESCRIPTION:Dog: Rex\\nHandler: Sam Jones\\nSlot: 09:00–09:20\\nCost: £12.50\\n\\nBring water.",
    );
  });

  it("omits the blank line and details when details are blank", () => {
    expect(prop(make({ details: " \n\t " }), "DESCRIPTION")).toBe(
      "DESCRIPTION:Dog: Rex\\nHandler: Sam Jones\\nSlot: 09:00–09:20\\nCost: £12.50",
    );
  });

  it("shows free bookings as Free", () => {
    expect(prop(make({ costPence: 0 }), "DESCRIPTION")).toContain("Cost: Free");
  });
});

describe("London wall-clock conversion", () => {
  const starts = (ics: string) => [prop(ics, "DTSTART"), prop(ics, "DTEND")];

  it("keeps UTC in winter", () => {
    expect(starts(make(slotAt("2026-01-17T09:00:00Z", "2026-01-17T09:20:00Z")))).toEqual([
      "DTSTART;TZID=Europe/London:20260117T090000",
      "DTEND;TZID=Europe/London:20260117T092000",
    ]);
  });

  it("adds an hour in summer", () => {
    expect(starts(make(slotAt("2026-06-13T08:00:00Z", "2026-06-13T08:20:00Z")))).toEqual([
      "DTSTART;TZID=Europe/London:20260613T090000",
      "DTEND;TZID=Europe/London:20260613T092000",
    ]);
  });

  it("switches at the spring-forward instant (2026-03-29 01:00Z)", () => {
    expect(prop(make(slotAt("2026-03-29T00:30:00Z", "2026-03-29T00:50:00Z")), "DTSTART")).toBe(
      "DTSTART;TZID=Europe/London:20260329T003000",
    );
    expect(prop(make(slotAt("2026-03-29T01:00:00Z", "2026-03-29T01:20:00Z")), "DTSTART")).toBe(
      "DTSTART;TZID=Europe/London:20260329T020000",
    );
    expect(prop(make(slotAt("2026-03-28T12:00:00Z", "2026-03-28T12:20:00Z")), "DTSTART")).toBe(
      "DTSTART;TZID=Europe/London:20260328T120000",
    );
  });

  it("is BST before and GMT after the autumn change", () => {
    expect(prop(make(slotAt("2026-10-24T09:00:00Z", "2026-10-24T09:20:00Z")), "DTSTART")).toBe(
      "DTSTART;TZID=Europe/London:20261024T100000",
    );
    expect(prop(make(slotAt("2026-10-26T09:00:00Z", "2026-10-26T09:20:00Z")), "DTSTART")).toBe(
      "DTSTART;TZID=Europe/London:20261026T090000",
    );
  });

  it("uses London time in the description slot line", () => {
    const ics = make(slotAt("2026-03-29T01:00:00Z", "2026-03-29T01:20:00Z"));
    expect(prop(ics, "DESCRIPTION")).toContain("Slot: 02:00–02:20");
  });
});

describe("escaping", () => {
  const description = (details: string) =>
    prop(make({ details }), "DESCRIPTION").slice("DESCRIPTION:".length);

  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(description("a\\b;c,d")).toMatch(/a\\\\b\\;c\\,d$/);
    expect(description("x\r\ny\nz\rw")).toMatch(/x\\ny\\nz\\nw$/);
  });

  it("strips other control characters", () => {
    expect(description("a\u0000b\u0007c\u001bd\u007fe")).toMatch(/abcde$/);
  });

  it("escapes SUMMARY and LOCATION too", () => {
    const ics = make({ dogName: "A,B;C", eventName: "x\\y", venuePostcode: "AB1, 2CD" });
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:A\\,B\\;C – x\\\\y");
    expect(prop(ics, "LOCATION")).toBe("LOCATION:AB1\\, 2CD");
  });

  it("does not escape UID", () => {
    expect(prop(make({ uid: "a;b,c@x" }), "UID")).toBe("UID:a;b,c@x");
  });
});

describe("folding", () => {
  const nasty =
    "Line one, with comma; semicolon \\ backslash\r\nSecond line\nThird\rFourth 🐕🐕🐕 " +
    "Zoë ZOË " +
    "long ".repeat(60);

  it("folds long, multi-byte, multi-line input safely", () => {
    const ics = make({ dogName: "Zoë 🐕", handlerName: "Zoë, ZOË", details: nasty });
    expectWellFormed(ics);
    expectLinesDecodeCleanly(ics);
    expect(physicalLines(ics).some((l) => l.startsWith(" "))).toBe(true);
  });

  it("leaves a line of exactly 75 octets unfolded", () => {
    const venuePostcode = "a".repeat(66); // "LOCATION:" is 9 octets
    const ics = make({ venuePostcode });
    const line = physicalLines(ics).find((l) => l.startsWith("LOCATION:"));
    expect(line).toBe(`LOCATION:${venuePostcode}`);
    expect(octets(line!)).toBe(75);
  });

  it("folds one octet past the limit", () => {
    const ics = make({ venuePostcode: "a".repeat(67) });
    const lines = physicalLines(ics);
    const i = lines.findIndex((l) => l.startsWith("LOCATION:"));
    expect(octets(lines[i])).toBe(75);
    expect(lines[i + 1]).toBe(" a");
  });

  it("never splits a multi-byte character across the boundary", () => {
    // 9 + 65 = 74 octets, so a 2-octet "ë" cannot fit and must move to the next line.
    const venuePostcode = "a".repeat(65) + "ë";
    const ics = make({ venuePostcode });
    const lines = physicalLines(ics);
    const i = lines.findIndex((l) => l.startsWith("LOCATION:"));
    expect(octets(lines[i])).toBe(74);
    expect(lines[i + 1]).toBe(" ë");
    expectLinesDecodeCleanly(ics);
  });

  it("fits a 2-octet character that ends exactly at 75", () => {
    const venuePostcode = "a".repeat(64) + "ë";
    const lines = physicalLines(make({ venuePostcode }));
    expect(lines.find((l) => l.startsWith("LOCATION:"))).toBe(`LOCATION:${venuePostcode}`);
  });

  it.each(Array.from({ length: 8 }, (_, n) => 60 + n))(
    "survives emoji at every offset (%i leading octets)",
    (n) => {
      const venuePostcode = "a".repeat(n) + "🐕".repeat(6);
      const ics = make({ venuePostcode });
      expectWellFormed(ics);
      expectLinesDecodeCleanly(ics);
      expect(prop(ics, "LOCATION")).toBe(`LOCATION:${venuePostcode}`);
    },
  );
});

describe("independent parse (ical.js)", () => {
  beforeEach(() => ICAL.TimezoneService.reset());

  const nastyCases: Partial<BookingIcsInput>[] = [
    { dogName: "Zoë", handlerName: "Zoë", eventName: "Fun, games; and \\ more" },
    { dogName: "ZOË 🐕", eventName: "E".repeat(120), venuePostcode: "AB1, 2CD; UK" },
    { uid: "uid-" + "u".repeat(150) + "@slot-booker", venuePostcode: "a".repeat(65) + "ë" },
    { details: "one, two; three \\ four\r\nfive\nsix\r" + "word ".repeat(80) + "🐕" },
  ];

  it.each(nastyCases)("round-trips text properties exactly (%#)", (over) => {
    const input = { ...base, ...over };
    const ics = buildBookingIcs(input);
    const { event } = parse(ics);
    expect(event.uid).toBe(input.uid);
    expect(event.summary).toBe(`${input.dogName} – ${input.eventName}`);
    expect(event.location).toBe(input.venuePostcode);
    const details = input.details.replace(/\r\n|\r/g, "\n").trim();
    expect(event.description).toBe(
      `Dog: ${input.dogName}\nHandler: ${input.handlerName}\nSlot: 09:00–09:20\nCost: £12.50` +
        (details ? `\n\n${details}` : ""),
    );
  });

  it("resolves DTSTART/DTEND to the original instants in winter and summer", () => {
    for (const [start, end] of [
      ["2026-01-17T09:00:00Z", "2026-01-17T09:20:00Z"],
      ["2026-06-13T08:00:00Z", "2026-06-13T08:20:00Z"],
      ["2026-03-29T01:00:00Z", "2026-03-29T01:20:00Z"],
      ["2026-10-26T09:00:00Z", "2026-10-26T09:20:00Z"],
    ]) {
      const { event } = parse(make(slotAt(start, end)));
      expect(event.startDate.toJSDate().toISOString()).toBe(start.replace("Z", ".000Z"));
      expect(event.endDate.toJSDate().toISOString()).toBe(end.replace("Z", ".000Z"));
    }
  });

  it("parses the calendar-level properties", () => {
    const { root } = parse(make());
    expect(root.getFirstPropertyValue("version")).toBe("2.0");
    expect(root.getFirstPropertyValue("method")).toBe("PUBLISH");
    expect(root.getFirstPropertyValue("prodid")).toBe("-//slot-booker//Booking//EN");
  });
});

describe("snapshot", () => {
  it("matches the canonical booking", async () => {
    const ics = buildBookingIcs({
      uid: "booking-42@slot-booker",
      dtstamp: "2026-06-01T10:00:00Z",
      slot: { start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:20:00Z" },
      dogName: "Zoë",
      handlerName: "Sam Jones",
      eventName: "Saturday Trial Day",
      venuePostcode: "SW1A 1AA",
      costPence: 1250,
      details:
        "Arrive 10 minutes early, please.\nBring water, a lead; and a towel. " +
        "Parking is limited so please share lifts where you can manage it.",
    });
    await expect(ics).toMatchFileSnapshot("./__snapshots__/booking.ics");
  });
});

describe("validation", () => {
  it.each(["2026-06-13", "2026-06-13T08:00:00.000Z", "2026-02-30T08:00:00Z", "nonsense"])(
    "rejects bad slot start %s",
    (start) => {
      expect(() => make(slotAt(start, "2026-06-13T09:00:00Z"))).toThrow(RangeError);
    },
  );

  it("rejects a bad slot end", () => {
    expect(() => make(slotAt("2026-06-13T08:00:00Z", "2026-06-13T24:00:00Z"))).toThrow(RangeError);
  });

  it("rejects a bad dtstamp", () => {
    expect(() => make({ dtstamp: "2026-06-01 10:00:00" })).toThrow(RangeError);
  });

  it("rejects end equal to or before start", () => {
    expect(() => make(slotAt("2026-06-13T08:00:00Z", "2026-06-13T08:00:00Z"))).toThrow(RangeError);
    expect(() => make(slotAt("2026-06-13T08:00:00Z", "2026-06-13T07:00:00Z"))).toThrow(RangeError);
  });

  it.each(["", "a\nb", "a\rb", "a\r\nb"])("rejects uid %j", (uid) => {
    expect(() => make({ uid })).toThrow(RangeError);
  });

  it("rejects an invalid cost", () => {
    expect(() => make({ costPence: -1 })).toThrow(RangeError);
  });
});
