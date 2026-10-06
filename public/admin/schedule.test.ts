// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./schedule.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ORIGIN = "https://club.example";
const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const BASE = `/api/admin/events/${SLUG}`;
const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };

// 2026-06-13 is BST: 09:00 London is 08:00Z. Slots 09:00 09:15 09:30 | lunch 09:45-10:15 | 10:15 10:30.
const S = ["2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "2026-06-13T08:30:00Z", "2026-06-13T09:15:00Z", "2026-06-13T09:30:00Z"];
const EVENT = {
  slug: SLUG, name: "Trial Day", archived: false, date: "2026-06-13", start: "09:00", end: "10:45",
  startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T09:45:00Z", sessionMinutes: 15, gapMinutes: 0, costPence: 0, venuePostcode: "AB1 2CD", details: "",
  breaks: [{ start: "09:45", end: "10:15", label: "Lunch", startUtc: "2026-06-13T08:45:00Z", endUtc: "2026-06-13T09:15:00Z" }],
};
const REX = { id: 11, dogName: "Rex", handlerName: "Sam Smith" };
const FLO = { id: 12, dogName: "Flo", handlerName: "Pat Jones" };
const LOST = { id: 13, slotStart: "2026-06-13T07:00:00Z", dogName: "Lost", handlerName: "Lou" }; // 08:00 London, not a slot
const LINEUP = "Trial Day\nSaturday 13 June 2026 · AB1 2CD\n\n09:00 — free\n09:15 — Rex — Sam Smith";

type Booking = { id: number; dogName: string; handlerName: string } | null;
const detail = (booked: Booking[] = [null, REX, null, FLO, null], orphans: unknown[] = [], lineup = LINEUP, event: unknown = EVENT) => ({
  event, orphans, lineup, slots: S.map((start, i) => ({ start, end: start, booking: booked[i] ?? null })),
});

type Call = { url: string; method: string; body?: any };
type Handler = (call: Call) => Response | Promise<Response> | undefined;

interface Options { respond?: Handler; initial?: unknown; clipboard?: unknown; search?: string; getStatus?: number; navigator?: unknown; settings?: Promise<unknown> }

async function start(o: Options = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const clipboard = "clipboard" in o ? o.clipboard : { writeText: vi.fn(async () => {}) };
  let current: unknown = o.initial ?? detail();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === "/api/admin/session") return reply(200, SESSION);
    const custom = o.respond?.(call);
    if (custom) return custom;
    if (url === BASE && call.method === "GET") return o.getStatus ? reply(o.getStatus, { error: { code: "x" } }) : reply(200, current);
    throw new Error(`unexpected ${call.method} ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate,
    location: { origin: ORIGIN, search: o.search ?? `?slug=${SLUG}` }, clipboard: clipboard as never,
    ...(o.navigator ? { navigator: o.navigator as never } : {}), ...(o.settings ? { settings: o.settings as never } : {}),
  });
  return {
    calls, navigate, clipboard: clipboard as { writeText: ReturnType<typeof vi.fn> },
    setDetail: (d: unknown) => { current = d; },
  };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const text = () => document.body.textContent ?? "";
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const rows = () => $$(".sched > li");
const row = (time: string) => $$(".sched-row").find((r) => r.querySelector(".sched-time")!.textContent === time)!;
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent === name)!;
const submit = (form: Element) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const statusText = () => $(".sched-status").textContent;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET" && c.url !== "/api/admin/session");
const options = (select: HTMLElement) => [...select.querySelectorAll("option")].filter((o) => o.value !== "").map((o) => o.textContent);

afterEach(() => { document.body.innerHTML = ""; });

describe("loading and rendering", () => {
  it("tags an unlisted event Not listed, and a listed one (or one with no flag) not at all", async () => {
    await start({ initial: detail(undefined, undefined, undefined, { ...EVENT, listed: false }) });
    expect($$(".badge").map((b) => b.textContent)).toEqual(["Not listed"]);
    await start({ initial: detail(undefined, undefined, undefined, { ...EVENT, listed: true }) });
    expect($$(".badge")).toHaveLength(0);
    await start();
    expect($$(".badge")).toHaveLength(0);
  });

  it("shows the event, the London date, the links, and every slot and break in time order", async () => {
    const { calls } = await start();
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/session", BASE]);
    expect($("h1").textContent).toBe("Schedule");
    expect($(".event-name").textContent).toBe("Trial Day");
    expect($(".sched-date").textContent).toBe("Saturday 13 June 2026");
    const edit = $$("a").find((a) => a.textContent === "Edit event")!;
    expect(edit.getAttribute("href")).toBe(`/admin/edit?slug=${SLUG}`);
    expect($$("a").find((a) => a.textContent === "Open public page")!.getAttribute("href")).toBe(`/e/${SLUG}`);
    expect(rows().map((r) => r.querySelector(".sched-time")!.textContent)).toEqual(["09:00", "09:15", "09:30", "09:45–10:15", "10:15", "10:30"]);
    expect(rows()[3].className).toBe("sched-break");
    expect(rows()[3].textContent).toContain("Lunch");
  });

  it("has a Download CSV link: a plain same-origin download of this event's export, styled as a button", async () => {
    await start();
    const link = $$("a").find((a) => a.textContent === "Download CSV")!;
    expect(link.getAttribute("href")).toBe(`${BASE}/export.csv`);
    expect(link.hasAttribute("download")).toBe(true);
    expect(link.className).toBe("button");
    expect(link.parentElement!.className).toBe("actions");
  });

  it("shows booked slots with dog, handler and Move, Swap and Clear; free slots with Add booking", async () => {
    await start();
    const booked = row("09:15");
    expect(booked.querySelector(".sched-who")!.textContent).toBe("Rex (Sam Smith)");
    expect([...booked.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Move", "Swap", "Clear"]);
    const free = row("09:00");
    expect(free.querySelector(".sched-who")!.textContent).toBe("Free");
    expect([...free.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add booking"]);
  });

  it("calls an unlabelled break Break", async () => {
    await start({ initial: detail(undefined, [], LINEUP, { ...EVENT, breaks: [{ ...EVENT.breaks[0], label: "" }] }) });
    expect(rows()[3].textContent).toBe("09:45–10:15Break");
  });

  it("puts orphans in a 'Not in the schedule' section with Clear and Move only", async () => {
    await start({ initial: detail(undefined, [LOST]) });
    const section = $(".sched-orphans");
    expect(section.querySelector("h2")!.textContent).toBe("Not in the schedule");
    const orphan = section.querySelector("li")!;
    expect(orphan.textContent).toContain("Lost (Lou)");
    expect(orphan.textContent).toContain("Saturday 13 June 2026, 08:00");
    expect([...orphan.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Move", "Clear"]);
  });

  it("has no orphans section when there are none", async () => {
    await start();
    expect($(".sched-orphans")).toBeNull();
  });

  it("keeps hostile names inert everywhere they appear", async () => {
    const hostile = { id: 21, dogName: HOSTILE, handlerName: `<b>${HOSTILE}</b>` };
    await start({ initial: detail([null, hostile, null, FLO, null], [{ ...LOST, dogName: HOSTILE }], LINEUP, { ...EVENT, name: HOSTILE, breaks: [{ ...EVENT.breaks[0], label: HOSTILE }] }) });
    expect(document.querySelector("img")).toBeNull();
    expect($(".event-name").textContent).toBe(HOSTILE);
    expect(row("09:15").querySelector(".sched-who")!.textContent).toBe(`${HOSTILE} (<b>${HOSTILE}</b>)`);
    button(row("10:15"), "Swap").click();
    expect(options($("select"))[0]).toContain(HOSTILE);
    button(row("10:15"), "Clear").click();
    button(row("09:15"), "Clear").click();
    expect($(".sched-panel").textContent).toContain(HOSTILE);
    expect(document.querySelector("img, b")).toBeNull();
  });

  it("answers an unknown event with a not-found message and a way back", async () => {
    await start({ getStatus: 404 });
    expect($("[role=alert]").textContent).toContain("We couldn't find that event");
    expect($$("a").some((a) => a.getAttribute("href") === "/admin/")).toBe(true);
  });

  it("does not call the server for a missing or malformed slug", async () => {
    for (const search of ["", "?slug=", "?slug=nope", `?slug=${"x".repeat(100)}`]) {
      const { calls } = await start({ search });
      expect(calls.map((c) => c.url), search).toEqual(["/api/admin/session"]);
      expect($("[role=alert]").textContent).toContain("We couldn't find that event");
    }
  });

  it("offers a retry when loading fails", async () => {
    await start({ getStatus: 500 });
    expect($("[role=alert]").textContent).toContain("We couldn't load the schedule");
    expect(button(document.body, "Retry")).toBeDefined();
  });
});

describe("Copy lineup", () => {
  it("writes the lineup from the loaded data synchronously, without fetching, and says Copied", async () => {
    const { calls, clipboard } = await start();
    const before = calls.length;
    button(document.body, "Copy lineup").click();
    expect(clipboard.writeText).toHaveBeenCalledTimes(1); // inside the click, before any await
    expect(clipboard.writeText).toHaveBeenCalledWith(LINEUP);
    await settle();
    expect(statusText()).toBe("Copied");
    expect($(".sched-status").getAttribute("aria-live")).toBe("polite");
    expect(calls).toHaveLength(before);
  });

  it("falls back to a selected read-only textarea when the clipboard rejects", async () => {
    await start({ clipboard: { writeText: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) } });
    button(document.body, "Copy lineup").click();
    await settle();
    const box = $("textarea") as HTMLTextAreaElement;
    expect(box.value).toBe(LINEUP);
    expect(box.hasAttribute("readonly")).toBe(true);
    expect(box.closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(LINEUP.length);
    expect(statusText()).toContain("Copy it from here");
  });

  it("falls back when there is no clipboard API", async () => {
    await start({ clipboard: undefined });
    button(document.body, "Copy lineup").click();
    await settle();
    expect(($("textarea") as HTMLTextAreaElement).value).toBe(LINEUP);
    expect(statusText()).toContain("Copy it from here");
  });
});

describe("Clear", () => {
  it("opens an inline confirmation naming the time, dog and handler, and sends nothing until the danger button is clicked", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "DELETE" ? reply(200, { removed: { ...REX, slotStart: S[1] } }) : undefined),
    });
    button(row("09:15"), "Clear").click();
    const panel = $(".sched-panel");
    expect(panel.textContent).toContain("09:15: Rex (Sam Smith)");
    expect(button(panel, "Clear booking").className).toContain("danger");
    expect(document.activeElement).toBe(button(panel, "Cancel")); // not the destructive button
    expect(writes(calls)).toEqual([]);
    button(panel, "Clear booking").click();
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/11`, method: "DELETE", body: { confirm: true } }]);
  });

  it("Cancel closes the panel, sends nothing and returns focus to Clear", async () => {
    const { calls } = await start();
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Cancel").click();
    expect($(".sched-panel")).toBeNull();
    expect(writes(calls)).toEqual([]);
    expect(calls).toHaveLength(2); // session and the first load only
    expect(document.activeElement).toBe(button(row("09:15"), "Clear"));
  });

  it("refreshes after success, shows the slot free, announces it and focuses the refreshed row", async () => {
    const { calls, setDetail } = await start({ respond: (c) => (c.method === "DELETE" ? reply(200, { removed: { ...REX, slotStart: S[1] } }) : undefined) });
    setDetail(detail([null, null, null, FLO, null]));
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(-2)).toEqual([`DELETE ${BASE}/bookings/11`, `GET ${BASE}`]);
    expect(row("09:15").querySelector(".sched-who")!.textContent).toBe("Free");
    expect($(".sched-panel")).toBeNull();
    expect(statusText()).toBe("Cleared Rex (Sam Smith) from 09:15.");
    expect(document.activeElement).toBe(row("09:15"));
  });

  it("clears an orphan, then focuses the live region because its row has gone", async () => {
    const { setDetail } = await start({ initial: detail(undefined, [LOST]), respond: (c) => (c.method === "DELETE" ? reply(200, { removed: LOST }) : undefined) });
    setDetail(detail());
    button($(".sched-orphans li"), "Clear").click();
    expect($(".sched-panel").textContent).toContain("Lost (Lou)");
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect($(".sched-orphans")).toBeNull();
    expect(document.activeElement).toBe($(".sched-status"));
  });

  it("says the booking has already gone, and refreshes, when it is a 404 (cleared twice)", async () => {
    const { calls } = await start({ respond: (c) => (c.method === "DELETE" ? reply(404, { error: { code: "not_found" } }) : undefined) });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(statusText()).toBe("That changed while you were working. The schedule has been refreshed.");
    expect(calls.at(-1)!.method).toBe("GET");
  });
});

describe("Move", () => {
  const moved = { booking: { ...REX, slotStart: S[4] } };

  it("lists only free slots, and needs a choice before it sends anything", async () => {
    const { calls } = await start();
    button(row("09:15"), "Move").click();
    expect(options($("select"))).toEqual(["09:00", "09:30", "10:30"]);
    submit($(".sched-panel"));
    expect($(".sched-panel .field-error").textContent).toBe("Choose a slot.");
    expect(writes(calls)).toEqual([]);
  });

  it("sends fromSlot and toSlot, refreshes and announces", async () => {
    const { calls, setDetail } = await start({ respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    setDetail(detail([null, null, null, FLO, REX]));
    button(row("09:15"), "Move").click();
    const select = $("select") as HTMLSelectElement;
    select.value = S[4];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/11/move`, method: "POST", body: { fromSlot: S[1], toSlot: S[4] } }]);
    expect(calls.at(-1)!.method).toBe("GET");
    expect(statusText()).toBe("Moved Rex (Sam Smith) from 09:15 to 10:30.");
    expect(row("10:30").querySelector(".sched-who")!.textContent).toBe("Rex (Sam Smith)");
    expect(document.activeElement).toBe(row("10:30"));
  });

  it("moves an orphan into a free slot, sending the orphan's own slot as fromSlot", async () => {
    const { calls } = await start({ initial: detail(undefined, [LOST]), respond: (c) => (c.method === "POST" ? reply(200, moved) : undefined) });
    button($(".sched-orphans li"), "Move").click();
    ($("select") as HTMLSelectElement).value = S[0];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)[0].body).toEqual({ fromSlot: LOST.slotStart, toSlot: S[0] });
  });

  it("says who holds a slot that was just taken, and refreshes", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, booking: { id: 99, dogName: "Zed", handlerName: "Zoe Zee" } }) : undefined),
    });
    button(row("09:15"), "Move").click();
    ($("select") as HTMLSelectElement).value = S[0];
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("That slot is already taken by Zed (Zoe Zee).");
    expect(calls.at(-1)!.method).toBe("GET");
    expect($(".sched-panel")).toBeNull();
    expect(document.activeElement).toBe($(".sched-status"));
  });

  it("says so when there is no free slot", async () => {
    await start({ initial: detail([REX, REX, REX, FLO, FLO]) });
    button(row("09:15"), "Move").click();
    expect($(".sched-panel").textContent).toContain("There are no free slots");
    expect($("select")).toBeNull();
  });
});

describe("Swap", () => {
  it("lists only the other booked slots", async () => {
    await start({ initial: detail([REX, FLO, null, { id: 14, dogName: "Cy", handlerName: "Dee" }, null]) });
    button(row("09:15"), "Swap").click();
    expect(options($("select"))).toEqual(["09:00: Rex (Sam Smith)", "10:15: Cy (Dee)"]);
  });

  it("sends both ids with the slots the admin saw, refreshes and announces", async () => {
    const { calls, setDetail } = await start({
      respond: (c) => (c.method === "POST" ? reply(200, { a: { id: 11, slotStart: S[3] }, b: { id: 12, slotStart: S[1] } }) : undefined),
    });
    setDetail(detail([null, FLO, null, REX, null]));
    button(row("09:15"), "Swap").click();
    expect(options($("select"))).toEqual(["10:15: Flo (Pat Jones)"]);
    ($("select") as HTMLSelectElement).value = S[3];
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings/swap`, method: "POST", body: { a: { id: 11, slot: S[1] }, b: { id: 12, slot: S[3] } } }]);
    expect(statusText()).toBe("Swapped Rex (09:15) with Flo (10:15).");
    expect(row("09:15").querySelector(".sched-who")!.textContent).toBe("Flo (Pat Jones)");
  });

  it("says so when there is nothing to swap with", async () => {
    await start({ initial: detail([null, REX, null, null, null]) });
    button(row("09:15"), "Swap").click();
    expect($(".sched-panel").textContent).toContain("There's no other booking to swap with");
  });
});

describe("Add booking", () => {
  it("opens a form for the slot, with focus in the dog field, and sends the names as typed", async () => {
    const { calls, setDetail } = await start({
      respond: (c) => (c.method === "POST" ? reply(201, { booking: { id: 30, slotStart: S[0], dogName: "Newt", handlerName: "Nan Ng" } }) : undefined),
    });
    setDetail(detail([{ id: 30, dogName: "Newt", handlerName: "Nan Ng" }, REX, null, FLO, null]));
    button(row("09:00"), "Add booking").click();
    expect(document.activeElement).toBe($("#add-dog"));
    expect($(".sched-panel h3").textContent).toBe("Add booking at 09:00");
    ($("#add-dog") as HTMLInputElement).value = "  Newt ";
    ($("#add-handler") as HTMLInputElement).value = "Nan Ng";
    submit($(".sched-panel"));
    await settle();
    expect(writes(calls)).toEqual([{ url: `${BASE}/bookings`, method: "POST", body: { slot: S[0], dogName: "  Newt ", handlerName: "Nan Ng" } }]);
    expect(statusText()).toBe("Added Newt (Nan Ng) at 09:00.");
    expect(row("09:00").querySelector(".sched-who")!.textContent).toBe("Newt (Nan Ng)");
    expect(document.activeElement).toBe(row("09:00"));
  });

  it("shows the server's messages against the right field and keeps what was typed", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST"
        ? reply(400, { error: { code: "invalid_input" }, fields: { dogName: "Enter the dog's name.", handlerName: "The handler's name must be at most 80 characters." } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    ($("#add-handler") as HTMLInputElement).value = "x";
    submit($(".sched-panel"));
    await settle();
    expect($("#add-dog-error").textContent).toBe("Enter the dog's name.");
    expect($("#add-handler-error").textContent).toBe("The handler's name must be at most 80 characters.");
    expect($("#add-dog").getAttribute("aria-invalid")).toBe("true");
    expect($("#add-dog").getAttribute("aria-describedby")).toBe("add-dog-error");
    expect(($("#add-handler") as HTMLInputElement).value).toBe("x");
    expect(document.activeElement).toBe($("#add-dog"));
    expect(calls.filter((c) => c.method === "GET" && c.url === BASE)).toHaveLength(1); // no refresh
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });

  it("says in plain English when the dog and handler already have a booking, with the time", async () => {
    await start({
      respond: (c) => (c.method === "POST"
        ? reply(409, { error: { code: "duplicate_booking" }, booking: { id: 11, slotStart: S[1], dogName: "Rex", handlerName: "Sam Smith" } })
        : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect($(".sched-panel .form-error").textContent).toBe("Rex and Sam Smith already have a booking at 09:15.");
    expect($(".sched-panel")).not.toBeNull();
  });

  it("says in plain English who holds a slot that was just taken, and refreshes", async () => {
    const { calls } = await start({
      respond: (c) => (c.method === "POST" ? reply(409, { error: { code: "slot_taken" }, booking: { id: 11, dogName: "Rex", handlerName: "Sam Smith" } }) : undefined),
    });
    button(row("09:00"), "Add booking").click();
    submit($(".sched-panel"));
    await settle();
    expect(statusText()).toBe("That slot is already taken by Rex (Sam Smith).");
    expect(calls.at(-1)!.method).toBe("GET");
    expect($(".sched-panel")).toBeNull();
  });

  it("returns focus to Add booking when cancelled", async () => {
    await start();
    button(row("09:00"), "Add booking").click();
    button($(".sched-panel"), "Cancel").click();
    expect(document.activeElement).toBe(button(row("09:00"), "Add booking"));
  });
});

describe("changes made while working, and requests in flight", () => {
  it("refreshes with the plain message on 409 changed and on 409 event_changed", async () => {
    for (const code of ["changed", "event_changed"]) {
      const { calls } = await start({ respond: (c) => (c.method === "POST" ? reply(409, { error: { code } }) : undefined) });
      button(row("09:15"), "Move").click();
      ($("select") as HTMLSelectElement).value = S[0];
      submit($(".sched-panel"));
      await settle();
      expect(statusText(), code).toBe("That changed while you were working. The schedule has been refreshed.");
      expect(calls.at(-1)!.method, code).toBe("GET");
      expect($(".sched-panel"), code).toBeNull();
      expect(document.activeElement, code).toBe($(".sched-status"));
    }
  });

  it("refreshes with the plain message on 400 invalid_slot from add, move and swap (an edit removed the slot)", async () => {
    const open: Record<string, () => void> = {
      add: () => { button(row("09:00"), "Add booking").click(); },
      move: () => { button(row("09:15"), "Move").click(); ($("select") as HTMLSelectElement).value = S[0]; },
      swap: () => { button(row("09:15"), "Swap").click(); ($("select") as HTMLSelectElement).value = S[3]; },
    };
    for (const kind of Object.keys(open)) {
      const { calls } = await start({
        respond: (c) => (c.method === "POST" ? reply(400, { error: { code: "invalid_slot", message: "That time isn't one of this event's slots." } }) : undefined),
      });
      open[kind]();
      submit($(".sched-panel"));
      await settle();
      expect(statusText(), kind).toBe("That changed while you were working. The schedule has been refreshed.");
      expect(calls.at(-1)!.method, kind).toBe("GET");
      expect($(".sched-panel"), kind).toBeNull();
      expect(document.activeElement, kind).toBe($(".sched-status"));
    }
  });

  it("disables every button while a request is in flight and ignores a second submit", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { release = r; });
    const { calls } = await start({ respond: (c) => (c.method === "DELETE" ? pending : undefined) });
    button(row("09:15"), "Clear").click();
    const confirm = button($(".sched-panel"), "Clear booking");
    confirm.click();
    await settle();
    expect($$<HTMLButtonElement>("button, select, input").every((el) => el.disabled)).toBe(true);
    confirm.click();
    button(row("09:00"), "Add booking").click();
    await settle();
    expect(writes(calls)).toHaveLength(1);
    release(reply(200, { removed: { ...REX, slotStart: S[1] } }));
    await settle();
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });

  it("re-enables everything and says so when the network fails", async () => {
    await start({ respond: (c) => { if (c.method === "DELETE") throw new TypeError("offline"); return undefined; } });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(statusText()).toContain("couldn't reach the server");
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
    expect($(".sched-panel")).not.toBeNull();
  });

  it("reports a refused action with the server's message when it is nothing it knows how to recover from", async () => {
    await start({ respond: (c) => (c.method === "DELETE" ? reply(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }) : undefined) });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(statusText()).toBe("Something went wrong. Please try again.");
    expect($$<HTMLButtonElement>("button").every((b) => !b.disabled)).toBe(true);
  });

  it("uses the shared session handling: a stale CSRF token gets one fresh session and one retry", async () => {
    let attempts = 0;
    const { calls } = await start({
      respond: (c) => {
        if (c.method !== "DELETE") return undefined;
        attempts += 1;
        return attempts === 1 ? reply(403, { error: { code: "csrf_failed" } }) : reply(200, { removed: { ...REX, slotStart: S[1] } });
      },
    });
    button(row("09:15"), "Clear").click();
    button($(".sched-panel"), "Clear booking").click();
    await settle();
    expect(calls.filter((c) => c.url === "/api/admin/session")).toHaveLength(2); // the first load, then the fresh one after csrf_failed
    expect(writes(calls)).toHaveLength(2);
    expect(statusText()).toContain("Cleared Rex");
  });
});

describe("Share", () => {
  // EVENT ends 2026-06-13T09:45:00Z: the clock is set to a moment before it, as only an event that has not ended is shared.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-06-13T07:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });
  const SHARE_EVENT = { ...EVENT, details: "Bring water", shareMessage: "", costPence: 1500 };
  const BUILT_IN = `Trial Day\nSaturday 13 June 2026, 09:00–10:45\nVenue: AB1 2CD\nCost: £15.00\nBook your slot:\nhttps://club.example/e/${SLUG}`;
  const withShare = () => ({ share: vi.fn(async () => {}) });
  const shareButton = () => $$("button").find((b) => b.textContent === "Share") as HTMLButtonElement | undefined;
  const withDetail = (event: unknown, defaultShareMessage?: string) => ({ ...detail(undefined, undefined, undefined, event), ...(defaultShareMessage === undefined ? {} : { defaultShareMessage }) });
  const sent = (share: ReturnType<typeof vi.fn>, n = 0) => (share.mock.calls[n][0] as { text: string }).text;

  it("sits under the date line, before the other actions", async () => {
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect(shareButton()!.getAttribute("aria-label")).toBe('Share "Trial Day"');
    expect($(".sched-date").nextElementSibling).toBe($(".share"));
    expect($(".share").nextElementSibling!.className).toBe("actions");
  });

  it("is absent for an archived event", async () => {
    await start({ navigator: withShare(), initial: withDetail({ ...SHARE_EVENT, archived: true }) });
    expect($$(".share")).toHaveLength(0);
    expect(shareButton()).toBeUndefined();
    expect($$("button").map((b) => b.textContent)).not.toContain("Copy message");
  });

  it("is absent once the event has ended, including at the very moment it ends, and present a millisecond before", async () => {
    vi.setSystemTime(new Date("2026-06-13T09:45:00Z"));
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect($$(".share")).toHaveLength(0);
    vi.setSystemTime(new Date("2026-06-14T00:00:00Z"));
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect($$(".share")).toHaveLength(0);
    vi.setSystemTime(new Date("2026-06-13T09:44:59.999Z"));
    await start({ navigator: withShare(), initial: withDetail(SHARE_EVENT) });
    expect($$(".share")).toHaveLength(1);
  });

  it("is absent when the event has no readable end", async () => {
    await start({ navigator: withShare(), initial: withDetail({ ...SHARE_EVENT, endUtc: undefined }) });
    expect($$(".share")).toHaveLength(0);
  });

  it("shares the built-in message, as text only, in the tap itself", async () => {
    const navigator = withShare();
    await start({ navigator, initial: withDetail(SHARE_EVENT) });
    shareButton()!.click();
    expect(navigator.share).toHaveBeenCalledTimes(1);
    expect(navigator.share.mock.calls[0]).toEqual([{ text: BUILT_IN }]);
  });

  it("prefers the event's own message, then the default template's, then the built-in one", async () => {
    const own = withShare();
    await start({ navigator: own, initial: withDetail({ ...SHARE_EVENT, shareMessage: "Own: {event} {details}" }, "Default: {event}") });
    shareButton()!.click();
    expect(sent(own.share)).toBe(`Own: Trial Day Bring water\nhttps://club.example/e/${SLUG}`);
    const def = withShare();
    await start({ navigator: def, initial: withDetail(SHARE_EVENT, "Default: {event} at {postcode}") });
    shareButton()!.click();
    expect(sent(def.share)).toBe(`Default: Trial Day at AB1 2CD\nhttps://club.example/e/${SLUG}`);
    const none = withShare();
    await start({ navigator: none, initial: withDetail(SHARE_EVENT, "") });
    shareButton()!.click();
    expect(sent(none.share)).toBe(BUILT_IN);
  });

  it("puts the club name first when the settings loaded with one", async () => {
    const navigator = withShare();
    await start({ navigator, initial: withDetail(SHARE_EVENT), settings: Promise.resolve({ clubName: "Hillside Dog Club", loaded: true }) });
    shareButton()!.click();
    expect(sent(navigator.share)).toBe(`Hillside Dog Club\n${BUILT_IN}`);
  });

  it("offers Copy message beside Share where navigator.share exists, and Copy link only as a fallback", async () => {
    const navigator = withShare();
    const { clipboard } = await start({ navigator, initial: withDetail(SHARE_EVENT) });
    expect($$(".share button").map((b) => [b.textContent, b.hidden])).toEqual([["Share", false], ["Copy message", false], ["Copy link", true]]);
    $$("button").find((b) => b.textContent === "Copy message")!.click();
    await settle();
    expect(clipboard.writeText).toHaveBeenCalledWith(BUILT_IN);
    expect(navigator.share).not.toHaveBeenCalled();
  });

  it("offers Copy message and Copy link where navigator.share is missing", async () => {
    const { clipboard } = await start({ navigator: {}, initial: withDetail(SHARE_EVENT) });
    expect(shareButton()).toBeUndefined();
    const copy = $$("button").find((b) => b.textContent === "Copy message")!;
    copy.click();
    await settle();
    expect(clipboard.writeText).toHaveBeenCalledWith(BUILT_IN);
    expect($(".share-status").textContent).toBe("Copied");
    expect($(".sched-status").textContent).toBe(""); // the page's own live region is left alone
  });

  it("builds the message from the event as it is after a refresh", async () => {
    const navigator = withShare();
    const ctx = await start({
      navigator, initial: withDetail({ ...SHARE_EVENT, shareMessage: "Before {event}" }),
      respond: (c) => (c.url.endsWith("/bookings") && c.method === "POST" ? reply(201, { booking: { id: 99, dogName: "Zed", handlerName: "Zoe" } }) : undefined),
    });
    shareButton()!.click();
    expect(sent(navigator.share, 0)).toBe(`Before Trial Day\nhttps://club.example/e/${SLUG}`);
    ctx.setDetail(withDetail({ ...SHARE_EVENT, name: "Renamed", shareMessage: "After {event}" }));
    button(row("09:00"), "Add booking").click();
    const form = $("form");
    (document.getElementById("add-dog") as HTMLInputElement).value = "Zed";
    (document.getElementById("add-handler") as HTMLInputElement).value = "Zoe";
    submit(form);
    await vi.waitFor(() => expect($(".event-name").textContent).toBe("Renamed"));
    shareButton()!.click();
    expect(sent(navigator.share, 1)).toBe(`After Renamed\nhttps://club.example/e/${SLUG}`);
    expect(shareButton()!.getAttribute("aria-label")).toBe('Share "Renamed"');
  });

  it("keeps a hostile name and details inert", async () => {
    const navigator = withShare();
    await start({
      navigator, clipboard: null,
      initial: withDetail({ ...SHARE_EVENT, name: HOSTILE, details: HOSTILE, shareMessage: "{event} {details}" }),
    });
    expect($$("img")).toHaveLength(0);
    expect(document.querySelector("[onerror]")).toBeNull();
    shareButton()!.click();
    expect(sent(navigator.share)).toBe(`${HOSTILE} ${HOSTILE}\nhttps://club.example/e/${SLUG}`);
  });
});
