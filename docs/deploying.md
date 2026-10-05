# Deploying a preview to Cloudflare

These steps create two remote D1 databases (one for preview, one for production), apply the migrations to the preview one, seed it with a sample event and publish a Pages **preview** deployment. Run them from the repo root, in order. They need a Cloudflare account; nothing here is run by the repo's tests.

> **Hard rule.** Admin sign-in with Cloudflare Access (`ADMIN_AUTH=access`) is only for a deployment served on a custom domain on a Cloudflare zone you control. A deployment reachable only on `*.pages.dev`, and every preview, uses `ADMIN_AUTH=password`. This is a project rule that the Worker doesn't check, and the planned setup wizard will enforce it. The reasons are in [`docs/admin-auth.md`](admin-auth.md#hard-rule-access-needs-a-custom-domain-pagesdev-uses-the-password). The preview below therefore uses the password provider; the Access route for a custom domain is a pointer at the end.

Syntax checked against the installed Wrangler (4.147.0) `npx wrangler d1 <command> --help` output and these Cloudflare docs: [Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) and Pages Direct Upload.

Three things below come from the maintainer's real preview deployment rather than from the docs or the Wrangler source: which environment `wrangler pages secret put` writes to (step 6), the `wrangler d1 create` prompt about the Wrangler config (step 2) and the API token permissions (step 1). Where this document says so, it also says which parts were not run.

## 1. Log in (once)

```sh
npx wrangler login
npx wrangler whoami
```

### Using an API token instead of `wrangler login`

If you set `CLOUDFLARE_API_TOKEN` instead of running `wrangler login`, the token needs these permissions (Account level): **D1 Edit** and **Pages Edit**. Without **User Details: Read**, `npx wrangler whoami` prints an error about the user lookup. That is harmless: deploy and D1 commands still worked without it. (Source: the maintainer's real preview deployment. I have not tried any other permission set.)

## 2. Create the two remote D1 databases

**When `wrangler d1 create` offers to add the binding to your Wrangler config, answer No.** If you answer Yes it edits `wrangler.jsonc` with a binding name that is not the committed one (the committed binding is `DB`; Wrangler proposes a different name). If you answered Yes by mistake, undo it with `git checkout -- wrangler.jsonc` and run `npm run configure` again (step 3). Answer No for both commands.

```sh
npx wrangler d1 create slot-booker-db-preview --location weur
npx wrangler d1 create slot-booker-db --location weur
```

`slot-booker-db-preview` is used by preview deployments and `slot-booker-db` by production. Production is optional until go-live, but creating both now keeps the names and IDs in one place.

`--location weur` is a placement hint (Western Europe). If you need data held within the EU, use `--jurisdiction eu` instead (the location hint is then ignored). Use the same choice for both databases, so preview and production hold data in the same place.

Each command prints a `database_id` (a UUID). Copy both, noting which is which.

## 3. Keep your database IDs out of the repo: `npm run configure`

The committed `wrangler.jsonc` holds all-zero placeholder IDs, so no account details are committed. Your real IDs go in a git-ignored file, and a script turns the two into a git-ignored `wrangler.json` that Wrangler reads instead. You never edit `wrangler.jsonc`.

1. Copy the example and fill it in with the two IDs from step 2 (the top-level block is production, `env.preview` is the preview database):

   ```sh
   cp account.local.example.json account.local.json
   ```

   ```jsonc
   {
     "productionDatabaseId": "<database_id of slot-booker-db>",
     "previewDatabaseId": "<database_id of slot-booker-db-preview>",
     "vars": { "ADMIN_AUTH": "password" }   // optional, see below
   }
   ```

   `vars` is optional: plain-text settings such as `ADMIN_AUTH`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `BOOKING_CUTOFF_OFFSET_MINUTES` and `PRIVACY_NOTICE` (`docs/admin-auth.md`, `docs/configuration.md`). Values are strings. `vars` applies to both production and preview. When the two need different values, add `productionVars` and/or `previewVars` with the same shape: each is added to its own environment only and wins over `vars` there (`account.local.example.json` shows the pattern; `docs/configuration.md`, "Setting them", has the rules). `name` is also optional: your Pages project name, if `slot-booker` is taken. Secrets (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`) are refused here; they go in Pages secrets (step 6) and `.dev.vars`.

2. Generate the config:

   ```sh
   npm run configure
   ```

   It checks that both IDs are UUIDs, are not the all-zero placeholders and differ from each other, then writes `wrangler.json`: the contents of `wrangler.jsonc` with your production ID in the top-level `d1_databases`, your preview ID in `env.preview.d1_databases`, and your variables in each block: `vars` in **both**, plus `productionVars` in the top level and `previewVars` in `env.preview` (`vars` and `d1_databases` are not inherited by `env.preview`). It prints what it wrote, by variable name only, listed separately for production and preview so you can see where they differ. Run it again whenever `wrangler.jsonc` or `account.local.json` changes (for example after pulling). `npm run configure -- --clear` removes `wrangler.json`, so Wrangler uses the committed placeholders again; it will not delete or overwrite a `wrangler.json` it did not make.

3. Keep the top-level `database_name` as `slot-booker-db`: the test suite and `npm run db:migrate:local` use it (the script does not change it).

### Why this works, and how far it was checked

Wrangler looks for `wrangler.json` before `wrangler.jsonc` in the same directory, so the generated file takes over without any flag. It is a normal config, so `env.preview` works. Evidence, by strength:

- **Run locally on the installed Wrangler 4.147.0, in a throwaway copy of the repo (nothing remote):**
  - `npx wrangler pages dev` started with the generated file, listed `env.DB (slot-booker-db)` and the `vars` as bindings, and served `/api/health`.
  - `npx wrangler d1 migrations list slot-booker-db-preview --local --env preview` found the preview database, and `slot-booker-db ... --env preview` was rejected with "Couldn't find a D1 DB ... in your wrangler.json file" (the same production guard as step 4).
  - `npx wrangler pages functions build` compiled. `npx wrangler pages functions build-env . --outfile f.json` runs Wrangler's Pages config reader and validator, which `pages deploy` also uses: with `PAGES_ENVIRONMENT=preview` it returned the `env.preview` vars, and with `PAGES_ENVIRONMENT=production` the top-level vars.
  - `npm test` passed (1174 tests) with the generated file present, vars included. The tests do not depend on it: the test environment now exposes only the `DB` binding.
- **Read from the Wrangler 4.147.0 source, not run (`pages deploy` needs a Cloudflare login and has no dry-run option):** `pages deploy` finds its config in the current directory (`wrangler.json` first), asks the Pages API which branch is production, and reads the config for `production` or `preview` accordingly, so a deploy with `--branch preview` uses the `env.preview` block (with no `--branch` it counts as production). It also sends that block's bindings with the deployment. I have **not verified** against a real deployment that Pages applies those bindings; step 8 checks the result.
- **Not in Cloudflare's docs:** that `wrangler.json` takes priority over `wrangler.jsonc`. Cloudflare's [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) page only says Wrangler "supports both JSON (`wrangler.json` or `wrangler.jsonc`)". This is Wrangler's lookup order in the installed code, and it may change in a later version. Check after upgrading Wrangler: `npx wrangler pages dev` lists your `vars` among its bindings when the generated file is in use.

Local state: Wrangler keys the local D1 file on the `database_id` (checked: placeholder and real IDs gave different files under `.wrangler/state`). After `npm run configure`, `npm run dev` therefore starts from an empty local database: run `npm run db:migrate:local` (and `npm run seed:local` if you want sample data). `npm run configure -- --clear` brings the old one back.

Cloudflare's docs on the `env.preview` block this relies on ([Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)): "`production` and `preview` are the only two options available via `[env.<ENVIRONMENT>]`", and "if any one non-inheritable key is overridden for any environment... all non-inheritable keys must also be specified in the environment configuration". That is why the script fills both blocks.

### Options that were checked and rejected

- **Wrangler's "generated configuration" redirect** (`.wrangler/deploy/config.json` pointing at another file; [docs](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration)). It does not fit a Pages project that needs two databases. Cloudflare's page says "The generated configuration file should not include any environments", and Wrangler 4.147.0 enforces it: with `env.preview` in the redirected file, `pages dev` stops with "Redirected configurations cannot include environments". Without `env`, one file is one environment, so preview and production deployments would share a database unless you regenerate before each deploy. `d1` commands also ignore the redirect (checked: "Couldn't find a D1 DB ... in your wrangler.jsonc file").
- **`--config` / `--env`**: `wrangler pages deploy` refuses both ("Pages does not support custom paths for the Wrangler configuration file", "Pages does not support targeting an environment with the --env flag"; both seen locally) and `pages dev` refuses `--env`.
- **Environment-variable substitution in the config file**: Cloudflare's configuration page (searched for it) describes no such mechanism, and `.env` / `.dev.vars` only feed local development. I did not search the Wrangler source for one.
- **Fallback if you prefer to edit `wrangler.jsonc` itself:** replace the placeholders by hand (same structure as the generated file) and hide the edit from git with `git update-index --skip-worktree wrangler.jsonc` (undo: `--no-skip-worktree`). Git may then refuse to pull or switch branches when that file changes upstream (not tested here), and the edit is easy to commit by mistake with `--no-skip-worktree`; hence the script.

## 4. Apply the migrations to the remote databases

Preview first:

```sh
npx wrangler d1 migrations list slot-booker-db-preview --remote --env preview
npx wrangler d1 migrations apply slot-booker-db-preview --remote --env preview
npx wrangler d1 migrations list slot-booker-db-preview --remote --env preview
```

The first command should list every file in `migrations/` as pending; the last should list none. `apply` asks for confirmation and takes a backup first.

Production, only when you are ready to go live:

```sh
npx wrangler d1 migrations apply slot-booker-db --remote
```

Always pass the database name and, for preview, `--env preview`. With `--env preview`, Wrangler looks the database up only in `env.preview.d1_databases`, so `slot-booker-db --env preview` is rejected ("Couldn't find a D1 DB with the name or binding 'slot-booker-db'"), as is the preview name without `--env preview`. That guards against migrating production by mistake. (Checked locally with `--local`; the remote commands resolve the name the same way but were not run for this document.)

Wrangler's `--preview` flag ("Execute commands/files against a preview D1 DB") is a different, older mechanism based on `preview_database_id`. This repo does not use it; do not mix it with `--env preview`.

## 5. Seed the preview with a sample event

A fresh database has no events, so the preview has nothing to book yet. After the migrations are applied (step 4):

```sh
npm run seed -- --remote --env preview
```

This inserts the same sample event and bookings as `npm run seed:local` into the remote **preview** database, and only that one: `--remote` requires `--env preview`, and the script refuses production or any other environment. Pass `--no-bookings` to skip the sample bookings. Wrangler's own prompts appear in your terminal; answer them there.

The script does not apply migrations. If you run it first, Wrangler fails with `no such table: events`; apply the migrations (step 4) and run it again. Each run adds another event.

It prints the event details and a path such as `/e/<slug>`. Open that path on your preview URL (step 7 gives the URL). For a local database use `npm run seed:local` as before.

## 6. Set up admin sign-in

The admin pages (`/admin/`) and the admin API (`/api/admin/*`) answer 503 until `ADMIN_AUTH` is set to `password` or `access`. On `pages.dev`, which is where a preview lives, the answer is `password` (see the hard rule above). `docs/admin-auth.md` explains both providers and the limits of each; its Access runbook is for a custom domain only. For the password provider on the preview:

1. Generate the admin secret. It prints the secret on stderr, once (store it in your password manager now; it can't be recovered from the hash), and only the hash to stdout:

   ```sh
   npm run --silent generate-admin-secret
   ```

2. Add the non-secret setting to `vars` in `account.local.json` (step 3) and run `npm run configure` again. Under `vars` the script puts it in **both** the top-level block and `env.preview` (`vars` is not inherited by `env.preview`; the Pages docs also say that once a Wrangler config file is used, the same fields can't be edited in the dashboard):

   ```jsonc
   "vars": { "ADMIN_AUTH": "password" }
   ```

3. Set the two secrets, `ADMIN_PASSWORD_HASH` (the hash line from step 1, not the secret) and `ADMIN_SESSION_SECRET` (at least 32 random characters, for example from `openssl rand -base64 48`). Each command prompts for the value. Run them once the Pages project exists (step 7 creates it; the runbook below does that first):

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker --env preview
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker --env preview
   ```

   `wrangler pages secret put` targets the **production** environment by default, and `--env preview` targets Preview. The maintainer confirmed this on a real preview deployment, from the command's own output. The installed `npx wrangler pages secret put --help` (Wrangler 4.147.0) lists only `--project-name`, so the flag is **not in `--help`**: do not leave `--env` out, and do not rely on `--help` to find it. For production, with its own different values, use `--env production`:

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker --env production
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker --env production
   ```

   Cloudflare's [Pages bindings docs](https://developers.cloudflare.com/pages/functions/bindings/) say secrets are set per environment and must be set before the deployment that uses them. As a confirmation, not as the fix, check Settings, Variables and Secrets for the project in the dashboard: the secrets should be listed under Preview. Creating the project, then setting the secrets, then deploying is the order that worked on the maintainer's real deployment; I have not tested setting them before the project exists.

If login later fails with a Cloudflare CPU-limit error, see "Known limits" in `docs/admin-auth.md`. Access would avoid checking a credential in the Worker, but only on a custom domain, so it isn't an answer for a `pages.dev` preview.

## 7. Create the Pages project and deploy a preview

```sh
npx wrangler pages project create slot-booker --production-branch main
npx wrangler pages deploy public --project-name slot-booker --branch preview
```

Any branch other than the production branch (`main`) produces a **preview** deployment. Wrangler prints a deployment URL (`https://<hash>.slot-booker.pages.dev`) and the branch alias (`https://preview.slot-booker.pages.dev`). The `functions/` directory is picked up from the current directory automatically.

If the project name `slot-booker` is taken in Cloudflare's global `pages.dev` namespace, choose another name and use it in both commands (and as `name` in `account.local.json`, then run `npm run configure` again).

## 8. Check the binding and the admin gate

```sh
curl -s https://preview.slot-booker.pages.dev/api/health
curl -s https://preview.slot-booker.pages.dev/api/events/not-a-real-slug
```

The first should return `{"ok":true}`. The second should return a JSON 404 (`not_found`). A 500 there means the `DB` binding is missing from the preview deployment: check Pages project, Settings, Bindings (Preview) in the dashboard, and the `env.preview` block in step 3.

Then check the landing page at the root:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://preview.slot-booker.pages.dev/
```

It should print `200`, and opening `/` in a browser should show the landing page, with the club name or "Slot booker", the logo and the upcoming events. It lists only upcoming, non-archived, listed events, each with its booking link, and nothing else. I have not run this check against a remote deployment.

Then check the admin gate:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://preview.slot-booker.pages.dev/api/admin/events
curl -sI https://preview.slot-booker.pages.dev/admin/login
```

The first should print `401` (it prints `503` if `ADMIN_AUTH` or its secrets are missing or malformed: the function logs say which, see [Troubleshooting](#troubleshooting)). The second should be `200` and show a `Content-Security-Policy` header containing `frame-ancestors 'none'`; if that header is missing in production, the login page could be framed, so tell the maintainers. Then open `/admin/login` in a browser, sign in, and create an event. Also open Settings (`/admin/settings`) and set the privacy contact (a name and an email address; the contact counts as set once it has an email): until then the booking page shows signed-in admins a warning and tells bookers nothing about who to contact. See [`docs/branding.md`](branding.md).

## Troubleshooting

### Admin answers 503

The response does not say which setting is missing or malformed; the reason is only in the function logs. To read it:

1. Start the log tail first, in its own terminal:

   ```sh
   npx wrangler pages deployment tail --project-name slot-booker --environment preview --format pretty
   ```

   Use `--environment production` for production. The flag names and choices (`--environment`, `--format pretty`) are from `npx wrangler pages deployment tail --help` on Wrangler 4.147.0. I have not run the tail against a real deployment.
2. In another terminal, reproduce the request:

   ```sh
   PREVIEW=https://preview.slot-booker.pages.dev
   curl -i $PREVIEW/api/admin/session
   ```

3. In the tail, read the line `Admin auth is not configured: <reason>`. The reason names the setting that is missing or malformed. The settings and their accepted forms are in the table in [`docs/admin-auth.md`](admin-auth.md#settings). Fix it (`vars` via `npm run configure` and a redeploy; secrets via `wrangler pages secret put ... --env preview` or `--env production`, step 6) and request again.

## Production on a custom domain with Access

Going live on a custom domain, with Cloudflare Access in front of `/admin/*` and `/api/admin/*`, is described click by click in "Access provider" in [`docs/admin-auth.md`](admin-auth.md#setting-it-up-custom-domain). Apart from that pointer a production go-live is out of scope here. Production also needs its migrations applied first (step 4, `npx wrangler d1 migrations apply slot-booker-db --remote`; check the pending list before applying) and its own `ADMIN_AUTH` variables in `account.local.json`: put them under `productionVars` (and keep `ADMIN_AUTH` for previews under `previewVars`), because `vars` goes to both production and preview. See step 5 of that runbook.

## Not covered

- A production go-live beyond the pointer above, and DNS or Pages custom-domain setup beyond what `docs/admin-auth.md` says.
- Nothing is deleted automatically, ever: there is no retention timer. (Archiving, deleting and the lineup export are built: see "Archiving and deleting" and "Managing bookings" in the README.)

## Before a real event

- Data residency: if bookings must stay in the EU, create the databases with `--jurisdiction eu` (step 2).
- The booking API has no rate limiting or bot protection yet. Add something like Cloudflare Turnstile before posting the link publicly.
- The booking form shows a privacy notice. The default wording says the details are kept until an organiser deletes the event, and that nothing is deleted automatically, which is what the app does: delete or clear out old events from the admin list when you no longer need them. The default names no data controller or contact, so replace it with your own text that does (`docs/configuration.md`).
- Admin sign-in: on `pages.dev` it is the password provider, a single shared secret with no second factor and no per-person identity (`docs/admin-auth.md`, "Known limits"). If that is not enough for your club, put the site on a custom domain and use Access (above).
- Preview URLs are public, and the booking pages work on them like any other deployment. Treat a preview's data as test data and delete the preview events from the admin list when you have finished.

## Runbook: deploy a preview (password sign-in, pages.dev)

**These commands are for you to run; nothing in this repo runs them.** They need a Cloudflare account and change it. Run them in order from a clean checkout of this repo with Node 24, from the repo root. The steps are the sections above in one list; where a step says "check", the check matters. `slot-booker` is the Pages project name: if it is taken, use another and set `name` in `account.local.json` as well.

1. Install and log in.

   ```sh
   npm install
   npx wrangler login
   npx wrangler whoami
   ```

   If you use a `CLOUDFLARE_API_TOKEN` instead of `wrangler login`, give it D1 Edit and Pages Edit (Account level); without User Details: Read, `whoami` prints a harmless error about the user lookup (section 1).

2. Create the two D1 databases and copy each `database_id` it prints, noting which is which. If bookings must stay in the EU, use `--jurisdiction eu` instead of `--location weur` in both commands, before you run them. **When Wrangler offers to add the binding to your Wrangler config, answer No** (both times): Yes edits `wrangler.jsonc` with a binding name other than the committed `DB`. If you answered Yes by mistake, run `git checkout -- wrangler.jsonc`, then `npm run configure` again.

   ```sh
   npx wrangler d1 create slot-booker-db-preview --location weur
   npx wrangler d1 create slot-booker-db --location weur
   ```

3. Fill in `account.local.json` (git-ignored).

   ```sh
   cp account.local.example.json account.local.json
   ```

   Edit it so it contains your two IDs and the password provider (a pages.dev-only deployment needs only `vars`; delete the `previewVars` and `productionVars` blocks of the example, and `BOOKING_CUTOFF_OFFSET_MINUTES` too if you want the default):

   ```jsonc
   {
     "productionDatabaseId": "<database_id of slot-booker-db>",
     "previewDatabaseId": "<database_id of slot-booker-db-preview>",
     "vars": { "ADMIN_AUTH": "password" }
   }
   ```

4. Generate `wrangler.json` (git-ignored) from it. It prints the variable names it wrote, never their values.

   ```sh
   npm run configure
   ```

5. Apply the migrations to the **preview** database: the first list shows every file in `migrations/` as pending, the last shows none. `apply` asks you to confirm.

   ```sh
   npx wrangler d1 migrations list slot-booker-db-preview --remote --env preview
   npx wrangler d1 migrations apply slot-booker-db-preview --remote --env preview
   npx wrangler d1 migrations list slot-booker-db-preview --remote --env preview
   ```

6. Seed the preview with a sample event and bookings (`--no-bookings` for the event only). It prints the event's path, `/e/<slug>`.

   ```sh
   npm run seed -- --remote --env preview
   ```

7. Create the Pages project.

   ```sh
   npx wrangler pages project create slot-booker --production-branch main
   ```

8. Generate the admin secret. The secret appears once on stderr: put it in your password manager now. Only the hash goes to stdout. Then make the session secret and keep it somewhere safe too, or you will have to rotate it if you lose it.

   ```sh
   npm run --silent generate-admin-secret
   openssl rand -base64 48
   ```

9. Set the two secrets. Each command prompts for its value: paste the **hash line** from step 8 for `ADMIN_PASSWORD_HASH` (not the secret), and the `openssl` output for `ADMIN_SESSION_SECRET`. When you set up production, run step 8 again and use a **different** admin secret and a different `ADMIN_SESSION_SECRET` there: with identical values a stolen preview session cookie would also work on production, and preview code from another branch would handle the production admin secret.

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker --env preview
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker --env preview
   ```

   Without `--env`, `wrangler pages secret put` writes to **production** (confirmed on the maintainer's real run; `--env` is not in the command's `--help`). For production use `--env production` in both commands.

   Then, as a confirmation, in the dashboard open "Workers & Pages", the project, "Settings" and "Variables and Secrets", and check that both secrets are listed for the **Preview** environment.

10. Deploy as a preview, from the repo root (`functions/` is picked up automatically). Any branch other than `main` is a preview, and it uses the `env.preview` block of `wrangler.json`.

    ```sh
    npx wrangler pages deploy public --project-name slot-booker --branch preview
    ```

11. Check the deployment. `PREVIEW` is the branch alias Wrangler printed (`https://preview.slot-booker.pages.dev` for the default name).

    ```sh
    PREVIEW=https://preview.slot-booker.pages.dev
    curl -s $PREVIEW/api/health
    curl -s $PREVIEW/api/events/not-a-real-slug
    curl -s -o /dev/null -w "%{http_code}\n" $PREVIEW/
    curl -s -o /dev/null -w "%{http_code}\n" $PREVIEW/api/admin/events
    curl -sI $PREVIEW/admin/login
    curl -sI $PREVIEW/admin/login | grep -i "^content-security-policy"
    ```

    Expected: `{"ok":true}`; a JSON 404 with code `not_found`; `200` for the root (the landing page, with the club name or "Slot booker", the logo and the upcoming, non-archived, listed events with their booking links: open `$PREVIEW/` in a browser to see it); `401`; a `200` with headers; and a `Content-Security-Policy` line that contains `frame-ancestors 'none'`. A 500 on the first two means the `DB` binding is missing from the preview (dashboard: project, "Settings", "Bindings", Preview). A `503` on the admin events request means `ADMIN_AUTH` or a secret is missing or malformed (the function logs say which: follow [Troubleshooting](#troubleshooting)). If the CSP header is missing, the login page could be framed: tell the maintainers.

12. In a browser, open `$PREVIEW/admin/login` and sign in with the secret from step 8 (let the password manager fill it in). Then check, using a test event (the seeded one will do):
    - Sign-in works, and a wrong secret is refused. After "Sign out", `/admin/` sends you back to the login page.
    - Open **Settings** (`/admin/settings`) and set the privacy contact (name and email). Check the booking page then shows it under "Privacy", and that it no longer shows the admin warning (see `docs/branding.md`).
    - Create an event, copy its booking link, open it in a private window and book a slot.
    - In the admin list, open the event's **Schedule**: the booking is there. Add a booking on another slot, move it, then clear it (confirm the prompt). Use **Copy lineup** and paste it somewhere.
    - **Edit** the event: change the name, and check the preview of removed bookings appears when you shorten the schedule (cancel instead of saving if you don't want to lose the test bookings).
    - **Archive** the event, check its public link shows it closed, **Unarchive** it, then **Delete…** it with its name typed in. Repeat for the seeded event if you don't want it kept.

Not verified: `wrangler pages deploy` itself (it needs a login and has no dry run; its use of the `env.preview` block was read from the Wrangler source, see "Why this works" in section 3), the landing page at `/` on a deployed preview, and whether a real login fits the free plan's 10 ms of CPU on Workers (only local timings exist, `docs/admin-auth.md`). The 302 and 503 answers from the admin middleware may not carry the `_headers` security headers in production either; only the static pages were checked. The runbook's order (create the Pages project in step 7, set the secrets in step 9, deploy in step 10) is the order that worked on the maintainer's real preview deployment; I have not tried any other order.
