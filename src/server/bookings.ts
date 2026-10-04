import { identityKey } from "../core/identity";
import { generateSchedule, type TimeRange } from "../core/schedule";
import { computeSlotViews, type EventRow } from "./events";
import { errorResponse } from "./http";

const MAX_BODY_CHARS = 4096;
const MAX_NAME_CODE_POINTS = 80;
export const noStore = { "Cache-Control": "no-store" };

export interface BookingInput { slot: string; dogName: string; handlerName: string }

export type BookingResult =
  | { kind: "created"; booking: { slot: TimeRange; dogName: string; handlerName: string } }
  | { kind: "duplicate_booking" }
  | { kind: "slot_taken"; freeSlots: TimeRange[] };

/** Returns the parsed JSON object, or the error response to send. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return errorResponse(415, "unsupported_media_type", "Send the request as application/json.", {}, noStore);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return errorResponse(413, "payload_too_large", "That request is too large.", {}, noStore);
  }
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

function checkName(value: unknown, label: string): { name: string } | { message: string } {
  if (typeof value !== "string") return { message: `Enter the ${label}.` };
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
  if (Object.keys(fields).length > 0) return { fields };
  return { slot: raw.slot as string, dogName: (dog as { name: string }).name, handlerName: (handler as { name: string }).name };
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
 * Inserts without checking availability or identity first: the UNIQUE constraints decide, and a
 * failure is classified afterwards. Identity wins when both constraints would be violated.
 */
export async function createBooking(
  db: D1Database, event: EventRow, slot: TimeRange, input: BookingInput,
): Promise<BookingResult> {
  const dogKey = identityKey(input.dogName);
  const handlerKey = identityKey(input.handlerName);
  try {
    await db
      .prepare(
        "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(event.id, slot.start, input.dogName, input.handlerName, dogKey, handlerKey)
      .run();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("UNIQUE constraint failed")) throw e;
    const same = await db
      .prepare("SELECT 1 AS n FROM bookings WHERE event_id = ? AND dog_key = ? AND handler_key = ?")
      .bind(event.id, dogKey, handlerKey)
      .first();
    if (same) return { kind: "duplicate_booking" };
    const views = await computeSlotViews(db, event);
    return {
      kind: "slot_taken",
      freeSlots: views.filter((s) => s.status === "free").map(({ start, end }) => ({ start, end })),
    };
  }
  return { kind: "created", booking: { slot, dogName: input.dogName, handlerName: input.handlerName } };
}
