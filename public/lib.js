// Pure helpers: no DOM, no network. Everything is shown in London time, whatever the device's timezone.

const TZ = "Europe/London";
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** "09:00" */
export const formatTime = (iso) => timeFmt.format(new Date(iso));

/** "Saturday 13 June 2026" (built from parts, as the separator punctuation varies between ICU versions) */
export function formatDate(iso) {
  const p = Object.fromEntries(dateFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** "09:00–16:00" */
export const formatTimeRange = (startIso, endIso) => `${formatTime(startIso)}–${formatTime(endIso)}`;

// Duplicate of src/core/format.ts (the browser can't import it without a build); lib.test.ts checks they agree.
export function formatPounds(pence) {
  if (!Number.isInteger(pence) || pence < 0) {
    throw new RangeError(`pence must be a non-negative integer, got ${pence}`);
  }
  if (pence === 0) return "Free";
  const pounds = Math.floor(pence / 100).toLocaleString("en-GB");
  return `£${pounds}.${String(pence % 100).padStart(2, "0")}`;
}

/** The slug from "/e/<slug>" (trailing slash allowed), or null. */
export function slugFromPathname(pathname) {
  const m = /^\/e\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m ? m[1] : null;
}

export const mapsUrl = (postcode) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(postcode)}`;

export const slotsLeftText = (n) => (n === 0 ? "Fully booked" : n === 1 ? "1 slot left" : `${n} slots left`);

/** Plain-text booking summary for the clipboard. */
export function copyText(event, booking) {
  const lines = [
    event.name,
    `${formatDate(booking.slot.start)}, ${formatTimeRange(booking.slot.start, booking.slot.end)}`,
    `Dog: ${booking.dogName}`,
    `Handler: ${booking.handlerName}`,
    `Venue: ${event.venuePostcode}`,
    `Cost: ${formatPounds(event.costPence)}`,
  ];
  if (event.details) lines.push(event.details);
  return lines.join("\n");
}
