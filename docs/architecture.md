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
- A genuinely changed forecast (a corrected price that lengthens a cheap
  window) produces a different key, and is treated as new.

### The timing decision is a pure function

`planPoll(now, window, isRetrieved)` returns what to do and when to wake up
next. It is separate from the timer that drives it, so restart-at-03:00,
restart-at-20:00 and cutoff-passed are unit tests rather than things to find
out in production.

### Storage is behind an interface

`Store` is expressed in domain terms with no SQL and permits synchronous or
asynchronous implementations. `D1Store` is used by Cloudflare production;
`SqliteStore` uses Node's built-in `node:sqlite` for local development and
tests.

### Cloudflare is the production runtime

The Worker serves the built PWA through Static Assets and handles `/api/*`
with the Web Fetch API. D1 persists prices, rules, subscriptions and
deduplication state. A five-minute Cron Trigger invokes the same polling plan
used by the Node timer; most invocations are deliberate no-ops outside the
16:05–22:15 Europe/London publication window.

Fastify remains the local Node HTTP adapter. It is not bundled into the Worker
because its router uses runtime code generation, which Workers disallow.

## Request flow

1. The PWA calls `GET /api/overview` on load, on focus, and once a minute.
2. The API reads the store; it never triggers a fetch from Octopus.
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
