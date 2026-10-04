import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countRows, createTestEnv, insertEvent, type TestEnv } from "../test/db";
import { guard, isGuardFailure } from "./db-guard";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
};

const insertNamed = (name: string) =>
  t.env.DB.prepare(
    `INSERT INTO events (slug, name, start_utc, end_utc, session_minutes, venue_postcode)
     VALUES ('guard-test-slug-' || ?, ?, '2026-06-13T08:00:00Z', '2026-06-13T09:00:00Z', 5, 'AB1')`,
  ).bind(name, name);

describe("guard", () => {
  it("lets the batch through when the condition holds", async () => {
    const before = await countRows(t.env.DB, "events");
    await t.env.DB.batch([insertNamed("passes"), guard(t.env.DB, "1 = 1"), insertNamed("passes too")]);
    expect(await countRows(t.env.DB, "events")).toBe(before + 2);
  });

  it("fails with an error isGuardFailure recognises when the condition is false", async () => {
    const e = await caught(t.env.DB.batch([guard(t.env.DB, "1 = 2")]));
    expect(isGuardFailure(e)).toBe(true);
  });

  it("aborts the whole batch, before and after it, when the condition is false", async () => {
    const before = await countRows(t.env.DB, "events");
    const e = await caught(t.env.DB.batch([insertNamed("before"), guard(t.env.DB, "1 = 2"), insertNamed("after")]));
    expect(isGuardFailure(e)).toBe(true);
    expect(await countRows(t.env.DB, "events")).toBe(before);
    const stray = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE name IN ('before', 'after')").first<{ n: number }>();
    expect(stray!.n).toBe(0);
  });

  it("evaluates a condition on stored rows, with bound values, at the moment the batch runs", async () => {
    const { id } = await insertEvent(t.env.DB, { name: "Guarded" });
    const holds = "(SELECT COUNT(*) FROM events WHERE id = ? AND name = ?) = 1";
    await t.env.DB.batch([guard(t.env.DB, holds, id, "Guarded")]);
    expect(isGuardFailure(await caught(t.env.DB.batch([guard(t.env.DB, holds, id, "Other")])))).toBe(true);
  });

  it("sees what earlier statements in the same batch wrote", async () => {
    const { id } = await insertEvent(t.env.DB, { name: "Before" });
    const renamed = "(SELECT name FROM events WHERE id = ?) = 'After'";
    const rename = t.env.DB.prepare("UPDATE events SET name = 'After' WHERE id = ?").bind(id);
    await t.env.DB.batch([rename, guard(t.env.DB, renamed, id)]);
    expect((await t.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(id).first<{ name: string }>())!.name).toBe("After");
  });
});

describe("isGuardFailure", () => {
  it("does not recognise other database errors or non-errors", async () => {
    const { slug } = await insertEvent(t.env.DB);
    const clash = await caught(insertEvent(t.env.DB, { slug }));
    expect(String((clash as Error).message)).toContain("UNIQUE constraint failed");
    expect(isGuardFailure(clash)).toBe(false);
    expect(isGuardFailure(new Error("malformed JSON"))).toBe(false);
    expect(isGuardFailure("integer overflow")).toBe(false);
    expect(isGuardFailure(null)).toBe(false);
  });
});
