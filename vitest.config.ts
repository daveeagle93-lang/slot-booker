/// <reference types="node" />
import { defineConfig } from "vitest/config";

// Not London, so tests that need Europe/London must ask for it explicitly rather than pass by luck.
// Set before defineConfig so the test worker processes inherit it.
process.env.TZ = "Pacific/Auckland";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["src/test/global-setup.ts"],
    include: ["src/**/*.test.ts", "functions/**/*.test.ts", "public/**/*.test.ts"],
  },
});
