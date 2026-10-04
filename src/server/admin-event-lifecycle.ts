import { isValidSlug } from "../core/slug";
import { guard, isGuardFailure } from "./db-guard";

/** Sets the archived flag by slug; null if there is no such event. Idempotent: setting the same value again is fine. */
export async function setArchived(db: D1Database, slug: string, archived: boolean): Promise<{ archived: boolean } | null> {
  if (!isValidSlug(slug)) return null;
  const row = await db
    .prepare("UPDATE events SET archived = ? WHERE slug = ? RETURNING archived")
    .bind(archived ? 1 : 0, slug).first<{ archived: number }>();
  return row ? { archived: row.archived === 1 } : null;
}

export type DeleteResult =
  | { kind: "deleted"; slug: string; name: string; bookings: number }
  | { kind: "not_found" }
  | { kind: "confirmation_mismatch" };

/** Test seam: runs after the event was read and before the batch, where another request could change things. */
export interface LifecycleHooks { afterRead?: () => Promise<void> }

/**
 * Permanently deletes the event with its breaks and bookings, if `confirmName` is exactly the stored name
 * (raw string comparison: no trimming, folding or Unicode normalisation; the page may trim what was typed, the
 * server never does). Bookings, breaks and the event are deleted explicitly in one batch rather than relying
 * on ON DELETE CASCADE, and the batch starts with a guard that the event still exists under the confirmed
 * name: a second delete racing the first finds nothing (not_found), and an event renamed after the read is
 * not deleted on the strength of the old name. The booking count is what the batch actually deleted, so a
 * booking that landed after the read is deleted and counted too.
 */
export async function deleteEvent(db: D1Database, slug: string, confirmName: unknown, hooks: LifecycleHooks = {}): Promise<DeleteResult> {
  if (!isValidSlug(slug)) return { kind: "not_found" };
  const event = await db.prepare("SELECT id, name FROM events WHERE slug = ?").bind(slug).first<{ id: number; name: string }>();
  if (!event) return { kind: "not_found" };
  if (typeof confirmName !== "string" || confirmName !== event.name) return { kind: "confirmation_mismatch" };
  await hooks.afterRead?.();
  try {
    const results = await db.batch([
      guard(db, "EXISTS (SELECT 1 FROM events WHERE id = ? AND name = ?)", event.id, event.name),
      db.prepare("DELETE FROM bookings WHERE event_id = ? RETURNING id").bind(event.id),
      db.prepare("DELETE FROM breaks WHERE event_id = ?").bind(event.id),
      db.prepare("DELETE FROM events WHERE id = ?").bind(event.id),
    ]);
    return { kind: "deleted", slug, name: event.name, bookings: results[1].results.length };
  } catch (e) {
    if (!isGuardFailure(e)) throw e;
    const now = await db.prepare("SELECT 1 AS n FROM events WHERE id = ?").bind(event.id).first();
    return now ? { kind: "confirmation_mismatch" } : { kind: "not_found" };
  }
}
