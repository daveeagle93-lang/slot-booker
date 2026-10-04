import { identityKey } from "../core/identity";
import { generateSchedule, type TimeRange } from "../core/schedule";
import { generateBookingToken } from "../core/slug";
import { computeSlotViews, type EventRow } from "./events";
import { errorResponse } from "./http";

const MAX_BODY_BYTES = 4096;
const MAX_NAME_CODE_POINTS = 80;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
// Soft hyphen, zero-width space, LRM/RLM, bidi controls, word joiner and invisible operators, BOM.
// ZWNJ/ZWJ (U+200C/D) are allowed: emoji sequences and some scripts need them.
export const INVISIBLE = /[\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;
export const noStore = { "Cache-Control": "no-store" };

export interface BookingInput { slot: string; dogName: string; handlerName: string; idempotencyKey: string }

type BookedResult = { booking: { slot: TimeRange; dogName: string; handlerName: string }; token: string };

export type BookingResult =
  | ({ kind: "created" } & BookedResult)
  | ({ kind: "replayed" } & BookedResult)
  | { kind: "idempotency_key_reuse"; original: BookedResult | null }
  | { kind: "duplicate_booking" }
  | { kind: "slot_taken"; freeSlots: TimeRange[] };

export const payloadTooLarge = (): Response =>
  errorResponse(413, "payload_too_large", "That request is too large.", {}, noStore);

/** True if the client declares a body over the cap; lets the handler refuse before touching the database. */
export const declaresOversizeBody = (request: Request): boolean =>
  Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES;

/** Reads the body as text, cancelling the stream and returning null as soon as it passes the byte cap. */
async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Returns the parsed JSON object, or the error response to send. */
export async function readJsonObject(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown> | Response> {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return errorResponse(415, "unsupported_media_type", "Send the request as application/json.", {}, noStore);
  }
  const text = await readCappedText(request, maxBytes);
  if (text === null) return payloadTooLarge();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return errorResponse(400, "invalid_json", "The request body isn't valid JSON.", {}, noStore);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return errorResponse(400, "invalid_json", "The request body must be a JSON object.", {}, noStore);
  }
  return value as Record<string, unknown>;
}

export function checkName(value: unknown, label: string): { name: string } | { message: string } {
  if (typeof value !== "string") return { message: `Enter the ${label}.` };
  if (!value.isWellFormed()) return { message: `The ${label} can't contain unpaired surrogate characters.` };
  if (INVISIBLE.test(value)) {
    return { message: `The ${label} can't contain invisible or direction-changing characters.` };
  }
  const name = value.trim();
  if (name === "") return { message: `Enter the ${label}.` };
  if ([...name].length > MAX_NAME_CODE_POINTS) {
    return { message: `The ${label} must be at most ${MAX_NAME_CODE_POINTS} characters.` };
  }
  if (/\p{Cc}/u.test(name)) return { message: `The ${label} can't contain control characters.` };
  if (identityKey(name) === "") return { message: `Enter the ${label}.` };
  return { name };
}

export function validateBookingInput(raw: Record<string, unknown>): BookingInput | { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const dog = checkName(raw.dogName, "dog's name");
  const handler = checkName(raw.handlerName, "handler's name");
  if ("message" in dog) fields.dogName = dog.message;
  if ("message" in handler) fields.handlerName = handler.message;
  if (typeof raw.slot !== "string") fields.slot = "Choose a slot.";
  if (typeof raw.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(raw.idempotencyKey)) {
    fields.idempotencyKey = "Reload the page and try again.";
  }
  if (Object.keys(fields).length > 0) return { fields };
  return {
    slot: raw.slot as string, dogName: (dog as { name: string }).name, handlerName: (handler as { name: string }).name,
    idempotencyKey: raw.idempotencyKey as string,
  };
}

/** The slots a public booker could take right now: not booked and not yet started. */
export async function bookableSlots(db: D1Database, event: EventRow, now: Date): Promise<TimeRange[]> {
  const views = await computeSlotViews(db, event, now);
  return views.filter((s) => s.status === "free").map(({ start, end }) => ({ start, end }));
}

function scheduleOf(event: EventRow): TimeRange[] {
  return generateSchedule({
    start: event.startUtc, end: event.endUtc,
    sessionMinutes: event.sessionMinutes, gapMinutes: event.gapMinutes, breaks: event.breaks,
  }).slots;
}

export const findSlot = (event: EventRow, start: string): TimeRange | undefined =>
  scheduleOf(event).find((s) => s.start === start);

/**
 * What the request's idempotency key says: a replay of the key holder's booking if the key was used by
 * the same slot, dog and handler (a retry), idempotency_key_reuse if it was used by anything else, or
 * null if no booking holds it. The lookup is by event and key alone, and the key is a 128-bit secret
 * held only by the booker's browser, so presenting it proves ownership: a reuse carries the key
 * holder's own booking as stored (never the requested values) so a booker who edited the form after a
 * lost response can still find it. If that booking's slot has since left the schedule, a retry gets
 * null (and so the usual invalid_slot) and a reuse carries no booking.
 */
export async function findByIdempotencyKey(
  db: D1Database, event: EventRow, input: BookingInput,
): Promise<Extract<BookingResult, { kind: "replayed" | "idempotency_key_reuse" }> | null> {
  const row = await db
    .prepare(
      "SELECT slot_start_utc, dog_name, handler_name, dog_key, handler_key, token FROM bookings WHERE event_id = ? AND idempotency_key = ?",
    )
    .bind(event.id, input.idempotencyKey)
    .first<{ slot_start_utc: string; dog_name: string; handler_name: string; dog_key: string; handler_key: string; token: string }>();
  if (!row) return null;
  const same = row.slot_start_utc === input.slot
    && row.dog_key === identityKey(input.dogName) && row.handler_key === identityKey(input.handlerName);
  const slot = findSlot(event, row.slot_start_utc);
  const stored = slot && { booking: { slot, dogName: row.dog_name, handlerName: row.handler_name }, token: row.token };
  if (!same) return { kind: "idempotency_key_reuse", original: stored ?? null };
  return stored ? { kind: "replayed", ...stored } : null;
}

/**
 * Inserts without checking availability or identity first: the UNIQUE constraints decide, and a
 * failure is classified afterwards. Whoever holds the requested slot decides the answer: a
 * different pair means slot_taken even if the requester's own pair has booked elsewhere, so
 * guessing a taken slot cannot confirm that a dog and handler have booked. If the guessed slot is
 * free, a request with the guessed pair gets duplicate_booking when that pair has booked; that is a
 * known limitation (a wrong guess also creates a real booking). The first thing checked after a
 * failure is the idempotency key, because a simultaneous request with the same key may have won.
 */
export async function createBooking(
  db: D1Database, event: EventRow, slot: TimeRange, input: BookingInput, now: Date,
): Promise<BookingResult> {
  const dogKey = identityKey(input.dogName);
  const handlerKey = identityKey(input.handlerName);
  const token = generateBookingToken();
  try {
    await db
      .prepare(
        "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(event.id, slot.start, input.dogName, input.handlerName, dogKey, handlerKey, token, input.idempotencyKey)
      .run();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("UNIQUE constraint failed")) throw e;
    const prior = await findByIdempotencyKey(db, event, input);
    if (prior) return prior;
    const holder = await db
      .prepare("SELECT dog_key, handler_key FROM bookings WHERE event_id = ? AND slot_start_utc = ?")
      .bind(event.id, slot.start)
      .first<{ dog_key: string; handler_key: string }>();
    if (holder) {
      if (holder.dog_key === dogKey && holder.handler_key === handlerKey) return { kind: "duplicate_booking" };
    } else {
      // The slot is free, so the identity constraint fired (unless the holder has since vanished).
      const same = await db
        .prepare("SELECT 1 AS n FROM bookings WHERE event_id = ? AND dog_key = ? AND handler_key = ?")
        .bind(event.id, dogKey, handlerKey)
        .first();
      if (same) return { kind: "duplicate_booking" };
    }
    return { kind: "slot_taken", freeSlots: await bookableSlots(db, event, now) };
  }
  return { kind: "created", booking: { slot, dogName: input.dogName, handlerName: input.handlerName }, token };
}
