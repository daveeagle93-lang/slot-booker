import { computeSlotViews, loadEventBySlug } from "../../../../src/server/events";
import { errorResponse, json } from "../../../../src/server/http";

export const onRequestGet: PagesFunction<Env, "slug"> = async ({ env, params }) => {
  const event = await loadEventBySlug(env.DB, String(params.slug));
  if (!event) return errorResponse(404, "not_found", "Event not found");
  const slots = event.archived ? [] : await computeSlotViews(env.DB, event);
  return json(
    {
      event: {
        slug: event.slug, name: event.name, startUtc: event.startUtc, endUtc: event.endUtc,
        costPence: event.costPence, venuePostcode: event.venuePostcode, details: event.details,
        archived: event.archived,
      },
      slots,
    },
    200,
    { "Cache-Control": "no-store" },
  );
};
