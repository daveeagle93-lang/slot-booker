import { formatTime, penceFromPounds, whatsappMessage } from "../lib.js";
import { createApi, makeH, writeClipboard } from "./api.js";

const DEBOUNCE_MS = 300;
const PLACEHOLDER = "Fill in the highlighted fields to see the schedule.";
const PREVIEW_FAILED = "We couldn't update the preview. Check your connection and keep editing to try again.";
const SAVE_FAILED = "We couldn't save the event. Check your connection and try again.";
// The preview endpoint validates a whole draft but only the schedule fields matter to it.
const PREVIEW_ONLY = { name: "Preview", costPence: 0, venuePostcode: "AB1 2CD", details: "" };
const SCHEDULE_KEYS = new Set(["date", "start", "end", "sessionMinutes", "gapMinutes"]);
const isScheduleKey = (key) => SCHEDULE_KEYS.has(key) || key === "breaks" || key.startsWith("breaks.");
const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : null);

/** Wires the create-event page into `#app`. Resolves once the form is on screen. */
export async function init({ document, fetch, navigate, clipboard, location }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  try {
    if (!(await api.loadSession())) return;
  } catch {
    root.replaceChildren(h("div", { class: "message", role: "alert" },
      h("p", {}, "We couldn't check that you're signed in. Check your connection and reload the page.")));
    return;
  }

  // Server errors by form key, with `breaks.<i>...` rewritten to `breaks.<row id>...` (see mapKey).
  let serverErrors = {};
  let attempted = false;
  let saving = false;
  const fields = new Map(); // key -> { key, input (or null), error, touched }
  const rows = []; // break rows: { id, el, legend, startInput, endInput }
  const dismissed = new Set(); // suggestion keys the user declined
  let nextRowId = 1;
  let timer;
  let controller = null;
  let seq = 0; // bumped whenever a pending or in-flight preview stops being wanted

  // ---- form ----
  function field(key, id, labelText, input) {
    const error = h("p", { id: `${id}-error`, class: "field-error", role: "alert" });
    fields.set(key, { key, input, error, touched: false });
    return h("div", { class: "field" }, h("label", { for: id }, labelText), input, error);
  }
  const control = (tag, id, attrs = {}) => h(tag, { id, name: id, "aria-describedby": `${id}-error`, ...attrs });
  const timeInput = (id) => control("input", id, { type: "time", required: true });
  const minutesInput = (id, min, max) =>
    control("input", id, { type: "number", inputmode: "numeric", min, max, step: 1, required: true });

  const f = {
    name: field("name", "name", "Event name",
      control("input", "name", { type: "text", maxlength: "100", autocomplete: "off", required: true })),
    date: field("date", "date", "Date", control("input", "date", { type: "date", required: true })),
    start: field("start", "start", "Start time", timeInput("start")),
    end: field("end", "end", "End time", timeInput("end")),
    session: field("sessionMinutes", "session", "Session length (minutes)", minutesInput("session", 1, 480)),
    gap: field("gapMinutes", "gap", "Gap between sessions (minutes)", minutesInput("gap", 0, 120)),
    cost: field("costPence", "cost", "Cost (£)",
      control("input", "cost", { type: "text", inputmode: "decimal", autocomplete: "off", required: true })),
    postcode: field("venuePostcode", "postcode", "Venue postcode",
      control("input", "postcode", { type: "text", autocapitalize: "characters", autocomplete: "off", required: true })),
    details: field("details", "details", "Details (optional)",
      control("textarea", "details", { rows: "4", maxlength: "2000" })),
  };
  const value = (key) => fields.get(key).input.value.trim();

  const breaksError = h("p", { id: "breaks-error", class: "field-error", role: "alert", tabindex: "-1" });
  fields.set("breaks", { key: "breaks", input: null, error: breaksError, touched: true });
  const breakList = h("div", { class: "breaks" });
  const addBreak = h("button", { type: "button", class: "button" }, "Add break");
  const formError = h("div", { class: "form-error", role: "alert", tabindex: "-1" });
  const progress = h("p", { class: "progress", "aria-live": "polite" });
  const saveButton = h("button", { type: "submit", class: "button primary" }, "Save event");

  const form = h("form", { id: "event-form", novalidate: true },
    h("h1", {}, "Create event"),
    formError,
    f.name,
    f.date,
    h("div", { class: "field-row" }, f.start, f.end),
    h("div", { class: "field-row" }, f.session, f.gap),
    h("fieldset", { class: "breaks-group" },
      h("legend", {}, "Breaks (optional)"),
      breakList, breaksError, addBreak),
    f.cost, f.postcode, f.details,
    h("p", { class: "note" }, "You can't edit an event after saving yet, so check the details."),
    saveButton,
    progress);

  function addRow() {
    const id = nextRowId++;
    const legend = h("legend", {});
    const times = {};
    const cells = ["start", "end"].map((which) => {
      const key = `breaks.${id}.${which}`;
      const inputId = `break-${id}-${which}`;
      const input = h("input", { id: inputId, name: inputId, type: "time", "aria-describedby": `${inputId}-error` });
      const error = h("p", { id: `${inputId}-error`, class: "field-error", role: "alert" });
      fields.set(key, { key, input, error, touched: false });
      times[which] = input;
      return h("div", { class: "field" }, h("label", { for: inputId }, which === "start" ? "Start" : "End"), input, error);
    });
    const remove = h("button", { type: "button", class: "button remove" }, "Remove");
    const row = { id, legend, startInput: times.start, endInput: times.end };
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(row), 1);
      fields.delete(`breaks.${id}.start`);
      fields.delete(`breaks.${id}.end`);
      row.el.remove();
      numberRows();
      addBreak.focus();
      onScheduleChange();
    });
    row.el = h("fieldset", { class: "break-row" }, legend, h("div", { class: "field-row" }, ...cells), remove);
    rows.push(row);
    breakList.append(row.el);
    numberRows();
    row.startInput.focus();
  }

  function numberRows() {
    rows.forEach((r, i) => {
      r.legend.textContent = `Break ${i + 1}`;
      r.el.querySelector("button").setAttribute("aria-label", `Remove break ${i + 1}`);
    });
  }

  const isUsed = (r) => r.startInput.value !== "" || r.endInput.value !== "";

  /** Shows each field's error: the local cost check, else the server's, once the field is touched or Save was tried. */
  function renderErrors() {
    const cost = penceFromPounds(fields.get("costPence").input.value);
    for (const fld of fields.values()) {
      let message = "";
      if (fld.touched || attempted) {
        message = (fld.key === "costPence" && "error" in cost ? cost.error : serverErrors[fld.key]) ?? "";
      }
      fld.error.textContent = message;
      if (fld.input) {
        if (message) fld.input.setAttribute("aria-invalid", "true");
        else fld.input.removeAttribute("aria-invalid");
      }
    }
  }

  function focusFirstError() {
    form.querySelector("[aria-invalid='true'], .field-error:not(:empty)")?.focus();
  }

  /** "breaks.<payload index>.end" becomes "breaks.<row id>.end", through the rows that were sent. */
  function mapKey(key, rowIds) {
    const m = /^breaks\.(\d+)(\..+)?$/.exec(key);
    if (!m) return key;
    const id = rowIds[Number(m[1])];
    return id === undefined ? "breaks" : `breaks.${id}${m[2] ?? ""}`;
  }

  function dropScheduleErrors() {
    serverErrors = Object.fromEntries(Object.entries(serverErrors).filter(([k]) => !isScheduleKey(k)));
  }

  form.addEventListener("input", (e) => {
    const fld = [...fields.values()].find((x) => x.input === e.target);
    if (!fld) return;
    fld.touched = true;
    delete serverErrors[fld.key];
    renderErrors();
    if (isScheduleKey(fld.key)) onScheduleChange();
  });
  form.addEventListener("focusout", (e) => {
    const fld = [...fields.values()].find((x) => x.input === e.target);
    if (!fld || fld.touched) return;
    fld.touched = true;
    renderErrors();
  });
  addBreak.addEventListener("click", addRow);
  form.addEventListener("submit", onSubmit);

  // ---- live preview ----
  const summary = h("p", { class: "preview-summary" }, PLACEHOLDER);
  const chips = h("ul", { class: "chips" });
  const suggestions = h("div", { class: "suggestions" });
  const previewHeading = h("h2", { id: "preview-heading", tabindex: "-1" }, "Schedule preview");
  const live = h("div", { "aria-live": "polite" }, summary, chips);
  const preview = h("section", { class: "preview", "aria-labelledby": "preview-heading" }, previewHeading, suggestions, live);

  function cancelPreview() {
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    seq++;
    preview.removeAttribute("aria-busy");
  }

  /** The preview request and the form row behind each break in it, or null until the draft is complete. */
  function readSchedule() {
    const sessionMinutes = wholeNumber(value("sessionMinutes"));
    const gapMinutes = wholeNumber(value("gapMinutes"));
    const used = rows.filter(isUsed);
    const complete = value("date") && value("start") && value("end") && sessionMinutes !== null && gapMinutes !== null
      && used.every((r) => r.startInput.value !== "" && r.endInput.value !== "");
    if (!complete) return null;
    return {
      rowIds: used.map((r) => r.id),
      payload: {
        ...PREVIEW_ONLY, date: value("date"), start: value("start"), end: value("end"), sessionMinutes, gapMinutes,
        breaks: used.map((r) => ({ start: r.startInput.value, end: r.endInput.value })),
      },
    };
  }

  function showNoSchedule(text) {
    summary.textContent = text;
    chips.replaceChildren();
    suggestions.replaceChildren();
  }

  function onScheduleChange() {
    cancelPreview();
    suggestions.replaceChildren(); // they only fit the inputs they were made for
    if (!readSchedule()) {
      dropScheduleErrors();
      renderErrors();
      showNoSchedule(PLACEHOLDER);
      return;
    }
    preview.setAttribute("aria-busy", "true");
    timer = setTimeout(runPreview, DEBOUNCE_MS);
  }

  async function runPreview() {
    const draft = readSchedule();
    if (!draft) return;
    cancelPreview();
    preview.setAttribute("aria-busy", "true");
    controller = new AbortController();
    const mine = seq;
    let res;
    try {
      res = await api.request("POST", "/api/admin/events/preview", draft.payload, controller.signal);
    } catch {
      if (mine === seq) showNoSchedule(PREVIEW_FAILED);
      return;
    }
    if (mine !== seq) return; // a newer edit has superseded this response
    controller = null;
    preview.removeAttribute("aria-busy");
    dropScheduleErrors();
    if (res.status === 200 && Array.isArray(res.data?.slots)) {
      const n = res.data.slots.length;
      summary.textContent = n === 1 ? "1 slot" : `${n} slots`;
      chips.replaceChildren(...res.data.slots.map((s) => h("li", {}, formatTime(s.start))));
      renderSuggestions(res.data.suggestions ?? [], draft.rowIds);
    } else if (res.status === 400 && res.data?.fields) {
      for (const [key, message] of Object.entries(res.data.fields)) {
        const mapped = mapKey(key, draft.rowIds);
        if (isScheduleKey(mapped)) serverErrors[mapped] = message;
      }
      showNoSchedule(PLACEHOLDER);
    } else if (res.status !== 401) {
      showNoSchedule(PREVIEW_FAILED);
    }
    renderErrors();
  }

  function renderSuggestions(list, rowIds) {
    const cards = [];
    for (const s of list) {
      const row = rows.find((r) => r.id === rowIds[s.breakIndex]);
      const key = `${s.breakIndex}|${s.droppedSlot.start}|${s.suggestedLocal.start}`;
      if (!row || dismissed.has(key)) continue;
      const move = h("button", { type: "button", class: "button primary" }, "Move break");
      const keep = h("button", { type: "button", class: "button" }, "Keep as it is");
      const card = h("div", { class: "suggestion" },
        h("p", {},
          `Move the ${row.startInput.value}–${row.endInput.value} break to ${s.suggestedLocal.start}–${s.suggestedLocal.end}`
          + ` to keep the ${formatTime(s.droppedSlot.start)} session?`),
        h("div", { class: "actions" }, move, keep));
      move.addEventListener("click", () => {
        row.startInput.value = s.suggestedLocal.start;
        row.endInput.value = s.suggestedLocal.end;
        for (const k of ["start", "end"]) {
          const fld = fields.get(`breaks.${row.id}.${k}`);
          fld.touched = true;
          delete serverErrors[fld.key];
        }
        renderErrors();
        onScheduleChange();
        previewHeading.focus();
      });
      keep.addEventListener("click", () => {
        dismissed.add(key);
        card.remove();
        previewHeading.focus();
      });
      cards.push(card);
    }
    suggestions.replaceChildren(...cards);
  }

  // ---- save ----
  async function onSubmit(e) {
    e.preventDefault();
    if (saving) return;
    attempted = true;
    formError.textContent = "";
    const cost = penceFromPounds(fields.get("costPence").input.value);
    if ("error" in cost) {
      renderErrors();
      return focusFirstError();
    }
    const used = rows.filter(isUsed);
    const rowIds = used.map((r) => r.id);
    const payload = {
      name: value("name"), date: value("date"), start: value("start"), end: value("end"),
      sessionMinutes: wholeNumber(value("sessionMinutes")), gapMinutes: wholeNumber(value("gapMinutes")),
      costPence: cost.pence, venuePostcode: value("venuePostcode"), details: value("details"),
      breaks: used.map((r) => ({ start: r.startInput.value, end: r.endInput.value })),
    };
    setSaving(true);
    let res;
    try {
      res = await api.request("POST", "/api/admin/events", payload);
    } catch {
      res = null;
    }
    setSaving(false);
    if (res?.status === 201 && res.data?.event) return showCreated(res.data);
    if (res?.status === 401) return;
    if (res?.status === 400 && res.data?.fields) {
      serverErrors = {};
      const unplaced = [];
      for (const [key, message] of Object.entries(res.data.fields)) {
        const mapped = mapKey(key, rowIds);
        if (fields.has(mapped)) serverErrors[mapped] = message;
        else unplaced.push(message);
      }
      renderErrors();
      if (unplaced.length > 0 || Object.keys(serverErrors).length === 0) {
        formError.textContent = unplaced.join(" ") || res.data.error?.message || SAVE_FAILED;
      }
      return focusFirstError();
    }
    formError.textContent = SAVE_FAILED;
  }

  function setSaving(busy) {
    saving = busy;
    saveButton.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    progress.textContent = busy ? "Saving the event…" : "";
  }

  function showCreated({ event, path }) {
    cancelPreview();
    const url = location.origin + path;
    const message = whatsappMessage(event, url);
    const heading = h("h1", { tabindex: "-1" }, "Event created");
    const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
    const link = h("input", { id: "booking-link", type: "text", readonly: true });
    link.value = url;
    const text = h("textarea", { id: "whatsapp-text", readonly: true, rows: "7" });
    text.value = message;
    let statusTimer;
    const copyButton = (label, source) => {
      const button = h("button", { type: "button", class: "button" }, label);
      button.addEventListener("click", async () => {
        clearTimeout(statusTimer);
        if (await writeClipboard(clipboard, source.value)) {
          copyStatus.textContent = "Copied";
          statusTimer = setTimeout(() => { copyStatus.textContent = ""; }, 2000);
        } else {
          source.focus();
          source.select();
          copyStatus.textContent = "Couldn't copy automatically. Copy the selected text manually.";
        }
      });
      return button;
    };
    root.replaceChildren(h("section", { class: "created" },
      heading,
      h("p", { class: "event-name" }, event.name),
      h("div", { class: "field" }, h("label", { for: "booking-link" }, "Booking link"), link,
        h("div", { class: "actions" }, copyButton("Copy link", link))),
      h("div", { class: "field" }, h("label", { for: "whatsapp-text" }, "WhatsApp message"), text,
        h("div", { class: "actions" },
          copyButton("Copy message", text),
          h("a", {
            class: "button", href: `https://wa.me/?text=${encodeURIComponent(message)}`,
            target: "_blank", rel: "noopener noreferrer",
          }, "Open in WhatsApp"))),
      copyStatus,
      h("div", { class: "actions" },
        h("a", { class: "button primary", href: "/admin/new" }, "Create another"),
        h("a", { class: "button", href: "/admin/" }, "Back to events"))));
    heading.focus();
  }

  root.replaceChildren(
    h("a", { class: "back", href: "/admin/" }, "Back to events"),
    h("div", { class: "new-layout" }, form, preview));
  renderErrors();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  init({
    document, location, clipboard: navigator.clipboard,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}
