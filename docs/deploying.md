# Deploying a preview to Cloudflare

These steps create two remote D1 databases (one for preview, one for production), apply the migrations to the preview one, seed it with a sample event and publish a Pages **preview** deployment. Run them from the repo root, in order. They need a Cloudflare account; nothing here is run by the repo's tests.

Syntax checked against the installed Wrangler (4.147.0) `npx wrangler d1 <command> --help` output and these Cloudflare docs: [Wrangler configuration for Pages](https://developers.cloudflare.com/pages/functions/wrangler-configuration/), [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) and Pages Direct Upload.

## 1. Log in (once)

```sh
npx wrangler login
npx wrangler whoami
```

## 2. Create the two remote D1 databases

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

   `vars` is optional: plain-text settings such as `ADMIN_AUTH`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `BOOKING_CUTOFF_OFFSET_MINUTES` and `PRIVACY_NOTICE` (`docs/admin-auth.md`, `docs/configuration.md`). Values are strings. `name` is also optional: your Pages project name, if `slot-booker` is taken. Secrets (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`) are refused here; they go in Pages secrets (step 6) and `.dev.vars`.

2. Generate the config:

   ```sh
   npm run configure
   ```

   It checks that both IDs are UUIDs, are not the all-zero placeholders and differ from each other, then writes `wrangler.json`: the contents of `wrangler.jsonc` with your production ID in the top-level `d1_databases`, your preview ID in `env.preview.d1_databases`, and your `vars` in **both** blocks (`vars` and `d1_databases` are not inherited by `env.preview`). It prints what it wrote, by variable name only. Run it again whenever `wrangler.jsonc` or `account.local.json` changes (for example after pulling). `npm run configure -- --clear` removes `wrangler.json`, so Wrangler uses the committed placeholders again; it will not delete or overwrite a `wrangler.json` it did not make.

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

The admin pages (`/admin/`) and the admin API (`/api/admin/*`) answer 503 until `ADMIN_AUTH` is set to `password` or `access`. `docs/admin-auth.md` explains both options, how the Access one is set up in Zero Trust, and the limits of each. For the password option on the preview:

1. Generate the admin secret. It prints the secret on stderr, once (store it in your password manager now), and only the hash to stdout:

   ```sh
   npm run --silent generate-admin-secret
   ```

2. Add the non-secret setting to `vars` in `account.local.json` (step 3) and run `npm run configure` again. The script puts it in **both** the top-level block and `env.preview` (`vars` is not inherited by `env.preview`; the Pages docs also say that once a Wrangler config file is used, the same fields can't be edited in the dashboard):

   ```jsonc
   "vars": { "ADMIN_AUTH": "password" }
   ```

3. Set the two secrets, `ADMIN_PASSWORD_HASH` (the hash line from step 1, not the secret) and `ADMIN_SESSION_SECRET` (at least 32 random characters, for example from `openssl rand -base64 48`). Each command prompts for the value:

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker
   ```

   Cloudflare's [Pages bindings docs](https://developers.cloudflare.com/pages/functions/bindings/) say secrets are set per environment and must be set before the deployment that uses them. The installed `wrangler pages secret put --help` has no environment flag, so which environment these commands write to is **not verified here**: after running them, check Settings, Variables and Secrets for the project in the dashboard, and add any missing secret to the Preview environment there.

If login later fails with a Cloudflare CPU-limit error, see "Known limits" in `docs/admin-auth.md`: the Access option avoids checking a credential in the Worker.

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

Then check the admin gate:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://preview.slot-booker.pages.dev/api/admin/events
curl -sI https://preview.slot-booker.pages.dev/admin/login
```

The first should print `401` (it prints `503` if `ADMIN_AUTH` or its secrets are missing or malformed: the Pages logs say which). The second should be `200` and show a `Content-Security-Policy` header containing `frame-ancestors 'none'`; if that header is missing in production, the login page could be framed, so tell the maintainers. Then open `/admin/login` in a browser, sign in, and create an event.

## Not covered

- Custom domains and production deployment are out of scope here.
- Nothing is deleted automatically, ever: there is no retention timer. (Archiving, deleting and the lineup export are built: see "Archiving and deleting" and "Managing bookings" in the README.)

## Before a real event

- Data residency: if bookings must stay in the EU, create the databases with `--jurisdiction eu` (step 2).
- The booking API has no rate limiting or bot protection yet. Add something like Cloudflare Turnstile before posting the link publicly.
- The booking form shows a privacy notice. The default wording says the details are kept until an organiser deletes the event, and that nothing is deleted automatically, which is what the app does: delete or clear out old events from the admin list when you no longer need them. The default names no data controller or contact, so replace it with your own text that does (`docs/configuration.md`).
