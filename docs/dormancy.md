# Dormancy and resumption

Alan is preparing to move away from the Agile tariff and leave this project
dormant. As of 1 November 2026, no shutdown is recorded by this documentation
change. The agreed approach is a reversible freeze, planned below for a later
date. Verify the actual Cloudflare state before assuming either environment is
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

## Agreed plan: freeze, keep everything (1 November 2026)

Alan chose to **freeze** both environments rather than disable or delete them,
so the whole service can be brought back quickly. This is a plan only: the
freeze will be carried out at a later date that Alan chooses, and nothing below
had been done when it was written.

Frozen means the Cron Triggers are removed from both Workers and nothing else
changes. Kept as they are: both Workers and their `workers.dev` addresses, the
deployed production version, both D1 databases with all users, sessions,
rules, push subscriptions and history, every Worker secret (including the VAPID
keys), and the GitHub repository. Because the Worker and its secrets survive,
existing logins, installed apps and push subscriptions can work again on
resumption without anyone re-registering.

While frozen, no Octopus or AgilePredict polling runs and no notifications are
sent. The site and API stay reachable, so anyone who opens the app sees prices
stop at the freeze. A user who changes their area can still trigger a one-off
Octopus fetch from the API. Cloudflare's Free plan is believed to make this
cost nothing; confirm the plan and billing when freezing.

### Before freezing

1. Alan signs Wrangler in to the Cloudflare account that owns the
   `alanclinch.workers.dev` Workers. On the second computer, checked on
   1 November 2026, Wrangler was signed in to a different account with
   read-only scopes.
2. Record, read-only, the current state of each Worker: deployed version,
   cron triggers, secret *names* (never values), D1 migration level and plan.
   This becomes the restoration target.
3. Decide whether and how to tell the two other users. A last push
   notification has to be sent before the schedules are removed.
4. Optionally, find or securely store a copy of the production VAPID key pair.
   It is not needed while the Worker is kept, only if it is ever rebuilt.

### Freezing

Freeze `octoprice-dev` first, check it, then production. Remove both cron
expressions (`*/5 * * * *` and `2-59/5 * * * *`) from each Worker in the
Cloudflare dashboard under the Worker's trigger settings. Do not delete the
Worker, the database or any secret, and do not change `wrangler.jsonc`: it
keeps the schedules so that resumption can reapply them. Confirm in the
dashboard and the Worker logs that no scheduled invocation runs after the
change. Then record the date, versions and verified state in this file.

Warning: while frozen, any `wrangler deploy` (including
`npm run deploy:cloudflare:dev`) reapplies the schedules from `wrangler.jsonc`
and silently ends the freeze. Do not deploy unless resumption is intended.

### Resuming from the freeze

1. Sign in to the owning Cloudflare account and check that both Workers,
   databases and secrets are still present.
2. Restore the schedules without uploading new code, from a checkout of the
   committed `main` revision that matches the deployed version:
   `npx wrangler triggers deploy --dry-run`, then without `--dry-run`, and the
   same with `--env dev` for the dev Worker. The command is marked experimental
   in Wrangler 4, so check its current behaviour first; the fallback is to
   re-add the two cron expressions in the dashboard.
3. The next price run backfills today's prices automatically; tomorrow's
   arrive in the normal 16:05-22:15 London publication polling window.
   The baseline forecast refills its history one tariff-day per forecast run,
   so estimates may take a while to appear; AgilePredict estimates are
   separate. Confirm prices, the status page and one test notification.

Sessions last one year from when each invite link was claimed and are not
renewed. If a user's cookie has expired, opening their original invite link
again still signs them in, because the token is kept. Issue a new link only
if they no longer have it. Browser push subscriptions can lapse on their own
after a long gap; affected users can turn notifications on again.

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
