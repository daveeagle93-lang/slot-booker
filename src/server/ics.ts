import { buildBookingIcs } from "../core/ics";
import { identityKey } from "../core/identity";
import { findSlot } from "./bookings";
import type { EventRow } from "./events";

/**
 * Stable per booking identity within an event (not per slot), so if an admin moves the slot,
 * calendars update the existing entry instead of duplicating it.
 */
export async function bookingUid(slug: string, dogKey: string, handlerKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${slug}|${dogKey}|${handlerKey}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 32)}@slot-booker`;
}

export const bookingIcsUrl = (slug: string, slot: string, dog: string, handler: string): string =>
  `/api/events/${slug}/ics?slot=${encodeURIComponent(slot)}&dog=${encodeURIComponent(dog)}&handler=${encodeURIComponent(handler)}`;

/** The .ics for an existing booking, or null if there is no such booking (or its slot is no longer scheduled). */
export async function loadBookingIcs(
  db: D1Database, event: EventRow, slot: string, dog: string, handler: string,
): Promise<string | null> {
  const dogKey = identityKey(dog);
  const handlerKey = identityKey(handler);
  if (slot === "" || dogKey === "" || handlerKey === "") return null;
  const booking = await db
    .prepare(
      "SELECT dog_name, handler_name, created_at FROM bookings WHERE event_id = ? AND slot_start_utc = ? AND dog_key = ? AND handler_key = ?",
    )
    .bind(event.id, slot, dogKey, handlerKey)
    .first<{ dog_name: string; handler_name: string; created_at: string }>();
  if (!booking) return null;
  const range = findSlot(event, slot);
  if (!range) return null;
  return buildBookingIcs({
    uid: await bookingUid(event.slug, dogKey, handlerKey),
    dtstamp: booking.created_at,
    slot: range,
    dogName: booking.dog_name,
    handlerName: booking.handler_name,
    eventName: event.name,
    venuePostcode: event.venuePostcode,
    costPence: event.costPence,
    details: event.details,
  });
}
