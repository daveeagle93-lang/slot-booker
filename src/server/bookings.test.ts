import { describe, expect, it } from "vitest";
import { readJsonObject } from "./bookings";

const request = (body: string): Request =>
  new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body });

/** A JSON object whose serialised form is exactly `bytes` bytes. */
const objectOfSize = (bytes: number): string => {
  const base = JSON.stringify({ p: "" });
  return JSON.stringify({ p: "x".repeat(bytes - base.length) });
};

describe("readJsonObject body cap", () => {
  it("defaults to 4096 bytes", async () => {
    expect(await readJsonObject(request(objectOfSize(4096)))).toEqual({ p: expect.any(String) });
    const over = await readJsonObject(request(objectOfSize(4097)));
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
  });

  it("takes a larger cap, and still enforces it", async () => {
    expect(await readJsonObject(request(objectOfSize(32768)), 32768)).toEqual({ p: expect.any(String) });
    const over = await readJsonObject(request(objectOfSize(32769)), 32768);
    expect(over).toBeInstanceOf(Response);
    expect((over as Response).status).toBe(413);
  });
});
