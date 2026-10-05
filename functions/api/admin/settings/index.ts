import { refuseUnlessAdmin } from "../../../../src/server/admin-context";
import { editFailed } from "../../../../src/server/admin-event-edit";
import { invalidInput, readEventBody } from "../../../../src/server/admin-events";
import { noStore } from "../../../../src/server/bookings";
import type { AppEnv } from "../../../../src/server/env";
import { json } from "../../../../src/server/http";
import { loadAdminSettings, parseSettingsInput, saveSettings } from "../../../../src/server/settings";

export const onRequestGet: PagesFunction<AppEnv> = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    return json(await loadAdminSettings(env.DB), 200, noStore);
  } catch (e) {
    return editFailed("loadAdminSettings", e);
  }
};

/** Replaces the club name, privacy contact and website together; all three must be sent. */
export const onRequestPut: PagesFunction<AppEnv> = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  const parsed = parseSettingsInput(body);
  if ("fields" in parsed) return invalidInput(parsed.fields);
  try {
    await saveSettings(env.DB, parsed.settings);
    return json(await loadAdminSettings(env.DB), 200, noStore);
  } catch (e) {
    return editFailed("saveSettings", e);
  }
};
