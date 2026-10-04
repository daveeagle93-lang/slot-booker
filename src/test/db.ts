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
  archived?: boolean;
}

export async function insertEvent(db: D1Database, o: EventOverrides = {}): Promise<{ id: number; slug: string }> {
  const slug = o.slug ?? generateSlug();
  const row = await db
    .prepare(
      `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, gap_minutes, cost_pence, venue_postcode, details, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      slug,
      o.name ?? "Test event",
      o.startUtc ?? "2026-06-13T08:00:00Z",
      o.endUtc ?? "2026-06-13T11:00:00Z",
      o.sessionMinutes ?? 15,
      o.gapMinutes ?? 0,
      o.costPence ?? 1250,
      o.venuePostcode ?? "AB1 2CD",
      o.details ?? "Test details",
      o.archived ? 1 : 0,
    )
    .first<{ id: number }>();
  return { id: row!.id, slug };
}

export async function insertBreak(db: D1Database, eventId: number, startUtc: string, endUtc: string, label = ""): Promise<void> {
  await db.prepare("INSERT INTO breaks (event_id, start_utc, end_utc, label) VALUES (?, ?, ?, ?)").bind(eventId, startUtc, endUtc, label).run();
}

/** A booking straight into the table (no slot or window checks); the identity keys are the lower-cased names. */
export async function insertBooking(db: D1Database, eventId: number, slotStartUtc: string, dogName: string, handlerName: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key, token)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(eventId, slotStartUtc, dogName, handlerName, dogName.toLowerCase(), handlerName.toLowerCase(), generateSlug())
    .first<{ id: number }>();
  return row!.id;
}

/** Row count of a table, for asserting that a failed request left nothing behind. */
export async function countRows(db: D1Database, table: "events" | "breaks" | "bookings"): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}
