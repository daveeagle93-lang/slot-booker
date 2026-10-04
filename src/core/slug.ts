/** Unguessable public identifier for an event (events use sequential integer ids internally). */
export function generateSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The upper bound is permissive so SQL-backfilled slugs (32 hex characters) are valid too.
export const isValidSlug = (s: string): boolean => /^[A-Za-z0-9_-]{16,64}$/.test(s);
