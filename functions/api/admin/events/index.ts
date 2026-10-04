import { refuseUnlessAdmin } from "../../../../src/server/admin-context";
import { insertEventWithBreaks, listUpcomingEvents, previewSchedule, readEventDraft } from "../../../../src/server/admin-events";
import { noStore } from "../../../../src/server/bookings";
import { bookingCutoffOffsetMinutes } from "../../../../src/server/config";
import type { AppEnv } from "../../../../src/server/env";
import { errorResponse, json } from "../../../../src/server/http";
import { generateSlug } from "../../../../src/core/slug";

const internalError = (what: string, e: unknown): Response => {
  console.error(`${what} failed:`, e instanceof Error ? e.message : String(e));
  return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
};

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const events = await listUpcomingEvents(env.DB, new Date(), bookingCutoffOffsetMinutes(env.BOOKING_CUTOFF_OFFSET_MINUTES));
    return json({ events }, 200, noStore);
  } catch (e) {
    return internalError("listUpcomingEvents", e);
  }
};

export const onRequestPost: PagesFunction<AppEnv> = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const draft = await readEventDraft(request, true);
  if (draft instanceof Response) return draft;
  const slug = generateSlug();
  try {
    await insertEventWithBreaks(env.DB, slug, draft);
  } catch (e) {
    return internalError("insertEventWithBreaks", e);
  }
  return json({
    event: {
      slug, name: draft.name, startUtc: draft.startUtc, endUtc: draft.endUtc, sessionMinutes: draft.sessionMinutes,
      gapMinutes: draft.gapMinutes, costPence: draft.costPence, venuePostcode: draft.venuePostcode, details: draft.details,
    },
    path: `/e/${slug}`,
    slotCount: previewSchedule(draft).slots.length,
  }, 201, noStore);
};
