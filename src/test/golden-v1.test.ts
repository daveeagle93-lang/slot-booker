/// <reference types="node" />
// BACK-COMPAT REPLAY of the v1.0 golden outputs (src/test/fixtures/v1-golden, captured from commit 7810f8c: see its README.md).
// It builds a local D1 migrated to 0014 only (as a v1.0 deployment is), loads the golden fixture's seed.sql, applies
// the remaining migrations (0015 to 0018: the bookings rebuild for lanes and places, then the booking form's fields, with real
// `wrangler d1 migrations apply`), then replays the same scenario as the capture script (the real Worker handlers and the real
// booking.js / schedule.js in happy-dom, same fixed clock, same normalisation) against the CURRENT code, and compares every output
// with the committed file. Text outputs (HTML, text, CSV, .ics with its UID, lineup, share, privacy) must be byte-identical.
// JSON outputs must be identical except for keys the current code ADDS and that are listed, with the reason, in ALLOWED_ADDITIONS
// below. Nothing else may differ, and an entry that no longer matches anything fails too. The fixture files are never rewritten here.
//
// Since 0018 the booking form's fields are configurable, which changes the PUBLIC JSON shapes (dogName and handlerName became
// field1 and field2, and a booking carries `fields: [{ label, value }]`) and the booking page's DOM attribute names (the ids,
// names and so on are derived from the field's position). The migrated v1.0 events have the fields Dog and Handler, so the replay
// can say the same things in the new words and translate the answers back. Everything that translates or allows is in this file's
// ADAPTERS and WORDING tables below, each with its reason, and each must be USED by the replay or the last test fails:
//   - REQUEST adapter (adaptRequest): the public POST bodies of the scenario are v1.0's (dogName, handlerName) and are sent as
//     field1 and field2. The admin requests are NOT adapted: the admin API still accepts the v1.0 names (TRANSITIONAL(6b)).
//   - RESPONSE normalisers (legacyPublic, legacyCall): new -> v1.0 shape, public answers only, and only when the labels really
//     are Dog and Handler (anything else throws): `booking.fields` -> dogName and handlerName, the error keys field1 and field2 ->
//     dogName and handlerName, and the page's own request bodies in the logged calls.
//   - DOM normaliser (legacyDom): the booking page's ids, names, `for` and `aria-describedby` that are derived from the position
//     (field-1 and so on), listed one by one, applied to the booking page's innerHTML only. textContent is never normalised.
//   - WORDING table (WORDING): the only text that may differ: the decision-1 changes (form titles are the bare label, "{Label} is
//     required.") and the same bare label in the other validation messages, and the default privacy notice (decision 5).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPrivacyNotice } from "../server/config";
import { NOW, ORIGIN, passwordEnv, TEST_PASSWORD } from "../server/auth/test-harness";
import { createWorker } from "../worker";
import { init as initBooking } from "../../public/booking.js";
import { init as initSchedule } from "../../public/admin/schedule.js";
import { loadSettings } from "../../public/branding.js";
import { formatTime } from "../../public/lib.js";
import { buildShareMessage, BUILT_IN_SHARE_TEMPLATE, pickShareTemplate } from "../../public/share-message.js";
import { createStagedDb, type StagedDb } from "./staged-db";

const FIXTURES = join(import.meta.dirname, "fixtures/v1-golden");

// ---------------------------------------------------------------------------------------------------------------------
// What the current code may ADD to a JSON output. Each entry is a key path (array positions written as [], any one key as
// *) that may appear in the current output but not in the v1.0 file, in the files whose name matches. A path that is not
// listed here is a failure when it appears, and an entry that matches nothing is a failure too.
// ---------------------------------------------------------------------------------------------------------------------
interface Allowed { files: RegExp; path: string; why: string }
const ALLOWED_ADDITIONS: Allowed[] = [
  { files: /^public-api\/event-(?!not-found)/, path: "body.event.lanes", why: "the public event now lists its lanes (id and name) so a booker can choose one" },
  { files: /^public-api\/event-(?!not-found)/, path: "body.event.capacity", why: "the public event now says how many places each lane has at each time" },
  { files: /^public-api\/event-(?!not-found)/, path: "body.slots[].places", why: "every slot now says how many places are free in each lane" },
  { files: /^public-api\/post-(bookings|slot-started)\.json$/, path: "*.body.booking.lane", why: "the booking answer now names the lane that was booked" },
  { files: /^public-api\/post-(bookings|slot-started)\.json$/, path: "*.body.event.lanes", why: "the event summary in a booking answer carries the lanes, as the public event does" },
  { files: /^public-api\/post-(bookings|slot-started)\.json$/, path: "*.body.event.capacity", why: "the event summary in a booking answer carries the capacity, as the public event does" },
  { files: /^public-api\/post-(bookings|slot-started)\.json$/, path: "*.body.freeSlots[].places", why: "the free slots in a slot_taken or slot_started answer carry their places, as the public event's slots do" },
  // Admin side: lanes and capacity are described next to the event, and every booking the admin API shows names its lane.
  { files: /^admin-api\/events-list\.json$/, path: "body.events[].laneCount", why: "the admin list says how many lanes each upcoming event has" },
  { files: /^admin-api\/events-list\.json$/, path: "body.events[].lanes", why: "the admin list names each upcoming event's lanes so Share can fill {lanes}" },
  { files: /^admin-api\/events-list\.json$/, path: "body.events[].capacity", why: "the admin list says how many places each lane has at each time" },
  { files: /^admin-api\/events-list\.json$/, path: "body.events[].placeCount", why: "the admin list says how many places the event has in all (times x lanes x places per lane)" },
  { files: /^admin-api\/detail-/, path: "body.event.lanes", why: "the admin detail lists the event's lanes (id and name) for the edit form" },
  { files: /^admin-api\/detail-/, path: "body.event.capacity", why: "the admin detail gives the places per lane per time for the edit form" },
  { files: /^admin-api\/(orphan-actions|event-edit)\.json$/, path: "*.body.event.lanes", why: "an event as the admin API returns it (detail or saved edit) lists its lanes" },
  { files: /^admin-api\/(orphan-actions|event-edit)\.json$/, path: "*.body.event.capacity", why: "an event as the admin API returns it (detail or saved edit) gives its capacity" },
  { files: /^admin-api\/(detail-|orphan-actions)/, path: "body.orphans[].lane", why: "an orphan booking names its lane, as every booking in the admin API does" },
  { files: /^admin-api\/orphan-actions\.json$/, path: "*.body.orphans[].lane", why: "an orphan booking names its lane, as every booking in the admin API does" },
  { files: /^admin-api\/templates-list\.json$/, path: "body.templates[].lanes", why: "a template lists its lanes (names only)" },
  { files: /^admin-api\/templates-list\.json$/, path: "body.templates[].capacity", why: "a template gives its places per lane per time" },
  { files: /^admin-api\/template-\d+\.json$/, path: "body.template.lanes", why: "a template lists its lanes (names only)" },
  { files: /^admin-api\/template-\d+\.json$/, path: "body.template.capacity", why: "a template gives its places per lane per time" },
  { files: /^admin-api\/bookings-(add|move)\.json$/, path: "*.body.booking.lane", why: "a booking added or moved by the admin names its lane" },
  { files: /^admin-api\/orphan-actions\.json$/, path: "*.body.booking.lane", why: "a booking added by the admin names its lane" },
  { files: /^admin-api\/bookings-clear\.json$/, path: "*.body.removed.lane", why: "a booking cleared by the admin names its lane" },
  { files: /^admin-api\/event-edit\.json$/, path: "*.body.affected[].lane", why: "a booking an edit would strand names its lane" },
  { files: /^admin-api\/event-edit\.json$/, path: "*.body.removed[].lane", why: "a booking an edit removed names its lane" },
  { files: /^admin-api\/detail-/, path: "body.slots[].places", why: "every slot of the admin detail lists, per lane, the bookings there and how many places are free" },
  { files: /^admin-api\/(orphan-actions|event-edit)\.json$/, path: "*.body.slots[].places", why: "every slot of the admin detail lists, per lane, the bookings there and how many places are free" },
  { files: /^admin-api\/bookings-(add|move)\.json$/, path: "*.body.bookings", why: "a slot_taken answer lists everyone who holds a place in the lane at that time (the v1.0 `booking` key stays for one lane and one place)" },
  { files: /^admin-api\/bookings-swap\.json$/, path: "*.body.a.lane", why: "a swapped booking says which lane it is in now (a swap can change the lane)" },
  { files: /^admin-api\/bookings-swap\.json$/, path: "*.body.b.lane", why: "a swapped booking says which lane it is in now (a swap can change the lane)" },
  // The booking form's fields (0018). The public side is translated back by the RESPONSE normalisers; what is added is listed here.
  { files: /^public-api\/event-(?!not-found)/, path: "body.event.fields", why: "the public event lists the booking form's fields (position, label, required, longest value; never which identify a booking) so the page can render them" },
  { files: /^public-api\/post-(bookings|slot-started)\.json$/, path: "*.body.event.fields", why: "the event summary in a booking answer carries the fields, as the public event does" },
  // Admin side: the first two values of every booking are still sent as dogName and handlerName (TRANSITIONAL(6b)), with the labelled `fields` beside them.
  { files: /^admin-api\/events-list\.json$/, path: "body.events[].fields", why: "the admin list gives each upcoming event's booking form fields" },
  { files: /^admin-api\/events-list\.json$/, path: "body.events[].identityLimit", why: "the admin list gives how many bookings one identity may hold" },
  { files: /^admin-api\/detail-/, path: "body.event.fields", why: "the admin detail lists the event's booking form fields for the edit form" },
  { files: /^admin-api\/detail-/, path: "body.event.identityLimit", why: "the admin detail gives how many bookings one identity may hold" },
  { files: /^admin-api\/(orphan-actions|event-edit)\.json$/, path: "*.body.event.fields", why: "an event as the admin API returns it (detail or saved edit) lists its booking form fields" },
  { files: /^admin-api\/(orphan-actions|event-edit)\.json$/, path: "*.body.event.identityLimit", why: "an event as the admin API returns it (detail or saved edit) gives its identity limit" },
  { files: /^admin-api\/(detail-|orphan-actions)/, path: "body.orphans[].fields", why: "an orphan booking lists its values by label, as every booking in the admin API does" },
  { files: /^admin-api\/orphan-actions\.json$/, path: "*.body.orphans[].fields", why: "an orphan booking lists its values by label, as every booking in the admin API does" },
  { files: /^admin-api\/detail-/, path: "body.slots[].booking.fields", why: "the slot's v1.0 `booking` lists its values by label, as every booking in the admin API does" },
  { files: /^admin-api\/(orphan-actions|event-edit)\.json$/, path: "*.body.slots[].booking.fields", why: "the slot's v1.0 `booking` lists its values by label, as every booking in the admin API does" },
  { files: /^admin-api\/bookings-(add|move)\.json$/, path: "*.body.booking.fields", why: "a booking added or moved by the admin (or the one holding an identity) lists its values by label" },
  { files: /^admin-api\/orphan-actions\.json$/, path: "*.body.booking.fields", why: "a booking added by the admin lists its values by label" },
  { files: /^admin-api\/bookings-clear\.json$/, path: "*.body.removed.fields", why: "a booking cleared by the admin lists its values by label" },
  { files: /^admin-api\/event-edit\.json$/, path: "*.body.affected[].fields", why: "a booking an edit would strand lists its values by label" },
  { files: /^admin-api\/event-edit\.json$/, path: "*.body.removed[].fields", why: "a booking an edit removed lists its values by label" },
  { files: /^admin-api\/bookings-add\.json$/, path: "*.body.fields.field1", why: "the admin add also keys the first value's error by its number (dogName stays, TRANSITIONAL(6b))" },
  { files: /^admin-api\/bookings-add\.json$/, path: "*.body.fields.field2", why: "the admin add also keys the second value's error by its number (handlerName stays, TRANSITIONAL(6b))" },
  { files: /^admin-api\/templates-list\.json$/, path: "body.templates[].fields", why: "a template lists its booking form fields" },
  { files: /^admin-api\/templates-list\.json$/, path: "body.templates[].identityLimit", why: "a template gives how many bookings one identity may hold" },
  { files: /^admin-api\/template-\d+\.json$/, path: "body.template.fields", why: "a template lists its booking form fields" },
  { files: /^admin-api\/template-\d+\.json$/, path: "body.template.identityLimit", why: "a template gives how many bookings one identity may hold" },
];

// ---------------------------------------------------------------------------------------------------------------------
// WORDING: the only text that may differ from v1.0. Each row says: in the files matching `files`, the golden text `old` is now
// `now`. The golden file is never rewritten: the row is applied to what was read from it before the comparison, so a file whose
// text differs in any other way, or where the old text is still there, fails. A row that matches nothing fails too.
// ---------------------------------------------------------------------------------------------------------------------
interface Worded { files: RegExp; old: string; now: string; why: string }
// Where the validation messages show: the public JSON, the booking page (its error paragraphs), the admin add's JSON and the admin schedule's add panel.
const MESSAGES_IN = /^(public-api\/post-invalid-input\.json|booking-page\/.*\.(html|txt)|admin-api\/bookings-add\.json|admin-schedule\/e1-add-submitted-empty\.(html|txt)|admin-schedule-flows\/add-invalid-input\.(html|txt))$/;
const REQUIRED = "decision 1: the required error is \"{Label} is required.\"";
const BARE = "decision 1: the other validation messages use the same bare label";
const WORDING: Worded[] = [
  { files: /^booking-page(-flows)?\/.*\.(html|txt)$/, old: "Dog's name", now: "Dog", why: "decision 1: the booking form's field title is the bare label" },
  { files: /^booking-page(-flows)?\/.*\.(html|txt)$/, old: "Handler's name", now: "Handler", why: "decision 1: the booking form's field title is the bare label" },
  { files: MESSAGES_IN, old: "Enter the dog's name.", now: "Dog is required.", why: REQUIRED },
  { files: MESSAGES_IN, old: "Enter the handler's name.", now: "Handler is required.", why: REQUIRED },
  { files: MESSAGES_IN, old: "The dog's name must be at most 80 characters.", now: "Dog must be at most 80 characters.", why: BARE },
  { files: MESSAGES_IN, old: "The handler's name must be at most 80 characters.", now: "Handler must be at most 80 characters.", why: BARE },
  { files: MESSAGES_IN, old: "The dog's name can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.",
    now: "Dog can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.", why: BARE },
  { files: MESSAGES_IN, old: "The handler's name can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.",
    now: "Handler can't contain invisible or direction-changing characters. Some emoji and flags contain invisible joiners and are not accepted; try plain text.", why: BARE },
  { files: MESSAGES_IN, old: "The dog's name can't contain line or paragraph separators.", now: "Dog can't contain line or paragraph separators.", why: BARE },
  { files: MESSAGES_IN, old: "The dog's name can't contain control characters.", now: "Dog can't contain control characters.", why: BARE },
  { files: MESSAGES_IN, old: "The dog's name can't contain unpaired surrogate characters.", now: "Dog can't contain unpaired surrogate characters.", why: BARE },
  { files: MESSAGES_IN, old: "The dog's name must contain at least one letter or number.", now: "Dog must contain at least one letter or number.", why: BARE },
  { files: MESSAGES_IN, old: "The handler's name must contain at least one letter or number.", now: "Handler must contain at least one letter or number.", why: BARE },
  { files: MESSAGES_IN, old: "The dog's name can't contain private-use or blank-looking characters. Try plain text.", now: "Dog can't contain private-use or blank-looking characters. Try plain text.", why: BARE },
  { files: /^(privacy\/.*\.txt|public-api\/event-.*\.json|booking-page(-flows)?\/.*\.(html|txt))$/,
    old: "We store your name, your dog's name and the slot you choose so the club can run the event.",
    now: "We store the details you enter on this form (Dog, Handler) and the slot you choose so the club can run the event.",
    why: "decision 5: the default privacy notice is built from the labels of the form; only its first sentence names the fields, the rest is v1.0's" },
];
const wordingHits = new Map<Worded, Set<string>>(WORDING.map((w) => [w, new Set<string>()]));
const worded = (rel: string, golden: string): string => {
  let out = golden;
  for (const w of WORDING) {
    if (!w.files.test(rel) || !out.includes(w.old)) continue;
    wordingHits.get(w)!.add(rel);
    out = out.replaceAll(w.old, w.now);
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// ADAPTERS: translations between the v1.0 shapes the scenario is written in and the current ones. Every use is counted.
// ---------------------------------------------------------------------------------------------------------------------
const adapterHits = new Map<string, number>();
const used = (name: string) => adapterHits.set(name, (adapterHits.get(name) ?? 0) + 1);
const ADAPTERS = [
  "request: public POST dogName -> field1", "request: public POST handlerName -> field2",
  "response: booking.fields -> dogName and handlerName", "response: error key field1 -> dogName", "response: error key field2 -> handlerName",
  "call log: page request field1 -> dogName", "call log: page request field2 -> handlerName",
  "dom: <label for=field-1>", "dom: <label for=field-2>", "dom: input id field-1", "dom: input id field-2", "dom: input name field1", "dom: input name field2",
  "dom: input aria-describedby field-1-error", "dom: input aria-describedby field-2-error", "dom: error id field-1-error", "dom: error id field-2-error",
  "dom: handler input autocomplete off -> name",
];

/** REQUEST adapter: a v1.0 public booking body (dogName, handlerName) as the current public API takes it (field1, field2). Anything else is left alone. */
function adaptRequest(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "dogName") { used("request: public POST dogName -> field1"); out.field1 = v; }
    else if (k === "handlerName") { used("request: public POST handlerName -> field2"); out.field2 = v; }
    else out[k] = v;
  }
  return out;
}

const isDogHandler = (labels: string[]) => labels.length === 2 && labels[0] === "Dog" && labels[1] === "Handler";

/**
 * RESPONSE normaliser: a public answer as v1.0 shaped it. `booking.fields` (labelled values) becomes dogName and handlerName and the
 * error keys field1 and field2 become dogName and handlerName. It only exists for the labels Dog and Handler: anything else throws,
 * so a changed label or a third field can never be hidden by it. `event.fields` is not touched (it is an allowed addition).
 */
function legacyPublic(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const out: Record<string, any> = { ...(body as object) };
  if (out.booking && Array.isArray(out.booking.fields)) {
    const { fields, ...rest } = out.booking;
    if (!isDogHandler(fields.map((f: { label: string }) => f.label))) throw new Error(`the v1.0 shape only exists for the labels Dog and Handler, got ${JSON.stringify(fields)}`);
    used("response: booking.fields -> dogName and handlerName");
    out.booking = { ...rest, dogName: fields[0].value, handlerName: fields[1].value };
  }
  if (out.fields && typeof out.fields === "object" && !Array.isArray(out.fields)) {
    const renamed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.fields)) {
      if (k === "field1") { used("response: error key field1 -> dogName"); renamed.dogName = v; }
      else if (k === "field2") { used("response: error key field2 -> handlerName"); renamed.handlerName = v; }
      else if (/^field\d$/.test(k)) throw new Error(`the v1.0 shape only exists for two fields, got ${k}`);
      else renamed[k] = v;
    }
    out.fields = renamed;
  }
  return out;
}

/** The booking page's own request body as it is written in the call log: field1 and field2 as v1.0 named them. */
function legacyCall(url: string, method: string, logged: any): any {
  if (method !== "POST" || !/^\/api\/events\/[^/]+\/bookings$/.test(url) || !logged || typeof logged !== "object") return logged;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(logged)) {
    if (k === "field1") { used("call log: page request field1 -> dogName"); out.dogName = v; }
    else if (k === "field2") { used("call log: page request field2 -> handlerName"); out.handlerName = v; }
    else if (/^field\d$/.test(k)) throw new Error(`the v1.0 shape only exists for two fields, got ${k}`);
    else out[k] = v;
  }
  return out;
}

/**
 * DOM normaliser for the booking page's innerHTML: the attributes that are now derived from the field's position, one by one.
 * Only these exact attributes are rewritten (the input's id, name and aria-describedby, its error paragraph's id, the label's `for`,
 * and the second input's autocomplete, which was "name" for a handler's name and is "off" for every field now: a stored label can't
 * tell the browser what kind of value it is). Every other attribute, and all text, must be the same as v1.0's.
 */
function legacyDom(html: string): string {
  let out = html.replace(/(<input id="field-2"[^>]*?) autocomplete="off"/g, (_m, head) => { used("dom: handler input autocomplete off -> name"); return `${head} autocomplete="name"`; });
  const swap = (name: string, from: string, to: string) => { out = out.replaceAll(from, () => { used(name); return to; }); };
  swap("dom: <label for=field-1>", 'for="field-1"', 'for="dog-name"');
  swap("dom: <label for=field-2>", 'for="field-2"', 'for="handler-name"');
  swap("dom: input id field-1", 'id="field-1"', 'id="dog-name"');
  swap("dom: input id field-2", 'id="field-2"', 'id="handler-name"');
  swap("dom: input name field1", 'name="field1"', 'name="dog"');
  swap("dom: input name field2", 'name="field2"', 'name="handler"');
  swap("dom: input aria-describedby field-1-error", 'aria-describedby="field-1-error"', 'aria-describedby="dog-error"');
  swap("dom: input aria-describedby field-2-error", 'aria-describedby="field-2-error"', 'aria-describedby="handler-error"');
  swap("dom: error id field-1-error", 'id="field-1-error"', 'id="dog-error"');
  swap("dom: error id field-2-error", 'id="field-2-error"', 'id="handler-error"');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output helpers: `save` compares one output with the golden file of the same name instead of writing it
// ---------------------------------------------------------------------------------------------------------------------
const compared = new Set<string>();
const hits = new Map<Allowed, Set<string>>(ALLOWED_ADDITIONS.map((a) => [a, new Set<string>()]));
const failures: string[] = [];

/** Where `actual` has a key `expected` lacks, or differs in value, type, array length or missing key: the paths of both kinds. */
function diffJson(expected: unknown, actual: unknown, path: string[], out: { added: string[]; other: string[] }): void {
  const here = path.join(".").replace(/\.\[\]/g, "[]");
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.other.push(`${here}: array length ${expected.length} became ${actual.length}`);
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) diffJson(expected[i], actual[i], [...path, "[]"], out);
  } else if (expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) out.other.push(`${[...path, k].join(".").replace(/\.\[\]/g, "[]")}: key removed`);
      else diffJson((expected as any)[k], (actual as any)[k], [...path, k], out);
    }
    for (const k of Object.keys(actual)) if (!(k in expected)) out.added.push([...path, k].join(".").replace(/\.\[\]/g, "[]"));
  } else if (!Object.is(expected, actual)) {
    out.other.push(`${here}: ${JSON.stringify(expected)} became ${JSON.stringify(actual)}`);
  }
}
const matchesPattern = (pattern: string, path: string): boolean =>
  new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.[\]]/g, "\\$&")).join("[^.]+")}$`).test(path);

function save(rel: string, content: string, _description?: string) {
  if (compared.has(rel)) throw new Error(`compared twice: ${rel}`);
  compared.add(rel);
  const golden = worded(rel, readFileSync(join(FIXTURES, rel), "utf8"));
  if (!rel.endsWith(".json")) {
    if (content !== golden) failures.push(`${rel}: differs from the golden file\n--- golden\n${golden}\n--- now\n${content}`);
    return;
  }
  const out = { added: [] as string[], other: [] as string[] };
  diffJson(JSON.parse(golden), JSON.parse(content), [], out);
  for (const path of out.added) {
    const entry = ALLOWED_ADDITIONS.find((a) => a.files.test(rel) && matchesPattern(a.path, path));
    if (entry) hits.get(entry)!.add(rel);
    else out.other.push(`${path}: key added and not allowed`);
  }
  for (const problem of out.other) failures.push(`${rel}: ${problem}`);
}
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as any)[k])]))
      : v;
const saveJson = (rel: string, value: unknown, description?: string) =>
  save(rel, `${JSON.stringify(sortKeys(value), null, 2)}\n`, description);

// ---------------------------------------------------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------------------------------------------------
const CLOCK = "2026-10-01T12:00:00Z"; // every capture runs at this instant unless a scenario says otherwise
const CLUB = "Hillside Agility Club";
const SLUG = {
  e1: "saturday-trial-2026-10-17",
  e2: "evening-run-2026-10-20",
  e3: "winter-fun-day-2026-12-05",
  e4: "members-ring-time-2026-11-07",
  e5: "summer-agility-day-2026-09-12",
  none: "no-such-event-0000000000",
};
// Event 1: 2026-10-17 (BST) 09:00-15:00 London, 30 minute sessions, 5 minute gap, Tea 10:30-10:45. UTC starts of its nine slots, by London time:
const T = {
  "0900": "2026-10-17T08:00:00Z", "0935": "2026-10-17T08:35:00Z", "1045": "2026-10-17T09:45:00Z", "1120": "2026-10-17T10:20:00Z",
  "1155": "2026-10-17T10:55:00Z", "1230": "2026-10-17T11:30:00Z", "1305": "2026-10-17T12:05:00Z", "1340": "2026-10-17T12:40:00Z",
  "1415": "2026-10-17T13:15:00Z",
};
const tokenOf = (id: number) => `tok-b${String(id).padStart(2, "0")}-0123456789abcdef`;
const FIXTURE_TOKENS = new Set(Array.from({ length: 16 }, (_, i) => tokenOf(i + 1))); // the seeded bookings 1 to 16

// A database migrated to 0014 and holding the golden seed, then taken through 0015 to 0018 by `wrangler d1 migrations apply`:
// what a v1.0 deployment looks like after updating. Built once; each scenario works on its own copy.
let migrated: StagedDb;
beforeAll(async () => {
  const v1 = await createStagedDb("0014");
  // One statement per line (the fixture's own rule), so a semicolon inside a text value is not a split point.
  const seed = readFileSync(join(FIXTURES, "seed.sql"), "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith("--"));
  await v1.env.DB.batch(seed.map((s) => v1.env.DB.prepare(s)));
  await v1.applyThrough("0018");
  migrated = v1;
}, 300_000);
afterAll(async () => { await migrated?.dispose(); });

async function freshEnv() {
  const copy = await migrated.fork();
  return { env: copy.env, dispose: () => copy.dispose() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Driving the Worker
// ---------------------------------------------------------------------------------------------------------------------
const worker = createWorker({ now: () => NOW });
let loginCount = 0;

/** The Worker's environment for a database (password provider), optionally with the booking cut-off set. */
async function appEnv(db: D1Database, extra: Record<string, string> = {}) {
  return { ...(await passwordEnv(db)), ...extra };
}

async function adminSession(env: any) {
  const login = await worker.fetch(new Request(`${ORIGIN}/api/admin/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${10 + ++loginCount}` },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  }), env);
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const session = await (await worker.fetch(new Request(`${ORIGIN}/api/admin/session`, { headers: { Cookie: cookie } }), env)).json() as { csrfToken: string };
  return { cookie, csrf: session.csrfToken };
}

/** The fetch the pages use: same-origin, so the browser's Origin and cookie are added. */
function pageFetch(env: any, session?: { cookie: string; csrf: string }) {
  const calls: any[] = [];
  let pending = 0;
  const fetchImpl = async (url: string, init: any = {}) => {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers ?? {});
    headers.set("Origin", ORIGIN);
    if (session) headers.set("Cookie", session.cookie);
    let body = init.body;
    let logged: any = null;
    if (typeof body === "string") { try { logged = JSON.parse(body); } catch { logged = body; } if (logged && logged.idempotencyKey) logged = { ...logged, idempotencyKey: "<key>" }; }
    calls.push({ method, url, body: legacyCall(url, method, logged) });
    pending++;
    try {
      return await worker.fetch(new Request(`${ORIGIN}${url}`, { method, headers, body }), env);
    } finally { pending--; }
  };
  const idle = async () => {
    for (let quiet = 0; quiet < 3;) {
      await new Promise((r) => setTimeout(r, 25));
      quiet = pending === 0 ? quiet + 1 : 0;
    }
  };
  return { fetchImpl, calls, idle };
}

const norm = (s: string): string =>
  s.replace(/\/bookings\/([A-Za-z0-9_-]{16,64})\/ics/g, (m, tok) => (FIXTURE_TOKENS.has(tok) ? m : "/bookings/<token>/ics"));
const normDeep = (v: unknown): unknown =>
  typeof v === "string" ? norm(v) : Array.isArray(v) ? v.map(normDeep)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normDeep(x)])) : v;

const KEEP_HEADERS = ["content-type", "cache-control", "idempotent-replayed", "content-disposition", "allow"];
async function snap(res: Response) {
  const headers = Object.fromEntries(KEEP_HEADERS.filter((h) => res.headers.has(h)).map((h) => [h, res.headers.get(h)]));
  const text = await res.text();
  let body: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json")) body = JSON.parse(text);
  return { status: res.status, headers, body: normDeep(body) };
}

interface Ctx { env: any; session?: { cookie: string; csrf: string } }
async function call(c: Ctx, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (path.startsWith("/api/admin") && c.session) {
    headers.Cookie = c.session.cookie;
    if (method !== "GET") { headers.Origin = ORIGIN; headers["X-CSRF-Token"] = c.session.csrf; }
  }
  let payload: string | undefined;
  if (body !== undefined) {
    if (!("Content-Type" in headers)) headers["Content-Type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: payload }), c.env);
}
const callSnap = async (c: Ctx, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  snap(await call(c, method, path, body, extra));

// ---------------------------------------------------------------------------------------------------------------------
// Driving the pages (happy-dom)
// ---------------------------------------------------------------------------------------------------------------------
const pretty = (html: string) => html.replace(/></g, ">\n<");
const IDLE_EVENT_OPTS = { bubbles: true, cancelable: true };

function newWindow() {
  const window = new Window({ url: `${ORIGIN}/` });
  window.document.body.innerHTML = '<main id="app"></main>';
  return window;
}

/** `normalise` rewrites the page's innerHTML before it is compared (the booking page's legacyDom); the text is never rewritten. */
function makeDomSaver(dir: string, pageName: string, normalise: (html: string) => string = (html) => html) {
  const meta: Record<string, unknown> = {};
  return {
    meta,
    /** Writes `<dir>/<state>.html` (pretty innerHTML of <body>) and `<dir>/<state>.txt` (textContent of <body>). */
    state(name: string, window: any, description: string, extra: Record<string, unknown> = {}) {
      const doc = window.document;
      save(`${dir}/${name}.html`, `${pretty(norm(normalise(doc.body.innerHTML)))}\n`, `${pageName}, ${description}: innerHTML of <body>, with each ">" followed directly by "<" broken onto a new line`);
      save(`${dir}/${name}.txt`, `${norm(doc.body.textContent)}\n`, `${pageName}, ${description}: textContent of <body>`);
      meta[name] = normDeep({ title: doc.title, ...extra });
    },
    finish() {
      saveJson(`${dir}/_meta.json`, meta, `${pageName}: per state, the document title and the requests the page made (idempotency keys shown as "<key>"), plus clipboard writes where relevant`);
    },
  };
}

async function openBooking(c: Ctx, slug: string, clip: string[] = []) {
  const window = newWindow();
  const net = pageFetch(c.env, c.session);
  const clipboard = { writeText: async (t: string) => { clip.push(t); } };
  await initBooking({
    document: window.document, fetch: net.fetchImpl, location: { pathname: `/e/${slug}` }, clipboard,
    settings: loadSettings(net.fetchImpl) as any,
  });
  await net.idle();
  return { window, doc: window.document, net, clip, $: (s: string): any => window.document.querySelector(s) };
}
const slotButton = (page: any, utc: string) =>
  [...page.doc.querySelectorAll(".slot-grid button")].find((b: any) => b.textContent.startsWith(formatTime(utc)));
const typeInto = (page: any, sel: string, value: string) => { page.$(sel).value = value; };
const submitBooking = async (page: any) => {
  page.$("#booking-form").dispatchEvent(new page.window.Event("submit", IDLE_EVENT_OPTS));
  await page.net.idle();
};

async function openSchedule(c: Ctx, slug: string, clip: string[] = []) {
  const window = newWindow();
  const net = pageFetch(c.env, c.session);
  const navigated: string[] = [];
  const clipboard = { writeText: async (t: string) => { clip.push(t); } };
  await initSchedule({
    document: window.document, fetch: net.fetchImpl, navigate: (u: string) => navigated.push(u), clipboard,
    location: { origin: ORIGIN, search: `?slug=${slug}` }, settings: loadSettings(net.fetchImpl) as any,
  });
  await net.idle();
  return { window, doc: window.document, net, clip, navigated, $: (s: string): any => window.document.querySelector(s) };
}
const opener = (page: any, key: string, action: string) => page.doc.querySelector(`[data-key="${key}"] [data-action="${action}"]`);
const buttonByText = (page: any, text: string) => [...page.doc.querySelectorAll("button")].find((b: any) => b.textContent === text);
const submitForm = async (page: any, form: any) => {
  form.dispatchEvent(new page.window.Event("submit", IDLE_EVENT_OPTS));
  await page.net.idle();
};

// ---------------------------------------------------------------------------------------------------------------------
describe("the v1.0 golden outputs, replayed against the current code on a migrated v1.0 database", () => {
  let current: Awaited<ReturnType<typeof freshEnv>> | null = null;
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(CLOCK)); });
  afterEach(async () => { vi.useRealTimers(); await current?.dispose(); current = null; });
  const T_OUT = 300_000;

  // -------------------------------------------------------------------------------------------------------------------
  it("1. read-only: JSON, rendered artefacts, booking page and admin schedule states", { timeout: T_OUT }, async () => {
    current = await freshEnv();
    const db = current.env.DB;
    const env = await appEnv(db);
    const session = await adminSession(env);
    const c: Ctx = { env, session };
    const pub: Ctx = { env };

    // --- Public JSON
    saveJson("public-api/events-list.json", await callSnap(pub, "GET", "/api/events"), "GET /api/events (listed, open, not started: events 1 and 2)");
    saveJson("public-api/settings.json", await callSnap(pub, "GET", "/api/settings"), "GET /api/settings (club name, privacy contact, website)");
    for (const [key, what] of [
      ["e1", "open event with free slots"], ["e2", "open event with an orphan booking (ignored by the public view)"], ["e3", "archived event (no slots)"],
      ["e4", "unlisted event, open"], ["e5", "past, unarchived event (bookings closed)"],
    ] as const) {
      saveJson(`public-api/event-${key}.json`, await callSnap(pub, "GET", `/api/events/${SLUG[key]}`), `GET /api/events/:slug, ${what}`);
    }
    saveJson("public-api/event-not-found.json", await callSnap(pub, "GET", `/api/events/${SLUG.none}`), "GET /api/events/:slug for an unknown slug (404)");
    // A started slot: event 4 at 13:40Z on its day with a 120-minute cut-off, so the window is still open and slots 13:00 and 13:30 are "past" (14:00 is booked: "taken").
    vi.setSystemTime(new Date("2026-11-07T13:40:00Z"));
    saveJson(
      "public-api/event-e4-with-started-slots.json",
      await callSnap({ env: { ...env, BOOKING_CUTOFF_OFFSET_MINUTES: "120" } }, "GET", `/api/events/${SLUG.e4}`),
      "GET /api/events/:slug for event 4 at 2026-11-07T13:40:00Z with BOOKING_CUTOFF_OFFSET_MINUTES=120: slots free, past and taken together",
    );
    vi.setSystemTime(new Date(CLOCK));

    // --- Privacy notice
    const e1json = (await (await call(pub, "GET", `/api/events/${SLUG.e1}`)).json()) as any;
    save("privacy/notice-in-api.txt", `${e1json.privacyNotice}\n`, "privacyNotice as GET /api/events/:slug returns it (no PRIVACY_NOTICE set)");
    save("privacy/default-notice.txt", `${defaultPrivacyNotice(["Dog", "Handler"])}\n`, "the default notice from src/server/config.ts, for the labels Dog and Handler");

    // --- Admin JSON
    saveJson("admin-api/events-list.json", await callSnap(c, "GET", "/api/admin/events"), "GET /api/admin/events: upcoming, past and archived groups, default share message");
    const details: Record<string, any> = {};
    for (const key of ["e1", "e2", "e3", "e4", "e5"] as const) {
      const r = await callSnap(c, "GET", `/api/admin/events/${SLUG[key]}`);
      details[key] = r;
      saveJson(`admin-api/detail-${key}.json`, r, `GET /api/admin/events/:slug for ${key} (event, slots with bookings, orphans, defaultShareMessage, lineup)`);
    }
    saveJson("admin-api/templates-list.json", await callSnap(c, "GET", "/api/admin/templates"), "GET /api/admin/templates");
    saveJson("admin-api/template-1.json", await callSnap(c, "GET", "/api/admin/templates/1"), "GET /api/admin/templates/1 (the default template)");
    saveJson("admin-api/template-2.json", await callSnap(c, "GET", "/api/admin/templates/2"), "GET /api/admin/templates/2");

    // --- Lineup text (admin detail)
    for (const key of ["e1", "e2", "e5"] as const) {
      save(`lineup/${key}.txt`, details[key].body.lineup, `the lineup text (admin detail "lineup" field, raw) for ${key}`);
    }

    // --- CSV
    for (const key of ["e1", "e2", "e5"] as const) {
      const res = await call(c, "GET", `/api/admin/events/${SLUG[key]}/export.csv`);
      const text = await res.text();
      save(`csv/${key}.csv`, text, `GET .../export.csv for ${key}, raw (BOM, CRLF, formula guard)`);
      if (key === "e1") {
        saveJson("csv/e1.headers.json", Object.fromEntries(KEEP_HEADERS.filter((h) => res.headers.has(h)).map((h) => [h, res.headers.get(h)])), "response headers of the e1 CSV export (content type and download name)");
      }
    }

    // --- ICS (fixture tokens, so UID and DTSTAMP are fixed)
    for (const id of [1, 3, 4, 5]) {
      const res = await call(pub, "GET", `/api/events/${SLUG.e1}/bookings/${tokenOf(id)}/ics`);
      expect(res.status).toBe(200);
      save(`ics/e1-booking-${String(id).padStart(2, "0")}.ics`, await res.text(),
        `GET /api/events/:slug/bookings/:token/ics, raw, for booking ${id} (UID included)`);
    }
    saveJson("ics/not-found.json", await callSnap(pub, "GET", `/api/events/${SLUG.e1}/bookings/unknown-token-0123456789/ics`), "the .ics route for an unknown token (404 body)");

    // --- Share messages
    const d1 = details.e1.body;
    const link = `${ORIGIN}/e/${SLUG.e1}`;
    save("share/e1-default-template.txt", `${buildShareMessage({ event: d1.event, clubName: CLUB, link, template: pickShareTemplate(d1.event, d1.defaultShareMessage) })}\n`,
      "buildShareMessage for event 1 (no message of its own: the default template's message is used)");
    save("share/e1-built-in-template.txt", `${buildShareMessage({ event: d1.event, clubName: CLUB, link, template: BUILT_IN_SHARE_TEMPLATE })}\n`,
      "buildShareMessage for event 1 with the built-in template");
    const d4 = details.e4.body;
    save("share/e4-own-message.txt", `${buildShareMessage({ event: d4.event, clubName: CLUB, link: `${ORIGIN}/e/${SLUG.e4}`, template: pickShareTemplate(d4.event, d4.defaultShareMessage) })}\n`,
      "buildShareMessage for event 4 (its own share message)");

    // --- Booking page states
    const bp = makeDomSaver("booking-page", "booking page", legacyDom);
    {
      const page = await openBooking(pub, SLUG.e1);
      bp.state("e1-open", page.window, "event 1 open with free slots", { calls: page.net.calls });
      slotButton(page, T["1120"]).click();
      bp.state("e1-slot-selected", page.window, "event 1 with the 11:20 slot selected and the form shown");

      // validation errors, through the real server (nothing is written)
      const attempt = async (name: string, desc: string, dog: string, handler: string) => {
        const p = await openBooking(pub, SLUG.e1);
        slotButton(p, T["1120"]).click();
        typeInto(p, "#field-1", dog);
        typeInto(p, "#field-2", handler);
        await submitBooking(p);
        bp.state(name, p.window, desc, { calls: p.net.calls });
      };
      await attempt("e1-error-empty-dog", "submitted with an empty dog name", "", "Ann Lee");
      await attempt("e1-error-empty-handler", "submitted with an empty handler name", "Willow", "");
      await attempt("e1-error-both-empty", "submitted with both names empty", "", "");
      await attempt("e1-error-invisible-character", "submitted with a zero-width space in the dog name", "Re​x", "Ann Lee");
      await attempt("e1-error-too-long", "submitted with an 81-character handler name", "Willow", "H".repeat(81));
      await attempt("e1-error-no-letter-or-number", "submitted with a dog name of only emoji", "🐶🐶", "Ann Lee");
    }
    {
      const page = await openBooking(pub, SLUG.e5);
      bp.state("e5-closed", page.window, "event 5 (started, bookings closed)");
    }
    {
      const page = await openBooking(pub, SLUG.e3);
      bp.state("e3-archived", page.window, "event 3 (archived)");
    }
    {
      const page = await openBooking(pub, SLUG.none);
      bp.state("unknown-event", page.window, "an unknown event slug");
    }
    {
      vi.setSystemTime(new Date("2026-11-07T13:40:00Z"));
      const page = await openBooking({ env: { ...env, BOOKING_CUTOFF_OFFSET_MINUTES: "120" } }, SLUG.e4);
      bp.state("e4-started-slots", page.window, "event 4 at 2026-11-07T13:40:00Z with a 120-minute cut-off: started slots shown disabled", { calls: page.net.calls });
      vi.setSystemTime(new Date(CLOCK));
    }
    bp.finish();

    // --- Admin schedule states (read-only)
    const as = makeDomSaver("admin-schedule", "admin schedule page");
    {
      const clip: string[] = [];
      const page = await openSchedule(c, SLUG.e1, clip);
      as.state("e1-schedule", page.window, "event 1: booked and free rows, the Tea break", { calls: page.net.calls });
      opener(page, T["1120"], "add").click();
      as.state("e1-add-open", page.window, "event 1 with the Add booking panel open on the 11:20 row");
      const form = page.doc.querySelector("form.sched-panel");
      await submitForm(page, form);
      as.state("e1-add-submitted-empty", page.window, "event 1, the Add booking panel submitted empty (server field errors)", { calls: page.net.calls });
      opener(page, T["0900"], "move").click();
      as.state("e1-move-open", page.window, "event 1 with the Move panel open on the 09:00 row");
      opener(page, T["0900"], "swap").click();
      as.state("e1-swap-open", page.window, "event 1 with the Swap panel open on the 09:00 row");
      opener(page, T["0900"], "clear").click();
      as.state("e1-clear-open", page.window, "event 1 with the Clear panel open on the 09:00 row");
      // Copy lineup and Copy message are the page's own clipboard writes
      buttonByText(page, "Copy lineup").click();
      await page.net.idle();
      buttonByText(page, "Copy message").click();
      await page.net.idle();
      save("share/e1-schedule-page-copy-lineup.txt", `${clip[0]}\n`, "what the schedule page's Copy lineup button wrote to the clipboard (event 1)");
      save("share/e1-schedule-page-copy-message.txt", `${clip[1]}\n`, "what the schedule page's Copy message (Share) button wrote to the clipboard (event 1)");
      as.state("e1-after-copy", page.window, "event 1 after Copy lineup and Copy message were pressed");
    }
    {
      const page = await openSchedule(c, SLUG.e2);
      as.state("e2-schedule-with-orphan", page.window, "event 2: unnamed break and the 'Not in the schedule' orphan section", { calls: page.net.calls });
      opener(page, "orphan-10", "move").click();
      as.state("e2-orphan-move-open", page.window, "event 2 with the Move panel open on the orphan booking");
      opener(page, "orphan-10", "clear").click();
      as.state("e2-orphan-clear-open", page.window, "event 2 with the Clear panel open on the orphan booking");
    }
    {
      const page = await openSchedule(c, SLUG.e3);
      as.state("e3-archived-schedule", page.window, "event 3 (archived): no Share control");
    }
    {
      const page = await openSchedule(c, SLUG.none);
      as.state("unknown-event", page.window, "an unknown event slug");
    }
    as.finish();
  });

  // -------------------------------------------------------------------------------------------------------------------
  it("2. public POST /bookings (JSON)", { timeout: T_OUT }, async () => {
    current = await freshEnv();
    const env = await appEnv(current.env.DB);
    const pub: Ctx = { env };
    // The scenario's bodies are v1.0's: the REQUEST adapter sends them as field1 and field2, the RESPONSE normaliser reads the answer as v1.0 shaped it.
    const post = async (slug: string, body: unknown, extra: Record<string, string> = {}, ctx: Ctx = pub) => {
      const r = await callSnap(ctx, "POST", `/api/events/${slug}/bookings`, adaptRequest(body), extra);
      return { ...r, body: legacyPublic(r.body) };
    };
    const ok = (over: Record<string, unknown> = {}) => ({ slot: T["1120"], dogName: "Willow", handlerName: "Gail Park", idempotencyKey: "idem-new-created-0001", ...over });

    const results: Record<string, unknown> = {};
    results["created"] = await post(SLUG.e1, ok());
    results["replayed (same idempotency key and values)"] = await post(SLUG.e1, ok());
    results["replayed fixture booking 2 (its stored key)"] = await post(SLUG.e1, { slot: T["0935"], dogName: "Zoë", handlerName: "Ann Lee", idempotencyKey: "idem-b02-aaaaaaaaaaaaaaaa" });
    results["idempotency_key_reuse with the original booking (key of booking 3, other slot and names)"] =
      await post(SLUG.e1, { slot: T["1230"], dogName: "Other", handlerName: "Person", idempotencyKey: "idem-b03-bbbbbbbbbbbbbbbb" });
    results["idempotency_key_reuse for the created booking (same key, other slot)"] = await post(SLUG.e1, ok({ slot: T["1230"] }));
    results["slot_taken (with freeSlots)"] = await post(SLUG.e1, ok({ slot: T["0900"], dogName: "Skye", handlerName: "Tom Hall", idempotencyKey: "idem-new-taken-000001" }));
    results["slot_taken wins over duplicate_booking (same identity as booking 2, on booking 1's slot)"] =
      await post(SLUG.e1, ok({ slot: T["0900"], dogName: "zoë", handlerName: "ann  lee", idempotencyKey: "idem-new-taken-000002" }));
    results["duplicate_booking (booking 2's identity in different case and spacing, free slot)"] =
      await post(SLUG.e1, ok({ slot: T["1230"], dogName: "ZOË", handlerName: "ann  LEE", idempotencyKey: "idem-new-dup-00000001" }));
    results["duplicate_booking (Unicode: fullwidth Ａnn Lee)"] =
      await post(SLUG.e1, ok({ slot: T["1230"], dogName: "Zoë", handlerName: "Ａnn Lee", idempotencyKey: "idem-new-dup-00000002" }));
    results["invalid_slot (08:01 is not a slot)"] = await post(SLUG.e1, ok({ slot: "2026-10-17T08:01:00Z", idempotencyKey: "idem-new-badslot-0001" }));
    results["404 unknown event"] = await post(SLUG.none, ok());
    results["410 bookings_closed (event 5 has started)"] = await post(SLUG.e5, ok({ slot: "2026-09-12T08:30:00Z", idempotencyKey: "idem-new-closed-00001" }));
    results["410 event_archived (event 3)"] = await post(SLUG.e3, ok({ slot: "2026-12-05T10:40:00Z", idempotencyKey: "idem-new-archived-001" }));
    results["a booking that survives the cut-off: event 4 free slot"] = await post(SLUG.e4, ok({ slot: "2026-11-07T13:00:00Z", dogName: "Juno", handlerName: "Cal Doyle", idempotencyKey: "idem-new-e4-000000001" }));
    results["invalid_json"] = await post(SLUG.e1, "{not json");
    results["unsupported_media_type"] = await callSnap(pub, "POST", `/api/events/${SLUG.e1}/bookings`, JSON.stringify(ok()), { "Content-Type": "text/plain" });
    results["payload_too_large (Content-Length over 4096)"] = await callSnap(pub, "POST", `/api/events/${SLUG.e1}/bookings`, JSON.stringify(ok({ dogName: "x".repeat(5000) })), { "Content-Length": "5100" });
    results["body is a JSON array"] = await post(SLUG.e1, [1, 2]);
    saveJson("public-api/post-bookings.json", results, "POST /api/events/:slug/bookings: created, replayed, idempotency_key_reuse, slot_taken, duplicate_booking, invalid_slot, 404, 410s and malformed requests (tokens shown as <token> in icsUrl)");

    // slot_started: clock inside event 1, cut-off 120 minutes so the window is still open
    vi.setSystemTime(new Date("2026-10-17T08:50:00Z"));
    const late: Ctx = { env: { ...env, BOOKING_CUTOFF_OFFSET_MINUTES: "120" } };
    saveJson("public-api/post-slot-started.json", {
      "slot_started (09:35 slot has started; window open via cut-off)": await post(SLUG.e1, ok({ slot: T["0935"], dogName: "Late", handlerName: "Lena Fox", idempotencyKey: "idem-new-started-0001" }), {}, late),
      "created in a later slot while the event is running": await post(SLUG.e1, ok({ slot: T["1340"], dogName: "Brisk", handlerName: "Lena Fox", idempotencyKey: "idem-new-started-0002" }), {}, late),
    }, "POST /api/events/:slug/bookings at 2026-10-17T08:50:00Z with BOOKING_CUTOFF_OFFSET_MINUTES=120: slot_started with freeSlots, and a normal booking in a later slot");
    vi.setSystemTime(new Date(CLOCK));

    // invalid_input, one field at a time
    const bad: Record<string, unknown> = {};
    const base = { slot: T["1120"], dogName: "Willow", handlerName: "Gail Park", idempotencyKey: "idem-new-invalid-0001" };
    const invalidCases: [string, Record<string, unknown>][] = [
      ["dogName missing", { ...base, dogName: undefined }],
      ["dogName not a string", { ...base, dogName: 7 }],
      ["dogName empty", { ...base, dogName: "" }],
      ["dogName only spaces", { ...base, dogName: "   " }],
      ["dogName 81 characters", { ...base, dogName: "d".repeat(81) }],
      ["dogName exactly 80 characters passes validation (then invalid_slot, as the slot is not real)", { ...base, dogName: "d".repeat(80), slot: "2026-10-17T08:01:00Z" }],
      ["dogName zero-width space", { ...base, dogName: "Re​x" }],
      ["dogName right-to-left override", { ...base, dogName: "Rex‮" }],
      ["dogName ZWJ emoji", { ...base, dogName: "👨‍👩‍👧" }],
      ["dogName line separator U+2028", { ...base, dogName: "Re x" }],
      ["dogName control character", { ...base, dogName: "Re\u0007x" }],
      ["dogName newline", { ...base, dogName: "Re\nx" }],
      ["dogName lone surrogate", { ...base, dogName: "Re\ud800x" }],
      ["dogName only emoji", { ...base, dogName: "🐶" }],
      ["dogName only a variation selector and space", { ...base, dogName: "️ " }],
      ["dogName private use", { ...base, dogName: "Rex" }],
      ["dogName braille blank", { ...base, dogName: "Rex⠀" }],
      ["handlerName missing", { ...base, handlerName: undefined }],
      ["handlerName empty", { ...base, handlerName: "" }],
      ["handlerName 81 characters", { ...base, handlerName: "h".repeat(81) }],
      ["handlerName zero-width joiner", { ...base, handlerName: "Ann‍Lee" }],
      ["handlerName only symbols", { ...base, handlerName: "@@" }],
      ["slot missing", { ...base, slot: undefined }],
      ["slot not a string", { ...base, slot: 5 }],
      ["idempotencyKey missing", { ...base, idempotencyKey: undefined }],
      ["idempotencyKey too short", { ...base, idempotencyKey: "short" }],
      ["idempotencyKey bad characters", { ...base, idempotencyKey: "has spaces in it 0123456789" }],
      ["every field missing", {}],
      ["everything wrong", { slot: 1, dogName: "", handlerName: "​", idempotencyKey: "x" }],
    ];
    for (const [name, body] of invalidCases) bad[name] = await post(SLUG.e1, body);
    saveJson("public-api/post-invalid-input.json", bad, "POST /api/events/:slug/bookings with invalid input, one case at a time (fields object per case)");
  });

  // -------------------------------------------------------------------------------------------------------------------
  it("3. booking page flows that write (confirmation, duplicate, slot taken, started, closed, event edited)", { timeout: T_OUT }, async () => {
    current = await freshEnv();
    const db = current.env.DB;
    const env = await appEnv(db);
    const pub: Ctx = { env };
    const bp = makeDomSaver("booking-page-flows", "booking page flow", legacyDom);

    // a successful booking and its confirmation
    {
      const clip: string[] = [];
      const page = await openBooking(pub, SLUG.e1, clip);
      slotButton(page, T["1120"]).click();
      typeInto(page, "#field-1", "Willow");
      typeInto(page, "#field-2", "Gail Park");
      await submitBooking(page);
      bp.state("e1-confirmation", page.window, "after booking 11:20 as Willow / Gail Park: the confirmation", { calls: page.net.calls });
      buttonByText(page, "Copy booking").click();
      await page.net.idle();
      save("booking-page-flows/e1-confirmation.copy.txt", `${clip[0]}\n`, "the text the confirmation's Copy booking button wrote to the clipboard (copyText)");
      bp.state("e1-confirmation-copied", page.window, "the confirmation after pressing Copy booking", { clipboard: clip });
    }
    // duplicate booking
    {
      const page = await openBooking(pub, SLUG.e1);
      slotButton(page, T["1230"]).click();
      typeInto(page, "#field-1", "ZOË");
      typeInto(page, "#field-2", "ann lee");
      await submitBooking(page);
      bp.state("e1-duplicate-booking", page.window, "booking 12:30 as ZOË / ann lee, which duplicates booking 2: the form error", { calls: page.net.calls });
    }
    // slot taken between load and submit
    {
      const page = await openBooking(pub, SLUG.e1);
      slotButton(page, T["1230"]).click();
      await db.prepare(
        // The one line of the scenario written for the new schema: the same booking (id, slot, names, time, token), in event 1's lane at place 1.
        "INSERT INTO bookings (id, event_id, lane_id, slot_start_utc, place, value_1, value_2, created_at, identity_key, token) VALUES (100, 1, (SELECT id FROM event_lanes WHERE event_id = 1), ?, 1, 'Racer', 'Una Frost', '2026-10-01T11:59:00Z', 'racer' || char(31) || 'una frost', 'tok-b100-0123456789abcdef')",
      ).bind(T["1230"]).run();
      typeInto(page, "#field-1", "Comet");
      typeInto(page, "#field-2", "Dee Marsh");
      await submitBooking(page);
      bp.state("e1-slot-taken-refresh", page.window, "12:30 was booked by someone else after the page loaded: slot-taken notice and refreshed slots", { calls: page.net.calls });
    }
    // event edited between load and submit: the chosen slot disappears
    {
      const page = await openBooking(pub, SLUG.e2);
      slotButton(page, "2026-10-20T18:10:00Z").click();
      await db.prepare("UPDATE events SET end_utc = '2026-10-20T17:45:00Z' WHERE id = 2").run();
      await db.prepare("DELETE FROM breaks WHERE event_id = 2").run();
      typeInto(page, "#field-1", "Dash");
      typeInto(page, "#field-2", "Eli Ward");
      await submitBooking(page);
      bp.state("e2-invalid-slot-after-edit", page.window, "event 2's end was moved earlier after the page loaded; the chosen 19:10 slot no longer exists", { calls: page.net.calls });
      // and then the event is archived under an open form
      const page2 = await openBooking(pub, SLUG.e2);
      slotButton(page2, "2026-10-20T17:20:00Z").click();
      await db.prepare("UPDATE events SET archived = 1 WHERE id = 2").run();
      typeInto(page2, "#field-1", "Echo");
      typeInto(page2, "#field-2", "Fay Lowe");
      await submitBooking(page2);
      bp.state("e2-archived-after-load", page2.window, "event 2 was archived after the page loaded: bookings closed (410)", { calls: page2.net.calls });
    }
    // slot started between selecting and submitting (cut-off keeps the window open)
    {
      vi.setSystemTime(new Date("2026-11-07T13:20:00Z"));
      const late: Ctx = { env: { ...env, BOOKING_CUTOFF_OFFSET_MINUTES: "120" } };
      const page = await openBooking(late, SLUG.e4);
      slotButton(page, "2026-11-07T13:30:00Z").click();
      vi.setSystemTime(new Date("2026-11-07T13:40:00Z"));
      typeInto(page, "#field-1", "Flash");
      typeInto(page, "#field-2", "Gus Rowe");
      await submitBooking(page);
      bp.state("e4-slot-started", page.window, "the 13:30 slot started between choosing it and submitting: 'already started' notice", { calls: page.net.calls });
      vi.setSystemTime(new Date(CLOCK));
    }
    bp.finish();
  });

  // -------------------------------------------------------------------------------------------------------------------
  it("4. admin schedule page flows that write", { timeout: T_OUT }, async () => {
    current = await freshEnv();
    const env = await appEnv(current.env.DB);
    const session = await adminSession(env);
    const c: Ctx = { env, session };
    const as = makeDomSaver("admin-schedule-flows", "admin schedule flow");
    const page = await openSchedule(c, SLUG.e1);
    const record = (name: string, desc: string) => as.state(name, page.window, desc, { status: page.$(".sched-status").textContent, calls: page.net.calls.filter((x: any) => x.method !== "GET") });

    // add
    opener(page, T["1120"], "add").click();
    page.$("#add-dog").value = "Willow";
    page.$("#add-handler").value = "Gail Park";
    await submitForm(page, page.doc.querySelector("form.sched-panel"));
    record("add-ok", "after adding Willow / Gail Park at 11:20");
    // add a duplicate identity: inline error
    opener(page, T["1230"], "add").click();
    page.$("#add-dog").value = "zoë";
    page.$("#add-handler").value = "ANN LEE";
    await submitForm(page, page.doc.querySelector("form.sched-panel"));
    record("add-duplicate", "adding zoë / ANN LEE at 12:30, which duplicates booking 2: inline message");
    // add with an invalid name
    page.$("#add-dog").value = "Re​x";
    page.$("#add-handler").value = "Ann Lee";
    await submitForm(page, page.doc.querySelector("form.sched-panel"));
    record("add-invalid-input", "adding with a zero-width space in the dog name: field error");
    buttonByText(page, "Cancel").click();
    // move
    opener(page, T["0900"], "move").click();
    page.$("#pick-move").value = T["1340"];
    await submitForm(page, page.doc.querySelector("form.sched-panel"));
    record("move-ok", "after moving Rex 🐶 from 09:00 to 13:40");
    // swap
    opener(page, T["0935"], "swap").click();
    page.$("#pick-swap").value = T["1045"];
    await submitForm(page, page.doc.querySelector("form.sched-panel"));
    record("swap-ok", "after swapping the 09:35 and 10:45 bookings");
    // swap with nothing chosen
    opener(page, T["0935"], "swap").click();
    await submitForm(page, page.doc.querySelector("form.sched-panel"));
    record("swap-nothing-chosen", "Swap panel submitted without choosing a slot");
    buttonByText(page, "Cancel").click();
    // clear
    opener(page, T["1155"], "clear").click();
    buttonByText(page, "Clear booking").click();
    await page.net.idle();
    record("clear-ok", "after clearing the 11:55 booking (=Max / +Dave Kerr)");
    as.finish();
  });

  // -------------------------------------------------------------------------------------------------------------------
  it("5. admin booking actions (JSON)", { timeout: T_OUT }, async () => {
    current = await freshEnv();
    const env = await appEnv(current.env.DB);
    const session = await adminSession(env);
    const c: Ctx = { env, session };
    const base = `/api/admin/events/${SLUG.e1}/bookings`;

    const add: Record<string, unknown> = {};
    add["created"] = await callSnap(c, "POST", base, { slot: T["1120"], dogName: "Willow", handlerName: "Gail Park" });
    add["created with names trimmed and inner spaces kept"] = await callSnap(c, "POST", base, { slot: T["1230"], dogName: "  Juno ", handlerName: "Ian  Ford" });
    add["slot_taken (holder named)"] = await callSnap(c, "POST", base, { slot: T["0900"], dogName: "Skye", handlerName: "Tom Hall" });
    add["slot_taken wins over duplicate (booking 2's identity on booking 1's slot)"] = await callSnap(c, "POST", base, { slot: T["0900"], dogName: "zoë", handlerName: "ann lee" });
    add["duplicate_booking (booking 2's identity, free slot)"] = await callSnap(c, "POST", base, { slot: T["1340"], dogName: "ZOË", handlerName: "ANN  LEE" });
    add["duplicate_booking (own slot, same identity)"] = await callSnap(c, "POST", base, { slot: T["0935"], dogName: "Zoë", handlerName: "Ann Lee" });
    add["invalid_input (nothing sent)"] = await callSnap(c, "POST", base, {});
    add["invalid_input (invisible character)"] = await callSnap(c, "POST", base, { slot: T["1340"], dogName: "Re​x", handlerName: "Ann Lee" });
    add["invalid_input (handler 81 characters)"] = await callSnap(c, "POST", base, { slot: T["1340"], dogName: "Rex", handlerName: "h".repeat(81) });
    add["invalid_slot"] = await callSnap(c, "POST", base, { slot: "2026-10-17T08:01:00Z", dogName: "Rex", handlerName: "Sam" });
    add["invalid_json"] = await callSnap(c, "POST", base, "{nope");
    add["404 unknown event"] = await callSnap(c, "POST", `/api/admin/events/${SLUG.none}/bookings`, { slot: T["1340"], dogName: "Rex", handlerName: "Sam" });
    saveJson("admin-api/bookings-add.json", add, "POST /api/admin/events/:slug/bookings: success and every error");

    const move: Record<string, unknown> = {};
    const mv = (id: number | string, body: unknown) => callSnap(c, "POST", `${base}/${id}/move`, body);
    move["moved (booking 2: 09:35 to 13:40)"] = await mv(2, { fromSlot: T["0935"], toSlot: T["1340"] });
    move["same_slot"] = await mv(1, { fromSlot: T["0900"], toSlot: T["0900"] });
    move["slot_taken (holder named)"] = await mv(1, { fromSlot: T["0900"], toSlot: T["1045"] });
    move["changed (booking 3 is not at the slot the admin saw)"] = await mv(3, { fromSlot: T["0900"], toSlot: T["0935"] });
    move["not_found (unknown id)"] = await mv(999, { fromSlot: T["0900"], toSlot: T["0935"] });
    move["not_found (id is not a number)"] = await mv("abc", { fromSlot: T["0900"], toSlot: T["0935"] });
    move["not_found (booking of another event)"] = await mv(14, { fromSlot: "2026-09-12T08:00:00Z", toSlot: T["0935"] });
    move["invalid_slot (target is no slot)"] = await mv(1, { fromSlot: T["0900"], toSlot: "2026-10-17T08:01:00Z" });
    move["invalid_input (nothing sent)"] = await mv(1, {});
    move["moved onto the freed 09:35 slot (booking 1)"] = await mv(1, { fromSlot: T["0900"], toSlot: T["0935"] });
    saveJson("admin-api/bookings-move.json", move, "POST /api/admin/events/:slug/bookings/:id/move: success and every error");

    const swap: Record<string, unknown> = {};
    const sw = (body: unknown) => callSnap(c, "POST", `${base}/swap`, body);
    swap["swapped (bookings 3 and 4)"] = await sw({ a: { id: 3, slot: T["1045"] }, b: { id: 4, slot: T["1155"] } });
    swap["same_booking"] = await sw({ a: { id: 3, slot: T["1155"] }, b: { id: 3, slot: T["1155"] } });
    swap["changed (booking 3 is no longer where the admin saw it)"] = await sw({ a: { id: 3, slot: T["1045"] }, b: { id: 4, slot: T["1155"] } });
    swap["not_found (unknown id)"] = await sw({ a: { id: 3, slot: T["1155"] }, b: { id: 999, slot: T["1045"] } });
    swap["not_found (booking of another event)"] = await sw({ a: { id: 3, slot: T["1155"] }, b: { id: 14, slot: "2026-09-12T08:00:00Z" } });
    swap["invalid_input (nothing sent)"] = await sw({});
    swap["invalid_input (one side bad)"] = await sw({ a: { id: 3, slot: T["1155"] }, b: { id: "x", slot: 5 } });
    saveJson("admin-api/bookings-swap.json", swap, "POST /api/admin/events/:slug/bookings/swap: success and every error");

    const clear: Record<string, unknown> = {};
    clear["cleared (booking 5)"] = await callSnap(c, "DELETE", `${base}/5`, { confirm: true });
    clear["cleared again: not_found"] = await callSnap(c, "DELETE", `${base}/5`, { confirm: true });
    clear["not_found (booking of another event)"] = await callSnap(c, "DELETE", `${base}/14`, { confirm: true });
    clear["confirmation_required (confirm false)"] = await callSnap(c, "DELETE", `${base}/6`, { confirm: false });
    clear["confirmation_required (empty body)"] = await callSnap(c, "DELETE", `${base}/6`, "");
    clear["unsupported_media_type (no body, so no JSON content type)"] = await callSnap(c, "DELETE", `${base}/6`);
    clear["confirmation_required (confirm is the string true)"] = await callSnap(c, "DELETE", `${base}/6`, { confirm: "true" });
    saveJson("admin-api/bookings-clear.json", clear, "DELETE /api/admin/events/:slug/bookings/:id: success and every error");

    saveJson("admin-api/detail-e1-after-actions.json", await callSnap(c, "GET", `/api/admin/events/${SLUG.e1}`),
      "GET /api/admin/events/:slug for event 1 after the add/move/swap/clear calls above, in that order (slots, bookings, lineup)");
  });

  // -------------------------------------------------------------------------------------------------------------------
  it("6. admin: orphan handling and the event edit with its booking clash", { timeout: T_OUT }, async () => {
    current = await freshEnv();
    const env = await appEnv(current.env.DB);
    const session = await adminSession(env);
    const c: Ctx = { env, session };
    const base = `/api/admin/events/${SLUG.e2}`;

    // orphan: swap refuses, move works
    const orphan: Record<string, unknown> = {};
    orphan["swap with an orphan: invalid_slot"] = await callSnap(c, "POST", `${base}/bookings/swap`, { a: { id: 10, slot: "2026-10-20T15:30:00Z" }, b: { id: 7, slot: "2026-10-20T17:00:00Z" } });
    orphan["add on a slot of the schedule"] = await callSnap(c, "POST", `${base}/bookings`, { slot: "2026-10-20T17:20:00Z", dogName: "Nell", handlerName: "Al Penn" });
    orphan["detail with the orphan"] = await callSnap(c, "GET", base);
    saveJson("admin-api/orphan-actions.json", orphan, "event 2 (has an orphan booking): swap with the orphan refused, an add, and the detail JSON listing the orphan");

    const body = (over: Record<string, unknown> = {}) => ({
      name: "Evening Run", date: "2026-10-20", start: "18:00", end: "20:00", sessionMinutes: 20, gapMinutes: 0, costPence: 800,
      venuePostcode: "AB1 2CD", details: "Floodlit ring. Wear sensible shoes.", breaks: [{ start: "19:00", end: "19:10", label: "" }], ...over,
    });
    const shorter = body({ end: "19:00", breaks: [] });
    const edit: Record<string, unknown> = {};
    edit["1 cost change only, the orphan is affected: bookings_affected"] = await callSnap(c, "PUT", base, body({ costPence: 900 }));
    edit["2 end moved to 19:00, no confirmation: bookings_affected lists the orphan and the 18:30 booking"] = await callSnap(c, "PUT", base, shorter);
    edit["3 only the orphan confirmed: bookings_affected again"] = await callSnap(c, "PUT", base, { ...shorter, removeBookingIds: [10] });
    edit["4 removeBookingIds invalid: invalid_input"] = await callSnap(c, "PUT", base, { ...shorter, removeBookingIds: ["x"] });
    edit["5 both confirmed: saved, with removed bookings"] = await callSnap(c, "PUT", base, { ...shorter, removeBookingIds: [10, 9] });
    edit["6 same save again: saved, nothing left to remove"] = await callSnap(c, "PUT", base, { ...shorter, removeBookingIds: [10, 9] });
    edit["7 detail after the edit"] = await callSnap(c, "GET", base);
    edit["8 invalid_input (end before start)"] = await callSnap(c, "PUT", base, body({ end: "17:00" }));
    edit["9 404 unknown event"] = await callSnap(c, "PUT", `/api/admin/events/${SLUG.none}`, body());
    saveJson("admin-api/event-edit.json", edit, "PUT /api/admin/events/:slug on event 2: the clash (bookings_affected, with the orphan), invalid removeBookingIds, the confirmed save (removed bookings), the retry and the detail after");
    saveJson("admin-api/detail-e2-after-edit.json", edit["7 detail after the edit"], "GET /api/admin/events/:slug for event 2 after the confirmed edit (same as step 7 of event-edit.json)");
  });

  // -------------------------------------------------------------------------------------------------------------------
  it("7. every golden output was compared and none differs, and every allowed addition was used", () => {
    // The manifest lists every output the capture wrote (seed.sql, the input, is not one of the replayed outputs).
    const manifest = Object.keys(JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"))).filter((f) => f !== "seed.sql");
    const onDisk = (dir: string): string[] => readdirSync(join(FIXTURES, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? onDisk(join(dir, e.name)) : [join(dir, e.name)]));
    const files = onDisk("").filter((f) => !["README.md", "capture.test.ts.txt", "manifest.json", "seed.sql", ".gitattributes"].includes(f));
    expect([...compared].sort()).toEqual([...manifest].sort());
    expect([...compared].sort()).toEqual(files.sort());
    expect(failures).toEqual([]);
    const unused = ALLOWED_ADDITIONS.filter((a) => hits.get(a)!.size === 0).map((a) => `${a.files} ${a.path}`);
    expect(unused, "allowed additions that no output contains any more").toEqual([]);
    expect(WORDING.filter((w) => wordingHits.get(w)!.size === 0).map((w) => w.old), "wording rows that match no golden text").toEqual([]);
    expect(ADAPTERS.filter((name) => !adapterHits.get(name)), "adapters the replay never used").toEqual([]);
    expect([...adapterHits.keys()].filter((name) => !ADAPTERS.includes(name)), "adapters that are not listed").toEqual([]);
  });
});
