import { refuseUnlessAdmin } from "../../../../../../../src/server/admin-context";
import { failureResponse, moveBooking } from "../../../../../../../src/server/admin-bookings";
import { editFailed, eventNotFound } from "../../../../../../../src/server/admin-event-edit";
import { noStore, readJsonObject } from "../../../../../../../src/server/bookings";
import type { AppEnv } from "../../../../../../../src/server/env";
import { loadEventBySlug } from "../../../../../../../src/server/events";
import { json } from "../../../../../../../src/server/http";

/** Moves a booking from `fromSlot` (where the admin saw it) to the free slot `toSlot`. */
export const onRequestPost: PagesFunction<AppEnv, "slug" | "id"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const id = /^[1-9]\d{0,14}$/.test(String(params.id)) ? Number(params.id) : 0;
    const result = await moveBooking(env.DB, event, id, body);
    return "ok" in result ? json({ booking: result.ok }, 200, noStore) : failureResponse(result);
  } catch (e) {
    return editFailed("moveBooking", e);
  }
};
