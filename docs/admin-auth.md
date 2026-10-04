# Admin sign-in

Everything under `/admin/*` (the pages) and `/api/admin/*` (the API) is for the club's organisers. Handlers can't move or cancel bookings; only an admin can. Sign-in is pluggable: one `AdminAuth` interface (`src/server/auth/types.ts`) with two providers, chosen by configuration:

- **`access`**: Cloudflare Access sits in front of the site and the Worker verifies the signed token Access adds. The admin's identity is the verified email address. It needs a custom domain (see the hard rule below).
- **`password`**: one shared, generated admin secret, checked by the Worker, which then issues a signed session cookie. The identity is the fixed string `admin`. It is the option for local development, for previews and for deployments reachable only on `*.pages.dev`.

It fails closed. If `ADMIN_AUTH` is unset, misspelt (`Password`, `none`, ` access`) or the chosen provider's settings are missing or malformed, **every** admin page and `/api/admin/*` request, including paths that don't exist, gets a 503 and a line in the logs saying which setting is wrong. The other provider's settings are never used as a fallback.

## Hard rule: Access needs a custom domain; `*.pages.dev` uses the password

**`ADMIN_AUTH=access` is only for a deployment served on a custom domain, on a Cloudflare zone you control. A deployment reachable only on `*.pages.dev`, and every preview deployment, uses `ADMIN_AUTH=password`.**

Why: Cloudflare documents no way to put a hand-made self-hosted Access application, scoped to `/admin/*` and `/api/admin/*`, on a `pages.dev` hostname. The self-hosted application guide lists "An active domain on Cloudflare" as a prerequisite and says "Domains must belong to an active zone in your Cloudflare account", and neither it nor the application-paths page mentions `pages.dev`. Pages' own "Enable access policy" is not a substitute: the Pages docs describe it per hostname with no path option, so it would put the public booking pages behind a login too, and by itself it covers previews only. (Sources and what was checked: "Cloudflare claims" at the end.)

This is a project rule, not something the Worker checks: with `ADMIN_AUTH=access` on a `pages.dev`-only deployment the Worker starts normally and then answers 401 to every admin request, because no token ever arrives (see "What `pages.dev` does under Access"). The planned setup wizard will enforce the rule. Until then, follow it by hand.

## Settings

| Name | Secret? | Used by | Meaning |
| --- | --- | --- | --- |
| `ADMIN_AUTH` | no | both | `access` or `password`, exactly. Anything else locks admin out. |
| `ACCESS_TEAM_DOMAIN` | no | access | Your team's host, such as `your-team.cloudflareaccess.com`. Must match `<name>.cloudflareaccess.com`, because it decides where the signing keys are fetched from. |
| `ACCESS_AUD` | no | access | The Access application's AUD (audience) tag. |
| `ADMIN_PASSWORD_HASH` | **yes** | password | `hmac-sha256$<salt>$<mac>`, the hash line from `npm run --silent generate-admin-secret`. Anything else, including the earlier `pbkdf2-sha256$...` format, locks admin out. |
| `ADMIN_SESSION_SECRET` | **yes** | password | At least 32 random characters. Signs the session cookie and keys the login rate-limit hashes. Shorter counts as not configured. |

The two secrets must never be committed or put in `wrangler.jsonc`. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not secrets but are club details, so keep them out of the committed `wrangler.jsonc` as well: put them under `vars` in the git-ignored `account.local.json` and run `npm run configure` (`docs/deploying.md`, step 3). Locally, put them in `.dev.vars` (see `.dev.vars.example`) and restart `npm run dev`; only the password provider can be tried locally.

## Password provider

### Why a generated secret, not a password

The password provider has one shared credential and nothing slows a guesser down except the rate limit (below). Workers have no strong password-hashing function: the only native one is PBKDF2, capped at 100,000 iterations (below the OWASP recommendation) and costing CPU time on every login. So the credential is not a password a person chooses. It is a **generated admin secret**: 32 random bytes from `crypto.getRandomValues`, written as 43 base64url characters (`A-Z a-z 0-9 - _`), which is 256 bits. Nobody can guess or brute-force 256 random bits, whether through the login form or from a stolen stored value, so the stored value needs no slow hash. It is `hmac-sha256$<salt>$<mac>`, where `mac` is HMAC-SHA-256 keyed with a random 16-byte salt over the secret, and the login compares in constant time.

What that protects against: online guessing (rate limited, and hopeless against 256 bits anyway) and a leak of the stored `ADMIN_PASSWORD_HASH` (it can't be reversed into the secret, or attacked offline in any practical way). What it doesn't: the secret itself being stolen (a keylogger, a phished or shoulder-surfed secret, a screenshot, a shared note), someone with the Cloudflare account reading or replacing the settings, or a stolen session cookie (see "Sessions"). There is no second factor and no per-person identity (the identity is always `admin`); Access provides both. The secret is meant to live in a password manager and be filled in by it, not typed from memory: it is 43 characters of noise.

Only a value in exactly the generated form is accepted: 43 characters from that alphabet that decode to 32 bytes and are the spelling the generator would print. (The last character of 43 base64url characters carries only 4 bits, so a few other spellings decode to the same bytes; they are refused, so each secret has one accepted spelling.) Any other value that reaches the check is refused with the same 401 as a wrong secret, before any hashing. Two cases never reach it and get 400 `invalid_input` instead: a value longer than 256 UTF-16 code units, and one that is empty, or only whitespace and zero-width characters, after trimming. Those are not counted toward the rate limit, which is harmless because no secret check happens. The form check reveals nothing that isn't already public, because the form is documented here. Whitespace and zero-width characters (spaces, tabs, line breaks, non-breaking spaces, zero-width spaces and joiners, soft hyphens) at the start or end of what is sent are ignored, because copying from a chat app or PDF often adds them; anything inside the secret is not ignored.

### Setting it up

1. Generate the secret and its stored value. The script takes no arguments and reads no input:

   ```sh
   npm run --silent generate-admin-secret
   ```

   It prints the **secret** on stderr, once, labelled "shown once", and only the **hash** (`hmac-sha256$...`) on stdout. Put the secret in your password manager straight away: it is not stored anywhere else and can't be recovered from the hash. Because the two go to different streams, `npm run --silent generate-admin-secret > hash.txt` keeps the secret out of the file (it still appears on the terminal). Use `--silent`: without it `npm run` writes its own two header lines to stdout, which would land in the file.
2. Make the session secret: `openssl rand -base64 48`.

   Use a **different** generated admin secret and a different `ADMIN_SESSION_SECRET` for preview and for production (run `generate-admin-secret` twice). With identical values, a session cookie minted on a preview would also validate on production if stolen and replayed, and preview code from another branch would handle the production admin secret.
3. Set the two secrets on the Pages project. The installed Wrangler (4.147.0) lists `wrangler pages secret put <key>` with a `--project-name` option (`npx wrangler pages secret put --help`); it asks for the value, so nothing secret goes on the command line. Paste the hash line from step 1 for `ADMIN_PASSWORD_HASH`:

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker
   ```

   `npx wrangler pages secret bulk <file>` also exists, taking a JSON or `.dev.vars` file. The help shows no flag for choosing the production or preview environment, and I haven't verified which one `put` targets, so check in the dashboard after setting them.
4. Set `ADMIN_AUTH=password` (a plain variable) under `vars` in `account.local.json` and run `npm run configure` (`docs/deploying.md`, step 3; see `docs/configuration.md`). `vars` are not inherited by `env.preview`, so the script writes them into **both** the top-level block and `env.preview` of the generated `wrangler.json`. Secrets set with `wrangler pages secret` are separate from `vars`. The help for `put` lists only `--project-name`, with no option for production versus preview, so I can't say from it which environment a secret lands in; check in the dashboard.

To replace the secret, run the script again and set the new `ADMIN_PASSWORD_HASH`. Existing sessions stay valid until they expire or `ADMIN_SESSION_SECRET` is rotated. A stored value in the earlier `pbkdf2-sha256$...` format is refused as malformed: admin answers 503 and the log line says to run `npm run generate-admin-secret`.

### What a login costs (measured locally only)

Workers Free gives a request 10 ms of CPU ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Measured on this machine in local `workerd` (via `wrangler`), **not on real Workers**, and local workerd does not enforce that limit:

- **The check itself.** A scratch worker ran the real `verifyAdminSecret` (shape check, HMAC key import, HMAC, constant-time compare) in a loop and read `performance.now()` around it. workerd's clock only advances at I/O boundaries and at awaits of crypto operations, so the figure was cross-checked against the wall time of the whole HTTP request, measured by `curl`; the two agreed. 10 runs of 10,000 verifications took 80 to 112 ms (median about 90 ms), about **9 microseconds each**. A secret refused by the shape check took under 1 microsecond.
- **The whole request.** With `wrangler pages dev`, a throwaway local D1 and the password provider, 30 `POST /api/admin/login` requests with the correct secret took a median of **3.5 ms** and a p95 of 4.2 ms by `curl`'s `time_total` (a 401 for a well-formed wrong secret: median 2.7 ms; for a malformed one: median 2.6 ms). That is wall time including HTTP, JSON parsing and the D1 rate-limit write and read (local SQLite, so a real D1 will be slower, in time spent waiting on I/O rather than CPU), not CPU time. I didn't measure the CPU of the rest of the request separately.

So the HMAC is about three orders of magnitude below 10 ms. Whether the whole login fits the free plan's CPU limit on real Workers is **not verified**; the local wall time of the entire request being about a third of the limit is encouraging but isn't a CPU measurement.

### Sessions

On a correct admin secret the Worker sets `__Host-sb_admin` with exactly `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` (8 hours, no `Domain`). Its value is `v1.<payload>.<signature>`: the payload is base64url JSON `{sid, iat, exp}` (a 128-bit random session id and times in seconds) and the signature is HMAC-SHA-256 over it with `ADMIN_SESSION_SECRET`. Each request verifies the signature first, then the claims (not expired, issued no later than a minute ahead, lifetime at most 24 hours, exactly those three fields).

Sessions are **stateless**. Logout clears the cookie in the browser but cannot revoke a stolen copy before it expires. Rotating `ADMIN_SESSION_SECRET` invalidates every session at once; do that if a cookie may have leaked, and generate a new admin secret if the secret or its hash may have leaked.

`SameSite=Strict` means the browser doesn't send the cookie on a cross-site navigation, such as a link to `/admin/` in a chat app. The first request then looks signed out and is redirected to the login page, whose script asks `/api/admin/session` (a same-origin request, which does carry the cookie) and continues to `/admin/` if already signed in.

### Rate limiting

`POST /api/admin/login` allows 5 attempts per client per 15 minutes. Each attempt is counted atomically **before** the secret is checked, so parallel guesses can't exceed the limit, and a client over the limit gets 429 with `Retry-After` without any hashing. A correct secret clears the client's count. The counts are in the `login_attempts` table (migrations `0006` and `0007`).

- **Who a client is.** The `CF-Connecting-IP` header (set by Cloudflare). An IPv4 address counts as itself. An IPv6 address counts as its **/64 prefix**, because one subscriber normally owns a whole /64 (2^64 addresses) and a per-address limit could be sidestepped by rotating through them. An IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) counts as that IPv4 address, a zone id (`%eth0`) is ignored, and a value that can't be parsed counts as itself. Without the header (local development) all requests share one client.
- **What is stored.** The key is the hex HMAC-SHA-256, keyed with `ADMIN_SESSION_SECRET`, of that client bucket (the message is domain-separated from the session signatures). It is keyed because an unkeyed hash of an IPv4 address can be reversed in minutes by hashing every address. The rows are therefore pseudonymous but **still personal data**: whoever holds the secret and the table can test a guess at an address. Rotating the secret makes old rows match nobody. Rows whose window ended more than a day ago are deleted as a side effect of later login attempts, at most 100 per attempt, so they stay until someone attempts a login. Rows written before migration `0007` were plain SHA-256 hashes; they match no client now and go the same way. With the Access provider the table is never touched.
- **Shared addresses.** Anyone sharing the admin's address (carrier-grade NAT, venue wifi, the same /64) shares the count: they can use up the five attempts and lock the admin's address out for up to 15 minutes. That is a known property of limiting by address.
- **No global lockout.** A limit across all clients would let anyone lock the real admin out from anywhere. So this limits one client, and does **not** stop a distributed attack that spreads guesses across many addresses; that is why the secret is 256 random bits rather than something a person chose.
- **Cost of the purge.** `0007` indexes `window_start`. Without it the purge scanned the whole table on every attempt, so attempts from many addresses could read enough rows to use up D1's free daily read allowance and break the public booking page too.

## Access provider

### Setting it up (custom domain)

Prerequisite: the hard rule above. You need a domain whose zone is active in your Cloudflare account, and the Pages project to serve the site on a hostname of that domain, such as `book.example.com`. The Access application is scoped to the paths `/admin/*` and `/api/admin/*` on that hostname, so the public booking pages stay public.

The labels below are the ones on Cloudflare's pages when this was written (sources under "Cloudflare claims"). Nobody has run this against a real account here, so the dashboard itself may word things differently.

1. **Attach the custom domain to the Pages project first.** In the Cloudflare dashboard go to "Workers & Pages", select your Pages project, then "Custom domains" and "Set up a domain". Enter the hostname and select "Continue". For an apex domain (`example.com`) Cloudflare's docs say the domain must be a zone in the same account with Cloudflare's nameservers. Do not add the CNAME record by hand instead: Cloudflare says that adding one without first associating the domain in the Pages dashboard "will result in your domain failing to resolve at the CNAME record address, and display a 522 error". Do this before step 2: Cloudflare lists as a known issue that "It is currently not possible to add a custom domain with a Cloudflare Access policy already enabled on that domain".
2. **Create the Access application.** In the Cloudflare dashboard go to "Zero Trust" > "Access controls" > "Applications", select "Create new application", then "Self-hosted and private". Select "Add public hostname". In the "Domain" dropdown choose your domain (it must belong to an active zone), set the subdomain if you use one, and set the **Path** as below. Never leave the path empty: that protects the whole site, including the booking pages.

   Cloudflare's application-paths page says a wildcard in the Path field "does not cover the parent path": its example is that `example.com/alpha/*` covers `example.com/alpha/one` but not `example.com/alpha`. So `/admin/*` does **not** cover `/admin` itself, and you need an entry for each of these four paths on your hostname:

   | Path | Covers |
   | --- | --- |
   | `/admin` | the bare `/admin` (no trailing slash) |
   | `/admin/*` | `/admin/` and everything below it: the admin pages |
   | `/api/admin` | the bare `/api/admin` |
   | `/api/admin/*` | everything below `/api/admin/`: the admin API |

   Select "Add public hostname" again for each further entry. The Cloudflare page documents the single-entry flow; adding several by repeating it is my assumption, so check it in the dashboard. A second application per path would work too but would give a second AUD tag, and the Worker accepts only one.
   The Worker guards bare `/admin` and `/api/admin` itself (checked locally, see "What `pages.dev` does under Access"), so the two bare entries are belt and braces, not the only protection. Entries with a `?` query string, a port or a `#` are not supported by Access application paths, so don't add any.
3. **Add an Allow policy.** Under "Access policies" add an existing policy or create a new one that allows the organisers' email addresses. Cloudflare: "All Access applications are deny by default -- a user must match an Allow policy before they are granted access." (How to pick emails, such as an "Emails" selector, is not on the page fetched; check the dashboard.) Choose the identity providers you accept, and set "Session Duration" short (say 8 hours or less), so a token that leaks expires soon. Cloudflare: "Cloudflare checks every HTTP request to your application for a valid application token." Select "Create".
4. **Copy the AUD tag and team domain.** Go to "Zero Trust" > "Access controls" > "Applications", select "Configure" for your application and, from "Additional settings", copy the "Application Audience (AUD) Tag" (Cloudflare: it "will never change unless you delete or recreate the Access application"). Your team domain is `<your-team-name>.cloudflareaccess.com`; Cloudflare says the team name is shown in Cloudflare One under "Settings".
5. **Give the Worker the settings and redeploy.** In `account.local.json` (`docs/deploying.md`, step 3) add to `vars`, as strings and with the host only, no `https://`:

   ```jsonc
   "vars": {
     "ADMIN_AUTH": "access",
     "ACCESS_TEAM_DOMAIN": "<your-team-name>.cloudflareaccess.com",
     "ACCESS_AUD": "<the AUD tag from step 4>"
   }
   ```

   Run `npm run configure`. It refuses an `account.local.json` that has a database ID that is not a UUID or is a placeholder, the two IDs equal, an unknown key, a variable name that isn't a plain identifier, a value that isn't a string, or a secret (`ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`: the Access provider uses neither). It does not check `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD`; the Worker does at run time and answers 503 on every admin request, logging which setting is wrong, if the team domain isn't a `<name>.cloudflareaccess.com` host or the AUD is empty. Then redeploy production (`docs/deploying.md`, step 7; use the production branch, `--branch main` if you made the project as in that doc). The script writes the same `vars` into `env.preview` too, so preview deployments also expect Access and admin does not work on them (401). The script cannot give previews different `vars`, so test a preview with the password provider (`docs/deploying.md`, "Runbook: deploy a preview") before you switch `ADMIN_AUTH` to `access`; I haven't worked out a supported way to run both at once.
6. **Verify.** Replace the hostnames with yours.

   ```sh
   curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://<custom-domain>/api/admin/events
   curl -s -i https://<project>.pages.dev/api/admin/events
   curl -s -i https://<project>.pages.dev/admin
   ```

   - The first request has no Access session, so Access should turn it away before the Worker sees it. The Worker's own answer is the JSON `unauthenticated` body shown below, so if you see that body here, Access isn't in front of this path. The status Access itself returns (I'd expect a redirect to your team's login page) is not stated on the pages fetched and is **not verified**.
   - The second and third go to `pages.dev`, where no Access token is attached, so they reach the Worker and are refused by it: 401 with `{"error":{"code":"unauthenticated","message":"Sign in to continue."},"provider":"access"}`, and 401 with the text "Sign in with Cloudflare Access to use the admin pages." (checked against the local dev server with a made-up Access configuration, not on Cloudflare). A 503 instead means a setting is missing or malformed (the Pages logs say which).
   - In a browser, open `https://<custom-domain>/admin` (no trailing slash) in a private window: you should reach Access's sign-in. Sign in with an allowed email and the admin list should load. A non-allowed email should be refused by Access. Also open `https://<custom-domain>/` and a booking link `/e/<slug>`: they must load without any sign-in. "Sign out" in the admin list sends the browser to `/cdn-cgi/access/logout`.

### What `pages.dev` does under Access

Access is only in front of the custom domain. The Worker verifies the Access token itself and reads it only from the `Cf-Access-Jwt-Assertion` header, so a request to `<project>.pages.dev` has no token unless the caller adds one by hand. With `ADMIN_AUTH=access` and a valid configuration, checked locally:

- `/admin`, `/admin/`, `/admin/login` and every other path under `/admin/` (the middleware in `functions/admin/_middleware.ts`) answer 401, `text/plain`, "Sign in with Cloudflare Access to use the admin pages." (the login pages are served unauthenticated only with the password provider).
- `/api/admin` and everything under it (`functions/api/admin/_middleware.ts`) answer 401 JSON `unauthenticated` with `"provider":"access"`. `POST /api/admin/login` answers 404 `not_found`, because that route doesn't exist with Access.

So the `pages.dev` hostname is not an authentication bypass, but:

- It still serves the public booking pages and API, and the static admin HTML and JavaScript at unusual paths (the known limit below).
- Admin cannot be **used** on `pages.dev`, previews included, while `ADMIN_AUTH=access`.
- The Worker accepts any validly signed, unexpired token for its AUD, whichever hostname the request arrives on, and the signing keys are per team, not per hostname. Someone who holds a token stolen from a signed-in organiser could add the header by hand on `pages.dev`, where Access is not there to enforce session revocation. A short session duration limits that, and the first optional step below removes the production `pages.dev` route.

#### Optional: closing the `pages.dev` hostnames

Neither step is needed for the admin to work or be secure, and both are optional.

- **Redirect the production `*.pages.dev` URL to the custom domain.** Cloudflare's custom-domains page lists, under "Disable access to *.pages.dev subdomain": "Redirect the `*.pages.dev` URL associated with your production Pages project to a custom domain. You can use the account-level Bulk Redirect feature to redirect your `*.pages.dev` URL to a custom domain." I haven't set this up, and that page gives no steps, only the pointer to Bulk Redirects.
- **Pages' "Enable access policy" for previews.** In the Pages project go to "Settings" > "General" and select "Enable access policy". Cloudflare: "Note that this will only protect your preview deployments ... and not your `*.pages.dev` domain or custom domain." It is whole-hostname, so it protects previews only. It would also put your preview admin sign-in behind a Cloudflare login first, which suits a preview used by the organisers alone. The same page also describes extending it to the production `pages.dev` hostname by deleting the wildcard from the Access application's subdomain; that locks the public booking pages on `pages.dev` as well and is not recommended here.

### How the Worker checks the token

The Worker doesn't trust that Access is in front: it verifies the token itself, following [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):

- The token is read only from the `Cf-Access-Jwt-Assertion` header (the docs recommend that over the `CF_Authorization` cookie). `Cf-Access-Authenticated-User-Email` is never read, because it is not signed. A request with only that header, or only the cookie, is unauthenticated.
- Checks, in order: three base64url segments (at most 8 KB); header `alg` exactly `RS256` and a string `kid` (so `none`, HS256 and every other algorithm are refused); the RSASSA-PKCS1-v1_5 SHA-256 signature, against the key in Access's key set with that `kid`. Only then is the payload read: `iss` equals `https://<team domain>`, `aud` (a string or a list) contains `ACCESS_AUD`, `exp` is a number and in the future (no leeway), `nbf` if present is not more than 30 seconds ahead, and `email` is a non-empty string containing `@`. Service tokens carry no email and are refused.
- Keys come from `https://<team domain>/cdn-cgi/access/certs` (the `keys` list; `public_cert` is not used). Access rotates them about every 6 weeks with a 7-day overlap, so the key is chosen by `kid`. The set is cached for an hour; an unknown `kid` forces one refetch, at most once a minute, so junk tokens can't hammer the endpoint. A failed or malformed fetch denies the request, waits a minute before trying again, and logs the reason (never token contents).

Access can't be tried locally: the token only exists behind Cloudflare. Use the password provider for local development, for previews and for `*.pages.dev`-only deployments.

### Logout

`POST /api/admin/logout` returns `{ "logoutUrl": "/cdn-cgi/access/logout" }`, and the page sends the browser there. Ending an Access session is Access's job.

## Requests from the admin pages

One middleware, `functions/api/admin/_middleware.ts`, guards everything under `/api/admin/`, including paths no route handles yet, so a new route is protected by default:

1. Provider not configured: 503 `admin_not_configured`.
2. Not authenticated: 401 `unauthenticated` (the body names the `provider`, so the login page knows whether to offer a password form).
3. A state-changing method (anything other than GET, HEAD and OPTIONS) must also pass the CSRF checks below, or it gets 403 `csrf_failed` (415 for a non-JSON Content-Type).
4. Otherwise `context.data.admin` is set to `{ identity, csrfBinding }` and the request continues. Handlers read `data.admin.identity`; type them as `PagesFunction<AppEnv, "param", AdminData>` (`AdminData` is exported from `src/server/auth`).

The one exemption is `POST /api/admin/login` with the password provider: it gets the Origin check but no token (there is no session yet). With the Access provider that route does not exist (404).

**CSRF** applies to every state-changing request, with either provider:

1. The `Origin` header must be present and equal this site's origin. (Admin is browser-only, so a missing Origin is refused.)
2. If `Sec-Fetch-Site` is present it must be `same-origin`.
3. `X-CSRF-Token` must equal the session's token, compared in constant time. The token is `base64url(SHA-256("slot-booker-csrf-v1:" + csrfBinding))`, where the binding is a secret the page's JavaScript never sees: the session id in the HttpOnly cookie (password) or the Access JWT in the header (access). No separate CSRF secret is needed.
4. `Content-Type` must be `application/json`, which a cross-site form can't send.

`GET /api/admin/session` returns `{ identity, provider, csrfToken }`. A client fetches it once, sends the token as `X-CSRF-Token` on writes, and **re-fetches `/session` and retries once on a 403 `csrf_failed`**: under Access the JWT is refreshed periodically, which changes the token.

The pages (`functions/admin/_middleware.ts`) are guarded too: signed out, the password provider redirects to `/admin/login` (only `/admin/login`, `/admin/login.html` and `/admin/login.js` are served without signing in), the access provider answers 401 text, and an unconfigured site answers 503. The pages hold no data and the API is protected on its own, so this is defence in depth.

## Checking the security headers after deployment

`public/_headers` gives every static file a `Content-Security-Policy` (including `frame-ancestors 'none'`), `Referrer-Policy`, `X-Content-Type-Options` and `X-Robots-Tag`. After deploying, check that they reach the admin pages:

```sh
curl -sI https://<your-preview-url>/admin/login
```

The output should include a `Content-Security-Policy` with `frame-ancestors 'none'`. Locally (`wrangler pages dev` with the password provider configured) `HEAD /admin/login` returned those headers, but the 302 redirect from `/admin/` and the 503 answered when admin is not configured came from the Functions middleware and carried none of them. I have not checked how production applies `_headers` to responses that pass through the Functions middleware, so check it there rather than assume.

## Known limits


- **Static admin files can be reached by unusual paths in local dev.** Under `wrangler pages dev` (4.147.0), with signed-out requests, `/admin`, `/admin/`, `/admin/index.html`, `/admin/x.js`, `/admin/../admin/`, `/ADMIN/` and `/admin/%2e%2e/admin/` were all redirected to `/admin/login`, but a path that the Functions router doesn't match while the static file server still normalises it was served without signing in: `//admin/x.js`, `///admin/x.js`, `/%2fadmin/x.js`, `/admin%2fx.js` and `/%61dmin/x.js` (an encoded letter) returned the file (200). Only static files are affected. I could not see a way to make the API or any Function skip its middleware: every variant either matched the router (and got 401) or fell through to the static site's HTML. I haven't checked whether Cloudflare's edge normalises these paths before they reach Pages in production. Since the admin HTML and JavaScript contain no data and every API call is checked, the exposure is the admin UI's code and layout. A fix would be a root `functions/_middleware.ts`, but that would turn every static request into a Function invocation, so it was not done.
- **The `pages.dev` hostname keeps serving the public site.** Under Access, admin cannot be used there and gets 401, but the booking pages and the static admin files are still reachable (see "What `pages.dev` does under Access" for the optional ways to close it).
- Whether a login fits in the free plan's 10 ms of CPU is unverified on real Workers; only local numbers exist (see "What a login costs").
- Per-client login limiting doesn't stop a distributed attack, and clients sharing an address share the lockout (see "Rate limiting").
- Logout can't revoke a password session before it expires (see above).
- No second factor with the password provider. Access can provide one.

## Cloudflare claims

Each was read from the live page on 4 October 2026 (the pages' own "Last updated" dates are in brackets). The dashboard itself was not checked: nobody has a Cloudflare account configured here.

- Access needs an active zone, and the path rules: [Self-hosted public application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) (17 April 2026): prerequisite "An active domain on Cloudflare"; "Domains must belong to an active zone in your Cloudflare account"; the steps "Create new application", "Self-hosted and private", "Add public hostname", "Session Duration". The page does not mention `pages.dev`.
- Paths: [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) (17 April 2026): for `example.com/alpha/*`, "Does not cover" `example.com/alpha`; "At most one wildcard in between each slash in the Path"; query strings, port numbers and `#` are not supported. The page does not mention `pages.dev`.
- Custom domain on Pages, the 522 on a hand-made CNAME, and the `*.pages.dev` redirect: [Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/) (21 April 2026).
- No custom domain while Access is enabled on it: [Known issues](https://developers.cloudflare.com/pages/platform/known-issues/) (6 May 2026), under "Custom Domains". The same page describes extending the preview policy to `*.pages.dev`.
- "Enable access policy" covers previews only: [Preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/) (3 June 2026).
- Header, keys and AUD tag: [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) (6 May 2026).
- **Not on any of those pages:** the `Emails` selector for an Allow policy, the status code Access returns to an unauthenticated `curl`, whether several public hostnames can be added by repeating "Add public hostname", and the Bulk Redirect steps. None of these is claimed as verified above.
