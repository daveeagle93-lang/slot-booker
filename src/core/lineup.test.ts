import { describe, expect, it } from "vitest";
import { buildLineup, type LineupInput } from "./lineup";
import { generateSchedule } from "./schedule";

// vitest pins TZ to Pacific/Auckland, so none of these can pass by using the host's time zone.

type Booked = Record<string, [string, string]>;

/** The input the way the event detail has it: the generated schedule with the given bookings (by slot start). */
function input(
  o: { name?: string; postcode?: string; start: string; end: string; session: number; gap?: number; breaks?: { start: string; end: string; label: string }[]; booked?: Booked },
): LineupInput {
  const breaks = o.breaks ?? [];
  const { slots } = generateSchedule({ start: o.start, end: o.end, sessionMinutes: o.session, gapMinutes: o.gap ?? 0, breaks });
  return {
    name: o.name ?? "Spring Trial", venuePostcode: o.postcode ?? "AB1 2CD", startUtc: o.start, breaks,
    slots: slots.map((s) => {
      const b = o.booked?.[s.start];
      return { start: s.start, booking: b ? { dogName: b[0], handlerName: b[1] } : null };
    }),
  };
}

describe("buildLineup", () => {
  it("lays out the example: header, blank line, then slots and breaks in time order", () => {
    // 2026-03-14 is GMT: 09:00 is 09:00Z. 09:00-09:20 in 10-minute slots, lunch 12:00-12:45, then 12:45.
    const text = buildLineup(input({
      start: "2026-03-14T09:00:00Z", end: "2026-03-14T09:20:00Z", session: 10,
      booked: { "2026-03-14T09:00:00Z": ["Rex", "Sam Smith"] },
    }));
    expect(text).toBe("Spring Trial\nSaturday 14 March 2026 · AB1 2CD\n\n09:00 — Rex — Sam Smith\n09:10 — free");

    const full = buildLineup(input({
      start: "2026-03-14T09:00:00Z", end: "2026-03-14T13:30:00Z", session: 10,
      breaks: [{ start: "2026-03-14T09:20:00Z", end: "2026-03-14T12:45:00Z", label: "Lunch" }],
      booked: { "2026-03-14T09:00:00Z": ["Rex", "Sam Smith"], "2026-03-14T12:45:00Z": ["Bella", "Alex Jones"] },
    }));
    expect(full.split("\n").slice(0, 9)).toEqual([
      "Spring Trial", "Saturday 14 March 2026 · AB1 2CD", "",
      "09:00 — Rex — Sam Smith", "09:10 — free", "09:20–12:45 — Lunch", "12:45 — Bella — Alex Jones", "12:55 — free", "13:05 — free",
    ]);
  });

  it("matches the brief's sample exactly", () => {
    const text = buildLineup({
      name: "Spring Trial", venuePostcode: "AB1 2CD", startUtc: "2026-03-14T09:00:00Z",
      slots: [
        { start: "2026-03-14T09:00:00Z", booking: { dogName: "Rex", handlerName: "Sam Smith" } },
        { start: "2026-03-14T09:10:00Z", booking: null },
        { start: "2026-03-14T12:45:00Z", booking: { dogName: "Bella", handlerName: "Alex Jones" } },
      ],
      breaks: [{ start: "2026-03-14T12:00:00Z", end: "2026-03-14T12:45:00Z", label: "Lunch" }],
    });
    expect(text).toBe(
      "Spring Trial\nSaturday 14 March 2026 · AB1 2CD\n\n09:00 — Rex — Sam Smith\n09:10 — free\n12:00–12:45 — Lunch\n12:45 — Bella — Alex Jones",
    );
  });

  it("shows London times on a BST date (2026-06-13: 08:00Z is 09:00)", () => {
    const text = buildLineup(input({ start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:30:00Z", session: 15, booked: { "2026-06-13T08:15:00Z": ["Fly", "Jo"] } }));
    expect(text).toBe("Spring Trial\nSaturday 13 June 2026 · AB1 2CD\n\n09:00 — free\n09:15 — Fly — Jo");
  });

  it("shows a GMT date as it is (2026-12-12: 09:00Z is 09:00)", () => {
    const text = buildLineup(input({ start: "2026-12-12T09:00:00Z", end: "2026-12-12T09:30:00Z", session: 15 }));
    expect(text).toBe("Spring Trial\nSaturday 12 December 2026 · AB1 2CD\n\n09:00 — free\n09:15 — free");
  });

  it("is right across the clocks going forward (2026-03-29: 01:00Z is 02:00 BST)", () => {
    const text = buildLineup(input({
      start: "2026-03-29T00:30:00Z", end: "2026-03-29T02:00:00Z", session: 30,
      breaks: [{ start: "2026-03-29T01:30:00Z", end: "2026-03-29T01:45:00Z", label: "Tea" }],
      booked: { "2026-03-29T00:30:00Z": ["Ann", "A"], "2026-03-29T01:00:00Z": ["Bea", "B"] },
    }));
    expect(text).toBe([
      "Spring Trial", "Sunday 29 March 2026 · AB1 2CD", "",
      "00:30 — Ann — A", "02:00 — Bea — B", "02:30–02:45 — Tea",
    ].join("\n"));
  });

  it("is right across the clocks going back (2026-10-25: 00:30Z is 01:30 BST, 01:00Z is 01:00 GMT)", () => {
    // Starts at 23:30Z on the 24th, which is 00:30 BST on the 25th: the date is the London one.
    const text = buildLineup(input({
      start: "2026-10-24T23:30:00Z", end: "2026-10-25T01:30:00Z", session: 30,
      booked: { "2026-10-25T00:30:00Z": ["Cy", "C"], "2026-10-25T01:00:00Z": ["Di", "D"] },
    }));
    expect(text).toBe([
      "Spring Trial", "Sunday 25 October 2026 · AB1 2CD", "",
      "00:30 — free", "01:00 — free", "01:30 — Cy — C", "01:00 — Di — D",
    ].join("\n"));
  });

  it("prints a break inside the day between the slots around it, using its label", () => {
    const text = buildLineup(input({
      start: "2026-06-13T08:00:00Z", end: "2026-06-13T10:00:00Z", session: 30,
      breaks: [{ start: "2026-06-13T08:30:00Z", end: "2026-06-13T09:00:00Z", label: "Lunch ☕" }],
    }));
    expect(text.split("\n").slice(3)).toEqual(["09:00 — free", "09:30–10:00 — Lunch ☕", "10:00 — free", "10:30 — free"]);
  });

  it("calls an unlabelled break Break", () => {
    const text = buildLineup(input({
      start: "2026-06-13T08:00:00Z", end: "2026-06-13T09:00:00Z", session: 30,
      breaks: [{ start: "2026-06-13T08:30:00Z", end: "2026-06-13T08:45:00Z", label: "" }],
    }));
    expect(text.split("\n").slice(3)).toEqual(["09:00 — free", "09:30–09:45 — Break"]);
  });

  it("puts a break at the very start before the first slot, and at the very end after the last", () => {
    const text = buildLineup(input({
      start: "2026-06-13T08:00:00Z", end: "2026-06-13T09:30:00Z", session: 30,
      breaks: [
        { start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:30:00Z", label: "Setting up" },
        { start: "2026-06-13T09:00:00Z", end: "2026-06-13T09:30:00Z", label: "Packing away" },
      ],
    }));
    expect(text.split("\n").slice(3)).toEqual(["09:00–09:30 — Setting up", "09:30 — free", "10:00–10:30 — Packing away"]);
  });

  it("sorts breaks given out of order and keeps two breaks in a row", () => {
    const text = buildLineup({
      name: "E", venuePostcode: "P", startUtc: "2026-06-13T08:00:00Z", slots: [],
      breaks: [
        { start: "2026-06-13T09:00:00Z", end: "2026-06-13T09:10:00Z", label: "Second" },
        { start: "2026-06-13T08:30:00Z", end: "2026-06-13T09:00:00Z", label: "First" },
      ],
    });
    expect(text.split("\n").slice(3)).toEqual(["09:30–10:00 — First", "10:00–10:10 — Second"]);
  });

  it("lists an all-free event with no stray blank line or space at the end", () => {
    const text = buildLineup(input({ start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:30:00Z", session: 15 }));
    expect(text).toBe("Spring Trial\nSaturday 13 June 2026 · AB1 2CD\n\n09:00 — free\n09:15 — free");
    expect(text.endsWith("\n")).toBe(false);
    expect(text.split("\n").every((l) => l === l.trimEnd())).toBe(true);
  });

  it("lists an all-booked event", () => {
    const text = buildLineup(input({
      start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:30:00Z", session: 15,
      booked: { "2026-06-13T08:00:00Z": ["Rex", "Sam"], "2026-06-13T08:15:00Z": ["Bella", "Alex"] },
    }));
    expect(text).toBe("Spring Trial\nSaturday 13 June 2026 · AB1 2CD\n\n09:00 — Rex — Sam\n09:15 — Bella — Alex");
    expect(text).not.toContain("free");
  });

  it("prints names exactly as stored: unicode, emoji, markup-looking and WhatsApp-formatting characters", () => {
    const text = buildLineup(input({
      name: "*Trial* _day_ ~x~ `y`", start: "2026-06-13T08:00:00Z", end: "2026-06-13T08:45:00Z", session: 15,
      booked: {
        "2026-06-13T08:00:00Z": ["Zoë 🐕‍🦺", "Łukasz Ñandú"],
        "2026-06-13T08:15:00Z": ["*bold* _it_", "<img src=x onerror=alert(1)>"],
        "2026-06-13T08:30:00Z": ["  spaced  ", "A  B"],
      },
    }));
    expect(text.split("\n")).toEqual([
      "*Trial* _day_ ~x~ `y`", "Saturday 13 June 2026 · AB1 2CD", "",
      "09:00 — Zoë 🐕‍🦺 — Łukasz Ñandú", "09:15 — *bold* _it_ — <img src=x onerror=alert(1)>", "09:30 —   spaced   — A  B",
    ]);
  });

  it("uses only the slots it is given: a booking whose slot is not in the schedule never appears", () => {
    const text = buildLineup({
      name: "E", venuePostcode: "P", startUtc: "2026-06-13T08:00:00Z", breaks: [],
      slots: [{ start: "2026-06-13T08:00:00Z", booking: null }],
    });
    expect(text).toBe("E\nSaturday 13 June 2026 · P\n\n09:00 — free");
  });

  it("names every month and weekday", () => {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    months.forEach((m, i) => {
      const iso = `2027-${String(i + 1).padStart(2, "0")}-15T12:00:00Z`;
      expect(buildLineup({ name: "E", venuePostcode: "P", startUtc: iso, slots: [], breaks: [] }).split("\n")[1]).toContain(` 15 ${m} 2027 `);
    });
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    days.forEach((d, i) => {
      const iso = `2026-06-${String(15 + i).padStart(2, "0")}T12:00:00Z`; // 2026-06-15 is a Monday
      expect(buildLineup({ name: "E", venuePostcode: "P", startUtc: iso, slots: [], breaks: [] }).split("\n")[1].startsWith(`${d} `)).toBe(true);
    });
  });
});

describe("buildLineup with a club name", () => {
  const base = { start: "2026-03-14T09:00:00Z", end: "2026-03-14T09:20:00Z", session: 10, booked: { "2026-03-14T09:00:00Z": ["Rex", "Sam Smith"] } as Booked };

  it("puts the club name on the first line, above the event name", () => {
    const plain = buildLineup(input(base));
    expect(buildLineup({ ...input(base), clubName: "Hillside Dog Club" })).toBe(`Hillside Dog Club\n${plain}`);
  });

  it("is unchanged when it is missing or empty", () => {
    const plain = buildLineup(input(base));
    expect(buildLineup({ ...input(base), clubName: "" })).toBe(plain);
    expect(buildLineup({ ...input(base), clubName: undefined })).toBe(plain);
  });

  it("is printed exactly as stored, like event names", () => {
    expect(buildLineup({ ...input(base), clubName: "*Hill* & <Dale>, _Club_" }).split("\n")[0]).toBe("*Hill* & <Dale>, _Club_");
  });

  it("heads a lineup with nothing to list", () => {
    expect(buildLineup({ clubName: "C", name: "E", venuePostcode: "P", startUtc: "2026-06-13T08:00:00Z", slots: [], breaks: [] }))
      .toBe("C\nE\nSaturday 13 June 2026 · P");
  });
});

describe("buildLineup with nothing to list", () => {
  it("ends after the date line, with no trailing blank line", () => {
    expect(buildLineup({ name: "E", venuePostcode: "P", startUtc: "2026-06-13T08:00:00Z", slots: [], breaks: [] })).toBe("E\nSaturday 13 June 2026 · P");
  });
});
