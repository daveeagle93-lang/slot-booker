# Configuration

The booking API reads two optional settings from Pages environment variables. (The admin sign-in settings, `ADMIN_AUTH` and the rest, are separate: see `docs/admin-auth.md`.) They are plain text, not secrets, and both have defaults, so a deployment works without setting either.

| Name | Meaning | Default | Example |
| --- | --- | --- | --- |
| `BOOKING_CUTOFF_OFFSET_MINUTES` | When bookings close, in whole minutes from the event's start time. Positive keeps bookings open that many minutes after the start; negative closes them earlier. A request at exactly the closing time is refused. Whole numbers from -10080 to 10080 (one week) are accepted; anything else is ignored with a warning in the logs. | `0` (closes at the start) | `-30` closes half an hour before the start |
| `PRIVACY_NOTICE` | The text shown under "Privacy" on the booking form. Plain text only (no HTML). A blank line starts a new paragraph. Leading and trailing whitespace is removed, and anything over 1000 characters is cut off with a warning in the logs. Blank means the default. | See below | `We use your details to run the event.\n\nEmail us to have them deleted.` |

A slot can be booked only while the booking window is open and the slot's own start is still in the future. A request at exactly the slot's start is refused, like a request at exactly the closing time. So with a positive offset, bookings stay open after the event has begun but only for the slots that haven't started: the page shows started slots as unavailable, and the API answers a request for one with 409 `slot_started`. A retry of a booking that was already saved is still answered after the window closes or the slot starts, so a booker whose response was lost still gets their confirmation.

The default privacy notice is:

> We store your name, your dog's name and the slot you choose so the club can run the event. The club's organisers can see these details; other people using this page only see which slots are taken. The details are kept until an organiser deletes the event; nothing is deleted automatically.

The last sentence describes what the app really does. Organisers can delete one event, or clear out several past events at once, from the admin list (see "Archiving and deleting" in the README), which removes its bookings too; nothing is ever deleted automatically. If your club promises something different, such as deleting everything within a set time, change the text and make sure the club keeps that promise by hand.

The default names no data controller and gives no contact. Clubs should add their own (UK GDPR transparency: who is responsible for the data and how to reach them) by setting `PRIVACY_NOTICE`.

## Setting them

- For a deployment, under `vars` in the git-ignored `account.local.json`, then run `npm run configure` (`docs/deploying.md`, step 3):

  ```jsonc
  "vars": { "BOOKING_CUTOFF_OFFSET_MINUTES": "-30" }
  ```

  Values are strings. The script writes them into both the top level and `env.preview` of the generated `wrangler.json`, because `vars` is not inherited by `env.preview`. (Without the script, put the same `vars` block in both places in `wrangler.jsonc`, but then your settings are in a committed file.)
- Locally, put them in `.dev.vars` (see `.dev.vars.example`). Restart `npm run dev` after changing it.

This project uses a Wrangler configuration file, which Cloudflare's [Pages configuration docs](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) say becomes the source of truth: "you cannot edit the same fields in the dashboard once you are using this file". So set deployed variables through the config file (`account.local.json` and `npm run configure`) and redeploy, rather than in the dashboard. (Redeploying is the safe assumption; the docs don't say whether a variable change applies without a new deployment.)
