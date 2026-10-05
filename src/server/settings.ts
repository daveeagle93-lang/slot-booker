import { MAX_IMAGE_BYTES, type ImageType } from "../core/image";
import { INVISIBLE, LINE_SEPARATORS } from "./bookings";

const MAX_CLUB_NAME = 80;
const MAX_CONTACT_NAME = 100;
const MAX_EMAIL = 254;
const MAX_WEBSITE = 200;

export interface SiteSettings {
  clubName: string;
  privacyContact: { name: string; email: string };
  website: string;
}

export interface LogoInfo { contentType: ImageType; width: number; height: number; bytes: number; sha256: string }

type Fields = Record<string, string>;

/**
 * Trimmed text of at most `max` code points, with the same character rules as the event and booking names
 * (src/server/admin-events.ts). Empty is allowed: it means "not set".
 */
function checkText(value: unknown, label: string, max: number): { text: string } | { message: string } {
  if (typeof value !== "string") return { message: `The ${label} must be text (it can be empty).` };
  if (!value.isWellFormed()) return { message: `The ${label} can't contain unpaired surrogate characters.` };
  if (INVISIBLE.test(value)) return { message: `The ${label} can't contain invisible or direction-changing characters.` };
  if (LINE_SEPARATORS.test(value)) return { message: `The ${label} can't contain line or paragraph separators.` };
  const text = value.trim();
  if ([...text].length > max) return { message: `The ${label} must be at most ${max} characters.` };
  if (/\p{Cc}/u.test(text)) return { message: `The ${label} can't contain control characters.` };
  return { text };
}

// One plain address. Letters and digits (any script), and . _ + - in the local part: no spaces, quotes, angle
// brackets, commas, semicolons or parentheses, so it can't be several addresses or a "Name <a@b.c>" form, and it is
// safe to put in a mailto: link. The domain needs a dot.
const EMAIL = /^[\p{L}\p{N}._+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;

function checkEmail(value: unknown): { text: string } | { message: string } {
  const checked = checkText(value, "email address", MAX_EMAIL);
  if ("message" in checked || checked.text === "" || EMAIL.test(checked.text)) return checked;
  return { message: "Enter one email address, like name@example.org." };
}

function checkWebsite(value: unknown): { text: string } | { message: string } {
  const checked = checkText(value, "website address", MAX_WEBSITE);
  if ("message" in checked || checked.text === "") return checked;
  const bad = { message: "Enter a full web address starting with https://, like https://example.org." };
  // The prefix check keeps out javascript:, data:, http:, ftp:, //host and a bare host before the URL parser's leniency.
  if (!/^https:\/\//i.test(checked.text) || /\s/u.test(checked.text)) return bad;
  let url: URL;
  try {
    url = new URL(checked.text);
  } catch {
    return bad;
  }
  if (url.protocol !== "https:" || url.hostname === "") return bad;
  if (url.username !== "" || url.password !== "") return { message: "The website address can't contain a user name or password." };
  if (url.href.length > MAX_WEBSITE) return { message: `The website address must be at most ${MAX_WEBSITE} characters.` };
  return { text: url.href };
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Validates the whole settings group (all three parts are required), or returns a message per field. */
export function parseSettingsInput(raw: Record<string, unknown>): { settings: SiteSettings } | { fields: Fields } {
  const fields: Fields = {};
  const clubName = checkText(raw.clubName, "club name", MAX_CLUB_NAME);
  if ("message" in clubName) fields.clubName = clubName.message;
  const website = checkWebsite(raw.website);
  if ("message" in website) fields.website = website.message;

  let name = "";
  let email = "";
  const contact = asRecord(raw.privacyContact);
  if (!contact) fields.privacyContact = "Send the privacy contact as a name and an email address.";
  else {
    const n = checkText(contact.name, "privacy contact name", MAX_CONTACT_NAME);
    const e = checkEmail(contact.email);
    if ("message" in n) fields["privacyContact.name"] = n.message;
    else name = n.text;
    if ("message" in e) fields["privacyContact.email"] = e.message;
    else email = e.text;
    if (!("message" in n) && !("message" in e) && name !== "" && email === "") {
      fields["privacyContact.email"] = "A privacy contact needs an email address.";
    }
  }

  if (Object.keys(fields).length > 0) return { fields };
  return { settings: { clubName: (clubName as { text: string }).text, privacyContact: { name, email }, website: (website as { text: string }).text } };
}

export async function loadSettings(db: D1Database): Promise<SiteSettings> {
  const row = await db
    .prepare("SELECT club_name, privacy_contact_name, privacy_contact_email, website_url FROM site_settings WHERE id = 1")
    .first<{ club_name: string; privacy_contact_name: string; privacy_contact_email: string; website_url: string }>();
  // The migration inserts the row; a missing one reads as nothing set rather than failing every page.
  return {
    clubName: row?.club_name ?? "",
    privacyContact: { name: row?.privacy_contact_name ?? "", email: row?.privacy_contact_email ?? "" },
    website: row?.website_url ?? "",
  };
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

/** Replaces the text settings. The theme columns are not touched. */
export async function saveSettings(db: D1Database, s: SiteSettings): Promise<void> {
  await db
    .prepare(
      `INSERT INTO site_settings (id, club_name, privacy_contact_name, privacy_contact_email, website_url) VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET club_name = excluded.club_name, privacy_contact_name = excluded.privacy_contact_name,
         privacy_contact_email = excluded.privacy_contact_email, website_url = excluded.website_url, updated_at = ${NOW_SQL}`,
    )
    .bind(s.clubName, s.privacyContact.name, s.privacyContact.email, s.website)
    .run();
}

interface LogoRow { content_type: ImageType; width: number; height: number; size: number; sha256: string }
const LOGO_INFO_SQL = "SELECT content_type, width, height, length(bytes) AS size, sha256 FROM site_logo WHERE id = 1";
const toInfo = (r: LogoRow): LogoInfo => ({ contentType: r.content_type, width: r.width, height: r.height, bytes: r.size, sha256: r.sha256 });

/** What the logo is, without reading its bytes. */
export async function loadLogoInfo(db: D1Database): Promise<LogoInfo | null> {
  const row = await db.prepare(LOGO_INFO_SQL).first<LogoRow>();
  return row ? toInfo(row) : null;
}

/** The logo with its bytes. D1 hands a BLOB back as an array of numbers (or an ArrayBuffer, depending on the runtime). */
export async function loadLogo(db: D1Database): Promise<{ info: LogoInfo; data: Uint8Array } | null> {
  const row = await db
    .prepare("SELECT content_type, width, height, length(bytes) AS size, sha256, bytes FROM site_logo WHERE id = 1")
    .first<LogoRow & { bytes: ArrayBuffer | number[] }>();
  if (!row) return null;
  return { info: toInfo(row), data: row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : Uint8Array.from(row.bytes) };
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Stores the logo in place of any earlier one. The caller has already run the bytes through inspectImage. */
export async function saveLogo(db: D1Database, data: Uint8Array, image: { type: ImageType; width: number; height: number }): Promise<LogoInfo> {
  const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
  await db
    .prepare(
      `INSERT INTO site_logo (id, content_type, bytes, width, height, sha256) VALUES (1, ?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes, width = excluded.width,
         height = excluded.height, sha256 = excluded.sha256, updated_at = ${NOW_SQL}`,
    )
    .bind(image.type, data, image.width, image.height, sha256)
    .run();
  return { contentType: image.type, width: image.width, height: image.height, bytes: data.byteLength, sha256 };
}

/** Removes the logo. Removing one that isn't there is fine. */
export async function deleteLogo(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM site_logo WHERE id = 1").run();
}

/** The `?v=` that changes whenever the logo does, so a long cache lifetime is safe. */
export const logoVersion = (sha256: string): string => sha256.slice(0, 16);
export const logoUrl = (info: LogoInfo): string => `/api/logo?v=${logoVersion(info.sha256)}`;

export interface AdminLogo { url: string; width: number; height: number; contentType: ImageType; bytes: number }
export const adminLogo = (info: LogoInfo): AdminLogo => ({
  url: logoUrl(info), width: info.width, height: info.height, contentType: info.contentType, bytes: info.bytes,
});

/** Everything the settings form shows. */
export async function loadAdminSettings(db: D1Database): Promise<SiteSettings & { logo: AdminLogo | null }> {
  const [settings, logo] = await Promise.all([loadSettings(db), loadLogoInfo(db)]);
  return { ...settings, logo: logo ? adminLogo(logo) : null };
}

export interface PublicSettings {
  clubName: string | null;
  website: string | null;
  privacyContact: { name: string; email: string } | null;
  logo: { url: string; width: number; height: number } | null;
}

/** Only what public pages need: no timestamps, theme or hashes (beyond the `?v=` in the logo URL). */
export async function loadPublicSettings(db: D1Database): Promise<PublicSettings> {
  const [settings, logo] = await Promise.all([loadSettings(db), loadLogoInfo(db)]);
  return {
    clubName: settings.clubName || null,
    website: settings.website || null,
    // The contact counts as set only with an email.
    privacyContact: settings.privacyContact.email ? settings.privacyContact : null,
    logo: logo ? { url: logoUrl(logo), width: logo.width, height: logo.height } : null,
  };
}

/** The longest base64 text that can decode to a logo within the size cap; checked before decoding. */
export const MAX_LOGO_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Standard base64 only: the + / alphabet, padded to a multiple of 4. No whitespace, no URL-safe alphabet. */
export function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
