import { brandPage, loadSettings } from "../branding.js";
import { formatDate, formatTime, isBookingPath } from "../lib.js";
import { buildShareMessage, pickShareTemplate } from "../share-message.js";
import { createApi, makeH, writeClipboard } from "./api.js";
import { shareControls } from "./share.js";

const SLUG = /^[A-Za-z0-9_-]{16,64}$/;
const CHANGED = "That changed while you were working. The schedule has been refreshed.";
const OFFLINE = "We couldn't reach the server. Check your connection and try again.";

/**
 * Wires the schedule page (`/admin/schedule?slug=...`) into `#app`: every slot and break in order with the
 * actions to add, move, swap and clear bookings. After every action the event is fetched again and drawn
 * afresh, so the page never shows what the server doesn't have. Names are user input: text nodes only.
 * A Share control sits under the date unless the event is archived or over (their links are closed). `settings` is the branding promise (see
 * branding.js), whose club name heads the shared message once it has loaded.
 * Resolves once the first load has settled.
 */
export async function init({ document, fetch, navigate, clipboard, location, navigator = undefined, settings = null }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  // Not awaited: the page must not wait for the settings. They are long settled by the time Share is tapped.
  let clubName = "";
  settings?.then((s) => { if (s?.loaded) clubName = s.clubName ?? ""; }, () => {});

  const show = (...nodes) => root.replaceChildren(...nodes);
  const back = () => h("a", { class: "button", href: "/admin/" }, "Back to events");
  const notFound = () => show(h("div", { class: "message", role: "alert" },
    h("p", {}, "We couldn't find that event. It may have been removed, or the link may be wrong."), back()));
  const failure = (retry) => {
    const button = h("button", { type: "button", class: "button" }, "Retry");
    button.addEventListener("click", retry);
    show(h("div", { class: "message", role: "alert" }, h("p", {}, "We couldn't load the schedule. Check your connection and try again."), button));
  };

  try {
    if (!(await api.loadSession())) return;
  } catch {
    show(h("div", { class: "message", role: "alert" },
      h("p", {}, "We couldn't check that you're signed in. Check your connection and reload the page.")));
    return;
  }

  const slug = new URLSearchParams(location.search).get("slug") ?? "";
  if (!SLUG.test(slug)) return notFound();
  const base = `/api/admin/events/${encodeURIComponent(slug)}`;

  let detail = null;
  let panel = null; // the open action: { kind: "clear" | "move" | "swap" | "add", key }
  let busy = false;
  // One live region for every result; it outlives re-renders so screen readers hear each change.
  const status = h("p", { class: "copy-status sched-status", "aria-live": "polite", tabindex: "-1" });
  const say = (text) => { status.textContent = text; };

  const person = (b) => `${b.dogName} (${b.handlerName})`;
  const orphanTime = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;
  const takenText = (b) => `That slot is already taken by ${person(b)}.`;

  function setBusy(on) {
    busy = on;
    for (const el of root.querySelectorAll("button, select, input")) el.disabled = on;
  }

  /**
   * One request at a time. `done(data)` says what to announce and where focus goes on success; `rejected(res)`
   * may handle a refusal inline (and return true). A change made by someone else (including an edit that
   * removed the slot: `invalid_slot`), or a slot that has just been taken, refreshes the page instead, so
   * what is shown is what the server has.
   */
  async function perform(method, url, body, { done, rejected }) {
    if (busy) return;
    setBusy(true);
    let res;
    try {
      res = await api.request(method, url, body);
    } catch {
      setBusy(false);
      say(OFFLINE);
      return;
    }
    if (res.status === 401) { setBusy(false); return; }
    const code = res.data?.error?.code;
    if (res.status >= 200 && res.status < 300) return refresh(done(res.data));
    setBusy(false); // before an inline refusal can move focus: a disabled control can't take it
    if (rejected?.(res, code)) return;
    if (res.status === 404 || (res.status === 400 && code === "invalid_slot") || (res.status === 409 && (code === "changed" || code === "event_changed"))) {
      return refresh({ message: CHANGED, focus: "status" });
    }
    if (res.status === 409 && code === "slot_taken" && res.data?.booking) {
      return refresh({ message: takenText(res.data.booking), focus: "status" });
    }
    say(res.data?.error?.message ?? "Something went wrong. Try again.");
  }

  async function refresh({ message, focus }) {
    setBusy(true);
    let res = null;
    try { res = await api.request("GET", base); } catch { /* reported below */ }
    panel = null;
    if (res?.status === 200 && Array.isArray(res.data?.slots)) {
      detail = res.data;
      busy = false;
      render(focus);
      say(message);
    } else {
      setBusy(false);
      say(`${message} We couldn't refresh the schedule, so reload the page to see it.`);
    }
  }

  async function load() {
    show(h("p", { class: "message", role: "status" }, "Loading the schedule…"));
    let res;
    try {
      res = await api.request("GET", base);
    } catch {
      return failure(load);
    }
    if (res.status === 401) return;
    if (res.status === 404) return notFound();
    if (res.status !== 200 || !Array.isArray(res.data?.slots)) return failure(load);
    detail = res.data;
    render(null);
  }

  const find = (key) => [...root.querySelectorAll("[data-key]")].find((el) => el.getAttribute("data-key") === key);

  /** `focus`: "status", { key } for a row, { key, action } for a row's button, or { panel } for the open form. */
  function render(focus) {
    const { event } = detail;
    const freeSlots = detail.slots.filter((s) => !s.booking);
    const bookedSlots = detail.slots.filter((s) => s.booking);

    const links = [h("a", { class: "button", href: `/admin/edit?slug=${encodeURIComponent(slug)}` }, "Edit event")];
    if (isBookingPath(`/e/${slug}`)) links.push(h("a", { class: "button", href: `/e/${slug}` }, "Open public page"));
    links.push(h("a", { class: "button", href: `${base}/export.csv`, download: true }, "Download CSV"));
    const fallback = h("div", { class: "field", hidden: true });
    const copy = h("button", { type: "button", class: "button primary" }, "Copy lineup");
    copy.addEventListener("click", async () => {
      if (await writeClipboard(clipboard, detail.lineup)) {
        fallback.hidden = true;
        say("Copied");
        return;
      }
      const box = h("textarea", { readonly: true, "aria-label": "Lineup", rows: String(Math.min(detail.slots.length + event.breaks.length + 3, 14)) });
      box.value = detail.lineup;
      fallback.replaceChildren(box);
      fallback.hidden = false;
      box.focus();
      box.select();
      say("Couldn't copy automatically. Copy it from here.");
    });

    // The message is built from the event as it is now, each time Share is tapped.
    const share = () => shareControls({
      h, navigator, clipboard, label: event.name,
      getLink: () => `${location.origin}/e/${slug}`,
      getMessage: () => buildShareMessage({
        event, clubName, link: `${location.origin}/e/${slug}`, template: pickShareTemplate(event, detail.defaultShareMessage),
      }),
    });

    // Slots and breaks together, in time order. A break never starts where a slot does.
    const items = [
      ...detail.slots.map((s) => ({ start: s.start, slot: s })),
      ...event.breaks.map((b) => ({ start: b.startUtc, brk: b })),
    ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    function openers(key, kind, label, aria) {
      const button = h("button", { type: "button", class: "button", "data-action": kind, "aria-label": aria, "aria-expanded": String(panel?.kind === kind && panel.key === key) }, label);
      button.addEventListener("click", () => {
        if (busy) return;
        panel = { kind, key };
        render({ panel: true });
      });
      return button;
    }
    const cancel = (key, kind, autofocus = false) => {
      const button = h("button", { type: "button", class: "button", "data-autofocus": autofocus }, "Cancel");
      button.addEventListener("click", () => {
        if (busy) return;
        panel = null;
        render({ key, action: kind });
      });
      return button;
    };
    const panelIf = (key, build) => (panel?.key === key ? [build()] : []);

    function clearPanel(b, key, when) {
      const confirmButton = h("button", { type: "button", class: "button danger" }, "Clear booking");
      confirmButton.addEventListener("click", () => perform("DELETE", `${base}/bookings/${b.id}`, { confirm: true }, {
        done: () => ({ message: `Cleared ${person(b)} from ${when}.`, focus: { key } }),
      }));
      return h("div", { class: "sched-panel confirm", role: "group", "aria-label": "Confirm clearing the booking" },
        h("h3", {}, "Clear this booking?"),
        h("p", {}, `${when}: ${person(b)}`),
        h("p", { class: "note" }, "They won't be told. You need to let them know."),
        h("div", { class: "actions" }, confirmButton, cancel(key, "clear", true)));
    }

    /** A form with one select of slots and a submit button; `choices` are { start, text }. */
    function pickPanel({ key, kind, title, label, choices, submitLabel, empty, send }) {
      if (choices.length === 0) return h("div", { class: "sched-panel", role: "group", "aria-label": title }, h("h3", {}, title), h("p", { class: "note" }, empty), h("div", { class: "actions" }, cancel(key, kind)));
      const select = h("select", { id: `pick-${kind}`, "data-autofocus": true },
        h("option", { value: "" }, "Choose…"), ...choices.map((c) => h("option", { value: c.start }, c.text)));
      const error = h("p", { class: "field-error", role: "alert" });
      const form = h("form", { class: "sched-panel", "aria-label": title },
        h("h3", {}, title),
        h("div", { class: "field" }, h("label", { for: `pick-${kind}` }, label), select, error),
        h("div", { class: "actions" }, h("button", { type: "submit", class: "button primary" }, submitLabel), cancel(key, kind)));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (busy) return;
        if (select.value === "") {
          error.textContent = "Choose a slot.";
          select.setAttribute("aria-invalid", "true");
          select.focus();
          return;
        }
        send(select.value);
      });
      return form;
    }

    function movePanel(b, key, fromSlot, when) {
      return pickPanel({
        key, kind: "move", title: "Move booking", label: "New slot", submitLabel: "Move booking", empty: "There are no free slots to move it to.",
        choices: freeSlots.map((s) => ({ start: s.start, text: formatTime(s.start) })),
        send: (toSlot) => perform("POST", `${base}/bookings/${b.id}/move`, { fromSlot, toSlot }, {
          done: () => ({ message: `Moved ${person(b)} from ${when} to ${formatTime(toSlot)}.`, focus: { key: toSlot } }),
        }),
      });
    }

    function swapPanel(b, key, fromSlot, when) {
      const others = bookedSlots.filter((s) => s.start !== fromSlot);
      return pickPanel({
        key, kind: "swap", title: "Swap bookings", label: "Swap with", submitLabel: "Swap bookings", empty: "There's no other booking to swap with.",
        choices: others.map((s) => ({ start: s.start, text: `${formatTime(s.start)}: ${person(s.booking)}` })),
        send: (otherSlot) => {
          const other = others.find((s) => s.start === otherSlot);
          return perform("POST", `${base}/bookings/swap`, { a: { id: b.id, slot: fromSlot }, b: { id: other.booking.id, slot: otherSlot } }, {
            done: () => ({ message: `Swapped ${b.dogName} (${when}) with ${other.booking.dogName} (${formatTime(otherSlot)}).`, focus: { key: otherSlot } }),
          });
        },
      });
    }

    function addPanel(slotStart, key) {
      const when = formatTime(slotStart);
      const dog = h("input", { id: "add-dog", type: "text", autocomplete: "off", "data-autofocus": true });
      const handler = h("input", { id: "add-handler", type: "text", autocomplete: "off" });
      const dogError = h("p", { class: "field-error", id: "add-dog-error" });
      const handlerError = h("p", { class: "field-error", id: "add-handler-error" });
      const formError = h("p", { class: "form-error", role: "alert" });
      const mark = (input, error, message) => {
        error.textContent = message ?? "";
        if (message) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", error.id); }
        else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
      };
      const form = h("form", { class: "sched-panel", "aria-label": `Add booking at ${when}` },
        h("h3", {}, `Add booking at ${when}`),
        formError,
        h("div", { class: "field" }, h("label", { for: "add-dog" }, "Dog's name"), dog, dogError),
        h("div", { class: "field" }, h("label", { for: "add-handler" }, "Handler's name"), handler, handlerError),
        h("div", { class: "actions" }, h("button", { type: "submit", class: "button primary" }, "Add booking"), cancel(key, "add")));
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (busy) return;
        formError.textContent = "";
        mark(dog, dogError, "");
        mark(handler, handlerError, "");
        perform("POST", `${base}/bookings`, { slot: slotStart, dogName: dog.value, handlerName: handler.value }, {
          done: (data) => ({ message: `Added ${person(data.booking)} at ${when}.`, focus: { key } }),
          rejected: (res, code) => {
            if (res.status === 400 && code === "invalid_input") {
              const fields = res.data?.fields ?? {};
              mark(dog, dogError, fields.dogName);
              mark(handler, handlerError, fields.handlerName);
              formError.textContent = fields.slot ?? "";
              (fields.dogName ? dog : handler).focus();
              return true;
            }
            if (res.status === 409 && code === "duplicate_booking" && res.data?.booking) {
              const b = res.data.booking;
              formError.textContent = `${b.dogName} and ${b.handlerName} already have a booking at ${formatTime(b.slotStart)}.`;
              dog.focus();
              return true;
            }
            return false;
          },
        });
      });
      return form;
    }

    function slotRow({ start, booking }) {
      const b = booking && { id: booking.id, dogName: booking.dogName, handlerName: booking.handlerName };
      const when = formatTime(start);
      const buttons = b
        ? [openers(start, "move", "Move", `Move booking at ${when}`), openers(start, "swap", "Swap", `Swap booking at ${when}`), openers(start, "clear", "Clear", `Clear booking at ${when}`)]
        : [openers(start, "add", "Add booking", `Add booking at ${when}`)];
      const open = panel?.key === start
        ? [panel.kind === "clear" ? clearPanel(b, start, when) : panel.kind === "move" ? movePanel(b, start, start, when)
          : panel.kind === "swap" ? swapPanel(b, start, start, when) : addPanel(start, start)]
        : [];
      return h("li", { class: b ? "sched-row booked" : "sched-row free", "data-key": start, tabindex: "-1" },
        h("div", { class: "sched-line" },
          h("span", { class: "sched-time" }, when),
          h("span", { class: "sched-who" }, b ? person(b) : "Free")),
        h("div", { class: "sched-actions" }, ...buttons),
        ...open);
    }

    function breakRow(b) {
      return h("li", { class: "sched-break" },
        h("span", { class: "sched-time" }, `${b.start}–${b.end}`),
        h("span", { class: "sched-who" }, b.label === "" ? "Break" : b.label));
    }

    function orphanRow(o) {
      const key = `orphan-${o.id}`;
      const when = orphanTime(o.slotStart);
      const b = { id: o.id, dogName: o.dogName, handlerName: o.handlerName };
      const open = panel?.key === key
        ? [panel.kind === "clear" ? clearPanel(b, key, when) : movePanel(b, key, o.slotStart, when)]
        : [];
      return h("li", { class: "sched-row booked orphan", "data-key": key, tabindex: "-1" },
        h("div", { class: "sched-line" }, h("span", { class: "sched-time" }, when), h("span", { class: "sched-who" }, person(b))),
        h("div", { class: "sched-actions" },
          openers(key, "move", "Move", `Move booking from ${when}`), openers(key, "clear", "Clear", `Clear booking from ${when}`)),
        ...open);
    }

    const children = [
      h("h1", {}, "Schedule"),
      h("p", { class: "event-name" }, event.name),
      ...(event.listed === false ? [h("p", {}, h("span", { class: "badge closed" }, "Not listed"))] : []),
      h("p", { class: "sched-date" }, formatDate(event.startUtc)),
      ...(event.archived || !(Date.parse(event.endUtc) > Date.now()) || !isBookingPath(`/e/${slug}`) ? [] : [share()]),
      h("div", { class: "actions" }, ...links, copy),
      status,
      fallback,
      h("ol", { class: "sched" }, ...items.map((i) => (i.slot ? slotRow(i.slot) : breakRow(i.brk)))),
    ];
    if (detail.orphans.length > 0) {
      children.push(h("section", { class: "sched-orphans" },
        h("h2", {}, "Not in the schedule"),
        h("p", { class: "note" }, "These bookings are on times that are no longer slots. Move them to a free slot or clear them."),
        h("ol", { class: "sched" }, ...detail.orphans.map(orphanRow))));
    }
    show(...children);

    if (focus === "status") status.focus();
    else if (focus?.panel) root.querySelector("[data-autofocus]")?.focus();
    else if (focus?.key) {
      const row = find(focus.key);
      const target = focus.action ? [...row?.querySelectorAll("[data-action]") ?? []].find((el) => el.getAttribute("data-action") === focus.action) : row;
      (target ?? status).focus(); // a cleared orphan's row is gone: fall back to the live region
    }
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  const settings = loadSettings((...args) => fetch(...args));
  brandPage(document, settings, { pageTitle: document.title, home: "/admin/" });
  init({
    document, location, navigator, clipboard: navigator.clipboard, settings,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}
