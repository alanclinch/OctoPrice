# OctoPrice

Know when Octopus Agile electricity is cheap — without having to remember to
look.

OctoPrice watches the Octopus Energy Agile tariff for your region, notices the
moment tomorrow's half-hourly prices are published, and pushes you a
notification telling you the cheapest slot, the most expensive slot, and
whether anything matched the alerts you set up. It installs to an Android home
screen as an app, and works in any browser.

> Status: in development, pre-MVP. See `AI_HANDOFF.md` for exactly where
> things stand.

## What it does

- **Current price, front and centre.** What you are paying right now and what
  the next half hour costs.
- **Today and tomorrow.** A chart and a plain table of every half-hour period,
  with negative and cheap periods obvious at a glance.
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
git clone <your-repository-url> OctoPrice
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
| `DATABASE_URL`          | `file:./data/octoprice.sqlite` for local use          |
| `PORT` / `HOST`         | Where the server listens                              |
| `DEFAULT_REGION`        | Your DNO region letter, used until you pick one in UI |
| `VAPID_PUBLIC_KEY`      | Public half of the push key pair                      |
| `VAPID_PRIVATE_KEY`     | Private half — treat as a password, never commit      |
| `VAPID_SUBJECT`         | A `mailto:` address, required by the push protocol    |
| `POLL_START`            | When to start looking for tomorrow's prices (16:05)   |
| `POLL_INTERVAL_MINUTES` | Retry gap while waiting (5)                           |
| `POLL_CUTOFF`           | When to give up for the day (22:15)                   |

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

See `docs/deployment.md`. The short version: it is one Node process and one
SQLite file, so anything that can run Node continuously will do. The server
must stay running for price polling to work — this is deliberately not a
serverless design.

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
