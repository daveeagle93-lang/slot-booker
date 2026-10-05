/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** What the ASSETS binding does, for the one thing the handlers read from it: files in public/. Anything else is a 404. */
export const publicAssets = (): Fetcher & { requested: string[] } => {
  const requested: string[] = [];
  return {
    requested,
    async fetch(request: Request) {
      const { pathname } = new URL(request.url);
      requested.push(pathname);
      if (pathname.includes("..")) return new Response("not found", { status: 404 });
      try {
        return new Response(readFileSync(join(import.meta.dirname, "../../public", pathname)), { headers: { "Content-Type": "image/png" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  } as Fetcher & { requested: string[] };
};
