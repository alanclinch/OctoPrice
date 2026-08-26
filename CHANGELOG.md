# Changelog

All notable user-visible changes are recorded here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version, build number and commit hash are derived from Git at build time
rather than maintained by hand here (see `DESIGN.md` section 34).

## [Unreleased]

MVP feature-complete. Not yet released: push notifications still need
confirming on a real device, and the app has not yet watched several real
Octopus publication cycles.

### Added

- **Live prices.** Current price, next price, and every half-hour period for
  today and tomorrow, with a chart and a plain table. Negative and cheap
  periods are colour-banded so they stand out.
- **Publication alerts.** The server polls Octopus from 16:05 every five
  minutes until 22:15, and notifies once the *complete* next day has arrived —
  a partially published day is shown as partial and does not trigger the
  summary.
- **Alert rules.** User-defined rules with four comparison operators, an
  optional time restriction that may cross midnight, and an optional minimum
  duration, so "below 7p for at least two hours" works out of the box. Three
  sensible rules are created on first run.
- **Cheapest continuous window.** The cheapest unbroken stretch of 1, 2, 3 or
  4 hours in any day.
- **Web push notifications**, per device, with a service worker so
  notifications arrive while the app is closed. Tapping one opens the
  relevant day.
- **Duplicate protection.** Every notification is keyed on stable facts and
  recorded once sent, so repeated polls and server restarts cannot re-notify.
- **Settings.** Region (all 14 distribution regions), notification switches, a
  test notification, alert rule management, 12/24-hour clock and
  light/dark/system theme.
- **Status page** showing the last Octopus check, the last complete
  retrieval, stored period counts, tariff details, recent notifications and
  the build version.
- Correct handling of British Summer Time, including the 46 and 50-period days
  either side of a daylight-saving change.
