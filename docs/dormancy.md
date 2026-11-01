# Dormancy and resumption

Alan is preparing to move away from the Agile tariff and leave this project
dormant. As of 1 November 2026, no shutdown is recorded by this documentation
change. Verify the actual Cloudflare state before assuming either environment is
running or disabled. Do not disable, delete, migrate or export live services or
personal data without an explicit decision on scope and retention.

## Start here

- Read `AGENTS.md` for project constraints and release rules. The next AI may
  choose its own development and review methods and models.
- Read `AI_HANDOFF.md`, checking dates and Git history: historical deployment
  statements are evidence of past state, not proof of current state.
- Read `docs/deployment.md`, `docs/architecture.md`, `docs/notifications.md`
  and `docs/forecasting.md`; compare each against code and Cloudflare settings.
- Fetch the remote, inspect `git status -sb` and recent commits, and preserve
  any uncommitted work. Development normally targets `dev`; production release
  from `main` requires Alan's explicit approval.

## What must be accounted for

The production Worker `octoprice` serves the PWA and API, binds the production
D1 database and has separate five-minute price/alert and forecast schedules.
The `octoprice-dev` Worker has its own origin, D1 database and credentials.
Both are configured in `wrangler.jsonc`; resource IDs are not credentials.
The last recorded production version and public URLs are in `AI_HANDOFF.md`.
On 1 November 2026 the production and dev `/api/health` endpoints both returned
HTTP 200 with `status: ok`. This only confirms that the endpoints responded; it
does not verify schedules, push delivery, forecast freshness or ownership.
Check whether cron triggers, Workers, D1 databases and billing remain active;
stopping web traffic alone does not necessarily stop scheduled work.

The database contains users, sessions, rules, subscriptions, notification
deduplication and price/forecast history. Backups and exports can contain
personal data and access tokens: protect them and decide who may retain them,
where and for how long before creating or sharing one. Never commit exports,
invitation links, Cloudflare credentials or VAPID private keys. Existing push
subscriptions depend on the original VAPID keys; sessions and installs also
depend on the original production origin, cookie behaviour and database.
Check whether the original VAPID key material exists in an approved secure
location before relying on it for reconstruction. Do not assume an existing
Worker secret can be retrieved in plaintext; verify Cloudflare's current secret
handling. Retaining an existing Worker and its secrets differs from rebuilding it.

Before any dormancy operation, agree whether users should be notified, whether
the app should remain accessible, whether notifications and schedules should
stop, and what happens to data, backups, secrets and recurring costs. Record
the actual decisions, date, verified resource state and restoration procedure
here after authorised changes. Do not imply that disabling a Worker deletes data
or that removing a schedule preserves every other service setting: verify the
provider's current behaviour before acting.

## Resuming

Confirm access to the GitHub repository and the correct Cloudflare account;
check Worker bindings, migrations, schedules, secrets and D1 data without
exposing their contents. Recheck dependency versions, Cloudflare limits and
third-party API terms. Install dependencies at the repository root and run
`npm run verify`. Before deploying either environment, inspect its current
configuration and decide which schedules and notifications should be active:
both Wrangler environments currently declare two five-minute cron triggers,
and a deployment can reapply configured schedules after a dashboard-only
pause. Exercise the isolated dev environment first using
`npm run deploy:cloudflare:dev` only when its Worker, D1 target, secrets and
scheduled effects are intended. Check actual prices, daylight-saving days,
forecast labelling and fallback, sign-in, notification permissions and push
delivery. Confirm the production deployment procedure and explicit approval
before restoring or changing production. Never assume old links or credentials
remain valid after dormancy.

AgilePredict forecasts are external, experimental and subject to its current
terms; confirmed Octopus prices take precedence. Price and alert calculations
must remain independent of forecast failures. Forecast quality should be
evaluated against observed prices, particularly cheap-window timing.

## Documentation map

- `README.md`: overview, local setup and commands.
- `AGENTS.md` and `CLAUDE.md`: agent instructions, review and release policy.
- `AI_HANDOFF.md`: dated operational record, current work and review history.
- `docs/architecture.md`: implementation boundaries and original rationale.
- `docs/deployment.md`: Cloudflare configuration and release procedures.
- `docs/notifications.md`: push setup, privacy and deduplication.
- `docs/octopus-api.md`: public price API shapes and time handling.
- `docs/forecasting.md`: research history and implemented forecast sources.
- `DESIGN.md`: historical specification; resolve conflicts in favour of code.
- `CHANGELOG.md`: user-visible history; Git is the authoritative change log.

The last recorded production application commit was `65cdb93`; the dev and
main refs should be fetched and checked rather than assumed. A historical
release required no new migration beyond `0008`; confirm actual D1 migration
state before any future release. Do not create an owner, migrate a database,
rotate keys or issue access links as a routine resumption step.
