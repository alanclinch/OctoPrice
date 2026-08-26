# CLAUDE.md — instructions for Claude Code

> **Do not assume previous Claude context is current. Git and `AI_HANDOFF.md`
> are the source of truth.**
>
> Another agent (ChatGPT Codex) works on this repository too. Anything you
> remember from an earlier session may already have been changed, reverted or
> superseded. Always check the repository first.

## Before you start work

1. `git fetch` and check what has landed since your last session.
2. Confirm which branch you are on: `git status -sb`.
3. Read `AI_HANDOFF.md` in full. It is the shared state file.
4. Read recent history: `git log --oneline -20`.
5. Confirm the code actually matches what the handoff claims. If it does not,
   trust the code and correct the handoff.
6. Check whether Codex has unfinished work in progress. If it does, do not
   modify the files it owns unless you are deliberately integrating.

## Project purpose

Monitor Octopus Energy Agile electricity prices and tell the user when
tomorrow's prices are published, when prices go negative, and when prices meet
their own alert rules. `DESIGN.md` holds the full specification.

The guiding principle, from `DESIGN.md` section 41:

> Get tomorrow's Octopus prices reliably, identify interesting periods, and
> tell the user about them.

Resist turning this into a home-energy management platform.

## Architecture

An npm-workspaces TypeScript monorepo.

```text
packages/core     Pure domain logic. No network, no database, no clock reads.
                  Time handling, price normalisation, the rules engine, the
                  cheapest-window calculator, notification text and dedupe keys.

apps/server       Fastify HTTP API, the Octopus client, the polling scheduler,
                  persistence and notification delivery. Serves the built PWA
                  in production.

apps/web          Vite + React PWA. Mobile-first.

deploy/cloudflare Example named-tunnel configuration. Credentials never live
                  in the repository.
```

Data flows one way: Octopus API to worker to database, then out through the
web API to the PWA, and through the notification service to the user's
devices.

`packages/core` must stay free of I/O. If something needs the network, a
database or the current time, it belongs in `apps/server` and takes what it
needs as an argument.

## Commands

```bash
npm install            # once, at the repository root
npm test               # Vitest across every workspace
npm run typecheck      # tsc --build plus the web project
npm run lint           # ESLint
npm run format         # Prettier, writes
npm run verify         # format:check + lint + typecheck + test + build
npm run dev            # server on :3000 (also builds core first)
npm run dev:web        # PWA dev server with API proxy
```

Run `npm run verify` before you commit. CI runs the same checks.

## Deployment

The current application must run as a persistent Node 24 process backed by a
persistent SQLite volume. Cloudflare is the HTTPS edge through a named Tunnel
to that origin; follow `docs/deployment.md` and the example under
`deploy/cloudflare/`.

Do not add Wrangler or describe ordinary Workers as supported without a
deliberate application redesign. The Fastify listener, in-process scheduler
and local SQLite persistence are not a drop-in Worker workload. Cloudflare
Containers require the paid Workers plan and have ephemeral local disk.

Deploy only committed `main` revisions after CI passes. Tunnel credentials,
VAPID keys and origin access credentials stay outside Git.

## Coding conventions

- TypeScript everywhere, `strict` on. Do not add `any` to make an error go
  away; model the type properly or use `unknown` and narrow.
- Relative imports carry the `.ts` extension. TypeScript rewrites them to
  `.js` on build, which is what lets the server run from source on Node.
- ESM only. No `require`.
- Comments explain *why*, not *what*. Match the density of the surrounding
  file — the existing code comments decisions and edge cases, not syntax.
- British spelling in user-facing text and in prose ("normalise", "colour").
- Money is in pence per kWh as a number. Always use the VAT-inclusive value
  for anything the user sees or that a rule compares against.
- Timestamps crossing any boundary (database, HTTP, push payload) are ISO 8601
  UTC strings. Convert to `Date` only inside calculations, and to London local
  time only for display.

## Time handling

This is the most common source of bugs in this project. Read
`packages/core/src/time.ts` before touching anything date-related.

- Store and compare in UTC. Display in `Europe/London`.
- A pricing day is a *local* calendar day and is 46, 48 or 50 half-hour
  periods long. Never hard-code 48.
- Never build a day boundary with `new Date(dateString)`; use
  `startOfLondonDay` / `endOfLondonDay`.

## Test requirements

- Anything touching dates, rules, or notification deduplication needs tests.
  Both daylight-saving days are already covered; keep them passing.
- Tests must not hit the network. The Octopus client is tested against
  recorded fixtures.
- Tests must not depend on the machine's local time zone or on the real clock.
  Pass an explicit `now` rather than calling `new Date()` inside logic.
- Prefer a failing test that reproduces a bug before fixing it.

## Git workflow

- `main` must always be a working build.
- Work on a branch named `claude/<topic>`, so it is obvious which agent owns
  it. Codex uses `codex/<topic>`.
- Do not make unrelated changes on `main`.
- Commit messages: a short imperative subject, a blank line, then why the
  change was made. End with the `Co-Authored-By` trailer.
- Rebase or merge the latest `main` before merging, and re-run `npm run
  verify`.

## Security

- Never commit secrets. `.env` is git-ignored; `.env.example` documents the
  variables with empty values.
- Never log a push subscription, an Octopus API key or an account number.
  `apps/server/src/logger.ts` redacts known secret fields — extend it rather
  than working around it.
- The VAPID private key signs push messages. Treat it like a password.
- Public Octopus price endpoints need no credentials. Do not introduce an
  authenticated call unless the feature genuinely requires one.
- Never commit Cloudflare Tunnel credential JSON or a real tunnel config.

## Before you finish work

1. `npm run verify`.
2. Update `docs/` if behaviour or architecture changed.
3. Update `CHANGELOG.md` if the change is user-visible.
4. Update `AI_HANDOFF.md`: what you did, what you left, what should happen
   next, and any decision worth recording.
5. Commit.
6. Push your branch.

Keep `AI_HANDOFF.md` concise and current: update or remove stale information
rather than building an append-only transcript. Git remains authoritative for
the actual change history.

If you ran out of time mid-task, say so explicitly in `AI_HANDOFF.md` under
"Currently In Progress" and note which files are half-finished. Leaving a
clear trail matters more than looking finished.
