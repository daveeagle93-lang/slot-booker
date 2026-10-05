// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { drawIcon, ICON_PADDING, ICON_SIZES, IconError, iconLayout, updateIcons } from "./icon-image.js";

const SHA = "a".repeat(64);
const logo = (type = "image/webp") => new Blob([new Uint8Array(10)], { type });

type Op = [string, ...unknown[]];

/** Fake browser pieces: records what is drawn on each canvas; toBlob answers `type` with `bytes(size)` bytes. */
function fakes({ source = { width: 300, height: 100 }, type = "image/png", bytes = (size: number) => size, context = true } = {}) {
  const drawn: { size: number; ops: Op[] }[] = [];
  const close = vi.fn();
  const deps = {
    createImageBitmap: vi.fn(async (_file: unknown) => ({ ...source, close })),
    loadImage: vi.fn(async (_file: unknown) => ({ source: {}, ...source })),
    createCanvas: (width: number, height: number) => {
      const canvas = { size: width, ops: [] as Op[] };
      drawn.push(canvas);
      expect(width).toBe(height);
      return {
        getContext: () => (context ? {
          set fillStyle(v: string) { canvas.ops.push(["fillStyle", v]); },
          set imageSmoothingQuality(v: string) { canvas.ops.push(["imageSmoothingQuality", v]); },
          fillRect: (...a: unknown[]) => canvas.ops.push(["fillRect", ...a]),
          drawImage: (_source: unknown, ...a: unknown[]) => canvas.ops.push(["drawImage", ...a]),
        } : null),
        toBlob: (cb: (b: Blob | null) => void, asked: string) => {
          canvas.ops.push(["toBlob", asked]);
          cb(type === "" ? null : new Blob([new Uint8Array(bytes(width))], { type }));
        },
      };
    },
  };
  return { deps, drawn, close };
}

describe("iconLayout", () => {
  it("uses 14% of the size as the margin and fits the logo in what is left, centred", () => {
    expect(ICON_PADDING).toBe(0.14);
    expect(iconLayout(512, 512, 512)).toEqual({ x: 72, y: 72, width: 368, height: 368 });
    expect(iconLayout(180, 180, 180)).toEqual({ x: 25, y: 25, width: 130, height: 130 });
    expect(iconLayout(32, 32, 32)).toEqual({ x: 4, y: 4, width: 24, height: 24 });
  });

  it("keeps the aspect ratio: a wide logo fills the width, a tall one the height", () => {
    expect(iconLayout(512, 300, 100)).toEqual({ x: 72, y: 195, width: 368, height: 123 });
    expect(iconLayout(512, 100, 300)).toEqual({ x: 195, y: 72, width: 123, height: 368 });
  });

  it("enlarges a small logo to fit rather than leaving it tiny", () => {
    expect(iconLayout(180, 10, 10)).toEqual({ x: 25, y: 25, width: 130, height: 130 });
  });

  it.each(ICON_SIZES)("always lands inside the margin at %i px, however odd the logo's shape", (size) => {
    const pad = Math.round(size * ICON_PADDING);
    for (const [w, h] of [[1, 1], [512, 1], [1, 512], [512, 511], [77, 13], [13, 77], [333, 333], [1000, 3], [3, 1000]]) {
      const at = iconLayout(size, w, h);
      expect(at.width, `${w}x${h}`).toBeGreaterThanOrEqual(1);
      expect(at.height, `${w}x${h}`).toBeGreaterThanOrEqual(1);
      expect(at.x, `${w}x${h}`).toBeGreaterThanOrEqual(pad);
      expect(at.y, `${w}x${h}`).toBeGreaterThanOrEqual(pad);
      expect(at.x + at.width, `${w}x${h}`).toBeLessThanOrEqual(size - pad);
      expect(at.y + at.height, `${w}x${h}`).toBeLessThanOrEqual(size - pad);
      expect(Math.abs(at.x - (size - at.x - at.width)), `${w}x${h}`).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - (size - at.y - at.height)), `${w}x${h}`).toBeLessThanOrEqual(1);
    }
  });
});

describe("drawIcon", () => {
  it("fills the whole square with the background, then draws the logo in its layout, then exports a PNG", async () => {
    const { deps, drawn } = fakes();
    const png = await drawIcon(180, "#1b6b3a", { source: {}, width: 300, height: 100 }, deps);
    expect(png).toBeInstanceOf(Uint8Array);
    expect(png.length).toBe(180);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].ops).toEqual([
      ["fillStyle", "#1b6b3a"], ["fillRect", 0, 0, 180, 180], ["imageSmoothingQuality", "high"],
      ["drawImage", 25, 69, 130, 43], ["toBlob", "image/png"],
    ]);
  });

  it("refuses a browser that has no 2D context, or answers anything but PNG", async () => {
    await expect(drawIcon(32, "#000000", { source: {}, width: 1, height: 1 }, fakes({ context: false }).deps)).rejects.toBeInstanceOf(IconError);
    for (const type of ["image/webp", "image/jpeg", "", "text/html"]) {
      await expect(drawIcon(32, "#000000", { source: {}, width: 1, height: 1 }, fakes({ type }).deps), type).rejects.toBeInstanceOf(IconError);
    }
  });
});

describe("updateIcons", () => {
  const run = (over: Record<string, unknown> = {}) => {
    const f = fakes();
    const calls: { size: number; body: { data: string; background: string; logoSha256: string } }[] = [];
    const put = vi.fn(async (size: number, body: never) => { calls.push({ size, body }); return true; });
    const args = { logo: logo(), background: "#0b5cad", logoSha256: SHA, image: f.deps, put, ...over };
    return { f, calls, put, args, done: () => updateIcons(args as never) };
  };

  it("draws and sends 32, 180 and 512 px, in that order, one request each", async () => {
    const { f, calls, done } = run();
    await done();
    expect(calls.map((c) => c.size)).toEqual([32, 180, 512]);
    expect(f.drawn.map((d) => d.size)).toEqual([32, 180, 512]);
    for (const c of calls) {
      expect(Object.keys(c.body).sort()).toEqual(["background", "data", "logoSha256"]);
      expect(c.body.background).toBe("#0b5cad");
      expect(c.body.logoSha256).toBe(SHA);
      expect(atob(c.body.data)).toHaveLength(c.size); // fakes() makes `size` bytes
    }
  });

  it("decodes the logo once and releases it afterwards", async () => {
    const { f, done } = run();
    await done();
    expect(f.deps.createImageBitmap).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to the <img> decode, as for the logo", async () => {
    const f = fakes();
    f.deps.createImageBitmap.mockRejectedValue(new Error("no"));
    const { calls, args } = run({ image: f.deps });
    await updateIcons(args as never);
    expect(f.deps.loadImage).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
  });

  it("stops at the first size the server refuses, and throws", async () => {
    const { f, calls, args } = run({ put: vi.fn(async (size: number) => size !== 180) });
    await expect(updateIcons(args as never)).rejects.toBeInstanceOf(IconError);
    expect(f.drawn.map((d) => d.size)).toEqual([32, 180]);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("lets a failed request or a bad decode through as an error, after releasing the logo", async () => {
    const { f, args } = run({ put: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(updateIcons(args as never)).rejects.toThrow("offline");
    expect(f.close).toHaveBeenCalledTimes(1);
    const broken = fakes();
    broken.deps.createImageBitmap.mockRejectedValue(new Error("no"));
    broken.deps.loadImage.mockRejectedValue(new Error("no"));
    await expect(run({ image: broken.deps }).done()).rejects.toThrow();
  });

  it("stops quietly once a newer run has taken over, before drawing or sending the next size", async () => {
    let current = true;
    const { f, calls, args } = run({
      isCurrent: () => current,
      put: vi.fn(async (size: number) => { if (size === 32) current = false; return true; }),
    });
    await updateIcons(args as never);
    expect(f.drawn.map((d) => d.size)).toEqual([32]);
    expect(calls).toHaveLength(0);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
