# Deployment

OctoPrice is one long-running Node process and one persistent SQLite file. It
is deliberately not a serverless application: the process owns the price
polling schedule, and its database holds rules, subscriptions and notification
deduplication state.

## Cloudflare decision

The compatible Cloudflare deployment for the application as it exists is:

```text
Browser -> Cloudflare edge / HTTPS -> named Cloudflare Tunnel
                                      -> persistent Node origin
                                         -> SQLite volume
```

Use `cloudflared`, not Wrangler, for this deployment. There is intentionally no
`wrangler.toml` or Worker entry point in this repository.

Ordinary Workers are not a drop-in target: they do not run this Fastify
listener and in-process scheduler as a continuously resident Node process, and
the application's local SQLite file is not a durable Worker filesystem.
Cloudflare Containers can run a Node image, but they require the Workers Paid
plan and their local disk is ephemeral. Making Containers production-safe
would require replacing or synchronising the current storage layer, which is
an application architecture change and is outside the present deployment-only
scope.

Cloudflare Tunnel supplies public HTTPS and keeps the origin port private while
leaving the application unchanged. The tunnel itself is available on
Cloudflare's free plan; the persistent origin host is separate infrastructure
and must stay running.

## Requirements

- Node.js 22.5 or newer (24 recommended)
- A persistent Linux host, NAS or home server
- A persistent directory for SQLite and backups
- A Cloudflare account and a domain managed in that account
- `cloudflared` installed from Cloudflare's official package or binary

## Build and run the origin

Clone the GitHub repository on the origin, then build the exact committed
state:

```bash
git fetch --all --prune
git checkout main
git pull --ff-only
npm ci
npm run verify
```

Copy `.env.example` to `.env` and supply the deployment values:

```text
NODE_ENV=production
DATABASE_URL=file:/var/lib/octoprice/octoprice.sqlite
PORT=3000
HOST=127.0.0.1
DEFAULT_REGION=C
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
```

Binding the origin to `127.0.0.1` means it is reachable by `cloudflared` on
the same host but is not exposed directly to the network.

Build and start it:

```bash
npm run build
npm start --workspace @octoprice/server
```

## Run OctoPrice as a service

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

Restarts are safe. On startup the app refreshes today and tomorrow, while
persisted deduplication keys prevent already-sent notifications being repeated.

## Create the named Cloudflare Tunnel

Authenticate `cloudflared` on the origin and create a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create octoprice
cloudflared tunnel route dns octoprice octoprice.example.com
```

Copy `deploy/cloudflare/config.yml.example` to
`/etc/cloudflared/config.yml`, replace the tunnel UUID and hostname, then
install and start the service:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

The generated tunnel credentials JSON and the real `config.yml` are secrets or
host-specific configuration. They must remain on the origin and are ignored by
Git when placed under `deploy/cloudflare/` for local preparation.

## GitHub as source of truth

Production should deploy only commits merged to `main`. Until an origin host
and its authentication method are chosen, deployment is deliberately a manual
pull/build/restart procedure rather than a workflow containing guessed SSH
details or long-lived credentials.

Once the origin exists, automate those same commands using either:

- a tightly scoped, self-hosted GitHub Actions runner on the origin; or
- a GitHub Actions deployment job using an SSH key stored in GitHub Actions
  secrets.

Do not place tunnel credentials, VAPID keys or SSH private keys in the
repository. Require the existing CI `verify` job to pass before deployment.

## Verification

Verify the origin directly first:

```text
GET http://127.0.0.1:3000/api/health
GET http://127.0.0.1:3000/api/status
```

Then verify the same paths through the public HTTPS hostname and install the
PWA on a real Android device. The status response should show the scheduler
enabled and the intended region; push should show configured only after VAPID
keys are supplied.

## Time zone

The server performs its own `Europe/London` conversion through `Intl`, so the
host time zone does not matter. It does need complete ICU data, which official
Node builds include.

## Logs

The application writes structured JSON to stdout. Under systemd:

```bash
journalctl -u octoprice -f
```

Useful event names include `PRICE_CHECK_STARTED`, `PRICE_DATA_NOT_READY`,
`PRICE_DATA_COMPLETE`, `RULE_MATCH`, `NOTIFICATION_SENT`,
`NOTIFICATION_FAILED`, `OCTOPUS_API_ERROR` and `SCHEDULER_GAVE_UP`.

Credentials and push subscriptions are redacted before logging.

## Backups

Only the SQLite database must be backed up. Because it uses WAL mode, use
SQLite's online backup command while the service is running:

```bash
sqlite3 /var/lib/octoprice/octoprice.sqlite ".backup '/backups/octoprice.sqlite'"
```

## Upgrading

After CI has passed and a commit has reached `main`:

```bash
git pull --ff-only
npm ci
npm run build
sudo systemctl restart octoprice
```

Schema migrations run automatically at startup.

## PostgreSQL

PostgreSQL is not implemented. `DATABASE_URL` recognises a `postgres://` URL
and fails clearly rather than silently falling back to SQLite. Implementing a
Cloudflare-native store such as D1 would similarly be application work, not a
deployment configuration change.
