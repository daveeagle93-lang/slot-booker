/** The bindings and variables the handlers read. Wider than the generated global `Env`, which only has DB. */
export interface AppEnv {
  DB: D1Database;
  /** Pages' static-asset binding (what is in public/). Only the default icons are read through it. */
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  /** Minutes after the event's start at which bookings close (negative = before). See docs/configuration.md. */
  BOOKING_CUTOFF_OFFSET_MINUTES?: string;
  /** Plain-text privacy notice shown on the booking form. See docs/configuration.md. */
  PRIVACY_NOTICE?: string;
  /** Admin sign-in method: "access" or "password". Anything else, or unset, locks admin out. See docs/admin-auth.md. */
  ADMIN_AUTH?: string;
  /** Access only: the team's cloudflareaccess.com host. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access only: the application's AUD tag. */
  ACCESS_AUD?: string;
  /** Password only, SECRET: `hmac-sha256$...` from `npm run generate-admin-secret`. */
  ADMIN_PASSWORD_HASH?: string;
  /** Password only, SECRET: at least 32 random characters that sign the session cookie. */
  ADMIN_SESSION_SECRET?: string;
}
