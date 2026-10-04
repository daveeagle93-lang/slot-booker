import { noStore } from "../../../../../../src/server/bookings";
import { loadEventBySlug } from "../../../../../../src/server/events";
import { apiHeaders, errorResponse } from "../../../../../../src/server/http";
import { loadBookingIcs } from "../../../../../../src/server/ics";

export const onRequestGet: PagesFunction<Env, "slug" | "token"> = async ({ env, params }) => {
  // One body for every miss (unknown event, unknown or malformed token, unscheduled slot).
  const notFound = () => errorResponse(404, "not_found", "Event not found", {}, noStore);
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return notFound();
  const ics = await loadBookingIcs(env.DB, event, String(params.token));
  if (ics === null) return notFound();
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="booking.ics"',
      ...noStore,
      ...apiHeaders,
    },
  });
};
