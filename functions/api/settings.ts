import { noStore } from "../../src/server/bookings";
import type { AppEnv } from "../../src/server/env";
import { json } from "../../src/server/http";
import { loadPublicSettings } from "../../src/server/settings";

/** What public pages need to show the club's name, logo and privacy contact; see loadPublicSettings. */
export const onRequestGet: PagesFunction<AppEnv> = async ({ env }) => json(await loadPublicSettings(env.DB), 200, noStore);
