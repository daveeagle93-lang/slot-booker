import { createBooking, declaresOversizeBody, findSlot, noStore, payloadTooLarge, readJsonObject, validateBookingInput } from "../../../../src/server/bookings";
import { eventSummary, loadEventBySlug } from "../../../../src/server/events";
import { errorResponse, json } from "../../../../src/server/http";
import { bookingIcsUrl } from "../../../../src/server/ics";

export const onRequestPost: PagesFunction<Env, "slug"> = async ({ request, env, params }) => {
  // Before any lookup, so oversized requests cost no database work.
  if (declaresOversizeBody(request)) return payloadTooLarge();
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return errorResponse(404, "not_found", "Event not found", {}, noStore);
  if (event.archived) return errorResponse(410, "event_archived", "This event is closed to bookings.", {}, noStore);

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const input = validateBookingInput(body);
  if ("fields" in input) {
    return errorResponse(400, "invalid_input", "Check the highlighted fields.", { fields: input.fields }, noStore);
  }
  const slot = findSlot(event, input.slot);
  if (!slot) return errorResponse(400, "invalid_slot", "That time isn't one of this event's slots.", {}, noStore);

  let result;
  try {
    result = await createBooking(env.DB, event, slot, input);
  } catch (e) {
    console.error("createBooking failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
  switch (result.kind) {
    case "created":
      return json({
        booking: result.booking,
        event: eventSummary(event),
        icsUrl: bookingIcsUrl(event.slug, result.booking.slot.start, result.booking.dogName, result.booking.handlerName),
      }, 201, noStore);
    case "duplicate_booking":
      return errorResponse(409, "duplicate_booking", "That dog and handler already have a booking for this event.", {}, noStore);
    case "slot_taken":
      return errorResponse(409, "slot_taken", "That slot's just gone.", { freeSlots: result.freeSlots }, noStore);
  }
};
