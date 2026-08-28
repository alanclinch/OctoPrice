# Architecture

## Shape of the system

```text
              Octopus Energy API
                      |
                      v
       Cron Trigger / PricePoller
                      |
                      v
              PriceService  ------>  Store (D1 or SQLite)
                      |                  ^
                      v                  |
             AlertDispatcher             |
                      |                  |
                      v                  |
           NotificationService           |
                      |                  |
          +-----------+                  |
          v                              |
   WebPushSender                    Fastify API
          |                              |
          v                              v
   User's devices              Worker API / React PWA
```

Data moves in one direction. Nothing downstream of the store calls back into
the Octopus client, and the PWA never talks to Octopus directly.

## Packages

| Package            | Responsibility                                                       |
| ------------------ | -------------------------------------------------------------------- |
| `@octoprice/core`  | Domain logic. Pure: no network, no database, no reading of the clock. |
| `@octoprice/server`| HTTP adapters, Octopus, D1/SQLite, scheduling and push delivery.      |
| `@octoprice/web`   | The mobile-first PWA.                                                 |

`core` being pure is what makes the awkward parts testable. Daylight-saving
days, rule matching over consecutive periods and notification wording are all
decided by functions that take their inputs as arguments, including `now`.

## Key decisions

### A pricing day is a local day, not 24 hours

Everything is stored in UTC, but a "pricing day" is a `Europe/London` calendar
day. That day is 46, 48 or 50 half-hour periods long depending on daylight
saving. `expectedPeriodCount(date)` is the only thing allowed to answer "how
many periods should this day have"; nothing hard-codes 48.

### Publication detection, not a fixed schedule

Octopus usually publishes next-day prices around 16:00 but may take until
22:00, and publishes a day *in parts*. The poller therefore asks about the
data rather than the clock.

Two separate questions are asked, and conflating them caused a production
outage in which no notification was ever sent:

- **`complete`** — every expected period present, contiguous, spanning local
  midnight to local midnight. This governs what the interface claims: the
  "46 of 48" label, the chart, the cheapest-window calculation.
- **`publishable`** — an unbroken run from local midnight covering at least
  22 hours. This governs notification.

The distinction exists because an Octopus batch covers a day only up to about
23:00 local; the final period or two arrive later, usually with the following
day's batch. A day therefore does not become complete until roughly 24 hours
after it was published. Gating notification on completeness meant the daily
summary and every price alert were silently never sent.

The threshold is 22 hours rather than "expected minus two periods" because
only BST has been observed. If the Octopus cutoff is a fixed UTC time rather
than a fixed local time, a GMT day would arrive two periods shorter again;
22 hours holds under either reading.

A day that is publishable but not complete keeps being re-fetched while the
poller is awake, so it fills in by itself. Re-running the alerts each time is
safe because dedupe keys suppress anything already sent.

### One installation, several people

Every table has always been keyed by `user_id`; until recently the value was
the constant `'default'`, which meant one shared account behind an
unauthenticated public URL. Now a user is a real row, and a user *is* an
invite: the owner creates one with a random token, sends the link, and opening
it once stores an HttpOnly session cookie on that device.

There are no passwords and no email addresses. For a handful of friends and
family that is the right trade: nothing to remember, nothing to reset, and no
credential store to look after. Only the SHA-256 of a token is kept, so a copy
of the database does not hand over anybody's access, and a lost link is
replaced by reissuing - the user id never changes, so their rules and devices
survive.

What is private to a person: their region, their alert rules, their devices,
their notification history. What is shared: the price data itself, which is
public information keyed by tariff rather than by person.

The poller fetches **once per distinct tariff**, not once per person. A
household all in the same region therefore costs exactly one request, while
somebody in another region still gets their own prices. That is deliberately
not optimised away for the common case: hardcoding a single region would cost
the same and break silently the day somebody moves.

### Alerts come in two flavours

Publication alerts are *advance notice*: when tomorrow's prices land, the app
says what the day looks like and which stretches match your rules. Useful for
planning, useless for acting.

"Starting soon" alerts are the other half: roughly fifteen minutes before a
matching stretch begins, sent so there is time to put the washing on. These
are checked every five minutes, all day, and read only stored prices — they
never touch Octopus, which is what makes running them that often free.

Their dedupe keys differ deliberately. A rule-match key includes the run
length, so a stretch that genuinely grows is re-announced. A starting-soon key
does not: a stretch is announced once as it begins, and nobody needs
interrupting twice about the same one.

### Rule matches are runs, not periods

`evaluateRule` returns maximal runs of consecutive qualifying periods. A
three-hour cheap stretch is one match, not six. This is what makes "cheap for
at least two hours" the same code path as "any period below 7p", and it means
one notification per stretch rather than one per half hour.

### Deduplication is persisted, not remembered

Every notification carries a `dedupeKey` derived from stable facts: user,
rule, pricing date, the matched run's start and length. The key is written to
`notification_log` only on a successful send. So:

- Polling repeatedly cannot re-notify.
- A server restart cannot re-notify.
- A failed send can still be retried later, because failure does not claim
  the key.
- A genuinely changed published price (a correction that lengthens a cheap
  window) produces a different key, and is treated as new.

### The timing decision is a pure function

`planPoll(now, window, isRetrieved)` returns what to do and when to wake up
next. It is separate from the timer that drives it, so restart-at-03:00,
restart-at-20:00 and cutoff-passed are unit tests rather than things to find
out in production.

### The API is defined once

`api/handler.ts` holds the routing, validation and authentication as a plain
function from a request description to a response. `api/routes.ts` adapts it
to Fastify and `worker.ts` adapts it to `fetch`.

This was two separate implementations of the same twenty endpoints, which
meant production ran the copy the tests never touched. Access control made
that untenable - authentication written twice is authentication wrong once -
so the routing moved to one place. The tests drive it through Fastify, which
is now the same code the Worker runs.

### Storage is behind an interface

`Store` is expressed in domain terms with no SQL and permits synchronous or
asynchronous implementations. `D1Store` is used by Cloudflare production;
`SqliteStore` uses Node's built-in `node:sqlite` for local development and
tests.

### Forecasting is downstream of confirmed prices

The experimental baseline is deliberately unable to participate in the
confirmed-price path. A separate Cron, staggered two minutes after the core
five-minute schedule, backfills one historical tariff-day from Octopus or
prepares one active tariff's estimate. It has its own Workers Free CPU budget.
The job maintains 28 complete days for reference region C and each active
region, processing only 46, 48 or 50 rows per backfill invocation.

`packages/core/src/forecast.ts` predicts reference-region half-hours from
recent prices at the same London-local time and weekday/weekend class. The
server derives peak and off-peak regional transforms from overlapping
confirmed data and refuses them if R² drops below 0.9999. The background job
stores the prepared result in D1 worker state. The API reads and validates that
cache; it never fetches upstream data or calculates a forecast in a request.
A missing, malformed, stale or failed cache returns no estimates rather than
failing the overview, and `FORECAST_BASELINE_ENABLED` can disable both display
and background work.

An unavailable historical tariff-day is tried three times before its cursor
advances. This prevents a date from before a product launch from starving all
other tariffs indefinitely; missing days simply reduce the observations
available to the deliberately conservative baseline. Cron expressions are
defined in code and checked against `wrangler.jsonc`; an unrecognised trigger
is logged and ignored rather than falling through to price and alert work.

Forecasts appear only in the price table and chart. They do not enter the
current/next card, publication status, alerts, rules or cheapest-window
calculator. A confirmed timestamp is removed from the forecast result before
it reaches the PWA.

### Cloudflare is the production runtime

The Worker serves the built PWA through Static Assets and handles `/api/*`
with the Web Fetch API. D1 persists prices, rules, subscriptions and
deduplication state. A five-minute Cron Trigger invokes the same polling plan
used by the Node timer; most invocations are deliberate no-ops outside the
16:05–22:15 Europe/London publication window. A second five-minute trigger,
offset by two minutes, handles forecast history and cache generation without
sharing the core trigger's CPU allowance.

Once the visible baseline history is current, that forecast trigger alternates
v1 cache refreshes with one bounded `fundamentals-analogue-v2` shadow unit. The
shadow path incrementally stores compact region-C prepared days and immutable
paired v1/v2 runs, then scores them after official prices arrive. An owner-only
diagnostics endpoint reads those already-prepared rows for the Forecast tab,
including preparation progress, paired curves and scores. It does not calculate
forecasts or fetch upstream data. The normal overview and every price/alert path
remain isolated from experimental v2 failures.

Fastify remains the local Node HTTP adapter. It is not bundled into the Worker
because its router uses runtime code generation, which Workers disallow.

## Request flow

1. The PWA calls `GET /api/overview` on load, on focus, and once a minute.
2. The API reads confirmed prices and a prepared experimental-estimate cache;
   it never triggers an Octopus fetch or calculates an estimate.
3. The poller writes to the store on its own schedule.

Keeping reads and fetches separate means a slow or failing Octopus API cannot
make the UI slow or failing — it just means the data is older.

## Testing approach

- `core` is tested directly, including both daylight-saving days.
- The Octopus client is tested against recorded response shapes, including
  pagination, retries, timeouts, duplicates, negative and zero prices, and
  malformed payloads.
- The server is tested through `app.inject`, with an in-memory database, a
  fake Octopus API and a recording notification sender — so the full
  retrieve-evaluate-notify path is exercised without a network or a device.
- Nothing depends on the machine's time zone or the real clock.
