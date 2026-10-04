/** The bindings and variables the handlers read. Wider than the generated global `Env`, which only has DB. */
export interface AppEnv {
  DB: D1Database;
  /** Minutes after the event's start at which bookings close (negative = before). See docs/configuration.md. */
  BOOKING_CUTOFF_OFFSET_MINUTES?: string;
  /** Plain-text privacy notice shown on the booking form. See docs/configuration.md. */
  PRIVACY_NOTICE?: string;
}
