import { previewSchedule, readEventDraft } from "../../../../src/server/admin-events";
import { refuseUnlessAdmin } from "../../../../src/server/admin-context";
import { noStore } from "../../../../src/server/bookings";
import type { AppEnv } from "../../../../src/server/env";
import { json } from "../../../../src/server/http";

/** Stateless: runs the real schedule engine on the draft and stores nothing. No database access. */
export const onRequestPost: PagesFunction<AppEnv> = async ({ request, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const draft = await readEventDraft(request, false);
  if (draft instanceof Response) return draft;
  return json(previewSchedule(draft), 200, noStore);
};
