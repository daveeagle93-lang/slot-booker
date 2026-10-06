[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<owner>/<repo>)

> **Maintainer:** replace `<owner>/<repo>` in the button link above with this repository's real GitHub address once it is public. Cloudflare's button only works for a public repository on github.com or gitlab.com ([Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)).

# slot-booker

A slot-booking app for small clubs that run a few events a year, such as a trial day with a few dozen timed slots. People book a slot on their phone with no account; admins create events and manage the bookings.

It is a template. Each club gets its own copy in its own Cloudflare account, on the free tier. The copy is one Cloudflare Worker (it serves the website and the booking API) plus one D1 database, written in TypeScript with a vanilla JavaScript front end and no build step.

Status: work in progress. The button has not been run end to end against a public copy of this repository, so the deploy steps below follow Cloudflare's documentation and this repository's code, and the points that are not confirmed are marked **unverified**.

## What the button will ask you for

Press the button, sign in to Cloudflare (a free account is enough) and connect your GitHub or GitLab account. Cloudflare then asks for:

- **Names:** a repository name, a Worker name and the database name. The suggested ones are fine. The Worker name becomes part of your site's address.
- **`SETUP_CODE`:** a private phrase you choose, at least 12 characters. You type it once, on your new site, to create your admin sign-in. Keep it to yourself and write it down somewhere safe.

That is all. Cloudflare creates the database, runs the migrations (the `deploy` script in `package.json`) and publishes the Worker. Cloudflare's docs say the button copies the code into your own GitHub or GitLab account and builds it there with Workers Builds.

What is **unverified** here: how the button treats the placeholder database id in `wrangler.jsonc`, whether the database prompt is keyed by `DB` in `package.json`'s `cloudflare.bindings`, whether the empty `SETUP_CODE=` line in `.dev.vars.example` shows as a prompt, and how `wrangler deploy` behaves inside Workers Builds when `env.preview` is defined and no `--env` is given (a warning appeared in a dry run). Step-by-step, with what you should see: [docs/deploying.md](docs/deploying.md).

## First run: `/setup`

Do this once the deploy has finished. A new site has no admin sign-in until you do.

1. Open `https://<worker-name>.<your-workers-subdomain>.workers.dev/setup` (find the address on the Worker's page in the Cloudflare dashboard).
2. Type your `SETUP_CODE` and press **Continue**.
3. The page shows your **admin secret**, 43 characters, **once**. Copy it into a password manager now.
4. Tick **I've saved it**, then press **Go to sign in**.
5. On the sign-in page, paste the secret into **Admin secret** and press **Sign in**.

Good to know:

- Until you first sign in successfully, `/setup` stays open and running it again **replaces** the secret (the old one stops working).
- After the first successful sign-in, `/setup` is closed for good (it answers 404).
- Only a hash of the secret is stored, in the `admin_credentials` table. The secret itself never is, so nobody can look it up for you.
- The setup code is limited to 5 attempts per 15 minutes per visitor (every attempt counts).
- If the secret is lost after the first sign-in, there is a recovery that needs your Cloudflare login: [If the admin secret is lost](docs/handover.md#if-the-admin-secret-is-lost).
- The `SETUP_CODE` has no other use afterwards, so it may stay where it is. It is what lets you run `/setup` again after a recovery.

If `/setup` says "Setup isn't ready" or an admin page says "Admin sign-in isn't set up.", see [Troubleshooting](docs/deploying.md#troubleshooting).

## Sign-in options

- **Setup secret (the default).** One shared admin secret, made on `/setup`. Nothing to configure: `wrangler.jsonc` already sets `ADMIN_AUTH=password`. Everyone who administers the club uses the same secret, there is no second factor and no per-person identity.
- **Cloudflare Access (the upgrade for a custom domain).** One-time-PIN emails and a named identity per admin. It needs a domain whose nameservers are managed by Cloudflare ([Cloudflare's migration notes](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) say custom domains require this). In your own copy's `wrangler.jsonc`, set the `vars` `ADMIN_AUTH` to `access`, plus `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, commit and push so the Worker redeploys, and create the Access application for your custom domain's hostname. Config `vars` overwrite values set in the dashboard on every deploy unless `keep_vars` is set ([Wrangler docs](https://developers.cloudflare.com/workers/wrangler/commands/workers/)); secrets are never deleted by a deploy.
  **Unverified:** whether the `Cf-Access-Jwt-Assertion` header reaches a Worker that serves static assets. Cloudflare's docs say `ctx.access` is not available for such Workers ([Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)) and say nothing about the header; the app checks the header itself. Test the sign-in after you turn Access on. Access can also protect `workers.dev` addresses ([workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)), but the recommendation stays a custom domain.

Details, settings and limits: [docs/admin-auth.md](docs/admin-auth.md).

## What it costs

A club's use should fit the free plans. Figures read from Cloudflare's documentation in September and October 2026; check the pages if it matters ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)).

- **Workers Free:** 100,000 requests a day to the Worker script and 10 ms of CPU per request. Static files served straight from `public/` (scripts, styles, icons) are free and unlimited.
- **What reaches the Worker:** `/`, `/e/*`, `/api/*`, `/admin`, `/admin/*` and `/setup`. So one view of a booking page costs about one Worker request plus a few API calls (settings, `theme.css`, events, icons and the manifest; the browser caches each for minutes).
- **If the daily limit is passed,** those requests get a 429 until the day resets, and static files keep working.
- **D1 Free:** 5 million rows read a day, 100,000 rows written a day, 5 GB of storage and 10 databases per account.

Whether a real admin sign-in fits the 10 ms of CPU is **unverified**: the timings in the docs were taken locally, and local `workerd` does not apply the limit. The paths the docs flag are the admin login, the logo read and the logo and app-icon uploads (see [docs/admin-auth.md](docs/admin-auth.md) and [docs/branding.md](docs/branding.md)).

## Link previews

`/` and `/e/<slug>` carry a page title and Open Graph tags (the event's name and London date, the club name, the venue postcode, the cost, and the 512 px icon), so a link pasted into WhatsApp shows a preview. Only what the public pages already show is used. An archived or unknown link gets generic tags. This has not been checked on real WhatsApp, which also caches a preview for each link.

## Keeping your copy up to date

The button makes a **copy**. Later changes to the template do **not** flow into your copy, and Cloudflare's docs describe no way for them to. To update, either:

- add the template as a git remote, merge it and push: `git remote add template <template-url>`, `git fetch template`, `git merge template/main`, `git push`. The migrations run on every deploy, so a merge and push applies any new ones. Expect a merge conflict if you or the button changed the database id lines in `wrangler.jsonc`: keep your own ids. Whether a push redeploys your Worker automatically is **unverified**; check in the dashboard; or
- deploy a fresh copy with the button and move your data across ([docs/handover.md](docs/handover.md)).

Details: [docs/deploying.md](docs/deploying.md#updating-your-copy).

## What it does

- Booking: a booker picks a free slot and enters a dog's name and a handler's name. A dog and handler pair can hold one slot per event. The booker gets a confirmation and an "Add to calendar" `.ics` file. Bookers cannot change or cancel online; they contact the organiser, and an admin moves or clears the booking.
- Events: date, start and end times, session length, gap, cost, postcode, details and breaks. The form previews the schedule and suggests fixes for near-miss settings.
- Event templates: saved sets of details, times, cost, breaks and a share message with placeholders (and a live preview), one of them the default. Picking a template fills the create-event form; each event keeps its own copy.
- Sharing: a Share button on upcoming events (the phone's share sheet, or Copy message and Copy link), and a plain-text lineup (running order) to paste into a chat.
- Admin booking management: add a booking, move it, swap two, or clear one.
- Editing an event warns which bookings sit on slots the new schedule no longer has, and lists the people to tell.
- Archive (reversible) and delete (typed confirmation), including a bulk clear-out of past events.
- Per-event bookings export as CSV.
- Listed and unlisted events: unlisted events stay off the landing page, but their link works.
- Club settings without redeploying: club name, logo, theme colours (WCAG AA contrast checked) and a privacy contact.
- App icons: a neutral default favicon, or square icons drawn in the browser from the club logo on the theme colour for the tab, a phone home screen and a web app manifest.
- A privacy notice on the booking form.

Design notes:

- Times are stored in UTC and shown in Europe/London.
- Money is whole pence.
- No tracking: no analytics or third-party scripts, and the Content-Security-Policy allows scripts from the site only.

## Screenshots

Screenshots: to come.

<!--
Intended files (not yet created):
![Booking page on a phone](docs/screenshots/booking.png)
![Booking confirmation](docs/screenshots/confirmation.png)
![Admin schedule](docs/screenshots/schedule.png)
![Settings page](docs/screenshots/settings.png)
-->

## Run it on your own computer

For developers. You need Node 24 (the tests and typecheck pass here on v24.20.0).

```sh
npm install
cp .dev.vars.example .dev.vars   # then put a SETUP_CODE of 12+ characters in it
npm test                         # unit and integration tests
npm run typecheck
npm run db:migrate:local         # local D1 under .wrangler/state
npm run seed                     # adds a test event and prints its URL
npm run dev                      # Wrangler prints the local address
```

Open `/setup` on the local address to make a local admin secret, as in "First run" above.

`npm run test:webkit` is an opt-in layout check for the date and time inputs on the create and edit event pages. iOS Safari gives those inputs a minimum width of their own, which once made them overflow the card and overlap on a phone, and Chromium never shows it. The script serves `public/` locally, stubs the API, loads `/admin/new` and `/admin/edit` at 320 and 390 px wide in Playwright's WebKit, and fails if an input leaves its field or card, a Start/End pair overlaps, or the page scrolls sideways.

It needs a machine where Playwright supports WebKit (`npx playwright-core install webkit` fetches the browser; Linux also needs its system libraries). Where WebKit can't launch, it prints `SKIPPED` and exits 2, so a skip is never mistaken for a pass; add `--allow-skip` to exit 0 instead. `--engine chromium` runs the same checks in Chromium, as a sanity check of the script only. It is not part of `npm test`.

To deploy from the command line instead of the button, see [docs/deploying.md](docs/deploying.md#advanced-deploy-from-the-command-line).

## Documentation

- [docs/deploying.md](docs/deploying.md): deploy with the button step by step, deploy from the command line, the maintainer's preview environment, updating and troubleshooting.
- [docs/admin-auth.md](docs/admin-auth.md): the two sign-in providers, setup and limits.
- [docs/configuration.md](docs/configuration.md): configuration reference.
- [docs/branding.md](docs/branding.md): club settings, logo and theme.
- [docs/admin-guide.md](docs/admin-guide.md): how organisers use the admin pages.
- [docs/handover.md](docs/handover.md): handing a deployment to a club's own Cloudflare account, what to keep safe, and what to do if the admin secret is lost.

## Known limits

- **The admin event list builds each upcoming event's schedule in the Worker.** Measured in Node on a dev machine (not in workerd), a 500-slot event costs about 0.45 ms, so a list with around 20 events of that size could exceed the Free plan's 10 ms CPU limit. Typical events (about 30 slots) cost well under 1 ms each. Storing the slot count would remove the cost if it ever matters.
- **Booked counts and the Full badge count every booking row.** Bookings on slots that are no longer in the schedule (orphans) should no longer be creatable now that edits, swaps and public bookings are guarded, but legacy data could contain them, and they would be counted.
- **Archived events are not included in the Past bulk clear-out.** They can be deleted one at a time, and nothing reminds anyone to, so organisers should delete archived events they no longer need.
- **Names and club text refuse every Unicode format character** (category Cf), which includes the invisible joiners that emoji sequences and some scripts use. Plain emoji and accented names are fine. A dog's or handler's name must also contain at least one letter or number (so a name of only an emoji is refused; "Rex 🐶" is fine), and invisible characters such as variation selectors and Hangul fillers are ignored when deciding whether two bookings are the same dog and handler.
- **There are no per-version preview URLs** (`preview_urls` is off in `wrangler.jsonc`): they would serve the whole app, admin included, on extra hostnames, and use the production database by default.
- **The booking API has no rate limiting or bot protection.** Only the admin sign-in and `/setup` count attempts. Add something like Cloudflare Turnstile before posting a link publicly.

## Licence

Licence: to be decided. Add a `LICENSE` file before publishing.
