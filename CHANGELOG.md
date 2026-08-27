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

- **First-run setup and install action.** New devices choose their electricity
  area before viewing prices, the header shows the area's real name, and an
  install button either opens the native PWA prompt or gives browser-specific
  Add to Home Screen guidance.
- **Continuous price timeline.** Today and tomorrow now form one scrollable
  sequence with date separators. Remaining periods are the default, the
  current slot is first, and the toggle restores elapsed prices.
- **Cloudflare-native hosting.** The PWA and API can run on Workers with
  Static Assets, D1 persistence and Cron Trigger polling, including a free
  `workers.dev` deployment with no separate origin server.
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

### Fixed

- Removed the internal region code from the header, clarified when new prices
  normally arrive, separated alert-rule titles from their conditions, and
  replaced the solid Android notification square with a monochrome bolt.
- Added a discreet Alan Clinch credit, source link and standard author
  metadata.
- The current-price card now shows the next price inline, and the secondary
  availability, cheapest-window and chart panels are condensed into one
  optional card that remembers which tool was left open.
- Changing region now immediately backfills current and next-day prices for
  the selected area.
- Default alert rules are claimed atomically during first-run setup, and the
  migration removes the duplicate defaults created by the initial concurrent
  Worker startup.
