// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { init } from "./list.js";

const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
const EVENT = {
  slug: "abc123", name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z", costPence: 1500,
  venuePostcode: "SW1A 1AA", slotCount: 12, bookedCount: 3, bookings: { open: true, closesAt: "2026-06-13T08:00:00Z" },
  path: "/e/abc123",
};
const ORIGIN = "https://club.example";

type Call = { url: string; init?: RequestInit };

async function start(events: unknown, { clipboard = { writeText: vi.fn(async () => {}) }, status = 200 } = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/admin/session") return reply(200, SESSION);
    if (url === "/api/admin/events") return reply(status, status === 200 ? { events } : { error: { code: "internal_error" } });
    if (url === "/api/admin/logout") return reply(200, { ok: true });
    throw new Error(`unexpected ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate, clipboard, location: { origin: ORIGIN },
  });
  return { calls, navigate, clipboard };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const text = () => document.body.textContent ?? "";
const buttonNamed = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("list page", () => {
  it("renders a card per event", async () => {
    const { calls } = await start([EVENT, { ...EVENT, slug: "def", path: "/e/def", name: "Second", bookings: { open: false, closesAt: "x" } }]);
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/session", "/api/admin/events"]);
    expect(text()).toContain("Signed in as ann@example.com");
    const cards = document.querySelectorAll(".event-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector("h2")!.textContent).toBe("Trial Day");
    expect(cards[0].textContent).toContain("Saturday 13 June 2026, 09:00–16:00");
    expect(cards[0].textContent).toContain("3 of 12 slots booked");
    expect(cards[0].querySelector(".badge")!.textContent).toBe("Bookings open");
    expect(cards[1].querySelector(".badge")!.textContent).toBe("Bookings closed");
    const create = document.querySelector<HTMLAnchorElement>("a[href='/admin/new']")!;
    expect(create.textContent).toBe("Create event");
    const open = cards[0].querySelector<HTMLAnchorElement>("a")!;
    expect(open.textContent).toBe("Open");
    expect(open.getAttribute("href")).toBe("/e/abc123");
  });

  it("gives each card an Edit link to the edit page, after Copy and Open", async () => {
    await start([EVENT, { ...EVENT, slug: "def456", path: "/e/def456", name: "Second" }]);
    const edits = [...document.querySelectorAll<HTMLAnchorElement>(".event-card a")].filter((a) => a.textContent === "Edit");
    expect(edits.map((a) => a.getAttribute("href"))).toEqual(["/admin/edit?slug=abc123", "/admin/edit?slug=def456"]);
    expect([...document.querySelectorAll(".event-card")[0].querySelectorAll(".actions > *")].map((n) => n.textContent)).toEqual(["Copy booking link", "Open", "Edit"]);
  });

  it("escapes the slug in the Edit link", async () => {
    await start([{ ...EVENT, slug: "a b&c" }]);
    const edit = [...document.querySelectorAll<HTMLAnchorElement>(".event-card a")].find((a) => a.textContent === "Edit")!;
    expect(edit.getAttribute("href")).toBe("/admin/edit?slug=a%20b%26c");
  });

  it("shows the empty state", async () => {
    await start([]);
    expect(text()).toContain("No upcoming events yet.");
    expect(document.querySelector(".event-card")).toBeNull();
    expect(document.querySelector("a[href='/admin/new']")).not.toBeNull();
  });

  it("shows a retryable error when loading fails", async () => {
    await start(null, { status: 500 });
    const alert = $("[role=alert]");
    expect(alert.textContent).toContain("We couldn't load your events.");
    expect(buttonNamed("Retry")).toBeDefined();
    expect(document.querySelector(".event-card")).toBeNull();
  });

  it("shows an error when the network fails", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async () => { throw new TypeError("offline"); });
    await init({
      document, fetch: fetch as unknown as typeof globalThis.fetch, navigate: vi.fn(), clipboard: undefined,
      location: { origin: ORIGIN },
    });
    expect($("[role=alert]").textContent).toContain("Check your connection");
  });

  it("only links valid booking paths", async () => {
    const hostile = ["javascript:alert(1)", "//evil.example/e/x", "/e/a/b", "/admin", "https://evil.example/e/abc", "/e/"];
    await start(hostile.map((path, i) => ({ ...EVENT, slug: `s${i}`, path })));
    expect(document.querySelectorAll(".event-card")).toHaveLength(hostile.length);
    expect(document.querySelectorAll(".event-card a")).toHaveLength(0);
    expect(document.querySelectorAll(".event-card button")).toHaveLength(0);
    expect(document.querySelectorAll("[href^='javascript'], [href*='evil']")).toHaveLength(0);
  });

  it("keeps hostile names inert", async () => {
    await start([{ ...EVENT, name: "<img src=x onerror=alert(1)>" }]);
    expect(document.querySelector(".event-card img")).toBeNull();
    expect($(".event-card h2").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("keeps a hostile identity inert", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async (url: string) =>
      url === "/api/admin/session" ? reply(200, { ...SESSION, identity: "<img src=x onerror=alert(1)>" }) : reply(200, { events: [] }));
    await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, navigate: vi.fn(), clipboard: undefined, location: { origin: ORIGIN } });
    expect(document.querySelector("img")).toBeNull();
    expect(text()).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("copy booking link", () => {
  it("copies the absolute URL and shows Copied briefly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clipboard } = await start([EVENT]);
    buttonNamed("Copy booking link").click();
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith("https://club.example/e/abc123");
    expect($(".copy-status").textContent).toBe("Copied");
    expect($(".copy-status").getAttribute("aria-live")).toBe("polite");
    vi.advanceTimersByTime(2100);
    expect($(".copy-status").textContent).toBe("");
  });

  it("falls back to a selected readonly field when the clipboard rejects", async () => {
    const clipboard = { writeText: vi.fn(async () => { throw new Error("denied"); }) };
    await start([EVENT], { clipboard });
    buttonNamed("Copy booking link").click();
    await vi.waitFor(() => expect(document.querySelector("input[readonly]")).not.toBeNull());
    const input = $("input[readonly]") as HTMLInputElement;
    expect(input.value).toBe("https://club.example/e/abc123");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect($(".copy-status").textContent).toContain("manually");
  });

  it("falls back when there is no clipboard API", async () => {
    await start([EVENT], { clipboard: null as never });
    buttonNamed("Copy booking link").click();
    await vi.waitFor(() => expect(document.querySelector("input[readonly]")).not.toBeNull());
  });
});

describe("sign out", () => {
  it("posts the logout and follows the navigation", async () => {
    const { calls, navigate } = await start([]);
    buttonNamed("Sign out").click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/admin/login"));
    const logout = calls.find((c) => c.url === "/api/admin/logout")!;
    expect(logout.init?.method).toBe("POST");
    expect((logout.init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
  });
});
