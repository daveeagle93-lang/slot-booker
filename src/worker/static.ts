import type { AppEnv, RouteHandler } from "../server/env";
import { serveWithTags } from "./open-graph";

const assets = (env: AppEnv): Fetcher => {
  if (!env.ASSETS) throw new Error("The ASSETS binding is missing (wrangler.jsonc assets.binding).");
  return env.ASSETS;
};

/** A static file from public/, as the request names it. Passes the original request on so the asset service's own redirects (with their relative Location) survive. */
export const serveAsset: RouteHandler = ({ request, env }) => assets(env).fetch(request);

/** "/": the landing page (public/index.html) with the club's title and link-preview tags written in. See open-graph.ts. */
export const serveLandingPage: RouteHandler = ({ request, env }) => serveWithTags(assets(env), env.DB, request, "/", null);

/**
 * /e/<slug>: the event page, with the event's title and link-preview tags written in (generic ones for an unknown, invalid or
 * archived slug). It is one file (public/event.html) for every slug, which reads the slug from the address.
 * public/_redirects says the same, but Cloudflare does not apply it to requests the Worker handles, so it is done here.
 */
export const serveEventPage: RouteHandler<"slug"> = ({ request, env, params }) =>
  serveWithTags(assets(env), env.DB, request, "/event", String(params.slug));
