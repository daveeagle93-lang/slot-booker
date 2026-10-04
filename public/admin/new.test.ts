// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./new.js";

const HOSTILE = "<img src=x onerror=alert(1)>";
const ORIGIN = "https://club.example";
const reply = (status: number, body: unknown = null) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const SESSION = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
const slots = (...starts: string[]) => starts.map((s) => ({ start: s, end: s }));
const SLOTS = slots("2026-06-13T08:00:00Z", "2026-06-13T08:20:00Z", "2026-06-13T08:40:00Z");
const preview = (extra: Record<string, unknown> = {}) => reply(200, { slots: SLOTS, suggestions: [], ...extra });
const suggestion = (breakIndex: number, suggestedStart = "11:50") => ({
  breakIndex, droppedSlot: { start: "2026-06-13T10:45:00Z", end: "2026-06-13T11:00:00Z" },
  overrunMinutes: 5, suggestedBreak: { start: "x", end: "y" }, suggestedLocal: { start: suggestedStart, end: "12:10" },
});
const CREATED = {
  event: {
    slug: "abc123", name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z",
    sessionMinutes: 15, gapMinutes: 5, costPence: 1250, venuePostcode: "SW1A 1AA", details: "",
  },
  path: "/e/abc123", slotCount: 21,
};

type Call = { url: string; init?: RequestInit; body?: any };
type Handler = (call: Call) => Response | Promise<Response>;
const PREVIEW = "/api/admin/events/preview";
const CREATE = "/api/admin/events";

async function start(opts: { preview?: Handler; create?: Handler; clipboard?: unknown } = {}) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const navigate = vi.fn();
  const clipboard = opts.clipboard === undefined ? { writeText: vi.fn(async () => {}) } : opts.clipboard;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (url === "/api/admin/session") return reply(200, SESSION);
    if (url === PREVIEW) return (opts.preview ?? (() => preview()))(call);
    if (url === CREATE) return (opts.create ?? (() => reply(201, CREATED)))(call);
    throw new Error(`unexpected ${url}`);
  });
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, navigate, location: { origin: ORIGIN },
    clipboard: clipboard as never,
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
const fillSchedule = () => {
  set("date", "2026-06-13"); set("start", "09:00"); set("end", "16:00"); set("session", "15"); set("gap", "5");
};
const fillAll = () => {
  fillSchedule();
  set("name", "Trial Day"); set("cost", "12.50"); set("postcode", "sw1a 1aa");
};
const buttonNamed = (name: string) => $$("button").find((b) => b.textContent === name)!;
const rowInputs = (n: number) => ({
  start: input(`break-${n}-start`), end: input(`break-${n}-end`),
});
const setRow = (n: number, start: string, end: string) => {
  const r = rowInputs(n);
  for (const [el, v] of [[r.start, start], [r.end, end]] as const) {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
};
const settle = () => vi.advanceTimersByTimeAsync(300);
const tick = () => vi.advanceTimersByTimeAsync(0);
const submit = () => $("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const text = () => document.body.textContent ?? "";
const chips = () => $$(".chips li").map((li) => li.textContent);
const errorOf = (id: string) => document.getElementById(`${id}-error`)!.textContent;
const previewCalls = (calls: Call[]) => calls.filter((c) => c.url === PREVIEW);
const PLACEHOLDER = "Fill in the highlighted fields to see the schedule.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("form", () => {
  it("has labelled, large, mobile-friendly controls", async () => {
    await start();
    const labels = $$("label").map((l) => l.textContent);
    expect(labels).toEqual([
      "Event name", "Date", "Start time", "End time", "Session length (minutes)", "Gap between sessions (minutes)",
      "Cost (£)", "Venue postcode", "Details (optional)",
    ]);
    for (const label of $$("label")) expect(document.getElementById(label.getAttribute("for")!)).not.toBeNull();
    expect(input("date").type).toBe("date");
    expect(input("start").type).toBe("time");
    expect(input("end").type).toBe("time");
    expect(input("session").type).toBe("number");
    expect(input("session").getAttribute("inputmode")).toBe("numeric");
    expect(input("session").min).toBe("1");
    expect(input("session").step).toBe("1");
    expect(input("gap").min).toBe("0");
    expect(input("cost").getAttribute("inputmode")).toBe("decimal");
    expect(input("details").tagName).toBe("TEXTAREA");
    expect(text()).toContain("You can't edit an event after saving yet, so check the details.");
    expect(buttonNamed("Save event")).toBeDefined();
    expect($("form").hasAttribute("novalidate")).toBe(true);
  });

  it("sends the browser to login without a session", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const navigate = vi.fn();
    const fetch = vi.fn(async () => reply(401));
    await init({ document, fetch: fetch as never, navigate, location: { origin: ORIGIN }, clipboard: null as never });
    expect(navigate).toHaveBeenCalledWith("/admin/login");
    expect(document.querySelector("form")).toBeNull();
  });
});

describe("live preview", () => {
  it("shows the placeholder and makes no call until the required fields are filled", async () => {
    const { calls } = await start();
    expect($(".preview [aria-live=polite]").textContent).toContain(PLACEHOLDER);
    for (const [id, value] of [["date", "2026-06-13"], ["start", "09:00"], ["end", "16:00"], ["session", "15"]] as const) {
      set(id, value);
      await settle();
      expect(previewCalls(calls)).toHaveLength(0);
    }
    set("gap", "5");
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body).toMatchObject({
      date: "2026-06-13", start: "09:00", end: "16:00", sessionMinutes: 15, gapMinutes: 5, breaks: [],
    });
    expect(previewCalls(calls)[0].init?.method).toBe("POST");
    expect((previewCalls(calls)[0].init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
  });

  it("does not preview for a non-integer session length", async () => {
    const { calls } = await start();
    fillSchedule();
    set("session", "1.5");
    await settle();
    expect(previewCalls(calls)).toHaveLength(0);
  });

  it("shows the slot count and London start times in a polite live region", async () => {
    await start();
    fillSchedule();
    await settle();
    const live = $(".preview [aria-live=polite]");
    expect(live.textContent).toContain("3 slots");
    expect(chips()).toEqual(["09:00", "09:20", "09:40"]);
    expect(live.contains($(".chips"))).toBe(true);
  });

  it("says 1 slot for one slot", async () => {
    await start({ preview: () => reply(200, { slots: slots("2026-01-17T09:00:00Z"), suggestions: [] }) });
    fillSchedule();
    await settle();
    expect($(".preview-summary").textContent).toBe("1 slot");
    expect(chips()).toEqual(["09:00"]);
  });

  it("debounces rapid input into one call", async () => {
    const { calls } = await start();
    fillSchedule();
    for (const v of ["1", "12", "120", "15"]) {
      set("session", v);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(previewCalls(calls)).toHaveLength(0);
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body.sessionMinutes).toBe(15);
  });

  it("aborts the in-flight request and ignores a stale response", async () => {
    const pending: ((r: Response) => void)[] = [];
    const { calls } = await start({ preview: () => new Promise<Response>((resolve) => { pending.push(resolve); }) });
    fillSchedule();
    await settle();
    expect(pending).toHaveLength(1);
    const first = previewCalls(calls)[0].init!.signal!;
    set("gap", "10");
    expect(first.aborted).toBe(true);
    await settle();
    expect(pending).toHaveLength(2);
    // The newer response arrives first, then the stale one
    pending[1](reply(200, { slots: slots("2026-06-13T08:00:00Z", "2026-06-13T08:25:00Z"), suggestions: [] }));
    await tick();
    pending[0](reply(200, { slots: slots("2026-06-13T08:00:00Z"), suggestions: [] }));
    await tick();
    expect(chips()).toEqual(["09:00", "09:25"]);
  });

  it("ignores a response that arrives after the draft became invalid", async () => {
    const pending: ((r: Response) => void)[] = [];
    await start({ preview: () => new Promise<Response>((resolve) => { pending.push(resolve); }) });
    fillSchedule();
    await settle();
    set("date", "");
    pending[0](preview());
    await tick();
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toBe(PLACEHOLDER);
  });

  it("clears the previous slots when the draft becomes invalid", async () => {
    const { calls } = await start();
    fillSchedule();
    await settle();
    expect(chips()).toHaveLength(3);
    set("end", "");
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toBe(PLACEHOLDER);
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
  });

  it("clears slots when the server rejects the draft, and shows its errors on touched fields", async () => {
    await start({
      preview: (c) => c.body.end === "08:00"
        ? reply(400, { error: { code: "invalid_input", message: "x" }, fields: { end: "The end must be after the start." } })
        : preview(),
    });
    fillSchedule();
    await settle();
    expect(chips()).toHaveLength(3);
    set("end", "08:00");
    await settle();
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toBe(PLACEHOLDER);
    expect(errorOf("end")).toBe("The end must be after the start.");
    expect(input("end").getAttribute("aria-invalid")).toBe("true");
    expect(input("end").getAttribute("aria-describedby")).toBe("end-error");
    // fixing the field clears the error at once
    set("end", "16:00");
    expect(errorOf("end")).toBe("");
    expect(input("end").hasAttribute("aria-invalid")).toBe(false);
  });

  it("shows a message when the preview request fails, with no stale slots", async () => {
    let fail = false;
    await start({ preview: () => (fail ? reply(500, null) : preview()) });
    fillSchedule();
    await settle();
    fail = true;
    set("gap", "10");
    await settle();
    expect(chips()).toEqual([]);
    expect($(".preview-summary").textContent).toContain("couldn't update the preview");
  });
});

describe("breaks", () => {
  it("adds and removes rows, numbering them, and re-previews on removal", async () => {
    const { calls } = await start();
    fillSchedule();
    await settle();
    buttonNamed("Add break").click();
    buttonNamed("Add break").click();
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1", "Break 2"]);
    expect(document.activeElement).toBe(rowInputs(2).start);
    setRow(2, "12:00", "12:20");
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "12:00", end: "12:20" }]);
    const removes = $$(".break-row button");
    expect(removes[0].getAttribute("aria-label")).toBe("Remove break 1");
    removes[0].click();
    expect($$(".break-row legend").map((l) => l.textContent)).toEqual(["Break 1"]);
    expect(document.activeElement).toBe(buttonNamed("Add break"));
    const before = previewCalls(calls).length;
    await settle();
    expect(previewCalls(calls)).toHaveLength(before + 1);
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "12:00", end: "12:20" }]);
  });

  it("ignores blank rows but waits for half-filled rows", async () => {
    const { calls } = await start();
    fillSchedule();
    buttonNamed("Add break").click();
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    expect(previewCalls(calls)[0].body.breaks).toEqual([]);
    setRow(1, "12:00", "");
    expect(chips()).toEqual([]);
    await settle();
    expect(previewCalls(calls)).toHaveLength(1);
    setRow(1, "12:00", "12:20");
    await settle();
    expect(previewCalls(calls)).toHaveLength(2);
  });

  it("maps a suggestion's payload index to the right row when a blank row precedes it", async () => {
    const { calls } = await start({
      preview: (c) => preview({ suggestions: c.body.breaks.length === 2 ? [suggestion(1)] : [] }),
    });
    fillSchedule();
    for (let i = 0; i < 3; i++) buttonNamed("Add break").click();
    setRow(2, "10:00", "10:20");
    setRow(3, "12:00", "12:20"); // payload index 1; row 1 is blank
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "10:00", end: "10:20" }, { start: "12:00", end: "12:20" }]);
    const card = $(".suggestion");
    expect(card.textContent).toContain("Move the 12:00–12:20 break to 11:50–12:10 to keep the 11:45 session?");
    buttonNamed("Move break").click();
    expect(rowInputs(3).start.value).toBe("11:50");
    expect(rowInputs(3).end.value).toBe("12:10");
    expect(rowInputs(2).start.value).toBe("10:00");
    expect(rowInputs(1).start.value).toBe("");
    expect($$(".suggestion")).toHaveLength(0);
    await settle();
    expect(previewCalls(calls).at(-1)!.body.breaks).toEqual([{ start: "10:00", end: "10:20" }, { start: "11:50", end: "12:10" }]);
  });

  it("offers Move break and Keep as it is as large buttons, and re-previews on accept", async () => {
    const { calls } = await start({ preview: (c) => preview({ suggestions: c.body.breaks[0]?.start === "12:00" ? [suggestion(0)] : [] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect($$(".suggestion button").map((b) => b.textContent)).toEqual(["Move break", "Keep as it is"]);
    expect($(".suggestion").compareDocumentPosition($(".chips")) & 4).toBeTruthy(); // suggestions come before the slots
    const n = previewCalls(calls).length;
    buttonNamed("Move break").click();
    await settle();
    expect(previewCalls(calls)).toHaveLength(n + 1);
    expect($$(".suggestion")).toHaveLength(0);
  });

  it("keeps a declined suggestion hidden for the same inputs, and raises a changed one", async () => {
    let suggestedStart = "11:50";
    await start({ preview: () => preview({ suggestions: [suggestion(0, suggestedStart)] }) });
    fillSchedule();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect($$(".suggestion")).toHaveLength(1);
    buttonNamed("Keep as it is").click();
    expect($$(".suggestion")).toHaveLength(0);
    set("gap", "5"); // same value, another preview
    set("session", "15");
    await settle();
    expect($$(".suggestion")).toHaveLength(0);
    suggestedStart = "11:45";
    set("session", "16");
    await settle();
    expect($$(".suggestion")).toHaveLength(1);
    expect($(".suggestion").textContent).toContain("to 11:45–12:10");
  });

  it("shows break errors on the right inputs, mapping payload indexes to rows", async () => {
    await start({
      preview: () => reply(400, {
        error: { code: "invalid_input", message: "x" },
        fields: { "breaks.1.end": "The break must end after it starts.", "breaks.0.start": "The break must start within the event." },
      }),
    });
    fillSchedule();
    for (let i = 0; i < 3; i++) buttonNamed("Add break").click();
    setRow(2, "07:00", "07:20"); // payload index 0
    setRow(3, "12:20", "12:00"); // payload index 1
    await settle();
    expect(errorOf("break-2-start")).toBe("The break must start within the event.");
    expect(errorOf("break-3-end")).toBe("The break must end after it starts.");
    expect(rowInputs(3).end.getAttribute("aria-invalid")).toBe("true");
    expect(rowInputs(3).end.getAttribute("aria-describedby")).toBe("break-3-end-error");
    expect(errorOf("break-1-start")).toBe("");
    expect(errorOf("break-2-end")).toBe("");
    expect(errorOf("break-3-start")).toBe("");
  });
});

describe("saving", () => {
  it("sends the exact JSON: pence, HH:MM, trimmed", async () => {
    const { calls } = await start();
    fillAll();
    set("name", "  Trial Day  ");
    set("postcode", "  SW1A 1AA ");
    set("details", "  Bring water.  ");
    buttonNamed("Add break").click();
    buttonNamed("Add break").click();
    setRow(2, "12:00", "12:20");
    submit();
    await tick();
    const create = calls.find((c) => c.url === CREATE)!;
    expect(create.init?.method).toBe("POST");
    expect(create.init?.headers).toEqual({ "Content-Type": "application/json", "X-CSRF-Token": "tok" });
    expect(create.body).toEqual({
      name: "Trial Day", date: "2026-06-13", start: "09:00", end: "16:00", sessionMinutes: 15, gapMinutes: 5,
      costPence: 1250, venuePostcode: "SW1A 1AA", details: "Bring water.", breaks: [{ start: "12:00", end: "12:20" }],
    });
  });

  it("sends 0 pence for a free event", async () => {
    const { calls } = await start();
    fillAll();
    set("cost", "0");
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)!.body.costPence).toBe(0);
  });

  it("disables Save while pending and creates only once", async () => {
    let finish!: (r: Response) => void;
    const { calls } = await start({ create: () => new Promise<Response>((resolve) => { finish = resolve; }) });
    fillAll();
    const save = buttonNamed("Save event") as HTMLButtonElement;
    submit();
    await tick();
    expect(save.disabled).toBe(true);
    expect($(".progress").textContent).toBe("Saving the event…");
    submit();
    save.click();
    await tick();
    expect(calls.filter((c) => c.url === CREATE)).toHaveLength(1);
    finish(reply(201, CREATED));
    await tick();
    expect($("h1").textContent).toBe("Event created");
  });

  it("blocks an invalid cost locally and focuses it", async () => {
    const { calls } = await start();
    fillAll();
    set("cost", "12.505");
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)).toBeUndefined();
    expect(errorOf("cost")).toBe("Use two decimal places at most, for example 12.50.");
    expect(document.activeElement).toBe(input("cost"));
    set("cost", "");
    expect(errorOf("cost")).toBe("Enter the cost in pounds, or 0 if it's free.");
  });

  it("shows server field errors for all fields after a save attempt and focuses the first", async () => {
    await start({
      create: () => reply(400, {
        error: { code: "invalid_input", message: "Check the highlighted fields." },
        fields: {
          venuePostcode: "Enter a venue postcode of 2 to 10 letters and numbers.", name: "Enter the event name.",
          "breaks.1.end": "The break must end within the event.",
        },
      }),
    });
    fillAll();
    for (let i = 0; i < 3; i++) buttonNamed("Add break").click();
    setRow(2, "10:00", "10:20");
    setRow(3, "12:00", "17:00");
    set("name", "");
    submit();
    await tick();
    expect(errorOf("name")).toBe("Enter the event name.");
    expect(errorOf("postcode")).toBe("Enter a venue postcode of 2 to 10 letters and numbers.");
    expect(errorOf("break-3-end")).toBe("The break must end within the event.");
    expect(errorOf("break-2-end")).toBe("");
    expect(document.activeElement).toBe(input("name"));
    expect(($("#name-error") as HTMLElement).getAttribute("role")).toBe("alert");
    expect((buttonNamed("Save event") as HTMLButtonElement).disabled).toBe(false);
    expect($("form")).not.toBeNull();
  });

  it("focuses a break error when it is the first", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input", message: "x" }, fields: { "breaks.0.end": "Bad." } }) });
    fillAll();
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    submit();
    await tick();
    expect(document.activeElement).toBe(rowInputs(1).end);
  });

  it("keeps the form and offers a retry after a server error", async () => {
    let fail = true;
    const { calls } = await start({ create: () => (fail ? reply(500, { error: { code: "internal_error", message: "x" } }) : reply(201, CREATED)) });
    fillAll();
    set("details", "Keep me");
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    expect($(".form-error").getAttribute("role")).toBe("alert");
    expect(input("name").value).toBe("Trial Day");
    expect(input("details").value).toBe("Keep me");
    const save = buttonNamed("Save event") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fail = false;
    submit();
    await tick();
    expect($("h1").textContent).toBe("Event created");
    expect(calls.filter((c) => c.url === CREATE)).toHaveLength(2);
  });

  it("keeps the form after a network failure", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const fetch = vi.fn(async (url: string) => {
      if (url === "/api/admin/session") return reply(200, SESSION);
      throw new TypeError("offline");
    });
    await init({ document, fetch: fetch as never, navigate: vi.fn(), location: { origin: ORIGIN }, clipboard: null as never });
    fillAll();
    submit();
    await tick();
    expect($(".form-error").textContent).toContain("couldn't save the event");
    expect(document.querySelector("form")).not.toBeNull();
  });
});

describe("created view", () => {
  async function create(opts: Parameters<typeof start>[0] = {}) {
    const ctx = await start(opts);
    fillAll();
    submit();
    await tick();
    return ctx;
  }

  it("replaces the form with the link, WhatsApp message and next steps, focusing the heading", async () => {
    await create();
    expect(document.querySelector("form")).toBeNull();
    expect($("h1").textContent).toBe("Event created");
    expect(document.activeElement).toBe($("h1"));
    expect(input("booking-link").value).toBe("https://club.example/e/abc123");
    expect(input("booking-link").readOnly).toBe(true);
    const message = input("whatsapp-text").value;
    expect(message).toBe(
      "Trial Day\nSaturday 13 June 2026, 09:00–16:00\nVenue: SW1A 1AA\nCost: £12.50\nBook your slot: https://club.example/e/abc123",
    );
    expect(input("whatsapp-text").readOnly).toBe(true);
    const wa = $$("a").find((a) => a.textContent === "Open in WhatsApp")!;
    expect(wa.getAttribute("href")).toBe(`https://wa.me/?text=${encodeURIComponent(message)}`);
    expect(wa.getAttribute("target")).toBe("_blank");
    expect(wa.getAttribute("rel")).toBe("noopener noreferrer");
    expect($$("a").find((a) => a.textContent === "Create another")!.getAttribute("href")).toBe("/admin/new");
    expect($$("a").find((a) => a.textContent === "Back to events")!.getAttribute("href")).toBe("/admin/");
  });

  it("copies the link and the message", async () => {
    const { clipboard } = await create();
    buttonNamed("Copy link").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith("https://club.example/e/abc123");
    expect($(".copy-status").textContent).toBe("Copied");
    buttonNamed("Copy message").click();
    await tick();
    expect(clipboard.writeText).toHaveBeenLastCalledWith(input("whatsapp-text").value);
    await vi.advanceTimersByTimeAsync(2100);
    expect($(".copy-status").textContent).toBe("");
  });

  it("selects the field and asks for a manual copy when the clipboard fails", async () => {
    await create({ clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    buttonNamed("Copy message").click();
    await tick();
    const area = input("whatsapp-text");
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(area.value.length);
    expect($(".copy-status").textContent).toContain("manually");
    buttonNamed("Copy link").click();
    await tick();
    expect(document.activeElement).toBe(input("booking-link"));
  });
});

describe("hostile text", () => {
  it("stays inert in the form, the preview, the errors and the created view", async () => {
    const { calls } = await start({
      create: (c) => reply(201, { ...CREATED, event: { ...CREATED.event, name: c.body.name, details: c.body.details } }),
    });
    fillAll();
    set("name", HOSTILE);
    set("details", HOSTILE);
    buttonNamed("Add break").click();
    setRow(1, "12:00", "12:20");
    await settle();
    expect(document.querySelector("img")).toBeNull();
    expect(input("name").value).toBe(HOSTILE);
    submit();
    await tick();
    expect(calls.find((c) => c.url === CREATE)!.body.name).toBe(HOSTILE);
    expect(document.querySelector("img")).toBeNull();
    expect($(".event-name").textContent).toBe(HOSTILE);
    expect(document.body.innerHTML).not.toContain("<img");
  });

  it("stays inert in server error messages", async () => {
    await start({ create: () => reply(400, { error: { code: "invalid_input", message: HOSTILE }, fields: { name: HOSTILE, nothing: HOSTILE } }) });
    fillAll();
    submit();
    await tick();
    expect(document.querySelector("img")).toBeNull();
    expect(errorOf("name")).toBe(HOSTILE);
    expect($(".form-error").textContent).toBe(HOSTILE);
  });
});
