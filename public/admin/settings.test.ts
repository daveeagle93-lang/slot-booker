// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME, PAGE_COLOURS, themeTokens } from "../theme.js";
import { MAX_INPUT_BYTES } from "./logo-image.js";
import { init } from "./settings.js";

const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
const LOGO = { url: "/api/logo?v=0123456789abcdef", width: 300, height: 150, contentType: "image/webp", bytes: 20480 };
const SETTINGS = {
  clubName: "Wag Club",
  privacyContact: { name: "Ann Lee", email: "ann@example.com" },
  website: "https://wag.example",
  theme: { primary: "#0b5cad", accent: "#0b5cad", isDefault: true },
  logo: LOGO,
};

type Call = { method: string; url: string; headers?: Record<string, string>; body?: any };
type Handler = (call: Call) => Response | Promise<Response>;

/** The fake browser pieces: every picture "decodes" to 1000 x 500 and exports as 4 KiB of WebP. */
function fakeImage() {
  return {
    createImageBitmap: vi.fn(async () => ({ width: 1000, height: 500, close: () => {} })),
    loadImage: vi.fn(),
    createCanvas: (width: number, height: number) => ({
      width,
      height,
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (cb: (b: Blob) => void, type: string) => cb(new Blob([new Uint8Array(4096).fill(7)], { type })),
    }),
  };
}

async function start(handlers: Record<string, Handler> = {}, { settings = SETTINGS as unknown, session = true } = {}) {
  // The test only reads the link's href; stop happy-dom trying to download it.
  (window as any).happyDOM.settings.disableCSSFileLoading = true;
  (window as any).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
  document.head.innerHTML = '<link rel="stylesheet" href="/api/theme.css" />';
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const image = fakeImage();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET", url, headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (url === "/api/admin/session") return session ? reply(200, SESSION) : reply(401);
    const handler = handlers[`${call.method} ${url}`];
    if (handler) return handler(call);
    if (call.method === "GET" && url === "/api/admin/settings") return reply(200, settings);
    throw new Error(`unexpected ${call.method} ${url}`);
  });
  await init({ document, fetch: fetch as never, navigate, image: image as never, now: () => 12345 });
  return { calls, navigate, image, writes: () => calls.filter((c) => c.method !== "GET" && c.url !== "/api/admin/session") };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (name: string) => $$("button").find((b) => b.textContent === name) as HTMLButtonElement;
const text = () => document.body.textContent ?? "";
const type = (id: string, value: string) => {
  const el = input(id);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = (id: string) => $(`#${id}`).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));
const choose = async (file: File) => {
  const el = input("logo-file");
  Object.defineProperty(el, "files", { value: [file], configurable: true });
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
};
const picture = (type = "image/png", size = 2000) => new File([new Uint8Array(size)], "logo", { type });
const panel = (mode: string) => $(`.pv-${mode}`);
const prop = (mode: string, name: string) => panel(mode).style.getPropertyValue(name);

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("page", () => {
  it("sends the browser to login without a session", async () => {
    const { navigate } = await start({}, { session: false });
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect(document.querySelector("form")).toBeNull();
  });

  it("has a Back to events link, a heading and three forms with their own Save button", async () => {
    await start();
    expect($("a.back").getAttribute("href")).toBe("/admin/");
    expect($("a.back").textContent).toBe("Back to events");
    expect($("h1").textContent).toBe("Settings");
    expect($$("form").map((f) => f.querySelector("h2")!.textContent)).toEqual(["Club details", "Logo", "Colours"]);
    for (const f of $$("form")) {
      expect(f.getAttribute("aria-labelledby")).toBe(f.querySelector("h2")!.id);
      expect(f.querySelector("[role=status]")).not.toBeNull();
      expect(f.querySelector("[role=alert]")).not.toBeNull();
    }
    expect(button("Save details").type).toBe("submit");
    expect(button("Save colours").type).toBe("submit");
  });

  it("shows the server's message with a Retry when the settings can't be loaded", async () => {
    const { calls } = await start({}, { settings: null });
    expect(calls.at(-1)!.url).toBe("/api/admin/settings");
    expect($("[role=alert]").textContent).toContain("couldn't load the settings");
    expect(button("Retry")).toBeDefined();
  });

  it("builds everything from text and attributes only", () => {
    for (const file of ["settings.js", "logo-image.js"]) {
      const source = readFileSync(`public/admin/${file}`, "utf8");
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.cssText|setAttribute\(["']style/);
    }
    const html = readFileSync("public/admin/settings.html", "utf8");
    expect(html).toContain('<link rel="stylesheet" href="/api/theme.css" />');
    expect(html).toContain('<link rel="icon" href="/api/logo" />');
    expect(html).toContain("data-autostart");
    expect(html).not.toMatch(/\sstyle=|<style|<script(?![^>]*\bsrc=)|\son\w+=/);
  });
});

describe("club details", () => {
  it("fills the fields, with sensible input attributes and a reason for each", async () => {
    await start();
    expect(input("club-name").value).toBe("Wag Club");
    expect(input("contact-name").value).toBe("Ann Lee");
    expect(input("contact-email").value).toBe("ann@example.com");
    expect(input("website").value).toBe("https://wag.example");
    expect(input("contact-email").type).toBe("email");
    expect(input("contact-email").getAttribute("autocomplete")).toBe("off");
    expect(input("contact-email").getAttribute("autocapitalize")).toBe("off");
    expect(input("website").type).toBe("url");
    expect(input("website").getAttribute("autocapitalize")).toBe("off");
    expect($("#club-name-hint").textContent).toBe("Shown in the page header, the browser tab, calendar entries and the lineup.");
    expect($("#contact-name-hint").textContent).toContain("who to contact about their details");
    expect($("#contact-email-hint").textContent).toContain("counts as set once it has an email");
    for (const id of ["club-name", "contact-name", "contact-email", "website"]) {
      expect(document.querySelector(`label[for=${id}]`)).not.toBeNull();
      expect(input(id).getAttribute("aria-describedby")).toBe(`${id}-hint ${id}-error`);
    }
  });

  it("copes with no contact at all", async () => {
    await start({}, { settings: { ...SETTINGS, privacyContact: undefined, website: "", clubName: "" } });
    expect(input("contact-email").value).toBe("");
    expect(input("website").value).toBe("");
  });

  it("saves with PUT, the CSRF token and a trimmed JSON body, then says so", async () => {
    const saved = { ...SETTINGS, clubName: "New Name", privacyContact: { name: "Bo", email: "bo@example.com" }, website: "" };
    const { writes } = await start({ "PUT /api/admin/settings": () => reply(200, saved) });
    type("club-name", "  New Name ");
    type("contact-name", "Bo");
    type("contact-email", "bo@example.com");
    type("website", "");
    button("Save details").click();
    submit("details");
    await flush();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "PUT", url: "/api/admin/settings",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "tok" },
      body: { clubName: "New Name", privacyContact: { name: "Bo", email: "bo@example.com" }, website: "" },
    });
    expect($("#details [role=status]").textContent).toBe("Club details saved.");
    expect(input("club-name").value).toBe("New Name");
    expect($("#details [role=alert]").textContent).toBe("");
  });

  it("shows field errors beside the fields and moves focus to the summary", async () => {
    await start({
      "PUT /api/admin/settings": () => reply(400, {
        error: { code: "invalid_input", message: "Check the highlighted fields." },
        fields: { "privacyContact.email": "Enter a valid email address.", website: "The website must start with https://." },
      }),
    });
    submit("details");
    await flush();
    expect($("#contact-email-error").textContent).toBe("Enter a valid email address.");
    expect($("#website-error").textContent).toBe("The website must start with https://.");
    expect(input("contact-email").getAttribute("aria-invalid")).toBe("true");
    expect(input("website").getAttribute("aria-invalid")).toBe("true");
    expect(input("club-name").hasAttribute("aria-invalid")).toBe(false);
    expect(input("contact-email").getAttribute("aria-describedby")).toContain("contact-email-error");
    expect(document.activeElement).toBe($("#details [role=alert]"));
    expect($("#details [role=alert]").textContent).toContain("Not saved");
    expect($("#details [role=status]").textContent).toBe("");
  });

  it("clears the old field errors on the next try", async () => {
    let first = true;
    await start({
      "PUT /api/admin/settings": () => {
        if (first) { first = false; return reply(400, { error: { code: "invalid_input", message: "x" }, fields: { clubName: "Required." } }); }
        return reply(200, SETTINGS);
      },
    });
    submit("details");
    await flush();
    expect(input("club-name").getAttribute("aria-invalid")).toBe("true");
    submit("details");
    await flush();
    expect(input("club-name").hasAttribute("aria-invalid")).toBe(false);
    expect($("#club-name-error").textContent).toBe("");
  });

  it("is busy while saving, so a second submit sends nothing", async () => {
    let release!: (r: Response) => void;
    const { writes } = await start({ "PUT /api/admin/settings": () => new Promise<Response>((r) => { release = r; }) });
    submit("details");
    await flush();
    expect(button("Save details").disabled).toBe(true);
    expect($("#details").getAttribute("aria-busy")).toBe("true");
    submit("details");
    submit("details");
    await flush();
    expect(writes()).toHaveLength(1);
    release(reply(200, SETTINGS));
    await flush();
    expect(button("Save details").disabled).toBe(false);
    expect($("#details").hasAttribute("aria-busy")).toBe(false);
  });

  it("reports a network failure and lets the admin try again", async () => {
    await start({ "PUT /api/admin/settings": () => { throw new Error("offline"); } });
    submit("details");
    await flush();
    expect($("#details [role=alert]").textContent).toContain("couldn't reach the server");
    expect(button("Save details").disabled).toBe(false);
  });

  it("sends the browser to login on 401 without an error message, and shows the server's words on 403", async () => {
    const unauthorised = await start({ "PUT /api/admin/settings": () => reply(401, { error: { code: "unauthorised" } }) });
    submit("details");
    await flush();
    expect(unauthorised.navigate).toHaveBeenCalledWith("/admin/login");
    expect($("#details [role=alert]").textContent).toBe("");

    await start({ "PUT /api/admin/settings": () => reply(403, { error: { code: "forbidden", message: "Admins only." } }) });
    submit("details");
    await flush();
    expect($("#details [role=alert]").textContent).toContain("Admins only.");
  });

  it("keeps focus on the Save button after a successful save", async () => {
    await start({ "PUT /api/admin/settings": () => reply(200, SETTINGS) });
    button("Save details").focus();
    submit("details");
    await flush();
    expect(document.activeElement).toBe(button("Save details"));
  });
});

describe("logo", () => {
  it("shows the current logo from the settings url with its size", async () => {
    await start();
    const img = $("#logo .logo-current img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/logo?v=0123456789abcdef");
    expect(img.getAttribute("alt")).toBe("Current logo");
    expect($("#logo .logo-current").textContent).toBe("Current logo: 300 × 150 px, 20.0 KB");
    expect(button("Remove logo").hidden).toBe(false);
  });

  it("says No logo, and offers no removal, when there isn't one", async () => {
    await start({}, { settings: { ...SETTINGS, logo: null } });
    expect($("#logo .logo-current").textContent).toBe("No logo");
    expect($("#logo .logo-current img")).toBeNull();
    expect(button("Remove logo").hidden).toBe(true);
  });

  it("won't show a logo url that leaves the site", async () => {
    for (const url of ["//evil.example/x.png", "/\t/evil.example/x.png", "/\n/evil.example", "/\\evil", "https://evil/x", "/api/logo?v=abc"]) {
      await start({}, { settings: { ...SETTINGS, logo: { ...LOGO, url } } });
      expect($("#logo .logo-current img"), JSON.stringify(url)).toBeNull();
    }
  });

  it("has a labelled file input that accepts only PNG, JPEG and WebP", async () => {
    await start();
    expect(document.querySelector("label[for=logo-file]")!.textContent).toBe("Choose a logo");
    expect(input("logo-file").type).toBe("file");
    expect(input("logo-file").getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
  });

  it("processes a chosen picture and previews it as a data: URL, uploading nothing yet", async () => {
    const { writes, image } = await start();
    await choose(picture());
    expect(image.createImageBitmap).toHaveBeenCalledTimes(1);
    const img = $("#logo .logo-preview img") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^data:image\/webp;base64,/);
    expect(img.getAttribute("src")).not.toMatch(/^blob:/);
    expect($("#logo .logo-preview").textContent).toContain("Preview: 512 × 256 px, 4.0 KB");
    expect($("#logo .logo-preview").hidden).toBe(false);
    expect(button("Use this logo").hidden).toBe(false);
    expect($("#logo [role=status]").textContent).toContain("ready");
    expect(writes()).toHaveLength(0);
  });

  it("uploads the processed picture as base64 JSON only when Use this logo is chosen", async () => {
    const newLogo = { ...LOGO, url: "/api/logo?v=fedcba9876543210", width: 512, height: 256, bytes: 4096 };
    const { writes } = await start({ "PUT /api/admin/settings/logo": () => reply(200, { logo: newLogo }) });
    await choose(picture());
    expect(writes()).toHaveLength(0);
    submit("logo");
    await flush();
    expect(writes()).toHaveLength(1);
    const [put] = writes();
    expect(put).toMatchObject({ method: "PUT", url: "/api/admin/settings/logo", headers: { "X-CSRF-Token": "tok" } });
    expect(Object.keys(put.body)).toEqual(["data"]);
    expect(put.body.data).toBe(btoa(String.fromCharCode(...new Uint8Array(4096).fill(7))));
    expect($("#logo [role=status]").textContent).toBe("Logo saved.");
    expect(($("#logo .logo-current img") as HTMLImageElement).getAttribute("src")).toBe("/api/logo?v=fedcba9876543210");
    expect($("#logo .logo-preview").hidden).toBe(true);
    expect(button("Use this logo").hidden).toBe(true);
    expect(document.activeElement).toBe(input("logo-file"));
  });

  it("blocks a double submit of Use this logo", async () => {
    let release!: (r: Response) => void;
    const { writes } = await start({ "PUT /api/admin/settings/logo": () => new Promise<Response>((r) => { release = r; }) });
    await choose(picture());
    submit("logo");
    submit("logo");
    await flush();
    expect(writes()).toHaveLength(1);
    expect(button("Use this logo").disabled).toBe(true);
    expect(input("logo-file").disabled).toBe(true);
    release(reply(200, { logo: LOGO }));
    await flush();
    expect(input("logo-file").disabled).toBe(false);
  });

  it("refuses SVG, and other types, with a message and no decoding", async () => {
    const { image, writes } = await start();
    for (const t of ["image/svg+xml", "image/gif", ""]) {
      await choose(picture(t));
      expect($("#logo [role=alert]").textContent).toContain("PNG, JPEG or WebP");
      expect(document.activeElement).toBe($("#logo [role=alert]"));
      expect($("#logo .logo-preview").hidden).toBe(true);
    }
    expect(image.createImageBitmap).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("refuses an oversized file without trying to decode it", async () => {
    const { image } = await start();
    const huge = picture();
    Object.defineProperty(huge, "size", { value: MAX_INPUT_BYTES + 1 });
    await choose(huge);
    expect($("#logo [role=alert]").textContent).toContain("too big");
    expect(image.createImageBitmap).not.toHaveBeenCalled();
  });

  it("drops an earlier preview when a later choice is refused", async () => {
    await start();
    await choose(picture());
    expect(button("Use this logo").hidden).toBe(false);
    await choose(picture("image/svg+xml"));
    expect(button("Use this logo").hidden).toBe(true);
    expect($("#logo .logo-preview").hidden).toBe(true);
  });

  it("shows the server's plain-English reason when it rejects the picture", async () => {
    await start({ "PUT /api/admin/settings/logo": () => reply(422, { error: { code: "invalid_image", message: "That picture is damaged." }, reason: "corrupt" }) });
    await choose(picture());
    submit("logo");
    await flush();
    expect($("#logo [role=alert]").textContent).toBe("Not saved. That picture is damaged.");
    expect(document.activeElement).toBe($("#logo [role=alert]"));
    expect(button("Use this logo").disabled).toBe(false);
  });

  it("explains a 413", async () => {
    await start({ "PUT /api/admin/settings/logo": () => reply(413, { error: { code: "too_large", message: "Too big." } }) });
    await choose(picture());
    submit("logo");
    await flush();
    expect($("#logo [role=alert]").textContent).toContain("too large");
  });

  it("asks before removing, and only removes on the second step", async () => {
    const { writes } = await start({ "DELETE /api/admin/settings/logo": () => reply(200, { logo: null }) });
    button("Remove logo").click();
    expect($("#logo .confirm").textContent).toContain("Remove the logo?");
    expect(button("Remove logo").disabled).toBe(true);
    expect(document.activeElement).toBe(button("Cancel"));
    expect(writes()).toHaveLength(0);

    button("Cancel").click();
    expect($("#logo .confirm")).toBeNull();
    expect(document.activeElement).toBe(button("Remove logo"));
    expect(writes()).toHaveLength(0);

    button("Remove logo").click();
    button("Yes, remove logo").click();
    button("Yes, remove logo").click();
    await flush();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "DELETE", url: "/api/admin/settings/logo", headers: { "X-CSRF-Token": "tok" } });
    expect($("#logo .logo-current").textContent).toBe("No logo");
    expect($("#logo [role=status]").textContent).toBe("Logo removed.");
    expect($("#logo .confirm")).toBeNull();
    expect(button("Remove logo").hidden).toBe(true);
    expect(document.activeElement).toBe(input("logo-file"));
  });

  it("keeps the logo and says so when removal fails", async () => {
    await start({ "DELETE /api/admin/settings/logo": () => reply(500, { error: { code: "internal_error", message: "Try later." } }) });
    button("Remove logo").click();
    button("Yes, remove logo").click();
    await flush();
    expect($("#logo [role=alert]").textContent).toBe("Not removed. Try later.");
    expect($("#logo .logo-current img")).not.toBeNull();
  });
});

describe("colours", () => {
  const swatchOf = (name: string) => button(name);
  const pressed = () => $$(".preset").filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

  it("offers the six presets, with the one matching the saved colours pressed", async () => {
    await start();
    expect($$(".preset").map((b) => b.textContent)).toEqual(["Ocean", "Forest", "Berry", "Ember", "Teal", "Slate"]);
    expect(pressed()).toEqual(["Ocean"]);
    const swatch = $(".preset .swatch");
    expect(swatch.style.getPropertyValue("--sw-primary")).toBe("#0b5cad");
    expect(swatch.hasAttribute("style")).toBe(true); // set through the CSSOM, never written as HTML
  });

  it("has two colour pickers showing their hex as text", async () => {
    await start({}, { settings: { ...SETTINGS, theme: { primary: "#1b6b3a", accent: "#a1235f", isDefault: false } } });
    expect(document.querySelector("label[for=primary-colour]")!.textContent).toBe("Main colour");
    expect(document.querySelector("label[for=accent-colour]")!.textContent).toBe("Accent colour");
    expect(input("primary-colour").type).toBe("color");
    expect(input("primary-colour").value).toBe("#1b6b3a");
    expect($("#primary-colour-hex").textContent).toBe("#1b6b3a");
    expect($("#accent-colour-hex").textContent).toBe("#a1235f");
    expect(pressed()).toEqual([]);
  });

  it("sets both pickers when a preset is chosen", async () => {
    await start();
    swatchOf("Berry").click();
    expect(input("primary-colour").value).toBe("#a1235f");
    expect(input("accent-colour").value).toBe("#a1235f");
    expect($("#primary-colour-hex").textContent).toBe("#a1235f");
    expect(pressed()).toEqual(["Berry"]);
    expect(prop("light", "--primary")).toBe("#a1235f");
  });

  it("shows Light and Dark samples that follow the pickers, with their own variables", async () => {
    await start();
    expect($$(".pv-wrap figcaption").map((c) => c.textContent)).toEqual(["Light", "Dark"]);
    type("primary-colour", "#1b6b3a");
    type("accent-colour", "#a1235f");
    const tokens = themeTokens({ primary: "#1b6b3a", accent: "#a1235f" });
    for (const mode of ["light", "dark"] as const) {
      expect(prop(mode, "--primary")).toBe(tokens[mode]["--primary"]);
      expect(prop(mode, "--on-primary")).toBe(tokens[mode]["--on-primary"]);
      expect(prop(mode, "--accent")).toBe(tokens[mode]["--accent"]);
      expect(prop(mode, "--bg")).toBe(PAGE_COLOURS[mode].bg);
      expect(prop(mode, "--surface")).toBe(PAGE_COLOURS[mode].surface);
      expect(prop(mode, "--text")).toBe(PAGE_COLOURS[mode].text);
      expect(prop(mode, "--muted")).toBe(PAGE_COLOURS[mode].muted);
    }
    expect(prop("light", "--accent")).toBe("#a1235f");
    expect(prop("dark", "--accent")).not.toBe("#a1235f"); // lightened for the dark page
    // The sample parts a visitor would see.
    const texts = $$(".pv-light .pv-card span").map((s) => s.textContent);
    expect(texts).toContain("Book a slot");
    expect($$(".pv-light .pv-tile.selected")).toHaveLength(1);
    expect($$(".pv").every((p) => p.getAttribute("aria-hidden") === "true")).toBe(true);
    expect($$(".pv a, .pv button, .pv input")).toHaveLength(0);
  });

  it("shows the club name from the form in the sample header, or the default", async () => {
    await start();
    expect($(".pv-light .pv-header").textContent).toBe("Wag Club");
    type("club-name", "Paws & Co");
    expect($(".pv-light .pv-header").textContent).toBe("Paws & Co");
    expect($(".pv-dark .pv-header").textContent).toBe("Paws & Co");
    type("club-name", "   ");
    expect($(".pv-dark .pv-header").textContent).toBe("Slot booker");
  });

  it("keeps the detailed contrast block out of the live region and announces through one separate element", async () => {
    await start();
    const detail = $(".contrast");
    expect(detail.hasAttribute("role")).toBe(false);
    expect(detail.hasAttribute("aria-live")).toBe(false);
    expect(detail.textContent).toContain("All contrast checks pass.");
    expect(button("Save colours").disabled).toBe(false);
    expect($("#theme-blocked").hidden).toBe(true);
    const live = $$("#theme [role=status]").filter((n) => n.classList.contains("visually-hidden"));
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe("All contrast checks pass.");
  });

  it("announces only when the overall result changes, not on every colour dragged through", async () => {
    await start();
    const live = $("#theme .visually-hidden[role=status]");
    const observer = new MutationObserver(() => {});
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    // Setting textContent replaces the text node: one record that adds a node per announcement.
    const announcements = () => observer.takeRecords().filter((r) => r.addedNodes.length > 0).length;
    let updates = 0;
    // Many different colours, all passing with the same result.
    for (const c of ["#0b5cad", "#1b6b3a", "#a1235f", "#b4400f", "#0f6b6e", "#3d4a5c", "#0a5cad", "#0a5bad", "#0a5aad"]) type("primary-colour", c);
    updates += announcements();
    expect(updates).toBe(0);
    expect($(".contrast").textContent).toContain("All contrast checks pass."); // the detail still follows the pickers

    // A different failing set, then the same set again with different colours: one announcement for each change.
    type("accent-colour", "#ffd400");
    type("accent-colour", "#ffe000");
    type("accent-colour", "#fff000");
    updates += announcements();
    expect(updates).toBe(1);
    expect(live.textContent).toContain("can't be saved yet");
    type("accent-colour", "#0b5cad");
    updates += announcements();
    expect(updates).toBe(2);
    expect(live.textContent).toBe("All contrast checks pass.");
  });

  it("disables Save with a written explanation when contrast fails, and re-enables it when fixed", async () => {
    await start();
    type("accent-colour", "#ffd400");
    const save = button("Save colours");
    expect(save.disabled).toBe(true);
    expect($(".contrast").textContent).toContain("can't be saved yet");
    expect($(".contrast").textContent).toMatch(/Links and outlined buttons on cards \(light mode\) has a contrast of \d\.\d\d:1; it needs at least 4\.5:1\./);
    expect($("#theme-blocked").hidden).toBe(false);
    expect($("#theme-blocked").textContent).toContain("Save is unavailable");
    expect(save.getAttribute("aria-describedby")).toBe("theme-blocked");

    submit("theme"); // even a forced submit sends nothing
    await flush();

    type("accent-colour", "#0b5cad");
    expect(save.disabled).toBe(false);
    expect($("#theme-blocked").hidden).toBe(true);
    expect($(".contrast").textContent).toContain("All contrast checks pass.");
  });

  it("shows non-blocking warnings as advice and still allows saving", async () => {
    await start();
    type("primary-colour", "#dddddd");
    expect(button("Save colours").disabled).toBe(false);
    expect($(".contrast").textContent).toContain("All contrast checks pass.");
    expect($(".contrast").textContent).toContain("Advice");
    expect($(".contrast").textContent).toMatch(/Main colour buttons against the page background \(light mode\) has a contrast of \d\.\d\d:1; 3:1 is recommended/);
  });

  it("clears a stale Colours saved line when the colours change or stop passing", async () => {
    await start({ "PUT /api/admin/settings/theme": () => reply(200, { theme: { primary: "#1b6b3a", accent: "#1b6b3a", isDefault: false } }) });
    const status = () => $("#theme .form-status").textContent;
    const save = async () => { submit("theme"); await flush(); };

    swatchOf("Forest").click();
    await save();
    expect(status()).toBe("Colours saved.");
    swatchOf("Berry").click();
    expect(status()).toBe("");

    await save();
    expect(status()).toBe("Colours saved.");
    type("primary-colour", "#123456");
    expect(status()).toBe("");

    await save();
    expect(status()).toBe("Colours saved.");
    type("accent-colour", "#ffd400"); // fails the check
    expect(status()).toBe("");
  });

  it("saves with PUT, restyles the page's stylesheet and announces it", async () => {
    const { writes } = await start({ "PUT /api/admin/settings/theme": () => reply(200, { theme: { primary: "#1b6b3a", accent: "#1b6b3a", isDefault: false } }) });
    swatchOf("Forest").click();
    button("Save colours").focus();
    submit("theme");
    await flush();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({
      method: "PUT", url: "/api/admin/settings/theme",
      headers: { "X-CSRF-Token": "tok" }, body: { primary: "#1b6b3a", accent: "#1b6b3a" },
    });
    expect($("#theme .form-status").textContent).toBe("Colours saved.");
    expect(document.querySelector('link[rel=stylesheet]')!.getAttribute("href")).toBe("/api/theme.css?v=12345");
    expect(document.activeElement).toBe(button("Save colours"));
  });

  it("blocks a double submit while saving", async () => {
    let release!: (r: Response) => void;
    const { writes } = await start({ "PUT /api/admin/settings/theme": () => new Promise<Response>((r) => { release = r; }) });
    submit("theme");
    submit("theme");
    await flush();
    expect(writes()).toHaveLength(1);
    expect(button("Save colours").disabled).toBe(true);
    expect(button("Reset to default colours").disabled).toBe(true);
    release(reply(200, { theme: SETTINGS.theme }));
    await flush();
    expect(button("Save colours").disabled).toBe(false);
  });

  it("shows the server's contrast message and moves focus to it", async () => {
    await start({
      "PUT /api/admin/settings/theme": () => reply(422, {
        error: { code: "theme_contrast", message: "Those colours are too pale to read." },
        failures: [{ id: "x", label: "x", mode: "light", ratio: 2, min: 4.5 }],
      }),
    });
    submit("theme");
    await flush();
    expect($("#theme [role=alert]").textContent).toBe("Not saved. Those colours are too pale to read.");
    expect(document.activeElement).toBe($("#theme [role=alert]"));
    expect(document.querySelector('link[rel=stylesheet]')!.getAttribute("href")).toBe("/api/theme.css");
  });

  it("shows server field errors against the pickers", async () => {
    await start({ "PUT /api/admin/settings/theme": () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { accent: "Not a colour." } }) });
    submit("theme");
    await flush();
    expect($("#accent-colour-error").textContent).toBe("Not a colour.");
    expect(input("accent-colour").getAttribute("aria-invalid")).toBe("true");
    expect(input("primary-colour").hasAttribute("aria-invalid")).toBe(false);
  });

  it("resets to the default colours with DELETE", async () => {
    const { writes } = await start(
      { "DELETE /api/admin/settings/theme": () => reply(200, { theme: { default: DEFAULT_THEME, isDefault: true } }) },
      { settings: { ...SETTINGS, theme: { primary: "#1b6b3a", accent: "#a1235f", isDefault: false } } },
    );
    button("Reset to default colours").click();
    await flush();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "DELETE", url: "/api/admin/settings/theme", headers: { "X-CSRF-Token": "tok" } });
    expect(input("primary-colour").value).toBe(DEFAULT_THEME.primary);
    expect(input("accent-colour").value).toBe(DEFAULT_THEME.accent);
    expect(pressed()).toEqual(["Ocean"]);
    expect($("#theme .form-status").textContent).toBe("Colours reset to the default.");
    expect(document.querySelector('link[rel=stylesheet]')!.getAttribute("href")).toBe("/api/theme.css?v=12345");
  });

  it("lets the admin reset even when the chosen colours fail the check", async () => {
    await start({ "DELETE /api/admin/settings/theme": () => reply(200, { theme: { default: DEFAULT_THEME, isDefault: true } }) });
    type("accent-colour", "#ffd400");
    expect(button("Save colours").disabled).toBe(true);
    expect(button("Reset to default colours").disabled).toBe(false);
    button("Reset to default colours").click();
    await flush();
    expect(button("Save colours").disabled).toBe(false);
  });
});
