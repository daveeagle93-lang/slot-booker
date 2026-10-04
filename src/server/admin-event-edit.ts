import { utcToLondon } from "../core/london";
import { generateSchedule, type TimeRange } from "../core/schedule";
import { noStore } from "./bookings";
import type { EventRow } from "./events";
import { errorResponse } from "./http";

export const eventNotFound = (): Response => errorResponse(404, "not_found", "Event not found", {}, noStore);

export const editFailed = (what: string, e: unknown): Response => {
  console.error(`${what} failed:`, e instanceof Error ? e.message : String(e));
  return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
};

/** A booking as the edit screens list it. `slotStart` is a UTC instant; the slot's end isn't needed. */
export interface BookingRef { id: number; slotStart: string; dogName: string; handlerName: string }

/** The event as the edit form uses it: London-local date and times next to the stored UTC instants. */
export const eventView = (e: EventRow) => ({
  slug: e.slug, name: e.name, archived: e.archived,
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

/** The saved schedule with each slot's booking, and any booking whose slot is not in it (there should be none). */
export async function eventDetail(db: D1Database, event: EventRow) {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc, sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const bookings = await loadBookings(db, event.id);
  const bySlot = new Map(bookings.map((b) => [b.slotStart, b]));
  return {
    event: eventView(event),
    slots: slots.map((s) => {
      const b = bySlot.get(s.start);
      return { ...s, booking: b ? { id: b.id, dogName: b.dogName, handlerName: b.handlerName } : null };
    }),
    orphans: bookingsOutside(bookings, slots),
  };
}
