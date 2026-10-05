# Configuration

The booking API reads two optional settings from Pages environment variables. (The admin sign-in settings, `ADMIN_AUTH` and the rest, are separate: see `docs/admin-auth.md`.) They are plain text, not secrets, and both have defaults, so a deployment works without setting either.

| Name | Meaning | Default | Example |
| --- | --- | --- | --- |
| `BOOKING_CUTOFF_OFFSET_MINUTES` | When bookings close, in whole minutes from the event's start time. Positive keeps bookings open that many minutes after the start; negative closes them earlier. A request at exactly the closing time is refused. Whole numbers from -10080 to 10080 (one week) are accepted; anything else is ignored with a warning in the logs. | `0` (closes at the start) | `-30` closes half an hour before the start |
| `PRIVACY_NOTICE` | The text shown under "Privacy" on the booking form. Plain text only (no HTML). A blank line starts a new paragraph. Leading and trailing whitespace is removed, and anything over 1000 characters is cut off with a warning in the logs. Blank means the default. | See below | `We use your details to run the event.\n\nEmail us to have them deleted.` |

A slot can be booked only while the booking window is open and the slot's own start is still in the future. A request at exactly the slot's start is refused, like a request at exactly the closing time. So with a positive offset, bookings stay open after the event has begun but only for the slots that haven't started: the page shows started slots as unavailable, and the API answers a request for one with 409 `slot_started`. A retry of a booking that was already saved is still answered after the window closes or the slot starts, so a booker whose response was lost still gets their confirmation.

The default privacy notice is:

> We store your name, your dog's name and the slot you choose so the club can run the event. The club's organisers can see these details; other people using this page only see which slots are taken. The organisers may share the running order, with names, with other participants (for example in a group chat). The details are kept until an organiser deletes the event; nothing is deleted automatically.

The third sentence covers **Copy lineup**, which puts the bookers' names into text that organisers paste into group chats. The last sentence describes what the app really does. Organisers can delete one event, or clear out several past events at once, from the admin list (see "Archiving and deleting" in the README), which removes its bookings too; nothing is ever deleted automatically. If your club promises something different, such as deleting everything within a set time, change the text and make sure the club keeps that promise by hand.

The default notice itself names no data controller and gives no contact. If an admin has set a privacy contact on the Settings page (`/admin/settings`, see [`docs/branding.md`](branding.md)), the booking form appends a line under the notice, whichever notice is in use: "Questions about your details, or want them deleted? Contact <name>, <email>." The contact counts as set once it has an email address. So the statement that the booking page names no contact is only true until a contact is set; it still names no data controller by name unless the club writes that into the notice. Clubs should set the contact and add who is responsible for the data (UK GDPR transparency: who is responsible for the data and how to reach them), by setting `PRIVACY_NOTICE`. Until a contact is set, the booking page shows a signed-in admin (and nobody else) a warning with a link to Settings.

A club that sets its own `PRIVACY_NOTICE` is unaffected by the default, but should add a sentence saying the running order may be shared with names if its organisers use Copy lineup. The Settings page's privacy contact is appended under a custom notice too, so a custom notice that already names a contact will show two.

### Upgrading

Earlier builds' default notice said the club deletes booking details after the event. This build never deletes anything automatically, and the default now says so. If you relied on the default, the wording your bookers see has changed. Bookings made under the old wording still need deleting by hand (from the admin list) if you want to keep that promise.

## Setting them

- For a deployment, under `vars` in the git-ignored `account.local.json`, then run `npm run configure` (`docs/deploying.md`, step 3):

  ```jsonc
  "vars": { "BOOKING_CUTOFF_OFFSET_MINUTES": "-30" }
  ```

  Values are strings. The script writes them into both the top level (production) and `env.preview` of the generated `wrangler.json`, because `vars` is not inherited by `env.preview`. (Without the script, put the same `vars` block in both places in `wrangler.jsonc`, but then your settings are in a committed file.)

  When production and preview need different values, add `productionVars` and `previewVars`. They have the same shape and checks as `vars` (valid names, string values, no secrets):

  ```jsonc
  "vars": { "BOOKING_CUTOFF_OFFSET_MINUTES": "-30" },
  "previewVars": { "ADMIN_AUTH": "password" },
  "productionVars": { "ADMIN_AUTH": "access", "ACCESS_TEAM_DOMAIN": "<your-team-name>.cloudflareaccess.com", "ACCESS_AUD": "<the AUD tag>" }
  ```

  The production block gets `vars` plus `productionVars`, and `env.preview` gets `vars` plus `previewVars`. Where a name is in both `vars` and the environment's own object, the environment's value wins in that block only; neither environment sees the other's own variables. `npm run configure` prints the variable names written to each block (never the values).
- Locally, put them in `.dev.vars` (see `.dev.vars.example`). Restart `npm run dev` after changing it.

This project uses a Wrangler configuration file, which Cloudflare's [Pages configuration docs](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) say becomes the source of truth: "you cannot edit the same fields in the dashboard once you are using this file". So set deployed variables through the config file (`account.local.json` and `npm run configure`) and redeploy, rather than in the dashboard. (Redeploying is the safe assumption; the docs don't say whether a variable change applies without a new deployment.)
