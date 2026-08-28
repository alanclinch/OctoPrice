# Cloudflare deployment

Production runs entirely on Cloudflare:

```text
Browser -> Worker Static Assets (React PWA)
        -> Worker /api/* -> D1
                         -> Octopus public API
Cron Trigger -----------> polling and notifications
```

No separate server, managed domain or Cloudflare Tunnel is required. The
default deployment uses a free `*.workers.dev` address. The expected traffic
for a personal installation fits comfortably within the Workers and D1 free
allowances, although Cloudflare's current limits remain authoritative.

The Node/Fastify/SQLite runtime is retained for local development. Production
uses the Web Fetch API rather than Fastify, `D1Store` rather than
`SqliteStore`, and Cron Triggers rather than an in-process timer.

## Requirements

- Node.js 24
- A Cloudflare account
- Wrangler authenticated with that account

Install dependencies and authenticate once:

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

## First deployment

Create the D1 database:

```bash
npx wrangler d1 create octoprice
```

Copy the returned database ID into `wrangler.jsonc`, replacing the all-zero
placeholder. Database IDs are resource identifiers, not credentials, and are
safe to commit.

Apply the schema, verify, and deploy:

```bash
npm run d1:migrate:remote
npm run verify
npm run deploy:cloudflare
```

Wrangler prints the public `workers.dev` URL. The configuration sends
`/api/*` through the Worker and all other requests through Static Assets, with
single-page-app fallback enabled.

## Push notification secrets

Generate a VAPID key pair locally:

```bash
npm run generate:vapid
```

Store the values as encrypted Worker secrets. Do not put them in
`wrangler.jsonc` or Git:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

`VAPID_SUBJECT` must be a contact URI such as `mailto:you@example.com`.
Deploy again after adding or changing secrets.

## The first access link

The app is private: every API route except health and the region list needs a
session. After the first deployment nobody has a link yet, including the
owner, so issue one from the command line - the only place that can, since
there is no session to authorise it and no public bootstrap endpoint to abuse:

```bash
npm run issue-link -- --url https://<worker>.workers.dev
```

The link is written to `.octoprice-link.txt`, which is git-ignored, rather
than printed, so it does not end up in shell history or a screen share. Open
it once, then delete the file.

Everyone else is invited from the People tab in the app, which is visible only
to the owner. Reissuing somebody's link invalidates the previous one and keeps
their rules and devices.

Run this **after** the migration and deployment. Applying migration 0003 to a
live installation locks it until a link is claimed.

## Configuration

Non-secret production values live under `vars` in `wrangler.jsonc`:

- `DEFAULT_REGION`
- `OCTOPUS_BASE_URL`
- optional `OCTOPUS_PRODUCT_CODE`
- `POLL_START`, `POLL_INTERVAL_MINUTES`, and `POLL_CUTOFF`
- `LOG_LEVEL`
- `FORECAST_BASELINE_ENABLED` — independent switch for the experimental
  estimate and its history backfill; defaults to `false`

The core Cron Trigger runs every five minutes, all day. Each invocation does
two things of very different cost:

- **Price polling**, which contacts Octopus. The application converts to
  Europe/London and makes this a no-op outside the local publication window,
  so the round-the-clock cron does not mean round-the-clock API traffic. This
  covers both GMT and BST without editing the cron seasonally.
- **Starting-soon alerts**, which read D1 only and never leave the Worker.
  These have to be able to fire at any hour, which is why the cron is no
  longer restricted to the afternoon.

When `FORECAST_BASELINE_ENABLED=true`, a second trigger runs at minutes 2, 7,
12 and so on. It incrementally backfills history and prepares cached estimates
without sharing an invocation or CPU budget with confirmed prices and alerts.
Both expressions are defined in `apps/server/src/scheduler/crons.ts`, and a
test requires `wrangler.jsonc` to contain them. The Worker ignores and logs any
unknown Cron expression so configuration drift cannot accidentally run core
price and alert work more often.

## Local Cloudflare runtime

Build the PWA, create the local D1 schema, then run Wrangler:

```bash
npm run build --workspace @octoprice/web
npm run d1:migrate:local
npm run dev:cloudflare
```

The local site is normally at <http://localhost:8787>. Trigger the scheduled
handler manually with:

```text
GET http://localhost:8787/cdn-cgi/local/scheduled
```

Local Wrangler state is stored under `.wrangler/` and is ignored by Git.

## Verification

After deployment, these two need no session:

```text
GET https://<worker>.workers.dev/          -> the app shell
GET https://<worker>.workers.dev/api/health -> {"status":"ok",...}
```

Everything else is private and answers 401 without one, which is itself worth
checking:

```bash
curl -s -o /dev/null -w '%{http_code}
' https://<worker>.workers.dev/api/overview
```

To read the status endpoint, pass a token from an access link:

```bash
curl -H "authorization: Bearer <token>" https://<worker>.workers.dev/api/status
```

It should report `schedulerEnabled: true`, the intended region, and
`pushConfigured: true` once the VAPID secrets are set. Then install the PWA on
a real Android device and use the test-notification control.

Cloudflare logs are available with:

```bash
npx wrangler tail
```

Useful event names include `PRICE_CHECK_STARTED`, `PRICE_DATA_NOT_READY`,
`PRICE_DATA_COMPLETE`, `RULE_MATCH`, `NOTIFICATION_SENT`,
`NOTIFICATION_FAILED`, `OCTOPUS_API_ERROR` and `SCHEDULER_GAVE_UP`.

## Updating

Deploy only a committed `main` revision after CI passes:

```bash
git checkout main
git pull --ff-only
npm ci
npm run d1:migrate:remote
npm run verify
npm run deploy:cloudflare
```

D1 migrations are forward-only. Apply a new migration before code that needs
the new schema. Existing prices, settings, subscriptions and notification
deduplication records remain in D1 across Worker deployments.
