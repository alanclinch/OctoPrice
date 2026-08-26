# Architecture

## Shape of the system

```text
              Octopus Energy API
                      |
                      v
            PricePoller (scheduler)
                      |
                      v
              PriceService  ------>  Store (SQLite)
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
   User's devices                   React PWA
```

Data moves in one direction. Nothing downstream of the store calls back into
the Octopus client, and the PWA never talks to Octopus directly.

## Packages

| Package            | Responsibility                                                       |
| ------------------ | -------------------------------------------------------------------- |
| `@octoprice/core`  | Domain logic. Pure: no network, no database, no reading of the clock. |
| `@octoprice/server`| Everything with a side effect: HTTP, Octopus, SQLite, timers, push.   |
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
22:00, and can publish a day *partially*. The poller therefore asks "is this
day complete?" rather than "has 16:05 happened?". A day counts as published
only when every expected period is present, contiguous, and spans local
midnight to local midnight.

This has been observed in practice: a day can sit at 46 of 48 periods for a
while before the rest arrives.

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

`Store` is expressed in domain terms with no SQL. `SqliteStore` implements it
using Node's built-in `node:sqlite`, chosen to avoid a native build step.
PostgreSQL should need only a second implementation.

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
