import {
  createBooking, declaresOversizeBody, findByIdempotencyKey, findSlot, noStore, payloadTooLarge, readJsonObject,
  validateBookingInput, type BookingResult,
} from "../../../../src/server/bookings";
import { bookingCutoffOffsetMinutes } from "../../../../src/server/config";
import type { AppEnv } from "../../../../src/server/env";
import { bookingWindow, eventSummary, loadEventBySlug } from "../../../../src/server/events";
import { errorResponse, json } from "../../../../src/server/http";
import { bookingIcsUrl } from "../../../../src/server/ics";

export const onRequestPost: PagesFunction<AppEnv, "slug"> = async ({ request, env, params }) => {
  // Before any lookup, so oversized requests cost no database work.
  if (declaresOversizeBody(request)) return payloadTooLarge();
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return errorResponse(404, "not_found", "Event not found", {}, noStore);

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const input = validateBookingInput(body);
  if ("fields" in input) {
    return errorResponse(400, "invalid_input", "Check the highlighted fields.", { fields: input.fields }, noStore);
  }

  const failed = (e: unknown) => {
    console.error("createBooking failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  };
  let result: BookingResult | null;
  // Before the archived and cut-off checks, so a retry after a dropped response still gets its booking.
  try {
    result = await findByIdempotencyKey(env.DB, event, input);
  } catch (e) {
    return failed(e);
  }
  if (!result) {
    if (event.archived) return errorResponse(410, "event_archived", "This event is closed to bookings.", {}, noStore);
    if (!bookingWindow(event, bookingCutoffOffsetMinutes(env.BOOKING_CUTOFF_OFFSET_MINUTES), new Date()).open) {
      return errorResponse(410, "bookings_closed", "Bookings for this event are now closed.", {}, noStore);
    }
    const slot = findSlot(event, input.slot);
    if (!slot) return errorResponse(400, "invalid_slot", "That time isn't one of this event's slots.", {}, noStore);
    try {
      result = await createBooking(env.DB, event, slot, input);
    } catch (e) {
      return failed(e);
    }
  }
  switch (result.kind) {
    case "created":
    case "replayed":
      return json({
        booking: result.booking,
        event: eventSummary(event),
        icsUrl: bookingIcsUrl(event.slug, result.token),
      }, 201, result.kind === "replayed" ? { ...noStore, "Idempotent-Replayed": "true" } : noStore);
    case "idempotency_key_reuse": {
      const message = "An earlier attempt from this page was already saved, so this change wasn't applied. To change a booking, contact the organiser.";
      const { original } = result;
      return errorResponse(422, "idempotency_key_reuse", message, original ? {
        booking: original.booking,
        event: eventSummary(event),
        icsUrl: bookingIcsUrl(event.slug, original.token),
      } : {}, noStore);
    }
    case "duplicate_booking":
      return errorResponse(409, "duplicate_booking", "That dog and handler already have a booking for this event.", {}, noStore);
    case "slot_taken":
      return errorResponse(409, "slot_taken", "That slot's just gone.", { freeSlots: result.freeSlots }, noStore);
  }
};
