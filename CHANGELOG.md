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

- **Experimental two-day price estimates.** Recent confirmed Agile prices now
  provide a deliberately simple weekday/weekend baseline beyond the official
  price horizon. Estimates are labelled inline, show the middle of recent
  prices, and are visually distinct. They never drive alerts or
  cheapest-window advice, confirmed Octopus prices always replace them, and a
  forecasting fault cannot prevent confirmed prices from loading. Estimates
  are prepared by a separate background trigger so opening the app does not
  spend its request CPU budget calculating them.

- **Sharing with friends and family.** The app is no longer one shared account
  behind a public URL. The owner invites people by name from a new People tab
  and sends them a link; opening it once signs that device in for good. No
  passwords, no sign-up form, nothing to reset.
- Each person has their own region, their own alert rules, their own devices
  and their own notification history. Nobody can see or change anyone
  else&rsquo;s, and prices are fetched once per region rather than once per
  person.

### Changed

- **OctoPrice is now OctoAgile Advisor.** The new Price Pulse identity turns
  five half-hour price bars into a forward arrow, with a reproducible SVG/PWA
  icon set, refreshed violet-and-mint branding, the shorter launcher name
  “Agile Advisor”, and an explicit independent-app notice. Technical storage,
  package and deployment identifiers remain unchanged to protect existing
  sessions and production data.
- **The app is now private.** Every screen requires an invite link. Anyone
  with the address used to be able to read the dashboard and change the
  region, alert rules and notifications for everybody.

### Fixed

- Forecast history collection no longer gets stuck forever when an old date
  is unavailable for a newly launched tariff. It retries three times, skips
  that date, and lets other regions continue. Unknown Cron expressions are
  ignored rather than accidentally running price and alert work.
- A cache waiting for its next background refresh now says exactly that,
  instead of incorrectly saying more historical prices need to be collected.
- **Notifications now actually arrive.** No notification of any kind had ever
  been sent in production. Octopus publishes a day only up to about 23:00
  local and delivers the remainder later, so a day never reached the
  "complete" state that both the daily summary and every price alert were
  waiting for. Publication now triggers on having enough of the day — an
  unbroken 22 hours from midnight — while the interface keeps reporting
  completeness honestly. Test notifications always worked because they bypass
  this path entirely, which is why the fault was invisible.
- Days that arrive in parts are now filled in as the rest turns up, instead of
  being abandoned two periods short for good.

### Added

- **"Starting soon" alerts.** About fifteen minutes before a stretch matching
  one of your rules begins, so there is time to put the washing on. Published
  prices still give advance notice the day before; this is the reminder in the
  moment. Checked every five minutes, all day, from stored prices only.
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
