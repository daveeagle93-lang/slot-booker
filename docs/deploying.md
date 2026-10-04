# Deploying a preview to Cloudflare

These steps create a remote D1 database, apply the migrations to it and publish a Pages **preview** deployment. Run them from the repo root, in order. They need a Cloudflare account; nothing here is run by the repo's scripts or tests.

Syntax checked against the installed Wrangler (4.147.0) `--help` output and the Cloudflare Pages docs (Wrangler configuration for Pages; Direct Upload).

## 1. Log in (once)

```sh
npx wrangler login
npx wrangler whoami
```

## 2. Create the remote D1 database

```sh
npx wrangler d1 create slot-booker-db --location weur
```

`--location weur` is a placement hint (Western Europe). If you need data held within the EU, use `--jurisdiction eu` instead (the location hint is then ignored).

The output prints a `database_id` (a UUID). Copy it.

## 3. Put the database ID in `wrangler.jsonc` (locally, do not commit it)

`wrangler.jsonc` holds an all-zero placeholder `database_id`. Replace it with your real ID, and add the same binding under `env.preview`. Cloudflare's docs list `d1_databases` as a non-inheritable key and do not say outright whether top-level bindings reach preview deployments, so state it explicitly rather than assume:

```jsonc
{
  // ...existing fields unchanged...
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "slot-booker-db",
      "database_id": "<YOUR-DATABASE-ID>",
      "migrations_dir": "migrations"
    }
  ],
  "env": {
    "preview": {
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "slot-booker-db",
          "database_id": "<YOUR-DATABASE-ID>",
          "migrations_dir": "migrations"
        }
      ]
    }
  }
}
```

Both entries point at the same database, so previews and production would share data. That is fine while there is no production deployment; create a second database and use its ID in `env.preview` when that changes.

The repo keeps the placeholder so no account details are committed. To stop git offering your edit for commit:

```sh
git update-index --skip-worktree wrangler.jsonc
```

(Undo with `git update-index --no-skip-worktree wrangler.jsonc`.)

## 4. Apply the migrations to the remote database

```sh
npx wrangler d1 migrations list slot-booker-db --remote
npx wrangler d1 migrations apply slot-booker-db --remote
npx wrangler d1 migrations list slot-booker-db --remote
```

The first command should list 0001, 0002 and 0003 as pending; the last should list none. `apply` asks for confirmation and takes a backup first.

## 5. Create the Pages project and deploy a preview

```sh
npx wrangler pages project create slot-booker --production-branch main
npx wrangler pages deploy public --project-name slot-booker --branch preview
```

Any branch other than the production branch (`main`) produces a **preview** deployment. Wrangler prints a deployment URL (`https://<hash>.slot-booker.pages.dev`) and the branch alias (`https://preview.slot-booker.pages.dev`). The `functions/` directory is picked up from the current directory automatically.

If the project name `slot-booker` is taken in Cloudflare's global `pages.dev` namespace, choose another name and use it in both commands (and as `name` in `wrangler.jsonc`).

## 6. Check the binding works

```sh
curl -s https://preview.slot-booker.pages.dev/api/health
curl -s https://preview.slot-booker.pages.dev/api/events/not-a-real-slug
```

The first should return `{"ok":true}`. The second should return a JSON 404 (`not_found`). A 500 there means the `DB` binding is missing from the preview deployment: check Pages project, Settings, Bindings (Preview) in the dashboard, and the `env.preview` block above.

## Not covered

- `npm run seed:local` only writes to the local database. A fresh remote database has no events, so a preview has nothing to book until an event is inserted (an admin UI is planned for later).
- Custom domains, production deployment and secrets are out of scope here.
