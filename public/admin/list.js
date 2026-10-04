import { formatDate, formatTimeRange, isBookingPath } from "../lib.js";
import { createApi, makeH, writeClipboard } from "./api.js";

/** Wires the upcoming-events page into `#app`. Resolves once the first load has settled. */
export async function init({ document, fetch, navigate, clipboard, location }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  const show = (...nodes) => root.replaceChildren(...nodes);
  const status = (text) => show(h("p", { class: "message", role: "status" }, text));
  const failure = (text) => {
    const retry = h("button", { type: "button", class: "button" }, "Retry");
    retry.addEventListener("click", load);
    show(h("div", { class: "message", role: "alert" }, h("p", {}, text), retry));
  };

  async function load() {
    status("Loading events…");
    let session;
    let res;
    try {
      session = await api.loadSession();
      if (!session) return;
      res = await api.request("GET", "/api/admin/events");
    } catch {
      return failure("We couldn't load your events. Check your connection and try again.");
    }
    if (res.status === 401) return;
    if (res.status !== 200 || !Array.isArray(res.data?.events)) {
      return failure("We couldn't load your events. Try again.");
    }
    render(session, res.data.events);
  }

  function render(session, events) {
    const signOutError = h("p", { class: "form-error", role: "alert" });
    const signOut = h("button", { type: "button", class: "button" }, "Sign out");
    signOut.addEventListener("click", async () => {
      signOut.disabled = true;
      signOutError.textContent = "";
      try {
        await api.logout();
      } catch {
        signOutError.textContent = "We couldn't sign you out. Try again.";
      }
      signOut.disabled = false;
    });
    show(
      h("header", { class: "admin-bar" },
        h("p", { class: "signed-in" }, "Signed in as ", h("strong", {}, session.identity)),
        signOut),
      signOutError,
      h("h1", {}, "Upcoming events"),
      h("a", { class: "button primary big", href: "/admin/new" }, "Create event"),
      events.length === 0
        ? h("p", { class: "message", role: "status" }, "No upcoming events yet.")
        : h("ul", { class: "event-list" }, ...events.map(card)));
  }

  function card(ev) {
    const children = [
      h("h2", {}, ev.name),
      h("p", { class: "when" }, `${formatDate(ev.startUtc)}, ${formatTimeRange(ev.startUtc, ev.endUtc)}`),
      h("p", { class: "booked" }, `${ev.bookedCount} of ${ev.slotCount} slots booked`),
      h("p", {}, h("span", { class: ev.bookings?.open ? "badge open" : "badge closed" },
        ev.bookings?.open ? "Bookings open" : "Bookings closed")),
    ];
    // Only events with a sound booking path get any links, as before.
    const edit = h("a", { class: "button", href: `/admin/edit?slug=${encodeURIComponent(ev.slug)}` }, "Edit");
    const schedule = h("a", { class: "button", href: `/admin/schedule?slug=${encodeURIComponent(ev.slug)}` }, "Schedule");
    if (isBookingPath(ev.path)) children.push(...actions(location.origin + ev.path, ev.path, edit, schedule));
    return h("li", { class: "event-card" }, ...children);
  }

  function actions(url, path, edit, schedule) {
    const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
    const fallback = h("div", { class: "field", hidden: true });
    const copy = h("button", { type: "button", class: "button primary" }, "Copy booking link");
    let timer;
    copy.addEventListener("click", async () => {
      clearTimeout(timer);
      if (await writeClipboard(clipboard, url)) {
        fallback.hidden = true;
        copyStatus.textContent = "Copied";
        timer = setTimeout(() => { copyStatus.textContent = ""; }, 2000);
        return;
      }
      const input = h("input", { type: "text", readonly: true, "aria-label": "Booking link" });
      input.value = url;
      fallback.replaceChildren(input);
      fallback.hidden = false;
      input.focus();
      input.select();
      copyStatus.textContent = "Couldn't copy automatically. Copy the link below manually.";
    });
    return [
      h("div", { class: "actions" }, copy, h("a", { class: "button", href: path }, "Open"), edit, schedule),
      copyStatus,
      fallback,
    ];
  }

  return load();
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  init({
    document, location, clipboard: navigator.clipboard,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}
