/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** What Pages' ASSETS binding does, for the one thing the Functions read from it: files in public/. Anything else is a 404, as on Pages. */
export const publicAssets = (): { fetch: (request: Request) => Promise<Response>; requested: string[] } => {
  const requested: string[] = [];
  return {
    requested,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      requested.push(pathname);
      if (pathname.includes("..")) return new Response("not found", { status: 404 });
      try {
        return new Response(readFileSync(join(import.meta.dirname, "../../public", pathname)), { headers: { "Content-Type": "image/png" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  };
};
