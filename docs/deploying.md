# Deploying slot-booker

This page gets your club its own copy of the app on Cloudflare's free plan. The first part is for a club organiser and needs no terminal. The advanced parts are for people comfortable with a command line.

Your copy is **one Cloudflare Worker**, named `slot-booker` unless you change it. It serves the website and the booking API, and it uses one D1 database, `slot-booker-db`. The migrations in `migrations/` (0001 to 0018) build the database.

**What was and was not checked.** The button was run once end to end against the public copy of this repository on 6 October 2026 ([Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)): the form, the build, the migrations, the deploy to `workers.dev`, `/setup`, sign-in, creating an event and booking all worked. The rest of the steps follow Cloudflare's documentation and this repository's code and configuration. Where the text says something that run, the documentation and the code do not confirm, it says **unverified**. Dashboard labels may have changed.

Contents:

- [Before you start](#before-you-start)
- [Deploy with the button](#deploy-with-the-button)
- [Check that it works](#check-that-it-works)
- [Advanced: deploy from the command line](#advanced-deploy-from-the-command-line)
- [Custom domain and Cloudflare Access](#custom-domain-and-cloudflare-access)
- [For maintainers: the preview environment](#for-maintainers-the-preview-environment)
- [Updating your copy](#updating-your-copy)
- [Troubleshooting](#troubleshooting)
- [Before a real event](#before-a-real-event)

## Before you start

You need:

- A **Cloudflare account** (free). Use a club email address that more than one person can reach.
- A **GitHub or GitLab account.** The button copies the code into it.
- The address of the template, which must be a **public** repository on github.com or gitlab.com. The button only works from a public one.
- About 15 minutes.

Decide on a `SETUP_CODE` first: a private phrase of **at least 12 characters**, such as four unrelated words. It is **not** your admin secret. You will use it once, on your new site, to make the admin secret. Write it down somewhere safe.

## Deploy with the button

1. **Press the "Deploy to Cloudflare" button** in the [README](../README.md). It opens Cloudflare.
2. **Sign in to Cloudflare**, or create the free account. The sign-up screens are Cloudflare's own: unverified here.
3. **Connect your GitHub or GitLab account** when asked. The form has a toggle for whether your copy of the repository is private. Cloudflare's docs say the button copies the repository into your own account, so you end up with your own copy that you own.
4. **Fill in the prompts.** Cloudflare's docs say you can customise the "repository name, Worker name, and required resource names". The suggestions are fine.
   - The **Worker name** becomes part of your address: `https://<worker-name>.<your-workers-subdomain>.workers.dev`.
   - The **database** (`DB`) is made for you. The description shown is the one in `package.json`: "Your club's booking database. Cloudflare creates it for you, so the suggested name is fine."
   - **`SETUP_CODE`**: type your phrase. The description shown is the one in `package.json`. A code under 12 characters is accepted by the form but then `/setup` refuses it (see Troubleshooting).
   - The form also shows toggles for "Enable Preview builds" and "Protect with Cloudflare Access", and an Advanced settings section. Leave both toggles off and the Advanced settings alone; the reasons are in the [README](../README.md#what-the-form-asks-for).
5. **Deploy.** Cloudflare creates the database and replaces the placeholder database id in your copy of `wrangler.jsonc`, then builds the copy with Workers Builds. That runs `npm run deploy`, which applies all 18 migrations to the database through its `DB` binding and publishes the Worker. Wait for it to finish. Both scripts pass `--env=""`, which targets the top-level environment explicitly: without it Wrangler warned that several environments are defined and none was chosen (`env.preview` exists). A dry run of the current scripts shows no such warning.
6. **Find your address.** In the Cloudflare dashboard, open **Workers & Pages**, then the Worker (`slot-booker` by default). Its page shows its `workers.dev` address. These labels are **unverified**. A new account may have to pick a `workers.dev` subdomain first: also unverified.
7. **Make your admin secret.** Open `https://<worker-name>.<your-workers-subdomain>.workers.dev/setup` and:
   1. Type your `SETUP_CODE` and press **Continue**.
   2. The page shows your **admin secret** (43 characters) **once**. Press **Copy** and paste it into a password manager now.
   3. Tick **I've saved it**, then press **Go to sign in**.
   4. On the sign-in page, paste the secret into **Admin secret** and press **Sign in**.

What to know about `/setup`:

- It works only on a password-provider site (`ADMIN_AUTH=password`, which `wrangler.jsonc` sets) and only while no admin has signed in yet.
- If you open an admin page before doing this, it sends you to `/setup` (once `SETUP_CODE` is in place).
- Running `/setup` again before the first sign-in **replaces** the secret: the old one stops working.
- After the first successful sign-in it is closed for good (404).
- The setup code is limited to 5 attempts per 15 minutes per visitor (every attempt counts), compared in constant time, and the page accepts same-origin requests only.
- Only a hash of the secret is stored (table `admin_credentials`). If you lose the secret, see [If the admin secret is lost](handover.md#if-the-admin-secret-is-lost).

## Check that it works

On your phone or computer, with your own address:

1. Open `https://<your-address>/api/health`. It should show `{"ok":true}`.
2. Open `https://<your-address>/`. You should see the landing page ("Slot booker" until you set a club name, and no events yet).
3. Open `https://<your-address>/admin/` while signed out. It should send you to the sign-in page (or to `/setup` if you have not done step 7 yet).
4. Sign in, open **Settings** (`/admin/settings`) and set the club name and the **privacy contact** (a name and an email address). Until then the booking page shows signed-in admins a warning and tells bookers nothing about who to contact. See [branding.md](branding.md).
5. Create a test event (see [admin-guide.md](admin-guide.md)), open its booking link in a private window and book a slot. Then delete the test event.
6. Press **Sign out**, then check `/admin/` sends you back to the sign-in page.

## Advanced: deploy from the command line

Use this if you prefer a terminal, want to choose where the database lives, or want the deploy to happen from your own computer rather than from Workers Builds.

You need Node 24 and Git. Every step below uses a command that exists in `package.json` or Wrangler.

1. **Get the code and install.**

   ```sh
   git clone <your-copy-or-the-template-url> slot-booker
   cd slot-booker
   npm ci
   ```

2. **Log in to the club's Cloudflare account.**

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

   `whoami` shows which account you are using. If you set `CLOUDFLARE_API_TOKEN` instead of logging in, the token needs two permissions, confirmed in a real cutover on 6 October 2026: **Account → D1 → Edit**, and **Account → Workers Scripts → Edit**. The second is needed for `wrangler deploy` and also for `wrangler secret put`: without it the secret call fails with "No access to the specified resource" on `.../workers/scripts/<name>/secrets`. **Cloudflare Pages → Edit** is not needed: the app runs on Workers. Gotcha: unless the token also has **User → User Details → Read**, `whoami` prints a harmless error about missing permissions; it does not affect deploying.

3. **Create the databases.** `npm run configure` (step 4) needs **two** ids, production and preview, so create both; the free plan allows 10 databases per account.

   ```sh
   npx wrangler d1 create slot-booker-db --location weur
   npx wrangler d1 create slot-booker-db-preview --location weur
   ```

   **When Wrangler offers to add the binding to your Wrangler config, answer No.** If you answer Yes it edits `wrangler.jsonc` with a binding name that is not the committed one (`DB`). If you did, undo it with `git checkout -- wrangler.jsonc`. (This prompt comes from the earlier maintainer's real run, not from Cloudflare's docs.)

   `--location weur` is a placement hint (Western Europe). If bookings must stay within the EU use `--jurisdiction eu` instead (the location hint is then ignored), for both databases.

   Each command prints a `database_id` (a UUID). Note which is which.

4. **Put your ids in a git-ignored file and generate the config.** The committed `wrangler.jsonc` holds all-zero placeholder ids so no account details are committed. Do not edit it. Your ids go in `account.local.json` (git-ignored), and a script writes a git-ignored `wrangler.json` that Wrangler reads instead of `wrangler.jsonc`:

   ```sh
   cp account.local.example.json account.local.json
   ```

   Replace its contents with this, using your two ids (the example file also shows Access settings and a cut-off setting you do not need yet):

   ```jsonc
   {
     "productionDatabaseId": "<database_id of slot-booker-db>",
     "previewDatabaseId": "<database_id of slot-booker-db-preview>"
   }
   ```

   Optional keys, from `scripts/configure-core.ts`:

   - `name`: the Worker's name, if `slot-booker` is taken (lower-case letters, digits and hyphens).
   - `vars`: plain-text settings (strings) written into both the production and the preview block, for example `"BOOKING_CUTOFF_OFFSET_MINUTES": "-30"`. `productionVars` and `previewVars` add settings to one block only. `ADMIN_AUTH` is already `password` in `wrangler.jsonc`, so a password-provider site needs none. See [configuration.md](configuration.md).
   - Secrets (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`) are refused here: they are Worker secrets.

   Then generate the config:

   ```sh
   npm run configure
   ```

   It checks that both ids are real UUIDs, are not the placeholders and differ, writes `wrangler.json` and prints the variable names it wrote (never the values). Run it again whenever `wrangler.jsonc` or `account.local.json` changes. `npm run configure -- --clear` removes `wrangler.json` so Wrangler uses `wrangler.jsonc` again; it will not delete a `wrangler.json` it did not make.

   Wrangler looks for `wrangler.json` before `wrangler.jsonc` in the same folder, which is why the generated file takes over. That order is Wrangler's behaviour, not in Cloudflare's docs (they say only that both names are supported): check it after upgrading Wrangler by looking at the bindings `npm run dev` lists.

   Keep the top-level `database_name` as `slot-booker-db`: the tests and `npm run db:migrate:local` use it.

5. **Deploy.** This applies the migrations to the production database (`wrangler d1 migrations apply DB --remote`) and then publishes the Worker (`wrangler deploy`):

   ```sh
   npm run deploy
   ```

   `apply` asks for confirmation and takes a backup first. Wrangler prints the Worker's address. Both commands in `npm run deploy` pass `--env=""`, so the top-level environment is targeted explicitly and Wrangler does not warn about `env.preview`.

6. **Set the setup code.** It prompts for the value, so nothing secret goes on the command line:

   ```sh
   npx wrangler secret put SETUP_CODE
   ```

   This comes after the deploy so the Worker already exists. (Wrangler's source has a prompt that offers to create the Worker if it does not, but I have not run it, so I use the order that avoids needing it.) Whether the secret is live the moment the command finishes is **unverified**: if `/setup` still says it is not ready, wait a minute and reload.

7. **Make your admin secret** at `/setup`, as in step 7 of the button path above.

Local development uses `.dev.vars` instead of secrets: `cp .dev.vars.example .dev.vars`, set `SETUP_CODE`, `npm run db:migrate:local`, `npm run dev`. After `npm run configure`, Wrangler keys the local database file on the database id, so `npm run dev` then starts from an empty local database: run `npm run db:migrate:local` again.

### Why the generated config is used, and the options that were rejected

- A plain edit of `wrangler.jsonc` would put your account's ids into a committed file. The fallback is to edit it by hand and hide the change with `git update-index --skip-worktree wrangler.jsonc`; Git may then refuse to pull when that file changes upstream (not tested), which is why the script exists.
- Wrangler's "generated configuration" redirect (`.wrangler/deploy/config.json`) cannot hold `env.preview`: Cloudflare's page says generated configuration should not include any environments ([docs](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)), and the earlier check on Wrangler 4.147.0 refused it. `d1` commands also ignored it.
- Cloudflare's configuration page describes no environment-variable substitution inside the config file.

Those three checks were made on an earlier version of the app and were not repeated for the Worker.

## Custom domain and Cloudflare Access

A club that wants named admins, or its own address, can add a custom domain and then Cloudflare Access.

1. **Custom domain.** It needs a domain whose nameservers are managed by Cloudflare ([Cloudflare's migration notes](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/) say custom domains require this). Adding it to the Worker is done in the dashboard under the Worker's settings: the exact labels are **unverified**, so follow Cloudflare's custom domains page for Workers.
2. **Access.** In the club's own copy of `wrangler.jsonc`, change the `vars` to `ADMIN_AUTH` = `access` and add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, commit and push so Workers Builds redeploys (or run `npm run deploy` from the command line). Create the Access application for the custom domain's hostname with the paths `/admin`, `/admin/*`, `/api/admin` and `/api/admin/*`. The full click path and the settings are in [admin-auth.md](admin-auth.md).
3. **Config `vars` overwrite values set in the dashboard on every deploy** unless `keep_vars` is set ([Wrangler docs](https://developers.cloudflare.com/workers/wrangler/commands/workers/)). Secrets are never deleted by a deploy.
4. **Test the sign-in.** It is **unverified** whether the `Cf-Access-Jwt-Assertion` header reaches a Worker that serves static assets: Cloudflare's docs say `ctx.access` is not available for such Workers ([Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)) and do not mention the header. The app validates the header itself. If admin answers 401 after you sign in through Access, that is the thing to look at.

The `workers.dev` address keeps serving the public booking pages. Access can protect `workers.dev` addresses too ([docs](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)), but the recommendation stays: use the custom domain.

With Access on, `/setup` is closed (404) and the stored admin secret is unused. See [handover.md](handover.md) for switching over and for adding and removing admins.

## For maintainers: the preview environment

`wrangler.jsonc` has two environments:

- **Production** is the top level: Worker `slot-booker`, database `slot-booker-db`. `npm run deploy` is for this one.
- **Preview** is `env.preview`: Worker `slot-booker-preview`, database `slot-booker-db-preview`. It is a separate Worker with its own `workers.dev` address, secrets and data. `vars` and `d1_databases` are not inherited by `env.preview`, so each block spells them out.

Developers keep their own ids in `account.local.json` and run `npm run configure` (see above), which fills in both blocks. The commands:

```sh
npx wrangler d1 migrations apply DB --remote --env preview
npx wrangler deploy --env preview
npx wrangler secret put SETUP_CODE --env preview
npm run seed -- --remote --env preview
```

- With `--env preview`, Wrangler looks the `DB` binding up in `env.preview.d1_databases` only, so these cannot migrate production. (Checked locally on the earlier version with `--local`; the remote commands resolve it the same way but were not run for this page.)
- `npm run seed -- --remote --env preview` inserts a sample event (and sample bookings; add `--no-bookings` for the event only) into the **preview** database only: the script refuses production. It does not apply migrations: if it fails with `no such table: events`, apply them first. Each run adds another event.
- Wrangler's `--preview` flag for D1 is an older, different mechanism based on `preview_database_id`. This repository does not use it; do not mix it with `--env preview`.
- `preview_urls` is `false` in `wrangler.jsonc`: Cloudflare's per-version preview URLs would serve the whole app, admin included, on extra hostnames, and use the production database by default.
- Treat the preview's data as test data.

## Updating your copy

The button makes a copy. Changes to the template do **not** flow into it, and Cloudflare's docs describe no way for them to. Two ways to update:

1. **Merge the template into your copy.** In your clone:

   ```sh
   git remote add template <template-url>
   git fetch template
   git merge template/main
   git push
   ```

   The migrations run on every deploy (the `deploy` script applies them), so pushing a merge that adds a migration applies it. Expect a conflict on the `database_id` lines of `wrangler.jsonc` if the button or you replaced the placeholders there: keep your own ids. That conflict is expected from how the button is documented to work; I have not seen it. A push redeploys your Worker automatically: the button's form says "Every push to your production branch will be deployed automatically". Tip: check the Deployments tab on the Worker's page in the dashboard after your first push. To deploy without pushing, run `npm run deploy` from your clone.
2. **Deploy a fresh copy** with the button and move the data across, as in [handover.md](handover.md). More work, but it starts clean.

Apply all migrations before running new code that needs them. For instance `0011_site_icons` adds the `site_icons` table: without it Settings, saving or removing the logo and uploading icons return errors, while public pages fall back to the default icons.

Migrations `0015` to `0017` rebuild the `bookings` table (for lanes and places) in three files, because Cloudflare's documentation does not say whether a migration file is applied as one transaction: `0016` is written so that running it again after an interruption finishes the job, and the old table is only dropped by `0017`, after the rows have been copied (and checked). From `0015` (which renames the old table) until the new Worker is live, the previous version of the Worker cannot read or make bookings, so a deploy that includes these migrations has a gap, normally seconds long: update at a quiet time, and take an export first (`npx wrangler d1 export`, see [handover.md](handover.md)). I have not measured the gap on a deployed copy. The booking table's id counter is not carried across (a write to D1's internal `sqlite_sequence` table might be refused, which would stop the migration after `0015` and leave the site down), so the id of a booking that was cleared before the migration may be given to a new booking; nothing outside the app refers to booking ids. Migration `0018` (the booking form's fields) only adds tables and rows, so it has no gap of its own: the previous Worker keeps working after it, and an event that Worker makes before the new one is live has no field rows and is read as Dog and Handler. The same goes for an event made in the window between `0016` and the new Worker going live: it has no layout row and no lane, so the new Worker gives it one unnamed lane, capacity 1 and a limit of 1 the first time anyone opens it (the public page, the booking form, or the admin list or event page), and it then behaves like any other event.

## Troubleshooting

### `/setup` says "Setup isn't ready"

The full text is: "Setup isn't ready: set SETUP_CODE (a phrase of at least 12 characters) as a Worker secret, then reload this page." (A 503.) `SETUP_CODE` is missing or shorter than 12 characters. Set it:

- Dashboard: the Worker, then **Settings**, then **Variables and Secrets**, and add a secret named `SETUP_CODE` (menu names **unverified**), or
- Terminal, in the project folder: `npx wrangler secret put SETUP_CODE`.

Reload `/setup`.

### An admin page says "Admin sign-in isn't set up."

This is a 503 on `/admin/*` and `/api/admin/*`. For a new deployment it normally means no admin secret exists yet **and** `SETUP_CODE` is missing or too short, so the page cannot send you to `/setup`. Fix the setup code as above, then open `/setup`. It can also mean `ADMIN_AUTH` is unset or wrong, or one of the sign-in settings is missing or malformed. The page does not say which; the reason is in the Worker's logs.

Read the logs with Wrangler (the command exists in the installed Wrangler 4.147.0, but I have not run it against a real deployment):

1. In one terminal: `npx wrangler tail` (add `--env preview` for the preview).
2. In another, reload the admin page.
3. Look for the line `Admin auth is not configured: <reason>`. The reason names the setting. The settings are in [admin-auth.md](admin-auth.md).

The Worker's logs may also be in the dashboard: **unverified**.

### `/setup` shows "Setup has already been completed. Sign in instead."

An admin has already signed in, so `/setup` is closed (404). Sign in at `/admin/login`. If the secret is lost, use [If the admin secret is lost](handover.md#if-the-admin-secret-is-lost).

### "That setup code isn't right." or "Too many attempts"

Check the code you chose. After 5 attempts in 15 minutes the page says "Too many attempts. Try again in N minutes." Wait that long. The code is trimmed of spaces at both ends, but spaces inside it count.

### Admin sign-in says "Too many attempts"

The admin sign-in allows 5 attempts per client per 15 minutes. Wait, or use the secret from your password manager. Everyone on the same network address shares the count.

### Visitors get a 429 error

The Free plan's daily request limit for the Worker (100,000 a day) has been passed. Booking pages and the API answer 429 until the day resets (00:00 UTC), while static files keep working. See the numbers in [costs.md](costs.md). A club with a few dozen bookers should not reach it; an event link shared widely, or a bot, might.

### The button's build failed

Open the build log on the Worker's page in the dashboard (**unverified** where). A migration step that fails stops the deploy, so the Worker is not updated with code that needs a missing table. Fix the cause and retry. `npm run db:migrations:apply` can be run on its own from a terminal.

### `migrations apply` stops at `0015` with "no such table: bookings"

**Unverified on real D1** (checked only on the local database, where running `0015` again after the rename gives exactly this error). It means the rename in `0015_bookings_legacy.sql` was committed but Wrangler's own record of it in the `d1_migrations` table was not, so Wrangler tries `0015` again. Do not edit the migration. First confirm the state: the old table must exist under its new name and the new one must not exist yet.

```sh
npx wrangler d1 execute DB --remote --env="" --command "SELECT name FROM sqlite_master WHERE name IN ('bookings', 'bookings_legacy')"
```

Only if that lists `bookings_legacy` and not `bookings`, record `0015` as applied by hand, then run the migrations again (it carries on with `0016`):

```sh
npx wrangler d1 execute DB --remote --env="" --command "INSERT INTO d1_migrations (name) VALUES ('0015_bookings_legacy.sql')"
npm run db:migrations:apply
```

If both tables are listed, or neither, stop and restore from the export you took before updating (see [handover.md](handover.md#exporting-before-deleting)).

### Admin shows an error saving Settings or a logo

The database probably lacks a migration. Run `npm run db:migrations:apply` (or `npm run deploy`), logged in to the club's account.

### Local development: `/setup` 404s

Check `.dev.vars` has `SETUP_CODE` of 12 or more characters and that neither `ADMIN_PASSWORD_HASH` nor `ADMIN_SESSION_SECRET` is set there (setting either turns `/setup` off). Also check `ADMIN_AUTH` is `password`.

## Before a real event

- **Data location.** The button creates the database for you: whether it offers a location or jurisdiction choice is **unverified**. If bookings must stay in the EU, use the command-line path with `--jurisdiction eu`.
- **The booking API has no rate limiting or bot protection.** Only the admin sign-in and `/setup` count attempts. Add something like Cloudflare Turnstile before posting the link publicly.
- **Privacy notice.** The booking form shows one. The default says details are kept until an organiser deletes the event, and nothing is deleted automatically, which is what the app does: delete or clear out old events from the admin list when you no longer need them. The default names no data controller or contact, so set the privacy contact on the Settings page and, if you can, replace the notice with your own text ([configuration.md](configuration.md)).
- **Admin sign-in.** The default is a single shared secret with no second factor and no per-person identity ([admin-auth.md](admin-auth.md), "Known limits"). If that is not enough for your club, put the site on a custom domain and use Access (above).
- **Keep these safe.** Your Cloudflare login, the `SETUP_CODE` and the admin secret: see [handover.md](handover.md).
