import { brandPage, loadSettings } from "./branding.js";

const SIGN_IN = "/admin/login";
const GENERIC_ERROR = "Something went wrong. Please try again.";

function rateLimitMessage(retryAfter) {
  const seconds = Number(retryAfter);
  if (!retryAfter || !Number.isFinite(seconds) || seconds <= 0) return "Too many attempts. Try again later.";
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// Same trimming as trimAdminSecret in src/server/auth/crypto.ts (this page cannot import from src/, nor from the
// guarded /admin/login.js); setup.test.ts checks it agrees with the sign-in page's copy. Whitespace plus the invisible
// characters String.prototype.trim leaves in.
const INVISIBLE = "​‌‍⁠᠎­";
const isIgnorable = (char) => char.trim() === "" || INVISIBLE.includes(char);

/** Drops whitespace and invisible characters from both ends only. */
export function trimAdminSecret(input) {
  let start = 0;
  let end = input.length;
  while (start < end && isIgnorable(input[start])) start++;
  while (end > start && isIgnorable(input[end - 1])) end--;
  return input.slice(start, end);
}

/**
 * Wires the first-run page. Step 1 asks for the setup code; step 2 shows the admin secret the server made, once. The
 * secret is only ever put into the page when the response arrives: not in the address, in storage, or anywhere else.
 */
export function init({ document, fetch, navigator }) {
  const form = document.getElementById("setup-form");
  const field = document.getElementById("code");
  const error = document.getElementById("setup-error");
  const button = form.querySelector("button");
  const step2 = document.getElementById("secret-step");
  const secretBlock = document.getElementById("secret");
  const copy = document.getElementById("copy");
  const copyStatus = document.getElementById("copy-status");
  const saved = document.getElementById("saved");
  const signIn = document.getElementById("sign-in");
  let submitting = false;

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const code = trimAdminSecret(field.value);
    if (code === "") {
      error.textContent = "Enter the setup code.";
      return;
    }
    submitting = true;
    button.disabled = true;
    error.textContent = "";
    let message = GENERIC_ERROR;
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && typeof body?.secret === "string") {
        field.value = "";
        form.hidden = true;
        secretBlock.textContent = body.secret;
        step2.hidden = false;
        copy.focus();
        return;
      }
      if (res.status === 429) message = rateLimitMessage(res.headers.get("Retry-After"));
      else if (res.status === 404) message = "Setup has already been completed. Sign in instead.";
      else if (typeof body?.error?.message === "string") message = body.error.message;
    } catch { /* offline or blocked: the generic message */ }
    if (message !== GENERIC_ERROR) field.value = "";
    error.textContent = message;
    submitting = false;
    button.disabled = false;
    field.focus();
  }
  form.addEventListener("submit", submit);

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(secretBlock.textContent);
      copyStatus.textContent = "Copied.";
    } catch {
      copyStatus.textContent = "Couldn't copy automatically. Select the secret above and copy it yourself.";
    }
  });

  // A link cannot be disabled, so it has no address until the box is ticked.
  saved.addEventListener("change", () => {
    if (saved.checked) {
      signIn.setAttribute("href", SIGN_IN);
      signIn.removeAttribute("aria-disabled");
    } else {
      signIn.removeAttribute("href");
      signIn.setAttribute("aria-disabled", "true");
    }
  });
}

// Browser entry only: the page opts in with data-autostart, so importing this module (tests) does nothing.
if (globalThis.document?.getElementById("app")?.hasAttribute("data-autostart")) {
  brandPage(document, loadSettings((...args) => fetch(...args)), { pageTitle: document.title, home: "/" });
  init({ document, fetch: (...args) => fetch(...args), navigator });
}
