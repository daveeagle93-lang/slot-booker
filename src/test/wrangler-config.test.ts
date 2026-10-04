import { expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

const dbOf = (env?: string) => {
  const dbs = unstable_readConfig({ env }, {}).d1_databases;
  return dbs.find((d: { binding: string }) => d.binding === "DB");
};

it("gives production and preview separate DB bindings", () => {
  const prod = dbOf();
  const preview = dbOf("preview");
  expect(prod).toBeDefined();
  expect(preview).toBeDefined();
  expect(preview?.database_name).not.toBe(prod?.database_name);
  expect(preview?.database_id).not.toBe(prod?.database_id);
});

it("keeps the production name that the test global-setup migrates", () => {
  expect(dbOf()?.database_name).toBe("slot-booker-db");
});
