# Admin sign-in

Everything under `/admin/*` (the pages) and `/api/admin/*` (the API) is for the club's organisers. Handlers can't move or cancel bookings; only an admin can. Sign-in is pluggable: one `AdminAuth` interface (`src/server/auth/types.ts`) with two providers, chosen by configuration:

- **`access`**: Cloudflare Access sits in front of the site and the Worker verifies the signed token Access adds. The admin's identity is the verified email address.
- **`password`**: one shared admin password, checked by the Worker, which then issues a signed session cookie. The identity is the fixed string `admin`.

It fails closed. If `ADMIN_AUTH` is unset, misspelt (`Password`, `none`, ` access`) or the chosen provider's settings are missing or malformed, **every** admin page and `/api/admin/*` request, including paths that don't exist, gets a 503 and a line in the logs saying which setting is wrong. The other provider's settings are never used as a fallback.

## Settings

| Name | Secret? | Used by | Meaning |
| --- | --- | --- | --- |
| `ADMIN_AUTH` | no | both | `access` or `password`, exactly. Anything else locks admin out. |
| `ACCESS_TEAM_DOMAIN` | no | access | Your team's host, such as `your-team.cloudflareaccess.com`. Must match `<name>.cloudflareaccess.com`, because it decides where the signing keys are fetched from. |
| `ACCESS_AUD` | no | access | The Access application's AUD (audience) tag. |
| `ADMIN_PASSWORD_HASH` | **yes** | password | `pbkdf2-sha256$<iterations>$<salt>$<hash>` from `npm run hash-password`. |
| `ADMIN_SESSION_SECRET` | **yes** | password | At least 32 random characters. Signs the session cookie. Shorter counts as not configured. |

The two secrets must never be committed or put in `wrangler.jsonc`. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are not secrets but are club details, so keep them out of the committed `wrangler.jsonc` as well (`docs/deploying.md` suggests `git update-index --skip-worktree wrangler.jsonc` for local edits). Locally, put all of them in `.dev.vars` (see `.dev.vars.example`) and restart `npm run dev`.

## Password provider

### Setting it up

1. Choose a long random password, at least 14 characters (the hash script refuses less). A password manager's generated one is ideal; see "Limits" for why length matters here.
2. Hash it. The script reads the password from the terminal without echo (asking twice), or from stdin when piped, and never from the command line:

   ```sh
   npm run hash-password
   ```

   It prints `pbkdf2-sha256$100000$...`. The password itself is not stored anywhere.
3. Make the session secret: `openssl rand -base64 48`.
4. Set the two secrets on the Pages project. The installed Wrangler (4.147.0) lists `wrangler pages secret put <key>` with a `--project-name` option (`npx wrangler pages secret put --help`); it asks for the value, so nothing secret goes on the command line:

   ```sh
   npx wrangler pages secret put ADMIN_PASSWORD_HASH --project-name slot-booker
   npx wrangler pages secret put ADMIN_SESSION_SECRET --project-name slot-booker
   ```

   `npx wrangler pages secret bulk <file>` also exists, taking a JSON or `.dev.vars` file. The help shows no flag for choosing the production or preview environment, and I haven't verified which one `put` targets, so check in the dashboard after setting them.
5. Set `ADMIN_AUTH=password` (a plain variable; see `docs/configuration.md` for where those go).

### Why PBKDF2 with 100,000 iterations (and why that's weak)

WebCrypto PBKDF2 is the only password-hashing function Workers provide natively. There is no native scrypt, argon2 or bcrypt, and a WASM or JavaScript implementation would burn Worker CPU time and add bundle size. Production Workers refuse more than 100,000 PBKDF2 iterations (`iteration counts above 100000 are not supported`, [workerd issue 1346](https://github.com/cloudflare/workerd/issues/1346)). The local workerd and Node that the tests run on do **not** enforce that cap, so a hash with 600,000 iterations would pass every test here and fail in production. So:

- The hasher always uses exactly 100,000 iterations.
- The verifier (and the config check) refuses any stored count above 100,000, and non-integers and zero, so a bad hash fails loudly in tests and puts admin into the 503 state instead of failing at login time.
- It uses SHA-256 with a 32-byte output (a single hash block, so the defender does no extra work), chosen on measured CPU cost. In local workerd (`wrangler pages dev`, scratch worker), 100,000 iterations took about 40 ms with SHA-512 and a 64-byte output, about 26 ms with SHA-256 and a 64-byte output (two blocks) and about 10 ms with SHA-256 and a 32-byte output. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) give the free plan 10 ms of CPU per request, and time spent waiting on I/O doesn't count. SHA-512 would almost certainly exceed that. The trade is a small loss of attacker cost: SHA-512's 64-bit arithmetic is less GPU-friendly than SHA-256's.
- Hashes in the earlier `pbkdf2-sha512` format are rejected as malformed (admin then answers 503); regenerate them with `npm run hash-password`.

**This is below the OWASP-recommended work factor for PBKDF2, and it cannot be raised on Workers.** It is compensated, not fixed, by login rate limiting (below) and by requiring a long password. If someone obtains the stored hash, a long random password is what protects it. If that risk is not acceptable, use the Access provider.

**CPU time (unverified).** The figures above are local measurements, and 10 ms is right at the free plan's limit. I have not run this on real Workers, so whether a login fits, and how PBKDF2 time is counted against the limit, is unverified. If logins fail in production with a CPU-limit error, the fix is the Access provider.

### Sessions

On a correct password the Worker sets `__Host-sb_admin` with exactly `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` (8 hours, no `Domain`). Its value is `v1.<payload>.<signature>`: the payload is base64url JSON `{sid, iat, exp}` (a 128-bit random session id and times in seconds) and the signature is HMAC-SHA-256 over it with `ADMIN_SESSION_SECRET`. Each request verifies the signature first, then the claims (not expired, issued no later than a minute ahead, lifetime at most 24 hours, exactly those three fields).

Sessions are **stateless**. Logout clears the cookie in the browser but cannot revoke a stolen copy before it expires. Rotating `ADMIN_SESSION_SECRET` invalidates every session at once; do that if a cookie may have leaked, and change the password if the hash may have.

`SameSite=Strict` means the browser doesn't send the cookie on a cross-site navigation, such as a link to `/admin/` in a chat app. The first request then looks signed out and is redirected to the login page, whose script asks `/api/admin/session` (a same-origin request, which does carry the cookie) and continues to `/admin/` if already signed in.

### Rate limiting

`POST /api/admin/login` allows 5 attempts per client per 15 minutes. The client key is the SHA-256 of the `CF-Connecting-IP` header (set by Cloudflare; the raw address is never stored), kept in the `login_attempts` table (migration `0006`). Each attempt is counted atomically **before** the password is checked, so parallel guesses can't exceed the limit, and a client over the limit gets 429 with `Retry-After` without any PBKDF2 work. A correct password clears the client's count. Rows whose window ended more than a day ago are deleted as a side effect of later attempts. Without that header (local development) all requests share one key.

This limits one address, so it does **not** stop a distributed attack that spreads guesses across many addresses; that is why a long random password matters. There is deliberately no global lockout: it would let anyone lock the real admin out.

## Access provider

### Setting it up

In the Cloudflare Zero Trust dashboard, create a self-hosted Access application for the site's hostname that covers both the paths `/admin` and `/api/admin`, with a policy allowing the organisers' email addresses. Note its **Application Audience (AUD) tag** and your team domain. Then set `ADMIN_AUTH=access`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. I haven't configured an Access application, so check the current dashboard wording against [Cloudflare's docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/).

The Worker doesn't trust that Access is in front: it verifies the token itself, following [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/):

- The token is read only from the `Cf-Access-Jwt-Assertion` header (the docs recommend that over the `CF_Authorization` cookie). `Cf-Access-Authenticated-User-Email` is never read, because it is not signed. A request with only that header, or only the cookie, is unauthenticated.
- Checks, in order: three base64url segments (at most 8 KB); header `alg` exactly `RS256` and a string `kid` (so `none`, HS256 and every other algorithm are refused); the RSASSA-PKCS1-v1_5 SHA-256 signature, against the key in Access's key set with that `kid`. Only then is the payload read: `iss` equals `https://<team domain>`, `aud` (a string or a list) contains `ACCESS_AUD`, `exp` is a number and in the future (no leeway), `nbf` if present is not more than 30 seconds ahead, and `email` is a non-empty string containing `@`. Service tokens carry no email and are refused.
- Keys come from `https://<team domain>/cdn-cgi/access/certs` (the `keys` list; `public_cert` is not used). Access rotates them about every 6 weeks with a 7-day overlap, so the key is chosen by `kid`. The set is cached for an hour; an unknown `kid` forces one refetch, at most once a minute, so junk tokens can't hammer the endpoint. A failed or malformed fetch denies the request, waits a minute before trying again, and logs the reason (never token contents).

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

## Known limits

- **Static admin files can be reached by unusual paths in local dev.** Under `wrangler pages dev` (4.147.0), with signed-out requests, `/admin`, `/admin/`, `/admin/index.html`, `/admin/x.js`, `/admin/../admin/`, `/ADMIN/` and `/admin/%2e%2e/admin/` were all redirected to `/admin/login`, but a path that the Functions router doesn't match while the static file server still normalises it was served without signing in: `//admin/x.js`, `///admin/x.js`, `/%2fadmin/x.js`, `/admin%2fx.js` and `/%61dmin/x.js` (an encoded letter) returned the file (200). Only static files are affected. I could not see a way to make the API or any Function skip its middleware: every variant either matched the router (and got 401) or fell through to the static site's HTML. I haven't checked whether Cloudflare's edge normalises these paths before they reach Pages in production. Since the admin HTML and JavaScript contain no data and every API call is checked, the exposure is the admin UI's code and layout. A fix would be a root `functions/_middleware.ts`, but that would turn every static request into a Function invocation, so it was not done.
- Whether a login fits in the free plan's 10 ms of CPU is unverified on real Workers (see above).
- Per-IP login limiting doesn't stop a distributed attack (see above).
- Logout can't revoke a password session before it expires (see above).
- No second factor with the password provider. Access can provide one.
