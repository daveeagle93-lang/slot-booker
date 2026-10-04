import { isValidSlug } from "../core/slug";

/** Sets the archived flag by slug; null if there is no such event. Idempotent: setting the same value again is fine. */
export async function setArchived(db: D1Database, slug: string, archived: boolean): Promise<{ archived: boolean } | null> {
  if (!isValidSlug(slug)) return null;
  const row = await db
    .prepare("UPDATE events SET archived = ? WHERE slug = ? RETURNING archived")
    .bind(archived ? 1 : 0, slug).first<{ archived: number }>();
  return row ? { archived: row.archived === 1 } : null;
}
