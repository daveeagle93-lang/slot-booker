import { refuseUnlessAdmin } from "../../../../../../src/server/admin-context";
import { failureResponse, swapBookings } from "../../../../../../src/server/admin-bookings";
import { editFailed, eventNotFound } from "../../../../../../src/server/admin-event-edit";
import { noStore, readJsonObject } from "../../../../../../src/server/bookings";
import type { AppEnv } from "../../../../../../src/server/env";
import { loadEventBySlug } from "../../../../../../src/server/events";
import { json } from "../../../../../../src/server/http";

/** Swaps the slots of two bookings, given as the ids and slots the admin saw: see swapBookings. */
export const onRequestPost: PagesFunction<AppEnv, "slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const result = await swapBookings(env.DB, event, body);
    return "ok" in result ? json(result.ok, 200, noStore) : failureResponse(result);
  } catch (e) {
    return editFailed("swapBookings", e);
  }
};
