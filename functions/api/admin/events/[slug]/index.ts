import { refuseUnlessAdmin } from "../../../../../src/server/admin-context";
import { editFailed, eventDetail, eventNotFound } from "../../../../../src/server/admin-event-edit";
import { noStore } from "../../../../../src/server/bookings";
import type { AppEnv } from "../../../../../src/server/env";
import { loadEventBySlug } from "../../../../../src/server/events";
import { json } from "../../../../../src/server/http";

export const onRequestGet: PagesFunction<AppEnv, "slug"> = async ({ env, data, params }) => {
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
