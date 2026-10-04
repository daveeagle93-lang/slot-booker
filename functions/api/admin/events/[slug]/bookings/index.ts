import { refuseUnlessAdmin } from "../../../../../../src/server/admin-context";
import { addBooking, failureResponse } from "../../../../../../src/server/admin-bookings";
import { editFailed, eventNotFound } from "../../../../../../src/server/admin-event-edit";
import { noStore, readJsonObject } from "../../../../../../src/server/bookings";
import type { AppEnv } from "../../../../../../src/server/env";
import { loadEventBySlug } from "../../../../../../src/server/events";
import { json } from "../../../../../../src/server/http";

/** Adds a booking on someone's behalf. An admin override: see addBooking for what it skips. */
export const onRequestPost: PagesFunction<AppEnv, "slug"> = async ({ request, env, data, params }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const event = await loadEventBySlug(env.DB, String(params.slug));
    if (!event) return eventNotFound();
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const result = await addBooking(env.DB, event, body);
    return "ok" in result ? json({ booking: result.ok }, 201, noStore) : failureResponse(result);
  } catch (e) {
    return editFailed("addBooking", e);
  }
};
