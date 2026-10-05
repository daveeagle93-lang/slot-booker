# Admin guide

Setting up or moving the site is covered in [deploying.md](deploying.md) and [handover.md](handover.md); this guide is for running it day to day.

It is written for a club organiser using a phone. Every button name below is in "quotes", exactly as it appears on screen. All times are London time, whatever your phone is set to.

## Contents

1. [Signing in](#1-signing-in)
2. [Club settings and branding](#2-club-settings-and-branding)
3. [Creating an event](#3-creating-an-event)
4. [Sharing to WhatsApp](#4-sharing-to-whatsapp)
5. [Fixing bookings](#5-fixing-bookings)
6. [Editing an event](#6-editing-an-event)
7. [The lineup](#7-the-lineup)
8. [Exporting bookings](#8-exporting-bookings)
9. [Archiving, deleting and clearing out old events](#9-archiving-deleting-and-clearing-out-old-events)
10. [If something looks wrong](#10-if-something-looks-wrong)

## 1. Signing in

This part gets you into the admin pages and tells you what to do when you are signed out.

There are two ways to sign in. Which one you have depends on how your club's site was set up.

### The password screen

You will see a page called "Admin sign-in".

1. Open the admin page.
2. Tap the box labelled "Admin secret".
3. Type or paste the password your club was given.
4. Tap "Sign in".

You land on the events page. A wrong password gives a short message saying it isn't right. Too many wrong tries in a row gives "Too many attempts. Try again in" some minutes. Wait, then try again.

The password is long and random. Keep it in a password manager and paste it. Spaces before or after it are ignored.

If you tap an admin link in a chat app and land on the sign-in page, wait a moment. If you are already signed in, it takes you straight on.

### The emailed code

You type your email address and a one-time code is emailed to you. Type the code in to get in.

That screen belongs to a separate sign-in service, not to this app. I can't show you exactly what it looks like.

If no code arrives:

1. Check your junk folder.
2. Ask whoever looks after the site's setup to check that your email address is on the allowed list.

If you see "Sign-in is handled by your organisation's Cloudflare Access login. Open the admin pages from the link you were given.", use the admin link you were given instead of the address you typed.

### How long you stay signed in

With the password screen, you stay signed in for up to 8 hours from the moment you sign in. Using the pages does not add time.

With the emailed code, whoever set up the site chose the length. I can't see it from the code. Ask them if it matters.

When your time runs out, the next thing you tap takes you back to the sign-in page. Sign in again. Anything you had typed but not saved is likely to be lost.

To sign out yourself, go to the events page and tap "Sign out".

### Forgot the password

Ask whoever looks after the site's setup. Changing the password is their job. They can find the steps in the section on changing the password in [handover.md](handover.md#4-changing-the-password-or-signing-everyone-out-password-mode-only).

## 2. Club settings and branding

This part is for the club name, contact details, logo, colours and icons. Tap "Settings" at the top of the events page. Each part has its own save button.

### Club details

1. Tap the "Club name" box and type your club's name. It shows in the page header, the browser tab, calendar entries and the lineup.
2. Fill in "Privacy contact name" and "Privacy contact email".
3. If you want a link to your own site, fill in "Website (optional)". It must start with https://.
4. Tap "Save details".

You should see "Club details saved." If a box has a problem, you see "Not saved. Check the highlighted fields."

The header at the top may keep the old club name until you reload the page.

### Why the privacy contact matters

People booking give their name and their dog's name. The booking form tells them who to contact about those details, and that is the privacy contact. The contact only counts once it has an email address.

If no contact is set, you will see a warning at the top of the booking page when you are signed in. It starts "Admin notice (the people booking can't see this)". Other people do not see it. It has a link to "Settings".

### Logo

1. Tap "Choose a logo".
2. Pick a picture. Use a PNG, JPEG or WebP picture. Other kinds, such as SVG, are refused.
3. Wait for the preview. Your phone shrinks the picture for you to fit within 512 pixels and under 200 KB.
4. Check the preview, then tap "Use this logo".

Nothing is saved until you tap "Use this logo". You should then see "Logo saved."

A picture over 20 MB is refused. Pick a smaller one.

To take the logo away, tap "Remove logo", then "Yes, remove logo". The pages then show only the club name.

### App icons and the home screen icon

You do not make the icons yourself. When you save a logo, the page draws the little icons for browser tabs and phone home screens from it, on your main colour.

1. Save a logo.
2. Stay on the page. You see "Updating app icons…".
3. Wait for "App icons updated."

If it says it couldn't update the icons, the logo itself is still saved. Open the Settings page again and it tries again by itself.

If you leave early, it also tries again next time you open Settings.

Browser tab icons can take a few minutes to change. An icon already on a home screen may keep the old picture. I'm not sure when phones refresh it.

To put the admin page on your phone's home screen:

1. Open the admin page in your phone's browser.
2. Use your browser's Add to Home Screen option.

### Colours

The page offers two colours. "Main colour" is for "Buttons, selected slots and the header band." "Accent colour" is for "Links and outlined buttons."

1. Optionally tap a preset under "Start from a preset". The presets are Ocean, Forest, Berry, Ember, Teal and Slate.
2. Or tap "Main colour" or "Accent colour" to pick your own.
3. Look at the Light and Dark previews. Dark mode lightens your colours for you.
4. Tap "Save colours".

You should see "Colours saved."

To go back to the starting colours, tap "Reset to default colours".

#### The contrast checks

Contrast means how well one colour stands out from another. Text needs to stand out so people can read it.

Under the previews you see either "All contrast checks pass." or a list.

- "These colours can't be saved yet:" means some text would be hard to read. "Save colours" stays switched off. Try a darker main or accent colour.
- "Advice (you can still save):" means your main colour is a bit faint against the page. Buttons may not stand out much. You can still save.

## 3. Creating an event

This part walks through the form for a new event.

1. On the events page, tap "Create event".
2. Fill in the form, using the notes below.
3. Tap "Save event".

You can edit the event afterwards, so a slip is easy to fix.

### The fields

- "Event name". Up to 100 characters.
- "Date". It must be in the future, and not more than two years away.
- "Start time" and "End time". The end must be after the start, so an event can't run past midnight. On the two nights when the clocks change, a time that doesn't exist, or happens twice, is refused with a message.
- "Session length (minutes)". How long each person gets. From 1 to 480.
- "Gap between sessions (minutes)". Time left after each session before the next starts. From 0 to 120. With 20-minute sessions and a 5-minute gap, slots start at 09:00, 09:25, 09:50 and so on.
- "Cost (£)". Type 12 or 12.50. Type 0 if it's free. People then see "Free".
- "Venue postcode". 2 to 10 letters and numbers. People see it as a link to a map.
- "Details (optional)". Up to 2000 characters. People see it on the booking page and after they book. A good place to say how to contact you to change a booking.
- "Listed on the home page". Ticked by default. See below.

An event can have at most 500 slots.

### Schedule preview

Once the date, times, session length and gap are filled in, a "Schedule preview" appears. It says how many slots there are and lists the start times. Check it before you save. Until then it says "Fill in the highlighted fields to see the schedule."

### Breaks

A break is a time with no slots, such as lunch.

1. Tap "Add break".
2. Fill in "Start" and "End".
3. Optionally fill in "Name (optional)". The box shows Lunch as an example.
4. Tap "Remove" on a break to take it out.

A break must sit inside the event. You can add up to 20.

What a break does to the slots:

- A session that would run into the break is left out.
- The time before the break is simply unused.
- Sessions start again when the break ends.

### Near-miss suggestions

Sometimes a break cuts off a session by only a few minutes. The page notices and offers a fix.

You see a question like "Move Lunch to 12:10–13:10 to keep the 11:50 session?" It appears when a session would be dropped because it overlaps the start of a break by 10 minutes or less. The suggestion moves the break later, with the same length, so the session fits.

It is only offered if the moved break would not clash with another break or run past the end.

You choose:

- "Move break" puts the new break times into the form and updates the preview.
- "Keep as it is" hides the suggestion.

Neither saves anything. You can also ignore the suggestion.

### Listed on the home page

The home page lists upcoming events. Untick "Listed on the home page" and the event stays off that list. Its link still works, and anyone with the link can still book. Use this for an event you only want to share with certain people.

Only events that have not started yet are on the home page, whether or not they are listed. Archived events are not on it either.

An event that is not listed shows a "Not listed" label in your admin pages.

### After you save

You see "Event created", with the event name and the sharing tools in the next section.

On the events page, the event now appears under "Upcoming events". It shows a "Bookings open" label and how many slots are booked.

## 4. Sharing to WhatsApp

This part is for getting the booking link to your members.

After you save, the "Event created" page has two boxes.

### The link

1. Find the box labelled "Booking link".
2. Tap "Copy link".
3. You see "Copied".

If it can't copy, the link is selected for you. Copy it by hand.

You can copy the link later too. On the events page, tap "Copy booking link" on the event.

### The message

The box labelled "WhatsApp message" holds ready-made text. It has these lines:

1. Your club name, if you have set one.
2. The event name.
3. The date and time range.
4. The venue postcode.
5. The cost.
6. A last line with the booking link.

The details text is not included.

Tap "Copy message" and paste it where you want it. Or tap "Open in WhatsApp". It opens WhatsApp with the message ready. I haven't tried this on a phone. If it doesn't work, use "Copy message".

To make another event, tap "Create another". To leave, tap "Back to events".

### What people booking see

1. They open your link and see the event name, date, time, venue and cost.
2. Under "Pick a time" they see the free slots. Slots already taken are hidden. Slots that have started show "Started".
3. They tap a time.
4. They fill in "Dog's name" and "Handler's name".
5. They tap the confirm button, which says "Confirm booking for" and the time.

They then see "You're booked in", with "Copy booking" and "Add to calendar". The page tells them to keep the details, because there is no way to look a booking up again.

People can't change or cancel a booking online. The page tells them to contact the organiser. You do it for them, as in the next section.

## 5. Fixing bookings

This part is for adding, moving, swapping and removing bookings yourself.

1. On the events page, tap "Schedule" on the event.
2. Find the time you want. Each row shows a time and either "Free" or the dog and handler.

Breaks show too, in time order.

After each action the page reloads the list so you see what is really saved. A line at the top says what happened.

### Add a booking for someone

1. On a free row, tap "Add booking".
2. Type "Dog's name".
3. Type "Handler's name".
4. Tap "Add booking".

### Move a booking

1. On the booking, tap "Move".
2. Under "New slot", tap "Choose…" and pick a free time.
3. Tap "Move booking".

If nothing is free you see "There are no free slots to move it to."

### Swap two bookings

1. On one of the bookings, tap "Swap".
2. Under "Swap with", pick the other booking.
3. Tap "Swap bookings".

Each person keeps their own booking. They just trade times.

### Remove a booking

1. On the booking, tap "Clear".
2. Read "Clear this booking?"
3. Tap "Clear booking".

The person is not told. The page says "They won't be told. You need to let them know."

### Rules and clashes

- You can add or move bookings after bookings have closed, and into slots that have already started. This is meant for sorting out the day itself.
- A slot holds one booking. If it is taken, you see "That slot is already taken by" the dog and handler. The list refreshes.
- A dog and handler can only have one booking per event. Capital letters and extra spaces do not make a name different. If they already have one, you are told which time.
- If someone else changed things while you were working, you see "That changed while you were working. The schedule has been refreshed."
- Names have the same rules as when people book. See [If something looks wrong](#10-if-something-looks-wrong).

### Bookings with no slot

If an edit leaves a booking on a time that is no longer a slot, a list called "Not in the schedule" appears. The page says "Move them to a free slot or clear them." These bookings have "Move" and "Clear" only.

## 6. Editing an event

This part covers changing an event, and what you are warned about when bookings would be removed.

1. On the events page, tap "Edit" on the event. On a past event, open "Schedule" and tap "Edit event".
2. Change what you need. The form is filled in for you.
3. Tap "Save changes".

You can change everything on the creation form. You can also edit an event that has already started.

### Changes that are safe

Name, cost, venue postcode, details and "Listed on the home page" do not touch bookings. Changing "Listed on the home page" gives no warning and does nothing to bookings. It only decides whether the event shows on the home page.

### Changes that can remove bookings

Date, times, session length, gap and breaks change the slots. A booking is affected when its start time is no longer one of the event's slots.

The page warns you while you edit. Under "Schedule preview" you see a count, such as "1 booking is on slots this change removes:". Then you see each person, like "10:05 — Rex — Sam Smith". It adds "You'll be asked to confirm before anything is removed."

When you tap "Save changes" with affected bookings, nothing is saved yet. You see a screen headed "Saving will remove" a number of bookings, "Tell these people to rebook:", with the list.

- Tap "Remove 1 booking and save" to go ahead. The wording shows the real number.
- Tap "Cancel" to go back. Nothing has changed.

If a new booking appears while you are editing, you see "Another booking has appeared since you checked, so please check the list again."

### After saving

You see "Saved." If bookings were removed, you also see "Removed bookings: tell these people to rebook". The people are not told for you.

1. Tap "Copy list". It copies lines like "Please rebook: 10:05 — Rex — Sam Smith".
2. Paste it into your chat.

There are also "Back to events" and "Open the booking page" buttons.

## 7. The lineup

This part is for sharing the running order with names.

1. On the events page, tap "Schedule" on the event.
2. Tap "Copy lineup". You see "Copied".

If it can't copy, a box appears with the text. Copy it from there.

The text looks like this:

1. Your club name, if set.
2. The event name.
3. The date, then a dot, then the venue postcode.
4. A blank line.
5. One line per slot, in time order. A booked slot shows the time, the dog and the handler. A free slot shows the time and "free".
6. Breaks show where they fall, with their start and end times and their name. An unnamed break shows as "Break".

Paste it into a group chat such as WhatsApp. The booking form's usual privacy note tells people that the running order, with names, may be shared with other people taking part.

Names appear as typed. If a name has star, underscore or tilde characters, WhatsApp may turn part of the message bold, italic or struck through.

Bookings that are not in the schedule are left out.

## 8. Exporting bookings

This part gives you a spreadsheet of one event's bookings.

1. On the events page, tap "Schedule" on the event.
2. Tap "Download CSV".

You get a file ending in -bookings.csv. Open it in Excel, Google Sheets or Numbers.

It has four columns: "Time", "Dog", "Handler" and "Booked at". Times are London time. It lists the bookings only, in time order. It does not include free slots, the event settings or breaks.

Some names may start with a mark like an apostrophe. That happens when a name begins with a symbol such as =, +, - or @. It is on purpose. It stops a spreadsheet from treating the name as an instruction. The name itself is unchanged.

The file holds people's names. Keep it private. Do not post it in a chat or email it around. Delete it when you have finished.

## 9. Archiving, deleting and clearing out old events

This part is for tidying up. Save an export first if you may need the names later.

### Archive

On the events page, tap "Archive" on an event.

- The event leaves "Upcoming events" and moves to the "Archived" part of the page.
- It is off the home page.
- Its booking link still opens, but it shows "Bookings closed".
- All bookings are kept.

Archived events show only "Unarchive" and "Delete…". There is no "Schedule" or "Edit" there. To use them again, tap "Unarchive".

### Delete one event

Deleting is permanent. The event and all its bookings go. They can't be brought back. Download the CSV first if you may need the names.

1. Tap "Delete…" on the event.
2. Read the warning. It says how many bookings will go.
3. Under "Type the event name to confirm", type the name exactly as shown.
4. Tap "Delete event".

You should see "Deleted" with the event name and the number of bookings. Anyone using the old link is told "We couldn't find that event. Check the link you were sent."

### Clear out past events

On the events page, tap "Past" to open it. It lists events that have ended and are not archived.

1. Tick the events you want to remove. Or tick "Select all".
2. Tap "Delete selected" and the number.
3. Read the list and the warning.
4. Type DELETE under "Type DELETE to confirm".
5. Tap "Delete events".

You see how many events and bookings went. If something could not be deleted, it is listed with the reason.

Only the 100 most recent past events are shown. Delete some to see more.

Archived events are not part of this. This is a known limit. Delete archived events one at a time with "Delete…". Nothing reminds you. If you plan to clear out in bulk, leave old events in "Past" rather than archiving them.

### Keep it tidy

The booking form's usual privacy note says details are kept until an organiser deletes the event. Nothing is deleted automatically. So delete old events once you no longer need them.

## 10. If something looks wrong

This part lists what you might see and what to do.

- **The page sends you to the sign-in page.** You were signed out. Sign in again. See [Signing in](#1-signing-in).
- **A booking looks wrong.** Open "Schedule" for the event. Use "Move", "Swap", "Clear" or "Add booking". See [Fixing bookings](#5-fixing-bookings).
- **A name was refused.** Messages like "The dog's name can't contain invisible or direction-changing characters." mean the name has a hidden mark in it. This happens with text pasted from elsewhere. It also happens with some emoji that are joined together with an invisible joiner. Some names in certain scripts need a joiner and are refused too. Retype the name by hand. For an emoji, pick a single plain one. The same rule applies to event names, break names, details, the club name and the contact details.
- **The logo won't upload.** Use a PNG, JPEG or WebP picture under 20 MB. A message says if it is the wrong type, too big, or can't be read. Try a simpler picture.
- **The icons didn't update.** Open the Settings page again and wait for "App icons updated."
- **An event isn't on the home page.** Edit it and check that "Listed on the home page" is ticked. The home page also only shows events that have not started, and not archived ones.
- **The booking page says "Bookings for this event are closed."** Bookings close when the event starts, unless the people who set up the site chose another closing time. They can set it earlier or later. An archived event is closed too. A session that has started shows "Started" and can't be picked. You can still add the booking yourself under "Schedule". See [Fixing bookings](#5-fixing-bookings). If it is archived, tap "Unarchive".
- **Anything else, or the site won't load.** Contact whoever looks after the site's setup. The steps they follow are in [handover.md](handover.md).
