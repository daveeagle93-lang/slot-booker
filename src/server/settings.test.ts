import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makePng } from "../test/images";
import { createTestEnv, type TestEnv } from "../test/db";
import {
  decodeBase64, deleteLogo, loadAdminSettings, loadLogo, loadLogoInfo, loadPublicSettings, loadSettings, MAX_LOGO_BASE64,
  parseSettingsInput, saveLogo, saveSettings,
} from "./settings";

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(() => t.dispose());
beforeEach(async () => {
  await t.env.DB.prepare("DELETE FROM site_logo").run();
  await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "", email: "" }, website: "" });
});

const ok = { clubName: "Example Dog Club", privacyContact: { name: "Pat Example", email: "pat@example.org" }, website: "https://example.org/" };
const parse = (over: Record<string, unknown>) => parseSettingsInput({ ...ok, ...over });
const fieldsOf = (r: ReturnType<typeof parseSettingsInput>) => ("fields" in r ? r.fields : null);

describe("parseSettingsInput", () => {
  it("accepts a full set and trims it", () => {
    expect(parseSettingsInput(ok)).toEqual({ settings: ok });
    expect(parse({ clubName: "  Spaced  ", website: " https://example.org/x ", privacyContact: { name: " A ", email: " a@b.co " } })).toEqual({
      settings: { clubName: "Spaced", privacyContact: { name: "A", email: "a@b.co" }, website: "https://example.org/x" },
    });
  });

  it("accepts everything empty (nothing set)", () => {
    expect(parseSettingsInput({ clubName: "", privacyContact: { name: "", email: "" }, website: "" })).toEqual({
      settings: { clubName: "", privacyContact: { name: "", email: "" }, website: "" },
    });
    expect(parse({ clubName: "   ", website: "  " })).toMatchObject({ settings: { clubName: "", website: "" } });
  });

  it("accepts an email with no name", () => {
    expect(parse({ privacyContact: { name: "", email: "office@example.org" } })).toMatchObject({ settings: { privacyContact: { name: "", email: "office@example.org" } } });
  });

  it("requires all three parts, as text", () => {
    for (const key of ["clubName", "privacyContact", "website"]) {
      const { [key]: _omitted, ...rest } = ok as Record<string, unknown>;
      expect(Object.keys(fieldsOf(parseSettingsInput(rest))!), `missing ${key}`).toEqual([key]);
    }
    for (const value of [null, 5, true, [], {}, ["x"]]) {
      expect(fieldsOf(parse({ clubName: value })), JSON.stringify(value)).toHaveProperty("clubName");
      expect(fieldsOf(parse({ website: value })), JSON.stringify(value)).toHaveProperty("website");
    }
    for (const value of [null, "x", 5, [], [{}]]) {
      expect(fieldsOf(parse({ privacyContact: value })), JSON.stringify(value)).toHaveProperty("privacyContact");
    }
    expect(fieldsOf(parse({ privacyContact: { name: "x" } }))).toHaveProperty(["privacyContact.email"]);
    expect(fieldsOf(parse({ privacyContact: { email: "a@b.co" } }))).toHaveProperty(["privacyContact.name"]);
  });

  it("reports a field-level message for each bad field at once", () => {
    const fields = fieldsOf(parseSettingsInput({ clubName: 1, privacyContact: { name: "x".repeat(101), email: "nope" }, website: "http://x.org" }))!;
    expect(Object.keys(fields).sort()).toEqual(["clubName", "privacyContact.email", "privacyContact.name", "website"]);
  });

  describe("club name and contact name", () => {
    it("counts code points, not UTF-16 units: 80 emoji are fine, 81 are not", () => {
      expect(fieldsOf(parse({ clubName: "😀".repeat(80) }))).toBeNull();
      expect(fieldsOf(parse({ clubName: "😀".repeat(81) }))).toHaveProperty("clubName");
      expect(fieldsOf(parse({ clubName: "a".repeat(80) }))).toBeNull();
      expect(fieldsOf(parse({ clubName: "a".repeat(81) }))).toHaveProperty("clubName");
      const contact = (name: string) => parse({ privacyContact: { name, email: "a@b.co" } });
      expect(fieldsOf(contact("😀".repeat(100)))).toBeNull();
      expect(fieldsOf(contact("😀".repeat(101)))).toHaveProperty(["privacyContact.name"]);
    });

    it.each([
      ["a control character", "Club\u0000"], ["a tab inside", "Dog\tClub"], ["a newline", "Dog\nClub"], ["DEL", "Dog\u007fClub"],
      ["U+2028", "Dog Club"], ["U+2029", "Dog Club"], ["a zero-width space", "Dog​Club"], ["a bidi override", "Dog‮Club"],
      ["a BOM", "﻿Club"], ["an unpaired surrogate", "Club\ud800"],
    ])("rejects %s", (_name, value) => {
      expect(fieldsOf(parse({ clubName: value }))).toHaveProperty("clubName");
      expect(fieldsOf(parse({ privacyContact: { name: value, email: "a@b.co" } }))).toHaveProperty(["privacyContact.name"]);
    });
  });

  describe("privacy contact email", () => {
    const email = (value: unknown) => fieldsOf(parse({ privacyContact: { name: "", email: value } }))?.["privacyContact.email"];

    it.each(["a@b.co", "first.last+tag@mail.example.org", "o_neil-x@sub-domain.example.co.uk", "ünï@exämple.org", "1@2.3"])("accepts %s", (value) => {
      expect(email(value)).toBeUndefined();
    });

    it.each([
      "plain", "a@b", "@b.co", "a@", "a@.co", "a@b.", "a@b..co", "a@@b.co", "a@b@c.co", "a b@c.co", "a@b c.co", "a@b.co d@e.fr",
      "<a@b.co>", "Pat <a@b.co>", "\"a\"@b.co", "'a'@b.co", "a@b.co, d@e.fr", "a@b.co; d@e.fr", "a(b)@c.co", "a@b.co(x)", "a[b]@c.co",
      "a\\b@c.co", "a:b@c.co", "a@b.co?subject=x", "a@b.co/x", "a@b.co#x", "a%0d@b.co", "a\u0000@b.co", "a\n@b.co", "a@b.co\nBcc: x@y.zz",
      "mailto:a@b.co", "a@[127.0.0.1]", "a@b_c.co", "a&b@c.co", "a=b@c.co", "a/b@c.co", "a?b@c.co",
    ])("rejects %j", (value) => {
      expect(email(value), value).toBeTypeOf("string");
    });

    it("allows 254 characters and rejects 255", () => {
      const at = (n: number) => `${"a".repeat(n - "@b.co".length)}@b.co`;
      expect(email(at(254))).toBeUndefined();
      expect(email(at(255))).toMatch(/at most 254/);
    });

    it("rejects a name without an email, on the email field", () => {
      const fields = fieldsOf(parse({ privacyContact: { name: "Pat", email: "" } }));
      expect(fields).toEqual({ "privacyContact.email": "A privacy contact needs an email address." });
      expect(fieldsOf(parse({ privacyContact: { name: "Pat", email: "   " } }))).toHaveProperty(["privacyContact.email"]);
    });

    it("wants text", () => {
      for (const value of [undefined, null, 5, {}, ["a@b.co"]]) expect(email(value), JSON.stringify(value)).toBeTypeOf("string");
    });
  });

  describe("website", () => {
    const website = (value: unknown) => {
      const r = parse({ website: value });
      return "fields" in r ? { error: r.fields.website } : { stored: r.settings.website };
    };

    it("accepts https and stores the normalised href", () => {
      expect(website("https://example.org")).toEqual({ stored: "https://example.org/" });
      expect(website("HTTPS://Example.ORG/Path?q=1#top")).toEqual({ stored: "https://example.org/Path?q=1#top" });
      expect(website("https://example.org:8443/a b".replace(" ", "%20"))).toEqual({ stored: "https://example.org:8443/a%20b" });
      expect(website("https://bücher.example/")).toEqual({ stored: "https://xn--bcher-kva.example/" });
    });

    it.each([
      ["javascript:alert(1)"], ["JavaScript:alert(1)"], ["  javascript:alert(1)//https://x.org"], ["data:text/html,<script>alert(1)</script>"],
      ["http://example.org"], ["ftp://example.org"], ["file:///etc/passwd"], ["//example.org"], ["example.org"], ["www.example.org"],
      ["https:example.org"], ["https:/example.org"], ["https:\\\\example.org"], ["https://"], ["https:///"], ["https://user@example.org"],
      ["https://user:pass@example.org"], ["https://:pass@example.org"], ["https://exa mple.org"], ["https://example.org/a b"],
      ["https://example.org/\u0000"], ["https://example.org/\nx"], ["https://example.org/ "], ["https://exa\tmple.org"],
      ["mailto:a@b.co"], ["blob:https://example.org/x"], ["vbscript:x"], ["https://[::1"], ["https://exa<mple.org"],
    ])("rejects %j", (value) => {
      expect(website(value), value).toHaveProperty("error");
    });

    it("says what is wanted", () => {
      expect(website("javascript:alert(1)")).toEqual({ error: "Enter a full web address starting with https://, like https://example.org." });
      expect(website("https://u:p@example.org")).toEqual({ error: "The website address can't contain a user name or password." });
    });

    it("allows 200 characters and rejects 201", () => {
      const url = (n: number) => `https://example.org/${"a".repeat(n - "https://example.org/".length)}`;
      expect(website(url(200))).toEqual({ stored: url(200) });
      expect(website(url(201))).toHaveProperty("error");
    });

    it("measures the stored href too, which can be longer than what was typed", () => {
      expect(website(`https://example.org/${"é".repeat(150)}`)).toHaveProperty("error");
    });
  });
});

describe("the text settings in D1", () => {
  it("start empty and survive a round trip, including non-ASCII", async () => {
    expect(await loadSettings(t.env.DB)).toEqual({ clubName: "", privacyContact: { name: "", email: "" }, website: "" });
    const settings = { clubName: "Café Dogs 🐕", privacyContact: { name: "Zoë", email: "zoe@example.org" }, website: "https://example.org/" };
    await saveSettings(t.env.DB, settings);
    expect(await loadSettings(t.env.DB)).toEqual(settings);
  });

  it("keeps a single row however often it is saved, and leaves the theme alone", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = '#112233', theme_accent = '#aabbcc'").run();
    await saveSettings(t.env.DB, { clubName: "One", privacyContact: { name: "", email: "" }, website: "" });
    await saveSettings(t.env.DB, { clubName: "Two", privacyContact: { name: "", email: "" }, website: "" });
    const rows = await t.env.DB.prepare("SELECT club_name, theme_primary, theme_accent FROM site_settings").all();
    expect(rows.results).toEqual([{ club_name: "Two", theme_primary: "#112233", theme_accent: "#aabbcc" }]);
    await t.env.DB.prepare("UPDATE site_settings SET theme_primary = NULL, theme_accent = NULL").run();
  });

  it("refreshes updated_at when saved", async () => {
    await t.env.DB.prepare("UPDATE site_settings SET updated_at = '2000-01-01T00:00:00Z'").run();
    await saveSettings(t.env.DB, ok);
    const row = await t.env.DB.prepare("SELECT updated_at FROM site_settings").first<{ updated_at: string }>();
    expect(row!.updated_at > "2020-01-01T00:00:00Z").toBe(true);
  });
});

describe("the logo in D1", () => {
  it("round-trips byte for byte, with every byte value including 0x00 and 0xFF", async () => {
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const data = Uint8Array.of(...allBytes, ...[...allBytes].reverse(), 0, 0, 255, 255, 0);
    await saveLogo(t.env.DB, data, { type: "image/png", width: 2, height: 3 });
    const loaded = await loadLogo(t.env.DB);
    expect(loaded!.data).toBeInstanceOf(Uint8Array);
    expect(loaded!.data.length).toBe(data.length);
    expect(Buffer.from(loaded!.data).equals(Buffer.from(data))).toBe(true);
    expect(loaded!.info).toMatchObject({ contentType: "image/png", width: 2, height: 3, bytes: data.length });
    const stored = await t.env.DB.prepare("SELECT typeof(bytes) AS t, length(bytes) AS n FROM site_logo").first();
    expect(stored).toEqual({ t: "blob", n: data.length });
  });

  it("round-trips a real-sized file", async () => {
    const data = Uint8Array.from({ length: 204_800 }, (_, i) => (i * 7 + (i >> 8)) & 255);
    await saveLogo(t.env.DB, data, { type: "image/webp", width: 512, height: 512 });
    const loaded = await loadLogo(t.env.DB);
    expect(Buffer.from(loaded!.data).equals(Buffer.from(data))).toBe(true);
  });

  it("stores the SHA-256 as lower-case hex, matching a reference digest", async () => {
    const data = makePng(3, 3);
    const info = await saveLogo(t.env.DB, data, { type: "image/png", width: 3, height: 3 });
    const { createHash } = await import("node:crypto");
    expect(info.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect((await loadLogoInfo(t.env.DB))!.sha256).toBe(info.sha256);
  });

  it("replaces in place and deletes, any number of times", async () => {
    expect(await loadLogo(t.env.DB)).toBeNull();
    expect(await loadLogoInfo(t.env.DB)).toBeNull();
    const first = await saveLogo(t.env.DB, makePng(4, 4), { type: "image/png", width: 4, height: 4 });
    const second = await saveLogo(t.env.DB, makePng(8, 6), { type: "image/png", width: 8, height: 6 });
    expect(second.sha256).not.toBe(first.sha256);
    expect((await t.env.DB.prepare("SELECT COUNT(*) AS n FROM site_logo").first<{ n: number }>())!.n).toBe(1);
    expect(await loadLogoInfo(t.env.DB)).toEqual(second);
    await deleteLogo(t.env.DB);
    await deleteLogo(t.env.DB); // nothing there: not an error
    expect(await loadLogo(t.env.DB)).toBeNull();
  });
});

describe("loadPublicSettings and loadAdminSettings", () => {
  it("public: nulls for everything unset", async () => {
    expect(await loadPublicSettings(t.env.DB)).toEqual({ clubName: null, website: null, privacyContact: null, logo: null });
  });

  it("public: the contact counts as set only with an email", async () => {
    await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "Pat", email: "" }, website: "" });
    expect((await loadPublicSettings(t.env.DB)).privacyContact).toBeNull();
    await saveSettings(t.env.DB, { clubName: "", privacyContact: { name: "", email: "a@b.co" }, website: "" });
    expect((await loadPublicSettings(t.env.DB)).privacyContact).toEqual({ name: "", email: "a@b.co" });
  });

  it("public: carries the logo url with a 16-character version, and admin carries the extras", async () => {
    await saveSettings(t.env.DB, ok);
    const info = await saveLogo(t.env.DB, makePng(10, 20), { type: "image/png", width: 10, height: 20 });
    const url = `/api/logo?v=${info.sha256.slice(0, 16)}`;
    expect(await loadPublicSettings(t.env.DB)).toEqual({ ...ok, logo: { url, width: 10, height: 20 } });
    expect(await loadAdminSettings(t.env.DB)).toEqual({
      ...ok, logo: { url, width: 10, height: 20, contentType: "image/png", bytes: makePng(10, 20).length },
    });
  });
});

describe("decodeBase64", () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  it("decodes standard padded base64", () => {
    for (const bytes of [[], [0], [0, 255], [0, 255, 128], [1, 2, 3, 4], [251, 255, 254]]) {
      expect(decodeBase64(b64(bytes)), JSON.stringify(bytes)).toEqual(Uint8Array.from(bytes));
    }
    expect(b64([251, 255, 254])).toContain("+");
    expect(b64([255, 255, 255])).toContain("/");
  });

  it.each([
    ["whitespace", "QUJD RA=="], ["a newline", "QUJD\nRA=="], ["a trailing newline", "QUJDRA==\n"], ["a leading space", " QUJD"],
    ["the URL-safe alphabet", "-_-_"], ["missing padding", "QUJDRA"], ["too much padding", "QUJDR==="], ["padding in the middle", "QQ==QUJD"],
    ["padding that isn't last", "QU=D"], ["a length of 1 mod 4", "QUJDR"], ["a non-base64 character", "QUJD$A=="], ["unicode", "QUJDé==="],
    ["a data: prefix", "data:image/png;base64,QUJD"], ["only padding", "===="],
  ])("rejects %s", (_name, text) => {
    expect(decodeBase64(text)).toBeNull();
  });

  it("derives the encoded cap from the byte cap", () => {
    expect(MAX_LOGO_BASE64).toBe(Buffer.from(new Uint8Array(204_800)).toString("base64").length);
  });
});
