/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityKey } from "../core/identity";
import { createTestEnv, insertEvent, type TestEnv } from "./db";
import { hex } from "./format-chars";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());

/** Every code point with the Unicode property Default_Ignorable_Code_Point, found by scanning the whole range. */
const IGNORABLE: number[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (/^\p{Default_Ignorable_Code_Point}$/u.test(String.fromCodePoint(cp))) IGNORABLE.push(cp);
}

/** The key as the application computed it before 0012: NFKC, trim, collapse whitespace, lower-case. */
const oldKey = (s: string): string => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-GB");

const MIGRATION = readFileSync(join(import.meta.dirname, "../../migrations/0012_strip_default_ignorables_from_keys.sql"), "utf8");

/** Runs the migration file again, statement by statement (D1's exec() reads one statement per line). */
async function runMigration(): Promise<void> {
  const sql = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await t.env.DB.prepare(statement).run();
  }
}

const BASE = Date.parse("2026-06-13T00:00:00Z");
let next = 0;
/** A booking with explicit keys and its own slot, so rows never clash unless the test makes them. */
const insertRow = () => t.env.DB.prepare(
  "INSERT INTO bookings (event_id, slot_start_utc, dog_name, handler_name, dog_key, handler_key) VALUES (?, ?, ?, ?, ?, ?)",
);
let insert: D1PreparedStatement;
beforeAll(() => { insert = insertRow(); });
const row = (eventId: number, dogName: string, handlerName: string, dogKey: string, handlerKey: string) =>
  insert.bind(eventId, new Date(BASE + 1000 * next++).toISOString().replace(".000Z", "Z"), dogName, handlerName, dogKey, handlerKey);

/** In pages: one result of tens of thousands of rows takes the local D1 far longer than the same rows in pieces. */
async function keysOf(eventId: number) {
  const all: { dog: string; handler: string; dk: string; hk: string }[] = [];
  for (let after = 0; ;) {
    const { results } = await t.env.DB.prepare(
      "SELECT id, dog_name AS dog, handler_name AS handler, dog_key AS dk, handler_key AS hk FROM bookings WHERE event_id = ? AND id > ? ORDER BY id LIMIT 1000",
    ).bind(eventId, after).all<{ id: number; dog: string; handler: string; dk: string; hk: string }>();
    if (results.length === 0) return all;
    after = results[results.length - 1].id;
    all.push(...results.map(({ dog, handler, dk, hk }) => ({ dog, handler, dk, hk })));
  }
}

describe("0012 strip default-ignorable code points from identity keys", () => {
  it("scans a plausible set of default-ignorable code points", () => {
    expect(IGNORABLE).toHaveLength(4174);
    for (const cp of [0x00ad, 0x034f, 0x115f, 0x1160, 0x3164, 0xfe0f, 0xffa0, 0xe0100, 0xe01ef]) expect(IGNORABLE, hex(cp)).toContain(cp);
  });

  it("makes every stored key equal identityKey(name) for every default-ignorable code point, in each position", { timeout: 120_000 }, async () => {
    const { id } = await insertEvent(t.env.DB);
    const names: string[] = [];
    for (const cp of IGNORABLE) {
      const c = String.fromCodePoint(cp);
      // U+FEFF is also JavaScript whitespace, so an old key already turned one inside a word into a space; that cannot be undone.
      const word = cp === 0xfeff ? "Rex" : `Re${c}x`;
      names.push(`${c}${word}${c}`, `Rex ${c} ${c} Jones`, c);
    }
    // One handler per row, so the new keys cannot clash with each other.
    const statements = names.map((n, i) => row(id, n, `Handler ${i}`, oldKey(n), `handler ${i}`));
    for (let i = 0; i < statements.length; i += 500) await t.env.DB.batch(statements.slice(i, i + 500));

    await runMigration();

    const after = await keysOf(id);
    expect(after).toHaveLength(names.length);
    const wrong = after.filter((r) => r.dk !== identityKey(r.dog)).map((r) => `${JSON.stringify(r.dog)} -> ${JSON.stringify(r.dk)}`);
    expect(wrong.slice(0, 10)).toEqual([]);
    expect(after.map((r) => r.dog)).toEqual(names); // display names untouched
    expect(after.every((r, i) => r.hk === `handler ${i}`)).toBe(true);
  });

  it("strips the handler key too", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([row(id, "Rex", "Sam️ Jones", "rex", oldKey("Sam️ Jones"))]);
    await runMigration();
    expect(await keysOf(id)).toEqual([{ dog: "Rex", handler: "Sam️ Jones", dk: "rex", hk: "sam jones" }]);
  });

  it("does not abort when stripping would make two bookings of one event collide, and leaves both rows as they were", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([
      row(id, "Rex", "Sam", "rex", "sam"),
      row(id, "Rex️", "Sam", oldKey("Rex️"), "sam"),
      row(id, "Fido️", "Ann", oldKey("Fido️"), "ann"),
      row(id, "Fidoㅤ", "Ann", oldKey("Fidoㅤ"), "ann"),
    ]);
    await runMigration();
    const after = await keysOf(id);
    expect(after).toHaveLength(4);
    // "rex" and "rex️": the second keeps its old key. "fido️" is stripped first, so "fidoᅠ" keeps its old key.
    expect(after.map((r) => r.dk)).toEqual(["rex", oldKey("Rex️"), "fido", oldKey("Fidoㅤ")]);
    expect(after.map((r) => r.dk)).toContain("rex️");
  });

  it("still processes the rows around a colliding one", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([
      row(id, "Rex", "Sam", "rex", "sam"),
      row(id, "Rex️", "Sam", oldKey("Rex️"), "sam"),
      row(id, "Bella️", "Sam", oldKey("Bella️"), "sam"),
    ]);
    await runMigration();
    expect((await keysOf(id)).map((r) => r.dk)).toEqual(["rex", "rex️", "bella"]);
  });

  it("is per event: the same stripped key in two events is no collision", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    await t.env.DB.batch([
      row(a.id, "Rex", "Sam", "rex", "sam"),
      row(b.id, "Rex️", "Sam", oldKey("Rex️"), "sam"),
    ]);
    await runMigration();
    expect((await keysOf(b.id)).map((r) => r.dk)).toEqual(["rex"]);
  });

  it("leaves untouched rows exactly as they were", async () => {
    const { id } = await insertEvent(t.env.DB);
    const plain = [["Rex", "Sam Jones"], ["Zoë", "Ann"], ["Ｒｅｘ", "Ann Lee"], ["犬", "太郎"], ["O'Brien", "Mary-Jane"], ["x y", "z"]];
    await t.env.DB.batch(plain.map(([d, h]) => row(id, d, h, oldKey(d), oldKey(h))));
    const before = await keysOf(id);
    await runMigration();
    expect(await keysOf(id)).toEqual(before);
    expect(before.map((r) => r.dk)).toEqual(plain.map(([d]) => oldKey(d)));
  });

  it("is idempotent", async () => {
    const { id } = await insertEvent(t.env.DB);
    await t.env.DB.batch([row(id, "Rex ️", "Sam", oldKey("Rex ️"), "sam")]);
    await runMigration();
    const once = await keysOf(id);
    await runMigration();
    expect(await keysOf(id)).toEqual(once);
  });
});
