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
- **Source control:** OctoAgile Advisor rebrand commit `c780556` is integrated
  and pushed on `main`; GitHub CI run 33153820894 passed. Claude approved the
  earlier background-cache fixes in `c63d379`.
- **Build status:** passing — `npm run verify`; mobile identity visually checked
  at 320 px and 360 px with no horizontal overflow
- **Test status:** passing — 330 tests across 13 files
- **Deployed:** `b8b6dee`, Worker version
  `deb57631-2a0c-4490-9d42-d858cd4a224e`, at
  `https://octoprice.alanclinch.workers.dev`. D1 is in WEUR, migration 0007 is
  applied, both five-minute triggers are active and
  `FORECAST_BASELINE_ENABLED=true`.
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
- OctoPrice rebranded to **OctoAgile Advisor** with the selected Price Pulse
  mark (five half-hour bars flowing into a forward arrow), violet/mint brand
  accents, a reproducible SVG/PNG/maskable/Android-badge asset set, updated PWA
  metadata and an explicit independent-app notice. Internal package, storage,
  repository and Cloudflare identifiers deliberately remain `octoprice` so
  the visual rename cannot invalidate sessions or production data.

## Latest Agent Work — 2026-08-28

- **Work completed:** implemented Alan's selected concept 2, Price Pulse, and
  applied the OctoAgile Advisor name across the React shell, signed-out state,
  PWA metadata, notification fallbacks, collector identity and public prose.
  Replaced the generated launcher, maskable and Android badge assets, and added
  reusable `Brand.tsx` plus `brand-mark.svg`.
- **Verification:** `npm run verify` passes (330 tests across 13 files), icon
  generation is reproducible, `git diff --check` passes, and the built PWA was
  inspected at 320×700 and 360×800. The manifest reports `OctoAgile Advisor`
  with launcher label `Agile Advisor`.
- **Outstanding:** confirm the new Android status-bar badge on a real device.
  Android may retain the old installed-app label or launcher icon until Chrome
  refreshes the installation metadata or the PWA is reinstalled.
- **Suggested next action:** open or refresh the installed PWA, then send a test
  notification and confirm the Price Pulse tray badge renders rather than a
  white square.

## Open Review Findings

### Re-review of `3a728ba` — Claude, 2026-08-28

All three findings from the `1aa8476` review are fixed. `npm run verify` exits 0
with 330 tests across 13 files.

**1. Cron routing — fixed, and the guard is real.** `scheduledJobForCron` gives
the two expressions one home, and the new test parses the actual
`wrangler.jsonc`. I checked it is not tautological the way the one it replaced
was: editing the core expression to `*/10 * * * *` fails the test with
`expected [ '*/10 * * * *', '2-59/5 * * * *' ] to include '*/5 * * * *'`, and
`wrangler.jsonc` was restored afterwards. That matters more than it looks,
because routing an unknown expression to nothing rather than to core work means
config drift would otherwise stop price polling and alerts outright — the guard
is what makes that trade safe.

**2. Backfill starvation — fixed.** The persisted per-tariff attempt counter
carries the date, so it resets naturally on a new one, and the two-region test
shows a permanently unavailable reference day no longer starves the other
tariff.

**3. Stale cache — fixed.** Missing, malformed and stale are now three distinct
reasons with their own wording, and `parseCachedForecast` still refuses to
accept `stale` or `failed` from a stored entry, so the read-path reasons cannot
be persisted.

One new low finding:

**Transient Octopus failures spend the same skip budget as genuinely missing
days.** `recordBackfillFailure` is called from all three paths, including the
`catch`. Since the backfill only ever works on `candidates[0]`, three
consecutive forecast Cron invocations are 15 minutes, so a 15-minute Octopus
outage permanently skips a day of history, and an hour-long one burns through
about four days — the cursor only moves forward, so those holes are never
repaired while they remain in the 28-day window. The effect is small (fewer
samples per slot, with `MIN_FORECAST_SAMPLES` still guarding) and this is
display-only, which is why it is low. The clean split is to count only the
answers that will not change — `stored === 0` and a day that stays incomplete —
toward the skip budget, and let a thrown request retry without spending it.

Also worth a line, not a finding: the `wrangler.jsonc` test asserts both
expressions are present but not the converse, so a third trigger added later
would be silently ignored at runtime with only a warn. Asserting that every
configured cron maps to a known job would close the loop.

Nothing here blocks the merge or the staged rollout.


### Background forecast cache `1aa8476` — Claude, 2026-08-28

Reviewed against `origin/main`. `npm run verify` exits 0 with 328 tests across
13 files. Moving the calculation off the request path is the right call and the
numbers hold up: I reran the benchmark and measured the cache read at **0.063 ms
median, 0.104 ms p95** for 96 periods, against 3.74 ms median for the full
calculation. Set beside the live P90/P99 of 8.68 ms with forecasting off, that
is the difference between fitting the 10 ms budget and not.

Checked and correct: the two Cron expressions are genuinely disjoint (`*/5`
fires at :00,:05..:55, `2-59/5` at :02,:07..:57); cache validation covers
version, tariff match, London-day match, a +60 s future guard, the six-hour age
limit and the shape of every period; and the overview re-applies confirmed
precedence by filtering cached periods against today's and tomorrow's stored
starts, with a test for it.

I also checked the clock-change risk directly rather than reasoning about it,
since the backfill only advances when `isDayComplete` is satisfied and both
transition days will enter the rolling 28-day window. Against the live Octopus
API, 2026-03-29 returns 46 periods and 2025-10-26 returns 50, and both satisfy
`isDayComplete`. That failure mode is not real.

Three findings, none blocking a merge. Codex addressed all three in `3a728ba`;
Claude confirmed the resolutions in the re-review above.

**1. Medium — nothing ties `wrangler.jsonc` to `FORECAST_BACKGROUND_CRON`.**
`isForecastBackgroundCron` is exact string equality against
`'2-59/5 * * * *'`, and the only test asserts the constant matches itself, which
cannot fail. If either side is edited independently the routing breaks silently,
and the fall-through is the damaging direction: an unmatched forecast Cron falls
into the core branch, so price polling and alert dispatch would run at
:00,:02,:05,:07 — roughly doubling Octopus polling and alert evaluation with no
error anywhere. Please add a test that reads `wrangler.jsonc` and asserts its
`triggers.crons` contains `FORECAST_BACKGROUND_CRON` alongside the core
expression. That is the one assertion that matters here and it is the one not
being made.

*Addressed in `3a728ba`.* Cron expressions and explicit routing now share one
module. A test reads the real `wrangler.jsonc` and requires both expressions;
an unknown expression is logged and ignored rather than falling into core work.

**2. Medium — one un-completable backfill day now stalls all forecasting,
permanently.** `runForecastHistoryBackfill` has three paths that return
`ran: true` *without* advancing the cursor: Octopus returns nothing for the
date, the day is still incomplete after storing, or the call throws. That was
survivable before, because forecasts were computed from whatever history
existed. Now `runForecastBackgroundJob` refreshes the cache only when
`!backfill.ran`, so a cursor that cannot advance blocks the cache forever, not
just the history. It is amplified by the scheduling: `candidates` is sorted by
date and only `candidates[0]` runs per invocation, so a single stuck tariff-day
also blocks every *other* tariff's backfill indefinitely.

Transient failures self-heal, and per finding 3 above the clock-change days are
fine. The permanent case is a date Octopus can never serve — most plausibly
after `OCTOPUS_PRODUCT_CODE` is pointed at a product launched less than 28 days
ago, where the earliest days of the window will always return nothing. The
symptom would be silent: no forecasts for anyone, one `warn` line per five
minutes, and a UI message saying history is still being collected. Suggest
counting attempts per date and skipping forward past a date that has failed
repeatedly.

*Addressed in `3a728ba`.* Empty, incomplete and failed days share a persisted
attempt counter. After three attempts the cursor advances. A two-region test
proves a permanently unavailable reference day no longer starves the other
tariff.

**3. Low — a stale cache reports itself as missing history.** Absent, expired,
previous-day and corrupt entries all collapse to `insufficient-history`, which
the UI renders as “estimates will appear after enough recent price history has
been collected”. Because entries are invalidated at the London day boundary and
only one tariff is refreshed per five minutes, every user sees that message
after each midnight until their tariff's turn comes round — up to roughly five
minutes times the number of active tariffs — saying history is missing when it
is complete. A separate `stale` reason with its own wording would be honest and
would also make the round-robin's latency visible if it ever grows.

*Addressed in `3a728ba`.* Missing cache means history is still collecting;
expired, future or previous-day cache means `stale`; malformed cache means
`failed`. The UI now describes `stale` as an estimate refresh in progress.

One thing only a deploy can settle, already in the rollout plan: whether the
Free plan accepts the second Cron Trigger.

### Re-review of `70593e8` — Claude, 2026-08-27

All four findings from the `6441a82` review are fixed, and I verified each
against measurement rather than reading the diff. `npm run verify` exits 0 with
324 tests across 13 files.

**1. CPU — fixed and independently confirmed.** `benchmark-seasonal-baseline.mjs`
gives 3.55 ms median and 4.74 ms p95 for 1,344 periods and 96 targets, against
the 617 ms I measured before, with a doubling ratio of 1.45. The Proxy-based
test that throws if the target loop touches raw history is a good guard for the
exact regression.

The risky part of that fix is the arithmetic in `prepareForecastHistory` that
replaced the per-row ICU lookup, so I checked it rather than trusting the unit
test: comparing its `minutes` and `weekend` against `londonMinutesOfDay` and the
ICU date for every half-hour from 2025-10-01 to 2026-11-01 gives **0 mismatches
across 19,010 periods**, covering one 46-period day and two 50-period days, and
0 mismatches again with multi-day gaps punched through the history so the
running day cursor has to resynchronise. The 46/50 index offsets are correct.

**2. Error isolation — fixed.** `safeBaselineForecast` degrades to
`unavailableReason: 'failed'`, the forecast now joins the existing
`Promise.all`, and the integration test proves the endpoint still returns 200.

**3. Kill switch — fixed.** `FORECAST_BASELINE_ENABLED` defaults false and also
gates the cron and startup backfill in both runtimes.

**4. Lead time — fixed, and the fix improved the product.** The back-test now
scores both horizons at the issue times the app actually uses, and moving
`historyTo` to `endOfLondonDay(today)` means the shipped configuration really
does match what is measured: 3.82p tomorrow, 3.99p the day after, over 2,736
periods each. I reran it live and reproduced both. My earlier 4.05p figure
described the old `startOfLondonDay` window and no longer applies. Wording,
the repeated separator and the invented ex-VAT field are all dealt with.

Nothing blocking remains. Three residual notes, none of which need to hold up a
merge:

- **The leakage guard moved out of `packages/core` and nothing tests it.**
  `forecastSeasonalPrices` no longer filters history to `Date.parse(validTo) <=
  now`; only targets are gated. Both current callers bound history themselves,
  so there is no live defect, and including today's confirmed prices is the
  right call. But the pure layer used to make a future-data leak structurally
  impossible and now relies on callers getting it right. Worth either restoring
  the filter over `preparedHistory` or documenting the contract on the option.

- **~4 ms of a 10 ms budget, and production is opted in on deploy.**
  `wrangler.jsonc` sets `FORECAST_BASELINE_ENABLED: "true"`, so the default-off
  applies to local runs only. Only the forecast portion has been benchmarked;
  the end-to-end CPU of `/api/overview` with auth, D1 deserialisation and JSON
  serialisation on top has not been measured on a real Worker isolate. Suggest
  deploying once with the flag false, measuring the whole request, then turning
  it on — the margin is real but no longer generous.

- **The scaling guard is a script, not CI.** `benchmark-seasonal-baseline.mjs`
  throws above 3x, but `verify` does not run it, so only the Proxy unit test
  actually blocks a regression.

Still true from the first review and unchanged: the back-test only exercises the
identity transform, so the regional path every non-London user takes remains
unmeasured.


### Forecast baseline review of `6441a82` — addressed by Codex, 2026-08-27

Reviewed on branch `codex/forecast-baseline`. `npm run verify` passes and
`npm test` reports 321 tests across 13 files, as claimed. Alert dispatch, the
rules engine, cheapest windows and notification text were checked by grep and
genuinely never see a forecast: `buildBaselineForecast` is referenced only by
`/api/overview`, and `packages/core` rules/windows/notifications contain no
reference to it. The accuracy claim reproduces exactly — running
`docs/research/backtest-seasonal-baseline.mjs` against live Octopus data gives
MAE 3.8158p, and the honest reporting of zero negative-price skill (93 actual
negatives, 9 predicted, no overlap) is a credit to the work.

All four findings were accepted and resolved. The retained review text below
records why the changes were necessary; the current evidence and files are in
the resolution summary after it.

**1. Resolved (was blocking) — the forecast costs ~620 ms of CPU on `/api/overview`, against
a 10 ms Workers Free budget.** `apps/server/src/api/handler.ts:284` awaits
`buildBaselineForecast` on the endpoint every screen of the app depends on.
Measured on this machine with 28 days of two regions (1,344 periods each) and
96 targets, which is the steady state the code is designed for:

    JSON.parse of 2,688 stored rows           0.84 ms
    fitRegionalPriceTransform                 6.36 ms
    forecastSeasonalPrices (96 targets)     616.87 ms

The cause is in `packages/core/src/forecast.ts`: `forecastSeasonalPrices`
re-scans the whole history inside the `targets.flatMap`, and the filter calls
`londonMinutesOfDay` and `londonDateOf` on every history row for every target.
Both go through `Intl.DateTimeFormat.formatToParts`, measured at 4.2 us per
call, so 96 x 1,344 x ~2 = about 258,000 Intl formats. `fitRegionalPriceTransform`
on its own already spends 6.4 ms of the 10 ms.

Machine speed is not the issue at 62x over budget: this will be terminated
with an exceeded-CPU error in production and take the main data endpoint with
it. The fix is cheap — bucket the history once by `(isWeekend, minutesOfDay)`
in a single O(n) pass (1,344 Intl calls rather than 258,048) and look each
target up in the map. Please add a bench or a test asserting the work is
linear in history length, so this cannot regress silently.

**2. Resolved (was high) — a forecast failure takes down the whole overview response.**
`buildBaselineForecast` at `apps/server/src/api/handler.ts:284` is awaited
with no `try`/`catch`, and nothing wraps route dispatch in `handleApiRequest`.
Any D1 error inside those three `getPrices` calls turns the endpoint that
serves current price, next price, today, tomorrow and settings into a 500. The
stated constraint is that forecasting must not weaken confirmed prices, so the
forecast should be caught and degraded to `periods: []` with a reason, never
propagated. Relatedly, it runs *after* the existing `Promise.all` rather than
inside it, adding a needless serial round-trip.

**3. Resolved (was medium) — no kill switch, unlike every other forecasting feature.** The
input archive is gated behind `FORECAST_ARCHIVE_ENABLED`. The baseline, which
is user-visible and explicitly experimental, ships on with no environment
flag, so the only way to withdraw it in production is a redeploy. Given
finding 1 that matters. Suggest a `FORECAST_BASELINE_ENABLED` defaulting off
until the CPU work lands.

**4. Resolved (was low) — the back-test measures a shorter lead time than the app ever uses,
and the displayed range is right about half the time.**
`backtest-seasonal-baseline.mjs` sets `predictionTime` to one millisecond
before the target day's own midnight, so history ends the night before the day
being scored. `buildBaselineForecast` instead ends history at
`startOfLondonDay(today)` and forecasts `today+1` and `today+2`, a lead time
one to two days longer. Scoring the shipped configuration over the same window:

    as shipped, tomorrow            n=2592  MAE 4.053p  range coverage 47.0%
    as shipped, day after tomorrow  n=2592  MAE 3.889p  range coverage 47.0%

So the honest headline figure is about 4.0p, not 3.82p. The gap is small and
the conclusion is unchanged, but `docs/forecasting.md` and the handoff should
quote the configuration that ships. Two smaller points in the same area:

- Today's prices are already confirmed and stored by the time this runs, yet
  the history window stops at the start of today and throws them away.
  Including them is worth about 0.1p (tomorrow: 3.957p) and costs nothing.
- The UI labels the P20-P80 band `X-Y recent range`, which is properly
  descriptive rather than a fabricated confidence interval — but it contains
  the actual price only 47-49% of the time, and a reader will take a range as
  a bracket. Consider saying what it is, e.g. "middle of recent prices".

Also noted, not worth blocking on: the back-test only ever exercises the
identity transform (`fitRegionalPriceTransform(all, all, true)`), so the
regional path that every non-London user takes is unmeasured; the
`Experimental estimates from here` separator row in `PriceTable.tsx` repeats
if confirmed and forecast periods ever interleave across a publication gap;
and `valueExcVat` is derived by dividing by a hard-coded 1.05.

**Resolution summary.** `prepareForecastHistory` now classifies the sorted
history once, with DST-aware settlement-slot tests, and shares that pass with
the transform and all targets. The new benchmark measures 4.01 ms median for
1,344 periods and 96 targets; doubling history takes 1.70×, and a unit test
prevents the target loop from reading raw history again. Forecast reads now
run concurrently with the other overview reads and degrade to `periods: []`,
reason `failed`, if anything throws; the integration test proves the endpoint
still returns HTTP 200. `FORECAST_BASELINE_ENABLED` defaults off, production
opts in explicitly, and disabling it also stops backfill. Today's official
prices are included. The corrected live back-test measures 3.82p MAE tomorrow
and 3.99p the following day over 2,736 periods per horizon. The P20–P80 label
now says “middle of recent prices”; the separator is emitted once; and the
made-up ex-VAT forecast field was removed.

### Forecast input archive post-removal review — addressed in `6441a82`

Codex reviewed `ea68f40` on 2026-08-27. The code changes resolve the three
previous findings: the NESO collector is gone, the retained timestamp helper
subtracts the 30-minute period, the public-vintage research script runs
successfully, and migration 0006 gives retention an indexed plan. Two P2
follow-ups were raised and are now resolved:

1. **P2 — invalid NESO rows are cleaned only in this one deployment.**
   *Fixed.* Migration 0007 idempotently removes every `neso_embedded` row,
   with an upgrade regression test that preserves Carbon rows.

   The original finding: The
   handoff records a manual production deletion, but no migration removes
   `source = 'neso_embedded'`. Any other installation that ran either flawed
   collector keeps midnight-collapsed or 30-minute-late rows for up to 180
   days, where a future training export can mistake them for valid data. Add a
   new idempotent migration deleting all archived NESO rows; the official NESO
   archives make those local copies unnecessary in every installation.
2. **P2 — `docs/forecasting.md` still describes the removed collector.**
   *Fixed and re-measured against production D1.* Carbon-only batches held 97
   and 96 rows at 292.8 bytes of stored column values per row: about 772 rows,
   0.23 MB/day and 41 MB per 180 days before SQLite/index overhead.

   The original finding: Its
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

## Status: experimental forecast enabled; history backfill in progress

Alan resumed forecasting development on 2026-08-27 with Codex as implementer
and Claude as reviewer. The existing application remains deployed and stable;
forecasting work must not weaken confirmed prices or alerts.

**The app is done and doing its job.** Confirmed prices, the daily publication
summary, price-alert rules, starting-soon alerts, per-person access and the
status page all work in production, and notifications have been verified
arriving on a real device across a real publication cycle.

**Forecasting now has an experimental user-visible baseline.** It is a rough
data-based estimate, not a precision claim: measured MAE is 3.82p/kWh for
tomorrow and 3.99p/kWh for the following day, and it does not predict
negative-price events reliably. Those limits are why it is labelled
throughout and cannot drive alerts or cheapest-window advice.

## Currently In Progress

- Claude's final re-review approved all three fixes and explicitly found
  nothing blocking merge or staged rollout. Its new transient-outage note is
  low severity and did not delay enablement.
- `c63d379` was fast-forwarded to `main`; local `npm run verify` and GitHub CI
  run 33151865731 passed with 330 tests.
- The disabled staged deployment succeeded as Worker version
  `46712db1-e50c-46aa-8cc6-3877ee01123a`. Cloudflare accepted both Cron
  expressions; `/api/health` and the app shell returned 200.
- Enablement commit `330bba7` passed local verification and GitHub CI run
  33152043906, then deployed as Worker version
  `0f28fe6b-630e-4ec0-8b0b-11964f9b2746` with the flag true. Both live routes
  remain healthy.
- The first live forecast invocation advanced reference-region C's cursor to
  `2026-08-01`, proving backfill is running. Production has one active region
  N plus reference region C, so the initial 56-day backfill and first cache
  should take at most about 4 hours 40 minutes from the 08:37 BST first run.

## Forecasting

Stages 1-4 and the implemented archive/baseline are recorded in
`docs/forecasting.md`. Carbon Intensity remains insert-only because its
vintages cannot be reconstructed. NESO is not collected; migration 0007
removes every legacy row because the provider's own archives are better.

The baseline backfills one tariff-day per isolated forecast cron, keeping D1
writes modest and confirmed-price work separate. It predicts region C from up
to eight recent same-slot weekday/weekend observations, then maps other regions
with derived peak/off-peak fits that must hold R² >= 0.9999. Missing inputs or
a failed fit produce no forecast. API requests use D1 only.

The UI merges estimates after confirmed prices, marks the boundary, labels
every row, shows the middle of recent prices and outlines chart bars. Current,
next, status, alerts, rules and cheapest windows still use confirmed prices
only. Confirmed timestamps suppress estimates before the response is returned.

The reproducible back-test (`docs/research/backtest-seasonal-baseline.mjs`)
scores 2,736 periods per shipped horizon: tomorrow MAE 3.82p and following-day
MAE 3.99p. Middle-of-recent-prices coverage is 49.2% and 46.9% respectively;
negative-price recall remains 0%. Exact-weekday matching was measured and
rejected as worse (4.25p MAE).

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

1. After roughly 13:20 BST, confirm the first region-N cache exists and the
   signed-in price timeline displays estimates for tomorrow and the following
   day.
2. Capture OctoAgile Advisor and comparison-app forecasts at the same issue time, then
   compare each half-hour against the eventual confirmed Octopus prices.
3. **Confirm the new Android badge visually.** Send another test notification
   after the updated service worker is active and confirm the tray shows the
   system-tinted Price Pulse mark rather than a white square. Push delivery
   itself has been confirmed on a real Android device.
4. **Watch several real Octopus publication cycles** (DESIGN.md section 42,
   step 21) before calling the MVP released. Confirm the daily notification
   arrives once, at a sensible time, and does not repeat.
5. Then Phase Two (DESIGN.md section 39). The rules engine, the window
   calculator and the provider interface are already general enough for
   Telegram, Home Assistant and EV-charging features without redesign.

## Known Problems

- **Migration 0003 locks a live installation until a link is claimed.** Apply
  the migration, deploy, then immediately run `npm run issue-link`. Existing
  push subscriptions belong to the owner and keep working once claimed.

- **The new Android notification badge has not yet been seen on the phone.**
  The previous badge delivered successfully but appeared as a white square.
  Its replacement is a verified transparent Price Pulse alpha mask and is now
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

### 2026-08-27 — Codex, Claude review fixes

**Work completed:** accepted all four findings against `6441a82`. Forecast CPU
is now linear and benchmarked at 4.01 ms median for the 28-day/96-target shape;
forecast errors degrade without affecting the overview; reads are concurrent;
`FORECAST_BASELINE_ENABLED` gates display and backfill; today's confirmed
prices feed the estimate; both shipped horizons are back-tested; range wording,
separator repetition and the fabricated ex-VAT field are fixed.

**Verification:** `npm run verify` passed (324 tests). The CPU regression
benchmark measured a 1.70× runtime increase when history doubled. The live,
fixed-range Octopus back-test measured 3.82p tomorrow MAE and 3.99p
following-day MAE over 2,736 periods each. Review-fix commit `70593e8` is ready
on `codex/forecast-baseline`.

**Outstanding:** Claude re-review. Do not merge or deploy before approval.

### 2026-08-27 — Codex, experimental forecast baseline

**Work completed:** implemented `seasonal-naive-v1`, isolated incremental
history backfill, derived regional transforms, confirmed-price precedence and
inline labelled estimates/ranges; added migration 0007; corrected and
re-measured the Carbon-only archive documentation. Main files:
`packages/core/src/forecast.ts`, `apps/server/src/forecast/baseline.ts`,
`apps/web/src/components/{PricesView,PriceTable,PriceChart}.tsx`, migration
0007, tests, `docs/forecasting.md`, architecture and changelog.

**Verification:** `npm run verify` passed (321 tests); fixed-range back-test
measured 3.82p MAE over 2,736 periods; local browser check found no console
errors. Implementation commit `6441a82` is review-ready on
`codex/forecast-baseline`.

**Outstanding:** Claude review. Do not migrate or deploy before approval.
After approval, migration 0007 must precede the Worker deployment.

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
