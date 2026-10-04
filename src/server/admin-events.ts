import { londonToUtc, LondonTimeError, utcToLondon } from "../core/london";
import { DEFAULT_NEAR_MISS_MINUTES, generateSchedule, type TimeRange } from "../core/schedule";
import { generateSlug } from "../core/slug";
import { IDEMPOTENCY_KEY, INVISIBLE, noStore, readJsonObject } from "./bookings";
import { bookingWindow, type EventRow } from "./events";
import { errorResponse } from "./http";

const MAX_NAME_CODE_POINTS = 100;
const MAX_LABEL_CODE_POINTS = 40;
const MAX_DETAILS_CODE_POINTS = 2000;
const MAX_BREAKS = 20;
const MAX_SLOTS = 500;
const MAX_DAYS_AHEAD = 730;
const MAX_LIST = 100;
const MAX_BODY_BYTES = 32_768;
// Any date works to check that a time is well formed; this one is not near a clock change.
const PROBE_DATE = "2026-01-15";

export interface EventDraft {
  name: string;
  /** London local: YYYY-MM-DD and HH:MM. */
  date: string; start: string; end: string;
  sessionMinutes: number; gapMinutes: number; costPence: number;
  venuePostcode: string; details: string;
  startUtc: string; endUtc: string;
  breaks: { start: string; end: string; label: string; startUtc: string; endUtc: string }[];
}

type Fields = Record<string, string>;

const BAD_TIME = "Enter a time as HH:MM.";
const CLOCK_MESSAGE = {
  invalid: BAD_TIME,
  nonexistent: "That time doesn't exist in London on that date (the clocks go forward).",
  ambiguous: "That time happens twice in London on that date (the clocks go back).",
};

function londonTime(date: string, value: unknown): { utc: string } | { message: string } {
  if (typeof value !== "string") return { message: BAD_TIME };
  try {
    return { utc: londonToUtc(date, value) };
  } catch (e) {
    if (!(e instanceof LondonTimeError)) throw e;
    return { message: CLOCK_MESSAGE[e.kind] };
  }
}

function checkName(value: unknown): { name: string } | { message: string } {
  if (typeof value !== "string") return { message: "Enter the event name." };
  if (!value.isWellFormed()) return { message: "The event name can't contain unpaired surrogate characters." };
  if (INVISIBLE.test(value)) return { message: "The event name can't contain invisible or direction-changing characters." };
  const name = value.trim();
  if (name === "") return { message: "Enter the event name." };
  if ([...name].length > MAX_NAME_CODE_POINTS) return { message: `The event name must be at most ${MAX_NAME_CODE_POINTS} characters.` };
  if (/\p{Cc}/u.test(name)) return { message: "The event name can't contain control characters." };
  return { name };
}

/** A break's optional name: missing, undefined or null means unnamed (""). */
function checkLabel(value: unknown): { label: string } | { message: string } {
  if (value === undefined || value === null) return { label: "" };
  if (typeof value !== "string") return { message: "The break name must be text." };
  if (!value.isWellFormed()) return { message: "The break name can't contain unpaired surrogate characters." };
  if (INVISIBLE.test(value)) return { message: "The break name can't contain invisible or direction-changing characters." };
  const label = value.trim();
  if ([...label].length > MAX_LABEL_CODE_POINTS) return { message: `The break name must be at most ${MAX_LABEL_CODE_POINTS} characters.` };
  if (/\p{Cc}/u.test(label)) return { message: "The break name can't contain control characters." };
  return { label };
}

/**
 * Lenient on purpose: this is not UK postcode validation, so the app can be reused for venues in other
 * countries. It only keeps the value short, printable and tidy (trimmed, one space, upper case).
 */
function checkPostcode(value: unknown): { postcode: string } | { message: string } {
  const tidy = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!/^[A-Za-z0-9 ]{2,10}$/.test(tidy)) return { message: "Enter a venue postcode of 2 to 10 letters and numbers." };
  return { postcode: tidy.toUpperCase() };
}

function checkDetails(value: unknown): { details: string } | { message: string } {
  if (typeof value !== "string") return { message: "Details must be text (they can be empty)." };
  if (!value.isWellFormed()) return { message: "The details can't contain unpaired surrogate characters." };
  if (INVISIBLE.test(value)) return { message: "The details can't contain invisible or direction-changing characters." };
  const details = value.replaceAll("\r\n", "\n");
  if (/(?!\n)\p{Cc}/u.test(details)) return { message: "The details can't contain control characters." };
  if ([...details].length > MAX_DETAILS_CODE_POINTS) return { message: `The details must be at most ${MAX_DETAILS_CODE_POINTS} characters.` };
  return { details };
}

const checkInteger = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function parseEventDraft(
  raw: Record<string, unknown>, opts: { now: Date; requireFuture: boolean },
): { draft: EventDraft } | { fields: Fields } {
  const fields: Fields = {};

  const name = checkName(raw.name);
  if ("message" in name) fields.name = name.message;

  const dateText = typeof raw.date === "string" ? raw.date : "";
  const dateOk = !("message" in londonTime(dateText, "12:00"));
  if (!dateOk) fields.date = "Enter a real date.";
  // With no usable date the times are still checked for shape, against a date with no clock change.
  const base = dateOk ? dateText : PROBE_DATE;

  const start = londonTime(base, raw.start);
  const end = londonTime(base, raw.end);
  if ("message" in start) fields.start = start.message;
  if ("message" in end) fields.end = end.message;
  const startUtc = "utc" in start ? start.utc : null;
  const endUtc = "utc" in end ? end.utc : null;
  if (startUtc && endUtc && endUtc <= startUtc) fields.end = "The end must be after the start.";
  if (dateOk && startUtc && opts.requireFuture) {
    const ahead = Date.parse(startUtc) - opts.now.getTime();
    if (ahead <= 0) fields.date = "The event must start in the future.";
    else if (ahead > MAX_DAYS_AHEAD * 86_400_000) fields.date = "That date is more than two years away. Check it.";
  }

  const sessionMinutes = checkInteger(raw.sessionMinutes, 1, 480);
  if (sessionMinutes === null) fields.sessionMinutes = "Enter a whole number of minutes from 1 to 480.";
  const gapMinutes = checkInteger(raw.gapMinutes, 0, 120);
  if (gapMinutes === null) fields.gapMinutes = "Enter a whole number of minutes from 0 to 120.";
  const costPence = checkInteger(raw.costPence, 0, 100_000);
  if (costPence === null) fields.costPence = "Enter the cost in pence as a whole number from 0 to 100000.";
  const postcode = checkPostcode(raw.venuePostcode);
  if ("message" in postcode) fields.venuePostcode = postcode.message;
  const details = checkDetails(raw.details);
  if ("message" in details) fields.details = details.message;

  const breaks: EventDraft["breaks"] = [];
  if (!Array.isArray(raw.breaks)) fields.breaks = "Breaks must be a list.";
  else if (raw.breaks.length > MAX_BREAKS) fields.breaks = `You can add at most ${MAX_BREAKS} breaks.`;
  else {
    raw.breaks.forEach((item, i) => {
      const b = asRecord(item);
      if (!b) {
        fields[`breaks.${i}`] = "Each break needs a start and an end.";
        return;
      }
      const label = checkLabel(b.label);
      if ("message" in label) fields[`breaks.${i}.label`] = label.message;
      const s = londonTime(base, b.start);
      const e = londonTime(base, b.end);
      if ("message" in s) fields[`breaks.${i}.start`] = s.message;
      if ("message" in e) fields[`breaks.${i}.end`] = e.message;
      if (!("utc" in s) || !("utc" in e) || !("label" in label)) return;
      if (e.utc <= s.utc) fields[`breaks.${i}.end`] = "The break must end after it starts.";
      else if (startUtc && s.utc < startUtc) fields[`breaks.${i}.start`] = "The break must start within the event.";
      else if (endUtc && e.utc > endUtc) fields[`breaks.${i}.end`] = "The break must end within the event.";
      breaks.push({ start: b.start as string, end: b.end as string, label: label.label, startUtc: s.utc, endUtc: e.utc });
    });
  }

  if (Object.keys(fields).length > 0) return { fields };
  const draft: EventDraft = {
    name: (name as { name: string }).name, date: dateText, start: raw.start as string, end: raw.end as string,
    sessionMinutes: sessionMinutes!, gapMinutes: gapMinutes!, costPence: costPence!,
    venuePostcode: (postcode as { postcode: string }).postcode, details: (details as { details: string }).details,
    startUtc: startUtc!, endUtc: endUtc!, breaks,
  };
  const slotCount = previewSchedule(draft).slots.length;
  if (slotCount === 0) return { fields: { end: "No sessions fit between the start and end." } };
  if (slotCount > MAX_SLOTS) return { fields: { sessionMinutes: `That would make more than ${MAX_SLOTS} slots.` } };
  return { draft };
}

export const readEventBody = (request: Request): Promise<Record<string, unknown> | Response> =>
  readJsonObject(request, MAX_BODY_BYTES);

export const invalidInput = (fields: Fields): Response =>
  errorResponse(400, "invalid_input", "Check the highlighted fields.", { fields }, noStore);

/** Reads and validates a draft from the request body, or returns the error response to send. */
export async function readEventDraft(request: Request, requireFuture: boolean): Promise<EventDraft | Response> {
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  const parsed = parseEventDraft(body, { now: new Date(), requireFuture });
  if ("fields" in parsed) return invalidInput(parsed.fields);
  return parsed.draft;
}

/** The create request's idempotency key, or the field error to report. */
export const checkEventKey = (value: unknown): { key: string } | { message: string } =>
  typeof value === "string" && IDEMPOTENCY_KEY.test(value) ? { key: value } : { message: "Reload the page and try again." };

export interface PreviewSuggestion {
  /** Index in the draft's breaks of the break this is about. */
  breakIndex: number;
  droppedSlot: TimeRange;
  overrunMinutes: number;
  suggestedBreak: TimeRange;
  /** The suggested break as London HH:MM, ready for the form inputs. */
  suggestedLocal: { start: string; end: string };
  /** The break's name ("" if unnamed), for the suggestion's wording. */
  breakLabel: string;
}

export function previewSchedule(draft: EventDraft): { slots: TimeRange[]; suggestions: PreviewSuggestion[] } {
  const { slots, suggestions } = generateSchedule({
    start: draft.startUtc, end: draft.endUtc, sessionMinutes: draft.sessionMinutes, gapMinutes: draft.gapMinutes,
    breaks: draft.breaks.map((b) => ({ start: b.startUtc, end: b.endUtc })),
    nearMissMinutes: DEFAULT_NEAR_MISS_MINUTES,
  });
  const usable: PreviewSuggestion[] = [];
  for (const s of suggestions) {
    const breakIndex = draft.breaks.findIndex((b) => b.startUtc === s.break.start && b.endUtc === s.break.end);
    const suggestedLocal = {
      start: utcToLondon(s.suggestedBreak.start).time, end: utcToLondon(s.suggestedBreak.end).time,
    };
    // The form takes London times on the event's date: leave out a suggestion those can't express
    // (a time in the hour the clocks repeat, or one on another day).
    try {
      if (londonToUtc(draft.date, suggestedLocal.start) !== s.suggestedBreak.start
        || londonToUtc(draft.date, suggestedLocal.end) !== s.suggestedBreak.end) continue;
    } catch (e) {
      if (e instanceof RangeError) continue;
      throw e;
    }
    if (breakIndex === -1) continue;
    usable.push({
      breakIndex, droppedSlot: s.droppedSlot, overrunMinutes: s.overrunMinutes,
      suggestedBreak: s.suggestedBreak, suggestedLocal, breakLabel: draft.breaks[breakIndex].label,
    });
  }
  return { slots, suggestions: usable };
}

/** An event as stored, with the breaks as stored: all that create answers with and compares. */
export interface SavedEvent {
  slug: string; name: string; startUtc: string; endUtc: string; sessionMinutes: number; gapMinutes: number;
  costPence: number; venuePostcode: string; details: string;
  breaks: { startUtc: string; endUtc: string; label: string }[];
}

export interface CreateEventResult { kind: "created" | "replayed" | "idempotency_key_reuse"; saved: SavedEvent }

/** The create response body: the same for a first create, a replay and the original shown on a reuse. */
export const createdBody = (e: SavedEvent) => ({
  event: {
    slug: e.slug, name: e.name, startUtc: e.startUtc, endUtc: e.endUtc, sessionMinutes: e.sessionMinutes,
    gapMinutes: e.gapMinutes, costPence: e.costPence, venuePostcode: e.venuePostcode, details: e.details,
  },
  path: `/e/${e.slug}`,
  slotCount: generateSchedule({
    start: e.startUtc, end: e.endUtc, sessionMinutes: e.sessionMinutes, gapMinutes: e.gapMinutes,
    breaks: e.breaks.map((b) => ({ start: b.startUtc, end: b.endUtc })),
  }).slots.length,
});

const breakKey = (b: { startUtc: string; endUtc: string; label: string }): string => JSON.stringify([b.startUtc, b.endUtc, b.label]);

/** The same event, breaks compared as a set so their order doesn't matter. */
function sameEvent(saved: SavedEvent, d: EventDraft): boolean {
  const mine = d.breaks.map(breakKey).sort();
  const theirs = saved.breaks.map(breakKey).sort();
  return saved.name === d.name && saved.startUtc === d.startUtc && saved.endUtc === d.endUtc
    && saved.sessionMinutes === d.sessionMinutes && saved.gapMinutes === d.gapMinutes && saved.costPence === d.costPence
    && saved.venuePostcode === d.venuePostcode && saved.details === d.details
    && mine.length === theirs.length && mine.every((k, i) => k === theirs[i]);
}

/**
 * What the idempotency key says: a replay if an event saved under it matches the draft, a reuse (carrying
 * the saved event as stored, never the draft) if it differs, or null if no event holds the key. One batch,
 * so the event and its breaks come from the same moment.
 */
export async function findEventByKey(
  db: D1Database, key: string, d: EventDraft,
): Promise<{ kind: "replayed" | "idempotency_key_reuse"; saved: SavedEvent } | null> {
  const [events, breaks] = await db.batch([
    db.prepare(
      `SELECT slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details
       FROM events WHERE idempotency_key = ?`,
    ).bind(key),
    db.prepare(
      `SELECT start_utc, end_utc, label FROM breaks
       WHERE event_id = (SELECT id FROM events WHERE idempotency_key = ?) ORDER BY start_utc, end_utc, label`,
    ).bind(key),
  ]);
  const e = (events.results as {
    slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number; gap_minutes: number;
    cost_pence: number; venue_postcode: string; details: string;
  }[])[0];
  if (!e) return null;
  const saved: SavedEvent = {
    slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc, sessionMinutes: e.session_minutes,
    gapMinutes: e.gap_minutes, costPence: e.cost_pence, venuePostcode: e.venue_postcode, details: e.details,
    breaks: (breaks.results as { start_utc: string; end_utc: string; label: string }[])
      .map((b) => ({ startUtc: b.start_utc, endUtc: b.end_utc, label: b.label })),
  };
  return { kind: sameEvent(saved, d) ? "replayed" : "idempotency_key_reuse", saved };
}

/**
 * Creates the event unless the key already holds one. The key is looked up first, then the insert is
 * tried, and if it fails on a UNIQUE constraint the key is looked up again: a simultaneous request with
 * the same key may have won, and the unique index decides. If the key still holds nothing, the failure
 * was something else (a slug clash) and is rethrown.
 */
export async function createEvent(db: D1Database, d: EventDraft, key: string): Promise<CreateEventResult> {
  const prior = await findEventByKey(db, key, d);
  if (prior) return prior;
  const slug = generateSlug();
  try {
    await insertEventWithBreaks(db, slug, d, key);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("UNIQUE constraint failed")) throw e;
    const won = await findEventByKey(db, key, d);
    if (won) return won;
    throw e;
  }
  return { kind: "created", saved: { ...d, slug } };
}

/**
 * Inserts the event and all its breaks in one batch, so either all of it is stored or none.
 * Assumes a validated draft; the table CHECK constraints are the last line of defence.
 */
export async function insertEventWithBreaks(db: D1Database, slug: string, d: EventDraft, idempotencyKey: string): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, d.name, d.startUtc, d.endUtc, d.sessionMinutes, d.gapMinutes, d.costPence, d.venuePostcode, d.details, idempotencyKey),
    ...d.breaks.map((b) =>
      db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES ((SELECT id FROM events WHERE slug = ?), ?, ?, ?)")
        .bind(slug, b.startUtc, b.endUtc, b.label)),
  ]);
}

interface ListedEvent { id: number; slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number; gap_minutes: number; cost_pence: number; venue_postcode: string }

/**
 * Upcoming (not yet finished), non-archived events, soonest first, at most 100. Three queries in all:
 * the events, all their breaks, and booking counts grouped by event.
 */
export async function listUpcomingEvents(db: D1Database, now: Date, cutoffOffsetMinutes: number) {
  const nowIso = `${now.toISOString().slice(0, 19)}Z`;
  const upcoming = `SELECT id FROM events WHERE archived = 0 AND end_utc > ?1 ORDER BY start_utc, id LIMIT ${MAX_LIST}`;
  const [events, breaks, counts] = await db.batch([
    db.prepare(
      `SELECT id, slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode
       FROM events WHERE id IN (${upcoming}) ORDER BY start_utc, id`,
    ).bind(nowIso),
    db.prepare(`SELECT event_id, start_utc, end_utc, label FROM breaks WHERE event_id IN (${upcoming})`).bind(nowIso),
    db.prepare(`SELECT event_id, COUNT(*) AS n FROM bookings WHERE event_id IN (${upcoming}) GROUP BY event_id`).bind(nowIso),
  ]);
  const breaksOf = new Map<number, EventRow["breaks"]>();
  for (const b of (breaks.results as { event_id: number; start_utc: string; end_utc: string; label: string }[])) {
    breaksOf.set(b.event_id, [...(breaksOf.get(b.event_id) ?? []), { start: b.start_utc, end: b.end_utc, label: b.label }]);
  }
  const bookedOf = new Map((counts.results as { event_id: number; n: number }[]).map((r) => [r.event_id, r.n]));
  return (events.results as unknown as ListedEvent[]).map((e) => {
    const row = {
      id: e.id, slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
      sessionMinutes: e.session_minutes, gapMinutes: e.gap_minutes, costPence: e.cost_pence,
      venuePostcode: e.venue_postcode, details: "", archived: false, breaks: breaksOf.get(e.id) ?? [],
    } satisfies EventRow;
    return {
      slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc, costPence: e.cost_pence,
      venuePostcode: e.venue_postcode,
      slotCount: generateSchedule({
        start: row.startUtc, end: row.endUtc, sessionMinutes: row.sessionMinutes, gapMinutes: row.gapMinutes, breaks: row.breaks,
      }).slots.length,
      bookedCount: bookedOf.get(e.id) ?? 0,
      bookings: bookingWindow(row, cutoffOffsetMinutes, now),
      path: `/e/${e.slug}`,
    };
  });
}
