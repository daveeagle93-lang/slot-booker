import { serveIcon } from "../../../src/server/icons";
import type { AppEnv } from "../../../src/server/env";
import { noStore } from "../../../src/server/bookings";
import { errorResponse } from "../../../src/server/http";
import { parseIconSize } from "../../../src/server/settings";

/** The app icon at 32, 180 or 512 px: the one made from the club's logo, or the bundled default. See serveIcon. */
export const onRequest: PagesFunction<AppEnv, "size"> = ({ request, env, params }) => {
  const size = parseIconSize(String(params.size ?? ""));
  if (size === null) return errorResponse(404, "not_found", "There is no icon of that size.", {}, noStore);
  return serveIcon(request, env, size);
};
