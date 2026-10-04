import { adminAuthFor, type AdminData } from "../../../src/server/auth";
import { csrfToken } from "../../../src/server/auth/csrf";
import { noStore } from "../../../src/server/bookings";
import type { AppEnv } from "../../../src/server/env";
import { json } from "../../../src/server/http";

/** Who is signed in, and the token to send as X-CSRF-Token on writes. Behind _middleware.ts, so only reached when signed in. */
export const onRequestGet: PagesFunction<AppEnv, string, AdminData> = async ({ env, data }) => {
  const resolved = adminAuthFor(env);
  const provider = "auth" in resolved ? resolved.auth.kind : null;
  return json({ identity: data.admin.identity, provider, csrfToken: await csrfToken(data.admin.csrfBinding) }, 200, noStore);
};
