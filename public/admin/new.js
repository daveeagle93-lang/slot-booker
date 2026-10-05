import { brandPage, loadSettings } from "../branding.js";
import { whatsappMessage } from "../lib.js";
import { createApi, makeH, writeClipboard } from "./api.js";
import { mountEventForm } from "./event-form.js";

/**
 * Wires the create-event page into `#app`. Resolves once the form is on screen. `settings` is the branding
 * promise (see branding.js); the club name heads the WhatsApp message once it has loaded, and without it the
 * message has no club line.
 */
export async function init({ document, fetch, navigate, clipboard, location, settings = null }) {
  const root = document.getElementById("app");
  const api = createApi({ fetch, navigate });
  const h = makeH(document);

  // Not awaited: the form must not wait for the settings. They are long settled by the time an event is saved.
  let clubName = "";
  settings?.then((s) => { if (s?.loaded) clubName = s.clubName ?? ""; }, () => {});

  try {
    if (!(await api.loadSession())) return;
  } catch {
    root.replaceChildren(h("div", { class: "message", role: "alert" },
      h("p", {}, "We couldn't check that you're signed in. Check your connection and reload the page.")));
    return;
  }

  mountEventForm({
    document, root, api, h, mode: "create",
    done: ({ data, notice }) => showCreated(data, notice),
  });

  function showCreated({ event, path }, noticeText) {
    const url = location.origin + path;
    const message = whatsappMessage(event, url, clubName);
    const heading = h("h1", { tabindex: "-1" }, "Event created");
    const copyStatus = h("p", { class: "copy-status", "aria-live": "polite" });
    const link = h("input", { id: "booking-link", type: "text", readonly: true });
    link.value = url;
    const text = h("textarea", { id: "whatsapp-text", readonly: true, rows: "10" });
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
    root.replaceChildren(...(noticeText ? [h("p", { class: "notice", role: "status" }, noticeText)] : []), h("section", { class: "created" },
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
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  const settings = loadSettings((...args) => fetch(...args));
  brandPage(document, settings, { pageTitle: document.title, home: "/admin/" });
  init({
    document, location, clipboard: navigator.clipboard, settings,
    fetch: (...args) => fetch(...args),
    navigate: (url) => location.assign(url),
  });
}
