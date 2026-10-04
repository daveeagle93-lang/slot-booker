import { bookingCutoffOffsetMinutes, privacyNotice } from "../../../../src/server/config";
import type { AppEnv } from "../../../../src/server/env";
import { bookingWindow, computeSlotViews, eventSummary, loadEventBySlug } from "../../../../src/server/events";
import { errorResponse, json } from "../../../../src/server/http";

export const onRequestGet: PagesFunction<AppEnv, "slug"> = async ({ env, params }) => {
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return errorResponse(404, "not_found", "Event not found");
  const slots = event.archived ? [] : await computeSlotViews(env.DB, event);
  return json(
    {
      event: eventSummary(event),
      slots,
      bookings: bookingWindow(event, bookingCutoffOffsetMinutes(env.BOOKING_CUTOFF_OFFSET_MINUTES), new Date()),
      privacyNotice: privacyNotice(env.PRIVACY_NOTICE),
    },
    200,
    { "Cache-Control": "no-store" },
  );
};
