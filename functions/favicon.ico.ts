import type { AppEnv } from "../src/server/env";
import { serveIcon } from "../src/server/icons";

/** `/favicon.ico`: browsers ask for it with no <link>. It is the 32 px app icon (PNG content, which browsers accept). */
export const onRequest: PagesFunction<AppEnv> = ({ request, env }) => serveIcon(request, env, 32);
