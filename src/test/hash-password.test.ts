/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parsePasswordHash, verifyPassword } from "../server/auth/crypto";

const run = (input: string, args: string[] = []) =>
  spawnSync(process.execPath, ["scripts/hash-password.ts", ...args], { input, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });

describe("scripts/hash-password.ts", () => {
  it("prints a hash in the server's format that the server's verifier accepts", async () => {
    const password = "correct horse battery staple";
    const out = run(`${password}\n`);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^pbkdf2-sha256\$100000\$[\w-]+\$[\w-]+\n$/);
    const parsed = parsePasswordHash(out.stdout.trim());
    expect(parsed).not.toBeNull();
    expect(await verifyPassword(password, parsed!)).toBe(true);
    expect(await verifyPassword("something else entirely", parsed!)).toBe(false);
  });

  it("strips one trailing newline (LF or CRLF) and nothing else", async () => {
    for (const [input, expected] of [["a-long-password-1\r\n", "a-long-password-1"], [" a-long-password-1 \n", " a-long-password-1 "], ["a-long-password-1", "a-long-password-1"]]) {
      const parsed = parsePasswordHash(run(input).stdout.trim())!;
      expect(await verifyPassword(expected, parsed)).toBe(true);
    }
  });

  it("refuses a password shorter than 14 characters", () => {
    for (const input of ["", "\n", "short\n", "1234567890123\n"]) {
      const out = run(input);
      expect(out.status, JSON.stringify(input)).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("at least 14");
    }
    expect(run("12345678901234\n").status).toBe(0);
  });

  it("refuses a password the login form could never send: over 256 UTF-16 code units", () => {
    const tooLong = run(`${"a".repeat(257)}\n`);
    expect(tooLong.status).toBe(1);
    expect(tooLong.stdout).toBe("");
    expect(tooLong.stderr).toContain("at most 256");
    expect(run(`${"a".repeat(256)}\n`).status).toBe(0);
    // 129 emoji are 129 code points but 258 UTF-16 units, and login checks password.length
    const emoji = run(`${"\u{1F600}".repeat(129)}\n`);
    expect(emoji.status).toBe(1);
    expect(emoji.stderr).toContain("at most 256");
    expect(run(`${"\u{1F600}".repeat(128)}\n`).status).toBe(0);
  });

  it("refuses a password given as an argument, and does not echo it", () => {
    const out = run("", ["a-perfectly-long-password"]);
    expect(out.status).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("no arguments");
    expect(out.stderr).not.toContain("a-perfectly-long-password");
    expect(run("a-perfectly-long-password\n", ["--password", "x"]).status).toBe(1);
  });
});
