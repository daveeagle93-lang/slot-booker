import { utcToLondon } from "./london";

/**
 * The running order as plain text for pasting into a chat. Pure: London wall-clock times from the UTC
 * instants (never the host's time zone), British English long date, 24-hour times.
 *
 * Nothing is escaped or marked up: names are printed exactly as stored, and the text carries no formatting
 * of its own, so odd characters in a name can't reformat the message.
 */
export interface LineupInput {
  name: string;
  venuePostcode: string;
  /** The event's start; its London date heads the message. */
  startUtc: string;
  /** Slots of the schedule, each with its booking if any. Bookings outside the schedule are not passed in. */
  slots: { start: string; booking: { dogName: string; handlerName: string } | null }[];
  breaks: { start: string; end: string; label: string }[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Saturday 14 March 2026", from the London date, with no locale data involved. */
function longDate(iso: string): string {
  const [y, m, d] = utcToLondon(iso).date.split("-").map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`;
}

export function buildLineup(input: LineupInput): string {
  const items = [
    ...input.slots.map((s) => ({
      start: s.start, order: 1,
      line: `${utcToLondon(s.start).time} — ${s.booking ? `${s.booking.dogName} — ${s.booking.handlerName}` : "free"}`,
    })),
    ...input.breaks.map((b) => ({
      start: b.start, order: 0,
      line: `${utcToLondon(b.start).time}–${utcToLondon(b.end).time} — ${b.label === "" ? "Break" : b.label}`,
    })),
  ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.order - b.order));
  const head = [input.name, `${longDate(input.startUtc)} · ${input.venuePostcode}`];
  return [...head, ...(items.length > 0 ? ["", ...items.map((i) => i.line)] : [])].join("\n");
}
