import type { AppEnv, RouteHandler } from "../server/env";

const assets = (env: AppEnv): Fetcher => {
  if (!env.ASSETS) throw new Error("The ASSETS binding is missing (wrangler.jsonc assets.binding).");
  return env.ASSETS;
};

/** A static file from public/, as the request names it. Passes the original request on so the asset service's own redirects (with their relative Location) survive. */
export const serveAsset: RouteHandler = ({ request, env }) => assets(env).fetch(request);

/**
 * /e/<slug>: the event page. It is one file (public/event.html) for every slug, which reads the slug from the address.
 * public/_redirects says the same, but Cloudflare does not apply it to requests the Worker handles, so it is done here.
 */
export const serveEventPage: RouteHandler = ({ request, env }) => assets(env).fetch(new Request(new URL("/event", request.url), request));
