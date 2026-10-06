// Opt-in layout check for the date and time inputs on the create and edit event pages (npm run test:webkit).
//
// iOS Safari (WebKit) gives input[type=date|time] an intrinsic minimum width, which made the Date field run past
// the card and the Start/End pairs overlap on a phone. This loads the real pages at phone widths and checks that no
// date or time input leaves its field or card, that pairs in one row don't overlap, and that the page doesn't
// scroll sideways.
//
//   node scripts/check-ios-date-inputs.mjs [--engine webkit|chromium] [--allow-skip] [--break-css]
//
// --engine      webkit (default) or chromium. Chromium never showed the bug, so it is only a sanity check of the
//               script and the page; only a WebKit run says anything about iOS.
// --allow-skip  exit 0 instead of 2 when WebKit can't launch here (Playwright supports a limited set of systems).
// --break-css   self-test: forces a wide min-width on the inputs, so the run must FAIL.
//
// Exit codes: 0 all checks passed (or skipped with --allow-skip), 1 a check failed, 2 the engine can't launch
// (not a pass).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, webkit } from "playwright-core";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const WIDTHS = [320, 390];
const TOLERANCE = 0.5;
const SLUG = "abcdefghijklmnop1234";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};
// A 1x1 transparent PNG, for the icon links.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const engineName = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : "webkit";
const engines = { webkit, chromium };
if (!engines[engineName]) {
  console.error(`Unknown engine "${engineName}": use webkit or chromium.`);
  process.exit(2);
}

/** Serves ./public the way the Worker's assets do: /admin/new is admin/new.html, /admin/ is admin/index.html. */
function startServer() {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index";
    let file = resolve(join(PUBLIC_DIR, path));
    if (!extname(file)) file += ".html";
    if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

// The shape of GET /api/admin/events/:slug (eventDetail in src/server/admin-event-edit.ts), with two breaks.
const EVENT = {
  slug: SLUG, name: "Saturday agility", archived: false, listed: true,
  date: "2030-06-15", start: "10:00", end: "14:00", sessionMinutes: 15, gapMinutes: 5, costPence: 1200,
  venuePostcode: "AB1 2CD", details: "Bring water.",
  startUtc: "2030-06-15T09:00:00.000Z", endUtc: "2030-06-15T13:00:00.000Z",
  breaks: [
    { start: "11:00", end: "11:30", label: "Tea", startUtc: "2030-06-15T10:00:00.000Z", endUtc: "2030-06-15T10:30:00.000Z" },
    { start: "12:30", end: "13:00", label: "Lunch", startUtc: "2030-06-15T11:30:00.000Z", endUtc: "2030-06-15T12:00:00.000Z" },
  ],
};
const SLOTS = [{ start: "2030-06-15T09:00:00.000Z", end: "2030-06-15T09:15:00.000Z" }];

/** Answers every /api/** call the two pages make, so no Worker or database is needed. */
async function stubApi(page) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route(/\/api\//, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/admin/session") return json(route, { identity: "admin", provider: "password", csrfToken: "test-token" });
    if (pathname === "/api/settings") return json(route, { clubName: "Test club", website: null, privacyContact: null, logo: null });
    if (pathname === "/api/theme.css") return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    if (pathname.startsWith("/api/icon/")) return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    if (pathname.startsWith("/api/manifest")) return json(route, {});
    if (pathname === `/api/admin/events/${SLUG}`) return json(route, { event: EVENT, slots: [], orphans: [], lineup: "" });
    if (pathname.endsWith("/preview")) return json(route, { slots: SLOTS, suggestions: [], affected: [] });
    return json(route, { error: { code: "not_stubbed", message: pathname } }, 404);
  });
}

/** One entry per date or time input: its rect, and the rects of the field and card around it. */
const measure = () => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };
  const card = box(document.querySelector("form"));
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    inputs: [...document.querySelectorAll('input[type="date"], input[type="time"]')].map((input) => ({
      id: input.id,
      rect: box(input),
      field: box(input.closest(".field")),
      card,
      row: input.closest(".field-row") ? [...input.closest(".field-row").querySelectorAll('input[type="date"], input[type="time"]')].map((i) => i.id) : [],
    })),
  };
};

const inside = (inner, outer) =>
  inner.left >= outer.left - TOLERANCE && inner.right <= outer.right + TOLERANCE;
const overlap = (a, b) =>
  a.left < b.right - TOLERANCE && b.left < a.right - TOLERANCE && a.top < b.bottom - TOLERANCE && b.top < a.bottom - TOLERANCE;

/** The failures for one loaded page, as readable lines (empty when it is fine). */
function check(label, m, expectedIds) {
  const failures = [];
  const ids = m.inputs.map((i) => i.id);
  for (const id of expectedIds) if (!ids.includes(id)) failures.push(`${label}: expected input #${id} is not on the page`);
  const round = (n) => Math.round(n * 10) / 10;
  for (const i of m.inputs) {
    if (!inside(i.rect, i.field)) failures.push(`${label}: #${i.id} (${round(i.rect.left)}..${round(i.rect.right)}) leaves its field (${round(i.field.left)}..${round(i.field.right)})`);
    if (!inside(i.rect, i.card)) failures.push(`${label}: #${i.id} (${round(i.rect.left)}..${round(i.rect.right)}) leaves the form card (${round(i.card.left)}..${round(i.card.right)})`);
    for (const otherId of i.row) {
      const other = m.inputs.find((o) => o.id === otherId);
      if (otherId > i.id && overlap(i.rect, other.rect)) failures.push(`${label}: #${i.id} and #${otherId} overlap`);
    }
  }
  if (m.scrollWidth > m.innerWidth) failures.push(`${label}: the page scrolls sideways (scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth})`);
  return failures;
}

async function main() {
  let browser;
  try {
    browser = await engines[engineName].launch();
  } catch (e) {
    const reason = String(e.message).split("\n").find((l) => l.trim()) ?? "unknown error";
    console.log(`SKIPPED: ${engineName} cannot launch here: ${reason}`);
    process.exit(engineName === "webkit" && flag("allow-skip") ? 0 : 2);
  }

  const server = await startServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { defaultBrowserType, ...phone } = devices["iPhone 13"];
  const failures = [];
  let checked = 0;
  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ ...phone, viewport: { width, height: 844 } });
      const page = await context.newPage();
      await stubApi(page);
      const run = async (label, path, expectedIds, prepare) => {
        await page.goto(`${origin}${path}`);
        await page.waitForSelector("#event-form");
        if (prepare) await prepare();
        if (flag("break-css")) {
          await page.addStyleTag({ content: 'input[type="date"], input[type="time"] { min-width: 300px !important; }' });
        }
        failures.push(...check(`${label} @${width}px`, await page.evaluate(measure), expectedIds));
        checked++;
      };
      await run("new", "/admin/new", ["date", "start", "end"]);
      await run("new + 2 breaks", "/admin/new", ["date", "start", "end", "break-1-start", "break-1-end", "break-2-start", "break-2-end"], async () => {
        await page.click("text=Add break");
        await page.click("text=Add break");
      });
      await run("edit", `/admin/edit?slug=${SLUG}`,
        ["date", "start", "end", "break-1-start", "break-1-end", "break-2-start", "break-2-end"],
        () => page.waitForSelector("#break-2-end"));
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.log(`FAIL (${engineName}): ${failures.length} problem(s)`);
    for (const f of failures) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log(`PASS (${engineName}): ${checked} page loads at ${WIDTHS.join(" and ")}px, every date and time input fits its field and card, no overlaps, no sideways scroll`);
}

await main();
