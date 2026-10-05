// The admin credentials kept in D1 (migration 0013), used when neither ADMIN_PASSWORD_HASH nor ADMIN_SESSION_SECRET
// is set. One row at most. Every write is a single statement guarded by `first_login_at`, so that setup (which may
// replace the credentials) and the first sign-in (which closes setup) cannot both win.

export interface StoredCredentials {
  secretHash: string;
  sessionSecret: string;
  /** Empty until the first successful sign-in; setup is open only while it is empty. */
  firstLoginAt: string | null;
}

export async function loadCredentials(db: D1Database): Promise<StoredCredentials | null> {
  const row = await db.prepare("SELECT secret_hash, session_secret, first_login_at FROM admin_credentials WHERE id = 1")
    .first<{ secret_hash: string; session_secret: string; first_login_at: string | null }>();
  return row ? { secretHash: row.secret_hash, sessionSecret: row.session_secret, firstLoginAt: row.first_login_at } : null;
}

/**
 * Stores the credentials made on /setup, replacing earlier ones, in one statement that does nothing once the first
 * sign-in is recorded. False means it did nothing (setup has just been closed by a sign-in).
 */
export async function saveCredentials(
  db: D1Database, { secretHash, sessionSecret, createdAt }: { secretHash: string; sessionSecret: string; createdAt: string },
): Promise<boolean> {
  const row = await db.prepare(
    `INSERT INTO admin_credentials (id, secret_hash, session_secret, created_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET secret_hash = excluded.secret_hash, session_secret = excluded.session_secret, created_at = excluded.created_at
     WHERE admin_credentials.first_login_at IS NULL
     RETURNING id`,
  ).bind(secretHash, sessionSecret, createdAt).first();
  return row !== null;
}

/**
 * Records the first sign-in, for the credentials that were verified (identified by their hash). True if the row is,
 * or already was, marked for exactly that hash; false if setup replaced the credentials in the meantime (or the row
 * is gone), in which case nothing is marked and the sign-in must be refused.
 */
export async function markFirstSignIn(db: D1Database, verifiedHash: string, nowIso: string): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE admin_credentials SET first_login_at = ? WHERE id = 1 AND first_login_at IS NULL AND secret_hash = ?",
  ).bind(nowIso, verifiedHash).run();
  if (result.meta.changes > 0) return true;
  const row = await loadCredentials(db);
  return row !== null && row.secretHash === verifiedHash && row.firstLoginAt !== null;
}
