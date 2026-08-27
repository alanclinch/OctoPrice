# OctoPrice

Know when Octopus Agile electricity is cheap — without having to remember to
look.

OctoPrice watches the Octopus Energy Agile tariff for your region, notices the
moment tomorrow's half-hourly prices are published, and pushes you a
notification telling you the cheapest slot, the most expensive slot, and
whether anything matched the alerts you set up. It installs to an Android home
screen as an app, and works in any browser.

> Status: MVP feature-complete. Cloudflare deployment is supported; see
> `AI_HANDOFF.md` for the current live-deployment state.

## What it does

- **Current price, front and centre.** What you are paying right now and what
  the next half hour costs.
- **One continuous price timeline.** The current half-hour appears first by
  default, followed by every published price across today and tomorrow. Past
  prices remain available with one toggle.
- **Guided setup and installation.** The first visit asks for your electricity
  area, and the header always offers an install action for the PWA.
- **Publication alerts.** Octopus usually publishes next-day prices around
  16:00 but is entitled to take until 22:00. OctoPrice polls until the full
  day has actually arrived, then tells you.
- **Your own alert rules.** "Below 7p", "negative", "below 5p for at least two
  hours between 22:00 and 06:00" — all the same rules engine, no hard-coded
  special cases.
- **Cheapest window.** The cheapest continuous stretch of any length, for
  charging a car or running a dishwasher.
- **No duplicate nagging.** Every notification is keyed, so repeated polls and
  server restarts do not re-send what you have already been told.

## Requirements

- Node.js 22.5 or newer (24 recommended — it is what this is developed
  against).
- No Octopus account or API key. Agile prices are public.

## Installation

```bash
git clone https://github.com/alanclinch/OctoPrice.git
cd OctoPrice
npm install
cp .env.example .env
```

Generate the VAPID key pair that signs push notifications, and paste the two
values into `.env`:

```bash
npm run generate:vapid
```

## Configuration

Everything is set through `.env`. The defaults in `.env.example` are sensible
for a personal single-user install.

| Variable                | What it does                                          |
| ----------------------- | ----------------------------------------------------- |
| `NODE_ENV`              | Runtime mode: development, test or production         |
| `DATABASE_URL`          | `file:./data/octoprice.sqlite` for local use          |
| `PORT` / `HOST`         | Where the server listens                              |
| `LOG_LEVEL`             | Structured log threshold                              |
| `OCTOPUS_BASE_URL`      | Public Octopus API base URL                           |
| `OCTOPUS_PRODUCT_CODE`  | Optional fixed Agile product; blank discovers it      |
| `OCTOPUS_API_KEY`       | Reserved for future account tariff detection          |
| `OCTOPUS_ACCOUNT_NUMBER`| Reserved for future account tariff detection          |
| `DEFAULT_REGION`        | Your DNO region letter, used until you pick one in UI |
| `VAPID_PUBLIC_KEY`      | Public half of the push key pair                      |
| `VAPID_PRIVATE_KEY`     | Private half — treat as a password, never commit      |
| `VAPID_SUBJECT`         | A `mailto:` address, required by the push protocol    |
| `POLL_START`            | When to start looking for tomorrow's prices (16:05)   |
| `POLL_INTERVAL_MINUTES` | Retry gap while waiting (5)                           |
| `POLL_CUTOFF`           | When to give up for the day (22:15)                   |
| `ENABLE_SCHEDULER`      | Whether the background price poller runs               |
| `WEB_DIST_PATH`         | Location of the built PWA served by Fastify            |

Your region letter is the last character of your Octopus tariff code — for
example `E-1R-AGILE-24-10-01-C` is region `C`, London. You can also just pick
your area from the list in Settings.

## Running locally

Two terminals during development:

```bash
npm run dev
```

```bash
npm run dev:web
```

The first starts the API and the price-polling worker on
<http://localhost:3000>. The second starts the PWA with hot reload on
<http://localhost:5173>, proxying API calls to the server.

For a production-style single process, build everything and run just the
server, which serves the built PWA itself:

```bash
npm run build
npm start --workspace @octoprice/server
```

## Development

```bash
npm test          # Vitest across all workspaces
npm run verify    # format check, lint, typecheck, test, build — what CI runs
```

Run `npm run verify` before committing.

## Deployment

See `docs/deployment.md`. The production target is Cloudflare Workers with
Static Assets, D1 persistence and a Cron Trigger. It runs on a free
`workers.dev` address without a separate server or domain. The Fastify/SQLite
runtime remains available for local development.

## Documentation

| Document                | Contents                                     |
| ----------------------- | -------------------------------------------- |
| `DESIGN.md`             | The full specification                       |
| `docs/architecture.md`  | How the pieces fit together                  |
| `docs/octopus-api.md`   | Octopus API behaviour and edge cases         |
| `docs/notifications.md` | Push, providers and duplicate prevention     |
| `docs/deployment.md`    | Running it somewhere permanent               |
| `AI_HANDOFF.md`         | Current project state                        |
| `CLAUDE.md`             | Instructions for Claude Code                 |
| `AGENTS.md`             | Instructions for Codex and other agents      |

## Licence

MIT.

Not affiliated with Octopus Energy. Prices come from their public API and are
shown VAT-inclusive; always check your own account for what you are actually
billed.
