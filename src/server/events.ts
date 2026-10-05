import { generateSchedule, type TimeRange } from "../core/schedule";
import { isValidSlug } from "../core/slug";

export interface EventRow {
  id: number;
  slug: string;
  name: string;
  startUtc: string;
  endUtc: string;
  sessionMinutes: number;
  gapMinutes: number;
  costPence: number;
  venuePostcode: string;
  details: string;
  archived: boolean;
  /** Whether the landing page lists it. Unlisted events are still bookable by their link. */
  listed: boolean;
  breaks: (TimeRange & { label: string })[];
}

export interface SlotView extends TimeRange { status: "free" | "taken" | "past" }

interface RawEvent {
  id: number; slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number;
  gap_minutes: number; cost_pence: number; venue_postcode: string; details: string; archived: number; listed: number;
}

export async function loadEventBySlug(db: D1Database, slug: string): Promise<EventRow | null> {
  if (!isValidSlug(slug)) return null;
  const e = await db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first<RawEvent>();
  if (!e) return null;
  const { results } = await db
    .prepare("SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ? ORDER BY start_utc")
    .bind(e.id)
    .all<{ start_utc: string; end_utc: string; label: string }>();
  return {
    id: e.id, slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
    sessionMinutes: e.session_minutes, gapMinutes: e.gap_minutes, costPence: e.cost_pence,
    venuePostcode: e.venue_postcode, details: e.details, archived: e.archived === 1, listed: e.listed === 1,
    breaks: results.map((b) => ({ start: b.start_utc, end: b.end_utc, label: b.label })),
  };
}

/** The public face of an event: no ids, no breaks. */
export const eventSummary = (e: EventRow) => ({
  slug: e.slug, name: e.name, startUtc: e.startUtc, endUtc: e.endUtc,
  costPence: e.costPence, venuePostcode: e.venuePostcode, details: e.details, archived: e.archived,
});

/**
 * Bookings close at the event's start plus the offset (minutes, may be negative); a request at
 * exactly that instant is too late. `now` is passed in so callers and tests control the clock.
 */
export function bookingWindow(e: EventRow, offsetMinutes: number, now: Date): { open: boolean; closesAt: string } {
  const closesAt = new Date(Date.parse(e.startUtc) + offsetMinutes * 60_000);
  return { open: !e.archived && now.getTime() < closesAt.getTime(), closesAt: closesAt.toISOString().replace(".000Z", "Z") };
}

/**
 * The public rule for one slot: the booking window is open and the slot has not started (a request at
 * exactly its start is too late). Admin booking does not call this.
 */
export const isSlotBookable = (slotStart: string, window: { open: boolean }, now: Date): boolean =>
  window.open && Date.parse(slotStart) > now.getTime();

/**
 * Bookings whose slot is not in the current schedule are ignored. A slot that has started is "past"
 * unless it is booked, which wins: the page shows it as unavailable either way.
 */
export async function computeSlotViews(db: D1Database, event: EventRow, now: Date): Promise<SlotView[]> {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc,
    sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const { results } = await db
    .prepare("SELECT slot_start_utc FROM bookings WHERE event_id = ?")
    .bind(event.id)
    .all<{ slot_start_utc: string }>();
  const taken = new Set(results.map((r) => r.slot_start_utc));
  return slots.map((s) => ({
    ...s, status: taken.has(s.start) ? "taken" : isSlotBookable(s.start, { open: true }, now) ? "free" : "past",
  }));
}
