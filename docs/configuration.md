# Configuration

The API reads two optional settings from Pages environment variables. They are plain text, not secrets, and both have defaults, so a deployment works without setting either.

| Name | Meaning | Default | Example |
| --- | --- | --- | --- |
| `BOOKING_CUTOFF_OFFSET_MINUTES` | When bookings close, in whole minutes from the event's start time. Positive keeps bookings open that many minutes after the start; negative closes them earlier. A request at exactly the closing time is refused. Whole numbers from -10080 to 10080 (one week) are accepted; anything else is ignored with a warning in the logs. | `0` (closes at the start) | `-30` closes half an hour before the start |
| `PRIVACY_NOTICE` | The text shown under "Privacy" on the booking form. Plain text only (no HTML). A blank line starts a new paragraph. Leading and trailing whitespace is removed, and anything over 1000 characters is cut off with a warning in the logs. Blank means the default. | See below | `We use your details to run the event.\n\nEmail us to have them deleted.` |

The default privacy notice is:

> We store your name, your dog's name and the slot you choose so the club can run the event. The club's organisers can see these details; other people using this page only see which slots are taken. The club deletes booking details after the event.

Clubs should replace this with their own wording. The last sentence is a promise the club keeps by hand: the app does not delete anything automatically yet, so if your club will not do that, change the text.

## Setting them

- In `wrangler.jsonc`, under `vars`:

  ```jsonc
  "vars": { "BOOKING_CUTOFF_OFFSET_MINUTES": "-30" }
  ```

  Values are strings. `vars` is not inherited by `env.preview`, so give the preview environment its own `vars` block with the same settings if you want them there.
- Locally, put them in `.dev.vars` (see `.dev.vars.example`). Restart `npm run dev` after changing it.

This project uses a Wrangler configuration file, which Cloudflare's [Pages configuration docs](https://developers.cloudflare.com/pages/functions/wrangler-configuration/) say becomes the source of truth: "you cannot edit the same fields in the dashboard once you are using this file". So set deployed variables in `wrangler.jsonc` and redeploy, rather than in the dashboard. (Redeploying is the safe assumption; the docs don't say whether a variable change applies without a new deployment.)
