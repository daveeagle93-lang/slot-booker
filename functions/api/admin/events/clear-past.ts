import { refuseUnlessAdmin } from "../../../../src/server/admin-context";
import { editFailed } from "../../../../src/server/admin-event-edit";
import { checkClearSlugs, clearPastEvents } from "../../../../src/server/admin-event-lifecycle";
import { invalidInput, readEventBody } from "../../../../src/server/admin-events";
import { noStore } from "../../../../src/server/bookings";
import type { AppEnv } from "../../../../src/server/env";
import { errorResponse, json } from "../../../../src/server/http";

/**
 * Bulk clear-out: permanently deletes the listed events that are past, with their breaks and bookings.
 * `confirm` must be the string "DELETE" (enforced here, not only in the page). Events that aren't past, or
 * don't exist, are left alone and listed in `skipped`; see clearPastEvents.
 */
export const onRequestPost: PagesFunction<AppEnv> = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    const body = await readEventBody(request);
    if (body instanceof Response) return body;
    if (body.confirm !== "DELETE") {
      return errorResponse(400, "confirmation_required", "Type DELETE to confirm clearing out these events.", {}, noStore);
    }
    const slugs = checkClearSlugs(body.slugs);
    if ("message" in slugs) return invalidInput({ slugs: slugs.message });
    return json(await clearPastEvents(env.DB, new Date(), slugs.slugs), 200, noStore);
  } catch (e) {
    return editFailed("clearPastEvents", e);
  }
};
