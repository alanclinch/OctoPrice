# AI Development Handoff

This file is the shared state between agents working on this repository
(Claude Code and ChatGPT Codex). It is agent-neutral: neither agent owns it,
both must read it before starting and update it before finishing.

If this file and the code disagree, **the code is right** — fix this file.

## Shared Review Protocol

This file is also the durable review queue between Claude and Codex. Chat
messages are not a handoff: when either agent is asked to review the project,
it must record every unresolved actionable finding under **Open Review
Findings** before finishing. Both agents must read that section before making
changes, update it as work progresses, and remove a finding only after the fix
and its relevant tests have been verified. Include severity, file/area and the
reason the behaviour is wrong so the other agent can act without needing the
original conversation.

## Active Agent Roles

Alan should never have to carry findings or instructions between agents.
For forecasting work, the standing roles are:

- **Codex owns development:** design decisions within the agreed scope,
  implementation, tests, documentation, deployment preparation and fixes.
- **Claude owns review:** inspect Codex's completed forecasting changes and
  record actionable findings directly in this file. Claude does not take over
  implementation unless Alan explicitly changes the roles.
- **`AI_HANDOFF.md` is the conversation between agents.** Codex records the
  branch, review-ready commit, verification and assumptions here. Claude
  records its verdict and findings here. Alan only needs to say “continue” or
  “review”; no copying and pasting between agents.

The forecasting implementation target is deliberately modest: an
**experimental, educated data-based estimate**, not a precision claim or a
large machine-learning system. Avoid reopening broad research unless a live
implementation is genuinely blocked.

## Current State

- **Current version:** 0.1.0 (MVP feature-complete, not yet released)
- **Current branch:** `main`
- **Source control:** clean `main`, synced to `origin/main`
- **Build status:** passing — `npm run verify`
- **Test status:** passing — 307 tests across 11 files
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

## Open Review Findings

### Forecast input archive post-removal review — open

Codex reviewed `ea68f40` on 2026-08-27. The code changes resolve the three
previous findings: the NESO collector is gone, the retained timestamp helper
subtracts the 30-minute period, the public-vintage research script runs
successfully, and migration 0006 gives retention an indexed plan. Two P2
follow-ups remain.

1. **P2 — invalid NESO rows are cleaned only in this one deployment.** The
   handoff records a manual production deletion, but no migration removes
   `source = 'neso_embedded'`. Any other installation that ran either flawed
   collector keeps midnight-collapsed or 30-minute-late rows for up to 180
   days, where a future training export can mistake them for valid data. Add a
   new idempotent migration deleting all archived NESO rows; the official NESO
   archives make those local copies unnecessary in every installation.
2. **P2 — `docs/forecasting.md` still describes the removed collector.** Its
   section 8 says NESO cannot supply history, retains the old 240-row/run and
   1,900-row/day sizing, says both stored sources lack issue times, discusses
   trimming NESO to 72 hours and its CPU cost, and keeps a NESO horizon as a
   current limitation. These statements contradict the corrected section 3a
   and the code. Re-measure Carbon-only row size and replace the obsolete
   sizing, retention runway, design points and limitation rather than merely
   saying the old figures were halved.

### Forecast input archive re-review — addressed

Codex re-reviewed `5b9cd5f` against the live NESO feed *and* NESO's official
2026 archives, and found three more. All three were right, and the second
invalidated a premise this component was built on.

1. **P1 — the corrected NESO timestamps were still 30 minutes late.** *Fixed.*
   `TIME_GMT` is the settlement period **end**. SP27 on 25 August publishes as
   12:30; BST makes that 12:00–12:30 UTC, so the period starts at 12:00. Two
   attempts reached production: the first put every period at midnight, the
   second put every period half an hour late. The shifted rows were deleted.
2. **P1 — NESO vintages were retrievable all along.** *Premise wrong, collector
   removed.* NESO publishes annual half-hourly forecast archives with a real
   `Forecast_Datetime` per issue — `31861619-…` (Jun–Dec 2026, ~1.13 M rows)
   and `d6375700-…` (Jan–Jun). The current one is up to date within the hour,
   so it serves live use as well as history, and can back-fill periods from
   before this application existed. Archiving the rolling feed was storing a
   worse copy of something already kept, so the live NESO collector is gone.
   `docs/research/neso-forecast-vintages.mjs` demonstrates the vintages.
   **Only Carbon Intensity genuinely needs live collection.**
3. **P2 — retention scanned the whole table.** *Fixed, verified with
   `EXPLAIN QUERY PLAN`.* Both indexes lead with `source`, so
   `DELETE … WHERE target_start < ?` reported `SCAN forecast_inputs` — a full
   scan eight times a day over a growing table. Migration 0006 adds an index on
   `target_start`; the plan is now `SEARCH … USING INDEX`.

**Worth carrying forward:** the NESO period semantics have now been got wrong
twice and the "no vintages" premise once. Neither was findable from the rolling
feed alone — both needed the official archive, which nobody had looked at.
Before trusting any feed, read the provider's own historical dataset first.

### Forecast input archive review — addressed

Codex reviewed `c6d1b4a`/`ff8224f` against the live payloads and the deployed
D1 table, and found five issues. All five were real; three were only visible
outside the test suite. Fixed, deployed, and covered by regression tests.

1. **P1 — NESO periods collapsed onto midnight.** *Fixed, and the deployed
   rows deleted.* `DATE_GMT` is the day; the half-hour is in `TIME_GMT`. The
   table held 144 rows across 3 distinct instants. **The fixture caused it** —
   it invented a full timestamp in `DATE_GMT`, a shape the API never emits, so
   the collector passed. A second bug sat underneath: `DATE_GMT` has no
   timezone, so `Date.parse` used the runtime zone and produced 23:00Z locally
   but 00:00Z in the Worker. Now assembled with `Date.UTC`. The bad rows could
   not be repaired because the settlement period was not stored either; it now
   is, as a cross-check.
2. **P1 — the archive was not isolated from price polling.** *Fixed.* All three
   jobs went to `Promise.all`, so "deliberately last" was false and they shared
   one 10 ms budget. `runScheduledJobs` awaits the core work first, with a test
   asserting the ordering.
3. **P2 — a succeeding source suppressed retries for a failing one.** *Fixed.*
   Per-source scheduling and retry, so a NESO failure is retried on the next
   invocation rather than waiting three hours and losing vintages.
4. **P2 — the Worker ignored the configured interval.** *Fixed.* Threaded
   through `Env` and `configFor`, along with the new retention setting.
5. **P2 — growth understated, no retention.** *Fixed and measured.* Rows
   average 235 bytes: ~0.43 MB/day, ~157 MB/year of payload before indexes. A
   free D1 database is capped at **500 MB** — the 5 GB I quoted is the account
   total. Retention now defaults to 180 days and prunes only after a successful
   collection. Longer history needs an export, which is not built.

**Worth carrying forward:** the fixture-shaped-like-the-bug problem is the
lesson here. Three of these five could not have been caught by tests written
against invented payloads. Check collectors against a real response before
trusting them.

### Further forecasting research review — addressed

Codex raised four more on 2026-08-27 against `4f118e1`–`5f58370`. All four
valid; two were claims I had made without checking. Codex re-reviewed the
answers in `3011529`, reran the revised sizing experiment, and found no further
actionable issue. Nothing outstanding.

1. **P1 — Cron does not escape the CPU limit.** *Confirmed against Cloudflare's
   docs, and my escape hatch was wrong.* Workers Free gives a Cron Trigger the
   same **10 ms** as an HTTP request; only the Paid plan gets 30 s, or 15 min
   at intervals of an hour or more. "Precompute on cron" therefore protects
   request latency and nothing else. The real choice is to stay inside the
   small-model envelope or generate forecasts outside Cloudflare — GitHub
   Actions, already proposed for training, with the Worker ingesting immutable
   results.
2. **P1 — Carbon Intensity terms.** *Read and documented.* CC BY 4.0 plus
   terms that matter: must not conceal the application's identity (so send a
   descriptive User-Agent — the Worker currently sends none), rate limited with
   blocking for heavy callers, must not substantially replace NESO's core
   experience, no implied endorsement, word mark and logo need written
   approval, and the service may be withdrawn without notice. Now a table in
   `docs/forecasting.md` section 3, to be settled before collection starts.
   This is the second time I have used a source before checking its terms.
3. **P2 — regional carbon mix is not a regional price signal.** *Accepted; it
   contradicted my own finding 1.1.* Agile's regional differences are a fixed
   retail transform of one GB series, so there is no regional price signal for
   regional carbon data to supply. The matching DNO geography is a trap. Use
   the **national** mix as a candidate feature; regional mix is user context
   only. Also noted: gas *share* is not a substitute for gas *price*, since
   the same share means different things at different gas costs.
4. **P2 — the CPU figures were a sizing experiment reported as a benchmark.**
   *Accepted and fixed.* Codex's rerun differed by ~55%, which was fair: the
   script was unseeded and reported a single mean. It is now seeded, reports
   median and p95 over 15 repeats, and records runtime and hardware. Even
   seeded, the large cases swing 50%+ between runs (GC under multi-megabyte
   structures) while small cases are stable — so the document now says to read
   the verdict column, not the milliseconds. Free-tier feasibility is only
   settled by a deployed Worker reporting its own CPU time.

### Forecasting research review — addressed

Codex raised six design gates on 2026-08-27 against `docs/forecasting.md`.
All six were valid; four are now answered with measurement rather than
agreement, and two are corrections to the document. Nothing outstanding.

1. **P1 — input vintage / leakage.** *Superseded by later live-data review.*
   Elexon and Open-Meteo expose forecast history. The initial review wrongly
   concluded that NESO did not because it inspected only the rolling feed;
   annual NESO archives do carry `Forecast_Datetime`. Only Carbon Intensity
   currently requires local live collection. See the newer archive reviews
   above and `docs/forecasting.md` section 3a.
2. **P1 — a fitted regional value must never be shown as confirmed.**
   *Accepted, and stated as a constraint.* The transform is exact to 0.01p,
   which is exactly what makes it tempting to misuse. Confirmed prices come
   from the Octopus API for that region and nowhere else.
3. **P2 — Worker CPU unproven.** *Measured, and the concern was justified.*
   `docs/research/bench-inference.mjs` over 144 periods: linear 0.010 ms,
   100 trees 0.79 ms, 300 trees 2.73 ms, but 500 trees depth 8 costs 12.1 ms
   and 1000 trees 29.7 ms — over a 10 ms budget. Tiers 1–2 are comfortable; a
   full-size ensemble is not, and AgilePredict runs three. If a large model is
   ever needed, forecasts must be precomputed on cron and the request path
   only read D1. Artefacts to be versioned and integrity-checked, not fetched
   as mutable data.
4. **P2 — decision metrics, not just MAE.** *Accepted; section 4.8 added.*
   Cheap-window regret, event precision/recall, pinball loss, and interval
   coverage. The calibration point is the sharpest one: a P10–P90 output is not
   an 80% interval until observed coverage says so, and the earlier draft
   implied quantiles give a trustworthy interval for free.
5. **P2 — ENTSO-E is an experiment, not the dependency.** *Accepted; the plan
   was reordered.* Calling it "the single biggest open question" overstated it.
   Even a good result mainly helps the same-day horizon and does not touch the
   48–72 hour problem. The baseline and the input archive unblock everything
   and proceed without it.
6. **P2 — make the findings reproducible.** *Done.* `docs/research/` now holds
   `fit-regional-coefficients.mjs` and `bench-inference.mjs`, each recording
   product codes, date ranges, VAT treatment, alignment and regression method.
   The regional script warns if the relationship stops being exact, so it
   doubles as the methodology-change detector.

### Earlier application review — resolved

Codex raised four findings on 2026-08-27 against `fb6615d` and `ed1fc65`; all
are resolved, in `main`, and deployed. Kept here briefly with their outcomes
so neither agent re-raises them.

1. **P1 — existing users could remain on an unconfirmed default region.**
   *Resolved: no defect in this installation.* The concern is sound in general
   — an existing settings row does not prove somebody chose their region — but
   the data settles it. Exactly one user existed when
   `migrations/0004_region_confirmed.sql` ran (the owner), and their region is
   `N` while the default is `C`. A row that differs from the default *is*
   evidence of a deliberate choice, so the blanket `region_confirmed = 1` set
   the right value and nobody was left silently on a default. Prompting again
   would have been a needless prompt. Going forward the flag is set by the API
   whenever a region is chosen, so the ambiguity cannot recur.
2. **P1 — one browser endpoint could belong to two people.** *Fixed.*
   Uniqueness was per `(user_id, subscription_data)`, so a device whose
   browser failed to release its old subscription could be registered by a
   second person while the first person's row stayed enabled — and both
   people's alerts reached that phone. Registration now removes the endpoint
   from any other person in the same transaction (batched on D1): a device
   belongs to whoever registered it last. Three regression tests.
3. **P2 — reopening your own link disabled working notifications.** *Fixed.*
   The device subscription was released after *every* successful claim. It is
   now released only when the previously signed-in person differs from the
   one just claimed, so reopening your own link from a bookmark or the file it
   arrived in leaves notifications alone.
4. **P2 — the status page claimed alerts had been sent.** *Fixed.* Price
   coverage cannot prove delivery: alerts may be switched off, have no
   subscription, or have failed. The ready message now speaks only about
   prices and leaves alerts to the alerts card, which reports actual state.

## Status: forecasting resumed under Codex ownership

Alan resumed forecasting development on 2026-08-27 with Codex as implementer
and Claude as reviewer. The existing application remains deployed and stable;
forecasting work must not weaken confirmed prices or alerts.

**The app is done and doing its job.** Confirmed prices, the daily publication
summary, price-alert rules, starting-soon alerts, per-person access and the
status page all work in production, and notifications have been verified
arriving on a real device across a real publication cycle.

**Forecasting currently remains research plus one small piece.** The input
archive collects Carbon Intensity and produces no forecasts yet. Codex's next
development branch will first resolve the two open P2 archive findings, then
build the smallest useful indicative forecast rather than the previously
proposed full modelling pipeline.

## Currently In Progress

- `main` is deployed and verified live; forecast work will be isolated on a
  `codex/` branch until it is reviewed.
- **Owner: Codex. Reviewer: Claude.** Next implementation branch:
  `codex/forecast-baseline`.
- Scope for the first useful forecast: a deterministic estimate from recent
  confirmed Agile history, time-of-day and weekday/weekend patterns; a clearly
  marked estimated range; confirmed prices always win; no forecast-driven
  alerts or automation in this version.
- Before the forecast itself, Codex will resolve the two open P2 findings:
  migrate away invalid legacy NESO rows and correct the stale Carbon-only
  archive documentation and measurements.

## Forecasting

Stages 1-4 are recorded in `docs/forecasting.md`, and stage 5's first piece
- the input archive - is built and running. It collects Carbon Intensity
insert-only because that forecast cannot be reconstructed later. It produces
no forecasts. NESO is no longer collected; its official annual archives carry
real issue times and support historical back-filling. This deployment's two
sets of malformed NESO rows were manually deleted, but the open finding above
requires a migration so every installation receives the same cleanup.

A practical note for whoever continues: the old CPU and storage measurements
included the now-removed NESO collector. Re-measure the Carbon-only archive
before using those figures for capacity decisions.

AgilePredict (MIT, actively maintained) was read properly, not just
summarised: it predicts a day-ahead wholesale series and converts per region
with hardcoded `(multiplier, peak_adder)` config, which is the same shape as
finding 1 below. That architecture is prior art, not a new idea here.

Two findings bind whatever gets built:

- **Regions are exact linear transforms of one another** once peak and
  off-peak are separated. R^2 of 1.000000 over 1441 periods, worst error
  0.009p, holding through negative prices and a 65p spike. Forecast one
  reference region and map the rest. The contribution over AgilePredict is
  narrower than it first looked: not the conversion idea, but *deriving* the
  coefficients from published prices instead of hardcoding them — exact rather
  than rounded, self-updating, and the fit quality doubles as a detector for a
  methodology change. AgilePredict's hardcoded factors are 2020-era and April
  2026 brought a flat −3.5p/kWh change, which is the fragility to avoid.
- **Elexon MID is not the Agile input.** R^2 of only 0.70 against Agile. It is
  the within-day market index; Agile comes from the EPEX half-hourly
  day-ahead auction that clears at 15:45, fifteen minutes before Octopus
  publishes. Fine for history, useless as the forward input.

The immediate open questions are honest baseline accuracy and allowing the
Carbon Intensity archive to accumulate. ENTSO-E remains a parallel experiment
for improving the short same-day horizon; it is not a dependency for the
48–72-hour fundamentals forecast.

Verified working with no API key: Elexon (day-ahead demand, wind forecast,
generation outturn, daily surplus, market index), NESO (embedded wind and
solar, 14 days), Open-Meteo. All reachable from a Worker with no secrets.

Recommended order, from `docs/forecasting.md` section 7: let the live Carbon
archive accumulate, fit and monitor regional forecast coefficients, then
back-test a seasonal-naive baseline and *publish its error* before judging any
model against it. Test ENTSO-E alongside those steps rather than blocking them.

## Next Recommended Work

1. **Let the Carbon Intensity archive accumulate**, and pull NESO history
   from its official archives when the back-test is written.
2. **Confirm the new Android badge visually.** Send another test notification
   after the updated service worker is active and confirm the tray shows the
   system-tinted lightning bolt rather than a white square. Push delivery
   itself has been confirmed on a real Android device.
3. **Watch several real Octopus publication cycles** (DESIGN.md section 42,
   step 21) before calling the MVP released. Confirm the daily notification
   arrives once, at a sensible time, and does not repeat.
4. Then Phase Two (DESIGN.md section 39). The rules engine, the window
   calculator and the provider interface are already general enough for
   Telegram, Home Assistant and EV-charging features without redesign.

## Known Problems

- **Migration 0003 locks a live installation until a link is claimed.** Apply
  the migration, deploy, then immediately run `npm run issue-link`. Existing
  push subscriptions belong to the owner and keep working once claimed.

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
