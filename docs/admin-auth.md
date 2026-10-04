# Admin sign-in

Everything under `/admin/*` (the pages) and `/api/admin/*` (the API) is for the club's organisers. Handlers can't move or cancel bookings; only an admin can. Sign-in is pluggable: one `AdminAuth` interface (`src/server/auth/types.ts`) with two providers, chosen by configuration:

- **`access`**: Cloudflare Access sits in front of the site and the Worker verifies the signed token Access adds. The admin's identity is the verified email address.
- **`password`**: one shared, generated admin secret, checked by the Worker, which then issues a signed session cookie. The identity is the fixed string `admin`.

It fails closed. If `ADMIN_AUTH` is unset, misspelt (`Password`, `none`, ` access`) or the chosen provider's settings are missing or malformed, **every** admin page and `/api/admin/*` request, including paths that don't exist, gets a 503 and a line in the logs saying which setting is wrong. The other provider's settings are never used as a fallback.

## Settings

| Name | Secret? | Used by | Meaning |
| --- | --- | --- | --- |
| `ADMIN_AUTH` | no | both | `access` or `password`, exactly. Anything else locks admin out. |
| `ACCESS_TEAM_DOMAIN` | no | access | Your team's host, such as `your-team.cloudflareaccess.com`. Must match `<name>.cloudflareaccess.com`, because it decides where the signing keys are fetched from. |
| `ACCESS_AUD` | no | access | The Access application's AUD (audience) tag. |
| `ADMIN_PASSWORD_HASH` | **yes** | password | `hmac-sha256$<salt>$<mac>`, the hash line from `npm run --silent generate-admin-secret`. Anything else, including the earlier `pbkdf2-sha256$...` format, locks admin out. |
| `ADMIN_SESSION_SECRET` | **yes** | password | At least 32 random characters. Signs the session cookie and keys the login rate-limit hashes. Shorter counts as not configured. |

The two secrets must never be committed or put in `wrangler.jsonc`. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not secrets but are club details, so keep them out of the committed `wrangler.jsonc` as well (`docs/deploying.md` suggests `git update-index --skip-worktree wrangler.jsonc` for local edits). Locally, put all of them in `.dev.vars` (see `.dev.vars.example`) and restart `npm run dev`.

## Password provider

### Why a generated secret, not a password

The password provider has one shared credential and nothing slows a guesser down except the rate limit (below). Workers have no strong password-hashing function: the only native one is PBKDF2, capped at 100,000 iterations (below the OWASP recommendation) and costing CPU time on every login. So the credential is not a password a person chooses. It is a **generated admin secret**: 32 random bytes from `crypto.getRandomValues`, written as 43 base64url characters (`A-Z a-z 0-9 - _`), which is 256 bits. Nobody can guess or brute-force 256 random bits, whether through the login form or from a stolen stored value, so the stored value needs no slow hash. It is `hmac-sha256$<salt>$<mac>`, where `mac` is HMAC-SHA-256 keyed with a random 16-byte salt over the secret, and the login compares in constant time.

What that protects against: online guessing (rate limited, and hopeless against 256 bits anyway) and a leak of the stored `ADMIN_PASSWORD_HASH` (it can't be reversed into the secret, or attacked offline in any practical way). What it doesn't: the secret itself being stolen (a keylogger, a phished or shoulder-surfed secret, a screenshot, a shared note), someone with the Cloudflare account reading or replacing the settings, or a stolen session cookie (see "Sessions"). There is no second factor and no per-person identity (the identity is always `admin`); Access provides both. The secret is meant to live in a password manager and be filled in by it, not typed from memory: it is 43 characters of noise.

Only a value in exactly the generated form is accepted: 43 characters from that alphabet that decode to 32 bytes and are the spelling the generator would print. (The last character of 43 base64url characters carries only 4 bits, so a few other spellings decode to the same bytes; they are refused, so each secret has one accepted spelling.) Anything else is refused with the same 401 as a wrong secret, before any hashing. That check reveals nothing that isn't already public, because the form is documented here. Whitespace and zero-width characters (spaces, tabs, line breaks, non-breaking spaces, zero-width spaces and joiners, soft hyphens) at the start or end of what is sent are ignored, because copying from a chat app or PDF often adds them; anything inside the secret is not ignored.

### Setting it up

1. Generate the secret and its stored value. The script takes no arguments and reads no input:

   ```sh
   npm run --silent generate-admin-secret
   ```

   It prints the **secret** on stderr, once, labelled "shown once", and only the **hash** (`hmac-sha256$...`) on stdout. Put the secret in your password manager straight away: it is not stored anywhere else and can't be recovered from the hash. Because the two go to different streams, `npm run --silent generate-admin-secret > hash.txt` keeps the secret out of the file (it still appears on the terminal). Use `--silent`: without it `npm run` writes its own two header lines to stdout, which would land in the file.
2. Make the session secret: `openssl rand -base64 48`.
3. Set the two secrets on the Pages project. The installed Wrangler (4.147.0) lists `wrangler pages secret put <key>` with a `--project-name` option (`npx wrangler pages secret put --help`); it asks for the value, so nothing secret goes on the command line. Paste the hash line from step 1 for `ADMIN_PASSWORD_HASH`:

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker
   ```

   `npx wrangler pages secret bulk <file>` also exists, taking a JSON or `.dev.vars` file. The help shows no flag for choosing the production or preview environment, and I haven't verified which one `put` targets, so check in the dashboard after setting them.
4. Set `ADMIN_AUTH=password` (a plain variable; see `docs/configuration.md` for where those go). `vars` (`ADMIN_AUTH`, and for Access `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`) are not inherited by `env.preview` in `wrangler.jsonc`, so give them in **both** the top-level `vars` block and the `env.preview` one if preview deployments should have admin. Secrets set with `wrangler pages secret` are separate from `vars`. The help for `put` lists only `--project-name`, with no option for production versus preview, so I can't say from it which environment a secret lands in; check in the dashboard.

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

### Setting it up

In the Cloudflare Zero Trust dashboard, create a self-hosted Access application for the site's hostname that covers both the paths `/admin` and `/api/admin`, with a policy allowing the organisers' email addresses. Put the Access application on **every hostname that serves the site**, including `<project>.pages.dev` and the preview aliases (`<branch>.<project>.pages.dev`), not just the custom domain. The Worker accepts any validly signed, unexpired token for its AUD, whichever hostname the request arrives on, and the signing keys are per team, not per hostname. A token captured on one hostname therefore keeps working on a hostname where Access is not enforcing session revocation. Set a short Access session duration so a captured token expires soon. Note its **Application Audience (AUD) tag** and your team domain. Then set `ADMIN_AUTH=access`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. I haven't configured an Access application, so check the current dashboard wording against [Cloudflare's docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/).

The Worker doesn't trust that Access is in front: it verifies the token itself, following [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):

- The token is read only from the `Cf-Access-Jwt-Assertion` header (the docs recommend that over the `CF_Authorization` cookie). `Cf-Access-Authenticated-User-Email` is never read, because it is not signed. A request with only that header, or only the cookie, is unauthenticated.
- Checks, in order: three base64url segments (at most 8 KB); header `alg` exactly `RS256` and a string `kid` (so `none`, HS256 and every other algorithm are refused); the RSASSA-PKCS1-v1_5 SHA-256 signature, against the key in Access's key set with that `kid`. Only then is the payload read: `iss` equals `https://<team domain>`, `aud` (a string or a list) contains `ACCESS_AUD`, `exp` is a number and in the future (no leeway), `nbf` if present is not more than 30 seconds ahead, and `email` is a non-empty string containing `@`. Service tokens carry no email and are refused.
- Keys come from `https://<team domain>/cdn-cgi/access/certs` (the `keys` list; `public_cert` is not used). Access rotates them about every 6 weeks with a 7-day overlap, so the key is chosen by `kid`. The set is cached for an hour; an unknown `kid` forces one refetch, at most once a minute, so junk tokens can't hammer the endpoint. A failed or malformed fetch denies the request, waits a minute before trying again, and logs the reason (never token contents).

The settings are `vars`, which `wrangler.jsonc` does not inherit into `env.preview`: give `ADMIN_AUTH`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in both the top-level and the `env.preview` blocks (see `docs/configuration.md`).

Access can't be tried locally: the token only exists behind Cloudflare. Use the password provider for local development.

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
- Whether a login fits in the free plan's 10 ms of CPU is unverified on real Workers; only local numbers exist (see "What a login costs").
- Per-client login limiting doesn't stop a distributed attack, and clients sharing an address share the lockout (see "Rate limiting").
- Logout can't revoke a password session before it expires (see above).
- No second factor with the password provider. Access can provide one.
