/// <reference types="node" />
import { crc32, deflateSync } from "node:zlib";

// Tiny image fixtures built in code, so the tests carry no binary files. They have the structure a real
// file has (what src/core/image.ts walks); they aren't meant to be decodable beyond the PNG.

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const u32be = (n: number): Uint8Array => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u32le = (n: number): Uint8Array => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);
const u16le = (n: number): Uint8Array => Uint8Array.of(n & 255, (n >>> 8) & 255);
const u16be = (n: number): Uint8Array => Uint8Array.of(n >>> 8, n & 255);

export const pngChunk = (type: string, data: Uint8Array): Uint8Array =>
  concat(u32be(data.length), ascii(type), data, u32be(crc32(concat(ascii(type), data))));

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** A greyscale PNG. `pixels: false` gives only the header and IEND, so a huge declared size stays a tiny file. */
export function makePng(width: number, height: number, pixels = true): Uint8Array {
  const header = concat(u32be(width), u32be(height), Uint8Array.of(8, 0, 0, 0, 0));
  const rows = pixels ? deflateSync(Buffer.alloc((width + 1) * height)) : new Uint8Array(0);
  return concat(PNG_SIGNATURE, pngChunk("IHDR", header), ...(pixels ? [pngChunk("IDAT", rows)] : []), pngChunk("IEND", new Uint8Array(0)));
}

const segment = (marker: number, body: Uint8Array): Uint8Array => concat(Uint8Array.of(0xff, marker), u16be(body.length + 2), body);

/** Header-only JPEG: SOI, JFIF, SOF0, SOS with a little entropy data (FF00, a restart marker, a fill byte), EOI. */
export function makeJpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  return concat(
    Uint8Array.of(0xff, 0xd8),
    segment(0xe0, concat(ascii("JFIF\0"), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 0, 0))),
    segment(0xdb, new Uint8Array(65)),
    segment(0xc4, new Uint8Array(17)), // DHT: must not be mistaken for a frame header
    segment(sofMarker, concat(Uint8Array.of(8), u16be(height), u16be(width), Uint8Array.of(1, 1, 0x11, 0))),
    segment(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)),
    Uint8Array.of(0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56),
    Uint8Array.of(0xff, 0xff, 0xd9), // a fill byte before the EOI
  );
}

const riff = (...chunks: Uint8Array[]): Uint8Array => {
  const body = concat(ascii("WEBP"), ...chunks);
  return concat(ascii("RIFF"), u32le(body.length), body);
};
const riffChunk = (type: string, data: Uint8Array): Uint8Array =>
  concat(ascii(type), u32le(data.length), data, data.length % 2 ? Uint8Array.of(0) : new Uint8Array(0));

export const webpLossy = (width: number, height: number): Uint8Array =>
  riff(riffChunk("VP8 ", concat(Uint8Array.of(0x10, 0, 0, 0x9d, 0x01, 0x2a), u16le(width), u16le(height), new Uint8Array(4))));

export const webpLossless = (width: number, height: number): Uint8Array =>
  riff(riffChunk("VP8L", concat(Uint8Array.of(0x2f), u32le((width - 1) | ((height - 1) << 14)), new Uint8Array(3))));

export const webpExtended = (width: number, height: number): Uint8Array =>
  riff(
    riffChunk("VP8X", concat(Uint8Array.of(0, 0, 0, 0), u32le(width - 1).subarray(0, 3), u32le(height - 1).subarray(0, 3))),
    riffChunk("VP8L", concat(Uint8Array.of(0x2f), u32le((width - 1) | ((height - 1) << 14)), new Uint8Array(3))),
  );

/** The same fixture with its RIFF size field set to `size`. */
export function withRiffSize(webp: Uint8Array, size: number): Uint8Array {
  const out = webp.slice();
  out.set(u32le(size), 4);
  return out;
}

export const withTrailing = (bytes: Uint8Array, ...extra: number[]): Uint8Array => concat(bytes, Uint8Array.from(extra));

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A valid PNG of exactly `total` bytes, made up with an ancillary text chunk before IEND. */
export function pngOfSize(total: number, width = 4, height = 4): Uint8Array {
  const base = makePng(width, height);
  const filler = total - base.length - 12; // one extra chunk: 12 bytes of framing
  if (filler < 0) throw new Error("total is smaller than the base image");
  const iend = base.subarray(base.length - 12);
  return concat(base.subarray(0, base.length - 12), pngChunk("tEXt", new Uint8Array(filler)), iend);
}
