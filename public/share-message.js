// The one builder for the message an admin shares about an event (Share, Copy message, the post-create page).
// Pure: no DOM, no network.
//
// The result is PLAIN TEXT built from user input (event name, details, club name). It must only ever reach the
// page through textContent or .value, navigator.share, the clipboard or encodeURIComponent: never innerHTML or
// insertAdjacentHTML.

import { formatDate, formatPounds, formatTime } from "./lib.js";

export const BUILT_IN_SHARE_TEMPLATE = "{club}\n{event}\n{date}, {start}–{end}\nVenue: {postcode}\nCost: {cost}\nBook your slot:\n{link}";

/** Every placeholder a template may use, with what it stands for. The template editor shows this list. */
export const PLACEHOLDERS = [
  { token: "{event}", meaning: "The event name" },
  { token: "{date}", meaning: "The date, for example Saturday 13 June 2026" },
  { token: "{start}", meaning: "The start time, for example 09:00" },
  { token: "{end}", meaning: "The end time, for example 16:00" },
  { token: "{cost}", meaning: "The cost, for example £12.00, or Free" },
  { token: "{postcode}", meaning: "The venue postcode" },
  { token: "{details}", meaning: "The event's details text" },
  { token: "{club}", meaning: "Your club name" },
  { token: "{link}", meaning: "The booking link" },
];

/** The event's own message, else the default template's, else the built-in one. */
export const pickShareTemplate = (event, defaultShareMessage) =>
  event.shareMessage || defaultShareMessage || BUILT_IN_SHARE_TEMPLATE;

/**
 * Fills the `{name}` placeholders of `template` from `values` in a single pass: a value is inserted literally and
 * never expanded again. Placeholders that aren't in `values` (`{foo}`, `{Event}`) are left exactly as typed. A line
 * with a known placeholder that renders to only whitespace is dropped; other lines are kept as typed.
 */
export function renderShareTemplate(template, values) {
  const lines = [];
  for (const line of String(template).replace(/\r\n/g, "\n").split("\n")) {
    let known = false;
    const rendered = line.replace(/\{([a-z]+)\}/g, (whole, name) => {
      if (!Object.hasOwn(values, name)) return whole;
      known = true;
      return String(values[name] ?? "");
    });
    if (known && rendered.trim() === "") continue;
    lines.push(rendered);
  }
  return lines.join("\n");
}

/**
 * `event` has name, startUtc, endUtc, costPence, venuePostcode and details; `template` is the text to render
 * (see pickShareTemplate). Without a {link} in the template, the link goes on its own final line.
 */
export function buildShareMessage({ event, clubName = "", link, template }) {
  const body = renderShareTemplate(template, {
    event: event.name,
    date: formatDate(event.startUtc),
    start: formatTime(event.startUtc),
    end: formatTime(event.endUtc),
    cost: formatPounds(event.costPence),
    postcode: event.venuePostcode,
    details: event.details,
    club: clubName,
    link,
  }).trimEnd();
  if (/\{link\}/.test(String(template))) return body;
  return body === "" ? link : `${body}\n${link}`;
}
