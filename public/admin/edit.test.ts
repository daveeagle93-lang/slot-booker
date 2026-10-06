// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./edit.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ORIGIN = "https://club.example";
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
// 2026-06-13 is BST: 09:00 London is 08:00Z.
const EVENT = {
  slug: SLUG, name: "Trial Day", archived: false, listed: true, date: "2026-06-13", start: "09:00", end: "16:00",
  sessionMinutes: 15, gapMinutes: 5, costPence: 1250, venuePostcode: "SW1A 1AA", details: "Bring water",
  startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z",
  breaks: [{ start: "12:00", end: "12:20", label: "Lunch", startUtc: "2026-06-13T11:00:00Z", endUtc: "2026-06-13T11:20:00Z" }],
};
const DETAIL = { event: EVENT, slots: [], orphans: [] };
const REX = { id: 11, slotStart: "2026-06-13T09:05:00Z", dogName: "Rex", handlerName: "Sam Smith" }; // 10:05 London
const FLO = { id: 12, slotStart: "2026-06-13T09:25:00Z", dogName: "Flo", handlerName: "Pat Jones" }; // 10:25
const NEW = { id: 13, slotStart: "2026-06-13T09:45:00Z", dogName: "Newcomer", handlerName: "Nell" }; // 10:45
const slots = (...starts: string[]) => starts.map((s) => ({ start: s, end: s }));
const SLOTS = slots("2026-06-13T08:00:00Z", "2026-06-13T08:20:00Z", "2026-06-13T08:40:00Z");
const preview = (affected: unknown[] = [], extra: Record<string, unknown> = {}) =>
  reply(200, { slots: SLOTS, suggestions: [], affected, ...extra });
const SAVED = { event: EVENT, slotCount: 21, removed: [] };

type Call = { url: string; init?: RequestInit; body?: any };
type Handler = (call: Call) => Response | Promise<Response>;
const EVENT_URL = `/api/admin/events/${SLUG}`;
const PREVIEW = `${EVENT_URL}/preview`;

interface Options { get?: Handler; preview?: Handler; put?: Handler; clipboard?: unknown; search?: string }

async function start(opts: Options = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const clipboard = opts.clipboard === undefined ? { writeText: vi.fn(async () => {}) } : opts.clipboard;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === "/api/admin/session") return reply(200, SESSION);
    if (url === PREVIEW) return (opts.preview ?? (() => preview()))(call);
    if (url === EVENT_URL && init?.method === "PUT") return (opts.put ?? (() => reply(200, SAVED)))(call);
    if (url === EVENT_URL) return (opts.get ?? (() => reply(200, DETAIL)))(call);
    throw new Error(`unexpected ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate,
    location: { origin: ORIGIN, search: opts.search ?? `?slug=${SLUG}` }, clipboard: clipboard as never,
  });
  return { calls, navigate, clipboard: clipboard as { writeText: ReturnType<typeof vi.fn> } };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const set = (id: string, value: string) => {
  const el = input(id);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const buttonNamed = (name: string) => $$("button").find((b) => b.textContent === name)!;
const settle = () => vi.advanceTimersByTimeAsync(300);
const tick = () => vi.advanceTimersByTimeAsync(0);
const submit = () => $("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const text = () => document.body.textContent ?? "";
const previewCalls = (calls: Call[]) => calls.filter((c) => c.url === PREVIEW);
const puts = (calls: Call[]) => calls.filter((c) => c.url === EVENT_URL && c.init?.method === "PUT");
const affectedLines = () => $$(".affected li").map((li) => li.textContent);
const confirmLines = () => $$(".confirm-list li").map((li) => li.textContent);

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("loading", () => {
  it("fills the form from the event, with its breaks and their names, and previews at once", async () => {
    const { calls } = await start();
    expect(calls.map((c) => c.url).slice(0, 2)).toEqual(["/api/admin/session", EVENT_URL]);
    expect(calls[1].init?.method ?? "GET").toBe("GET");
    expect($("h1").textContent).toBe("Edit event");
    expect(input("name").value).toBe("Trial Day");
    expect(input("date").value).toBe("2026-06-13");
    expect(input("start").value).toBe("09:00");
    expect(input("end").value).toBe("16:00");
    expect(input("session").value).toBe("15");
    expect(input("gap").value).toBe("5");
    expect(input("cost").value).toBe("12.50");
    expect(input("postcode").value).toBe("SW1A 1AA");
    expect(input("details").value).toBe("Bring water");
    expect($$(".break-row")).toHaveLength(1);
    expect(input("break-1-start").value).toBe("12:00");
    expect(input("break-1-end").value).toBe("12:20");
    expect(input("break-1-label").value).toBe("Lunch");
    expect(buttonNamed("Save changes")).toBeDefined();
    expect($("a.back").getAttribute("href")).toBe("/admin/");
    // The preview doesn't wait for the debounce, and uses the event's own endpoint.
    await tick();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body).toMatchObject({
      date: "2026-06-13", start: "09:00", end: "16:00", sessionMinutes: 15, gapMinutes: 5,
      breaks: [{ start: "12:00", end: "12:20", label: "Lunch" }],
    });
    expect($$(".chips li").map((li) => li.textContent)).toEqual(["09:00", "09:20", "09:40"]);
  });

  it("ticks the Listed on the home page box for a listed event and leaves it unticked for an unlisted one", async () => {
    await start();
    expect(input("listed").checked).toBe(true);
    await start({ get: () => reply(200, { ...DETAIL, event: { ...EVENT, listed: false } }) });
    expect(input("listed").checked).toBe(false);
    expect(document.getElementById(input("listed").getAttribute("aria-describedby")!)!.textContent)
      .toBe("Untick to keep this event off the home page. Anyone with its link can still book.");
  });

  it("shows a free event's cost as 0 and a whole-pound one without pence", async () => {
    await start({ get: () => reply(200, { ...DETAIL, event: { ...EVENT, costPence: 0 } }) });
    expect(input("cost").value).toBe("0");
  });

  it("sends the browser to login without a session", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const navigate = vi.fn();
    await init({ document, fetch: (async () => reply(401)) as never, navigate, location: { origin: ORIGIN, search: `?slug=${SLUG}` }, clipboard: null as never });
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect(document.querySelector("form")).toBeNull();
  });

  it.each([["", "no slug"], ["?slug=", "empty slug"], ["?slug=short", "short slug"], ["?slug=a%20b%2Fc%3Cd" + "x".repeat(20), "odd characters"]])(
    "says the event can't be found and links back for %j (%s), without asking the server",
    async (search) => {
      const { calls } = await start({ search });
      expect(text()).toContain("We couldn't find that event.");
      expect($("a[href='/admin/']").textContent).toBe("Back to events");
      expect(document.querySelector("form")).toBeNull();
      expect(calls.map((c) => c.url)).toEqual(["/api/admin/session"]);
    },
  );

  it("says the event can't be found, with a way back, when the server answers 404", async () => {
    await start({ get: () => reply(404, { error: { code: "not_found", message: "Event not found" } }) });
    expect(text()).toContain("We couldn't find that event.");
    expect($("a[href='/admin/']")).not.toBeNull();
    expect(document.querySelector("form")).toBeNull();
  });

  it("offers a retry when loading fails, then loads", async () => {
    let fail = true;
    const { calls } = await start({ get: () => (fail ? reply(500, null) : reply(200, DETAIL)) });
    expect($("[role=alert]").textContent).toContain("We couldn't load the event.");
    fail = false;
    buttonNamed("Retry").click();
    await tick();
    expect($("h1").textContent).toBe("Edit event");
    expect(calls.filter((c) => c.url === EVENT_URL)).toHaveLength(2);
  });

  it("offers a retry after a network failure", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/admin/session") return reply(200, SESSION);
      throw new TypeError("offline");
    });
    await init({ document, fetch: fetch as never, navigate: vi.fn(), location: { origin: ORIGIN, search: `?slug=${SLUG}` }, clipboard: null as never });
    expect($("[role=alert]").textContent).toContain("We couldn't load the event.");
    expect(buttonNamed("Retry")).toBeDefined();
  });

  it("shows the event's text as text", async () => {
    await start({ get: () => reply(200, { ...DETAIL, event: { ...EVENT, name: HOSTILE, details: HOSTILE, breaks: [{ ...EVENT.breaks[0], label: HOSTILE }] } }) });
    expect(input("name").value).toBe(HOSTILE);
    expect(input("break-1-label").value).toBe(HOSTILE);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("<img");
  });
});

describe("the affected bookings panel", () => {
  it("lists each booking as HH:MM — dog — handler in London time", async () => {
    await start({ preview: () => preview([REX, FLO]) });
    await tick();
    expect($(".affected-title").textContent).toBe("2 bookings are on slots this change removes:");
    expect(affectedLines()).toEqual(["10:05 — Rex — Sam Smith", "10:25 — Flo — Pat Jones"]);
  });

  it("says 1 booking for one, and shows nothing when none are affected", async () => {
    const { calls } = await start({ preview: (c) => preview(c.body.end === "15:00" ? [REX] : []) });
    await tick();
    expect($$(".affected li")).toHaveLength(0);
    expect($(".affected").textContent).toBe("");
    set("end", "15:00");
    await settle();
    expect($(".affected-title").textContent).toBe("1 booking is on slots this change removes:");
    expect(previewCalls(calls)).toHaveLength(2);
    set("end", "16:00");
    await settle();
    expect($(".affected").textContent).toBe("");
  });

  it("clears the list when the draft becomes unusable", async () => {
    await start({ preview: () => preview([REX]) });
    await tick();
    set("end", "");
    expect($(".affected").textContent).toBe("");
  });

  it("shows names as text, not markup", async () => {
    await start({ preview: () => preview([{ ...REX, dogName: HOSTILE, handlerName: HOSTILE }]) });
    await tick();
    expect(affectedLines()).toEqual([`10:05 — ${HOSTILE} — ${HOSTILE}`]);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("<img");
  });
});

describe("saving with nothing affected", () => {
  it("sends the exact JSON with an empty removeBookingIds and no idempotency key, and needs no confirmation", async () => {
    const { calls } = await start();
    await tick();
    set("name", "  Trial Day, renamed ");
    set("cost", "15");
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    const put = puts(calls)[0];
    expect(put.init?.headers).toEqual({ "Content-Type": "application/json", "X-CSRF-Token": "tok" });
    expect(put.body).toEqual({
      name: "Trial Day, renamed", date: "2026-06-13", start: "09:00", end: "16:00", sessionMinutes: 15, gapMinutes: 5,
      costPence: 1500, venuePostcode: "SW1A 1AA", details: "Bring water", shareMessage: "",
      breaks: [{ start: "12:00", end: "12:20", label: "Lunch" }], listed: true, removeBookingIds: [],
    });
    expect(document.querySelector(".confirm")).toBeNull();
    expect($("h1").textContent).toBe("Saved.");
  });

  it("does not preview again when the box is toggled, as it is not a schedule change", async () => {
    const { calls } = await start({ preview: () => preview([REX]) });
    await tick();
    const previews = previewCalls(calls).length;
    input("listed").click();
    await settle();
    expect(previewCalls(calls)).toHaveLength(previews);
    expect(affectedLines()).toEqual(["10:05 — Rex — Sam Smith"]);
  });

  it("saves listed: false for an event that was listed, with nothing to confirm", async () => {
    const { calls } = await start();
    await tick();
    input("listed").click();
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body).toMatchObject({ listed: false, removeBookingIds: [] });
    expect(document.querySelector(".confirm")).toBeNull();
  });

  it("saves straight away when Save is pressed before the first preview has come back", async () => {
    const { calls } = await start({ preview: () => new Promise<Response>(() => {}) });
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body.removeBookingIds).toEqual([]);
  });

  it("disables Save while pending and saves only once", async () => {
    let finish!: (r: Response) => void;
    const { calls } = await start({ put: () => new Promise<Response>((resolve) => { finish = resolve; }) });
    await tick();
    const save = buttonNamed("Save changes") as HTMLButtonElement;
    submit();
    await tick();
    expect(save.disabled).toBe(true);
    expect($(".progress").textContent).toBe("Saving the changes…");
    submit();
    save.click();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    finish(reply(200, SAVED));
    await tick();
    expect($("h1").textContent).toBe("Saved.");
  });

  it("blocks an invalid cost locally", async () => {
    const { calls } = await start();
    await tick();
    set("cost", "12.505");
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(0);
    expect(document.getElementById("cost-error")!.textContent).toBe("Use two decimal places at most, for example 12.50.");
    expect(document.activeElement).toBe(input("cost"));
  });

  it("shows the server's field errors and keeps the form", async () => {
    await start({
      put: () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { name: "Enter the event name.", "breaks.0.label": "Too long." } }),
    });
    await tick();
    submit();
    await tick();
    expect(document.getElementById("name-error")!.textContent).toBe("Enter the event name.");
    expect(document.getElementById("break-1-label-error")!.textContent).toBe("Too long.");
    expect(document.activeElement).toBe(input("name"));
    expect($("form")).not.toBeNull();
  });

  it("keeps the form and offers a retry after a server error or a lost connection", async () => {
    let fail: "http" | "net" | null = "http";
    const { calls } = await start({
      put: () => (fail === "net" ? Promise.reject(new TypeError("offline")) : fail ? reply(500, null) : reply(200, SAVED)),
    });
    await tick();
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    fail = "net";
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    fail = null;
    submit();
    await tick();
    expect($("h1").textContent).toBe("Saved.");
    expect(puts(calls)).toHaveLength(3);
  });

  it("says so when the event has gone", async () => {
    await start({ put: () => reply(404, { error: { code: "not_found", message: "Event not found" } }) });
    await tick();
    submit();
    await tick();
    expect($(".form-error").textContent).toBe("This event no longer exists.");
  });
});

describe("saving with bookings affected", () => {
  async function affectedForm(over: Options = {}) {
    const ctx = await start({ preview: () => preview([REX, FLO]), ...over });
    await tick();
    return ctx;
  }

  it("does not save: it asks for confirmation, listing who must rebook, and focuses the heading", async () => {
    const { calls } = await affectedForm();
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(0);
    expect($(".confirm h2").textContent).toBe("Saving will remove 2 bookings. Tell these people to rebook:");
    expect(confirmLines()).toEqual(["10:05 — Rex — Sam Smith", "10:25 — Flo — Pat Jones"]);
    expect($$(".confirm button").map((b) => b.textContent)).toEqual(["Remove 2 bookings and save", "Cancel"]);
    expect($(".confirm .button.danger").textContent).toBe("Remove 2 bookings and save");
    expect(document.activeElement).toBe($(".confirm h2"));
    expect($(".new-layout").hidden).toBe(true);
  });

  it("uses the singular for one booking", async () => {
    await affectedForm({ preview: () => preview([REX]) });
    submit();
    await tick();
    expect($(".confirm h2").textContent).toBe("Saving will remove 1 booking. Tell this person to rebook:");
    expect(buttonNamed("Remove 1 booking and save")).toBeDefined();
  });

  it("sends exactly the affected ids, and only after the destructive button is pressed", async () => {
    const { calls } = await affectedForm({ put: () => reply(200, { ...SAVED, removed: [REX, FLO] }) });
    set("end", "15:00");
    await settle();
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(0);
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body.removeBookingIds).toEqual([11, 12]);
    expect(puts(calls)[0].body.end).toBe("15:00");
    expect($("h1").textContent).toBe("Saved.");
  });

  it("Cancel sends nothing, brings the form back with its edits, focuses Save and refreshes the preview", async () => {
    const { calls } = await affectedForm();
    set("name", "Kept edit");
    submit();
    await tick();
    const previews = previewCalls(calls).length;
    buttonNamed("Cancel").click();
    await tick();
    expect(puts(calls)).toHaveLength(0);
    expect(document.querySelector(".confirm")).toBeNull();
    expect($(".new-layout").hidden).toBe(false);
    expect(input("name").value).toBe("Kept edit");
    expect(document.activeElement).toBe(buttonNamed("Save changes"));
    expect(previewCalls(calls)).toHaveLength(previews + 1);
  });

  it("disables both buttons while the save is pending", async () => {
    let finish!: (r: Response) => void;
    const { calls } = await affectedForm({ put: () => new Promise<Response>((resolve) => { finish = resolve; }) });
    submit();
    await tick();
    const remove = buttonNamed("Remove 2 bookings and save") as HTMLButtonElement;
    remove.click();
    await tick();
    expect(remove.disabled).toBe(true);
    expect((buttonNamed("Cancel") as HTMLButtonElement).disabled).toBe(true);
    remove.click();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    finish(reply(200, SAVED));
    await tick();
  });

  it("goes to the server, which asks for the confirmation, when the preview is out of date", async () => {
    let answer: Response = preview([]);
    const { calls } = await start({
      preview: () => answer,
      put: (c) => (c.body.removeBookingIds.length === 0
        ? reply(409, { error: { code: "bookings_affected", message: "x" }, affected: [REX] })
        : reply(200, { ...SAVED, removed: [REX] })),
    });
    await tick();
    answer = new Promise(() => {}) as never;
    set("end", "15:00"); // a preview is now pending: what the panel says no longer fits the form
    submit();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body.removeBookingIds).toEqual([]);
    expect($(".confirm h2").textContent).toBe("Saving will remove 1 booking. Tell this person to rebook:");
    expect(document.querySelector(".confirm .notice")).toBeNull();
    buttonNamed("Remove 1 booking and save").click();
    await tick();
    expect(puts(calls)[1].body.removeBookingIds).toEqual([11]);
    expect($("h1").textContent).toBe("Saved.");
  });

  it("shows the refreshed list and asks again when a booking appeared since the preview (409)", async () => {
    let attempt = 0;
    const { calls } = await affectedForm({
      put: () => (++attempt === 1
        ? reply(409, { error: { code: "bookings_affected", message: "x" }, affected: [REX, FLO, NEW] })
        : reply(200, { ...SAVED, removed: [REX, FLO, NEW] })),
    });
    submit();
    await tick();
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body.removeBookingIds).toEqual([11, 12]);
    expect($("h1").textContent).not.toBe("Saved.");
    expect($(".confirm h2").textContent).toBe("Saving will remove 3 bookings. Tell these people to rebook:");
    expect(confirmLines()).toEqual(["10:05 — Rex — Sam Smith", "10:25 — Flo — Pat Jones", "10:45 — Newcomer — Nell"]);
    expect($(".confirm .notice").textContent).toBe("Another booking has appeared since you checked, so please check the list again.");
    expect(document.activeElement).toBe($(".confirm h2"));
    // Nothing more is sent until the admin confirms again, and then it is the new list.
    await settle();
    expect(puts(calls)).toHaveLength(1);
    buttonNamed("Remove 3 bookings and save").click();
    await tick();
    expect(puts(calls)).toHaveLength(2);
    expect(puts(calls)[1].body.removeBookingIds).toEqual([11, 12, 13]);
    expect($("h1").textContent).toBe("Saved.");
  });

  it("asks the admin to save again when a 409 comes back with nothing left to remove", async () => {
    await affectedForm({ put: () => reply(409, { error: { code: "bookings_affected", message: "x" }, affected: [] }) });
    submit();
    await tick();
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect(document.querySelector(".confirm")).toBeNull();
    expect($(".form-error").textContent).toBe("Something changed while saving. Try saving again.");
  });

  it("returns to the form with its errors when the save is refused as invalid", async () => {
    await affectedForm({ put: () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { date: "The event must start in the future." } }) });
    submit();
    await tick();
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect(document.querySelector(".confirm")).toBeNull();
    expect($(".new-layout").hidden).toBe(false);
    expect(document.getElementById("date-error")!.textContent).toBe("The event must start in the future.");
    expect(document.activeElement).toBe(input("date"));
  });

  it("shows names as text in the confirmation", async () => {
    await affectedForm({ preview: () => preview([{ ...REX, dogName: HOSTILE, handlerName: HOSTILE }]) });
    submit();
    await tick();
    expect(confirmLines()).toEqual([`10:05 — ${HOSTILE} — ${HOSTILE}`]);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("<img");
  });
});

describe("the result view", () => {
  it("says Saved. with links back to the list and to the public page, focusing the heading", async () => {
    await start();
    await tick();
    submit();
    await tick();
    expect(document.querySelector("form")).toBeNull();
    expect($("h1").textContent).toBe("Saved.");
    expect(document.activeElement).toBe($("h1"));
    expect($(".event-name").textContent).toBe("Trial Day");
    expect($$("a").find((a) => a.textContent === "Back to events")!.getAttribute("href")).toBe("/admin/");
    expect($$("a").find((a) => a.textContent === "Open the booking page")!.getAttribute("href")).toBe(`/e/${SLUG}`);
    expect(document.querySelector("#rebook-text")).toBeNull();
  });

  it("lists who was removed in a copyable plain-text block", async () => {
    const { clipboard } = await start({ preview: () => preview([REX, FLO]), put: () => reply(200, { ...SAVED, removed: [REX, FLO] }) });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect($(".removed h2").textContent).toBe("Removed bookings: tell these people to rebook");
    const block = input("rebook-text");
    expect(block.tagName).toBe("TEXTAREA");
    expect(block.readOnly).toBe(true);
    expect(block.value).toBe("Please rebook: 10:05 — Rex — Sam Smith\nPlease rebook: 10:25 — Flo — Pat Jones");
    buttonNamed("Copy list").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(block.value);
    expect($(".copy-status").textContent).toBe("Copied");
  });

  it("still shows the list the admin confirmed when the server removed nothing (a retry after a lost response)", async () => {
    await start({ preview: () => preview([REX, FLO]), put: () => reply(200, { ...SAVED, removed: [] }) });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect(input("rebook-text").value).toBe("Please rebook: 10:05 — Rex — Sam Smith\nPlease rebook: 10:25 — Flo — Pat Jones");
  });

  it("does not fetch the event again when the server removed everything the admin confirmed", async () => {
    const { calls } = await start({ preview: () => preview([REX, FLO]), put: () => reply(200, { ...SAVED, removed: [FLO, REX] }) });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 2 bookings and save").click();
    await tick();
    expect(calls.filter((c) => c.url === EVENT_URL && c.init?.method !== "PUT")).toHaveLength(1); // the first load only
    expect($(".note")).toBeNull();
  });

  it("leaves out a confirmed booking that is still on the event (moved to a surviving slot, in a slot or among the orphans)", async () => {
    const present = {
      ...DETAIL,
      slots: [{ start: EVENT.startUtc, end: EVENT.startUtc, booking: { id: 11, dogName: "Rex", handlerName: "Sam Smith" } }],
      orphans: [{ id: 14, slotStart: "2026-06-13T07:00:00Z", dogName: "Other", handlerName: "Ola" }],
    };
    const OTHER = { id: 14, slotStart: "2026-06-13T07:00:00Z", dogName: "Other", handlerName: "Ola" };
    let gets = 0;
    await start({
      preview: () => preview([REX, FLO, OTHER]), put: () => reply(200, { ...SAVED, removed: [FLO] }),
      get: () => reply(200, ++gets === 1 ? DETAIL : present),
    });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 3 bookings and save").click();
    await tick();
    expect(gets).toBe(2);
    expect(input("rebook-text").value).toBe("Please rebook: 10:25 — Flo — Pat Jones");
    expect($(".note")).toBeNull();
  });

  it("shows no list when every confirmed booking is still on the event", async () => {
    const present = { ...DETAIL, slots: [{ start: EVENT.startUtc, end: EVENT.startUtc, booking: { id: 11, dogName: "Rex", handlerName: "Sam Smith" } }] };
    let gets = 0;
    await start({ preview: () => preview([REX]), put: () => reply(200, { ...SAVED, removed: [] }), get: () => reply(200, ++gets === 1 ? DETAIL : present) });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 1 booking and save").click();
    await tick();
    expect(document.querySelector("#rebook-text")).toBeNull();
    expect($("h1").textContent).toBe("Saved.");
  });

  it("ignores a second press of the confirm button while the re-fetch is pending: one PUT, one result view", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    let gets = 0;
    const { calls } = await start({
      preview: () => preview([REX]), put: () => reply(200, { ...SAVED, removed: [] }),
      get: () => (++gets === 1 ? reply(200, DETAIL) : pending),
    });
    await tick();
    submit();
    await tick();
    const confirm = buttonNamed("Remove 1 booking and save");
    confirm.click();
    await tick();
    expect(gets).toBe(2); // the re-fetch is now in flight
    confirm.click();
    await tick();
    expect(puts(calls)).toHaveLength(1);
    release(reply(200, DETAIL));
    await tick();
    expect($$("h1")).toHaveLength(1);
    expect($("h1").textContent).toBe("Saved.");
    expect($$(".removed")).toHaveLength(1);
    expect(puts(calls)).toHaveLength(1);
  });

  it("shows only what the server removed, and says the check failed, when the event can't be fetched again", async () => {
    for (const failing of [() => reply(500, { error: { code: "internal_error" } }), () => { throw new TypeError("offline"); }]) {
      let gets = 0;
      await start({
        preview: () => preview([REX, FLO]), put: () => reply(200, { ...SAVED, removed: [FLO] }),
        get: () => (++gets === 1 ? reply(200, DETAIL) : failing()),
      });
      await tick();
      submit();
      await tick();
      buttonNamed("Remove 2 bookings and save").click();
      await tick();
      expect(gets).toBe(2);
      expect(input("rebook-text").value).toBe("Please rebook: 10:25 — Flo — Pat Jones");
      expect($(".note").textContent).toBe("Couldn't check who still has a booking; check the schedule.");
    }
  });

  it("falls back to selecting the text when the clipboard fails", async () => {
    await start({
      preview: () => preview([REX]), put: () => reply(200, { ...SAVED, removed: [REX] }),
      clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 1 booking and save").click();
    await tick();
    buttonNamed("Copy list").click();
    await tick();
    expect(document.activeElement).toBe(input("rebook-text"));
    expect($(".copy-status").textContent).toContain("manually");
  });

  it("shows hostile names and event names as text", async () => {
    const hostile = { ...REX, dogName: HOSTILE, handlerName: HOSTILE };
    await start({
      preview: () => preview([hostile]),
      put: () => reply(200, { ...SAVED, event: { ...EVENT, name: HOSTILE }, removed: [hostile] }),
    });
    await tick();
    submit();
    await tick();
    buttonNamed("Remove 1 booking and save").click();
    await tick();
    expect($(".event-name").textContent).toBe(HOSTILE);
    expect(input("rebook-text").value).toBe(`Please rebook: 10:05 — ${HOSTILE} — ${HOSTILE}`);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.innerHTML).not.toContain("<img");
  });

  it("does not repaint the form when a preview returns after Save succeeds", async () => {
    const pending: ((r: Response) => void)[] = [];
    await start({ preview: () => new Promise<Response>((resolve) => { pending.push(resolve); }) });
    submit();
    await tick();
    for (const resolve of pending) resolve(preview([REX]));
    await tick();
    expect($("h1").textContent).toBe("Saved.");
    expect(document.querySelector(".preview")).toBeNull();
  });
});

describe("near-miss suggestions in edit", () => {
  const suggestion = (label = "Lunch") => ({
    breakIndex: 0, droppedSlot: { start: "2026-06-13T11:00:00Z", end: "2026-06-13T11:15:00Z" }, overrunMinutes: 5,
    suggestedBreak: { start: "x", end: "y" }, suggestedLocal: { start: "13:05", end: "14:00" }, breakLabel: label,
  });

  it("words the suggestion with the break's name and moves the break on request", async () => {
    const { calls } = await start({ preview: (c) => preview([], { suggestions: c.body.breaks[0].start === "12:00" ? [suggestion()] : [] }) });
    await tick();
    expect($(".suggestion p").textContent).toBe("Move Lunch to 13:05–14:00 to keep the 12:00 session?");
    buttonNamed("Move break").click();
    expect(input("break-1-start").value).toBe("13:05");
    expect(input("break-1-end").value).toBe("14:00");
    expect(input("break-1-label").value).toBe("Lunch");
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "13:05", end: "14:00", label: "Lunch" }]);
    expect($$(".suggestion")).toHaveLength(0);
  });

  it("keeps a declined suggestion hidden", async () => {
    await start({ preview: () => preview([], { suggestions: [suggestion()] }) });
    await tick();
    buttonNamed("Keep as it is").click();
    set("gap", "5");
    await settle();
    expect($$(".suggestion")).toHaveLength(0);
  });
});

describe("the share message", () => {
  const MESSAGE_FIELD = () => document.getElementById("share-message") as HTMLTextAreaElement;
  const edit = (event: Record<string, unknown>) => start({ get: () => reply(200, { ...DETAIL, event: { ...EVENT, ...event } }) });

  it("has no template picker and asks for no templates", async () => {
    const { calls } = await start();
    await tick();
    expect(document.getElementById("template")).toBeNull();
    expect(calls.some((c) => c.url === "/api/admin/templates")).toBe(false);
  });

  it("is a labelled textarea after Details, with a note and a link to the templates page, prefilled from the event", async () => {
    await edit({ shareMessage: "Book {event} at {postcode}\n{link}" });
    expect(MESSAGE_FIELD().tagName).toBe("TEXTAREA");
    expect(MESSAGE_FIELD().maxLength).toBe(1000);
    expect(MESSAGE_FIELD().value).toBe("Book {event} at {postcode}\n{link}");
    expect($("label[for='share-message']").textContent).toBe("Share message (optional)");
    expect(MESSAGE_FIELD().getAttribute("aria-describedby")).toContain("share-message-hint");
    const hint = document.getElementById("share-message-hint")!;
    expect(hint.textContent).toContain("Used when you share this event. Leave it blank to use your default template's message.");
    expect(hint.textContent).toContain("Placeholders such as {event} and {date} are filled in when you share.");
    expect(hint.querySelector("a")!.getAttribute("href")).toBe("/admin/templates");
    const order = $$("label").map((l) => l.textContent);
    expect(order.indexOf("Share message (optional)")).toBe(order.indexOf("Details (optional)") + 1);
  });

  it("is empty when the event has none, and an old response without the field also gives an empty box", async () => {
    await edit({ shareMessage: "" });
    expect(MESSAGE_FIELD().value).toBe("");
    await start();
    expect(MESSAGE_FIELD().value).toBe("");
  });

  it("is sent with the save, as typed (trimmed), and does not trigger a preview", async () => {
    const { calls } = await edit({ shareMessage: "Old" });
    await tick();
    const before = previewCalls(calls).length;
    MESSAGE_FIELD().value = "  New {event}  ";
    MESSAGE_FIELD().dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(previewCalls(calls)).toHaveLength(before);
    submit();
    await tick();
    expect(puts(calls)[0].body.shareMessage).toBe("New {event}");
  });

  it("sends an emptied message as an empty string", async () => {
    const { calls } = await edit({ shareMessage: "Old" });
    await tick();
    MESSAGE_FIELD().value = "";
    submit();
    await tick();
    expect(puts(calls)[0].body.shareMessage).toBe("");
  });

  it("shows the server's shareMessage error on the field and focuses it", async () => {
    await start({ put: () => reply(400, { error: { code: "invalid_input" }, fields: { shareMessage: "The share message can be at most 1000 characters." } }) });
    await tick();
    submit();
    await tick();
    expect(document.getElementById("share-message-error")!.textContent).toBe("The share message can be at most 1000 characters.");
    expect(MESSAGE_FIELD().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(MESSAGE_FIELD());
  });

  it("keeps hostile text as text", async () => {
    await edit({ shareMessage: HOSTILE });
    expect(MESSAGE_FIELD().value).toBe(HOSTILE);
    expect(document.querySelector("img")).toBeNull();
  });
});
