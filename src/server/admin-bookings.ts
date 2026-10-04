import { identityKey } from "../core/identity";
import { generateBookingToken } from "../core/slug";
import type { BookingRef } from "./admin-event-edit";
import { checkName, findSlot, noStore } from "./bookings";
import { guard, isGuardFailure, scheduleUnchanged } from "./db-guard";
import { loadEventBySlug, type EventRow } from "./events";
import { errorResponse } from "./http";

/** What an admin booking action answers when it can't do what was asked: becomes the JSON error response. */
export interface Failure { status: number; code: string; message: string; extra?: object }
export type Outcome<T> = { ok: T } | Failure;

export const failureResponse = (f: Failure): Response => errorResponse(f.status, f.code, f.message, f.extra ?? {}, noStore);

const fail = (status: number, code: string, message: string, extra?: object): Failure => ({ status, code, message, extra });
const invalidInput = (fields: Record<string, string>) => fail(400, "invalid_input", "Check the highlighted fields.", { fields });
const invalidSlot = () => fail(400, "invalid_slot", "That time isn't one of this event's slots.");
const notFound = () => fail(404, "not_found", "Booking not found.");
const changed = () => fail(409, "changed", "This booking was changed by someone else. Reload the page.");
const eventChanged = () => fail(409, "event_changed", "The event was edited while you were working. Reload the page.");

/** Test seam: runs after the handler's reads and before the batch, where another request could change things. */
export interface MutationHooks { afterRead?: () => Promise<void> }

interface Row { id: number; slot_start_utc: string; dog_name: string; handler_name: string }
const COLUMNS = "id, slot_start_utc, dog_name, handler_name";
const ref = (r: Row): BookingRef => ({ id: r.id, slotStart: r.slot_start_utc, dogName: r.dog_name, handlerName: r.handler_name });
const isUniqueFailure = (e: unknown): boolean => e instanceof Error && e.message.includes("UNIQUE constraint failed");

/** A guard failure is either the event being edited or a booking having moved: say which. */
async function guardFailed(db: D1Database, event: EventRow): Promise<Failure> {
  const fresh = await loadEventBySlug(db, event.slug);
  const same = (e: EventRow) =>
    JSON.stringify([e.startUtc, e.endUtc, e.sessionMinutes, e.gapMinutes, [...new Set(e.breaks.map((b) => `${b.start}|${b.end}`))].sort()]);
  return !fresh || same(fresh) !== same(event) ? eventChanged() : changed();
}

/** Who holds the slot, for telling the admin why a move or add was refused. */
const holderOf = (db: D1Database, eventId: number, slot: string) =>
  db.prepare(`SELECT ${COLUMNS}, dog_key, handler_key FROM bookings WHERE event_id = ? AND slot_start_utc = ?`)
    .bind(eventId, slot).first<Row & { dog_key: string; handler_key: string }>();

/**
 * Adds a booking on someone's behalf. This is an admin override: unlike the public booking it ignores the
 * cut-off, the past-slot rule and an archived event, so an organiser can fix up the day itself. The slot must
 * still be one of the current schedule. The UNIQUE constraints decide a clash; the failure is classified
 * afterwards, and a slot's holder is named (admin-only, so no leak).
 */
export async function addBooking(
  db: D1Database, event: EventRow, raw: Record<string, unknown>, hooks: MutationHooks = {},
): Promise<Outcome<BookingRef>> {
  const dog = checkName(raw.dogName, "dog's name");
  const handler = checkName(raw.handlerName, "handler's name");
  const fields: Record<string, string> = {};
  if ("message" in dog) fields.dogName = dog.message;
  if ("message" in handler) fields.handlerName = handler.message;
  if (typeof raw.slot !== "string") fields.slot = "Choose a slot.";
  if (Object.keys(fields).length > 0) return invalidInput(fields);
  const { name: dogName } = dog as { name: string };
  const { name: handlerName } = handler as { name: string };
  const slot = findSlot(event, raw.slot as string);
  if (!slot) return invalidSlot();
  await hooks.afterRead?.();

  const dogKey = identityKey(dogName);
  const handlerKey = identityKey(handlerName);
  try {
    const results = await db.batch([
      scheduleUnchanged(db, event),
      db.prepare(
        `INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      ).bind(event.id, slot.start, dogName, handlerName, dogKey, handlerKey, generateBookingToken()),
    ]);
    return { ok: ref((results[1].results as Row[])[0]) };
  } catch (e) {
    if (isGuardFailure(e)) return eventChanged();
    if (!isUniqueFailure(e)) throw e;
  }
  const holder = await holderOf(db, event.id, slot.start);
  if (holder && (holder.dog_key !== dogKey || holder.handler_key !== handlerKey)) {
    return fail(409, "slot_taken", "That slot is already taken.", { booking: { id: holder.id, dogName: holder.dog_name, handlerName: holder.handler_name } });
  }
  const existing = holder ?? await db
    .prepare(`SELECT ${COLUMNS} FROM bookings WHERE event_id = ? AND dog_key = ? AND handler_key = ?`)
    .bind(event.id, dogKey, handlerKey).first<Row>();
  if (!existing) return changed(); // whoever caused the clash has gone again
  return fail(409, "duplicate_booking", "That dog and handler already have a booking for this event.", { booking: ref(existing) });
}

/** Removes the booking if it belongs to this event; a second call, or another event's id, finds nothing. */
export async function clearBooking(db: D1Database, event: EventRow, id: number): Promise<Outcome<BookingRef>> {
  const row = await db
    .prepare(`DELETE FROM bookings WHERE id = ? AND event_id = ? RETURNING ${COLUMNS}`)
    .bind(id, event.id).first<Row>();
  return row ? { ok: ref(row) } : notFound();
}

/**
 * Moves a booking to a free slot of the schedule. Admin override: the new slot may be past or closed. The
 * booking must still be where the admin saw it (`fromSlot`); the UNIQUE constraint decides a race for the
 * target, so two moves into one free slot cannot both win.
 */
export async function moveBooking(
  db: D1Database, event: EventRow, id: number, raw: Record<string, unknown>, hooks: MutationHooks = {},
): Promise<Outcome<BookingRef>> {
  const fields: Record<string, string> = {};
  if (typeof raw.fromSlot !== "string") fields.fromSlot = "Send the slot the booking is in.";
  if (typeof raw.toSlot !== "string") fields.toSlot = "Choose a slot.";
  if (Object.keys(fields).length > 0) return invalidInput(fields);
  const { fromSlot, toSlot } = raw as { fromSlot: string; toSlot: string };
  if (fromSlot === toSlot) return fail(400, "same_slot", "The booking is already in that slot.");
  if (!findSlot(event, toSlot)) return invalidSlot();
  await hooks.afterRead?.();

  try {
    const results = await db.batch([
      scheduleUnchanged(db, event),
      db.prepare(`UPDATE bookings SET slot_start_utc = ? WHERE id = ? AND event_id = ? AND slot_start_utc = ? RETURNING ${COLUMNS}`)
        .bind(toSlot, id, event.id, fromSlot),
    ]);
    const moved = (results[1].results as Row[])[0];
    if (moved) return { ok: ref(moved) };
  } catch (e) {
    if (isGuardFailure(e)) return eventChanged();
    if (!isUniqueFailure(e)) throw e;
    const holder = await holderOf(db, event.id, toSlot);
    if (!holder) return changed();
    return fail(409, "slot_taken", "That slot is already taken.", { booking: { id: holder.id, dogName: holder.dog_name, handlerName: holder.handler_name } });
  }
  const exists = await db.prepare("SELECT 1 AS n FROM bookings WHERE id = ? AND event_id = ?").bind(id, event.id).first();
  return exists ? changed() : notFound();
}

/** A slot value that passes the table's shape check and is never a real slot, for the middle step of a swap. */
const PARKING_SLOT = "0001-01-01T00:00:00Z";

function swapSide(value: unknown): { id: number; slot: string } | null {
  const v = value as { id?: unknown; slot?: unknown } | null;
  if (typeof v !== "object" || v === null) return null;
  return typeof v.id === "number" && Number.isSafeInteger(v.id) && v.id > 0 && typeof v.slot === "string" ? { id: v.id, slot: v.slot } : null;
}

/**
 * Swaps the slots of two bookings of this event. SQLite checks UNIQUE after every row, so the swap goes
 * through a parking slot inside one batch: guards first (both bookings still where the admin saw them, the
 * parking slot unused, the schedule unchanged), then A to parking, B to A's slot, A to B's slot, then a last
 * guard that both ended up where intended. Any failure rolls the whole batch back, so no booking is ever left
 * on the parking slot. The people stay with their bookings, so the dog/handler index is untouched.
 */
export async function swapBookings(
  db: D1Database, event: EventRow, raw: Record<string, unknown>, hooks: MutationHooks = {},
): Promise<Outcome<{ a: { id: number; slotStart: string }; b: { id: number; slotStart: string } }>> {
  const a = swapSide(raw.a);
  const b = swapSide(raw.b);
  if (!a || !b) {
    return invalidInput({ ...(a ? {} : { a: "Send the id and slot of the first booking." }), ...(b ? {} : { b: "Send the id and slot of the second booking." }) });
  }
  if (a.id === b.id) return fail(400, "same_booking", "Choose two different bookings.");
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM bookings WHERE event_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(event.id, JSON.stringify([a.id, b.id])).all<Row>();
  if (results.length !== 2) return notFound();
  const at = new Map(results.map((r) => [r.id, r.slot_start_utc]));
  if (at.get(a.id) !== a.slot || at.get(b.id) !== b.slot) return changed();
  // Both must end up on real slots: swapping an orphan with a booked slot would orphan the other booking.
  if (!findSlot(event, a.slot) || !findSlot(event, b.slot)) return invalidSlot();
  await hooks.afterRead?.();

  const bothAt = "(SELECT COUNT(*) FROM bookings WHERE event_id = ? AND ((id = ? AND slot_start_utc = ?) OR (id = ? AND slot_start_utc = ?))) = 2";
  const move = (id: number, to: string, from: string) =>
    db.prepare(`UPDATE bookings SET slot_start_utc = ? WHERE id = ? AND event_id = ? AND slot_start_utc = ? RETURNING id, slot_start_utc`)
      .bind(to, id, event.id, from);
  try {
    const out = await db.batch([
      scheduleUnchanged(db, event),
      guard(db, bothAt, event.id, a.id, a.slot, b.id, b.slot),
      guard(db, "NOT EXISTS (SELECT 1 FROM bookings WHERE event_id = ? AND slot_start_utc = ?)", event.id, PARKING_SLOT),
      move(a.id, PARKING_SLOT, a.slot),
      move(b.id, a.slot, b.slot),
      move(a.id, b.slot, PARKING_SLOT),
      guard(db, bothAt, event.id, a.id, b.slot, b.id, a.slot),
    ]);
    const aRow = (out[5].results as { id: number; slot_start_utc: string }[])[0];
    const bRow = (out[4].results as { id: number; slot_start_utc: string }[])[0];
    return { ok: { a: { id: aRow.id, slotStart: aRow.slot_start_utc }, b: { id: bRow.id, slotStart: bRow.slot_start_utc } } };
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    return guardFailed(db, event);
  }
}
