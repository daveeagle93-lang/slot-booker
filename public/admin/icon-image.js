// Draws the app icons (browser tab, home screen, manifest) from the club's logo, in the browser: each is a square
// PNG filled with the theme's main colour with the logo scaled to fit inside a margin. The server checks every PNG
// again and is the real gate; this is only where the pixels come from (Functions can't draw).
//
// Like logo-image.js, the browser pieces (decoder, canvas) are passed in so tests can drive this without a browser.

import { bytesToBase64, decode } from "./logo-image.js";

/** One icon per request on the server, in this order. */
export const ICON_SIZES = [32, 180, 512];
/**
 * The most the server stores for each size (MAX_ICON_BYTES in src/server/settings.ts; a test keeps the two equal).
 * A PNG over its cap is redrawn with the logo smaller instead of being sent to be refused.
 */
export const MAX_ICON_BYTES = { 32: 16 * 1024, 180: 96 * 1024, 512: 200 * 1024 };
/** The logo's size, as a fraction of the padded box, for each try: the first that fits the cap is used. */
export const ICON_SCALES = [1, 0.8, 0.65, 0.5, 0.35];
/** The margin on each side, as a fraction of the icon's size. */
export const ICON_PADDING = 0.14;

/** An error whose message is fit to show to the admin as it is. */
export class IconError extends Error {}

/**
 * Where to draw a `width` x `height` logo in a `size` x `size` icon: as large as fits inside the margin with the
 * aspect ratio kept (a small logo is enlarged, a large one reduced), centred. `shrink` (0 to 1) scales the box down further.
 */
export function iconLayout(size, width, height, shrink = 1) {
  const box = (size - 2 * Math.round(size * ICON_PADDING)) * shrink;
  const scale = Math.min(box / width, box / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: Math.round((size - w) / 2), y: Math.round((size - h) / 2), width: w, height: h };
}

const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type));

/**
 * The PNG bytes of one icon. `image` is a decoded logo (see decode in logo-image.js). A PNG over the size's cap is
 * redrawn with the logo smaller (ICON_SCALES) until it fits; an IconError if even the smallest is too big.
 */
export async function drawIcon(size, background, image, deps) {
  for (const scale of ICON_SCALES) {
    const canvas = deps.createCanvas(size, size);
    const context = canvas.getContext("2d");
    if (!context) throw new IconError("Your browser couldn't draw the app icons.");
    context.fillStyle = background;
    context.fillRect(0, 0, size, size);
    context.imageSmoothingQuality = "high";
    const at = iconLayout(size, image.width, image.height, scale);
    context.drawImage(image.source, at.x, at.y, at.width, at.height);
    const blob = await toBlob(canvas, "image/png");
    if (!blob || blob.type !== "image/png") throw new IconError("Your browser couldn't make PNG icons.");
    if (blob.size <= MAX_ICON_BYTES[size]) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new IconError(`The ${size} px icon is too large to store, even with the logo made smaller.`);
}

/**
 * Draws every size from `logo` (a Blob or File of the logo image) on `background` (the current main colour, "#rrggbb")
 * and hands each to `put(size, { data, background, logoSha256 })`, which resolves true once the server has stored it.
 * One size at a time. Stops early, quietly, once `isCurrent()` is false (a newer run has taken over). Throws
 * IconError (or whatever the decoder or `put` threw) on failure; the caller decides what that means for the page.
 */
export async function updateIcons({ logo, background, logoSha256, image, put, isCurrent = () => true }) {
  const decoded = await decode(logo, image);
  try {
    for (const size of ICON_SIZES) {
      if (!isCurrent()) return;
      const png = await drawIcon(size, background, decoded, image);
      if (!isCurrent()) return;
      if (!(await put(size, { data: bytesToBase64(png), background, logoSha256 }))) {
        throw new IconError(`The server didn't accept the ${size} px icon.`);
      }
    }
  } finally {
    decoded.close();
  }
}
