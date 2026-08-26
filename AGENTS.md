# AGENTS.md — instructions for Codex and other coding agents

> **Do not rely on conversation history as the current state of the project.
> Inspect the repository and `AI_HANDOFF.md` first.**
>
> Claude Code also works on this repository. Files may have changed since your
> last session in ways no conversation records.

## Before you start work

1. `git fetch` and review what has landed.
2. `git status -sb` to confirm your branch.
3. Read `AI_HANDOFF.md` in full.
4. `git log --oneline -20`.
5. Verify the code matches the handoff. Trust the code and fix the handoff if
   they disagree.
6. Check whether Claude has work in progress, and leave those files alone
   unless you are deliberately integrating.

## What this project is

A Progressive Web App plus a small Node service that monitors Octopus Energy
Agile electricity prices and notifies the user when tomorrow's prices are
published, when prices go negative, and when prices match user-defined alert
rules.

`DESIGN.md` is the full specification. `docs/` holds the detail.

## Repository structure

```text
packages/core/       Pure domain logic, no I/O
  src/time.ts        UTC and Europe/London, 46/48/50-period days
  src/prices.ts      Normalisation, day slicing, completeness, summaries
  src/rules.ts       Alert rule engine
  src/windows.ts     Cheapest continuous window calculator
  src/notifications.ts  Message text and idempotency keys
  src/types.ts       Shared models and zod schemas
  test/              Vitest suites

apps/server/         Fastify API, Octopus client, scheduler, persistence
apps/web/            Vite + React PWA, mobile-first

docs/                architecture, octopus-api, notifications, deployment
deploy/cloudflare/   Example named-tunnel configuration; never credentials
```

## Build and test commands

```bash
npm install          # repository root only; this is an npm workspaces monorepo
npm test             # Vitest, all workspaces
npm run typecheck    # tsc --build, plus the web project
npm run lint         # ESLint
npm run format       # Prettier, writes in place
npm run verify       # everything CI runs
npm run dev          # server on :3000
npm run dev:web      # PWA dev server
```

`npm run verify` must pass before you commit.

## Deployment

- Production runs on Cloudflare Workers with Static Assets, D1 and a Cron
  Trigger. Follow `docs/deployment.md` and `wrangler.jsonc`.
- The Node/Fastify/SQLite path remains the local development runtime.
- Apply D1 migrations before deploying code that depends on them.
- Deploy only committed `main` revisions after CI passes. Keep tunnel
  credentials and other secrets outside Git.

## Coding standards

- TypeScript, `strict`, ESM only.
- Relative imports include the `.ts` extension; the build rewrites them.
- No `any` as an escape hatch. Use `unknown` and narrow.
- Prettier owns formatting; do not hand-format. ESLint owns correctness rules.
- British spelling in prose and user-facing strings.
- Prices are pence per kWh, and user-facing values are always VAT-inclusive.
- Timestamps at any boundary are ISO 8601 UTC strings.
- `packages/core` must never import `node:` modules, perform I/O, or read the
  clock. Pass `now` in as an argument.

## Time handling

Days are *local* London days of 46, 48 or 50 half-hour periods. Never assume
48. Use the helpers in `packages/core/src/time.ts` rather than constructing
dates directly. This is the single most bug-prone area of the project and is
covered by tests that must keep passing.

## Git rules

- `main` is always a working build.
- Branch as `codex/<topic>`. Claude uses `claude/<topic>`.
- No unrelated changes on `main`.
- Short imperative commit subject, blank line, then the reasoning.
- Before merging: fetch, rebase or merge latest `main`, re-run `npm run
  verify`, review the diff.

## Security requirements

- Never commit secrets. Use `.env`, which is git-ignored, and document new
  variables in `.env.example`.
- Never log push subscriptions, Octopus API keys or account numbers.
- Public Octopus price endpoints require no authentication; do not add
  credentialed calls without a real need.
- Never commit Wrangler credentials, VAPID private keys or Cloudflare API
  tokens.

## Source-of-truth documents

| Question                        | File                            |
| ------------------------------- | ------------------------------- |
| What should this app do?        | `DESIGN.md`                     |
| What state is the project in?   | `AI_HANDOFF.md`                 |
| How does it fit together?       | `docs/architecture.md`          |
| How does the Octopus API work?  | `docs/octopus-api.md`           |
| How do notifications work?      | `docs/notifications.md`         |
| How is it deployed?             | `docs/deployment.md`            |
| What changed for users?         | `CHANGELOG.md`                  |

## Before you finish work

1. `npm run verify`.
2. Update `docs/` if behaviour changed.
3. Update `CHANGELOG.md` if the change is user-visible.
4. Update `AI_HANDOFF.md`: work completed, files changed, tests run,
   outstanding issues, suggested next action.
5. Commit and push your branch.

Keep `AI_HANDOFF.md` concise and current. Replace stale state instead of
appending a transcript; Git is the authoritative change history.

If you stopped mid-task, record that plainly under "Currently In Progress"
along with which files are incomplete.
