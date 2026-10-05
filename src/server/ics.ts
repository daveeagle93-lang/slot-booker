import { buildBookingIcs } from "../core/ics";
import { isValidToken } from "../core/slug";
import { findSlot } from "./bookings";
import type { EventRow } from "./events";
import { loadSettings } from "./settings";

/**
 * Stable per booking identity within an event (not per slot or token), so if an admin moves the
 * slot, calendars treat it as the same entry instead of duplicating it. A moved booking keeps its
 * UID but SEQUENCE and DTSTAMP stay fixed (0 and created_at), so calendar clients may ignore the
 * update; revisit when the admin move feature adds a per-booking revision.
 */
export async function bookingUid(slug: string, dogKey: string, handlerKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${slug}|${dogKey}|${handlerKey}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 32)}@slot-booker`;
}

export const bookingIcsUrl = (slug: string, token: string): string => `/api/events/${slug}/bookings/${token}/ics`;

/**
 * The .ics for the booking with this token, or null if there is none (or its slot is no longer
 * scheduled). The token is 128 random bits, so it cannot be guessed, and the caller must give every
 * miss the same response, so a miss reveals nothing about who has booked.
 */
export async function loadBookingIcs(db: D1Database, event: EventRow, token: string): Promise<string | null> {
  if (!isValidToken(token)) return null;
  const booking = await db
    .prepare(
      "SELECT slot_start_utc, dog_name, handler_name, dog_key, handler_key, created_at FROM bookings WHERE event_id = ? AND token = ?",
    )
    .bind(event.id, token)
    .first<{ slot_start_utc: string; dog_name: string; handler_name: string; dog_key: string; handler_key: string; created_at: string }>();
  if (!booking) return null;
  const range = findSlot(event, booking.slot_start_utc);
  if (!range) return null;
  const { clubName } = await loadSettings(db);
  return buildBookingIcs({
    uid: await bookingUid(event.slug, booking.dog_key, booking.handler_key),
    dtstamp: booking.created_at,
    slot: range,
    dogName: booking.dog_name,
    handlerName: booking.handler_name,
    eventName: event.name,
    venuePostcode: event.venuePostcode,
    costPence: event.costPence,
    details: event.details,
    clubName,
  });
}
