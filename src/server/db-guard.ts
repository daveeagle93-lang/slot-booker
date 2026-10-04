/**
 * An in-batch precondition for D1. A batch runs as one transaction, so a statement that errors rolls back
 * every statement in it. `guard` is such a statement: it errors unless its condition holds, which lets a
 * batch check something (for example "no booking has appeared on a slot we are about to remove") at the
 * moment it runs, after earlier statements in the same batch and with no gap in which another request
 * could change the answer.
 *
 * The error is SQLite's "integer overflow", raised by `abs(-9223372036854775808)` (the one value whose
 * absolute value does not fit in 64 bits) in the ELSE branch of a CASE, so it is only evaluated when the
 * condition is false. Checked on local D1 (workerd's SQLite): the batch fails with
 * "D1_ERROR: integer overflow: SQLITE_ERROR" and nothing in it is written. The alternative,
 * `json(CASE WHEN ... THEN '1' ELSE 'x' END)` ("malformed JSON"), also works but could be mistaken for a
 * real JSON error from a json_each() parameter, whereas nothing else in these batches can overflow.
 * Production D1 is the same SQLite engine; this has not been run against remote D1.
 *
 * `conditionSql` is trusted SQL written by the caller, never user input; values go in `binds`. D1 allows
 * at most 100 bound parameters per statement, so pass a list as ONE JSON text and read it with json_each(?).
 */
export function guard(db: D1Database, conditionSql: string, ...binds: unknown[]): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN ${conditionSql} THEN 1 ELSE abs(-9223372036854775808) END`).bind(...binds);
}

/** True if the error is a failed `guard` (so the batch wrote nothing), not some other database error. */
export const isGuardFailure = (e: unknown): boolean => e instanceof Error && e.message.includes("integer overflow");

/** Breaks as the guard compares them: start|end, ordered, joined. Labels don't change the schedule, so aren't part of it. */
export const breaksSignature = (breaks: { start: string; end: string }[]): string =>
  breaks.map((b) => `${b.start}|${b.end}`).sort().join(";");

/**
 * A guard that aborts the batch if the event's schedule definition is no longer what the handler read:
 * start, end, session length, gap or the set of breaks (name, price and the rest don't matter). It closes the
 * race where another admin edits the event between a handler's read and its batch, which could otherwise put a
 * booking on a slot the edit removed. The handler answers `event_changed` when the batch fails on it.
 *
 * The breaks are compared as one ordered string. `ORDER BY` in a subquery feeding `group_concat` is not
 * guaranteed by SQLite's documentation but is what its query planner does in practice (checked on local D1
 * by the guard's tests, which include breaks added in reverse order); the order is identical on both sides
 * for ASCII timestamps (binary collation, as the JS sort).
 */
export function scheduleUnchanged(
  db: D1Database,
  event: { id: number; startUtc: string; endUtc: string; sessionMinutes: number; gapMinutes: number; breaks: { start: string; end: string }[] },
): D1PreparedStatement {
  return guard(
    db,
    `(SELECT COUNT(*) FROM events WHERE id = ? AND start_utc = ? AND end_utc = ? AND session_minutes = ? AND gap_minutes = ?) = 1
     AND COALESCE((SELECT group_concat(k, ';') FROM (SELECT start_utc || '|' || end_utc AS k FROM breaks WHERE event_id = ? ORDER BY start_utc || '|' || end_utc)), '') = ?`,
    event.id, event.startUtc, event.endUtc, event.sessionMinutes, event.gapMinutes, event.id, breaksSignature(event.breaks),
  );
}
