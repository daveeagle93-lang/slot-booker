// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRIVACY_NOTICE } from "../src/server/config";
import { init } from "./booking.js";

const SLUG = "abcdefghijklmnop";
const EVENT = {
  slug: SLUG, name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z",
  costPence: 1500, venuePostcode: "SW1A 1AA", details: "Bring water.\nBe kind.", archived: false,
};
const slot = (start: string, end: string, status: "free" | "taken" | "past" = "free") => ({ start, end, status });
const SLOTS = [
  slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "taken"),
  slot("2026-06-13T08:20:00Z", "2026-06-13T08:35:00Z"),
  slot("2026-06-13T08:40:00Z", "2026-06-13T08:55:00Z"),
  slot("2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z"),
];
const ICS_URL = "/api/events/abc/bookings/tok0123456789abcdef01/ics";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const OPEN = { open: true, closesAt: "2026-06-13T08:00:00Z" };
const getOk = (event = EVENT, slots: unknown[] = SLOTS, extra: Record<string, unknown> = {}) =>
  reply(200, { event, slots, bookings: OPEN, privacyNotice: DEFAULT_PRIVACY_NOTICE, ...extra });
const created = () => reply(201, {
  booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, dogName: "Biscuit", handlerName: "Ann Lee" },
  event: EVENT, icsUrl: ICS_URL,
});

type Call = { url: string; init?: RequestInit };
type Handler = (call: Call) => Response | Promise<Response>;

async function start(handler: Handler, pathname = `/e/${SLUG}`, settings?: unknown) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  const clipboard = { writeText: vi.fn(async () => {}) };
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, location: { pathname }, clipboard,
    settings: (settings === undefined ? null : Promise.resolve(settings)) as never,
  });
  return { calls, clipboard };
}

const routes = (post: Handler, get: Handler = () => getOk()): Handler => (call) =>
  call.init?.method === "POST" ? post(call) : get(call);

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const slotButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".slot-grid button")];
const slotButton = (time: string) => slotButtons().find((b) => b.textContent!.startsWith(time))!;
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

  describe("slots that have already started", () => {
    const WITH_PAST = [
      slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "past"),
      slot("2026-06-13T08:20:00Z", "2026-06-13T08:35:00Z", "taken"),
      slot("2026-06-13T08:40:00Z", "2026-06-13T08:55:00Z"),
      slot("2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z"),
    ];

    it("renders them disabled, labelled Started, and not selectable", async () => {
      await start(routes(() => created(), () => getOk(EVENT, WITH_PAST)));
      expect(slotButtons().map((b) => b.textContent)).toEqual(["09:00Started", "09:40", "10:00"]);
      const past = slotButton("09:00");
      expect(past.querySelector(".slot-time")!.textContent).toBe("09:00");
      expect(past.querySelector(".slot-note")!.textContent).toBe("Started");
      expect(past.disabled).toBe(true);
      expect(past.classList.contains("past")).toBe(true);
      expect(past.getAttribute("aria-label")).toBe("09:00 slot, started");
      expect(past.hasAttribute("aria-pressed")).toBe(false);
      past.click();
      expect(form().hidden).toBe(true);
      expect(slotButton("09:40").disabled).toBe(false);
      expect(slotButton("09:40").classList.contains("past")).toBe(false);
    });

    it("counts only bookable slots in the slots-left text", async () => {
      await start(routes(() => created(), () => getOk(EVENT, WITH_PAST)));
      expect(text()).toContain("2 slots left");
    });

    it("says fully booked when only started and taken slots remain", async () => {
      await start(routes(() => created(), () => getOk(EVENT, WITH_PAST.slice(0, 2))));
      expect(text()).toContain("Fully booked");
      expect(slotButtons().every((b) => b.disabled)).toBe(true);
    });
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

  it("shows the header and a Bookings closed message, not the form or slots, once the cut-off has passed", async () => {
    await start(() => getOk(EVENT, SLOTS, { bookings: { open: false, closesAt: "2026-06-13T08:00:00Z" } }));
    expect($("h1").textContent).toBe("Trial Day");
    expect(text()).toContain("Saturday 13 June 2026");
    expect(text()).toContain("£15.00");
    expect($(".message h2").textContent).toBe("Bookings closed");
    expect(text()).toContain("Bookings for this event are closed.");
    expect(document.querySelector("form")).toBeNull();
    expect(slotButtons()).toHaveLength(0);
    expect(document.querySelector(".privacy")).toBeNull();
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
    expect(JSON.parse(post.init!.body as string)).toEqual({
      slot: SLOTS[1].start, dogName: "Biscuit", handlerName: "Ann Lee", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });

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

  // The page after another booker took 09:20 and 09:40: only 10:00 is left, and 09:00 London (started) is still listed.
  const AFTER = [
    slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "past"),
    slot(SLOTS[1].start, SLOTS[1].end, "taken"),
    slot(SLOTS[2].start, SLOTS[2].end, "taken"),
    SLOTS[3],
  ];
  const BEFORE = [AFTER[0], SLOTS[1], SLOTS[2], SLOTS[3]];
  const afterGet = () => { let gets = 0; return () => (gets++ === 0 ? getOk(EVENT, BEFORE) : getOk(EVENT, AFTER)); };

  it("refetches the event after a slot_taken 409, notices, and keeps the typed names", async () => {
    const freeSlots = [{ start: SLOTS[3].start, end: SLOTS[3].end }];
    const { calls } = await start(routes(() => reply(409, {
      error: { code: "slot_taken", message: "That slot's just gone." }, freeSlots,
    }), afterGet()));
    slotButton("09:20").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That slot's just gone."));
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:00Started", "10:00"]));

    expect($("#notice").getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe($("#notice"));
    expect(slotButton("09:00").disabled).toBe(true);
    expect(slotButtons()[1].getAttribute("aria-pressed")).toBe("false");
    expect(text()).toContain("1 slot left");
    expect(form().hidden).toBe(true);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#handler-name") as HTMLInputElement).value).toBe("Ann Lee");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2); // the load, then the refetch

    slotButton("10:00").click();
    expect(form().hidden).toBe(false);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
  });

  it("handles slot_started like slot_taken: refetches, keeps the started slots, its own message, typed names kept", async () => {
    const freeSlots = [{ start: SLOTS[3].start, end: SLOTS[3].end }];
    const { calls } = await start(routes(() => reply(409, {
      error: { code: "slot_started", message: "That session has already started." }, freeSlots,
    }), afterGet()));
    slotButton("09:20").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That session has already started."));
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:00Started", "10:00"]));

    expect($("#notice").getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe($("#notice"));
    expect(text()).toContain("1 slot left");
    expect(form().hidden).toBe(true);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#handler-name") as HTMLInputElement).value).toBe("Ann Lee");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
  });

  it("falls back to the 409 payload's free slots when the refetch fails", async () => {
    let gets = 0;
    await start(routes(
      () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [{ start: SLOTS[3].start, end: SLOTS[3].end }] }),
      () => (gets++ === 0 ? getOk() : reply(500, { error: { code: "internal_error" } })),
    ));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["10:00"]));
    expect($("#notice").textContent).toContain("That slot's just gone.");
    expect(document.activeElement).toBe($("#notice"));
  });

  it("shows the closed message when the refetch after a 409 finds the event closed", async () => {
    let gets = 0;
    await start(routes(
      () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [] }),
      () => (gets++ === 0 ? getOk() : reply(200, { event: EVENT, slots: [], bookings: { open: false } })),
    ));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(text()).toContain("Bookings for this event are closed."));
  });

  it("shows fully booked when the refetched event has no free slots", async () => {
    let gets = 0;
    await start(routes(
      () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [] }),
      () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0]])),
    ));
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

  it("refetches on event_changed, notices, keeps the typed names and focuses the notice", async () => {
    let gets = 0;
    const { calls } = await start(routes(
      () => reply(409, { error: { code: "event_changed", message: "x" } }),
      () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0], SLOTS[1], SLOTS[2]])),
    ));
    slotButton("10:00").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:20", "09:40"]));
    expect($("#notice").textContent).toContain("The event was just changed. The times below are up to date; choose again.");
    expect(text()).not.toContain("Something went wrong");
    expect(document.activeElement).toBe($("#notice"));
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
    expect(form().hidden).toBe(true);
    expect(($("#dog-name") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#handler-name") as HTMLInputElement).value).toBe("Ann Lee");
  });

  it.each(["event_archived", "bookings_closed"])("switches to the closed state on 410 %s", async (code) => {
    await start(routes(() => reply(410, { error: { code, message: "closed" } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(text()).toContain("Bookings for this event are closed."));
    expect($(".message h2").textContent).toBe("Bookings closed");
    expect(document.querySelector("form")).toBeNull();
    expect(slotButtons()).toHaveLength(0);
  });

  it("shows the server's message when the idempotency key was reused with different details", async () => {
    const message = "That request doesn't match the earlier one. Reload the page and try again.";
    await start(routes(() => reply(422, { error: { code: "idempotency_key_reuse", message } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain(message));
    expect(form().hidden).toBe(false);
  });

  describe("a key reused with a different payload", () => {
    const original = {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, dogName: "Biscuit", handlerName: "Ann Leee" },
      event: EVENT, icsUrl: ICS_URL,
    };
    const reuse = { error: { code: "idempotency_key_reuse", message: "An earlier attempt was saved." } };

    it("after a lost response and a corrected name, shows the confirmation of the ORIGINAL booking with a notice", async () => {
      let attempts = 0;
      const { calls } = await start(routes(() => {
        if (attempts++ === 0) throw new TypeError("offline"); // the booking was saved, but the response was lost
        return reply(422, { ...reuse, ...original });
      }));
      slotButton("09:20").click();
      fill("Biscuit", "Ann Leee");
      submit();
      await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
      fill("Biscuit", "Ann Lee"); // the corrected name
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));

      expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
      expect(JSON.parse(calls.filter((c) => c.init?.method === "POST")[1].init!.body as string).handlerName).toBe("Ann Lee");
      const handlerRow = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === "Handler")!;
      expect(handlerRow.nextElementSibling!.textContent).toBe("Ann Leee"); // as stored, not as retyped
      expect(text()).toContain("09:20");
      const cal = [...document.querySelectorAll("a")].find((a) => a.textContent === "Add to calendar")!;
      expect(cal.getAttribute("href")).toBe(ICS_URL);
      expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Copy booking")).toBe(true);
      const notice = $("[role=status]");
      expect(notice.textContent).toBe(
        "We'd already saved a booking from this page, so we haven't changed it. Here it is. To change it, contact the organiser.",
      );
      expect(notice.compareDocumentPosition($("h1")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.activeElement).toBe($("h1"));
      expect(document.querySelector("form")).toBeNull();
    });

    it("shows no notice on an ordinary confirmation", async () => {
      await start(routes(() => created()));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(document.querySelector("[role=status]")).toBeNull();
    });

    it("renders the notice and the original booking as text", async () => {
      const evil = "<img src=x onerror=alert(1)>";
      await start(routes(() => reply(422, { ...reuse, ...original, booking: { ...original.booking, dogName: evil } })));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(document.querySelector("img")).toBeNull();
      expect(text()).toContain(evil);
    });
  });

  it("shows the server's text as the form error when the only field error is the idempotency key", async () => {
    await start(routes(() => reply(400, {
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { idempotencyKey: "Reload the page and try again." },
    })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Reload the page and try again."));
    expect(form().textContent).not.toContain("Check the highlighted fields.");
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

describe("idempotency key", () => {
  const posts = (calls: Call[]) => calls.filter((c) => c.init?.method === "POST");
  const keyOf = (c: Call) => JSON.parse(c.init!.body as string).idempotencyKey as string;

  it("reuses one key when a submit is retried after a network error", async () => {
    let fail = true;
    const { calls } = await start(routes(() => {
      if (fail) throw new TypeError("offline");
      return created();
    }));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
    fail = false;
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(posts(calls)).toHaveLength(2);
    expect(keyOf(posts(calls)[0])).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keyOf(posts(calls)[1])).toBe(keyOf(posts(calls)[0]));
  });

  it("reuses it after a server error", async () => {
    let status = 500;
    const { calls } = await start(routes(() => (status === 500 ? reply(500, { error: { code: "internal_error", message: "x" } }) : created())));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
    status = 201;
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(keyOf(posts(calls)[1])).toBe(keyOf(posts(calls)[0]));
  });

  it("reuses it for another slot after a slot_taken 409", async () => {
    let taken = true;
    let gets = 0;
    const { calls } = await start(routes(() => (taken
      ? reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [{ start: SLOTS[3].start, end: SLOTS[3].end }] })
      : created()), () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0], SLOTS[3]]))));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That slot's just gone."));
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["10:00"]));
    taken = false;
    slotButton("10:00").click();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(JSON.parse(posts(calls)[1].init!.body as string).slot).toBe(SLOTS[3].start);
    expect(keyOf(posts(calls)[1])).toBe(keyOf(posts(calls)[0]));
  });

  it("uses a different key in a new page session after a successful booking", async () => {
    const first = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    const second = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(keyOf(posts(second.calls)[0])).not.toBe(keyOf(posts(first.calls)[0]));
  });
});

describe("privacy notice", () => {
  const heading = () => [...document.querySelectorAll("h3")].find((h) => h.textContent === "Privacy")!;

  it("shows the server's notice under a Privacy heading, before the submit button", async () => {
    await start(routes(() => created()));
    slotButton("09:20").click();
    expect(heading().closest("form")).toBe(form());
    expect(heading().parentElement!.textContent).toContain(DEFAULT_PRIVACY_NOTICE);
    const submitButton = form().querySelector("button[type=submit]")!;
    expect(heading().compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("splits paragraphs on blank lines", async () => {
    await start(routes(() => created(), () => getOk(EVENT, SLOTS, { privacyNotice: "First.\n\nSecond.\nStill second." })));
    expect([...heading().parentElement!.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["First.", "Second.\nStill second."]);
  });

  it("renders markup in the notice as inert text", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await start(routes(() => created(), () => getOk(EVENT, SLOTS, { privacyNotice: `${evil}\n\n<b>bold</b>` })));
    expect(document.querySelector("img, b, script")).toBeNull();
    expect(heading().parentElement!.textContent).toContain(evil);
    expect(heading().parentElement!.textContent).toContain("<b>bold</b>");
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

describe("branding, privacy contact and the admin notice", () => {
  const SETTINGS = {
    clubName: "Barkside Agility", website: null, logo: null, loaded: true,
    privacyContact: { name: "Ann Lee", email: "ann@barkside.example" },
  };
  const SESSION = "/api/admin/session";
  const withSettings = (over: Record<string, unknown> = {}) => ({ ...SETTINGS, ...over });
  const probes = (calls: Call[]) => calls.filter((c) => c.url === SESSION);
  /** Event requests get the event, the session probe gets `session`. */
  const route = (session: Handler = () => reply(401, {})): Handler => (call) => (call.url === SESSION ? session(call) : getOk());
  const banner = () => [...document.querySelectorAll(".notice")].find((n) => n.textContent!.startsWith("Admin notice"));

  it("titles the page '<event> – <club>' and adds the header", async () => {
    await start(route(), `/e/${SLUG}`, SETTINGS);
    expect(document.title).toBe("Trial Day – Barkside Agility");
    expect(document.querySelector(".site-header a")!.textContent).toBe("Barkside Agility");
    expect(document.querySelector(".site-header a")!.getAttribute("href")).toBe("/");
  });

  it("titles the page with the event name alone when no club name is set", async () => {
    await start(route(), `/e/${SLUG}`, withSettings({ clubName: null }));
    expect(document.title).toBe("Trial Day");
  });

  it("shows the privacy contact after the notice, with a mailto link", async () => {
    await start(route(), `/e/${SLUG}`, SETTINGS);
    const paragraphs = [...document.querySelectorAll(".privacy p")];
    const last = paragraphs[paragraphs.length - 1];
    expect(last.textContent).toBe("Questions about your details, or want them deleted? Contact Ann Lee, ann@barkside.example.");
    expect(paragraphs.length).toBeGreaterThan(1);
    const a = last.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("mailto:ann@barkside.example");
    expect(a.textContent).toBe("ann@barkside.example");
  });

  it("leaves the name out when it is empty", async () => {
    await start(route(), `/e/${SLUG}`, withSettings({ privacyContact: { name: "", email: "ann@barkside.example" } }));
    expect(document.querySelector(".privacy p:last-child")!.textContent)
      .toBe("Questions about your details, or want them deleted? Contact ann@barkside.example.");
  });

  it("omits the contact when none is set", async () => {
    await start(route(), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(text()).not.toContain("Questions about your details");
    expect(document.querySelector(".privacy a")).toBeNull();
  });

  it("builds the mailto link safely from a hostile address", async () => {
    for (const email of ['a@b.c?cc=x&body=y', 'a"@b.c', "a@b.c><img src=x onerror=alert(1)>"]) {
      await start(route(), `/e/${SLUG}`, withSettings({ privacyContact: { name: "", email } }));
      const a = document.querySelector<HTMLAnchorElement>(".privacy a")!;
      const href = a.getAttribute("href")!;
      expect(href, email).toMatch(/^mailto:[^?&"<>\s]*$/);
      expect(decodeURIComponent(href.slice("mailto:".length))).toBe(email);
      expect(a.textContent).toBe(email);
      expect(document.querySelector(".privacy img")).toBeNull();
    }
  });

  it("shows the admin notice, with a link to Settings, when the contact is missing and the probe answers 200", async () => {
    const { calls } = await start(route(() => reply(200, { csrfToken: "x" })), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(probes(calls)[0].init).toEqual({ credentials: "same-origin", cache: "no-store" });
    expect(banner()!.textContent).toBe(
      "Admin notice (the people booking can't see this): no privacy contact is set, so bookers aren't told who to contact "
      + "about their details. Set one in Settings.",
    );
    expect(banner()!.querySelector("a")!.getAttribute("href")).toBe("/admin/settings");
    expect(document.querySelector("#app")!.firstElementChild).toBe(banner());
  });

  it("keeps the admin notice through later renders", async () => {
    await start(route(() => reply(200, {})), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    slotButton("09:20").click();
    expect(banner()).toBeDefined();
    expect(document.querySelectorAll(".notice").length).toBeGreaterThan(1); // the booking notice (hidden) and the admin one
    expect(document.querySelector("#app")!.firstElementChild).toBe(banner());
  });

  it("shows nothing when the probe answers 401", async () => {
    const { calls } = await start(route(() => reply(401, {})), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(banner()).toBeUndefined();
  });

  it("shows nothing, and still renders the page, when the probe fails", async () => {
    const { calls } = await start(route(() => { throw new TypeError("blocked by CSP"); }), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(banner()).toBeUndefined();
    expect(slotButtons()).toHaveLength(3);
  });

  it("shows nothing when the probe was redirected, even to a 200 page", async () => {
    const redirected = () => Object.defineProperty(new Response("<html>", { status: 200 }), "redirected", { value: true });
    await start(route(redirected), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(banner()).toBeUndefined();
  });

  it("makes no probe and shows no notice when the settings are unavailable", async () => {
    const unavailable = { clubName: null, website: null, privacyContact: null, logo: null, loaded: false };
    const { calls } = await start(route(() => reply(200, {})), `/e/${SLUG}`, unavailable);
    expect(probes(calls)).toHaveLength(0);
    expect(banner()).toBeUndefined();
    const { calls: noSettings } = await start(route(() => reply(200, {})));
    expect(probes(noSettings)).toHaveLength(0);
  });

  it("makes no probe at all when a contact is set", async () => {
    const { calls } = await start(route(() => reply(200, {})), `/e/${SLUG}`, SETTINGS);
    expect(probes(calls)).toHaveLength(0);
    expect(banner()).toBeUndefined();
  });
});
