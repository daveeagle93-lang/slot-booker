import { noStore } from "../server/bookings";
import type { AppEnv, RouteHandler } from "../server/env";
import { setupState } from "../server/setup";
import { plain } from "./guards";
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

/**
 * /setup: the first-run page (public/setup.html), only while setup is open (src/server/setup.ts). Fetched by its clean
 * URL without the visitor's conditional headers, so a cached copy can never answer once setup has closed, and sent no-store.
 * Closed is a plain 404; a missing or too-short SETUP_CODE gets a one-line explanation instead of the page.
 */
export const serveSetupPage: RouteHandler = async ({ request, env }) => {
  const state = await setupState(env);
  if (state === "closed") return plain(404, "Not found.");
  if (state === "not_ready") return plain(503, "Setup isn't ready: set SETUP_CODE (a phrase of at least 12 characters) as a Worker secret, then reload this page.");
  const page = await assets(env).fetch(new Request(new URL("/setup", request.url), { method: "GET" }));
  const out = new Response(page.body, page);
  for (const [name, value] of Object.entries(noStore)) out.headers.set(name, value);
  return out;
};
