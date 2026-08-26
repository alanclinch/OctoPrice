# AI Development Handoff

This file is the shared state between agents working on this repository
(Claude Code and ChatGPT Codex). It is agent-neutral: neither agent owns it,
both must read it before starting and update it before finishing.

If this file and the code disagree, **the code is right** — fix this file.

## Current State

- **Current version:** 0.1.0 (MVP feature-complete, not yet released)
- **Current branch:** `codex/infrastructure-deployment`
- **Last known good application commit:** `8b9d9dd` on `main`; the current
  branch's infrastructure/documentation state is also verified
- **Build status:** passing — `npm run verify`
- **Test status:** passing — 204 tests across 8 files
- **Deployed:** nowhere yet; Cloudflare requires a persistent origin host and
  an authenticated account/domain
- **Git remote:** none configured. Everything is local only, so CI has never
  actually run.

## Current Architecture

npm-workspaces TypeScript monorepo. Full detail in `docs/architecture.md`.

- `packages/core` — pure domain logic, no I/O and no clock reads: London/UTC
  time handling, price normalisation, the alert rules engine, the cheapest
  window calculator, notification text and dedupe keys.
- `apps/server` — Fastify API, Octopus client, polling scheduler, SQLite
  persistence via a `Store` interface, notification delivery behind a
  provider interface. Serves the built PWA in production.
- `apps/web` — Vite + React mobile-first PWA with a custom service worker.

Data flows one way: Octopus to poller to database, then out through the API to
the PWA and through the notification service to devices. The API never
triggers an Octopus fetch, so a slow upstream cannot make the UI slow.

## Completed

Everything in the MVP list (DESIGN.md section 38) except items that need a
GitHub remote or a real device:

- Responsive, installable PWA: dashboard, chart, table, settings, status.
- Region selection across all 14 DNO regions.
- Automatic Agile product discovery, with a fallback product code.
- Today, tomorrow, current price, next price, cheapest continuous window.
- Publication detection: polls from 16:05 every 5 minutes until 22:15, and
  treats a day as published only when every expected period is present.
- Generic alert rules: four operators, optional time restrictions that may
  cross midnight, minimum-duration matching over consecutive periods.
- Web push implemented end to end in code, including the service worker.
- Persistent configuration and duplicate-notification protection.
- Structured logging with the event names from DESIGN.md section 37.
- `DESIGN.md`, `README.md`, `CLAUDE.md`, `AGENTS.md`, this file,
  `CHANGELOG.md`, and `docs/` (architecture, octopus-api, notifications,
  deployment).
- CI workflow written (`.github/workflows/ci.yml`) — format, lint, typecheck,
  test, build, plus a check that the generated icons are reproducible.

## Currently In Progress

Codex is preparing GitHub and Cloudflare infrastructure on
`codex/infrastructure-deployment`. The documentation, environment template,
secret exclusions and named Cloudflare Tunnel example are complete and
`npm run verify` passes. GitHub creation/push and live Cloudflare provisioning
remain blocked on account sign-in; a production Tunnel also needs the chosen
persistent origin host and Cloudflare-managed hostname.

Application source files have not been changed.

## Next Recommended Work

1. **Finish GitHub setup.** Sign in, create the repository, add `origin`, push
   this branch, open/merge it into `main`, and confirm the CI workflow passes.
2. **Provision the production origin and Cloudflare Tunnel.** Choose the
   always-on Node host, persistent SQLite path and hostname, then follow
   `docs/deployment.md`.
3. **Generate VAPID keys and verify push on a real device.** `npm run
   generate:vapid`, paste into `.env`, restart, then install the PWA on an
   Android phone and use the test-notification button. This is the one part
   of the MVP that has never been exercised for real.
4. **Watch several real Octopus publication cycles** (DESIGN.md section 42,
   step 21) before calling the MVP released. Confirm the daily notification
   arrives once, at a sensible time, and does not repeat.
5. Then Phase Two (DESIGN.md section 39). The rules engine, the window
   calculator and the provider interface are already general enough for
   Telegram, Home Assistant and EV-charging features without redesign.

## Known Problems

- **Push is unverified against a real device.** The code is complete and unit
  tested with a recording sender, but the embedded browser used during
  development refuses to register a service worker (the page fetches
  `/sw.js` correctly with the right content type, so this looks like a
  sandbox restriction rather than an app bug). Treat push as unproven until
  someone sees a notification on a phone.
- **No GitHub remote, so CI has never run.** The workflow is written but
  unexecuted.
- **`node:sqlite` prints an experimental warning on Node 24.** Harmless, but
  noisy in logs.
- **PostgreSQL is not implemented.** A `postgres://` URL fails with a clear
  message rather than silently using SQLite.
- **Product discovery has only been exercised for `AGILE-24-10-01`**, the
  currently available product.
- Vite prints a deprecation warning about `inlineDynamicImports` from
  `vite-plugin-pwa`; it comes from the plugin, not from our config.

## Important Decisions

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

### 2026-08-26 — Codex

**Work completed:** audited the repository and deployment constraints; created
the Cloudflare Tunnel configuration template; documented the compatible
Cloudflare topology, GitHub-as-source workflow, secrets and deployment steps;
aligned `AGENTS.md`, `CLAUDE.md`, `README.md`, `.env.example` and `.gitignore`.

**Tests run:** `npm run verify` (204 tests plus format, lint, typecheck and
build) passed. A production-style server smoke test returned 200 from the app
shell and `ok` from `/api/health` with an in-memory test database.

**Outstanding:** authenticate GitHub and Cloudflare, create/push the GitHub
repository, select the persistent origin and hostname, then provision and test
the named Tunnel. No application files were modified.

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
