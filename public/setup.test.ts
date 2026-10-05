// @vitest-environment happy-dom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trimAdminSecret as loginTrim } from "./admin/login.js";
import { init, trimAdminSecret } from "./setup.js";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const SECRET = "AwoRGB8mLTQ7QklQV15lbHN6gYiPlp2kq7K5wMfO1dw";

type Call = { url: string; init?: RequestInit };
type Clipboard = { writeText: (text: string) => Promise<void> };

/** Loads the real setup.html body, then starts the page with a scripted fetch. */
async function start(handler: (call: Call) => Response | Promise<Response> = () => reply(200, { secret: SECRET }), clipboard?: Clipboard) {
  const html = readFileSync("public/setup.html", "utf8");
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[\s\S]*?<\/script>/g, "");
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init });
  });
  init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigator: { clipboard } });
  return { calls };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const code = () => $("#code") as HTMLInputElement;
const button = () => $("#setup-form button") as HTMLButtonElement;
const error = () => $("#setup-error");
const saved = () => $("#saved") as HTMLInputElement;
const link = () => $("#sign-in") as HTMLAnchorElement;
const submit = async (value: string) => {
  code().value = value;
  $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(button().disabled).toBe(false)); // disabled synchronously, re-enabled when settled
};
const submitOk = async () => {
  code().value = "club-setup-phrase";
  $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
};

afterEach(() => { document.body.innerHTML = ""; localStorage.clear(); sessionStorage.clear(); });

describe("setup page markup", () => {
  const html = readFileSync("public/setup.html", "utf8");
  it("is British English, mobile-friendly, noindex, and has no inline script or style", () => {
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain('<script type="module" src="/setup.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style|style=|\son[a-z]+=/i);
    expect(html).not.toMatch(/action=/);
  });
  it("shares the theme, styles and icons of the other pages", () => {
    expect(html).toContain('<link rel="stylesheet" href="/style.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/api/theme.css" />');
    expect(html).toContain('href="/api/icon/32"');
  });
  it("has one code field with autocomplete off, its label, an alert region, a Continue button, and a hidden secret step", () => {
    expect(html.match(/<input/g)).toHaveLength(2); // the code, and the "I've saved it" checkbox
    expect(html).toMatch(/<input[^>]*id="code"[^>]*autocomplete="off"|<input[^>]*autocomplete="off"[^>]*id="code"/);
    expect(html).toContain('<label for="code">Setup code</label>');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*>Continue<\/button>/);
    expect(html).toContain("This is your admin secret. Save it in your password manager now: it is shown only this once");
    expect(html).toContain("If you run setup again before you first sign in, this secret is replaced");
    expect(html).toMatch(/id="secret-step"[^>]*\bhidden\b/);
    expect(html).not.toContain(SECRET);
  });
});

describe("setup page, step 1", () => {
  it("shows the form, with no secret anywhere yet, and makes no request on load", async () => {
    const { calls } = await start();
    expect(calls).toEqual([]);
    expect($("#setup-form").hidden).toBe(false);
    expect($("#secret-step").hidden).toBe(true);
    expect($("#secret").textContent).toBe("");
    expect(link().getAttribute("href")).toBeNull();
  });

  it("asks for a code when the field is empty or only whitespace, without a request", async () => {
    const { calls } = await start();
    await submit("  ​\t ");
    expect(error().textContent).toBe("Enter the setup code.");
    expect(calls).toEqual([]);
  });

  it("posts the trimmed code as same-origin, uncached JSON to /api/setup, and nowhere else", async () => {
    const { calls } = await start();
    await submitOk();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/setup");
    expect(calls[0].init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ code: "club-setup-phrase" });
  });

  it("sends the code trimmed", async () => {
    const { calls } = await start();
    code().value = "  club-setup-phrase​ ";
    $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ code: "club-setup-phrase" });
  });

  it("shows the server's message for a wrong code, clears the field, and lets the user try again", async () => {
    await start(() => reply(401, { error: { code: "invalid_setup_code", message: "That setup code isn't right." } }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("That setup code isn't right.");
    expect(code().value).toBe("");
    expect($("#secret-step").hidden).toBe(true);
    expect(button().disabled).toBe(false);
  });

  it("says how many minutes to wait when rate limited", async () => {
    await start(() => reply(429, { error: { code: "too_many_attempts", message: "Too many attempts. Try again later." } }, { "Retry-After": "600" }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again in 10 minutes.");
    await start(() => reply(429, {}, { "Retry-After": "61" }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again in 2 minutes.");
    await start(() => reply(429, {}, { "Retry-After": "30" }));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again in 1 minute.");
    await start(() => reply(429, {}));
    await submit("wrong-code-here");
    expect(error().textContent).toBe("Too many attempts. Try again later.");
  });

  it("explains a closed setup, shows the server's message for other refusals, and a generic one for a network failure", async () => {
    await start(() => reply(404, { error: { code: "not_found", message: "Not found." } }));
    await submit("club-setup-phrase");
    expect(error().textContent).toContain("Setup has already been completed");
    await start(() => reply(503, { error: { code: "setup_not_ready", message: "Setup isn't ready: set SETUP_CODE to a phrase of at least 12 characters." } }));
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Setup isn't ready: set SETUP_CODE to a phrase of at least 12 characters.");
    await start(() => { throw new TypeError("Failed to fetch"); });
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
    await start(() => new Response("<html>oops</html>", { status: 500 }));
    await submit("club-setup-phrase");
    expect(error().textContent).toBe("Something went wrong. Please try again.");
  });

  it("ignores a second submit while one is in flight", async () => {
    let release!: () => void;
    const { calls } = await start(() => new Promise<Response>((resolve) => { release = () => resolve(reply(200, { secret: SECRET })); }));
    code().value = "club-setup-phrase";
    $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    $("#setup-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls).toHaveLength(1);
    expect(button().disabled).toBe(true);
    release();
    await vi.waitFor(() => expect($("#secret-step").hidden).toBe(false));
  });
});

describe("setup page, step 2", () => {
  it("replaces the form with the secret from the response, in a block, and forgets the code", async () => {
    await start();
    await submitOk();
    expect($("#setup-form").hidden).toBe(true);
    expect($("#secret-step").hidden).toBe(false);
    expect($("#secret").textContent).toBe(SECRET);
    expect(code().value).toBe("");
    expect(document.body.textContent).toContain("This is your admin secret. Save it in your password manager now: it is shown only this once");
    expect(document.body.textContent).toContain("If you run setup again before you first sign in, this secret is replaced");
  });

  it("keeps the secret out of the URL, local and session storage, and cookies", async () => {
    await start();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await submitOk();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(globalThis.location.href).not.toContain(SECRET);
    expect(document.cookie).not.toContain(SECRET);
    setItem.mockRestore();
  });

  it("enables the sign-in link only while 'I've saved it' is ticked", async () => {
    await start();
    await submitOk();
    expect(saved().checked).toBe(false);
    expect(link().getAttribute("href")).toBeNull();
    expect(link().getAttribute("aria-disabled")).toBe("true");
    saved().checked = true;
    saved().dispatchEvent(new Event("change", { bubbles: true }));
    expect(link().getAttribute("href")).toBe("/admin/login");
    expect(link().getAttribute("aria-disabled")).toBeNull();
    expect(link().textContent).toBe("Go to sign in");
    saved().checked = false;
    saved().dispatchEvent(new Event("change", { bubbles: true }));
    expect(link().getAttribute("href")).toBeNull();
    expect(link().getAttribute("aria-disabled")).toBe("true");
  });

  it("copies the secret with the clipboard API and says so", async () => {
    const writeText = vi.fn(async () => {});
    await start(undefined, { writeText });
    await submitOk();
    ($("#copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toBe("Copied."));
    expect(writeText).toHaveBeenCalledWith(SECRET);
  });

  it("tells the user to copy it by hand when the clipboard is missing or refuses", async () => {
    await start(undefined, undefined);
    await submitOk();
    ($("#copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toContain("Select the secret above and copy it yourself"));
    await start(undefined, { writeText: async () => { throw new Error("denied"); } });
    await submitOk();
    ($("#copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($("#copy-status").textContent).toContain("Select the secret above and copy it yourself"));
  });
});

describe("trimming", () => {
  it("agrees with the admin sign-in page and the server (src/server/auth/crypto.ts)", () => {
    for (const input of ["", " ", "abc", "  abc  ", "​abc​", "­abc᠎", "a b", "﻿ abc\n\t", " ​ ", "a​b"]) {
      expect(trimAdminSecret(input), JSON.stringify(input)).toBe(loginTrim(input));
    }
  });
});
