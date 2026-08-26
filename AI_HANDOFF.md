# AI Development Handoff

This file is the shared state between agents working on this repository
(Claude Code and ChatGPT Codex). It is agent-neutral: neither agent owns it,
both must read it before starting and update it before finishing.

If this file and the code disagree, **the code is right** — fix this file.

## Current State

- **Current version:** 0.1.0 (pre-MVP)
- **Current branch:** `main`
- **Last known good commit:** see `git log -1`
- **Build status:** passing (`npm run verify`)
- **Test status:** passing
- **Deployed:** nowhere yet
- **Git remote:** none configured yet — the repository is local only

## Current Architecture

npm-workspaces TypeScript monorepo:

- `packages/core` — pure domain logic with no I/O: London/UTC time handling,
  price normalisation, the alert rules engine, the cheapest-window
  calculator, notification text and idempotency keys.
- `apps/server` — Fastify API, Octopus client, polling scheduler,
  persistence, notification delivery.
- `apps/web` — Vite + React mobile-first PWA.

Data flows one way: Octopus API to the polling worker to the database, then
out through the web API to the PWA and through the notification service to
the user's devices.

## Completed

- Repository, tooling and CI-ready scripts (`verify` = format, lint,
  typecheck, test, build).
- `packages/core`, covered by 129 tests:
  - `time.ts` — Europe/London vs UTC, BST/GMT, and the 46/48/50-period days
    around daylight-saving changes.
  - `prices.ts` — sorting, de-duplication, London-day slicing, completeness
    validation, missing-period detection, daily summaries.
  - `rules.ts` — the generic alert engine: four operators, optional time
    restrictions including windows that cross midnight, and minimum-duration
    matching over maximal runs of consecutive periods.
  - `windows.ts` — cheapest / most expensive continuous window of any length.
  - `notifications.ts` — message text and dedupe keys.
- Specification and agent instructions: `DESIGN.md`, `CLAUDE.md`, `AGENTS.md`.

## Currently In Progress

- **Task:** server application — Octopus client, persistence, scheduler,
  rule evaluation, notifications, HTTP API; then the PWA.
- **Responsible agent:** Claude
- **Branch:** `claude/server-and-api`

## Next Recommended Work

1. Finish the server: Octopus client, SQLite store, scheduler, alert
   dispatch, REST API.
2. Build the PWA: dashboard, chart, table, settings, rule management.
3. Wire up web push end to end and test on a real Android device.
4. Create the GitHub repository and push (needs the owner to do this or to
   install the `gh` CLI).
5. Deploy a test instance and observe several days of real Octopus
   publication behaviour before calling the MVP done.

## Known Problems

- No GitHub remote exists yet, so nothing is pushed. CI cannot run until the
  repository is on GitHub.
- Web push is unverified against a real device; VAPID keys are not generated.
- Automatic Agile product discovery is implemented against the live API but
  has only been exercised for the current product, `AGILE-24-10-01`.

## Important Decisions

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
binaries); `libsql`. The store is behind an interface, so swapping is cheap.
**Caveat:** `node:sqlite` still emits an experimental warning on Node 24.

### 2026-08-26 — `.ts` import extensions

**Decision:** relative imports include `.ts`, with
`rewriteRelativeImportExtensions` rewriting them on build.
**Reason:** lets the server run directly from source on Node 24 with no
transpiler in the dev loop, while still emitting valid ESM.
**Alternatives considered:** `tsx` (an extra dependency); extensionless
imports (not valid ESM).

### 2026-08-26 — Rule matches are runs, not periods

**Decision:** the rules engine returns maximal runs of consecutive qualifying
periods rather than individual periods.
**Reason:** it makes "cheap for at least two hours" fall out of the same code
path as a single-period alert, and it means one notification per cheap
stretch instead of one per half hour.
**Alternatives considered:** returning periods and grouping in the caller,
which would have duplicated the grouping logic in the UI and the notifier.

## Recent Agent Handoffs

### 2026-08-26 — Claude

**Work completed:** repository setup from an empty directory; monorepo
scaffold and tooling; the whole of `packages/core` with 129 tests;
`DESIGN.md`, `CLAUDE.md`, `AGENTS.md` and this file.

**Files changed:** everything — this is the initial implementation.

**Tests run:** `npm test` (129 passing), `npm run lint`, `npm run typecheck`,
Prettier check.

**Outstanding issues:** see Known Problems above.

**Suggested next action:** continue with `apps/server` on
`claude/server-and-api`.
