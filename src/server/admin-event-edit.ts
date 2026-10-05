import { buildLineup } from "../core/lineup";
import { utcToLondon } from "../core/london";
import { generateSchedule, type TimeRange } from "../core/schedule";
import { previewSchedule, type EventDraft } from "./admin-events";
import { noStore } from "./bookings";
import { guard, isGuardFailure } from "./db-guard";
import type { EventRow } from "./events";
import { errorResponse } from "./http";
import { loadSettings } from "./settings";

export type EditResult =
  | { kind: "saved"; event: EventRow; slotCount: number; removed: BookingRef[] }
  | { kind: "bookings_affected"; affected: BookingRef[] }
  | { kind: "not_found" };

export const eventNotFound = (): Response => errorResponse(404, "not_found", "Event not found", {}, noStore);

export const editFailed = (what: string, e: unknown): Response => {
  console.error(`${what} failed:`, e instanceof Error ? e.message : String(e));
  return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
};

/** A booking as the edit screens list it. `slotStart` is a UTC instant; the slot's end isn't needed. */
export interface BookingRef { id: number; slotStart: string; dogName: string; handlerName: string }

/** The event as the edit form uses it: London-local date and times next to the stored UTC instants. */
export const eventView = (e: EventRow) => ({
  slug: e.slug, name: e.name, archived: e.archived, listed: e.listed,
  date: utcToLondon(e.startUtc).date, start: utcToLondon(e.startUtc).time, end: utcToLondon(e.endUtc).time,
  sessionMinutes: e.sessionMinutes, gapMinutes: e.gapMinutes, costPence: e.costPence,
  venuePostcode: e.venuePostcode, details: e.details,
  startUtc: e.startUtc, endUtc: e.endUtc,
  breaks: [...e.breaks].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
    .map((b) => ({ start: utcToLondon(b.start).time, end: utcToLondon(b.end).time, label: b.label, startUtc: b.start, endUtc: b.end })),
});

/** Every booking of the event, in slot order: one query. */
export async function loadBookings(db: D1Database, eventId: number): Promise<BookingRef[]> {
  const { results } = await db
    .prepare("SELECT id, slot_start_utc, dog_name, handler_name FROM bookings WHERE event_id = ? ORDER BY slot_start_utc, id")
    .bind(eventId)
    .all<{ id: number; slot_start_utc: string; dog_name: string; handler_name: string }>();
  return results.map((r) => ({ id: r.id, slotStart: r.slot_start_utc, dogName: r.dog_name, handlerName: r.handler_name }));
}

/** The bookings whose slot is not among these slots: what a schedule change would orphan. */
export const bookingsOutside = (bookings: BookingRef[], slots: TimeRange[]): BookingRef[] => {
  const starts = new Set(slots.map((s) => s.start));
  return bookings.filter((b) => !starts.has(b.slotStart));
};

/**
 * The saved schedule with each slot's booking, and any booking whose slot is not in it (there should be none).
 * `lineup` is the WhatsApp text for the schedule page's Copy button, built here so the page can copy it
 * synchronously from what it already loaded (a clipboard write has to happen inside the click).
 */
export async function eventDetail(db: D1Database, event: EventRow) {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc, sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const [bookings, { clubName }] = await Promise.all([loadBookings(db, event.id), loadSettings(db)]);
  const bySlot = new Map(bookings.map((b) => [b.slotStart, b]));
  const withBookings = slots.map((s) => {
    const b = bySlot.get(s.start);
    return { ...s, booking: b ? { id: b.id, dogName: b.dogName, handlerName: b.handlerName } : null };
  });
  return {
    event: eventView(event),
    slots: withBookings,
    orphans: bookingsOutside(bookings, slots),
    lineup: buildLineup({ clubName, name: event.name, venuePostcode: event.venuePostcode, startUtc: event.startUtc, slots: withBookings, breaks: event.breaks }),
  };
}

const MAX_REMOVE_IDS = 500;

/** The save request's optional `removeBookingIds` (missing means none), or the field error to report. */
export function checkRemoveIds(value: unknown): { ids: number[] } | { message: string } {
  if (value === undefined) return { ids: [] };
  const ok = Array.isArray(value) && value.length <= MAX_REMOVE_IDS
    && value.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0);
  return ok ? { ids: value as number[] } : { message: `Send at most ${MAX_REMOVE_IDS} booking ids, each a positive whole number.` };
}

/** Test seam: runs after the bookings were read and before the batch, where a real booking could land. */
export interface SaveHooks { afterRead?: () => Promise<void> }

/**
 * Saves the draft over the event, removing the bookings the admin confirmed.
 *
 * The bookings that would lose their slot are worked out from a read; if any of them was not confirmed,
 * nothing is changed and they are returned. Otherwise one batch updates the event, replaces its breaks and
 * deletes exactly those bookings. Its first statement is a guard that fails the whole batch if any booking
 * now sits on a slot the new schedule lacks without being one of those: a booking made after the read
 * (the batch writes nothing then, and the fresh list is returned). A second guard fails the batch if the event
 * was deleted after the read (not_found, nothing written). Event fields are last write wins.
 */
export async function saveEventEdit(
  db: D1Database, event: EventRow, draft: EventDraft, confirmedIds: number[], hooks: SaveHooks = {},
): Promise<EditResult> {
  const { slots } = previewSchedule(draft);
  const affected = bookingsOutside(await loadBookings(db, event.id), slots);
  const confirmed = new Set(confirmedIds);
  if (affected.some((b) => !confirmed.has(b.id))) return { kind: "bookings_affected", affected };
  await hooks.afterRead?.();

  // A request without `listed` leaves it as it is in the database now (COALESCE with null), not as it was when the event was loaded.
  const listed = draft.listed ?? event.listed;
  const starts = JSON.stringify(slots.map((s) => s.start));
  const ids = JSON.stringify(affected.map((b) => b.id));
  const outside = "slot_start_utc NOT IN (SELECT value FROM json_each(?))";
  try {
    const results = await db.batch([
      guard(db, "EXISTS (SELECT 1 FROM events WHERE id = ?)", event.id),
      guard(
        db,
        `NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ? AND ${outside} AND id NOT IN (SELECT value FROM json_each(?)))`,
        event.id, starts, ids,
      ),
      db.prepare(
        `UPDATE events SET name = ?, start_utc = ?, end_utc = ?, session_minutes = ?, gap_minutes = ?, cost_pence = ?,
           venue_postcode = ?, details = ?, listed = COALESCE(?, listed) WHERE id = ?`,
      ).bind(draft.name, draft.startUtc, draft.endUtc, draft.sessionMinutes, draft.gapMinutes, draft.costPence,
        draft.venuePostcode, draft.details, draft.listed === undefined ? null : draft.listed ? 1 : 0, event.id),
      db.prepare("DELETE FROM breaks WHERE event_id = ?").bind(event.id),
      ...draft.breaks.map((b) =>
        db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (?, ?, ?, ?)").bind(event.id, b.startUtc, b.endUtc, b.label)),
      db.prepare(
        `DELETE FROM bookings WHERE event_id = ? AND ${outside} AND id IN (SELECT value FROM json_each(?))
         RETURNING id, slot_start_utc, dog_name, handler_name`,
      ).bind(event.id, starts, ids),
    ]);
    const deleted = results[results.length - 1].results as { id: number; slot_start_utc: string; dog_name: string; handler_name: string }[];
    return {
      kind: "saved", slotCount: slots.length,
      event: {
        ...event, name: draft.name, startUtc: draft.startUtc, endUtc: draft.endUtc, sessionMinutes: draft.sessionMinutes,
        gapMinutes: draft.gapMinutes, costPence: draft.costPence, venuePostcode: draft.venuePostcode, details: draft.details, listed,
        breaks: draft.breaks.map((b) => ({ start: b.startUtc, end: b.endUtc, label: b.label })),
      },
      removed: deleted.map((r) => ({ id: r.id, slotStart: r.slot_start_utc, dogName: r.dog_name, handlerName: r.handler_name }))
        .sort((a, b) => (a.slotStart < b.slotStart ? -1 : a.slotStart > b.slotStart ? 1 : a.id - b.id)),
    };
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    if (!(await db.prepare("SELECT 1 AS n FROM events WHERE id = ?").bind(event.id).first())) return { kind: "not_found" };
    return { kind: "bookings_affected", affected: bookingsOutside(await loadBookings(db, event.id), slots) };
  }
}
