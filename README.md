# slot-booker

A slot-booking app for small clubs that run a few events a year, such as a trial day with a few dozen timed slots. People book a slot on their phone with no account; admins create events and manage the bookings. It is written in TypeScript with a vanilla JavaScript front end (no build step) and runs on Cloudflare only: Pages, Pages Functions and D1, within the free tier. It is a template: each club deploys its own copy to its own Cloudflare account.

Status: work in progress.

## What it does

- Booking: a booker picks a free slot and enters a dog's name and a handler's name. A dog and handler pair can hold one slot per event. The booker gets a confirmation and an "Add to calendar" `.ics` file. Bookers cannot change or cancel online; they contact the organiser, and an admin moves or clears the booking.
- Events: date, start and end times, session length, gap, cost, postcode, details and breaks. The form previews the schedule and suggests fixes for near-miss settings.
- Sharing: a WhatsApp-ready message for a new event, and a plain-text lineup (running order) to paste into a chat.
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

## Admin sign-in

Two providers, chosen by configuration (`ADMIN_AUTH`):

- Cloudflare Access (one-time-PIN emails, a named identity per admin): only for a deployment served on a custom domain on a Cloudflare zone you control.
- A shared, generated admin secret: for a deployment reachable only on `*.pages.dev`, and for every preview.

This is a project rule that the Worker does not check. With Access on a `pages.dev`-only deployment, every admin request is answered 401. The planned setup wizard will enforce the rule; until then, follow it by hand. If `ADMIN_AUTH` is unset or wrong, admin pages fail closed with a 503. Details and the reasons: [docs/admin-auth.md](docs/admin-auth.md).

## Quick start

Prerequisites: a Cloudflare account (free plan) and Node 24 (the tests and typecheck pass here on v24.20.0).

```sh
npm install
npm test                   # unit and integration tests
npm run typecheck
npm run db:migrate:local   # local D1 under .wrangler/state
npm run seed               # adds a test event and prints its URL
npm run dev                # http://localhost:8788
```

Deploying to Cloudflare is a step-by-step runbook in [docs/deploying.md](docs/deploying.md). The `/admin/` pages need `ADMIN_AUTH` set; for local use see [docs/admin-auth.md](docs/admin-auth.md) and `.dev.vars.example`.

## Documentation

- [docs/deploying.md](docs/deploying.md): create the Cloudflare resources and deploy a preview.
- [docs/admin-auth.md](docs/admin-auth.md): the two sign-in providers, setup and limits.
- [docs/configuration.md](docs/configuration.md): configuration reference.
- [docs/branding.md](docs/branding.md): club settings, logo and theme.
- [docs/admin-guide.md](docs/admin-guide.md): how organisers use the admin pages.
- [docs/handover.md](docs/handover.md): handing a deployment over to a club.

## Status and roadmap

- Setup wizard: planned, not built. Setup is manual, following docs/deploying.md.

## Known limits

- **The admin event list builds each upcoming event's schedule in the Worker.** Measured in Node on a dev machine (not in workerd), a 500-slot event costs about 0.45 ms, so a list with around 20 events of that size could exceed the Free plan's 10 ms CPU limit. Typical events (about 30 slots) cost well under 1 ms each. Storing the slot count would remove the cost if it ever matters.
- **Booked counts and the Full badge count every booking row.** Bookings on slots that are no longer in the schedule (orphans) should no longer be creatable now that edits, swaps and public bookings are guarded, but legacy data could contain them, and they would be counted.
- **Archived events are not included in the Past bulk clear-out.** They can be deleted one at a time, and nothing reminds anyone to, so organisers should delete archived events they no longer need.
- **Names and club text refuse every Unicode format character** (category Cf), which includes the invisible joiners that emoji sequences and some scripts use. Plain emoji and accented names are fine. A dog's or handler's name must also contain at least one letter or number (so a name of only an emoji is refused), and invisible characters such as variation selectors and Hangul fillers are ignored when deciding whether two bookings are the same dog and handler.

## Workers Free plan

The Workers Free plan allows 10 ms of CPU per request. Local timings in the docs are comfortably under that, but they were not taken on real Workers, which does not apply the limit locally, so the fit is not verified there. The admin login, the logo read and the logo and app-icon uploads are the paths the docs flag (see [docs/admin-auth.md](docs/admin-auth.md) and [docs/branding.md](docs/branding.md)).

## Licence

Licence: to be decided. Add a `LICENSE` file before publishing.
