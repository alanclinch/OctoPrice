# Octopus Agile Price Notifier

> This is the original project specification. It is the reference for *what*
> the application should do and why. Where the implementation has since made a
> more specific decision, that decision is recorded in `AI_HANDOFF.md` under
> "Important Decisions" and in `docs/`. Inline research citations from the
> original draft have been collected into the References section at the end.

## 1. Purpose

Create a simple, reliable application for monitoring Octopus Energy Agile
electricity prices and notifying users when:

1. The following day's Agile prices become available.
2. One or more half-hour periods meet a user-defined price condition.
3. Negative pricing occurs.
4. Particularly cheap periods occur, for example electricity at or below 7p/kWh.

The application should make it extremely easy for a user to see:

- The current electricity price.
- Today's remaining prices.
- Tomorrow's prices once published.
- The cheapest periods.
- Any periods matching their configured alerts.

The application should initially focus on Octopus Agile import pricing but be
designed so that additional Octopus tariffs or export pricing can be added
later without redesigning the application.

---

## 2. Recommended Application Type

### 2.1 Progressive Web App

The preferred implementation is a **responsive Progressive Web App (PWA)**
backed by a small server-side application.

This provides:

- A normal website accessible from any browser.
- Excellent mobile usability.
- Ability to install it on Android as an app.
- Push notifications.
- No requirement to publish through the Google Play Store.
- One codebase for desktop and mobile.
- Easy development using Claude and Codex/ChatGPT.
- Straightforward deployment and version control.

The interface should be designed mobile-first.

### 2.2 Server-Side Component

Price checking must **not depend on the user's phone or browser being open**.

A backend worker/scheduler will:

1. Contact the Octopus API.
2. Detect publication of new prices.
3. Store those prices.
4. Evaluate notification rules.
5. Send notifications.

This is important because browser timers and background execution cannot be
relied upon for something expected to run every day.

---

## 3. Octopus Energy Data Source

The application should use the official Octopus Energy API.

Base API: `https://api.octopus.energy/v1/`

Octopus provides specific endpoints for products, tariffs and Agile half-hour
electricity prices.

The standard unit rates endpoint returns records containing:

- VAT-exclusive price.
- VAT-inclusive price.
- Valid-from timestamp.
- Valid-to timestamp.

The application should normally use the **VAT-inclusive price
(`value_inc_vat`)** because this corresponds most closely to the price
consumers actually pay.

Where possible the application should automatically determine the appropriate
current Agile product and tariff rather than permanently hard-coding a product
code.

---

## 4. Regional Pricing

Agile prices differ according to the user's electricity distribution region.
The application must therefore support Octopus regional tariff codes.

During initial setup the user should be able to either:

- Select their region.
- Enter their Octopus details and allow the application to determine their
  tariff automatically.

For an initial personal-use MVP, manually selecting the region is acceptable
and avoids requiring Octopus account credentials.

A later version can optionally use:

- Octopus API key.
- Octopus account number.

to automatically identify the active electricity tariff. Public product and
price information does not require the same authenticated account access as
customer-specific account information.

---

## 5. Daily Price Retrieval

### 5.1 Publication Behaviour

Do **not** assume prices will always appear at exactly 16:00 or 16:05.

Octopus states that Agile prices for the following day are normally published
near 16:00 but can be published considerably later. Current Octopus terms
describe a usual publication window of approximately 16:00 to 22:00.

Therefore the application should implement publication detection rather than
relying on one API request.

### 5.2 Daily Polling

Suggested workflow:

**16:05 local UK time** — start checking for the following day's prices.

If they are unavailable:

- Retry at 16:10.
- Continue every five minutes.

When the complete expected set of rates becomes available:

1. Validate the dataset.
2. Save it.
3. Mark that pricing date as successfully retrieved.
4. Stop polling.
5. Evaluate notification rules.
6. Send the daily price notification.

Polling should have sensible retry/backoff behaviour if the API itself is
unavailable. The system should continue trying until an appropriate cutoff,
initially 22:15. Errors must be logged rather than silently ignored.

---

## 6. Daily Price Notification

Once tomorrow's complete prices have been retrieved, send a notification.

Example:

> **Tomorrow's Octopus Agile prices are available**
>
> Cheapest: **3.2p/kWh at 02:30**
> Most expensive: **31.4p/kWh at 17:30**
> Average: **16.8p/kWh**
>
> **6 periods below your 7p alert**

Opening the notification should take the user directly to tomorrow's price
screen. The user should be able to enable or disable this daily notification
independently from price alerts.

---

## 7. Price Alert Rules

This is a core feature. A user should be able to create one or more alert
rules. Examples:

### Negative electricity

`Price < 0p`

### Cheap electricity

`Price <= 7p`

### Very cheap electricity

`Price <= 3p`

Rules should not be hard-coded.

---

## 8. Alert Rule Model

Each rule should contain:

- Rule ID.
- Friendly name.
- Enabled/disabled state.
- Price threshold.
- Comparison operator.
- Optional time restriction.
- Optional minimum number of matching periods.
- Notification enabled.
- Created date.
- Last triggered date.

Supported operators should initially include:

- Less than.
- Less than or equal to.
- Greater than.
- Greater than or equal to.

For example: `Price <= 7p/kWh`

---

## 9. Consecutive Cheap Periods

A particularly useful enhancement should be included early in development.
Allow rules such as:

> Alert me when electricity is below 7p for at least 2 hours.

Since Agile uses 30-minute periods, this means finding four consecutive
qualifying periods.

Examples:

- 30 minutes below 0p.
- 1 hour below 5p.
- 2 hours below 7p.
- 4 hours below 10p.

This would be useful for EV charging, dishwashers, washing machines, tumble
dryers, battery charging and electric heating.

---

## 10. Cheapest Window Calculator

The application should eventually allow the user to ask:

> Find the cheapest continuous 3-hour period tomorrow.

The application evaluates all possible consecutive combinations and returns
the lowest-cost period.

Example:

> **Cheapest 3-hour period**
> 01:30 – 04:30
> Average price: **4.6p/kWh**

This feature is demonstrated in some existing Octopus applications and would
be valuable without making the core application unnecessarily complicated.

---

## 11. Notification System

### Initial notification method

The preferred built-in method is **Web Push notifications**. This allows the
installed PWA to behave much like a native Android application.

Notifications should work while the application is closed. Each device must
register its own push subscription. A user should therefore be able to receive
notifications on phone, tablet and PC.

Future notification providers could include Telegram, email, Discord, ntfy,
Pushover and Home Assistant.

Notification delivery should be implemented behind a provider interface so new
notification methods can be added without rewriting the price-monitoring
engine.

---

## 12. Main Dashboard

The main screen should be extremely simple.

**Current price** — large display:

> **NOW**
> ### 12.4p/kWh
> Until 17:30 · then 18.9p

The following price is shown inline in its price-band colour rather than in a
second row.

**Published range** — one chronological timeline spanning today and tomorrow,
with the current period first by default. Show the exact count when tomorrow
is only partially published rather than repeating a vague waiting message.

First use must ask for the user's electricity area before showing prices. The
header should name the area as well as the underlying region code and provide
an obvious PWA installation action.

Tomorrow's publication state, the cheapest continuous window and the price
chart share one compact secondary card. The window and chart are collapsed by
default, expand in place, and remember whether the user left either tool open.

---

## 13. Price Chart

Display half-hourly prices visually. The chart should:

- Show time horizontally.
- Show p/kWh vertically.
- Clearly display negative prices.
- Highlight cheap periods.
- Highlight expensive periods.
- Make the current period obvious.
- Allow tapping a bar/point to see the exact price.

Do not overcomplicate the visual design. The chart should remain easy to
understand on a phone. It is an optional expansion on the dashboard; the
half-hour price table remains the main detailed view.

---

## 14. Price Table

Users should also be able to view a straightforward list.

The list combines all stored days, inserts clear date separators, and hides
elapsed periods by default. A working **Remaining only** control lets the user
restore past prices.

| Time        | Price |
| ----------- | ----: |
| 00:00–00:30 |  9.4p |
| 00:30–01:00 |  7.1p |
| 01:00–01:30 |  4.8p |
| 01:30–02:00 | -1.2p |
| 02:00–02:30 | -3.6p |

Negative periods should be immediately obvious.

---

## 15. Settings

Settings should initially include:

**Tariff** — Octopus Agile, region.

**Notifications** — new prices published, price alerts, notification test.

**Alert rules** — create, edit and delete rules.

**Display** — pence/kWh, 12-hour or 24-hour time, dark/light/system theme.

UK time should be the default.

---

## 16. Time Handling

Internally all dates and times should be stored in UTC. Display times should
use `Europe/London`.

The application must correctly handle:

- GMT.
- BST.
- Daylight-saving transitions.
- Days containing 46 or 50 half-hour periods instead of the normal 48.

This must be covered by automated tests.

The Octopus documentation specifically recommends using UTC ISO-8601
timestamps when requesting prices to avoid daylight-saving errors.

---

## 17. Suggested Technical Architecture

```text
                    Octopus Energy API
                            │
                            ▼
                   Price Retrieval Worker
                            │
                            ▼
                       Price Database
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
         Alert Rule Engine           Web API
                │                       │
                ▼                       ▼
        Notification Service       PWA Frontend
                │
                ▼
         User's devices
```

---

## 18. Suggested Technology

The exact framework may be reviewed before implementation, but the preferred
technology is:

**Language** — TypeScript throughout where practical, so frontend and backend
share models and validation.

**Frontend** — React, TypeScript, PWA support, responsive CSS. A framework
such as Next.js may be used if server and frontend integration makes
deployment simpler.

**Backend** — TypeScript on Cloudflare Workers in production and Node.js for
local development, responsible for Octopus API integration, scheduling, price
persistence, rule evaluation and notification sending.

**Database** — Cloudflare D1 in production and SQLite for local development.
Both implement the same domain-level storage interface.

---

## 19. Data Model

Minimum entities:

**Price**

```text
id
tariff_code
region
valid_from
valid_to
price_inc_vat
price_exc_vat
retrieved_at
```

Unique constraint: `tariff_code + valid_from`

**AlertRule**

```text
id
user_id
name
enabled
comparison_operator
price_threshold
minimum_duration_minutes
time_start
time_end
created_at
updated_at
```

**NotificationSubscription**

```text
id
user_id
provider
subscription_data
enabled
created_at
last_success
last_failure
```

**NotificationLog**

```text
id
user_id
rule_id
type
message
created_at
status
```

---

## 20. Duplicate Notification Prevention

Notifications must be idempotent. The same rule must not repeatedly notify the
user every time the worker checks prices.

Generate a unique notification key based on information such as:

```text
user
rule
pricing_date
matching_period
```

Store successfully sent notifications. Before sending anything, check whether
that notification has already been sent.

---

## 21. Reliability

The application should be designed to handle:

- Octopus API temporarily unavailable.
- Partial tomorrow pricing data.
- Duplicate API results.
- Delayed publication.
- Network timeout.
- Notification provider failure.
- Application restart.
- Server restart.

A server restart must not cause duplicate notifications.

---

## 22. Existing Open-Source Projects

Existing projects should be reviewed for ideas but should **not simply be
copied**.

One particularly relevant project is **Octogram**, which retrieves Octopus
Agile prices, uses configurable price thresholds, detects zero/negative
periods, sends Telegram notifications and automatically discovers the user's
active tariff.

Another useful reference is **Agile Rates**, which already implements the
current rate, price forecasts, negative pricing, region selection, multiple
Octopus tariffs and cheapest continuous time-window calculation.

These repositories should be examined during implementation for ideas, API
behaviour and edge cases. Their licences must be checked before reusing any
actual source code.

---

## 23. Git Repository

The entire project must live in Git from the beginning. GitHub is the
preferred remote repository. `main` should always represent a working build.

Development should take place using branches:

```text
main
feature/price-api
feature/notifications
feature/dashboard
fix/dst-price-slots
```

Claude and Codex should not normally make unrelated changes directly on
`main`.

---

## 24. Automatic Git Maintenance

The project must be designed so that development history is not dependent on
remembering to manually maintain documentation.

After meaningful development work:

1. Tests run.
2. Documentation/state files are updated.
3. Changes are committed.
4. The development branch is pushed to GitHub.

CI should validate at minimum: type checking, linting, unit tests, build, and
formatting where appropriate. Pull requests should not be merged when these
checks fail.

Where practical, project-state metadata can be generated automatically from
Git rather than manually duplicated.

---

## 25. AI-Assisted Development

The project is expected to be developed using both Claude / Claude Code and
ChatGPT Codex.

Neither agent should assume it is the only agent working on the project. The
repository therefore requires explicit coordination files.

---

## 26. Required AI Instruction Files

The repository must contain:

```text
CLAUDE.md
AGENTS.md
AI_HANDOFF.md
```

These files should be created during initial repository setup. They are **not
part of this specification document itself**.

---

## 27. CLAUDE.md

`CLAUDE.md` contains instructions specifically for Claude Code, describing
project purpose, architecture, coding conventions, test requirements, Git
workflow, security requirements, files that must not contain secrets, and how
to use `AI_HANDOFF.md` — including the requirement to read it before beginning
work, update it before ending work, and check changes made by another agent
since its previous session.

Claude should be explicitly told:

> Do not assume previous Claude context is current. Git and AI_HANDOFF.md are
> the source of truth.

---

## 28. AGENTS.md

`AGENTS.md` provides equivalent repository instructions for Codex/ChatGPT
coding agents: project architecture, repository structure, build commands,
test commands, coding standards, Git rules, security requirements,
current source-of-truth documents, and instructions for reading and updating
`AI_HANDOFF.md`.

Codex should likewise be explicitly told:

> Do not rely on conversation history as the current state of the project.
> Inspect the repository and AI_HANDOFF.md first.

---

## 29. AI_HANDOFF.md

`AI_HANDOFF.md` is the coordination layer between Claude and Codex. It is
deliberately **agent-neutral**. Neither Claude nor Codex owns this file. Both
must read and maintain it.

Its purpose is to answer:

> What state did the other developer leave the project in?

---

## 30. AI_HANDOFF.md Structure

```markdown
# AI Development Handoff

## Current State

Current version:
Current branch:
Last known good commit:
Build status:
Test status:

## Current Architecture

Short description of the current implementation.

## Completed

- Item

## Currently In Progress

- Task
- Responsible agent
- Branch

## Next Recommended Work

1. Task

## Known Problems

- Problem

## Important Decisions

### YYYY-MM-DD — Decision

Decision:
Reason:
Alternatives considered:

## Recent Agent Handoffs

### YYYY-MM-DD HH:MM — Claude

Work completed:
Files changed:
Tests run:
Outstanding issues:
Suggested next action:
```

---

## 31. Claude/Codex Handoff Protocol

At the **start of every coding session**, an agent must:

1. Fetch the latest Git state.
2. Confirm its branch.
3. Read `CLAUDE.md` or `AGENTS.md`.
4. Read `AI_HANDOFF.md`.
5. Inspect recent Git commits.
6. Confirm the actual code matches the handoff.
7. Check whether another agent has unfinished work.

Before finishing, the agent must:

1. Run relevant tests.
2. Run lint/type checks.
3. Update documentation if architecture or behaviour changed.
4. Update `AI_HANDOFF.md`.
5. Record outstanding problems.
6. Record what should happen next.
7. Commit the work.
8. Push the branch to GitHub.

This means Claude could finish work at night and Codex could start the next
morning without needing Claude's conversation history.

---

## 32. Preventing Claude and Codex Conflicts

Agents should use separate branches when working concurrently:

```text
claude/notification-engine
codex/price-dashboard
```

`AI_HANDOFF.md` should identify active work. Agents should avoid modifying
files belonging to another actively developed feature unless deliberately
integrating it.

Before merging work:

```text
git fetch
git rebase/merge latest main
run tests
review diff
merge
```

---

## 33. Documentation

Recommended repository documentation:

```text
README.md
DESIGN.md
CLAUDE.md
AGENTS.md
AI_HANDOFF.md
CHANGELOG.md
docs/
    architecture.md
    octopus-api.md
    notifications.md
    deployment.md
```

`DESIGN.md` should initially contain this specification. README should
concentrate on what the application does, an interface overview, installation,
configuration, running locally and deployment. Detailed architecture belongs
in `/docs`.

---

## 34. Documentation Synchronisation

Agents must update documentation when implementation changes make existing
documentation inaccurate. CI should eventually contain a documentation
consistency check where practical.

Generated information such as application version, build number and commit
hash should be generated from Git rather than manually maintained in multiple
files.

---

## 35. Secrets

Never commit Octopus API keys, account numbers, push notification private
keys, database passwords or hosting credentials.

Use environment variables. Provide `.env.example`:

```text
DATABASE_URL=
OCTOPUS_API_KEY=
OCTOPUS_ACCOUNT_NUMBER=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

Real `.env` files must be included in `.gitignore`.

---

## 36. Testing

The project should contain automated tests from the beginning.

**API** — parse normal Octopus response, negative price, zero price, missing
price, duplicate price, partial day's prices.

**Rules** — `< 0`, `<= 7`, `>= 30`, multiple matching periods,
consecutive-period detection, rule disabled.

**Notifications** — correct message, no duplicate notification, failed
notification can retry.

**Dates** — GMT, BST, DST starts, DST ends, 46-period day, 48-period day,
50-period day.

---

## 37. Observability

Include structured application logging. Important events should include:

```text
PRICE_CHECK_STARTED
PRICE_DATA_NOT_READY
PRICE_DATA_COMPLETE
RULE_MATCH
NOTIFICATION_SENT
NOTIFICATION_FAILED
OCTOPUS_API_ERROR
```

Do not log credentials or secret notification subscription information.

A simple admin/status page should eventually display the last Octopus check,
last successful price retrieval, tomorrow pricing status, number of stored
prices, last notification and application version.

---

## 38. MVP

The first genuinely usable release should contain only:

1. Responsive PWA.
2. Octopus Agile region selection.
3. Automatic Agile price retrieval.
4. Today's prices.
5. Tomorrow's prices.
6. Current price.
7. Price chart.
8. Notification when tomorrow's prices become available.
9. User-configurable price threshold.
10. Negative-price alerts.
11. Push notification support.
12. Persistent configuration.
13. Duplicate-notification protection.
14. GitHub repository.
15. CI tests.
16. `CLAUDE.md`.
17. `AGENTS.md`.
18. `AI_HANDOFF.md`.

Anything beyond this should not delay the first working release.

---

## 39. Phase Two

Possible additions: multiple alert rules, minimum cheap duration, cheapest
continuous period, Telegram notifications, Home Assistant integration, EV
charging optimisation, battery charging recommendations, Octopus account
auto-detection, other Octopus tariffs, Agile Outgoing, historical price
charts, price statistics, installable Android experience improvements and
multiple users.

---

## 40. Future Automation

The application architecture should allow later rules such as:

> Tell me if there are at least two consecutive hours below 5p.
> Tell me if electricity goes negative tomorrow.
> Find the cheapest four hours to charge the car.
> Tell me if tomorrow's average price is below 12p.
> Tell me if any period exceeds 40p.

These should ultimately use the same generic rules engine rather than separate
hard-coded features.

---

## 41. Design Principle

The application should remain simple. Its primary job is:

**Get tomorrow's Octopus prices reliably, identify interesting periods, and
tell the user about them.**

Do not turn the first release into a general-purpose home-energy management
platform. The architecture should permit expansion, but the interface should
remain focused on prices and alerts.

---

## 42. Initial Development Sequence

1. Create GitHub repository.
2. Add this document as `DESIGN.md`.
3. Create `README.md`.
4. Create `CLAUDE.md`.
5. Create `AGENTS.md`.
6. Create `AI_HANDOFF.md`.
7. Establish branch/commit rules.
8. Scaffold application.
9. Implement Octopus API client.
10. Implement regional/tariff handling.
11. Store price data.
12. Implement scheduler.
13. Detect completed tomorrow dataset.
14. Build price-rule engine.
15. Build tests.
16. Build basic mobile dashboard.
17. Add price chart.
18. Implement push notifications.
19. Add settings/rule management.
20. Deploy test instance.
21. Test several days of real Octopus publication behaviour.
22. Release MVP.

The Octopus API integration and rule engine should be completed before
spending significant development time on visual polish.

---

## References

Sources consulted while drafting this specification. These replace the inline
citation markers in the original document.

- Octopus Energy REST API documentation — <https://developer.octopus.energy/rest/>
- Octopus Energy Agile tariff terms, including the publication window for
  next-day prices — <https://octopus.energy/smart/agile/>
- Octogram, a Telegram notifier for Agile prices with configurable thresholds
  and automatic tariff discovery.
- Agile Rates, which implements current rate display, negative pricing,
  region selection and cheapest-window calculation.

Licences of any referenced project must be checked before reusing source code.
