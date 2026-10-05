import { noStore } from "../../src/server/bookings";
import type { AppEnv } from "../../src/server/env";
import { errorResponse, json } from "../../src/server/http";
import { loadPublicSettings } from "../../src/server/settings";

/** What public pages need to show the club's name, logo and privacy contact; see loadPublicSettings. */
export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => {
  try {
    return json(await loadPublicSettings(env.DB), 200, noStore);
  } catch (e) {
    // Only the message is logged: an error object can carry SQL text and bound values.
    console.error("loadPublicSettings failed:", e instanceof Error ? e.message : String(e));
    return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
  }
};
