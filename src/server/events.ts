import { generateSchedule, type TimeRange } from "../core/schedule";
import { isValidSlug } from "../core/slug";

/** One lane (ring) of an event; lanes run in parallel, in `position` order. A single lane may have an empty name. */
export interface EventLane { id: number; position: number; name: string }

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
  /** What the admin's Share button builds its message from; empty means the default template's, then the built-in wording. Never public. */
  shareMessage: string;
  archived: boolean;
  /** Whether the landing page lists it. Unlisted events are still bookable by their link. */
  listed: boolean;
  breaks: (TimeRange & { label: string })[];
  lanes: EventLane[];
  /** Places per lane per time. */
  capacity: number;
  /** How many bookings one identity (one dog and handler) may hold in the event. */
  identityLimit: number;
  /** Counts the edits of lanes, capacity and identity limit, so a request can tell that they changed under it (db-guard.ts). */
  configRev: number;
}

/** What is left in one lane at one time. */
export interface LanePlaces { laneId: number; free: number }

export interface SlotView extends TimeRange {
  /** "free" if any place in any lane is free and the slot hasn't started, "taken" if none is (booked wins over past), else "past". */
  status: "free" | "taken" | "past";
  places: LanePlaces[];
}

interface RawEvent {
  id: number; slug: string; name: string; start_utc: string; end_utc: string; session_minutes: number;
  gap_minutes: number; cost_pence: number; venue_postcode: string; details: string; share_message: string; archived: number; listed: number;
}

/**
 * The event with its breaks, lanes and layout, from one batch (one round trip, one consistent snapshot). An event
 * without a layout row (inserted by hand, not by the app) gets capacity 1, limit 1 and revision 0, and with no lane
 * it can't be booked.
 */
export async function loadEventBySlug(db: D1Database, slug: string): Promise<EventRow | null> {
  if (!isValidSlug(slug)) return null;
  const idOf = "(SELECT id FROM events WHERE slug = ?)";
  const [event, breaks, lanes, layout] = await db.batch([
    db.prepare("SELECT * FROM events WHERE slug = ?").bind(slug),
    db.prepare(`SELECT start_utc, end_utc, label FROM breaks WHERE event_id = ${idOf} ORDER BY start_utc`).bind(slug),
    db.prepare(`SELECT id, position, name FROM event_lanes WHERE event_id = ${idOf} ORDER BY position`).bind(slug),
    db.prepare(`SELECT capacity, identity_limit, config_rev FROM event_layout WHERE event_id = ${idOf}`).bind(slug),
  ]);
  const e = (event.results as unknown as RawEvent[])[0];
  if (!e) return null;
  const results = breaks.results as { start_utc: string; end_utc: string; label: string }[];
  const rawLayout = (layout.results as { capacity: number; identity_limit: number; config_rev: number }[])[0];
  return {
    id: e.id, slug: e.slug, name: e.name, startUtc: e.start_utc, endUtc: e.end_utc,
    sessionMinutes: e.session_minutes, gapMinutes: e.gap_minutes, costPence: e.cost_pence,
    venuePostcode: e.venue_postcode, details: e.details, shareMessage: e.share_message, archived: e.archived === 1, listed: e.listed === 1,
    breaks: results.map((b) => ({ start: b.start_utc, end: b.end_utc, label: b.label })),
    lanes: lanes.results as unknown as EventLane[],
    capacity: rawLayout?.capacity ?? 1, identityLimit: rawLayout?.identity_limit ?? 1, configRev: rawLayout?.config_rev ?? 0,
  };
}

/** The public face of an event: no event id, no breaks, no share message. The lanes are the ones a booker chooses between. */
export const eventSummary = (e: EventRow) => ({
  slug: e.slug, name: e.name, startUtc: e.startUtc, endUtc: e.endUtc,
  costPence: e.costPence, venuePostcode: e.venuePostcode, details: e.details, archived: e.archived,
  lanes: e.lanes.map((l) => ({ id: l.id, name: l.name })), capacity: e.capacity,
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
 * Bookings whose slot is not in the current schedule are ignored. A slot with no free place in any lane is "taken", and
 * that wins over "past" (a slot that has started and is full shows as unavailable either way); a slot that has started
 * with places left is "past". `places` has one entry per lane, in lane order, so a page can offer a lane at a time.
 */
export async function computeSlotViews(db: D1Database, event: EventRow, now: Date): Promise<SlotView[]> {
  const { slots } = generateSchedule({
    start: event.startUtc, end: event.endUtc,
    sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  });
  const { results } = await db
    .prepare("SELECT slot_start_utc, lane_id, COUNT(*) AS n FROM bookings WHERE event_id = ? GROUP BY slot_start_utc, lane_id")
    .bind(event.id)
    .all<{ slot_start_utc: string; lane_id: number; n: number }>();
  const booked = new Map(results.map((r) => [`${r.slot_start_utc}|${r.lane_id}`, r.n]));
  return slots.map((s) => {
    const places = event.lanes.map((l) => ({ laneId: l.id, free: Math.max(0, event.capacity - (booked.get(`${s.start}|${l.id}`) ?? 0)) }));
    const anyFree = places.some((p) => p.free > 0);
    return { ...s, status: !anyFree ? "taken" : isSlotBookable(s.start, { open: true }, now) ? "free" : "past", places };
  });
}
