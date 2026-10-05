import { previewSchedule, readEventDraft } from "../../../../server/admin-events";
import { refuseUnlessAdmin } from "../../../../server/admin-context";
import { noStore } from "../../../../server/bookings";
import type { RouteHandler } from "../../../../server/env";
import { json } from "../../../../server/http";

/** Stateless: runs the real schedule engine on the draft and stores nothing. No database access. */
export const onRequestPost: RouteHandler = async ({ request, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const draft = await readEventDraft(request, false);
  if (draft instanceof Response) return draft;
  return json(previewSchedule(draft), 200, noStore);
};
