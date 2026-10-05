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

Open the URL that `seed` prints. Each run adds a new event (nothing is wiped); pass `-- --no-bookings` to skip the sample bookings. The landing page at `/` lists the upcoming events with their booking links. The public booking page is at `/e/<slug>` (static files in `public/`, no build step); the raw event data is at `/api/events/<slug>`. To seed the remote preview database instead, see `docs/deploying.md` (`npm run seed -- --remote --env preview`).

## Landing page, club settings, logo and theme

The page at `/` shows the club's name and logo and lists the upcoming, non-archived events (at most 50, soonest first) with a link to each booking page. This means the booking links of upcoming events can now be found by anyone who opens `/`, where before only people given a link knew them; archiving an event removes it from the list (its link still works, showing it closed).

**First run: sign in, open Settings (the button on the admin list, `/admin/settings`) and set the privacy contact.** Until a contact with an email address is set, the booking page tells bookers nothing about who to contact, and it shows a signed-in admin a warning saying so.

On the Settings page an admin can set, without redeploying:

- **Club details**: the club name (page header, browser tab title, the calendar entry's description, the lineup text and the new-event WhatsApp message), a privacy contact (shown in the booking form's Privacy section) and an optional `https://` website (a footer link).
- **Logo**: a PNG, JPEG or WebP, resized in the browser to fit 512 px and under 200 KiB; the server checks the real file type, size and structure, and refuses SVG. It is stored in D1, shown in the page header, and used as the browser tab icon.
- **Colours**: a preset or two custom colours, with a live light and dark preview. Text colours and dark mode are worked out automatically, and colours that would make text hard to read (WCAG AA contrast) are refused by the server as well as the form.

Settings routes are admin-only and CSRF-protected like the rest of `/api/admin/*`; changes are not logged. The fields, validation rules, what is public, and what has not been verified are in [`docs/branding.md`](docs/branding.md).

## Editing an event

In the admin pages, the **Edit** button on an event changes its name, date, times, session length, gap, cost, postcode, details and breaks. The booking link stays the same. While you edit, the page shows which bookings sit on slots the new schedule no longer has. Saving then asks you to confirm, lists the people to tell to rebook, and deletes exactly those bookings in the same step as the change; if someone books one of those slots after you looked, nothing is saved and you are asked again. Adding slots never removes anything. If two admins edit the same event, the last save wins for the event's details (there is no version check); the bookings are still protected. An event that has already started can still be corrected, but its start can only move to a future date. A public booking made at the same instant as an edit is checked against the schedule when it is saved: if the edit removed the slot, the booker sees "That slot isn't available any more." and nothing is booked; if the edit left the slot in place, the booking is retried once automatically and goes ahead if the slot is still free (otherwise the booker gets the usual message for that case); if the event keeps changing under it, they see "The event was just changed. The times below are up to date; choose again." and the page refreshes the list of times. The event's detail API (`GET /api/admin/events/<slug>`) lists any booking on a slot the schedule no longer has under `orphans` rather than hiding it.

## Managing bookings

In the admin pages, the **Schedule** button on an event shows every slot and break in order (London time), with who has booked each slot. From there you can:

- **Add booking** to a free slot, on someone's behalf (a dog's name and a handler's name, checked by the same rules as the public form).
- **Move** a booking to a free slot, or **Swap** two bookings' slots.
- **Clear** a booking. This asks you to confirm first, and the server refuses to clear anything without that confirmation.
- **Copy lineup**, which puts the running order on the clipboard as plain text for pasting into a chat: the event name, the date and postcode, then every slot (booked ones with dog and handler, the rest as "free") and every break in time order. If the browser won't let the page copy, the text appears in a box with the text selected so you can copy it by hand.

Things to know:

- Admin actions skip the public booking rules: they work after the cut-off, on slots that have started and on an archived event. A slot must still be one of the event's current slots.
- Nothing notifies the person. If you move, swap or clear a booking, tell them yourself.
- A booker whose page retries the same request (for example after a dropped connection) gets their booking back rather than a second one. If you have cleared that booking in the meantime, the retry books the slot again if it is still free, so tell people before you clear their booking.
- A booking whose slot is no longer in the schedule is listed under "Not in the schedule", where it can be moved or cleared, so it can't hide. It can't be swapped: a swap needs both bookings to be on slots of the current schedule, otherwise the other booking would be left on a slot that doesn't exist.
- Each change is applied in one step and is checked at that moment: moving a booking to a slot someone else took a moment earlier, or an event that was edited while you were working, is refused and the page reloads the schedule. A swap that fails part-way changes nothing.

## Archiving and deleting

Events never delete themselves. The admin list has three sections: **Upcoming** (events that have not ended), **Past** (ended, not archived) and **Archived**. Past and Archived are collapsed by default and show the 100 most recent events each, with a note if there are more. Every event is in exactly one section, and archived wins over the date.

- **Archive** hides an event from Upcoming and Past without deleting anything: its bookings are kept and you can **Unarchive** it at any time. An archived event's public booking link still works, but shows the event as closed to bookings.
- **Delete…** permanently deletes one event with its breaks and all its bookings. It can't be undone. The page says how many bookings will go and asks you to type the event's name; the server checks the name exactly (capitals and spacing matter) and deletes nothing if it differs.
- **Clear out the Past section**: tick the past events (or Select all) and choose **Delete selected**. The page lists them with the total number of bookings and asks you to type `DELETE`. Only events that have really ended are deleted, all in one step; anything else you ticked is left alone and reported.
- Upcoming events show a **Full** badge when every slot is booked.

The default privacy notice says the details are kept until an organiser deletes the event, so clear out old events when you no longer need the bookings.

## Known limits

- **The admin event list builds each upcoming event's schedule in the Worker.** Measured in Node on a dev machine (not in workerd), a 500-slot event costs about 0.45 ms, so a list with around 20 events of that size could exceed the Free plan's 10 ms CPU limit. Typical events (about 30 slots) cost well under 1 ms each. Storing the slot count would remove the cost if it ever matters.
- **Booked counts and the Full badge count every booking row.** Bookings on slots that are no longer in the schedule (orphans) should no longer be creatable now that edits, swaps and public bookings are guarded, but legacy data could contain them, and they would be counted.
- **Archived events are not included in the Past bulk clear-out.** They can be deleted one at a time, and nothing reminds anyone to, so organisers should delete archived events they no longer need.
