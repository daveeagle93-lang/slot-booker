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

## 3. Put the database IDs in `wrangler.jsonc` (locally, do not commit them)

`wrangler.jsonc` holds all-zero placeholder IDs. The top-level `d1_databases` block is production; `env.preview.d1_databases` is the preview database. Replace each placeholder with the matching real ID:

```jsonc
{
  // ...existing fields unchanged...
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "slot-booker-db",
      "database_id": "<YOUR-PRODUCTION-DATABASE-ID>",
      "migrations_dir": "migrations"
    }
  ],
  "env": {
    "preview": {
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "slot-booker-db-preview",
          "database_id": "<YOUR-PREVIEW-DATABASE-ID>",
          "migrations_dir": "migrations"
        }
      ]
    }
  }
}
```

`production` and `preview` are the only two environments Pages supports. The top-level config is the base for local development and production, and preview deployments inherit it unless `env.preview` overrides it. `d1_databases` is non-inheritable, so the preview block must be complete, binding and `migrations_dir` included. Cloudflare's docs: "if any one non-inheritable key is overridden for any environment... all non-inheritable keys must also be specified in the environment configuration".

Keep the top-level `database_name` as `slot-booker-db`: the test suite and `npm run db:migrate:local` use it.

The repo keeps the placeholders so no account details are committed. To stop git offering your edit for commit:

```sh
git update-index --skip-worktree wrangler.jsonc
```

(Undo with `git update-index --no-skip-worktree wrangler.jsonc`.)

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

2. Add the non-secret setting to `wrangler.jsonc`, in **both** the top-level block and `env.preview` (like `d1_databases`, `vars` is not inherited by `env.preview`; the Pages docs also say that once a Wrangler config file is used, the same fields can't be edited in the dashboard):

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

If the project name `slot-booker` is taken in Cloudflare's global `pages.dev` namespace, choose another name and use it in both commands (and as `name` in `wrangler.jsonc`).

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
- Archiving and deleting events are not built yet. (Managing bookings and the lineup export are: see "Managing bookings" in the README.)

## Before a real event

- Data residency: if bookings must stay in the EU, create the databases with `--jurisdiction eu` (step 2).
- The booking API has no rate limiting or bot protection yet. Add something like Cloudflare Turnstile before posting the link publicly.
- The booking form shows a privacy notice. The default wording says the club deletes booking details after the event, which the app does not do for you yet. Replace it with your own text, or make sure the club does that by hand (`docs/configuration.md`).
