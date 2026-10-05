# Club settings, logo and theme

An admin can set the club's name, a privacy contact, a website, a logo and two theme colours at `/admin/settings` (the **Settings** button on the admin list). Nothing here needs a redeploy or an environment variable. This page says what each setting does, what is checked, what the public can read, and what has not been verified.

## Where the settings live

- **D1, two singleton tables** (`id` is always 1), created by `migrations/0009_site_settings.sql`:
  - `site_settings`: club name, privacy contact name and email, website, and the two theme colours (NULL means the default theme). The migration inserts the row, so a read always finds one.
  - `site_logo`: no row means no logo. The image bytes are in a BLOB column. The logo has its own table so that reading the text settings, which every public page does, never pulls the image.
- **Admin API**: `GET` and `PUT /api/admin/settings` (name, contact, website), `PUT` and `DELETE /api/admin/settings/logo`, `PUT` and `DELETE /api/admin/settings/theme`. They sit under `/api/admin/*`, so they get the same protection as the rest of the admin API: the sign-in check, then the same-origin and CSRF-token checks on every write (`docs/admin-auth.md`). Each handler also refuses a request with no signed-in identity (401).
- **Public API**: `GET /api/settings`, `GET /api/logo`, `GET /api/theme.css` and `GET /api/events` (below).

## The fields and their rules

The rules are in `src/server/settings.ts`; the browser form adds nothing the server doesn't check. `PUT /api/admin/settings` replaces all three parts together: `clubName`, `privacyContact` (`name` and `email`) and `website` must all be sent, and any of the text can be empty, which means "not set". A refusal is a 400 `invalid_input` with a message per field (`clubName`, `website`, `privacyContact`, `privacyContact.name`, `privacyContact.email`).

Every text field is text, trimmed, at most the number of Unicode code points below, and can't contain unpaired surrogates, control characters, line or paragraph separators (U+2028, U+2029) or the invisible and direction-changing characters the booking names also refuse (soft hyphen, zero-width space, left-to-right and right-to-left marks, bidi controls, word joiner, invisible operators, BOM). Zero-width joiners are allowed.

| Field | Limit | Extra rule |
| --- | --- | --- |
| Club name | 80 | None. |
| Privacy contact name | 100 | A name with no email is refused ("A privacy contact needs an email address."). |
| Privacy contact email | 254 | One plain address: letters and digits (any script) and `. _ + -` before the `@`, a domain with at least one dot, nothing else. No spaces, quotes, angle brackets, commas, semicolons or parentheses, so it can't be a list or a `Name <a@b.c>` form. |
| Website | 200 (after normalising) | Must start with `https://` (any case) and have no whitespace; `http:`, `javascript:`, `data:`, `//host` and a bare host are refused. It must parse as a URL with a host, and may not contain a user name or password. It is stored in the parser's normalised form (`url.href`, so a bare host gains a trailing `/`). |

The privacy contact counts as **set once it has an email**. The name alone is never enough, and `/api/settings` returns `privacyContact: null` until there is an email.

## Where each setting is used

- **Club name**
  - The header band at the top of every public and admin page (the name links to `/` on public pages and to `/admin/` on admin pages), and the page title (`<page> – <club>`; the page alone if no name is set; "Slot booker" is the fallback name in the header).
  - The first line of the calendar entry's description in the booking's `.ics` download (`src/core/ics.ts`, `src/server/ics.ts`).
  - The first line of the **Copy lineup** text (`src/core/lineup.ts`, built in `src/server/admin-event-edit.ts`).
  - The first line of the new-event WhatsApp message on the admin "new event" page (`whatsappMessage` in `public/lib.js`). If the settings haven't loaded when the message is built, it has no club line.
  - With no name set, all three texts are as they were before this feature.
- **Logo**: in the header band next to the name, and as the browser tab icon on every page through `<link rel="icon" href="/api/logo">` (so the favicon is derived from the logo; with no logo that URL is a 404 and the browser shows no icon). The header image has an empty `alt`, because the club name sits next to it.
- **Website**: a footer link on the public and admin pages showing the host name, opening in a new tab with `rel="noopener noreferrer"`. `public/branding.js` re-checks that it is an `https:` URL before using it.
- **Privacy contact**: a line at the end of the booking form's "Privacy" section, after the privacy notice: "Questions about your details, or want them deleted? Contact <name>, <email>." The email is a `mailto:` link, encoded so nothing in it can add a header or body.
- **Landing page** (`/`, `public/index.html`, `public/landing.js`): the club name as the heading, the header band, and the list of upcoming events.
- **Theme colours**: every page, through `/api/theme.css` (below).

If `/api/settings` can't be read, pages carry on without branding (default name, no logo, no contact).

### The admin warning when no contact is set

Until a privacy contact has an email, the booking page shows an "Admin notice" at the top, with a link to Settings, saying bookers aren't told who to contact about their details. Only an admin should see it, and the page decides that this way (`warnAdmin` in `public/booking.js`):

1. The page loads `/api/settings`. If that failed, it doesn't know, so it shows nothing. If a contact is set, it shows nothing and does nothing else.
2. If no contact is set, it makes **one** request to `/api/admin/session` with the browser's cookies. Only a plain `200` that was not redirected counts as "signed-in admin". A `401`, any redirect, or a network failure shows nothing.
3. No contact is shown to anyone else. Visitors who aren't admins see no warning and no placeholder.

Consequences:

- While the contact is unset, **every visitor's browser makes that request** on every booking-page view. Under the password provider it is answered with `401` (visible in the browser's network tab and counted as a Functions request). Setting the contact removes it.
- Under Cloudflare Access, an unauthenticated visitor's request is redirected to the team's `cloudflareaccess.com` sign-in host. That is a different origin, and the page's CSP (`connect-src 'self'`) blocks it, so the request fails and the failure is swallowed. The `redirected` check covers the case where a redirect is followed within the same origin. I have not run this against a real Access deployment.
- The probe only decides whether to show a banner. It grants nothing: the session endpoint and the rest of the admin API still enforce their own checks.

## What the public can read

`GET /api/settings` (`Cache-Control: no-store`) returns exactly these keys:

- `clubName`: string or `null`
- `website`: string or `null`
- `privacyContact`: `{ name, email }` or `null` (`null` until there is an email)
- `logo`: `{ url, width, height }` or `null`

No timestamps, theme values or hashes (the `?v=` in the logo URL is the first 16 hex characters of the logo's SHA-256). Note that the privacy contact's email address is readable by anyone who requests this URL, not only people on the booking page: it is meant to be shown to bookers, but it is not hidden from others.

`GET /api/events` (`Cache-Control: no-store`) returns `{ "events": [ ... ] }` where each event has exactly `slug`, `name`, `startUtc` and `endUtc`. It lists events that are not archived and have not started yet, soonest first, at most 50. It has no venue, details, cost, counts or ids.

**Privacy trade-off.** Before the landing page, an event's booking link (`/e/<slug>`) was known only to people who were given it. Now the booking links of all upcoming, non-archived events can be discovered by anyone who opens `/` or requests `/api/events`. This was a decision by the maintainer, for a page that lists what is open. If an event should stay reachable only by link, this app currently has no way to hide it from the list other than archiving it, which also closes it to bookings (an archived event's link still works but shows it closed). `public/_headers` sets `X-Robots-Tag: noindex` on the static pages and the API responses carry it too, which asks search engines not to index them; that is a request, not access control. I have not checked that Pages applies `_headers` to `/` on a deployed site.

Every page view now also makes Functions requests (`/api/settings`, `/api/theme.css`, and `/api/logo` unless cached), where before the static pages made none. I have not measured what that means for the Free plan's request allowance.

## The logo

**In the browser** (`public/admin/logo-image.js`; a convenience, not the gate): the file picker accepts PNG, JPEG or WebP; anything over 20 MB is not decoded. The picture is drawn onto a canvas scaled to fit within 512 px on its longest side (never enlarged), and exported as WebP at quality 0.9, then 0.8, 0.7 and 0.5 until it is 200 KiB or smaller; if still too big the size is cut to 75% and the loop tries again, up to four times, before giving up with a message. A browser that can't export WebP hands back PNG, which is accepted as is and shrunk instead of re-compressed. The result is shown as a preview and is not saved until **Use this logo** is pressed. Decoding uses `createImageBitmap`, falling back to an `<img>` with a `data:` URL (the CSP does not allow `blob:`).

**On the server** (`PUT /api/admin/settings/logo`, `src/core/image.ts`; this is the gate). The body is JSON, `{ "data": "<base64>" }`, so the admin CSRF checks apply unchanged. In order:

1. Body at most 300,000 bytes, and the base64 text no longer than a 200 KiB image needs; otherwise 413 `too_large`. Only standard padded base64 (`+` and `/`) is accepted; anything else is a 400.
2. The type comes **only from the magic bytes**: PNG, JPEG or WebP. Nothing the client says about the file (name, type) is used. SVG, GIF, ICO, PDF, HTML and everything else are refused (422 `invalid_image`, reason `unsupported_type`), SVG because it can carry script.
3. Size cap 204,800 bytes (200 KiB), and empty files are refused.
4. The structure is walked end to end: PNG chunks to an `IEND` that ends exactly at the end of the file, JPEG markers to an `EOI` that is the last two bytes, WebP chunks that fill the RIFF size exactly. Trailing bytes, a second file or a truncated image are `corrupt`. A parse that runs off the buffer is `corrupt`, not an error.
5. Each side must be 1 to 512 pixels (reason `dimensions`).

The logo is then stored in `site_logo` (D1), with its type, size, dimensions and SHA-256. The table has its own CHECKs as a backstop (type allow-list, 1 to 204,800 bytes, sides 1 to 512). `DELETE` removes it, and removing a logo that isn't there is not an error.

**Serving** (`GET` or `HEAD /api/logo`, `functions/api/logo.ts`):

- `Content-Type` is the stored, allow-listed type, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so the response can't be sniffed into something else or run as a page.
- `ETag` is the SHA-256. A request with a matching `If-None-Match` gets `304` from the row's metadata without reading the image.
- Pages use `/api/logo?v=<first 16 hex of the SHA-256>`. When `v` matches the current logo the response is `Cache-Control: public, max-age=31536000, immutable`; otherwise (including the bare `/api/logo` used for the favicon) it is `public, max-age=300`. A new logo gives a new `v`, so the long lifetime is safe for the header image. The favicon, using the bare URL, can show the old logo for up to five minutes.
- With no logo: 404 with `Cache-Control: no-cache`. Other methods: 405.

## The theme

Two colours: **main** (buttons, selected slots, the header band) and **accent** (links and outlined buttons). Defaults are `#0b5cad` for both, which is what `public/style.css` already used.

- **Presets** (`public/theme.js`): Ocean (the default), Forest, Berry, Ember, Teal and Slate, each with the same main and accent colour. Or pick any two colours with the colour pickers.
- **Hex only.** The only accepted input is `#rgb` or `#rrggbb` (any case, surrounding spaces allowed, 64 characters at most), stored as lower-case `#rrggbb`. The database CHECKs the same shape.
- **Text colours are chosen automatically.** The text on a main-colour fill (`--on-primary`) is white or the page's dark text colour (`#14181f`), whichever has more contrast. Nobody picks it.
- **Dark mode is derived automatically.** There is no second set of colours to enter. The main colour is lightened in 2% steps towards white until it reaches contrast 3 against the dark page and its button text reaches 4.5; the accent is lightened until it reaches 4.5 on both dark surfaces. The steps are fixed, so the same input always gives the same output. The last step is pure white, which passes every check below.
- **Contrast checks** (WCAG 2.x ratios, `checkTheme` in `public/theme.js`), run in both light and dark mode:
  - Blocking (a theme that fails any of these can't be saved): main text and secondary text on the page background and on cards (these depend only on the fixed page colours, so they are included for completeness), the button text on the main colour (4.5), and the accent on the page background and on cards (4.5).
  - Advice only (shown, does not stop a save): the main colour against the page background, ratio 3, so buttons stand out (`button-shape-light` and `button-shape-dark`).
  - Ratios are shown rounded down, so a displayed 4.5 is never a fail.
- **The server enforces the block.** `PUT /api/admin/settings/theme` runs the same `checkTheme` (the same file is imported by the browser and the Functions). Non-hex colours are a 400 `invalid_input` with a message per colour. A failing blocking check is a 422 `theme_contrast` with the failing checks (`id`, `label`, `mode`, `ratio`, `min`). The form disables Save for the same reason, but that is a convenience. `DELETE` goes back to the default theme.
- **`/api/theme.css`** (`functions/api/theme.css.ts`) is the stylesheet every page loads. It is built only by `themeCss`, which accepts nothing except colours that passed `normaliseHex` and concatenates them into constant text, so no administrator-supplied string reaches the CSS. The query string is never read. What is stored is checked again on every read (`loadTheme`): a value edited into the database by hand that isn't a valid hex pair, or fails a blocking check, is served as the default theme. If the database read fails, the default colours are served with `no-store` instead of an error. It sends `Cache-Control: no-cache` with an `ETag`, so browsers revalidate and get `304` when nothing changed.
- **CSS variables**: `--primary`, `--on-primary` and `--accent`, in `:root` for light and inside `@media (prefers-color-scheme: dark)` for dark. `public/style.css` declares the same three variables with the values the default theme produces, in both modes, so pages look right if `/api/theme.css` fails to load. `public/theme.test.ts` compares the fixed page colours that `public/theme.js` uses with those in `style.css`. No test compares the three fallback variables with the default theme's output; I checked by hand that `themeCss(DEFAULT_THEME)` gives `#0b5cad / #ffffff / #0b5cad` for light and `#1563b0 / #ffffff / #4f8ac4` for dark, the same as `style.css`.
- **No inline styles.** The CSP in `public/_headers` is `style-src 'self'` (no `'unsafe-inline'`), and the admin form follows that: the preview panels set their colours with the CSSOM (`element.style.setProperty`), which the CSP allows, rather than `style` attributes or `<style>` blocks. After a save, the page re-points its own stylesheet link at `/api/theme.css?v=<time>` so the change shows without a reload.

## Known limits

- **The header name doesn't refresh after saving the club name.** The Settings page's preview panels follow what you type, but the header band and the title keep the old name until the page is reloaded. (The logo is likewise shown in the header as loaded.)
- **Settings changes are not logged anywhere.** There is no audit-log table, so there is no record of who changed the name, contact, logo or colours, or when (`updated_at` holds only the last change time). The control is that every settings route is admin-only and CSRF-protected, which the tests assert (`functions/api/admin/settings/access-control.test.ts`).
- **`PRIVACY_NOTICE` still works.** The settings page's privacy contact is appended under whichever notice is in use, the default or the club's own. A club that already names a contact in its own `PRIVACY_NOTICE` will therefore show two (see `docs/configuration.md`).
- **One logo, one theme, one set of details.** No per-event branding, and no history of earlier logos.
- **The logo favicon can lag by up to five minutes** after a change (see "Serving").

## Not verified

- **Remote D1.** All of this was run against local D1 under `wrangler pages dev` and in the tests, not against a remote database. I have not verified how remote D1 returns a BLOB (the code accepts an array of numbers or an `ArrayBuffer`), that a 200 KiB BLOB fits its row and parameter limits, or that the migration's `GLOB` CHECKs apply as written (D1 limits `GLOB` patterns to 50 bytes, which is why the colour pattern is split in two).
- **CPU on Workers Free.** Reading the logo (a BLOB up to 200 KiB converted from D1's result) and the upload path (base64 decode, structure walk, SHA-256, insert) have not been timed on real Workers, and local workerd does not enforce the 10 ms CPU limit. `GET /api/logo` is the likeliest to matter, because every first view of a page that doesn't have the logo cached reads it.
- **Cloudflare Access.** The admin-only banner probe under Access (above) was reasoned from the code and its tests, not seen against a real Access application.
- **Request volume.** The extra Functions requests per page view have not been measured against the Free plan allowance.
- **Real browsers.** Checking the settings page, the logo upload from real image files, the previews and the contrast messages in an actual browser is reported separately; this page doesn't claim it.
