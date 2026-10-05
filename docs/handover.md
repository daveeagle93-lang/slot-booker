# Handing the app over to the club

This is for the day the live app moves from the maintainer's own Cloudflare account to the club's own account, and for the jobs the club then does itself: adding and removing admins, changing the admin password, exporting data and tidying up. The reader is a club volunteer who can follow steps and paste a few commands, and the maintainer who is handing over.

> **Hard rule.** Admin sign-in with Cloudflare Access (`ADMIN_AUTH=access`) is only for a deployment served on a custom domain, on a Cloudflare zone the club controls. A deployment reachable only on `*.pages.dev`, and every preview, uses the shared password (`ADMIN_AUTH=password`). The reasons are in [`admin-auth.md`](admin-auth.md#hard-rule-access-needs-a-custom-domain-pagesdev-uses-the-password).

**What was and was not run.** No Cloudflare command was run in writing this document, and nobody has done this handover against a real pair of accounts. The `--help` output of the installed Wrangler (4.147.0) was read for `wrangler pages secret put|delete`, `wrangler d1 export|execute|delete` and `wrangler logout`, and the app's code was read for what it does with sign-in, sessions and deletion. Statements about Cloudflare's dashboard and services come from Cloudflare's documentation, with the page linked each time. Where the documentation says nothing, the text says **unverified** and tells you to check in the dashboard. Dashboard labels are the ones on Cloudflare's pages when this was written and may have changed.

## The short version

1. The club creates its own Cloudflare account and invites the maintainer, or the maintainer invites the club; either way, the club's owner ends up as a **Super Administrator** (section 1).
2. Deploy the app in the club's account from scratch, following [`deploying.md`](deploying.md) (section 1).
3. Copy the data across: export from the old database, import into the new one, and check the logo and the numbers match (sections 1 and 7).
4. Test the new site on its `pages.dev` address with the shared password.
5. Move the club's address to the new site, and switch admin sign-in to Cloudflare Access if the club wants it (sections 1 and 2).
6. Only when everything is checked: the maintainer exports a last copy, deletes their own project and databases, and leaves the club's account (section 5).

## Before you start: what you need

- A Cloudflare account owned by the club, with a club email address that more than one person can reach. Cloudflare says only a Super Administrator can manage members, so make sure at least one club person has that role ([Manage members](https://developers.cloudflare.com/fundamentals/manage-members/manage/), [Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)).
- A computer with Node 24 and a copy of this repo, and someone who can paste commands into a terminal. The app is deployed from a computer with `wrangler pages deploy` (see [`deploying.md`](deploying.md)); there is no automatic deployment from GitHub, so the club needs a person and a computer for future updates. The maintainer should hand over the repo link, not the maintainer's local `account.local.json` (it holds the maintainer's database IDs).
- If the club wants Access: a domain whose DNS the club controls and that is on Cloudflare (section 2).
- The maintainer's access to the old account until the end. Nothing in the old account should be deleted until section 5.
- A private place to keep export files (they hold names), and a password manager for the new admin secret.

## 1. Moving to the club's own Cloudflare account

I couldn't find any documented way to transfer a Pages project or a D1 database from one Cloudflare account to another. Treat that as **unverified**: the route below does not rely on a transfer. It builds a second copy in the club's account, copies the data in, checks it, then switches over. (Cloudflare does document moving a domain between accounts: [Move a domain](https://developers.cloudflare.com/fundamentals/manage-domains/move-domain/). That is the address only, not the app.)

### Step A: set up the club's account and its owner

1. The club creates its Cloudflare account.
2. Invite the people who will run it in **Manage Account**, **Members**, **Invite**, entering the email, choosing the role and confirming ([Manage members](https://developers.cloudflare.com/fundamentals/manage-members/manage/)). Give the club's owner **Super Administrator - All Privileges**. Cloudflare's "Administrator" role cannot manage members or billing ([Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)).
3. Do this before anything else, and wait until the club's owner has accepted and can see the Members list. The maintainer can then be added as a temporary, lesser member (or simply work from the owner's login with the owner present). Reason: if the maintainer set everything up and then left, nobody else could add or remove members.

### Step B: deploy the app in the club's account

Follow [`deploying.md`](deploying.md) from the start, logged in to the **club's** account (`npx wrangler login`, then `npx wrangler whoami` to check which account it shows). Use the club's own `account.local.json` with the club's own database IDs. Two differences:

- **Do not apply the migrations to the new production database** (step 4 of `deploying.md`). The export you import in Step C already contains the tables, and importing into a database that already has them fails. Apply migrations only if you decide to start the new site empty.
- Set the secrets with new values. The shared admin secret and `ADMIN_SESSION_SECRET` are generated afresh in the club's hands (section 4), not copied from the maintainer.

### Step C: copy the data across

Wrangler finds a database by the name in `wrangler.json`, which `npm run configure` writes from `account.local.json`. So the export needs the **old** database's ID in that file and the old account's login, and the import needs the **new** ones. Do them one after the other and run `npm run configure` each time you change the file.

1. Logged in to the old account, with the old IDs configured, export the live database (section 7 has the command and the notes on it).
2. Log in to the club's account (`npx wrangler login`, `npx wrangler whoami`) and put the club's IDs in `account.local.json`, then `npm run configure`.
3. **Round-trip into a scratch database first.** The club's preview database (`slot-booker-db-preview`, created in `deploying.md` step 2) can serve as the scratch one. Import the export there:

   ```sh
   npx wrangler d1 execute slot-booker-db-preview --remote --env preview --file=./backup.sql
   ```

   This runs the SQL file against that database. The preview database should have no migrations applied (or be freshly created), for the reason in Step B.
4. **Check that the logo and the app icons came across.** The club logo (table `site_logo`) and the app icons made from it (browser tab, home screen and manifest icons, table `site_icons`) are stored as images, BLOBs (blocks of raw bytes), in the database. Cloudflare's import/export page and its limits page do not say how BLOBs are exported ([Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [Limits](https://developers.cloudflare.com/d1/platform/limits/): a row or BLOB is at most 2 MB). A closed report in the Wrangler issue tracker (workers-sdk #8226) describes a crash when exporting a local database containing a BLOB column; that was an older Wrangler and a local database, but it is the reason for this check. Compare the logo's and the icons' sizes and checksums in both databases. Each pair of commands prints small tables:

   ```sh
   npx wrangler d1 execute slot-booker-db --remote --command "SELECT sha256, length(bytes) AS size FROM site_logo"
   npx wrangler d1 execute slot-booker-db --remote --command "SELECT size, sha256, length(bytes) AS bytes FROM site_icons ORDER BY size"
   npx wrangler d1 execute slot-booker-db-preview --remote --env preview --command "SELECT sha256, length(bytes) AS size FROM site_logo"
   npx wrangler d1 execute slot-booker-db-preview --remote --env preview --command "SELECT size, sha256, length(bytes) AS bytes FROM site_icons ORDER BY size"
   ```

   Run the first two with the old account's login and old IDs, the last two with the club's. The rows should be identical (`sha256` is a checksum the app stored when each image was saved). Having no icon rows is normal if the club never uploaded a logo. Also compare the row counts of `events` and `bookings` in the same way (`SELECT count(*) FROM bookings`), and open `/api/logo` on the preview site to see the logo itself.
5. **Check how Wrangler's migration tracking came across.** Whether the export carries Wrangler's own record of which migrations have run is **unverified**. After the scratch import, run `npx wrangler d1 migrations list slot-booker-db-preview --remote --env preview`. If it lists migrations as pending, do not apply them blindly: ask the maintainer, because applying them again may fail or change data. If it lists none, all is well.
6. **If the logo or the icons did not survive**, the fallback is simple: finish the move without them, then sign in to Admin, open **Settings** and upload the logo again ([`branding.md`](branding.md)). The app works without a logo in the meantime, and with no icon rows it serves its bundled default icons (`migrations/0011_site_icons.sql`). Saving a logo deletes the stored icons, and the Settings page redraws them from the logo and the theme colour (same migration's comments; I haven't run this).
7. When the scratch copy matches, import into the club's **production** database in the same way, using `slot-booker-db` and no `--env`:

   ```sh
   npx wrangler d1 execute slot-booker-db --remote --file=./backup.sql
   ```

   Repeat the checks of step 4 against it. Then deploy to production (`deploying.md` step 7, with `--branch main`).
8. The scratch copy now holds real names. Empty or delete it when you have finished checking (`npx wrangler d1 delete <name>` exists, and `deploying.md` says the preview deployment uses that database, so recreate it if you still want a preview).

### Step D: check, then switch the address

1. Open the new production site on its `pages.dev` address. Check `/api/health`, the landing page, one event's booking link and the admin sign-in with the new shared password. Look at one event's bookings against what the old site shows.
2. If the club's own address pointed at the old site, move it: add it to the **club's** Pages project under "Workers & Pages", the project, "Custom domains", "Set up a domain" ([Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)). Cloudflare says to add the domain this way and not by creating the DNS record by hand first, which gives a 522 error. Whether the old project must give the hostname up first, and how Cloudflare handles a hostname moving between two accounts' Pages projects, is **unverified**: check it in the dashboard and expect a short gap. Choose a quiet moment, not the day bookings open.
3. Keep the old site running until the new address works and has been checked by someone other than the maintainer. Bookings made on the old site after the export are not in the new database: for a clean move, stop taking bookings (or re-export and re-import) around the switch.

### Step E: retire the old one

Only after section 5's conditions are met. Do not delete anything in the old account until the new one has been in use for a while and the club has a verified copy of its data (section 7).

## 2. Switching to Cloudflare Access on a custom domain

> **Rule from [`admin-auth.md`](admin-auth.md#hard-rule-access-needs-a-custom-domain-pagesdev-uses-the-password).** Access only on a custom domain on a Cloudflare zone the club controls. `*.pages.dev` and previews use the password.

Access replaces the shared password with each admin signing in by their own email, using a code Cloudflare sends them. It is optional, and the app works with the password. What the app does: with `ADMIN_AUTH=access` the app checks the signed token that Access adds to each request (`src/server/auth/access.ts`) and ignores any password cookie. Both admin paths have their own guard (`functions/admin/_middleware.ts` for the pages, `functions/api/admin/_middleware.ts` for the API), and both refuse a request with no valid Access token. Cloudflare attaches the token only to requests on paths Access covers, so Access has to cover **both** `/admin/*` and `/api/admin/*` (and the bare `/admin` and `/api/admin`: Cloudflare says `/admin/*` does not cover `/admin` itself, see [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)). If it covers only one, the other part of the admin gets no token and answers 401.

The order matters. Exact variable names, accepted forms and the full click path are in [`admin-auth.md`](admin-auth.md#setting-it-up-custom-domain); this is the sequence.

1. **Custom domain on the Pages project first** (section 1, Step D). Cloudflare lists as a known issue that you can't add a custom domain that already has an Access policy on it ([Known issues](https://developers.cloudflare.com/pages/platform/known-issues/)), so do this before step 2.
2. **Create the Access application.** In Zero Trust, "Access controls", "Applications", "Create new application", "Self-hosted and private", then "Add public hostname" with the paths `/admin`, `/admin/*`, `/api/admin` and `/api/admin/*` on the club's hostname ([Self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)). Never leave the path empty: that would put the public booking pages behind a login. That one application can hold several paths is the project's assumption, not something Cloudflare's page states, so check it in the dashboard.
3. **Add an Allow policy** listing the admins' email addresses. Access applications deny everyone by default until an Allow policy matches. Set a short session duration (8 hours or less, as `admin-auth.md` recommends).
4. **Turn on the one-time PIN login method**, which emails each admin a single-use code that expires after 10 minutes: "Zero Trust", "Integrations", "Identity providers", "Add new identity provider", "One-time PIN" ([One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)). Cloudflare says a new Zero Trust organisation does not get it automatically, and that an email must match an Access policy before a code is sent. If admins don't receive codes, Cloudflare says to allow mail from `notify.cloudflare.com`.
5. **Give the app the settings.** Copy the application's AUD tag (Configure the application, then "Additional settings", "Application Audience (AUD) Tag") and your team domain (`<your-team-name>.cloudflareaccess.com`) ([Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)). Put `ADMIN_AUTH`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` under `productionVars` in `account.local.json` and keep previews on the password with `previewVars` (the exact block is in `admin-auth.md`, step 5). Run `npm run configure`.
6. **Redeploy production** (`deploying.md` step 7, `--branch main`). Until you redeploy, the site is still using the password.
7. **Test** with the `curl` checks and the private-window check in `admin-auth.md`, step 6: the admin must ask for Access sign-in, an allowed email must get in, a non-allowed one must be refused, and the public booking pages must still open without any sign-in. A `503` on admin means a setting is missing or malformed; the function logs say which (`deploying.md`, "Troubleshooting").
8. **Turn the password off.** Setting `ADMIN_AUTH=access` already stops the app using the password: the app never falls back to the other provider's settings, and an old password session cookie is ignored once the site is on Access (the code reads the Access token only; `src/server/auth/index.ts`). After Access has worked for a few days, you can also delete the two now-unused secrets, `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET`, from production, in the dashboard under the project's "Settings", "Variables and Secrets" ([Bindings](https://developers.cloudflare.com/pages/functions/bindings/)), or with `npx wrangler pages secret delete <NAME> --project-name <project>` (listed in `--help`; whether it needs `--env production` is the same open question as in section 4). Keep them until then: if Access misbehaves, setting `ADMIN_AUTH` back to `password` and redeploying brings the password back.

Before step 6, make sure the Allow policy holds an email address that someone can actually receive mail on, or nobody will get in.

Free-plan user limits for Access: I couldn't find them in Cloudflare's documentation; check Cloudflare's pricing page.

## 3. Adding and removing admins

### Under Access

- **Add** an admin: add their email to the Allow policy of the Access application ("Zero Trust", "Access controls", "Applications", the application, its policy). Cloudflare's policy page describes an "Emails" selector for specific addresses ([Policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)); its step-by-step editing instructions aren't there, so I couldn't verify the exact clicks. Check in the dashboard.
- **Remove** an admin: delete their email from the policy. Cloudflare says emails are checked when someone logs in, not continuously (same page), so removing someone does not necessarily end a session they already have open. The app itself accepts any validly signed, unexpired Access token for the club's application (`admin-auth.md`, "How the Worker checks the token"), so until that token runs out the person can still use the admin. What limits it is the session duration you set on the policy (section 2, step 3): keep it short.
- **Forcing a sign-out now.** I couldn't find a documented way to do this in Cloudflare's documentation: **unverified**; look in the Zero Trust dashboard. One heavy remedy follows from how the app checks tokens, and it is my reading of the code, not something I ran: delete the Access application and create a new one, which gives a new AUD tag (Cloudflare says the tag never changes unless you delete or recreate the application), then put the new tag in `ACCESS_AUD` and redeploy. Tokens issued for the old application then fail the app's `aud` check. Use it only if a real leak is suspected.

### Under the password

There are **no individual admin accounts**: one shared secret and a signed cookie, and the identity is always the word `admin` (`src/server/auth/password.ts`). So you can't remove one person. Removing an admin means changing the secret everyone shares, **and** signing everyone out, because a session already open stays valid for up to 8 hours otherwise. Follow section 4 and change both secrets, then give the new admin secret to the people who stay.

## 4. Changing the password, or signing everyone out (password mode only)

There are two secrets, both Pages secrets (never in the repo or the database):

| Secret | What it is | Change it to |
| --- | --- | --- |
| `ADMIN_PASSWORD_HASH` | The stored form of the shared admin secret. | **Change the password.** Nobody can log in with the old one afterwards. |
| `ADMIN_SESSION_SECRET` | Signs the cookie that keeps an admin signed in (at least 32 random characters). | **Sign everyone out.** Every existing session stops working. |

Changing only the hash leaves existing sessions valid until they expire, up to 8 hours (`admin-auth.md`, "Sessions"; `src/server/auth/session.ts`). Changing the session secret also resets the stored login-attempt counts, which is harmless. To remove an admin, change **both**.

1. Generate a new admin secret. Its one-time output is printed on the terminal: copy the secret into the club's password manager straight away, because it can't be recovered from the hash. The hash is the line on standard output.

   ```sh
   npm run --silent generate-admin-secret
   ```

2. For `ADMIN_SESSION_SECRET`, make 32 or more random characters, for example:

   ```sh
   openssl rand -base64 48
   ```

3. Store each. Each command asks for the value, so nothing secret goes on the command line. Paste the **hash line** (not the secret) for `ADMIN_PASSWORD_HASH`. Use `--env production` for the live site and `--env preview` for previews; use different values for the two.

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name <project> --env production
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name <project> --env production
   ```

   Two things about `--env`. It is **not** in `npx wrangler pages secret put --help` (Wrangler 4.147.0 lists only `--project-name`), and it is not documented by Cloudflare for this command; the maintainer found first-hand that without it the secret goes to production and with `--env preview` it goes to Preview (`deploying.md`, step 6). Check the result in the dashboard under the project's "Settings", "Variables and Secrets" ([Bindings](https://developers.cloudflare.com/pages/functions/bindings/)): secrets can't be viewed afterwards, but they are listed by name per environment.
4. **Redeploy** the project (`npx wrangler pages deploy public --project-name <project> --branch main`, with the club's `wrangler.json` configured as in `deploying.md`). Cloudflare says secrets must be set before a deployment that uses them ([Bindings](https://developers.cloudflare.com/pages/functions/bindings/)); I couldn't find whether an already-live deployment picks up a changed secret, so redeploying is the safe step, not a guess.
5. Test: the old secret is refused, the new one signs in, and an admin tab left open from before has been signed out (if you changed the session secret).

Under Access none of this applies: the password secrets are not used.

## 5. Removing the maintainer's access

Do this only after the club's deployment has been checked (section 1, Step D) and the club holds a verified copy of its data (section 7).

**In the club's account (done by a club Super Administrator).**

1. Remove the maintainer as a member: "Manage Account", "Members", expand the member, "Revoke", confirm ([Manage members](https://developers.cloudflare.com/fundamentals/manage-members/manage/)). Only a Super Administrator can do this. A member can also choose to leave themselves, on the same page.
2. If Access is on: delete the maintainer's email from the Allow policy (section 3). Revoking membership does not do this.
3. Check "Members" afterwards. The app has no GitHub-style deployment connection: it deploys with `wrangler pages deploy` from a computer (`deploying.md`), so there is nothing to disconnect for that. If the club has connected the Pages project to a Git repository by its own choice, check that connection in the project's settings; I didn't verify where.

**By the maintainer, in their own account.**

1. Export a last copy of the old database (section 7). Keep it private; delete it once the club confirms its own copy is good.
2. Delete the old Pages project and the old D1 databases: in the dashboard, or `npx wrangler d1 delete <name>` for a database (listed in `--help`). I couldn't find whether D1's Time Travel backups survive a deleted database ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)): **unverified**, so don't treat Time Travel as a substitute for the export in step 1.
3. Run `npx wrangler logout`. The research behind this document found that Wrangler's documentation says it invalidates the current login token and deletes the stored credentials; I didn't record the page, so treat that as unverified and check `npx wrangler whoami` afterwards (it should say you are not logged in).
4. Revoke any API tokens the maintainer created, for example the one for `CLOUDFLARE_API_TOKEN` (`deploying.md`, section 1). I couldn't find revocation steps in Cloudflare's documentation. **Unverified:** the API Tokens list in the dashboard under your profile is where I'd look. Tokens belonging to a user are understood to be tied to that user, while account-owned tokens are understood to persist after their creator leaves an account (both unverified), so check the club account for any tokens the maintainer made there too. What happens to the maintainer's OAuth login after being removed from an account is also not documented in what I found.
5. The maintainer should also delete local copies: exports, the maintainer's `account.local.json`, and the generated `wrangler.json`.

## 6. Where the data lives

All data is in one Cloudflare D1 database, `slot-booker-db` by default (the preview has its own, `slot-booker-db-preview`). The tables, from [`migrations/`](../migrations/):

| Table | Holds |
| --- | --- |
| `events` | One row per event: name, start and end time, session length, gap, cost, venue postcode, details, whether archived, whether listed, its secret link slug. |
| `breaks` | Periods within an event with no slots (for example lunch), each with an optional label. |
| `bookings` | One row per booked slot: slot start time, **dog name, handler name**, when it was booked, plus a private token for the booking's calendar link and technical keys that stop double bookings. |
| `login_attempts` | Failed-login counting for the password sign-in: a keyed hash of the client's network address, a count and a time. Never used with Access. |
| `site_settings` | One row: club name, privacy contact name and email, website address and theme colours. |
| `site_logo` | At most one row: the club logo as an image, with its type, size and checksum. |
| `site_icons` | Up to three rows (32, 180 and 512 pixels): the app icons drawn from the logo and theme colour, as PNG images. None means the bundled default icons are used. |

**Personal data.** Dog and handler names and the times of their slots in `bookings`; the privacy contact's name and email in `site_settings`; and the pseudonymous address hashes in `login_attempts`, which the app treats as personal data too (`admin-auth.md`, "Rate limiting"). Exports hold all of it.

**Secrets.** `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` are Pages secrets in the Cloudflare account. They are not in the repo and not in the database, so an export doesn't contain them and doesn't carry them to a new account. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are plain settings in the deployment's configuration, not secrets, and they come from the git-ignored `account.local.json` (`admin-auth.md`).

**Retention.** Nothing is deleted automatically, except old `login_attempts` rows, which are removed as a side effect of later login attempts. Bookings and events are only removed by an admin (checked in `src/server/admin-event-lifecycle.ts`): **Archive** hides the event and keeps all its data; **Delete** removes an event with its bookings and breaks, permanently; **Clear out past events** (`functions/api/admin/events/clear-past.ts`) does the same for the past events you pick, and asks you to type `DELETE`. The booking form's privacy notice says details are kept until an organiser deletes the event, which matches this. Delete old events when you no longer need them.

**Backups.** D1 Time Travel can restore a database to an earlier moment: 7 days back on the Workers Free plan and 30 on Paid ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)). `npx wrangler d1 time-travel info <DB>` shows the available range. A restore overwrites the database in place, so use it with care, and it is not a replacement for exports (section 7).

**Free-plan limits worth knowing.** Cloudflare's Workers Free plan allows 100,000 requests a day (resetting at 00:00 UTC) and 10 ms of CPU per request; Pages Functions requests count against the same pool and static files are free ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)). D1 on the free plan allows 5 million rows read and 100,000 rows written a day, 500 MB per database and 5 GB per account in total, up to 10 databases ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Whether a password login fits the 10 ms on real Workers is **unverified** (`admin-auth.md`, "What a login costs").

## 7. Exporting before deleting

**One event, for a spreadsheet.** In Admin, open the event and select **Download CSV**. It contains the bookings only: time (London time), dog, handler and when it was booked (`functions/api/admin/events/[slug]/export.csv.ts`). It does not contain the event's settings, the breaks, the logo or anything else.

**The whole database.** Logged in to the account that owns the database, with that database's ID in `account.local.json` and `npm run configure` run:

```sh
npx wrangler d1 export slot-booker-db --remote --output=./backup.sql
```

This writes the database's structure and contents to a file. To load such a file into another, empty database, as in section 1:

```sh
npx wrangler d1 execute slot-booker-db --remote --file=./backup.sql
```

Both commands are from [Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/) and were checked against `--help`; neither was run for this document. Notes:

- Cloudflare says an export blocks other requests to that database while it runs, so the booking page may pause briefly: export at a quiet time. An export has limits (a database of at most 5 GiB, no virtual tables, an SQL statement of at most 100 KB) ([Limits](https://developers.cloudflare.com/d1/platform/limits/)); this app's database is far smaller.
- How BLOBs (the logo and the icons) are exported is not in Cloudflare's documentation. Check as in section 1, Step C. Always restore into a scratch database and look, before relying on a backup.
- An export file contains every name and the privacy contact. Keep it private (not in the repo, not in email or a shared chat) and delete it when it is no longer needed. `backup.sql` is not git-ignored by default: do not commit it.
- **Never delete a database before the new one is verified**, and not before there is at least one export you have restored successfully somewhere.

## 8. If something goes wrong, and after the handover

- **Admin shows an error or answers 503 after a change.** A setting or secret is missing or malformed. The reason is in the function logs: `deploying.md`, "Troubleshooting", shows how to read them. With Access, the quickest way back is to set `ADMIN_AUTH` back to `password` (the password secrets must still be set), run `npm run configure` and redeploy.
- **The new database is wrong or empty.** Don't delete the old one. Import again into a fresh database and check as in section 1.
- **Something was deleted by mistake.** Time Travel may restore it, if it was within the window (section 6). Act quickly, and ask the maintainer or Cloudflare before restoring, because a restore overwrites the database in place.
- **Nobody can sign in to the club's Cloudflare account.** This is why more than one person should hold Super Administrator, and why the club's account email should be reachable by more than one person.
- **After the handover, the maintainer cannot see the club's data**, and can't reset the password or fix the live site unless the club invites them again. That is the point of the move, and the club is then the only one who can change its admins, its secrets and its deployment. The maintainer can still help from the repository (code, documentation and issues), but only on what the club chooses to share. Keep this document up to date with anything the club learns while doing the move.
