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

## Managing bookings

In the admin pages, the **Schedule** button on an event shows every slot and break in order (London time), with who has booked each slot. From there you can:

- **Add booking** to a free slot, on someone's behalf (a dog's name and a handler's name, checked by the same rules as the public form).
- **Move** a booking to a free slot, or **Swap** two bookings' slots.
- **Clear** a booking. This asks you to confirm first, and the server refuses to clear anything without that confirmation.
- **Copy lineup**, which puts the running order on the clipboard as plain text for pasting into a chat: the event name, the date and postcode, then every slot (booked ones with dog and handler, the rest as "free") and every break in time order. If the browser won't let the page copy, the text appears in a box with the text selected so you can copy it by hand.

Things to know:

- Admin actions skip the public booking rules: they work after the cut-off, on slots that have started and on an archived event. A slot must still be one of the event's current slots.
- Nothing notifies the person. If you move, swap or clear a booking, tell them yourself.
- A booking whose slot is no longer in the schedule is listed under "Not in the schedule", where it can be moved or cleared, so it can't hide.
- Each change is applied in one step and is checked at that moment: moving a booking to a slot someone else took a moment earlier, or an event that was edited while you were working, is refused and the page reloads the schedule. A swap that fails part-way changes nothing.
