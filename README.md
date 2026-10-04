# slot-booker

A lightweight slot-booking app for small clubs that run a handful of events each year, such as scent-training days with a few dozen bookable slots. It is designed to run entirely on the Cloudflare free tier and to be published as a template that each club can deploy to its own account.

Status: work in progress.

## Local development

Needs Node 24.

```sh
npm install
npm run db:migrate:local   # apply migrations to the local D1 (.wrangler/state)
npm run seed               # add a test event with sample bookings; prints its URL (alias: seed:local)
npm run dev                # serves on http://localhost:8788
npm test                   # also: npm run typecheck
```

Open the URL that `seed` prints. Each run adds a new event (nothing is wiped); pass `-- --no-bookings` to skip the sample bookings. The public booking page is at `/e/<slug>` (static files in `public/`, no build step); the raw event data is at `/api/events/<slug>`. To seed the remote preview database instead, see `docs/deploying.md` (`npm run seed -- --remote --env preview`).

## Editing an event

In the admin pages, the **Edit** button on an event changes its name, date, times, session length, gap, cost, postcode, details and breaks. The booking link stays the same. While you edit, the page shows which bookings sit on slots the new schedule no longer has. Saving then asks you to confirm, lists the people to tell to rebook, and deletes exactly those bookings in the same step as the change; if someone books one of those slots after you looked, nothing is saved and you are asked again. Adding slots never removes anything. If two admins edit the same event, the last save wins for the event's details (there is no version check); the bookings are still protected. An event that has already started can still be corrected, but its start can only move to a future date. One gap remains: a public booking that was already past its checks when the edit saved can still land on a removed slot in that same instant. The event's detail API (`GET /api/admin/events/<slug>`) lists any such booking under `orphans` rather than hiding it.
