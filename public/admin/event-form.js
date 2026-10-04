import { formatTime, newIdempotencyKey, penceFromPounds } from "../lib.js";

const DEBOUNCE_MS = 300;
const PLACEHOLDER = "Fill in the highlighted fields to see the schedule.";
const PREVIEW_FAILED = "We couldn't update the preview. Check your connection and keep editing to try again.";
const SAVE_FAILED = "We couldn't save the event. Check your connection and try again.";
const SAVED_EARLIER = "We'd already saved an event from this page, so we haven't changed it. Here it is as saved. Any changes you made since weren't applied.";
const AFFECTED_APPEARED = "Another booking has appeared since you checked, so please check the list again.";
// The preview endpoint validates a whole draft but only the schedule fields matter to it.
const PREVIEW_ONLY = { name: "Preview", costPence: 0, venuePostcode: "AB1 2CD", details: "" };
const SCHEDULE_KEYS = new Set(["date", "start", "end", "sessionMinutes", "gapMinutes"]);
const isScheduleKey = (key) => SCHEDULE_KEYS.has(key) || key === "breaks" || key.startsWith("breaks.");
const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : null);
const plural = (n, one, many) => (n === 1 ? one : many);

/** Whole pounds as "15", otherwise "12.50": what the cost field takes back through penceFromPounds. */
export const poundsText = (pence) => (pence % 100 === 0 ? String(pence / 100) : `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`);

/** "10:05 — Rex — Sam Smith" (London time). */
export const bookingLine = (b) => `${formatTime(b.slotStart)} — ${b.dogName} — ${b.handlerName}`;

/**
 * The event form shared by the create page (`mode: "create"`) and the edit page (`mode: "edit"`): fields,
 * break rows, live preview, near-miss suggestions, validation display and Save.
 *
 * Create sends one idempotency key per page load with every Save. Edit is pre-filled from `initial` (the
 * detail endpoint's `event`), previews through the event's own endpoint, which also lists the bookings the
 * draft would orphan, and Save asks for confirmation when there are any. `done({ data, notice, confirmed })`
 * is called once the event is saved (the form is then dead: the page shows its own result); `confirmed` is
 * the list of bookings the admin agreed to remove.
 */
export function mountEventForm({ document, root, api, h, mode, slug, initial, done }) {
  const editing = mode === "edit";

  // One key per page load, sent with every Save so a retry can't create the event twice, even after edits to
  // the form. The created view has no way back to the form, so a second event means a new page load and so
  // a new key.
  const idempotencyKey = editing ? null : newIdempotencyKey();
  const eventUrl = editing ? `/api/admin/events/${encodeURIComponent(slug)}` : "/api/admin/events";
  const previewUrl = editing ? `${eventUrl}/preview` : "/api/admin/events/preview";

  // Server errors by form key, with `breaks.<i>...` rewritten to `breaks.<row id>...` (see mapKey).
  let serverErrors = {};
  let attempted = false;
  let saving = false;
  const fields = new Map(); // key -> { key, input (or null), error, touched }
  const rows = []; // break rows: { id, el, legend, startInput, endInput, labelInput }
  const dismissed = new Set(); // suggestion keys the user declined
  let nextRowId = 1;
  let timer;
  let controller = null;
  let seq = 0; // bumped whenever a pending or in-flight preview stops being wanted
  let affected = []; // edit: the bookings the last preview said the draft would remove
  let previewCurrent = false; // edit: whether `affected` answers the form as it is now

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
  const saveButton = h("button", { type: "submit", class: "button primary" }, editing ? "Save changes" : "Save event");

  const form = h("form", { id: "event-form", novalidate: true },
    h("h1", {}, editing ? "Edit event" : "Create event"),
    formError,
    f.name,
    f.date,
    h("div", { class: "field-row" }, f.start, f.end),
    h("div", { class: "field-row" }, f.session, f.gap),
    h("fieldset", { class: "breaks-group" },
      h("legend", {}, "Breaks (optional)"),
      breakList, breaksError, addBreak),
    f.cost, f.postcode, f.details,
    h("p", { class: "note" }, editing
      ? "Changing the times can remove booked slots. You'll see who is affected and be asked to confirm before anything is removed."
      : "You can edit the event after saving, so you can fix any slip later."),
    saveButton,
    progress);

  function addRow(focus = true) {
    const id = nextRowId++;
    const legend = h("legend", {});
    const times = {};
    const labelId = `break-${id}-label`;
    const labelInput = h("input", {
      id: labelId, name: labelId, type: "text", maxlength: "40", placeholder: "Lunch", autocomplete: "off",
      "aria-describedby": `${labelId}-error`,
    });
    const labelError = h("p", { id: `${labelId}-error`, class: "field-error", role: "alert" });
    fields.set(`breaks.${id}.label`, { key: `breaks.${id}.label`, input: labelInput, error: labelError, touched: false });
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
    const row = { id, legend, startInput: times.start, endInput: times.end, labelInput };
    remove.addEventListener("click", () => {
      rows.splice(rows.indexOf(row), 1);
      fields.delete(`breaks.${id}.start`);
      fields.delete(`breaks.${id}.end`);
      fields.delete(`breaks.${id}.label`);
      row.el.remove();
      numberRows();
      addBreak.focus();
      onScheduleChange();
    });
    row.el = h("fieldset", { class: "break-row" }, legend, h("div", { class: "field-row" }, ...cells),
      h("div", { class: "field" }, h("label", { for: labelId }, "Name (optional)"), labelInput, labelError), remove);
    rows.push(row);
    breakList.append(row.el);
    numberRows();
    if (focus) row.startInput.focus();
    return row;
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
  addBreak.addEventListener("click", () => addRow());
  form.addEventListener("submit", onSubmit);

  // ---- live preview ----
  const summary = h("p", { class: "preview-summary" }, PLACEHOLDER);
  const chips = h("ul", { class: "chips" });
  const suggestions = h("div", { class: "suggestions" });
  const affectedPanel = h("div", { class: "affected", "aria-live": "polite" });
  const previewHeading = h("h2", { id: "preview-heading", tabindex: "-1" }, "Schedule preview");
  const live = h("div", { "aria-live": "polite" }, summary, chips);
  const preview = h("section", { class: "preview", "aria-labelledby": "preview-heading" },
    previewHeading, ...(editing ? [affectedPanel] : []), suggestions, live);

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
        breaks: used.map((r) => ({ start: r.startInput.value, end: r.endInput.value, label: r.labelInput.value })),
      },
    };
  }

  /** The bookings the draft would remove, as a warning under the preview heading (edit only). */
  function renderAffected(list) {
    affected = list;
    if (list.length === 0) return affectedPanel.replaceChildren();
    affectedPanel.replaceChildren(
      h("p", { class: "affected-title" },
        `${list.length} ${plural(list.length, "booking is", "bookings are")} on slots this change removes:`),
      h("ul", {}, ...list.map((b) => h("li", {}, bookingLine(b)))),
      h("p", { class: "affected-note" }, "You'll be asked to confirm before anything is removed."));
  }

  function showNoSchedule(text) {
    summary.textContent = text;
    chips.replaceChildren();
    suggestions.replaceChildren();
    previewCurrent = false;
    renderAffected([]);
  }

  function onScheduleChange() {
    cancelPreview();
    previewCurrent = false;
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
      res = await api.request("POST", previewUrl, draft.payload, controller.signal);
    } catch {
      if (mine === seq) {
        controller = null;
        preview.removeAttribute("aria-busy");
        showNoSchedule(PREVIEW_FAILED);
      }
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
      if (editing) {
        renderAffected(Array.isArray(res.data.affected) ? res.data.affected : []);
        previewCurrent = Array.isArray(res.data.affected);
      }
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
      const id = rowIds[s.breakIndex];
      const row = rows.find((r) => r.id === id);
      const key = `${id}|${s.droppedSlot.start}|${s.suggestedLocal.start}`;
      if (!row || dismissed.has(key)) continue;
      const move = h("button", { type: "button", class: "button primary" }, "Move break");
      const keep = h("button", { type: "button", class: "button" }, "Keep as it is");
      const what = s.breakLabel ? s.breakLabel : `the ${row.startInput.value}–${row.endInput.value} break`;
      const card = h("div", { class: "suggestion" },
        h("p", {},
          `Move ${what} to ${s.suggestedLocal.start}–${s.suggestedLocal.end} to keep the ${formatTime(s.droppedSlot.start)} session?`),
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
  /** The form as a request body, or null (after showing the cost error) if the cost can't be read. */
  function readForm() {
    const cost = penceFromPounds(fields.get("costPence").input.value);
    if ("error" in cost) return null;
    const used = rows.filter(isUsed);
    return {
      rowIds: used.map((r) => r.id),
      payload: {
        name: value("name"), date: value("date"), start: value("start"), end: value("end"),
        sessionMinutes: wholeNumber(value("sessionMinutes")), gapMinutes: wholeNumber(value("gapMinutes")),
        costPence: cost.pence, venuePostcode: value("venuePostcode"), details: value("details"),
        breaks: used.map((r) => ({ start: r.startInput.value, end: r.endInput.value, label: r.labelInput.value })),
      },
    };
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (saving) return;
    attempted = true;
    formError.textContent = "";
    const draft = readForm();
    if (!draft) {
      renderErrors();
      return focusFirstError();
    }
    // Only a preview that matches the form as it is can tell what Save would remove. Without one Save goes
    // straight to the server, which works it out itself and answers 409 with the list if anything is affected.
    if (editing && previewCurrent && affected.length > 0) return openConfirmation(affected);
    cancelPreview(); // a late preview response would wipe the errors Save is about to show
    await save(draft, []);
  }

  /** Sends the save; `removeIds` is what the admin confirmed (always empty for create and for a plain Save). */
  async function save(draft, removeIds, confirmed = []) {
    setSaving(true);
    let res;
    try {
      res = editing
        ? await api.request("PUT", eventUrl, { ...draft.payload, removeBookingIds: removeIds })
        : await api.request("POST", eventUrl, { ...draft.payload, idempotencyKey });
    } catch {
      res = null;
    }
    // On success the form stays busy: the caller replaces it, and it may take a round trip to do so.
    if (!editing && res?.status === 201 && res.data?.event) return finish({ data: res.data });
    if (editing && res?.status === 200 && res.data?.event) return finish({ data: res.data, confirmed });
    setSaving(false);
    // The page's own earlier attempt was saved: show that event rather than the edited form.
    if (!editing && res?.status === 422 && res.data?.error?.code === "idempotency_key_reuse") {
      if (res.data.event) return finish({ data: res.data, notice: SAVED_EARLIER });
      closeConfirmation();
      formError.textContent = res.data.error.message;
      return;
    }
    if (res?.status === 401) return;
    if (editing && res?.status === 409 && res.data?.error?.code === "bookings_affected" && Array.isArray(res.data.affected)) {
      // A booking appeared (or the list was stale): show the server's list and ask again.
      if (res.data.affected.length > 0) return openConfirmation(res.data.affected, removeIds.length > 0 ? AFFECTED_APPEARED : "");
      closeConfirmation();
      formError.textContent = "Something changed while saving. Try saving again.";
      return;
    }
    closeConfirmation();
    if (res?.status === 400 && res.data?.fields) {
      serverErrors = {};
      const unplaced = [];
      for (const [key, message] of Object.entries(res.data.fields)) {
        const mapped = mapKey(key, draft.rowIds);
        if (fields.has(mapped)) serverErrors[mapped] = message;
        else unplaced.push(message);
      }
      renderErrors();
      if (unplaced.length > 0 || Object.keys(serverErrors).length === 0) {
        formError.textContent = unplaced.join(" ") || res.data.error?.message || SAVE_FAILED;
      }
      return focusFirstError();
    }
    formError.textContent = editing && res?.status === 404 ? "This event no longer exists." : SAVE_FAILED;
  }

  function setSaving(busy) {
    saving = busy;
    saveButton.disabled = busy;
    for (const b of confirmButtons) b.disabled = busy;
    form.setAttribute("aria-busy", String(busy));
    progress.textContent = busy ? (editing ? "Saving the changes…" : "Saving the event…") : "";
  }

  function finish(result) {
    cancelPreview();
    done(result);
  }

  // ---- confirmation (edit): nothing is removed until the admin confirms this exact list ----
  const confirmButtons = [];
  let confirmation = null;
  let layout = null;

  function openConfirmation(list, noticeText = "") {
    cancelPreview();
    confirmation?.remove();
    confirmButtons.length = 0;
    const n = list.length;
    const heading = h("h2", { id: "confirm-heading", tabindex: "-1" },
      `Saving will remove ${n} ${plural(n, "booking", "bookings")}. Tell ${plural(n, "this person", "these people")} to rebook:`);
    const remove = h("button", { type: "button", class: "button danger" }, `Remove ${n} ${plural(n, "booking", "bookings")} and save`);
    const cancel = h("button", { type: "button", class: "button" }, "Cancel");
    confirmButtons.push(remove, cancel);
    remove.addEventListener("click", async () => {
      if (saving) return;
      const draft = readForm();
      if (!draft) return closeConfirmation();
      // Only this button sends ids, and only those of the bookings listed above.
      await save(draft, list.map((b) => b.id), list);
    });
    cancel.addEventListener("click", () => {
      closeConfirmation();
      saveButton.focus();
      if (readSchedule()) runPreview();
    });
    confirmation = h("section", { class: "confirm", "aria-labelledby": "confirm-heading" },
      ...(noticeText ? [h("p", { class: "notice", role: "status" }, noticeText)] : []),
      h("div", { class: "confirm-body" },
        heading,
        h("ul", { class: "confirm-list" }, ...list.map((b) => h("li", {}, bookingLine(b)))),
        h("div", { class: "actions" }, remove, cancel)));
    layout.hidden = true;
    root.append(confirmation);
    heading.focus();
  }

  function closeConfirmation() {
    if (!confirmation) return;
    confirmation.remove();
    confirmation = null;
    confirmButtons.length = 0;
    layout.hidden = false;
  }

  // ---- mount ----
  layout = h("div", { class: "new-layout" }, form, preview);
  root.replaceChildren(h("a", { class: "back", href: "/admin/" }, "Back to events"), layout);

  if (editing) {
    f.name.querySelector("input").value = initial.name;
    f.date.querySelector("input").value = initial.date;
    f.start.querySelector("input").value = initial.start;
    f.end.querySelector("input").value = initial.end;
    f.session.querySelector("input").value = String(initial.sessionMinutes);
    f.gap.querySelector("input").value = String(initial.gapMinutes);
    f.cost.querySelector("input").value = poundsText(initial.costPence);
    f.postcode.querySelector("input").value = initial.venuePostcode;
    f.details.querySelector("textarea").value = initial.details;
    for (const b of initial.breaks) {
      const row = addRow(false);
      row.startInput.value = b.start;
      row.endInput.value = b.end;
      row.labelInput.value = b.label;
    }
    if (readSchedule()) runPreview();
  }
  renderErrors();
}
