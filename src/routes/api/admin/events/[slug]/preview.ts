import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import { bookingsOutside, editFailed, eventNotFound, loadBookings } from "../../../../../server/admin-event-edit";
import { previewSchedule, readEventDraft } from "../../../../../server/admin-events";
import { noStore } from "../../../../../server/bookings";
import type { RouteHandler } from "../../../../../server/env";
import { loadEventBySlug } from "../../../../../server/events";
import { json } from "../../../../../server/http";

/**
 * The stateless preview plus `affected`: this event's bookings whose slot the draft's schedule lacks.
 * Read-only. The date may be in the past: an event that has started can still be corrected.
 */
export const onRequestPost: RouteHandler<"slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const draft = await readEventDraft(request, false);
    if (draft instanceof Response) return draft;
    const preview = previewSchedule(draft);
    return json({ ...preview, affected: bookingsOutside(await loadBookings(env.DB, event.id), preview.slots) }, 200, noStore);
  } catch (e) {
    return editFailed("editPreview", e);
  }
};
