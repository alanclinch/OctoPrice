# AI Development Handoff

This file is the shared state between agents working on this repository
(Claude Code and ChatGPT Codex). It is agent-neutral: neither agent owns it,
both must read it before starting and update it before finishing.

If this file and the code disagree, **the code is right** — fix this file.

## Current State

- **Current version:** 0.1.0 (MVP feature-complete, not yet released)
- **Current branch:** `main`
- **Source control:** clean `main`, synced to `origin/main`
- **Build status:** passing — `npm run verify`
- **Test status:** passing — 273 tests across 10 files
- **Deployed:** `https://octoprice.alanclinch.workers.dev` on Cloudflare
  Workers, with D1 in WEUR and a five-minute Cron Trigger
- **Git remote:** public GitHub repository at
  `https://github.com/alanclinch/OctoPrice`; `main` is pushed and GitHub CI
  has completed successfully

## Current Architecture

npm-workspaces TypeScript monorepo. Full detail in `docs/architecture.md`.

- `packages/core` — pure domain logic, no I/O and no clock reads: London/UTC
  time handling, price normalisation, the alert rules engine, the cheapest
  window calculator, notification text and dedupe keys.
- `apps/server` — native Cloudflare Worker API, D1 persistence and Cron
  scheduling in production; Fastify, SQLite and timers for local Node
  development; shared Octopus, rules and notification services.
- `apps/web` — Vite + React mobile-first PWA with a custom service worker.

Data flows one way: Octopus to poller to database, then out through the API to
the PWA and through the notification service to devices. The API never
triggers an Octopus fetch, so a slow upstream cannot make the UI slow.

## Completed

Everything in the MVP list (DESIGN.md section 38) except items that need a
GitHub remote or a real device:

- Responsive, installable PWA: combined price timeline, chart, table, settings,
  status and an explicit install action.
- First-run area selection across all 14 DNO regions, with immediate price
  backfill when the area changes.
- Automatic Agile product discovery, with a fallback product code.
- Today, tomorrow, current price, next price, cheapest continuous window.
- Publication detection: polls from 16:05 every 5 minutes until 22:15, and
  treats a day as published only when every expected period is present.
- Generic alert rules: four operators, optional time restrictions that may
  cross midnight, minimum-duration matching over consecutive periods.
- Web push implemented end to end and confirmed on a real Android device.
- Persistent configuration and duplicate-notification protection.
- Structured logging with the event names from DESIGN.md section 37.
- `DESIGN.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`, this file,
  `CHANGELOG.md`, and `docs/` (architecture, octopus-api, notifications,
  deployment).
- CI workflow written (`.github/workflows/ci.yml`) — format, lint, typecheck,
  test, build, plus a check that the generated icons are reproducible.

## Currently In Progress

- **Task:** publication-trigger fix and "starting soon" alerts.
- **Responsible agent:** Claude
- Nothing is half-finished. `main` is deployed and verified live.

## Next Recommended Work

1. **Deploy the notification fix and watch it fire.** `npm run
   deploy:cloudflare` from `main` once merged. Then confirm, on the phone,
   that the daily summary arrives when tomorrow publishes and that a
   starting-soon alert arrives before a matching stretch. Nothing about this
   fix is proven until a notification lands on a device.
2. **Expect a burst on first deploy.** The current day has never been
   dispatched, so the first scheduled run inside the publication window will
   send today's summary plus any settled rule matches. That is a one-off
   catch-up, not a fault.
3. **Confirm the new Android badge visually.** Send another test notification
   after the updated service worker is active and confirm the tray shows the
   system-tinted lightning bolt rather than a white square. Push delivery
   itself has been confirmed on a real Android device.
2. **Watch several real Octopus publication cycles** (DESIGN.md section 42,
   step 21) before calling the MVP released. Confirm the daily notification
   arrives once, at a sensible time, and does not repeat.
3. Then Phase Two (DESIGN.md section 39). The rules engine, the window
   calculator and the provider interface are already general enough for
   Telegram, Home Assistant and EV-charging features without redesign.

## Known Problems

- **Migration 0003 locks a live installation until a link is claimed.** Apply
  the migration, deploy, then immediately run `npm run issue-link`. Existing
  push subscriptions belong to the owner and keep working once claimed.

- **Push on a device that has changed hands.** Signing in as a different
  person now releases the browser's push subscription, but the server-side
  record is only cleaned up when a send to it fails and returns 410. That is
  correct but not immediate.

- **The new Android notification badge has not yet been seen on the phone.**
  The previous badge delivered successfully but appeared as a white square.
  Its replacement is a verified transparent lightning-bolt alpha mask and is
  served live, but still needs one real notification to confirm Android's
  rendering.
- **`node:sqlite` prints an experimental warning on Node 24.** Harmless, but
  noisy in local development; production uses D1.
- **Product discovery has only been exercised for `AGILE-24-10-01`**, the
  currently available product.
- Vite prints a deprecation warning about `inlineDynamicImports` from
  `vite-plugin-pwa`; it comes from the plugin, not from our config.

## Important Decisions

### 2026-08-27 — Invite links rather than accounts

**Decision:** a user *is* an invite. The owner creates a row with a random
token; the link carries it and the browser keeps it in an HttpOnly cookie.
Only the SHA-256 of the token is stored.
**Reason:** the audience is a handful of friends and family. Passwords mean a
credential store, a reset flow and an email dependency, all for people who
would rather be sent a link. Storing only the hash means a database copy does
not grant access, and reissuing replaces a lost link without disturbing the
person's rules or devices.
**Alternatives considered:** Cloudflare Access (free to 50 users and no auth
code, but every person needs a Cloudflare-brokered login and it sits in front
of the push endpoints); a single shared secret (keeps one shared account, so
no per-person rules).
**Consequence:** there is no public bootstrap endpoint. The owner's first link
is issued with `npm run issue-link`, which requires database access, so the
first visitor after a deployment cannot claim ownership.

### 2026-08-27 — The API is defined once, with two adapters

**Decision:** routing, validation and authentication live in
`api/handler.ts`; Fastify and the Worker are thin adapters.
**Reason:** they were two implementations of the same twenty endpoints, and
production ran the one the tests never touched. Access control would have had
to be written twice. The tests now exercise the same code the Worker runs.

### 2026-08-27 — Prices are fetched per tariff, not per person

**Decision:** the poller groups people by tariff and fetches once per distinct
tariff.
**Reason:** everyone in one region costs a single request, and somebody in
another region still gets correct prices. Special-casing the common case
would have cost the same and broken silently when it stopped holding.

### 2026-08-27 — Publication triggers on coverage, not completeness

**Decision:** split "is this day complete?" from "is there enough of this day
to tell the user about?". Completeness stays strict and governs the interface;
notification triggers on an unbroken 22 hours from local midnight.
**Reason:** Octopus publishes a day only up to about 23:00 local and delivers
the rest later, usually with the following day's batch. A day therefore does
not become complete until roughly 24 hours after publication, and gating
notification on completeness meant nothing was ever sent. Confirmed against
live data and against the deployment, where `lastSuccessfulRetrievalAt` had
been null since launch.
**Alternatives considered:** "expected minus two periods", rejected because
only BST has been observed and a fixed-UTC cutoff would leave a GMT day two
periods shorter again; a percentage threshold, rejected as arbitrary.
**Consequence:** matches sitting on the trailing edge of incomplete data are
withheld until the day settles, so a growing stretch does not produce two
near-identical alerts.

### 2026-08-27 — Alerts both in advance and in the moment

**Decision:** keep publication-time alerts and add a separate "starting soon"
alert about fifteen minutes before a matching stretch begins.
**Reason:** the two answer different questions. Advance notice is for
planning; the user's actual complaint was that nothing told them when cheap
electricity was about to start. The starting-soon check reads stored prices
only, so it can run every five minutes all day at no API cost. The Cloudflare
cron was widened from the afternoon window to all day to allow it, with price
polling still a no-op outside the publication window.

### 2026-08-26 — Cloudflare Workers, D1 and Cron for production

**Decision:** run the PWA and API on Workers, persist state in D1 and drive
polling with Cron Triggers. Keep Fastify/SQLite as the local Node runtime.
**Reason:** this provides a no-server, no-domain deployment on `workers.dev`
that fits the expected personal-use free allowances. The storage boundary and
polling plan are shared between runtimes. The Worker uses native Fetch API
routing because Fastify's router performs runtime code generation, which the
Workers runtime disallows.

The earlier Tunnel decision below is superseded by the user's explicit
approval to redesign the application for Cloudflare-native hosting.

### 2026-08-26 — Cloudflare Tunnel, not Workers, for the unchanged app

**Decision:** run the existing Fastify/SQLite service on a persistent Node
origin and publish it through a named Cloudflare Tunnel.
**Reason:** the service owns a long-running scheduler and a persistent local
SQLite file. Ordinary Workers are not a drop-in runtime; Cloudflare Containers
require the paid Workers plan and have ephemeral local disk. A Worker/D1 or
Container persistence conversion would be an application architecture change,
which the infrastructure task explicitly forbids.
**Revisit when:** the project deliberately adopts a Cloudflare-native store or
another durable database, or the deployment budget and persistence design for
Containers are approved.

### 2026-08-26 — TypeScript pinned to 5.9

**Decision:** pin TypeScript to `^5.9`, not the newly released 7.x.
**Reason:** `typescript-eslint` requires `<6.1.0`, so linting breaks on 7.
**Alternatives considered:** dropping typescript-eslint (loses most of the
lint value); `--legacy-peer-deps` (papers over a real incompatibility).
Revisit once typescript-eslint supports the native port.

### 2026-08-26 — `node:sqlite` instead of `better-sqlite3`

**Decision:** use Node's built-in `node:sqlite`.
**Reason:** no native compilation, which matters on the Windows development
machine, and no dependency to keep current.
**Alternatives considered:** `better-sqlite3` (needs node-gyp or prebuilt
binaries); `libsql`. The store sits behind an interface, so swapping is cheap.

### 2026-08-26 — `.ts` import extensions and `erasableSyntaxOnly`

**Decision:** relative imports include `.ts`, rewritten on build by
`rewriteRelativeImportExtensions`, and `erasableSyntaxOnly` is enabled.
**Reason:** the server runs directly from source on Node with no transpiler in
the dev loop. Node only *strips* types, so non-erasable syntax type-checks but
crashes at runtime — which actually happened: two constructor parameter
properties passed every test and broke the server on first real start. The
compiler flag now rejects that class of bug.
**Alternatives considered:** `tsx` (an extra dependency); extensionless
imports (not valid ESM).

### 2026-08-26 — Rule matches are runs, not periods

**Decision:** the rules engine returns maximal runs of consecutive qualifying
periods.
**Reason:** "cheap for at least two hours" becomes the same code path as a
single-period alert, and the user gets one notification per cheap stretch
instead of one per half hour.
**Alternatives considered:** returning periods and grouping in the caller,
which would have duplicated the grouping logic in the UI and the notifier.

### 2026-08-26 — A day is published only when it is complete

**Decision:** `isDayComplete` requires the full expected period count (46, 48
or 50), contiguity, and local-midnight-to-local-midnight coverage.
**Reason:** observed live, tomorrow sat at 46 of 48 periods for a while.
Treating that as published would have produced a daily summary missing the
evening and a cheapest-window answer computed from partial data.
**Alternatives considered:** a percentage threshold, which would have been
arbitrary and would still have produced wrong summaries.

### 2026-08-26 — Dedupe keys include the matched run length

**Decision:** a rule match key is
`{user}:rule:{ruleId}:{date}:{runStart}:{periodCount}`.
**Reason:** a corrected price that lengthens a cheap window is genuinely new
information and should be sent; an unrelated change elsewhere in the day is
not, and does not alter the key.
**Trade-off:** a growing window produces a second notification. Silence about
a real change seemed the worse failure.

### 2026-08-26 — Hand-drawn SVG chart, no charting library

**Decision:** render the price chart directly as SVG.
**Reason:** the requirements are specific (negative bars below the axis,
banded colours, an obvious "now" marker, tap for exact price) and small. The
bundle is 87 kB gzipped, which matters for a phone-first PWA.
**Alternatives considered:** Recharts or Chart.js, both of which would have
been larger and harder to bend to the negative-price presentation.

## Recent Agent Handoffs

### 2026-08-27 — Codex, labels and Android notification polish

**Work completed:** removed the internal region letter from the header;
reworded the unpublished state as “Prices usually update around 4pm”;
separated and title-cased default alert-rule names; replaced the opaque
Android notification badge with a transparent lightning-bolt mask; added an
Alan Clinch footer credit, source link and author metadata.

**Verification:** `npm run verify` passed twice (205 tests), including on the
fast-forwarded `main`; GitHub Actions run 33052629302 passed. Phone-viewport
checks confirmed the header, price wording, alert spacing, creator credit and
metadata with no browser errors. The live 500-byte badge returns 200 as a PNG.
Commit `c2fe756` is deployed and the UI was verified live.

**Outstanding:** send one more Android test notification after the service
worker update and visually confirm the lightning-bolt tray badge.

### 2026-08-27 — Codex, compact price tools

**Work completed:** replaced the separate next-price row with an inline
“Until … · then …” line; condensed tomorrow's publication state, cheapest
window and price chart into one compact card; made the two tools collapsed by
default and persisted the user's open or closed choice locally. Updated the
design and changelog.

**Verification:** `npm run verify` passed twice (205 tests), including once on
the fast-forwarded `main`. GitHub Actions run 33050731569 passed. At a phone
viewport, both tools expanded correctly, the chosen state survived reload,
and the browser reported no errors. Commit `959fc09` is deployed and the same
behaviour was verified live.

**Outstanding:** install on a real phone and confirm Web Push delivery.

### 2026-08-27 — Codex, first-run and price timeline fixes

**Work completed:** added first-run area selection, meaningful region labels
and PWA install guidance; merged today and tomorrow into one chronological
timeline; made Remaining only the working default with the current slot first;
backfilled prices after region changes; made default-rule seeding atomic and
added a migration to remove the three duplicate production defaults.

**Verification:** `npm run verify` passed (205 tests). The built PWA was tested
in the local Cloudflare runtime at a mobile viewport: the table opened on the
current slot, toggling Remaining only changed 31 rows to 46, onboarding and
install guidance rendered correctly, and no new browser errors appeared.

**Live verification:** Southern Scotland is named in the header; the install
action is present; the current 08:00–08:30 slot appeared first; toggling
Remaining only changed the table from 30 rows to all 46; Settings showed
exactly three default rules; no browser errors appeared.

**Outstanding:** install on a real phone and confirm Web Push delivery.

### 2026-08-26 — Codex, Cloudflare-native deployment

**Work completed:** added the Worker Fetch API adapter, D1 store and migration,
Cron-driven polling, Wrangler configuration and deployment scripts; made the
shared storage boundary asynchronous; updated CI and documentation; created
the live D1 database, configured encrypted VAPID secrets and deployed the PWA.

**Verification:** `npm run verify` passed (204 tests plus format, lint,
typecheck and build). Wrangler's local runtime passed site/API/D1 smoke tests.
The live site, health, status and push-key endpoints return 200; the live Cron
and manual check both reached Octopus and stored a partial 46-of-48 day in D1.

**Outstanding:** install on a real phone and confirm Web Push delivery; observe
several publication cycles before declaring the MVP released.

### 2026-08-26 — Codex

**Work completed:** audited the repository and deployment constraints; created
the Cloudflare Tunnel configuration template; documented the compatible
Cloudflare topology, GitHub-as-source workflow, secrets and deployment steps;
aligned `AGENTS.md`, `CLAUDE.md`, `README.md`, `.env.example` and `.gitignore`.

**Tests run:** `npm run verify` (204 tests plus format, lint, typecheck and
build) passed. A production-style server smoke test returned 200 from the app
shell and `ok` from `/api/health` with an in-memory test database.

**Outstanding:** add a Cloudflare-managed domain, select the persistent origin
and hostname, and provision/test the named Tunnel. No application files were
modified.

### 2026-08-26 — Claude

**Work completed:** the project, from an empty directory to a working MVP.
Monorepo scaffold and tooling; the whole of `packages/core`; the whole of
`apps/server`; the whole of `apps/web`; specification, agent instructions and
`docs/`; CI workflow.

**Files changed:** all of them — this is the initial implementation. History
is four commits plus two merges on `main`.

**Tests run:** `npm run verify` (format check, lint, typecheck, 204 tests,
build) — passing. Also a live smoke test against the real Octopus API, and a
manual pass through all four tabs of the built PWA served by the server.

**Verified against live data:** product discovery picked `AGILE-24-10-01`; six
complete historical days each held exactly 48 periods in their local-day
window; a genuinely in-progress day was correctly reported as 46 of 48 and
not notified.

**Outstanding issues:** see Known Problems. The important one is that push has
never reached a real device.

**Suggested next action:** create the GitHub repository and push, so CI runs;
then generate VAPID keys and confirm a notification arrives on a phone.
