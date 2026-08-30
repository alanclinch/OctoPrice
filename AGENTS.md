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

## Forecasting

Predicted prices are a *proposed* enhancement, designed in
`docs/forecasting.md` and not implemented. Two findings from that research
bind any future work:

- Agile regions are exact linear transforms of one another once peak
  (16:00-19:00 local) and off-peak are separated - R^2 of 1.000000 over 1441
  periods. Forecast one reference region and map the rest; never model regions
  separately, and never hard-code the coefficients.
- Elexon's MID dataset is *not* the wholesale series Agile derives from. It is
  fine for history and training, useless as the input.

Forecasting must never be able to break confirmed prices. It runs in its own
cron branch, and a run with missing inputs produces no forecast rather than a
worse one. A forecast must never be displayable as though it were an official
Octopus price.

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

## Mandatory independent Claude review

Every user turn concerning this project must use this workflow, including
small code, documentation and configuration changes:

1. Understand the user's request and perform the requested work.
2. Run the appropriate tests, checks, linting or other validation.
3. Before the final response, invoke the locally installed Claude Code CLI for
   an independent review. This review is mandatory and must not be replaced by
   a Codex self-review or by `AI_HANDOFF.md`.
4. Claude is a read-only reviewer. Never grant it Edit, Write or any other
   file-modification tool. Use `--permission-mode dontAsk` and only the tools
   listed in the command below.
5. Give Claude the original user request and a concise description of the work
   completed in the current turn. Tell it to inspect the current Git diff and
   relevant surrounding code.
6. Independently assess Claude's findings. Do not accept them automatically.
7. If Claude identifies a valid problem caused by the current work, fix it,
   rerun the relevant validation, and invoke the read-only Claude review again.
   Normally use no more than two review rounds; exceed that only for a clear
   critical defect.
8. Only then provide the final response.

The Codex execution environment does not inherit the npm global-bin directory,
so invoke Claude through this verified full path:

```powershell
"<DYNAMIC REVIEW PROMPT>" | `
  & 'C:\Users\alanc\AppData\Roaming\npm\claude.cmd' -p `
    --permission-mode dontAsk `
    --allowedTools "Read,Glob,Grep,Bash(git status *),Bash(git diff *),Bash(git log *)"
```

The dynamic review prompt must include the current user's original request and
the implementer's concise work summary, followed by this instruction:

> You are acting only as an independent code reviewer. Do not modify any files.
> Review the work completed for the current user request. Inspect the current
> git diff and relevant surrounding files. Look for bugs, regressions, incorrect
> assumptions, security issues, architectural problems, edge cases, missing or
> inadequate tests and anything that fails to fully satisfy the request. Be
> concise and specific. If there are no material issues, finish with REVIEW:
> PASS. If there are material issues, finish with REVIEW: FAIL.

If the Claude command fails, do not claim that Claude was unavailable without
attempting it. Preserve and report the exact command failure in the final
response. Never allow Claude to edit the project as part of this workflow.

The final response must clearly state:

- what was done;
- which validation and tests passed;
- that Claude reviewed the work;
- what Claude found;
- whether Codex agreed with those findings;
- what changed as a result, if anything; and
- the final review status.

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
