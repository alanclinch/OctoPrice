# Start here: guide for a new AI maintainer

This is a navigation map for OctoAgile Advisor. Alan is preparing to leave the
project dormant. The service has not been recorded as shut down; check actual
state before acting. Do not treat a dated handoff entry as a current live check.

## First reading, in order

1. Read `AGENTS.md` (and `CLAUDE.md` when using Claude Code) for the working,
   review, Git and release rules. Its Claude CLI path refers to the original
   Windows machine and must be checked on a different computer.
2. Read `AI_HANDOFF.md`, starting with **Current State**, **Currently In
   Progress** and **Open Review Findings**. Much of it is dated history;
   check dates, Git and code before assuming an old issue remains open.
3. For taking the app dormant or bringing it back, read `docs/dormancy.md` in
   full, then `docs/deployment.md`. No shutdown or production release is
   authorised merely by opening these documents.
4. Check `git status -sb`, recent history and the relevant code. Fetch the
   remote if available, and preserve work already in progress. The `dev`
   branch is the development handoff; `main` is the production release branch.

## Find the right Markdown file

| You need to know | Read |
| --- | --- |
| What the app does, local installation and commands | `README.md` |
| Latest known state, decisions, outstanding work and review history | `AI_HANDOFF.md` |
| What to preserve, decide, shut down or check on resumption | `docs/dormancy.md` |
| Cloudflare Workers, D1, migrations, secrets and deployment | `docs/deployment.md` and `wrangler.jsonc` |
| How the parts, schedules and data flow fit together | `docs/architecture.md` |
| Push notifications, subscriptions, privacy and deduplication | `docs/notifications.md` |
| Octopus API, tariffs, publication and daylight-saving behaviour | `docs/octopus-api.md` |
| AgilePredict, baseline fallback, private experiment and research | `docs/forecasting.md` |
| Original requirements and design rationale | `DESIGN.md` (historical; check code) |
| User-visible changes | `CHANGELOG.md`; use Git history for exact changes |

When sources disagree, running code and verified current infrastructure take
precedence over historical prose. Document any corrections with dates and
evidence. Do not assume the next maintainer can access this conversation.

## Find the implementation

| Area | Starting point |
| --- | --- |
| Domain prices, London time, rules and cheapest windows | `packages/core/src/prices.ts`, `time.ts`, `rules.ts`, `windows.ts` |
| Worker entry point and schedules | `apps/server/src/worker.ts`, `scheduler/crons.ts`, `scheduler/poller.ts` |
| Octopus price retrieval | `apps/server/src/octopus/client.ts`, `prices/service.ts` |
| Forecast provider, fallback and experiments | `apps/server/src/forecast/provider.ts`, `baseline.ts`, `analogue.ts`, `competitor.ts` |
| Forecast calculations and regions | `packages/core/src/forecast.ts`, `forecast-analogue.ts`, `regions.ts` |
| Alert evaluation and dispatch | `packages/core/src/rules.ts`, `apps/server/src/alerts/dispatcher.ts` |
| Authentication, API and persistence | `apps/server/src/auth.ts`, `api/handler.ts`, `api/routes.ts`, `db/store.ts`, `db/d1.ts`, `db/sqlite.ts` |
| Local Fastify server | `apps/server/src/app.ts`, `index.ts` |
| Push delivery and message content | `apps/server/src/notifications/`, `packages/core/src/notifications.ts`, `apps/web/src/sw.ts` |
| Web interface | `apps/web/src/App.tsx`, `apps/web/src/components/`, `apps/web/src/styles.css` |
| Database schema history and CI | `migrations/`, `.github/workflows/ci.yml` |
| Tests | `packages/core/test/`, `apps/server/test/`, `apps/web/test/` |

## Copying to another computer

Check `git status` and the current branch before copying the `dev` source and
Markdown files; account for any uncommitted work rather than silently losing
it. Include `.git` if history and branch information are wanted. A full folder copy can also include ignored
secrets, invitation links and local databases: review or exclude them before
sharing. Reinstall dependencies with a suitable Node.js version rather than
relying on a copied `node_modules` directory. Cloudflare account access,
remote D1 data, Worker secrets and original VAPID key material are separate
from the source handoff; see `docs/dormancy.md`. Do not place credentials in
the Markdown files or Git. A separate Claude Code installation and sign-in may
be needed for the review workflow in `AGENTS.md`.
