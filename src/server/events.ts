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
  breaks: TimeRange[];
}

export interface SlotView extends TimeRange { status: "free" | "taken" }

interface RawEvent {
  id: number; slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number;
  gap_minutes: number; cost_pence: number; venue_postcode: string; details: string; archived: number;
}

export async function loadEventBySlug(db: D1Database, slug: string): Promise<EventRow | null> {
  if (!isValidSlug(slug)) return null;
  const e = await db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug).first<RawEvent>();
  if (!e) return null;
  const { results } = await db
    .prepare("SELECT start_utc, end_utc FROM breaks WHERE event_id = ? ORDER BY start_utc")
    .bind(e.id)
    .all<{ start_utc: string; end_utc: string }>();
  return {
    id: e.id, slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
    sessionMinutes: e.session_minutes, gapMinutes: e.gap_minutes, costPence: e.cost_pence,
    venuePostcode: e.venue_postcode, details: e.details, archived: e.archived === 1,
    breaks: results.map((b) => ({ start: b.start_utc, end: b.end_utc })),
  };
}

/** The public face of an event: no ids, no breaks. */
export const eventSummary = (e: EventRow) => ({
  slug: e.slug, name: e.name, startUtc: e.startUtc, endUtc: e.endUtc,
  costPence: e.costPence, venuePostcode: e.venuePostcode, details: e.details, archived: e.archived,
});

/** Bookings whose slot is not in the current schedule are ignored. */
export async function computeSlotViews(db: D1Database, event: EventRow): Promise<SlotView[]> {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc,
    sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const { results } = await db
    .prepare("SELECT slot_start_utc FROM bookings WHERE event_id = ?")
    .bind(event.id)
    .all<{ slot_start_utc: string }>();
  const taken = new Set(results.map((r) => r.slot_start_utc));
  return slots.map((s) => ({ ...s, status: taken.has(s.start) ? "taken" : "free" }));
}
