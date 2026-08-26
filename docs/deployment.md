# Deployment

OctoPrice is one long-running Node process and one SQLite file. It is
deliberately **not** a serverless design: the whole point is that price
checking keeps happening whether or not anyone has the app open, and that
means something has to stay running.

## What you need

- Node.js 22.5+ (24 recommended)
- Somewhere that stays on: a Raspberry Pi, a NAS, a small VPS, a home server
- HTTPS, if you want push notifications

## Build and run

```bash
npm ci
npm run build
npm start --workspace @octoprice/server
```

`npm run build` compiles the core package, the server and the PWA. The server
serves the built PWA itself, so there is nothing else to host.

## Configuration

Copy `.env.example` to `.env` and fill it in. The variables that matter for a
real deployment:

```text
DATABASE_URL=file:/var/lib/octoprice/octoprice.sqlite
PORT=3000
HOST=0.0.0.0
DEFAULT_REGION=C
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Point `DATABASE_URL` at a directory that is backed up and that survives
restarts and redeploys. Losing it loses your rules and, more importantly, the
record of what has already been notified — which would cause a burst of
duplicate notifications on the next poll.

## HTTPS

Push notifications require a secure context. `localhost` counts; a bare LAN
address does not.

The simplest options:

- Put it behind a reverse proxy (Caddy, nginx, Traefik) with a real
  certificate. Caddy will obtain one automatically given a domain name.
- Use a tunnel (Cloudflare Tunnel, Tailscale with HTTPS) if you would rather
  not expose a port.

The server sets `trustProxy`, so `X-Forwarded-*` headers from a proxy are
honoured.

## Running as a service

A minimal systemd unit:

```ini
[Unit]
Description=OctoPrice
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/octoprice
EnvironmentFile=/opt/octoprice/.env
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=10
User=octoprice

[Install]
WantedBy=multi-user.target
```

Restarts are safe. On startup the app refreshes today and tomorrow, and the
notification dedupe keys mean anything already sent is skipped rather than
sent again.

## Time zone

The server does its own `Europe/London` conversion through `Intl`, so the host
time zone does not matter. It does need correct **ICU data**, which official
Node builds include. A `small-icu` build would break time formatting.

## Health checks

```text
GET /api/health    -> {"status":"ok","time":"..."}
GET /api/status    -> retrieval state, tariff, stored periods, last notification
```

`/api/status` is what to look at when something seems wrong: it shows the last
check, the last complete retrieval, and how many periods today and tomorrow
currently hold. The same information is on the Status tab in the app.

## Logs

Structured JSON, one object per line, on stdout. Under systemd:

```bash
journalctl -u octoprice -f
```

To answer "did tomorrow's prices arrive?":

```bash
journalctl -u octoprice | grep PRICE_DATA_COMPLETE
```

Useful event names: `PRICE_CHECK_STARTED`, `PRICE_DATA_NOT_READY`,
`PRICE_DATA_COMPLETE`, `RULE_MATCH`, `NOTIFICATION_SENT`,
`NOTIFICATION_FAILED`, `OCTOPUS_API_ERROR`, `SCHEDULER_GAVE_UP`.

Credentials and push subscriptions are redacted before anything is written.

## Backups

Only the SQLite file matters. It is small. With the app stopped, copying the
file is enough; while running, prefer:

```bash
sqlite3 /var/lib/octoprice/octoprice.sqlite ".backup '/backups/octoprice.sqlite'"
```

The database uses WAL mode, so a naive copy of just the `.sqlite` file while
the server is running may miss recent writes.

## Upgrading

```bash
git pull
npm ci
npm run build
systemctl restart octoprice
```

Schema migrations run automatically at startup and are applied in order.

## PostgreSQL

Not implemented yet. `DATABASE_URL` recognises a `postgres://` URL and fails
with a clear message rather than silently falling back to SQLite. Adding it
means implementing the `Store` interface a second time; nothing above that
layer should need to change.
