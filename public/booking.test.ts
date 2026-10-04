// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./booking.js";

const SLUG = "abcdefghijklmnop";
const EVENT = {
  slug: SLUG, name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z",
  costPence: 1500, venuePostcode: "SW1A 1AA", details: "Bring water.\nBe kind.", archived: false,
};
const slot = (start: string, end: string, status: "free" | "taken" = "free") => ({ start, end, status });
const SLOTS = [
  slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "taken"),
  slot("2026-06-13T08:20:00Z", "2026-06-13T08:35:00Z"),
  slot("2026-06-13T08:40:00Z", "2026-06-13T08:55:00Z"),
  slot("2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z"),
];
const ICS_URL = "/api/events/abc/bookings/tok0123456789abcdef01/ics";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const getOk = (event = EVENT, slots: unknown[] = SLOTS) => reply(200, { event, slots });
const created = () => reply(201, {
  booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, dogName: "Biscuit", handlerName: "Ann Lee" },
  event: EVENT, icsUrl: ICS_URL,
});

type Call = { url: string; init?: RequestInit };
type Handler = (call: Call) => Response | Promise<Response>;

async function start(handler: Handler, pathname = `/e/${SLUG}`) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  const clipboard = { writeText: vi.fn(async () => {}) };
  await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, location: { pathname }, clipboard });
  return { calls, clipboard };
}

const routes = (post: Handler, get: Handler = () => getOk()): Handler => (call) =>
  call.init?.method === "POST" ? post(call) : get(call);

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const slotButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".slot-grid button")];
const slotButton = (time: string) => slotButtons().find((b) => b.textContent === time)!;
const form = () => $("#booking-form") as HTMLFormElement;
const type = (sel: string, value: string) => {
  const input = $(sel) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = () => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const fill = (dog = "Biscuit", handler = "Ann Lee") => {
  type("#dog-name", dog);
  type("#handler-name", handler);
};
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  // scrollIntoView is not implemented by happy-dom
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("loading and slots", () => {
  it("fetches the event uncached and renders free slots only", async () => {
    const { calls } = await start(routes(() => created()));
    expect(calls[0].url).toBe(`/api/events/${SLUG}`);
    expect(calls[0].init?.cache).toBe("no-store");
    expect(slotButtons().map((b) => b.textContent)).toEqual(["09:20", "09:40", "10:00"]);
    expect(slotButton("09:20").getAttribute("aria-label")).toBe("Book 09:20 slot");
    expect(text()).toContain("3 slots left");
  });

  it("renders the event header in London time", async () => {
    await start(routes(() => created()));
    expect($("h1").textContent).toBe("Trial Day");
    expect(text()).toContain("Saturday 13 June 2026");
    expect(text()).toContain("09:00–16:00");
    expect(text()).toContain("£15.00");
    const maps = document.querySelector<HTMLAnchorElement>("a[href^='https://www.google.com/maps/']")!;
    expect(maps.textContent).toBe("SW1A 1AA");
    expect(maps.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=SW1A%201AA");
    expect(maps.getAttribute("target")).toBe("_blank");
    expect(maps.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says fully booked when nothing is free", async () => {
    await start(routes(() => created(), () => getOk(EVENT, [SLOTS[0]])));
    expect(slotButtons()).toHaveLength(0);
    expect(text()).toContain("Fully booked");
  });

  it("shows the form only after a slot is picked", async () => {
    await start(routes(() => created()));
    expect(form().hidden).toBe(true);
    slotButton("09:40").click();
    expect(form().hidden).toBe(false);
    expect(slotButton("09:40").getAttribute("aria-pressed")).toBe("true");
    expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("false");
    expect(form().textContent).toContain("Booking 09:40");
    expect(form().querySelector("button[type=submit]")!.textContent).toBe("Confirm booking for 09:40");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("closed and missing events", () => {
  it("shows not-found for a 404", async () => {
    await start(() => reply(404, { error: { code: "not_found", message: "Event not found" } }));
    expect(text()).toContain("We couldn't find that event. Check the link you were sent.");
    expect(document.querySelector(".slot-grid")).toBeNull();
  });

  it("shows not-found without calling the API for a bad path", async () => {
    const { calls } = await start(() => getOk(), "/e/");
    expect(calls).toHaveLength(0);
    expect(text()).toContain("We couldn't find that event.");
  });

  it("shows the header and a closed message for archived events", async () => {
    await start(() => getOk({ ...EVENT, archived: true }, []));
    expect($("h1").textContent).toBe("Trial Day");
    expect(text()).toContain("Bookings for this event are closed.");
    expect(document.querySelector("form")).toBeNull();
  });

  it("offers retry after a network error", async () => {
    let fail = true;
    await start(() => {
      if (fail) throw new TypeError("offline");
      return getOk();
    });
    expect(slotButtons()).toHaveLength(0);
    fail = false;
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click();
    await vi.waitFor(() => expect(slotButtons()).toHaveLength(3));
  });
});

describe("booking", () => {
  it("posts the booking and shows the confirmation", async () => {
    const { calls } = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));

    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe(`/api/events/${SLUG}/bookings`);
    expect((post.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.init!.body as string)).toEqual({ slot: SLOTS[1].start, dogName: "Biscuit", handlerName: "Ann Lee" });

    expect(text()).toContain("Biscuit");
    expect(text()).toContain("Ann Lee");
    expect(text()).toContain("09:20");
    expect(text()).toContain("Saturday 13 June 2026");
    expect(text()).toContain("SW1A 1AA");
    expect(text()).toContain("£15.00");
    expect(text()).toContain("Bring water.");
    const cal = [...document.querySelectorAll("a")].find((a) => a.textContent === "Add to calendar")!;
    expect(cal.getAttribute("href")).toBe(ICS_URL);
    expect(cal.hasAttribute("download")).toBe(false);
    expect(slotButtons()).toHaveLength(0);
  });

  it("sends names as typed", async () => {
    const { calls } = await start(routes(() => created()));
    slotButton("09:20").click();
    fill("  Biscuit ", "ann  lee");
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    const body = JSON.parse(calls.find((c) => c.init?.method === "POST")!.init!.body as string);
    expect(body.dogName).toBe("  Biscuit ");
    expect(body.handlerName).toBe("ann  lee");
  });

  it("disables the button while pending and never double-posts", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { resolve = r; });
    const { calls } = await start(routes(() => pending));
    slotButton("09:20").click();
    fill();
    submit();
    submit();
    const button = form().querySelector("button[type=submit]") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect($(".progress").textContent).toBe("Confirming your booking…");
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    resolve(created());
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  });

  it("replaces the slot list from the 409 payload and keeps the typed names", async () => {
    const freeSlots = [{ start: SLOTS[3].start, end: SLOTS[3].end }];
    const { calls } = await start(routes(() => reply(409, {
      error: { code: "slot_taken", message: "That slot's just gone." }, freeSlots,
    })));
    slotButton("09:20").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That slot's just gone."));

    expect($("#notice").getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe($("#notice"));
    expect(slotButtons().map((b) => b.textContent)).toEqual(["10:00"]);
    expect(slotButtons()[0].getAttribute("aria-pressed")).toBe("false");
    expect(text()).toContain("1 slot left");
    expect(form().hidden).toBe(true);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#handler-name") as HTMLInputElement).value).toBe("Ann Lee");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(1); // no refetch

    slotButton("10:00").click();
    expect(form().hidden).toBe(false);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
  });

  it("shows fully booked when the 409 payload has no free slots", async () => {
    await start(routes(() => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [] })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(slotButtons()).toHaveLength(0));
    expect(text()).toContain("Fully booked");
  });

  it("shows the duplicate_booking message and keeps inputs and selection", async () => {
    await start(routes(() => reply(409, {
      error: { code: "duplicate_booking", message: "That dog and handler already have a booking for this event." },
    })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("already have a booking"));
    expect(form().hidden).toBe(false);
    expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("true");
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
    expect((form().querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows field errors for invalid_input", async () => {
    await start(routes(() => reply(400, {
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { dogName: "Enter your dog's name." },
    })));
    slotButton("09:20").click();
    fill("Biscuit", "Ann");
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Enter your dog's name."));
    const dog = $("#dog-name");
    expect(dog.getAttribute("aria-invalid")).toBe("true");
    const err = document.getElementById(dog.getAttribute("aria-describedby")!.split(" ")[0])!;
    expect(err.textContent).toBe("Enter your dog's name.");
    expect($("#handler-name").getAttribute("aria-invalid")).not.toBe("true");
  });

  it("refetches on invalid_slot", async () => {
    let gets = 0;
    const { calls } = await start(routes(
      () => reply(400, { error: { code: "invalid_slot", message: "x" } }),
      () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0], SLOTS[1], SLOTS[2]])),
    ));
    slotButton("10:00").click();
    fill();
    submit();
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:20", "09:40"]));
    expect($("#notice").textContent).toContain("That slot isn't available any more.");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
    expect(form().hidden).toBe(true);
  });

  it("switches to the closed state on 410", async () => {
    await start(routes(() => reply(410, { error: { code: "event_archived", message: "closed" } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(text()).toContain("Bookings for this event are closed."));
    expect(document.querySelector("form")).toBeNull();
  });

  it.each([
    ["a server error", () => reply(500, { error: { code: "internal_error", message: "boom" } })],
    ["a network error", () => { throw new TypeError("offline"); }],
  ])("keeps everything after %s", async (_name, fail) => {
    const { calls } = await start(routes(fail as Handler));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
    expect(form().hidden).toBe(false);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
    expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("true");
    const button = form().querySelector("button[type=submit]") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    submit(); // can retry
    await vi.waitFor(() => expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2));
  });
});

describe("confirmation actions", () => {
  async function confirmed() {
    const ctx = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    return ctx;
  }
  const copyButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy booking")!;

  it("copies a plain-text summary and reverts the confirmation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clipboard } = await confirmed();
    copyButton().click();
    await vi.waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("Copied"));
    expect(clipboard.writeText).toHaveBeenCalledWith(
      "Trial Day\nSaturday 13 June 2026, 09:20–09:35\nDog: Biscuit\nHandler: Ann Lee\nVenue: SW1A 1AA\nCost: £15.00\nBring water.\nBe kind.",
    );
    vi.advanceTimersByTime(2100);
    expect(document.querySelector("[aria-live]")!.textContent).toBe("");
  });

  it("falls back to execCommand when the clipboard API is unavailable", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    const calls: Call[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return init?.method === "POST" ? created() : getOk();
    };
    await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, location: { pathname: `/e/${SLUG}` }, clipboard: undefined });
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    copyButton().click();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    expect(document.querySelector("textarea")).toBeNull(); // temporary textarea removed
    await vi.waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("Copied"));
  });
});

describe("text safety", () => {
  const evil = "<img src=x onerror=alert(1)>";

  it("renders event fields as text", async () => {
    await start(routes(() => created(), () => getOk({
      ...EVENT, name: evil, details: "<b>bold</b>\n<script>alert(1)</script>", venuePostcode: "<i>x</i>",
    })));
    expect(document.querySelector("img, b, i, script")).toBeNull();
    expect($("h1").textContent).toBe(evil);
    expect(text()).toContain("<b>bold</b>");
    expect(text()).toContain("<script>alert(1)</script>");
  });

  it("renders names and details in the confirmation as text", async () => {
    await start(routes(() => reply(201, {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, dogName: evil, handlerName: "<u>me</u>" },
      event: { ...EVENT, details: "<b>hi</b>" }, icsUrl: ICS_URL,
    })));
    slotButton("09:20").click();
    fill(evil, "<u>me</u>");
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(document.querySelector("img, b, u, script")).toBeNull();
    expect(text()).toContain(evil);
    expect(text()).toContain("<b>hi</b>");
  });

  it("renders server messages as text", async () => {
    await start(routes(() => reply(409, { error: { code: "duplicate_booking", message: evil } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain(evil));
    expect(document.querySelector("img")).toBeNull();
  });
});
