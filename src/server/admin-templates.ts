import { checkName, PROBE_DATE, parseEventDraft } from "./admin-events";
import { guard, isGuardFailure } from "./db-guard";

export const MAX_TEMPLATES = 20;
const MAX_NAME_CODE_POINTS = 60;

type Fields = Record<string, string>;

/** A template as the admin API returns it: London HH:MM times, breaks sorted by start. */
export interface Template {
  id: number; name: string; isDefault: boolean; details: string; venuePostcode: string; costPence: number;
  start: string; end: string; sessionMinutes: number; gapMinutes: number;
  breaks: { start: string; end: string; label: string }[];
  shareMessage: string;
}

/** A validated request. `isDefault` and `shareMessage` are undefined when the request didn't say (create: not default, ""; edit: unchanged). */
export interface TemplateDraft extends Omit<Template, "id" | "isDefault" | "shareMessage"> { isDefault?: boolean; shareMessage?: string }

/**
 * A template is checked as an event on a day with no clock change, so the one event code path decides everything the two
 * have in common: the times, the breaks, the slot count, the postcode, the details, the cost and the share message, under
 * the same field keys (`breaks.N.start` and so on). The name has its own rule (60 characters, as "template name"), and the
 * date and `listed` don't apply. Unknown fields are ignored.
 */
export function parseTemplateDraft(raw: Record<string, unknown>): { draft: TemplateDraft } | { fields: Fields } {
  const fields: Fields = {};
  const name = checkName(raw.name, undefined, "template name", MAX_NAME_CODE_POINTS);
  if ("message" in name) fields.name = name.message;
  if (raw.isDefault !== undefined && typeof raw.isDefault !== "boolean") fields.isDefault = "Default must be true or false.";
  const parsed = parseEventDraft({
    name: "Template", date: PROBE_DATE, start: raw.start, end: raw.end, sessionMinutes: raw.sessionMinutes, gapMinutes: raw.gapMinutes,
    costPence: raw.costPence, venuePostcode: raw.venuePostcode, details: raw.details, shareMessage: raw.shareMessage, breaks: raw.breaks,
  }, { now: new Date(), requireFuture: false });
  if ("fields" in parsed) Object.assign(fields, parsed.fields);
  if (Object.keys(fields).length > 0 || !("draft" in parsed)) return { fields };
  const d = parsed.draft;
  return {
    draft: {
      name: (name as { name: string }).name, isDefault: raw.isDefault as boolean | undefined, details: d.details,
      venuePostcode: d.venuePostcode, costPence: d.costPence, start: d.start, end: d.end, sessionMinutes: d.sessionMinutes,
      gapMinutes: d.gapMinutes, shareMessage: d.shareMessage,
      breaks: d.breaks.map(({ start, end, label }) => ({ start, end, label }))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0)),
    },
  };
}

/** The id from the URL: a positive safe integer, or null (the handler answers 404). */
export const templateId = (param: string): number | null =>
  /^[1-9]\d*$/.test(param) && Number.isSafeInteger(Number(param)) ? Number(param) : null;

interface TemplateRow {
  id: number; name: string; is_default: number; details: string; venue_postcode: string; cost_pence: number; start_time: string;
  end_time: string; session_minutes: number; gap_minutes: number; share_message: string;
}

/** Every template (default first, then by name), or just the one with this id: one batch, so the breaks match the rows. */
export async function loadTemplates(db: D1Database, id?: number): Promise<Template[]> {
  const scoped = (sql: string, column: string, order: string) =>
    id === undefined ? db.prepare(`${sql} ORDER BY ${order}`) : db.prepare(`${sql} WHERE ${column} = ? ORDER BY ${order}`).bind(id);
  const [rows, breaks] = await db.batch([
    scoped("SELECT * FROM event_templates", "id", "is_default DESC, name COLLATE NOCASE, id"),
    scoped("SELECT template_id, start_time, end_time, label FROM event_template_breaks", "template_id", "start_time, end_time, id"),
  ]);
  const breaksOf = new Map<number, Template["breaks"]>();
  for (const b of breaks.results as { template_id: number; start_time: string; end_time: string; label: string }[]) {
    breaksOf.set(b.template_id, [...(breaksOf.get(b.template_id) ?? []), { start: b.start_time, end: b.end_time, label: b.label }]);
  }
  return (rows.results as unknown as TemplateRow[]).map((r) => ({
    id: r.id, name: r.name, isDefault: r.is_default === 1, details: r.details, venuePostcode: r.venue_postcode, costPence: r.cost_pence,
    start: r.start_time, end: r.end_time, sessionMinutes: r.session_minutes, gapMinutes: r.gap_minutes,
    breaks: breaksOf.get(r.id) ?? [], shareMessage: r.share_message,
  }));
}

export type SaveTemplateResult =
  | { kind: "saved"; template: Template }
  | { kind: "limit" }
  | { kind: "duplicate_name" }
  | { kind: "needs_default" }
  | { kind: "not_found" };

/** The name's unique index (case-insensitive) refused the write; the batch wrote nothing. */
const isNameClash = (e: unknown): boolean => e instanceof Error && e.message.includes("UNIQUE constraint failed");

/**
 * Creates the template in one batch: the limit is a guard, so two requests can't both take the last place. The first
 * template, or one made while none is the default, becomes the default. Asking for the default clears the old one first,
 * in the same batch (the partial unique index refuses two defaults at any moment, and a batch is one transaction, so
 * nobody sees none or two). A name that matches another ignoring case fails on the unique index (duplicate_name).
 */
export async function createTemplate(db: D1Database, d: TemplateDraft): Promise<SaveTemplateResult> {
  const named = "(SELECT id FROM event_templates WHERE lower(name) = lower(?))";
  try {
    const results = await db.batch([
      guard(db, "(SELECT COUNT(*) FROM event_templates) < ?", MAX_TEMPLATES),
      ...(d.isDefault ? [db.prepare("UPDATE event_templates SET is_default = 0 WHERE is_default = 1")] : []),
      db.prepare(
        `INSERT INTO event_templates (name, is_default, details, venue_postcode, cost_pence, start_time, end_time, session_minutes, gap_minutes, share_message)
         VALUES (?, CASE WHEN ? = 1 OR NOT EXISTS (SELECT 1 FROM event_templates WHERE is_default = 1) THEN 1 ELSE 0 END, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      ).bind(d.name, d.isDefault ? 1 : 0, d.details, d.venuePostcode, d.costPence, d.start, d.end, d.sessionMinutes, d.gapMinutes, d.shareMessage ?? ""),
      ...d.breaks.map((b) =>
        db.prepare(`INSERT INTO event_template_breaks (template_id, start_time, end_time, label) VALUES (${named}, ?, ?, ?)`)
          .bind(d.name, b.start, b.end, b.label)),
    ]);
    const id = (results[d.isDefault ? 2 : 1].results as { id: number }[])[0].id;
    return { kind: "saved", template: (await loadTemplates(db, id))[0] };
  } catch (e) {
    if (isGuardFailure(e)) return { kind: "limit" };
    if (isNameClash(e)) return { kind: "duplicate_name" };
    throw e;
  }
}

/**
 * Replaces the template's fields and breaks in one batch (isDefault and shareMessage only when sent). `isDefault: true`
 * clears the other default first, in the same batch. `isDefault: false` on the default is refused (needs_default): a guard
 * makes that hold even if the default changed after the read, so there is never no default while a template exists.
 */
export async function updateTemplate(db: D1Database, id: number, d: TemplateDraft): Promise<SaveTemplateResult> {
  const current = await db.prepare("SELECT is_default FROM event_templates WHERE id = ?").bind(id).first<{ is_default: number }>();
  if (!current) return { kind: "not_found" };
  if (d.isDefault === false && current.is_default === 1) return { kind: "needs_default" };
  try {
    await db.batch([
      guard(db, "EXISTS (SELECT 1 FROM event_templates WHERE id = ?)", id),
      ...(d.isDefault === false ? [guard(db, "EXISTS (SELECT 1 FROM event_templates WHERE id = ? AND is_default = 0)", id)] : []),
      ...(d.isDefault === true ? [db.prepare("UPDATE event_templates SET is_default = 0 WHERE is_default = 1 AND id <> ?").bind(id)] : []),
      db.prepare(
        `UPDATE event_templates SET name = ?, is_default = COALESCE(?, is_default), details = ?, venue_postcode = ?, cost_pence = ?,
           start_time = ?, end_time = ?, session_minutes = ?, gap_minutes = ?, share_message = COALESCE(?, share_message),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`,
      ).bind(d.name, d.isDefault === true ? 1 : null, d.details, d.venuePostcode, d.costPence, d.start, d.end, d.sessionMinutes,
        d.gapMinutes, d.shareMessage ?? null, id),
      db.prepare("DELETE FROM event_template_breaks WHERE template_id = ?").bind(id),
      ...d.breaks.map((b) =>
        db.prepare("INSERT INTO event_template_breaks (template_id, start_time, end_time, label) VALUES (?, ?, ?, ?)").bind(id, b.start, b.end, b.label)),
    ]);
  } catch (e) {
    if (isNameClash(e)) return { kind: "duplicate_name" };
    if (!isGuardFailure(e)) throw e;
    const now = await db.prepare("SELECT 1 AS n FROM event_templates WHERE id = ?").bind(id).first();
    return { kind: now ? "needs_default" : "not_found" };
  }
  return { kind: "saved", template: (await loadTemplates(db, id))[0] };
}

/**
 * Deletes the template and its breaks (events are not touched: they hold copies). If that leaves no default, the oldest
 * remaining template becomes the default in the same batch. Null if there is no such template.
 */
export async function deleteTemplate(db: D1Database, id: number): Promise<{ id: number; name: string } | null> {
  const [deleted] = await db.batch([
    db.prepare("DELETE FROM event_templates WHERE id = ? RETURNING name").bind(id),
    db.prepare(
      `UPDATE event_templates SET is_default = 1
       WHERE id = (SELECT id FROM event_templates ORDER BY created_at, id LIMIT 1)
         AND NOT EXISTS (SELECT 1 FROM event_templates WHERE is_default = 1)`,
    ),
  ]);
  const row = (deleted.results as { name: string }[])[0];
  return row ? { id, name: row.name } : null;
}
