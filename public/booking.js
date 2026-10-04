import {
  copyText, formatDate, formatPounds, formatTime, formatTimeRange, mapsUrl, newIdempotencyKey, privacyParagraphs,
  slotsLeftText, slugFromPathname,
} from "./lib.js";

const GENERIC_ERROR = "Something went wrong. Please try again.";
const CLOSED = "Bookings for this event are closed.";
const SAVED_EARLIER = "We'd already saved a booking from this page, so we haven't changed it. Here it is. To change it, contact the organiser.";

/** Wires the booking page into `#app`. Resolves once the first load has settled. */
export function init({ document, fetch, location, clipboard }) {
  const root = document.getElementById("app");
  const slug = slugFromPathname(location.pathname);
  let event = null;
  let slots = [];
  let selected = null;
  let submitting = false;
  let privacyText = "";
  // One key per page load, sent with every submit so a retry can't book twice. The confirmation has no
  // way back to the form, so a second booking means a reload, and so a new key.
  const idempotencyKey = newIdempotencyKey();
  let view = null; // element refs for the booking view

  // All text goes through textContent; nothing here ever parses HTML.
  const h = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  };
  const show = (...nodes) => root.replaceChildren(...nodes);
  const reduceMotion = () => document.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scrollTo = (el) => el.scrollIntoView?.({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  const mapsLink = (postcode) =>
    h("a", { href: mapsUrl(postcode), target: "_blank", rel: "noopener noreferrer" }, postcode);

  function showMessage(text, withRetry = false) {
    view = null;
    show(h("div", { class: "message", role: "status" },
      h("p", {}, text),
      ...(withRetry ? [h("button", { type: "button", class: "button" }, "Retry")] : [])));
    if (withRetry) root.querySelector("button").addEventListener("click", load);
  }

  function eventHeader(ev) {
    const row = (label, ...value) => [h("dt", {}, label), h("dd", {}, ...value)];
    return h("header", { class: "event" },
      h("h1", {}, ev.name),
      h("dl", { class: "facts" },
        ...row("Date", formatDate(ev.startUtc)),
        ...row("Time", formatTimeRange(ev.startUtc, ev.endUtc)),
        ...row("Venue", mapsLink(ev.venuePostcode)),
        ...row("Cost", formatPounds(ev.costPence))),
      ...(ev.details ? [h("p", { class: "details" }, ev.details)] : []));
  }

  async function fetchEvent() {
    try {
      const res = await fetch(`/api/events/${slug}`, { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      return { status: res.status, data };
    } catch {
      return null;
    }
  }

  // Taken slots are hidden; slots that have already started stay visible but disabled.
  const shown = (list) => list.filter((s) => s.status === "free" || s.status === "past");
  const isClosed = (data) => data.event.archived || data.bookings?.open === false;

  async function load() {
    if (!slug) return showMessage("We couldn't find that event. Check the link you were sent.");
    showMessage("Loading…");
    const r = await fetchEvent();
    if (r?.status === 404) return showMessage("We couldn't find that event. Check the link you were sent.");
    if (!r?.data) return showMessage("We couldn't load this event. Check your connection and try again.", true);
    event = r.data.event;
    slots = shown(r.data.slots);
    privacyText = r.data.privacyNotice ?? "";
    selected = null;
    document.title = event.name;
    if (isClosed(r.data)) showClosed();
    else showBooking();
  }

  function showClosed() {
    view = null;
    show(eventHeader(event), h("div", { class: "message", role: "status" }, h("h2", {}, "Bookings closed"), h("p", {}, CLOSED)));
  }

  function showBooking() {
    const notice = h("div", { id: "notice", class: "notice", role: "alert", tabindex: "-1", hidden: true });
    const slotsLeft = h("p", { class: "slots-left" });
    const grid = h("ul", { class: "slot-grid" });

    const dog = h("input", {
      id: "dog-name", name: "dog", type: "text", required: true, maxlength: "80", autocapitalize: "words",
      autocomplete: "off", enterkeyhint: "next", "aria-describedby": "dog-error",
    });
    const handler = h("input", {
      id: "handler-name", name: "handler", type: "text", required: true, maxlength: "80", autocapitalize: "words",
      autocomplete: "name", enterkeyhint: "done", "aria-describedby": "handler-error",
    });
    const dogError = h("p", { id: "dog-error", class: "field-error", role: "alert" });
    const handlerError = h("p", { id: "handler-error", class: "field-error", role: "alert" });
    const formError = h("div", { class: "form-error", role: "alert" });
    const heading = h("h2", { tabindex: "-1" });
    const submit = h("button", { type: "submit", class: "button primary" });
    const progress = h("p", { class: "progress", "aria-live": "polite" });
    const privacy = privacyParagraphs(privacyText);
    const form = h("form", { id: "booking-form", hidden: true },
      heading,
      formError,
      h("div", { class: "field" }, h("label", { for: "dog-name" }, "Dog's name"), dog, dogError),
      h("div", { class: "field" }, h("label", { for: "handler-name" }, "Handler's name"), handler, handlerError),
      ...(privacy.length > 0
        ? [h("section", { class: "privacy", "aria-labelledby": "privacy-heading" },
          h("h3", { id: "privacy-heading" }, "Privacy"), ...privacy.map((p) => h("p", {}, p)))]
        : []),
      submit,
      progress);

    view = { notice, slotsLeft, grid, form, heading, submit, progress, formError, dog, handler, dogError, handlerError };
    show(
      eventHeader(event),
      h("section", { class: "slots", "aria-labelledby": "slots-heading" },
        h("h2", { id: "slots-heading" }, "Pick a time"), slotsLeft, notice, grid),
      form);
    form.addEventListener("submit", onSubmit);
    renderSlots();
  }

  function setNotice(text) {
    view.notice.textContent = text;
    view.notice.hidden = !text;
  }

  function renderSlots() {
    view.slotsLeft.textContent = slotsLeftText(slots.filter((s) => s.status === "free").length);
    view.grid.replaceChildren(...slots.map((s) => {
      const time = formatTime(s.start);
      if (s.status === "past") {
        return h("li", {}, h("button", { type: "button", class: "slot past", disabled: true, "aria-label": `${time} slot, started` },
          h("span", { class: "slot-time" }, time), h("span", { class: "slot-note" }, "Started")));
      }
      const button = h("button", {
        type: "button", class: "slot", "aria-pressed": String(s.start === selected), "aria-label": `Book ${time} slot`,
      }, time);
      button.dataset.start = s.start;
      button.addEventListener("click", () => select(s));
      return h("li", {}, button);
    }));
  }

  function select(slot) {
    selected = slot.start;
    setNotice("");
    clearErrors();
    for (const b of view.grid.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.start === selected));
    const time = formatTime(slot.start);
    view.heading.textContent = `Booking ${time}`;
    view.submit.textContent = `Confirm booking for ${time}`;
    view.form.hidden = false;
    scrollTo(view.form);
  }

  function deselect() {
    selected = null;
    view.form.hidden = true;
  }

  function clearErrors() {
    view.formError.textContent = "";
    for (const [input, error] of [[view.dog, view.dogError], [view.handler, view.handlerError]]) {
      error.textContent = "";
      input.removeAttribute("aria-invalid");
    }
  }

  function fieldError(input, error, message) {
    error.textContent = message;
    input.setAttribute("aria-invalid", "true");
  }

  function setBusy(busy) {
    submitting = busy;
    view.submit.disabled = busy;
    view.form.setAttribute("aria-busy", String(busy));
    view.progress.textContent = busy ? "Confirming your booking…" : "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || selected === null) return;
    clearErrors();
    setBusy(true);
    let res;
    let data = null;
    try {
      res = await fetch(`/api/events/${slug}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slot: selected, dogName: view.dog.value, handlerName: view.handler.value, idempotencyKey }),
      });
      data = await res.json().catch(() => null);
    } catch {
      setBusy(false);
      view.formError.textContent = GENERIC_ERROR;
      return;
    }
    setBusy(false);
    const code = data?.error?.code;
    if (res.status === 201 && data?.booking) return showConfirmation(data);
    if (res.status === 409 && (code === "slot_taken" || code === "slot_started")) {
      // The payload only lists free slots, so show it at once (in case the refetch fails), then refetch for the
      // full current view, which also keeps the slots that have started.
      slots = shown((data.freeSlots ?? []).map((s) => ({ ...s, status: "free" })));
      deselect();
      renderSlots();
      setNotice(code === "slot_started" ? "That session has already started." : "That slot's just gone.");
      await refresh();
      view?.notice.focus();
    } else if (res.status === 409 && code === "duplicate_booking") {
      view.formError.textContent = data.error.message;
    } else if (res.status === 400 && code === "invalid_input") {
      const f = data.fields ?? {};
      if (f.dogName) fieldError(view.dog, view.dogError, f.dogName);
      if (f.handlerName) fieldError(view.handler, view.handlerError, f.handlerName);
      if (f.slot || !(f.dogName || f.handlerName)) view.formError.textContent = f.slot ?? f.idempotencyKey ?? data.error.message;
    } else if (res.status === 400 && code === "invalid_slot") {
      deselect();
      setNotice("That slot isn't available any more.");
      await refresh();
    } else if (res.status === 422 && code === "idempotency_key_reuse") {
      // With a booking: the page's own earlier attempt was saved, so show that rather than the edit.
      if (data.booking) showConfirmation(data, SAVED_EARLIER);
      else view.formError.textContent = data.error.message;
    } else if (res.status === 410) {
      showClosed();
    } else {
      view.formError.textContent = GENERIC_ERROR;
    }
  }

  /** Re-reads the slot list, leaving any notice and typed names in place. */
  async function refresh() {
    const r = await fetchEvent();
    if (!r?.data) return;
    event = r.data.event;
    if (isClosed(r.data)) return showClosed();
    slots = shown(r.data.slots);
    if (view) renderSlots();
  }

  function showConfirmation({ booking, event: ev = event, icsUrl }, noticeText) {
    view = null;
    const when = `${formatDate(booking.slot.start)}, ${formatTimeRange(booking.slot.start, booking.slot.end)}`;
    const row = (label, ...value) => [h("dt", {}, label), h("dd", {}, ...value)];
    const heading = h("h1", { tabindex: "-1" }, "You're booked in");
    const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
    const copyButton = h("button", { type: "button", class: "button" }, "Copy booking");
    let timer;
    copyButton.addEventListener("click", async () => {
      const ok = await copyToClipboard(copyText(ev, booking));
      copyStatus.textContent = ok ? "Copied" : "Couldn't copy. Take a screenshot instead.";
      clearTimeout(timer);
      timer = setTimeout(() => { copyStatus.textContent = ""; }, 2000);
    });
    show(...(noticeText ? [h("p", { class: "notice", role: "status" }, noticeText)] : []), h("section", { class: "confirmation" },
      heading,
      h("p", { class: "event-name" }, ev.name),
      h("dl", { class: "facts" },
        ...row("When", when),
        ...row("Dog", booking.dogName),
        ...row("Handler", booking.handlerName),
        ...row("Venue", mapsLink(ev.venuePostcode)),
        ...row("Cost", formatPounds(ev.costPence))),
      ...(ev.details ? [h("p", { class: "details" }, ev.details)] : []),
      h("div", { class: "actions" },
        copyButton,
        h("a", { class: "button primary", href: icsUrl }, "Add to calendar")),
      copyStatus,
      h("p", { class: "keep" },
        "Keep this: take a screenshot or copy the details, as there's no way to look your booking up again. "
        + "Bookings can't be changed online, so contact the organiser to move or cancel.")));
    heading.focus();
  }

  async function copyToClipboard(text) {
    try {
      if (clipboard?.writeText) {
        await clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    const area = h("textarea", { class: "clipboard-buffer", readonly: true, tabindex: "-1", "aria-hidden": "true" });
    area.value = text;
    document.body.append(area);
    area.select();
    area.setSelectionRange?.(0, text.length);
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* unsupported */ }
    area.remove();
    return ok;
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  init({
    document, location, clipboard: navigator.clipboard,
    fetch: (...args) => fetch(...args),
  });
}
