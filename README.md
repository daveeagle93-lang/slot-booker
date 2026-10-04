# slot-booker

A lightweight slot-booking app for small clubs that run a handful of events each year, such as scent-training days with a few dozen bookable slots. It is designed to run entirely on the Cloudflare free tier and to be published as a template that each club can deploy to its own account.

Status: work in progress.

## Local development

Needs Node 24.

```sh
npm install
npm run db:migrate:local   # apply migrations to the local D1 (.wrangler/state)
npm run seed:local         # add a test event with sample bookings; prints its URL
npm run dev                # serves on http://localhost:8788
npm test                   # also: npm run typecheck
```

Open the URL that `seed:local` prints. Each run adds a new event (nothing is wiped); pass `-- --no-bookings` to skip the sample bookings. The public booking page is at `/e/<slug>` (static files in `public/`, no build step); the raw event data is at `/api/events/<slug>`.
