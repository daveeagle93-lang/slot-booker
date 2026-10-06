/// <reference types="node" />
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { inject } from "vitest";
import { generateSlug } from "../core/slug";

export interface TestEnv {
  env: { DB: D1Database };
  dispose(): Promise<void>;
}

/** A fresh, fully migrated, real local D1 (workerd/SQLite via wrangler), isolated per call. */
export async function createTestEnv(): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "slot-booker-test-"));
  cpSync(inject("templateDir"), dir, { recursive: true });
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: join(dir, "v3") } });
  return {
    // Only the binding: vars from a developer's generated wrangler.json (npm run configure) must not leak into tests.
    env: { DB: proxy.env.DB },
    async dispose() {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface EventOverrides {
  slug?: string;
  name?: string;
  startUtc?: string;
  endUtc?: string;
  sessionMinutes?: number;
  gapMinutes?: number;
  costPence?: number;
  venuePostcode?: string;
  details?: string;
  shareMessage?: string;
  archived?: boolean;
  /** Defaults to listed, as the column does. */
  listed?: boolean;
  /** Places per lane per time (default 1). */
  capacity?: number;
  /** Bookings one identity may hold (default 1). */
  identityLimit?: number;
  /** Lane names in order (default one unnamed lane). */
  lanes?: string[];
}

/** An event with its layout row and lanes, as the app creates them. `laneId` is the first lane; `laneIds` are all of them in order. */
export async function insertEvent(db: D1Database, o: EventOverrides = {}): Promise<{ id: number; slug: string; laneId: number; laneIds: number[] }> {
  const slug = o.slug ?? generateSlug();
  const names = o.lanes ?? [""];
  const [inserted, , ...lanes] = await db.batch([
    db.prepare(
      `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details, share_message, archived, listed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(
      slug,
      o.name ?? "Test event",
      o.startUtc ?? "2026-06-13T08:00:00Z",
      o.endUtc ?? "2026-06-13T11:00:00Z",
      o.sessionMinutes ?? 15,
      o.gapMinutes ?? 0,
      o.costPence ?? 1250,
      o.venuePostcode ?? "AB1 2CD",
      o.details ?? "Test details",
      o.shareMessage ?? "",
      o.archived ? 1 : 0,
      o.listed === false ? 0 : 1,
    ),
    db.prepare("INSERT INTO event_layout (event_id, capacity, identity_limit) VALUES ((SELECT id FROM events WHERE slug = ?), ?, ?)")
      .bind(slug, o.capacity ?? 1, o.identityLimit ?? 1),
    ...names.map((name, i) =>
      db.prepare("INSERT INTO event_lanes (event_id, position, name) VALUES ((SELECT id FROM events WHERE slug = ?), ?, ?) RETURNING id")
        .bind(slug, i + 1, name)),
  ]);
  const laneIds = lanes.map((l) => (l.results as { id: number }[])[0].id);
  return { id: (inserted.results as { id: number }[])[0].id, slug, laneId: laneIds[0], laneIds };
}

export async function insertBreak(db: D1Database, eventId: number, startUtc: string, endUtc: string, label = ""): Promise<void> {
  await db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (?, ?, ?, ?)").bind(eventId, startUtc, endUtc, label).run();
}

export interface BookingOverrides {
  /** Default: the event's first lane. */
  laneId?: number;
  /** Default: the next place after the highest one taken in that lane and slot. */
  place?: number;
}

/**
 * A booking straight into the table (no slot or window checks), in the event's first lane unless told otherwise. The
 * identity key is the two lower-cased names joined with U+001F, and its number the next one for that identity.
 */
export async function insertBooking(
  db: D1Database, eventId: number, slotStartUtc: string, dogName: string, handlerName: string, o: BookingOverrides = {},
): Promise<number> {
  const lane = o.laneId !== undefined
    ? { sql: "?", binds: [o.laneId] }
    : { sql: "(SELECT id FROM event_lanes WHERE event_id = ? ORDER BY position LIMIT 1)", binds: [eventId] };
  const key = `${dogName.toLowerCase()}\u001f${handlerName.toLowerCase()}`;
  const row = await db
    .prepare(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, identity_seq, token)
       VALUES (?, ${lane.sql}, ?,
         COALESCE(?, (SELECT COALESCE(MAX(place), 0) + 1 FROM bookings WHERE event_id = ? AND lane_id = ${lane.sql} AND slot_start_utc = ?)),
         ?, ?, ?, (SELECT COALESCE(MAX(identity_seq), 0) + 1 FROM bookings WHERE event_id = ? AND identity_key = ?), ?) RETURNING id`,
    )
    .bind(eventId, ...lane.binds, slotStartUtc, o.place ?? null, eventId, ...lane.binds, slotStartUtc, dogName, handlerName, key, eventId, key, generateSlug())
    .first<{ id: number }>();
  return row!.id;
}

/**
 * A D1 that behaves like `db` except that every batch goes through `intercept` first, which is told the SQL of each
 * statement in the batch and a `run` that executes it for real. For tests that make one kind of batch fail, or let
 * another request in just before it. Single statements (`first`, `all`, `run`) are not intercepted.
 */
export function interceptBatches(
  db: D1Database, intercept: (sqls: string[], run: () => Promise<D1Result[]>) => Promise<D1Result[]>,
): D1Database {
  // The platform proxy's statement objects can't be tagged, so the statements handed out are small wrappers that carry their SQL.
  interface Wrapped { sql: string; real: D1PreparedStatement }
  const wrap = (real: D1PreparedStatement, sql: string) => ({
    sql, real,
    bind: (...values: unknown[]) => wrap(real.bind(...values), sql),
    first: (...args: unknown[]) => (real.first as (...a: unknown[]) => Promise<unknown>)(...args),
    all: () => real.all(),
    run: () => real.run(),
    raw: (...args: unknown[]) => (real.raw as (...a: unknown[]) => Promise<unknown>)(...args),
  });
  return {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: (statements: Wrapped[]) => intercept(statements.map((s) => s.sql), () => db.batch(statements.map((s) => s.real))),
  } as unknown as D1Database;
}

/** True if a batch's statements (as interceptBatches reports them) include a booking insert. */
export const insertsBooking = (sqls: string[]): boolean => sqls.some((s) => /^\s*INSERT INTO bookings/.test(s));

/** Row count of a table, for asserting that a failed request left nothing behind. */
export async function countRows(db: D1Database, table: "events" | "breaks" | "bookings" | "event_templates" | "event_template_breaks" | "event_lanes" | "event_layout" | "event_template_lanes" | "event_template_layout"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

export interface TemplateOverrides { name?: string; isDefault?: boolean; shareMessage?: string }

/** A template straight into the table (no limit or default checks). */
export async function insertTemplate(db: D1Database, o: TemplateOverrides = {}): Promise<{ id: number }> {
  const name = o.name ?? `Template ${generateSlug()}`;
  const [row] = await db.batch([
    db.prepare(
      `INSERT INTO event_templates (name, is_default, venue_postcode, start_time, end_time, session_minutes, share_message)
       VALUES (?, ?, 'AB1 2CD', '09:00', '12:00', 15, ?) RETURNING id`,
    ).bind(name, o.isDefault ? 1 : 0, o.shareMessage ?? ""),
    db.prepare("INSERT INTO event_template_layout (template_id) VALUES ((SELECT id FROM event_templates WHERE name = ?))").bind(name),
    db.prepare("INSERT INTO event_template_lanes (template_id, position, name) VALUES ((SELECT id FROM event_templates WHERE name = ?), 1, '')").bind(name),
  ]);
  return { id: (row.results as { id: number }[])[0].id };
}
