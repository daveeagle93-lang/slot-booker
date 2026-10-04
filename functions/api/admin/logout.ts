import { adminAuthFor, type AdminData } from "../../../src/server/auth";
import { noStore } from "../../../src/server/bookings";
import type { AppEnv } from "../../../src/server/env";
import { json } from "../../../src/server/http";

/**
 * Behind _middleware.ts, so signed in and CSRF-checked. Sessions are stateless: this clears the browser's
 * cookie but cannot revoke a copy of it. Access sessions end at Access, so the client is sent there.
 */
export const onRequestPost: PagesFunction<AppEnv, string, AdminData> = async ({ env }) => {
  const resolved = adminAuthFor(env);
  if ("error" in resolved || resolved.auth.kind === "access") return json({ logoutUrl: "/cdn-cgi/access/logout" }, 200, noStore);
  return json({ ok: true }, 200, { ...noStore, "Set-Cookie": resolved.auth.clearCookie() });
};
