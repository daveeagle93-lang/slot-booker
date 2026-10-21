# Design: "Switch to email sign-in" wizard

Status: **draft, design only, no code.** Written 21 October 2026 on branch `docs/access-wizard-design`, cut from `main`. Decisions D1 to D5 were recorded on 21 October 2026 and spike P6 has passed (see [Decisions](#decisions) and [Spikes](#spikes-live-tests-needed-before-building)).

Every Cloudflare claim below is tagged. **VERIFIED** means it was read in a primary source (Cloudflare's docs, the OpenAPI schema at github.com/cloudflare/api-schemas commit `880ff24`, or Wrangler's source at workers-sdk commit `f43e2e6`) on 21 October 2026. **Unverified** means inferred, secondary, or untested. Nothing here was run against a Cloudflare account; the one live call was an unauthenticated read of a public price catalogue. The list of live tests that must pass before any code is written is in [Spikes](#spikes-live-tests-needed-before-building). Source labels `[S1]`... are listed at the end.

## Summary

Today a club moves from the shared admin secret to Cloudflare Access by hand: buy or move a domain, attach it to the Worker, switch on Zero Trust, create an Access application with four paths and an email policy, copy the team domain and AUD tag, edit `wrangler.jsonc` on GitHub, and push. The last step is the one a non-technical organiser cannot do, and it also fights Wrangler: `vars` and `workers_dev` in the config overwrite whatever the dashboard or API says on every deploy.

The wizard replaces all of that with one admin page and a pasted API token. The design rests on five decisions:

1. **Auth settings live in D1, not in `wrangler.jsonc`.** The template stops shipping `vars.ADMIN_AUTH`. An env `ADMIN_AUTH=access` still wins, so existing hand-configured deployments keep working untouched.
2. **The token is used in memory for one wizard run and is never stored or logged.** It reaches Cloudflare only through a fixed allow-list of calls made by the Worker.
3. **Nothing switches until a real Access sign-in has reached the Worker and the Worker's own JWT check has passed against the new settings.** The switch is refused by the server otherwise, not just hidden in the UI.
4. **`SETUP_CODE` stays as break-glass**, always on in v1 and limited per client address (never by a global cap), so it cannot be used to lock the owner out. A D1-console statement is the last resort if even that is unavailable.
5. **`workers.dev` is closed by the Worker at run time, not by the API.** The API toggle does not survive a Workers Builds redeploy (see [Workers Builds](#workers-builds-and-wranglerjsonc)).

## Decisions

Recorded 21 October 2026. D1 to D4 accept the recommendation made in the first draft. D5 does not.

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| D1 | Should env `ADMIN_AUTH=password` pin password mode, or defer to D1? | **Defer to D1.** Only `ADMIN_AUTH=access` pins. | Every fork made from today's template has `"vars": { "ADMIN_AUTH": "password" }` in its own `wrangler.jsonc`. If that pinned password mode, the wizard could never work for any existing club until they edited GitHub, which is the problem we are solving. |
| D2 | Disable `workers.dev` through the API, or at run time in the Worker? | **At run time** (redirect to the custom domain; keep only break-glass reachable). API disable is an opt-in extra, unchecked by default. | Wrangler re-enables `workers.dev` on the next deploy unless the repo says `workers_dev: false`; a redirect also keeps already-shared booking links working. |
| D3 | Ship "create the Zero Trust organisation" via the API? | **Manual step first**; add the API button only if spike P1 shows `POST .../access/organizations` completes plan selection. | The endpoint has no plan field; the docs put plan and payment in the dashboard onboarding. |
| D4 | Account-owned token or user token in the template URL? | **Account-owned.** | The documented user-token template forces `accountId=*&zoneId=all`; the account template scopes in the dashboard. |
| D5 | Can break-glass be switched off in-app? | **No, not in v1.** Break-glass is always on whenever `SETUP_CODE` is set and valid. The only off switch is removing the `SETUP_CODE` Worker secret, outside the app. | An in-app switch is one more way to lock yourself out, and break-glass exists for the day everything else is broken. The lock-out risk it was meant to limit is handled by per-client rate limiting instead (section 5). |

## 1. Auth settings move to D1

### Table

One new migration, `0019` (`main` ends at `0018` since v1.1). It follows the `site_settings` pattern, a singleton row with snake_case columns (`migrations/0009_site_settings.sql`):

| Column | Meaning |
| --- | --- |
| `mode` | `password` (default) or `access`. The active provider when env does not pin one. |
| `access_team_domain` | `<team>.cloudflareaccess.com`. From the organisation's `auth_domain` [S3]. |
| `access_aud` | The Access application's AUD tag. From `result.aud` on create/list [S5]. |
| `access_hostname` | The canonical custom-domain hostname the site is served on. |
| `access_app_id`, `access_policy_id` | Cloudflare ids kept so a later run updates instead of duplicating. Not secret. |
| `admin_emails` | JSON array copy of the Allow policy, for display and re-sync. The Access policy stays the source of truth. |
| `verify_nonce`, `verify_nonce_expires_at` | One-time value for the sign-in test (section 4). |
| `verified_at`, `verified_config_hash` | When a real Access sign-in passed, and a hash of team domain + AUD + hostname it passed for. |
| `changed_at`, `changed_by` | `wizard`, `recovery`, `import` or `owner`. Shown as a banner after a recovery. |

A `CHECK` constraint makes `mode = 'access'` impossible unless team domain, AUD and hostname are all non-null, so a half-written row cannot lock admin out by itself. No secret is stored: the team domain and AUD are in every Access JWT the Worker sees anyway. The API token is never in this table.

### Which source wins

`adminAuthFor` (`src/server/auth/index.ts:19`) today reads only env. The new rule:

| env `ADMIN_AUTH` | D1 `mode` | Result |
| --- | --- | --- |
| `access` | any | Access, with `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` **from env**, exactly as today (fails closed if they are invalid). D1 is not consulted. The wizard shows "set in your deployment config". |
| `password` or unset | `access` | Access, with all three values **from D1**. |
| `password` or unset | `password`, or no row | Password, as today. |
| anything else | any | 503 `not_configured`, as today. |

Values are never mixed field by field between env and D1: a source is chosen whole, so a stray `ACCESS_AUD` in env cannot combine with a D1 team domain. The preview environment uses a separate D1 database (`wrangler.jsonc`, `env.preview`), so it has no row and stays on password.

Cost: D1 access mode adds one single-row read per admin request (password mode already reads D1 on every admin request, `src/server/auth/index.ts:33`). The `workers.dev` redirect (section 5) must **not** read D1 per public request, because most clubs are on `workers.dev` and would pay for a read on every booking-page view; it caches the decision per isolate for 60 seconds. Admin authentication itself is not cached.

### Migration for existing deployments

- **Schema:** the migration is additive and creates an empty table. `npm run deploy` applies it before `wrangler deploy` (`package.json:15`). Whether a club's Workers Builds "deploy command" runs that script rather than plain `wrangler deploy` is **unverified**; the forked repo's build settings need to be looked at on the test instance.
- **Clubs on password mode (the default):** no action. Their forked `wrangler.jsonc` still has `ADMIN_AUTH=password`, which the rule above treats as "defer to D1", so the wizard works the moment they sync their fork. They never have to edit `wrangler.jsonc`.
- **Clubs already on Access by env (a hand-configured instance):** unchanged; env access pins. The wizard page shows an **Import** button that copies the env values into D1 (`changed_by = 'import'`). It only becomes the live source once the three vars are removed from their config; the page says so. Importing never changes behaviour by itself.
- **The template:** `wrangler.jsonc` drops `vars.ADMIN_AUTH` from the top level and from `env.preview`, and the comment above it is rewritten. `src/test/wrangler-config.test.ts` gains an assertion that the template has no `ADMIN_AUTH` var (it does not assert on `vars` today). `docs/admin-auth.md` ("Settings", "Setting it up") and the README "Sign-in options" move the manual route to a short appendix. The same pass fixes the stale `ADMIN_AUTH: "password"` literal in `worker-configuration.d.ts:4-7`.

## 2. The API token

Template URL, permissions and status of each key are in [Token template URL](#token-template-url). Handling rules:

- **In memory only.** The page keeps the token in a JavaScript variable, never in `localStorage`, `sessionStorage`, cookies, the URL or the DOM after submit. A reload loses it and the admin pastes it again. Every wizard step is a "check, then change if needed" step, so a run can be repeated from any point.
- **Sent in a header** (`X-Cloudflare-Token`), not the body or query string, over the existing admin API with the existing CSRF checks. The Worker never writes it to D1, never passes it to `console.*`, and strips it from any error it returns. Responses are `Cache-Control: no-store`.
- **Fixed allow-list, not a proxy.** The Worker exposes named operations (`discover`, `provision`, `check-org`, ...) that call a fixed set of `api.cloudflare.com/client/v4` paths. No caller-supplied URL, path or method. Hostnames are validated as a fully qualified name that is inside a zone returned by the zones call.
- **Check what was pasted.** `GET /user/tokens/verify` returns `status` and `expires_on` [S10] (VERIFIED in the schema for user tokens; the account-owned equivalent is **unverified**). If the token has no expiry, the wizard says "set one for tomorrow" but does not refuse.
- **Finish by asking for deletion.** The final screen links to the token list and says to delete the token. The wizard does not delete it: that would need the `API Tokens Write` permission, which it should not hold.
- **Why a header from the browser rather than a direct browser call to Cloudflare:** whether the Cloudflare API allows cross-origin browser calls with a bearer token is **unverified**; the Worker route is also where the allow-list lives, so it is the design either way.

What a leaked token can do is in [Risks](#risks).

## 3. Wizard steps

Order (this differs from the order you listed; see "Why this order" below):

```
0 preflight  1 token  2 discover  3 organisation  4 provision  5 verify  6 activate  7 clean up
```

| Step | What it does | Call (Cloudflare API) | Permission | Re-run rule | Status |
| --- | --- | --- | --- | --- | --- |
| 0 Preflight | Collect admin emails (at least one, the person's own first). Confirm which hostname the wizard is open on. No token yet. | none | none | n/a | n/a |
| 1 Token | Verify the pasted token; find the account id. | `GET /user/tokens/verify` [S10]; `GET /accounts` | none listed for either | If `GET /accounts` fails or returns several, ask for the Account ID. | `GET /accounts` with an account-owned token: **unverified** (spike P3) |
| 2 Discover | Read-only. List zones; read the organisation; list IdPs; list Worker domains and Access apps; read this Worker's `workers.dev` state. Shows "what will change". | `GET /zones?account.id=` [S8]; `GET .../access/organizations`; `GET .../access/identity_providers`; `GET .../workers/domains`; `GET .../access/apps`; `GET .../workers/scripts/{name}/subdomain` and `GET .../workers/subdomain` | Zone Read; Access Org/IdP/Groups Read (Write also accepted); Workers Scripts Write/Read; Access Apps and Policies Read | Pure reads. | VERIFIED [S2][S4][S5][S6][S8] (permission string for zones is literally "Zone Zone Read" in the docs) |
| 3 Organisation | If `auth_domain` is present, use it and **never** call `PUT` (it would overwrite org-wide settings). If absent, show the manual step and a "check again" button. | `GET .../access/organizations`; optionally `POST .../access/organizations` with `{ auth_domain, name }` (D3) | Access Org/IdP/Groups Write | A team name is reserved for good once used [S1b]: confirm it with the admin before any `POST`. | `POST` exists, no required fields, **no plan field** [S3]; behaviour on an account that never finished onboarding **unverified** (spike P1) |
| 4a One-time PIN | Reuse an existing `type: "onetimepin"` IdP, else create one. | `POST .../access/identity_providers` with `{ "name": "One-time PIN", "type": "onetimepin", "config": {} }` | Access Org/IdP/Groups Write | Filter the list client-side by `type` (no server filter exists). Duplicate behaviour **unverified**. | VERIFIED [S4]. OTP is **not** on by default for new orgs, the Cloudflare IdP is [S4]. |
| 4b Custom domain | Pick a zone and a hostname (default a subdomain such as `book.<zone>`); attach to this Worker. | `PUT /accounts/{id}/workers/domains` with `{ hostname, service, zone_id }` | Workers Scripts Write | List first: attached to this Worker → skip; attached to **another** Worker or blocked by DNS → stop and explain. **Never** send override flags. Idempotency **unverified** (spike P4). | VERIFIED method and fields [S6]; creates DNS records and an Advanced Certificate on the zone [S7] |
| 4c Allow policy | Create or update a reusable policy of exact email rules. | `POST .../access/policies` `{ name, decision: "allow", include: [{ "email": { "email": "a@b.c" } }, ...] }`; later `PUT` | Access Apps and Policies Write | Id kept in `access_policy_id`. `PUT` on policies: **unverified** (not read). | `POST` VERIFIED [S5] |
| 4d Access app | Create or update one self-hosted app on the four admin paths, with the policy and the OTP IdP only. | `POST .../access/apps` (`PUT .../apps/{id}` on re-run) | Access Apps and Policies Write | Find by `access_app_id`, else by listing **all** apps and matching destinations (the `domain` query only matches exact hostnames [S9]). | VERIFIED fields; exact multi-path payload **unverified** (spike P2) |
| 4e Record, do not activate | Write team domain, AUD, hostname, ids and emails to D1 with `mode` unchanged. | none | n/a | Clears `verified_at` if any value changed. | n/a |
| 5 Verify | Section 4. | none from the wizard | n/a | Required again after any change to team domain, AUD or hostname. | the check itself is new code; Access's header reaching this Worker was **observed** on 21 October 2026 (spike P6 passed) |
| 6 Activate | `mode = 'access'`, server-side precondition below. | none | n/a | Reversible by "Switch back to password". | n/a |
| 7 Clean up | Forget the token; link to token deletion. Optional, unchecked: also disable `workers.dev` through the API. | optional `POST .../workers/scripts/{name}/subdomain` `{ "enabled": false, "previews_enabled": false }` | Workers Scripts Write | See D2. | VERIFIED [S11]; marked deprecated in the OpenAPI schema only; Wrangler still calls it [S11] |

### The Access application body

Intent, from the schema [S5] (exact acceptance of this payload is spike P2):

```jsonc
{
  "type": "self_hosted",
  "name": "slot-booker admin",
  "domain": "book.example.com/admin",              // schema requires `domain` for self_hosted
  "destinations": [                                 // supersedes self_hosted_domains
    { "type": "public", "uri": "book.example.com/admin" },
    { "type": "public", "uri": "book.example.com/admin/*" },
    { "type": "public", "uri": "book.example.com/api/admin" },
    { "type": "public", "uri": "book.example.com/api/admin/*" }
  ],
  "policies": [{ "id": "<reusable policy id>", "precedence": 1 }],
  "allowed_idps": ["<one-time PIN idp id>"],
  "auto_redirect_to_identity": true,                // needs exactly one IdP in allowed_idps
  "session_duration": "8h"
}
```

- `/admin/*` does **not** cover `/admin` [S12], which is why the existing docs list four paths (`docs/admin-auth.md:129-134`). Whether a bare `uri` also covers subpaths is only an inference from the schema text [S5] and is not relied on.
- `allowed_idps` defaults to **every** IdP in the account [S5]; naming the OTP id keeps the club's other IdPs out of this app.
- Adding an OTP IdP is account-wide and appears as a login option for the club's other Access apps that do not restrict `allowed_idps`. The wizard says so before creating it.
- The response gives `result.id` and `result.aud` [S5]. The team domain is `auth_domain` from step 3, with no scheme [S3]. The Worker already builds `https://<team domain>` for `iss` and fetches `/cdn-cgi/access/certs` (`src/server/auth/access.ts`, `docs/admin-auth.md:204-208`), so nothing else needs reading.
- If the schema rejects four destinations on one app, the fallback is four apps and a Worker that accepts a **list** of AUDs. That would change `access_aud` to a list, so decide before the migration is written.

### Why this order

The original brief listed "disable `workers.dev`" before verification. It is moved to after, and made it a run-time Worker behaviour: if the wizard turned `workers.dev` off and the new Access app then turned out to be wrong, the admin would be locked out of both addresses and the wizard itself (served from `workers.dev`) would be gone. Attaching the domain first also follows `docs/admin-auth.md:124`.

## 4. Verify before switching

The wizard is open on `workers.dev` under the password session. Access protects only the custom domain, so the proof has to come from a browser that goes through Access.

1. The wizard stores a random `verify_nonce` (expires after 15 minutes) and shows a link: `https://<hostname>/api/admin/access-check?n=<nonce>`.
2. The admin opens it. Access shows its sign-in; the admin enters an email from the list and the emailed PIN.
3. The request reaches the Worker with `Cf-Access-Jwt-Assertion`. A handler built on the **same JWT code** that will guard admin (`src/server/auth/access.ts`) validates the token against the **D1 candidate settings**, not against the active mode. It records `verified_at` and `verified_config_hash` only if: the nonce matches and is unexpired, the signature, `iss`, `aud`, `exp` and `nbf` checks pass, and `email` is one of `admin_emails`. It returns a small "Verified, you can close this tab" page.
4. The wizard tab polls the verify status and enables "Switch now".

What this proves: Access is in front of `/api/admin/*`; its header reaches this Worker (the question at `docs/admin-auth.md:183`, answered by spike P6); the Worker accepts the JWT for the AUD it will use; and at least one listed address can sign in.

Server-side invariant: `POST /api/admin/auth/activate` refuses unless `verified_at` is set **and** `verified_config_hash` equals the hash of the current team domain, AUD and hostname. Changing any of the three in the wizard clears the flag. Nothing in the UI is the only guard.

Route handling: the check route is under `/api/admin/*`, so `guardAdminApi` would 401 it while the site is in password mode. It needs the same kind of narrow exemption as `POST /api/admin/login` (`src/worker/guards.ts:27-33`), registered in `src/worker/routes.ts` (`routes.test.ts` enforces registration). Anything an unauthenticated caller can do there is limited to failing validation: it cannot pass without a valid Access JWT.

Optional extra, advisory only: the wizard page can try `fetch(url, { redirect: "manual", mode: "no-cors" })` against the custom domain and report whether the response was an opaque redirect (consistent with Access intercepting). Browser behaviour here is **unverified** and it proves less than the sign-in, so it is a hint, not a gate. A server-side fetch from the Worker to its own custom domain is not used: whether a Worker can fetch its own custom domain without looping is **unverified**, and Access would intercept it anyway.

If verification does not complete, nothing has changed: `mode` is still `password` and `workers.dev` is untouched.

## 5. Break-glass and `workers.dev` at run time

### Recovery with `SETUP_CODE`

`SETUP_CODE` is already a required Worker secret (the Deploy button prompts for it) and already means "the person who owns the deployment". It becomes the way back:

- `/setup` today is 404 under Access (`docs/admin-auth.md:51`). Under D1 access mode it serves a **"Recover sign-in"** form instead, reachable on both hostnames (Access only covers the four admin paths). This reuses the existing `/setup` entry in `run_worker_first`, so the pinned list in `src/test/wrangler-config.test.ts:37-41` does not change.
- A correct `SETUP_CODE` (constant-time compare, existing rate limits) sets `mode = 'password'`, **deletes the `admin_credentials` row** so `/setup` can issue a new generated secret (the same effect as the manual step in [handover.md](../handover.md#if-the-admin-secret-is-lost)), and sets `changed_by = 'recovery'`. The old secret is not reused, because after months in Access mode the club may have lost it.
- The next admin page shows "Sign-in was reset to the shared secret on <time>", so an unexpected recovery is visible.
- It is refused with 404 if `SETUP_CODE` is unset or shorter than 12 characters. There is no other off switch (D5).

#### Rate limiting for recovery (decided 21 October 2026)

The first draft reused the setup design, which includes a global cap of 30 attempts per 15 minutes across all visitors (`docs/admin-auth.md:49`). That cap is wrong for recovery: anyone could burn it and block the owner from the one route meant for the day everything else is broken. Recovery therefore limits **per client only**:

- **Key.** The existing client bucket: `CF-Connecting-IP`, with an IPv6 address counted as its /64 prefix, hashed with the session secret (`docs/admin-auth.md:110-111`). Stored in `login_attempts` under its own key prefix, so it never shares a count with sign-in or first-run setup.
- **Window.** 5 failed attempts per 15 minutes per client. Attempts are counted before the code is compared, so parallel guesses cannot exceed the limit, and a correct code clears that client's count.
- **Backoff.** Each time a client hits the limit, its next lockout is longer: 15 minutes, then 1 hour, then 24 hours (the ceiling). The step resets after 24 hours without a failure. The answer is 429 with `Retry-After`. The exact steps are a proposal.
- **No global cap, no global counter.** One client can exhaust only its own bucket.

What this leaves:

- A distributed attacker gets 5 guesses per address per window, and `SETUP_CODE` is a phrase a person chose (at least 12 characters), far weaker than the generated 256-bit admin secret. The backoff slows a single address a lot but does nothing about many addresses. The mitigations are visibility (the banner after any recovery), the Deploy-button and docs advice to use a long random phrase, and the owner's option to remove the secret. A stronger option, such as a longer minimum for recovery or a second factor, is not designed here.
- Someone sharing the owner's address (carrier-grade NAT, venue wifi, the same /64) shares the bucket and can lock that address out for up to the current backoff. The owner then uses another network, or the D1 console below.
- First-run `/setup` keeps its present limits, global cap included. Before the first sign-in there is no admin to lock out. Revisit if the implementation finds a reason to unify them.

It is the same trust the deployment already has: whoever can set Worker secrets can set `SETUP_CODE`.

### Last resort

If recovery is unavailable (secret removed or shorter than 12 characters, or the owner's address is in backoff with no other network to use), the owner can open the D1 console in the dashboard and run:

```sql
UPDATE auth_settings SET mode = 'password' WHERE id = 1;
```

and, if the secret is also lost, delete the `admin_credentials` row. Both belong in `docs/handover.md`. For an env-pinned Access deployment the lever is changing the three vars; a dashboard edit lasts only until the next deploy.

### Closing `workers.dev` without the API

In D1 access mode, a request whose host ends in `.workers.dev` and is not the canonical hostname is handled before routing:

- `/setup` and `POST /api/setup` (the recovery form) pass through, so break-glass works even if the custom domain breaks.
- Other `GET`/`HEAD` get a `308` to the same path and query on `access_hostname`. That keeps every booking link the club has already shared working, which turning `workers.dev` off through the API would break.
- Other methods get `421`. A page left open on `workers.dev` loses an in-flight booking; this is rare and said in the docs.

This also removes the weakness in `docs/admin-auth.md:196` (a stolen Access token replayed by hand on `workers.dev`, where Access cannot revoke it), because admin is refused on that hostname. It is independent of `workers_dev` in the repo, so a redeploy cannot undo it.

## 6. What stays manual

| Step | Why it cannot be automated | Deep link | Status |
| --- | --- | --- | --- |
| Put the domain on Cloudflare (onboard the zone, change nameservers at the registrar, wait until active) | The zone must be active before a custom domain or an Access app can use it [S7][S13]. The registrar step is outside Cloudflare. | `https://dash.cloudflare.com/?to=/:account/domains/overview` | link used verbatim in Cloudflare's own docs [S13] |
| Turn on Zero Trust and choose the **Free** plan, with payment details | Docs describe this as dashboard onboarding: "this step is still needed but you will not be charged" [S1]. No plan field on the organisation endpoint [S3]. Whether a card is demanded for Free is **not stated** in the docs. | `https://one.dash.cloudflare.com/?to=/:account/onboarding` | route taken from Cloudflare's dash-route data; **unverified** as a landing link. Fallback documented in [S1]: dashboard home, then **Zero Trust**. |
| Create the API token | Template URLs only pre-fill; the user must finish creation [S14]. | the template URL below | VERIFIED |
| Delete the API token afterwards | Needs a permission the wizard should not hold. | `https://dash.cloudflare.com/?to=/:account/api-tokens` | used verbatim in Cloudflare's docs [S14] |
| Add or remove admin emails later (v1) | Needs the token again. v1 points to the Zero Trust policy list; the wizard can be re-run to re-sync. | `https://one.dash.cloudflare.com/?to=/:account/access/apps` | from dash-route data; **unverified** as a landing link |

Zero Trust Free is up to 50 users at no cost (the public rate-plan catalogue showed `TEAMS_FREE`, tier 1 to 50 users at 0 [S1]); a club is far below that.

## Token template URL

Documented format [S14] (VERIFIED, page last updated 14 January 2025, older than the permissions reference, so re-check it in spike P5):

- **Account-owned token** (recommended, D4):
  `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<encoded JSON>&name=<name>`. Account templates take no `accountId` or `zoneId`; resource scope is chosen in the dashboard.
- **User token** (fallback): `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=<encoded JSON>&accountId=*&zoneId=all&name=<name>`. These two parameters are required and the documented values are all accounts and all zones. Whether a specific id is accepted is **unverified**.
- `permissionGroupKeys` is a URL-encoded JSON array of `{ "key", "type" }`, where `type` is `read` or `edit` (`edit` is "Full access"; there is no `write`). The page only pre-fills; the user still creates the token [S14].

Keys for this wizard:

| Permission (API "Write" naming [S2]) | Needed for | `key` / `type` | Status |
| --- | --- | --- | --- |
| Workers Scripts Write | custom domain, `workers.dev` toggle | `workers_scripts` / `edit` | key and type VERIFIED (the page's own "Workers scripts only" template) [S14] |
| Access: Apps and Policies Write | Access app, reusable policy | `access` / `edit` | key published as "Access applications"; the mapping to this exact permission name is inferred |
| Access: Organizations, Identity Providers, and Groups Write | org read/create, OTP IdP | `access_acct` / `edit` | best candidate, **unverified** (published as "Access organizations") |
| Zone Read | list zones | `zone` / `read` | key published; `read` pairing **unverified** |
| Account Settings Read | maybe `GET /accounts` | `account_settings` / `read` | key published; whether it is needed is **unverified** |

The keys are **not** returned by `GET /user/tokens/permission_groups`, which gives only `id`, `name`, `scopes` and `category` [S14]. So the only way to confirm the mapping is to open the generated URL and read which groups the dashboard pre-selects (spike P5).

The URL, built by script from the array above (`encodeURIComponent(JSON.stringify(keys))`):

```
https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22access_acct%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&name=slot-booker%20email%20sign-in%20setup
```

In the implementation it is a constant with a unit test that decodes it and compares it to the intended list, so a future edit cannot drift.

Account-owned tokens need the creator to have API Token Provisioning or Super Administrator status ("in order to create account API tokens, members either require...", Cloudflare's account-owned tokens page, last updated 28 September 2026). I could not resolve that page's URL (the path I tried returned 404), so treat this requirement as **unverified** until spike P5. A club organiser who created the account is normally Super Administrator, but a delegated organiser may not be; the wizard should say what to do then (use the user-token link, or ask the account owner).

The wizard must also tell the admin what to pick in the dashboard form: this account, zones **only** the one(s) they will use, an expiry of one day.

## Workers Builds and `wrangler.jsonc`

What a Wrangler deploy (which is what Workers Builds runs) does to settings made outside the repo. Row sources: [S15] Wrangler configuration docs, the deprecations page, and Wrangler source.

| Setting | On every deploy | Status |
| --- | --- | --- |
| `vars` (plain text and JSON bindings) | Replaced by the config's values: "If you change your environment variables in the Cloudflare dashboard, Wrangler will override them the next time you deploy." `keep_vars = true` turns that off. | VERIFIED |
| Secrets | Kept: "Wrangler will not delete your secrets..." | VERIFIED |
| `workers_dev` | Wrangler posts the desired state to the script `subdomain` endpoint on every deploy. If the key is omitted it defaults to **true when the config has no `route(s)`**, and false otherwise. "If you disable your workers.dev route in the Cloudflare dashboard but do not update your Worker's Wrangler file with workers_dev = false, the workers.dev route will be re-enabled the next time you deploy." | VERIFIED |
| Dashboard routes | Replaced by the config's routes when the config has any. | VERIFIED |
| Custom domains | Touched **only** if the config has a `custom_domain: true` route. A domain attached through the API with no such route in the config is left alone; that matches what the maintainer saw on 21 October. Whether a domain missing from a config that *does* list others is detached: **unverified**. | code condition VERIFIED; your observation matches; removal **unverified** |
| Bindings added only in the dashboard (non-secret, non-var) | Probably dropped; the docs are silent. | **unverified** |

Template consequences:

- Remove `vars.ADMIN_AUTH` (section 1). With no `vars` in the template, there is nothing for a deploy to overwrite, and the wizard's settings are in D1, which a deploy never touches.
- **Leave `workers_dev` explicit** at `true` in the template. The Deploy button's first-run URL needs it (`wrangler.jsonc` comment, and `docs/admin-auth.md:16`), and omitting it would only reintroduce Wrangler's "it will be enabled for this deployment by default" warning. The run-time redirect (section 5) does the closing, so the club never needs `workers_dev: false`.
- Do **not** add `keep_vars` yet. It would let a club set a plain var in the dashboard that survives deploys, which is attractive, but how it behaves when the *same* var is also in the fork's old config is **unverified** (spike P7), and the wizard no longer needs it.
- Do not add a `custom_domain` route: it is per-club, and adding it would make Wrangler start managing (and, in non-interactive mode, overriding) the domain [S15].
- Clubs that already put `workers_dev: false` in their repo (for example the maintainer's own instance) are unaffected: the redirect simply never sees a `workers.dev` request.
- Forks do not receive template changes automatically. Until a club syncs its fork, its old `vars` stay; section 1 is designed so that is harmless.

## Risks

### Lockout

| Risk | Mitigation |
| --- | --- |
| An email typo or wrong policy locks everyone out after switching. | Verification signs in with a real listed address before the switch; the invariant is server-side. Only one address is proven, so the wizard asks the admin to send each other listed person a test link (the same `access-check` link) and shows who has been seen. |
| The Access app, the org, or the team name is deleted or changed in the dashboard later. | The Worker fails closed (no header, 401). Recovery: break-glass (section 5). |
| The key fetch from `<team>.cloudflareaccess.com/cdn-cgi/access/certs` fails or Access rotates keys. | Existing behaviour (hourly cache, `kid` match, one forced refetch a minute: `docs/admin-auth.md:208`). Rotation keeps the old key for 7 days [S12]. |
| The custom domain's DNS or certificate breaks. | `/setup` on `workers.dev` stays reachable (section 5). |
| `SETUP_CODE` removed or short, or the owner's address is in recovery backoff. | D1-console statement, documented in `handover.md`. |
| A half-written D1 row. | `CHECK` constraint; a write for the three Access values is one statement. |
| A recovery destroys the old admin secret. | The recovery page says so before the code is submitted; the old secret is unrecoverable by design anyway (`docs/admin-auth.md:53`). |

### Token scope

- **`Workers Scripts Write` is the dangerous one.** A leaked token with it can replace the code of every Worker in the account, not only this one. That is full takeover of the club's Workers, and no narrower permission covers `PUT /workers/domains` (the schema lists only this one [S6]). Mitigations: account-owned token scoped to the one account; expiry of a day; delete after; the Worker holds the token for the duration of a few requests only.
- **Access Organizations/IdP Write** lets a token change org-wide Access settings and IdPs, which affects the club's other Access applications.
- **Zone Read** is low risk, but the zone choice in the form should be limited to the one zone.
- The Worker cannot tell if the admin pasted something broader (a user token for all zones, a global key). It warns and proceeds.
- XSS on an admin page could read the in-memory token. The existing security headers (`docs/admin-auth.md:242`) and the vanilla-JS, no-framework pages are the mitigation; the wizard page must load no third-party script.
- Logging: the Worker must not log request headers or bodies on the wizard routes. If Workers observability is ever turned on in the template, re-check this.

### Cloudflare-side surprises

- A custom domain "will also generate an Advanced Certificate on your target zone" and the certificate is not deleted when the domain is detached [S7]. Whether that is **billed** is **not stated** in what I read; spike P4 must check before the wizard tells a club it is free, and the docs need a line on it either way (`docs/costs.md`).
- A hostname with an existing CNAME, or in a zone the account does not own, is refused [S7]. The wizard surfaces the raw Cloudflare error with a one-line explanation and does not retry with overrides.
- `self_hosted_domains` was "supported until November 21, 2025" [S5]; the design uses `destinations`.
- The schema requires `domain` for `self_hosted` apps, but Cloudflare's Workers docs create one with only a `worker` destination and no `domain` [S16]. That worker-level form would protect every hostname of the Worker, including the public booking pages, so it is not used (alternative below).
- Cloudflare's documentation and its schema disagree in places (organisation create returns 201 in the schema and 200 in the docs example; the per-script `subdomain` endpoint is flagged deprecated only in the schema). The client must accept either, and every response shape needs a fixture from the live spikes.

### Workers Builds and redeploys

All covered in the table above. The two that bite: `workers_dev` is re-applied on every deploy, and `vars` are replaced. The design removes dependence on both. Two things are still **unverified**: whether the club's build runs `npm run deploy` (so the migration is applied before the new code starts), and whether Workers Builds runs Wrangler without a TTY, which makes Wrangler set its domain-override flags without asking [S15].

## Spikes (live tests needed before building)

Run with a throwaway Cloudflare account and a token made from the template URL, using a script in `scripts/` (not the wizard), recording each response as a test fixture.

| # | Question | Decides |
| --- | --- | --- |
| P1 | What does `POST .../access/organizations` do on an account that never finished Zero Trust onboarding (error, org without a plan, success)? What does `GET` return when there is no organisation? What happens on a second `POST`? Is `POST /accounts/{id}/subscriptions` with `teams_free` a supported way to pick Free? | D3, step 3 |
| P2 | Does `POST .../access/apps` accept `domain` plus four `public` destinations? Does it return `aud`? What happens when the same app is posted twice? Does `PUT` replace or merge? Does a bare `uri` cover subpaths? | the app body; whether `access_aud` must be a list |
| P3 | Does a token with exactly the template's permissions succeed on every call in section 3, including `GET /accounts` and `GET /user/tokens/verify` (or its account equivalent)? | the permission list; step 1 |
| P4 | `PUT /workers/domains`: idempotent on a repeat? Error for a hostname on another Worker, and for a DNS conflict? Does it need a zone permission beyond `Workers Scripts Write`? Is the generated Advanced Certificate billed? | step 4b; cost docs |
| P5 | Open the generated token URL: which groups are pre-selected, and do `zone`/`read`, `access_acct`/`edit`, `account_settings`/`read` map to the intended names? Does the account template need Super Administrator? | the key list |
| P6 | **PASSED, 21 October 2026.** Does `Cf-Access-Jwt-Assertion` reach this Worker through the static-assets path? (`docs/admin-auth.md:183`; Cloudflare notes `ctx.access` is not passed through the assets router [S16].) | whether the design works at all |
| P7 | With `vars` in the fork's old config and a `vars`/`keep_vars` mix, what does a Workers Builds deploy leave? Does the build command run migrations? | migration for existing deploys |
| P8 | Does a Worker survive a `workers_dev` redeploy with a custom domain attached by the API and no `routes` in config (observed to survive on 21 October; reproduce on a clean account)? | confirms the template stays route-free |

P6 evidence: on 21 October 2026 a production deployment on a custom domain returned 200 from `GET /api/admin/session` with an identity and `"provider":"access"` after an Access sign-in. This was reported by the maintainer from their own instance; it was not re-run for this document. It shows that `Cf-Access-Jwt-Assertion` reaches a Worker that serves static assets, and that the existing JWT check accepted it for the configured team domain and AUD. That Access application was made in the dashboard with the four admin paths on one application, so one application covering those paths works end to end; what remains untested is the API payload shape (P2). The design does not need rethinking on this point.

## Not in scope, and alternatives considered

- **Worker-level Access app** (`destinations: [{ "type": "worker", ... }]` [S16]). Simpler, no per-path list, and it would protect `workers.dev` and previews too. Rejected because it also puts the public booking pages behind a login.
- **Managing admin emails after setup** inside the app. v1 re-runs the wizard or uses the dashboard.
- **A second provider** (Google, GitHub IdP) beyond one-time PIN.
- **The Worker running its own email-code login**, which would need no Cloudflare account setup at all. Different product decision; not designed here.
- **Previews** (`env.preview`) stay on password.

## Docs and tests to change when this is built

- `docs/admin-auth.md`: settings table, the hard rule, the manual route moves to an appendix, `workers_dev` section, "Unverified" notes resolved by the spikes.
- `docs/deploying.md`, `README.md` ("Sign-in options"), `docs/handover.md` (recovery), the cost note about the certificate, if billed (`docs/deploying.md` or `docs/costs.md`).
- New: a `migration-0019` test per the existing convention (`src/test/migration-0019.test.ts`); a resolution-table test for `adminAuthFor`; guard tests for the exempt check route; tests that mock `fetch` with the spike fixtures for the Cloudflare client; a test that the token never reaches `console.*` or any D1 write; the template-URL decode test; and the extended `wrangler-config.test.ts` assertion.
- CI never calls Cloudflare.

## Sources

| Label | Page | Notes |
| --- | --- | --- |
| S1 | [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/) | plan and payment as dashboard onboarding; Free "you will not be charged". S1b: the FAQ, team names stay reserved after an organisation is deleted (Cloudflare Zero Trust getting-started FAQ). |
| S2 | [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) | "Edit" and "Write" naming tabs; the OpenAPI `x-api-token-group` strings used here are the "Write" ones. |
| S3 | [Create a Zero Trust organization](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/) | no required field, no plan field, `auth_domain` auto-generated if omitted. |
| S4 | [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/); [Create identity provider](https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/create/) | OTP "is no longer added automatically". |
| S5 | [Create Access application](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/); [Create Access policy](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/) | `destinations`, `aud`, `allowed_idps`, policies. |
| S6 | [Attach a Worker custom domain](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/) | `PUT`, `hostname` and `service` required. |
| S7 | [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) | CNAME restriction; DNS records and Advanced Certificate created; certificate kept on detach. |
| S8 | [List zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) | permission shown as "Zone Zone Read". |
| S9 | OpenAPI schema, github.com/cloudflare/api-schemas, commit `880ff24` | `GET .../access/apps` query parameters; also the cross-check for S2 to S6. |
| S10 | OpenAPI schema (same commit) | `GET /user/tokens/verify` returns `id`, `status`, `expires_on`, `not_before`. |
| S11 | [Subdomain endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/); [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/); Wrangler source (workers-sdk `f43e2e6`, `triggers/deploy.ts`) | Wrangler posts `{ enabled, previews_enabled }` on every deploy. |
| S12 | [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/); [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) | `alpha/*` does not cover `alpha`; `kid`, rotation, `iss`, `aud`. |
| S13 | [Add a site](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/) | zone onboarding is a dashboard flow. |
| S14 | [Account-owned token template URLs](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/) | URL formats, `permissionGroupKeys`, the published key list, "only pre-fill". |
| S15 | [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/); [deprecations](https://developers.cloudflare.com/workers/wrangler/deprecations/) | `keep_vars`, `workers_dev` default, dashboard routes replaced. |
| S16 | [Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) | `worker` destinations; `ctx.access` and the assets router. |

All URLs above returned HTTP 200 on 21 October 2026. That shows the page exists, not that I re-read it; the claims were read by the research pass, whose notes are not committed.
