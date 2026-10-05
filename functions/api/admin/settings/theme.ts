import { refuseUnlessAdmin } from "../../../../src/server/admin-context";
import { editFailed } from "../../../../src/server/admin-event-edit";
import { invalidInput, readEventBody } from "../../../../src/server/admin-events";
import { noStore } from "../../../../src/server/bookings";
import type { AppEnv } from "../../../../src/server/env";
import { errorResponse, json } from "../../../../src/server/http";
import { loadTheme, parseThemeInput, resetTheme, saveTheme } from "../../../../src/server/settings";

/** Replaces the theme colours; both must be sent. Colours that are hard to read are refused here, not only in the form. */
export const onRequestPut: PagesFunction<AppEnv> = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  const parsed = parseThemeInput(body);
  if ("fields" in parsed) return invalidInput(parsed.fields);
  if ("failures" in parsed) {
    return errorResponse(
      422, "theme_contrast",
      "Some text would be hard to read with those colours. Choose darker colours, or ones with a bigger difference from the page.",
      { failures: parsed.failures }, noStore,
    );
  }
  try {
    await saveTheme(env.DB, parsed.theme);
    return json({ theme: await loadTheme(env.DB) }, 200, noStore);
  } catch (e) {
    return editFailed("saveTheme", e);
  }
};

/** Goes back to the default theme; already being on it is not an error. */
export const onRequestDelete: PagesFunction<AppEnv> = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    await resetTheme(env.DB);
    return json({ theme: await loadTheme(env.DB) }, 200, noStore);
  } catch (e) {
    return editFailed("resetTheme", e);
  }
};
