import { sha256, utf8 } from "./crypto";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 15 * 60;
const KEEP_SECONDS = 24 * 60 * 60;

/** Hex SHA-256 of the client address, so the address itself is never stored. No address (local dev) shares one key. */
export async function clientKey(ip: string | null): Promise<string> {
  return [...(await sha256(utf8(ip ?? "unknown")))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Counts one login attempt and says whether it may go on to the password check. The count happens
 * first, in one upsert, so parallel guesses cannot slip past the limit. A new window starts when an attempt
 * arrives 900 s or more after the window began. The same batch purges rows whose window ended over a day ago.
 */
export async function countAttempt(
  db: D1Database, key: string, nowSeconds: number,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const [, upsert] = await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE window_start < ?").bind(nowSeconds - KEEP_SECONDS - WINDOW_SECONDS),
    // Every right-hand side sees the row as it was before this statement, so both CASEs test the old window.
    db.prepare(
      `INSERT INTO login_attempts (key, attempts, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT (key) DO UPDATE SET
         attempts = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
       RETURNING attempts, window_start`,
    ).bind(key, nowSeconds, WINDOW_SECONDS),
  ]);
  const row = upsert.results[0] as { attempts: number; window_start: number };
  if (row.attempts <= MAX_ATTEMPTS) return { allowed: true };
  return { allowed: false, retryAfterSeconds: Math.max(1, row.window_start + WINDOW_SECONDS - nowSeconds) };
}

export async function clearAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}
