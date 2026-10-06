import { refuseUnlessAdmin } from "../../../../../server/admin-context";
import { checkRemoveIds, editFailed, eventDetail, eventNotFound, eventView, saveEventEdit } from "../../../../../server/admin-event-edit";
import { deleteEvent } from "../../../../../server/admin-event-lifecycle";
import { invalidInput, parseEventDraft, readEventBody } from "../../../../../server/admin-events";
import { noStore } from "../../../../../server/bookings";
import type { RouteHandler } from "../../../../../server/env";
import { loadEventBySlug } from "../../../../../server/events";
import { errorResponse, json } from "../../../../../server/http";

export const onRequestGet: RouteHandler<"slug"> = async ({ env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    return json(await eventDetail(env.DB, event), 200, noStore);
  } catch (e) {
    return editFailed("eventDetail", e);
  }
};

/**
 * Saves the event as the form describes it. Removing bookings needs their ids in `removeBookingIds`: the
 * server works out which bookings the new schedule would orphan itself and refuses (409) unless every one
 * is listed, so the confirmation is enforced here, not only in the page. A retry of a save that already
 * went through finds nothing left to remove and answers 200 with `removed: []`.
 * Two admins saving at once: the last write wins on the event's fields (there is no version column); the
 * bookings are still protected, by the guard inside the save's batch.
 */
export const onRequestPut: RouteHandler<"slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readEventBody(request);
    if (body instanceof Response) return body;
    const remove = checkRemoveIds(body.removeBookingIds);
    const now = new Date();
    const stored = { name: event.name, details: event.details, shareMessage: event.shareMessage, breakLabels: event.breaks.map((b) => b.label) };
    const parsed = parseEventDraft(body, { now, requireFuture: false, stored });
    if ("fields" in parsed) return invalidInput({ ...parsed.fields, ...("message" in remove ? { removeBookingIds: remove.message } : {}) });
    if ("message" in remove) return invalidInput({ removeBookingIds: remove.message });
    // Only a start that changes has to be in the future: a running or finished event can still be corrected.
    if (parsed.draft.startUtc !== event.startUtc) {
      const strict = parseEventDraft(body, { now, requireFuture: true, stored });
      if ("fields" in strict) return invalidInput(strict.fields);
    }
    const result = await saveEventEdit(env.DB, event, parsed.draft, remove.ids);
    if (result.kind === "not_found") return eventNotFound();
    if (result.kind === "bookings_affected") {
      const message = "Some bookings are on slots this change would remove. Check the list and confirm to remove them.";
      return errorResponse(409, "bookings_affected", message, { affected: result.affected }, noStore);
    }
    return json({ event: eventView(result.event), slotCount: result.slotCount, removed: result.removed }, 200, noStore);
  } catch (e) {
    return editFailed("saveEventEdit", e);
  }
};

/**
 * Permanently deletes the event, its breaks and its bookings. `confirmName` must be the event's name exactly;
 * the server checks it, not only the page, and a wrong or missing name deletes nothing (see deleteEvent).
 */
export const onRequestDelete: RouteHandler<"slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const body = await readEventBody(request);
    if (body instanceof Response) return body;
    const result = await deleteEvent(env.DB, String(params.slug), body.confirmName);
    switch (result.kind) {
      case "not_found":
        return eventNotFound();
      case "confirmation_mismatch":
        return errorResponse(400, "confirmation_mismatch", "Type the event's name exactly to delete it.", {}, noStore);
      case "deleted":
        return json({ deleted: { slug: result.slug, name: result.name, bookings: result.bookings } }, 200, noStore);
    }
  } catch (e) {
    return editFailed("deleteEvent", e);
  }
};
