# Agile price forecasting — research and proposed architecture

**Status: research and design, plus an implemented input archive (section 8)
and experimental seasonal-naive baseline (section 9).**

This document covers stages 1–4 of the staged plan in the feature request:
review prior art, investigate data sources, propose an architecture, and
establish what fits the existing Cloudflare free-tier deployment. It exists so
that the design and its reasoning are on record before any substantial code is
written.

Everything marked **verified** was tested against the live API on 2026-08-27
from this repository. Everything else is proposal or secondary reading.

The headline measurements are reproducible rather than narrative. See
`docs/research/`:

| Script | Reproduces |
| ------ | ---------- |
| `fit-regional-coefficients.mjs` | Finding 1.1, and warns if the relationship stops being exact |
| `bench-inference.mjs` | The Worker CPU budget table in section 4.6 |

Each records its own product codes, date ranges, VAT treatment, alignment and
regression method, so a later reader can disagree with the method rather than
having to trust a number in prose.

---

## 1. The two findings that should shape the design

Two experiments produced results specific enough to change the architecture,
so they come first.

### 1.1 Regions are exact linear transforms of one another

Agile prices in every region are the same series, scaled and shifted. Fitting
each region against region C over 30 days (1441 half-hour periods), splitting
peak from off-peak:

| Region | Period   | Slope  | Intercept | Worst error |
| ------ | -------- | ------ | --------- | ----------- |
| N      | off-peak | 1.0500 | +0.1671   | 0.009p      |
| N      | peak     | 1.0501 | +0.5649   | 0.009p      |
| P      | off-peak | 1.2000 | +0.6676   | 0.008p      |
| P      | peak     | 1.2000 | −1.7314   | 0.008p      |
| L      | off-peak | 1.1500 | +0.5011   | 0.010p      |
| L      | peak     | 1.1500 | −2.2974   | 0.010p      |

R² is 1.000000 to six decimal places. The worst error of ~0.01p is the
rounding in the published figures. The relationship holds through the 23
negative-price periods and a 65p spike in the sample, and the slopes are
clean deliberate numbers (1.05, 1.15, 1.20).

Several regions share coefficients exactly — E, F, G and H are one group, J
and K another — so there are fewer distinct pricing groups than regions.

**Consequence:** the regional problem is solved and is not a modelling
problem. Forecast **one reference region** and map it to the other thirteen
with two coefficient pairs each. No per-region model, no per-region error.

AgilePredict reaches the same conclusion (see section 2) — this is not a novel
architecture. What the measurement adds is that the coefficients can be
*derived from Octopus's own published prices* rather than hardcoded: exact
rather than rounded, self-updating, and with a fit statistic that acts as a
health check. If Octopus changes its methodology, R² collapses and we know.

### 1.2 Elexon's market index price is not the Agile input

The obvious free shortcut is Elexon's MID dataset (half-hourly GB market
index price, no API key). It is not the right series. Fitting region N Agile
against MID over six days:

| Window   | Fit                                    | R²   | MAE   |
| -------- | -------------------------------------- | ---- | ----- |
| Off-peak | `agile = 0.967 × wholesale + 13.29`    | 0.70 | 1.96p |
| Peak     | `agile = 1.041 × wholesale + 26.63`    | 0.56 | 2.04p |

R² of 0.70 is far too loose for a relationship that should be arithmetic.
MID is the *within-day market index* used for imbalance settlement; Agile is
set from the **EPEX Spot half-hourly day-ahead auction**, which is a different
series.

The fit is not useless — the gap between the two intercepts (26.63 − 13.29 =
13.34p ex-VAT) recovers the documented 4–7pm peak adder of 11–14p, which
corroborates the formula's shape. But MID cannot be used as the wholesale
input.

**Consequence:** a genuinely forward-looking wholesale price needs ENTSO-E or
another day-ahead source, or the model must predict the auction outcome from
fundamentals. Do not build on MID.

---

## 2. Prior art: AgilePredict

<https://github.com/fboundy/agile_predict> — **MIT licensed**, Python/Django,
actively maintained (last push 2026-08-27). MIT means its code may be reused
with attribution, which `DESIGN.md` section 22 requires checking before any
reuse.

- **Data:** Elexon (nuclear availability, demand), NESO (wind, solar, embedded
  wind and demand, daily operating margin reserve), ENTSO-E (French nuclear as
  an interconnector signal — *not* GB prices), Open-Meteo (UK and French
  weather, forecast plus ensemble), Nord Pool (**GB60 hourly day-ahead
  prices**), Yahoo Finance (TTF gas futures), Octopus (Agile actuals).
- **Models:** a three-model ensemble — CatBoost, LightGBM and ExtraTrees —
  on a rolling 90-day window of half-hourly data, with samples weighted by
  linear z-score so spikes and negative prices are prioritised.
- **Features:** a fixed base (UK generation mix, demand, NESO operating margin
  reserve surplus, calendar flags) plus an experimentally selected optional set
  (currently French wind and radiation).
- **Uncertainty:** intervals derived empirically from holdout residuals binned
  by horizon, *and* from Open-Meteo ensemble weather perturbations.
- **Explainability:** SHAP contributions per half-hour slot, surfaced in the UI
  as "why this price?".
- **Horizon:** up to 14 days, all regions A–P plus a national aggregate.

### It already does the thing described in 1.1

This is worth stating plainly because an earlier draft of this document got it
wrong. AgilePredict does **not** model each region separately. It predicts a
single day-ahead wholesale series and converts to each region with a linear
`(multiplier, peak_adder)` pair, peak being 16:00–19:00 local — the same shape
as finding 1.1, arrived at independently.

Its coefficients live in `config/settings.py` as hardcoded configuration,
rounded to two decimal places, in £/MWh units:

| Region | multiplier | peak adder |
| ------ | ---------- | ---------- |
| A      | 0.21       | 13         |
| B      | 0.20       | 14         |
| C      | 0.20       | 12         |
| D      | 0.22       | 13         |
| E      | 0.21       | 11         |

So the architectural contribution of 1.1 is **not** the idea of converting
rather than modelling — that is prior art. It is two narrower things:

1. **Deriving the coefficients from Octopus's published prices instead of
   hardcoding them**, which is exact rather than rounded, updates itself, and
   yields a fit statistic that detects a methodology change. Hardcoded factors
   are precisely the fragility to avoid: the values above correspond to the
   2020-era formula, and April 2026 brought a flat −3.5p/kWh change to Agile.
2. **Mapping Agile-to-Agile** rather than wholesale-to-Agile, which means a
   reference region's *confirmed* prices can drive the other thirteen without
   any wholesale price at all.

**A derived value is never a confirmed price.** The transform is exact to
0.01p, which makes it tempting to show a mapped region as official. It must
not be. Confirmed prices come from the Octopus API for that region and nowhere
else; a mapped value is a forecast and is labelled as one, however small its
error. The mapping exists to produce forecast output, to check coefficient
health, and to avoid modelling fourteen series — not to fill gaps in the
confirmed-price path.

**What else to take:** weighting extreme observations during training, and
deriving intervals from weather ensembles as well as historical residuals.

**What not to take:** the stack. It is a Django service with a Python training
pipeline, deployed on fly.io. This application is a Cloudflare Worker with D1
and a hard preference for the free tier.

## 3. Data sources

### Verified working, no API key

Tested from this repository on 2026-08-27.

| Source | Endpoint | Gives us |
| ------ | -------- | -------- |
| Elexon BMRS | `/forecast/demand/day-ahead` | National demand forecast (NDF/TSDF) by settlement period |
| Elexon BMRS | `/forecast/generation/wind` | Wind generation forecast (WINDFOR) |
| Elexon BMRS | `/generation/outturn/summary` | Actual generation by fuel type, half-hourly |
| Elexon BMRS | `/forecast/surplus/daily` | Daily surplus/margin forecast (OCNMFD), several days ahead |
| Elexon BMRS | `/balancing/pricing/market-index` | Half-hourly market index price — **training/history only, see 1.2** |
| NESO | `datastore_search` (resource `db6c038f…`) | Embedded wind and solar forecast, 14 days |
| Open-Meteo | `/v1/forecast` | Wind speed at 100m, shortwave radiation, temperature, 3+ days |
| Carbon Intensity (National Grid) | `/intensity/{from}/fw48h` | National carbon intensity forecast, 48h |
| Carbon Intensity (National Grid) | `/regional/intensity/{from}/fw48h/regionid/{id}` | **Forecast generation mix by fuel, 48h, per DNO region** |
| Octopus | existing client | Confirmed Agile prices and history, all regions |

All returned JSON over plain HTTPS with no authentication, which means all of
them are reachable from a Worker with no secret management.

**The Carbon Intensity API deserves separate mention.** It was found by looking
at what a shipped app credits (see section 5), not by searching, and it is
arguably the most useful source on the list:

- It forecasts **48 hours ahead**, which is most of the target horizon.
- It gives **generation mix by fuel** — gas, wind, solar, nuclear, imports,
  biomass — rather than raw inputs. Gas share matters because gas usually sets
  the marginal GB price, so this is close to being a price driver already.
- Its regions are **DNO regions** (`regionid` 2 returns "SP Distribution /
  South Scotland"), the same structure Agile uses — though see the warning
  below, because that resemblance is misleading for pricing.
- It is National Grid's own modelled forecast, meaning the demand, wind and
  solar forecasting has already been done and reconciled by someone with
  better data than us.

The caveat matches NESO's: the response carries no issue time, so **vintages
cannot be retrieved after the fact** and it must be archived live from the
start (section 3a).

**Use the national mix, not the regional mix, as a price feature.** The
matching geography is a trap. Finding 1.1 shows Agile's regional differences
are a fixed retail transform of one GB-wide series — so there is no regional
*price* signal to find, and regional carbon data cannot supply one. DNO carbon
regions model local generation, consumption and power flows, which is a
different question. Regional mix is good **user context** ("your electricity
is mostly wind right now"); it is not a pricing input, and treating it as one
would reintroduce the per-region modelling that 1.1 makes unnecessary.

Note also that **gas generation share is not a substitute for the gas
commodity price**. A high gas share when gas is cheap and a high gas share
when gas is expensive are very different price environments, and the share
alone cannot distinguish them. It is a useful feature; it does not close the
gap left by having no licensed gas price source.

### Terms of use, which must be designed for before collection starts

The API is CC BY 4.0, with additional terms that carry real obligations. From
the published terms:

| Obligation | What it means here |
| ---------- | ------------------ |
| CC BY 4.0 attribution | Credit National Energy System Operator wherever the data or anything derived from it is shown. Octopus Watch's footer is a reasonable model. |
| "Conceal your identity or your application's identity" is prohibited | Send a descriptive `User-Agent` identifying this application and a contact. The Worker currently sends none. |
| Rate limited; may block heavy callers | Poll at a documented, modest rate. Archiving needs roughly one call per region per run, not continuous polling. |
| Must not "substantially replace the core user experience" of NESO's sites or the API | We use it as a forecasting feature and as optional context inside a price app. Do not build a carbon-intensity product on it. |
| Must not imply endorsement | Attribution must read as credit, not partnership. Their word mark and logo need prior written approval — so use plain text. |
| May be changed, suspended or discontinued without notice, as-is, no warranty | Section 4.7 already requires graceful degradation; this makes it contractual as well as sensible. |

Retention of collected observations for model training is compatible with
CC BY provided attribution travels with anything published from it. These
decisions should be written down before the archive starts, not after.

### Requires registration

- **ENTSO-E Transparency Platform** — publishes GB day-ahead prices,
  cross-border flows and French nuclear availability. Free but needs an API
  token, which would be a Worker secret. Still the most valuable unverified
  source, but note that AgilePredict uses ENTSO-E only for *French nuclear*
  and takes GB day-ahead from Nord Pool instead. Whether ENTSO-E's GB
  day-ahead series is complete and timely enough to replace a licence-
  restricted feed is exactly what needs testing.

### Investigated and rejected or deferred

- **Nord Pool** — GB60 hourly day-ahead prices, and what AgilePredict
  actually uses for the GB forward price. Redistribution is licence-restricted,
  so it is not appropriate for a public deployment without checking terms;
  AgilePredict being MIT does not license the *data*. Note the series is
  hourly, while Agile is set from a half-hourly auction.
- **Yahoo Finance (TTF gas futures)** — AgilePredict uses it; it is not a
  licensed data feed and scraping it is fragile. Gas prices matter because gas
  usually sets the marginal GB price, so this is worth revisiting with a
  proper source, but not on an unofficial endpoint.
- **EPEX Spot direct** — the actual auction Agile derives from. Commercial.

### The awkward timing fact

Agile prices come from the EPEX half-hourly day-ahead auction that clears at
**15:45 local**, and Octopus publishes at about **16:00**. The window between
the auction result existing and the official prices appearing is roughly
fifteen minutes.

This matters: there is no long period in which the answer is knowable but
unpublished. Forecasting tomorrow is therefore genuine forecasting from
fundamentals, not arithmetic on an already-known auction result. The earlier
hourly day-ahead auction (~11:00) is a strong correlate and worth testing as a
same-day anchor, but it is hourly, not half-hourly.

---

## 3a. Data vintage: can back-tests be made leak-free?

Grid and weather forecasts are *revised* after publication. Training or
validating against the latest stored value would let the model see information
that did not exist at forecast time, making measured accuracy better than
anything achievable live. This is the difference between a back-test that
means something and one that flatters.

So the question is whether each source can be asked what it *said at the
time*. Tested 2026-08-27:

| Source | Vintage available? | How |
| ------ | ------------------ | --- |
| Elexon wind forecast | **Yes** | `/forecast/generation/wind/history?publishTime=…` returns the forecast as it stood |
| Elexon day-ahead demand | **Yes** | `/forecast/demand/day-ahead/history?publishTime=…` |
| Elexon (any dataset) | **Yes** | `/datasets/{name}?publishDateTimeFrom=…&publishDateTimeTo=…` |
| Open-Meteo | **Yes** | `historical-forecast-api.open-meteo.com` serves past forecast runs |
| NESO embedded wind/solar | **Yes** | Annual forecast archives carry `Forecast_Datetime` per issue — see below |

**An earlier version of this section was wrong about NESO**, and the input
archive was partly built on that error. NESO's *rolling* feed carries no issue
time, which is what was checked. But NESO also publishes **annual half-hourly
forecast archives** with a `Forecast_Datetime` for every issue of every 0–14
day forecast:

| Resource | Period | Rows |
| -------- | ------ | ---- |
| `d6375700-69c2-4c25-8bde-883a205d742e` | Jan–Jun 2026 | ~2.43 M |
| `31861619-0b86-47ba-bac2-d008a760af54` | Jun–Dec 2026 | ~1.13 M |

The second was current to within an hour when checked, so it serves live use
as well as history. `docs/research/neso-forecast-vintages.mjs` demonstrates
it: hourly issues for a single settlement period, with the estimate visibly
revising as the day approaches.

**Consequence:** only the **Carbon Intensity API** genuinely needs live
collection. NESO can be back-filled, including for periods before this
application existed, which is strictly better than anything we could have
recorded. The live NESO collector was removed rather than kept as a worse
duplicate.

### The NESO period timestamp, which has been wrong twice

`TIME_GMT` is the settlement period **end**, and `DATE_GMT` supplies only the
date (rendered inconsistently — sometimes midnight, sometimes carrying the
period time). Settlement period 27 on 25 August 2026 appears as
`TIME_GMT: "12:30"`; BST makes SP27 13:00–13:30 local, which is 12:00–12:30
UTC, so the period **starts at 12:00**.

Two mistakes were made here in succession: first reading `DATE_GMT` alone,
which put all 48 periods of a day on midnight; then combining the fields but
keeping the end instant, leaving every row half an hour late. Both reached
production. `nesoArchivePeriodStart` and its tests exist so that whoever
writes the back-test reader does not discover this a third time.

Every stored observation should record both the source's own issue time and
our collection time. They are different facts and only the first prevents
leakage.

## 4. Proposed architecture

### 4.1 Shape

```text
Cron (a few times a day)
  |
  v
Collectors ---> D1: forecast_inputs        (raw observations, kept)
  |
  v
Reference-region model  --->  D1: forecasts (every run, never overwritten)
  |                                  |
  v                                  v
Regional mapping (1.1)          Validation job ---> D1: forecast_accuracy
  |
  v
API / UI / notifications, clearly labelled as forecast
```

### 4.2 Model: start deliberately simple

The feature request asks whether AgilePredict's complexity is justified. The
proposal is to **establish a baseline first and only add complexity that
measurably beats it**, because without a baseline there is no way to tell.

Three tiers, in order:

1. **Seasonal-naive baseline.** Predict each settlement period from recent
   values of the same period on similar days. Costs nothing, runs anywhere,
   and is the number every later model must beat. Publishing an MAE for this
   is the honest starting point.
2. **Regularised linear model on fundamentals.** Features: wind forecast,
   demand forecast, margin surplus, residual demand (demand − wind − solar),
   settlement period, day of week, and recent price level. Trained offline,
   exported as coefficients, evaluated in the Worker in microseconds.
3. **Gradient-boosted trees**, only if tiers 1–2 prove insufficient. A trained
   LightGBM/CatBoost model exports to JSON and tree traversal is a few dozen
   lines of TypeScript, so inference stays in the Worker; only *training*
   needs Python.

Negative prices and spikes are the events that matter most to an Agile
customer and are exactly where a squared-error model performs worst. Two
mitigations to test: weighting extreme observations during training (as
AgilePredict does), and predicting **quantiles** rather than a point estimate,
which gives the uncertainty range the feature request asks for as a direct
output rather than an afterthought.

### 4.3 Confidence

The request is explicit that confidence must not be invented. Two defensible
options, in preference order:

1. **Quantile regression.** Predict the 10th, 50th and 90th percentiles
   directly. The published range is then a real interval from the model, and
   "expected range 1.8–5.1p" means something specific.
2. **Empirical error bands.** Once enough forecast/actual pairs exist, derive
   intervals from the model's own historical error at that horizon and that
   time of day.
3. **Propagated weather uncertainty.** Open-Meteo publishes ensemble members;
   running the model over several of them gives a spread that reflects how
   uncertain *this particular forecast* is, rather than how uncertain forecasts
   have been on average. AgilePredict combines this with (2), and the
   combination is better than either — (2) alone cannot tell a calm settled
   week from a volatile one.

Both need history before they can say anything, which is why the storage and
validation work comes before any accuracy claim. Until then the UI should show
a forecast with **no** confidence figure rather than a fabricated one.

Coarse labels (High/Medium/Low) should map to stated interval widths, and the
mapping should be documented where a user can find it.

### 4.4 Wholesale → Agile conversion

Given 1.1, the conversion is:

```text
agile_region = slope_region_period × agile_reference + intercept_region_period
```

where `period` is peak (16:00–19:00 local) or off-peak, and the coefficients
are refitted from published prices on a schedule. Store them with the fit
statistics and the window they were derived from. Alert if R² degrades — that
is the signal that Octopus has changed something.

If a wholesale price is forecast rather than a reference Agile price, convert
with the documented `min(D × wholesale + P, cap)` form, with D, P and the cap
stored as data and their source recorded. **Do not embed them in code.** Note
that the widely cited coefficients (multipliers 2.0–2.4, adders 11–14p, 35p
cap) date from August 2020 and are stale: the cap is now £1/kWh, and April
2026 brought a flat −3.5p/kWh reduction.

### 4.5 Storage

Forecasts must never be overwritten, so the run is part of the key:

```text
forecast_runs
  id, generated_at, model_version, horizon_hours, reference_region, status

forecasts
  run_id, settlement_start_utc, region,
  predicted_p, lower_p, upper_p, confidence_label

forecast_inputs
  observed_at, source, settlement_start_utc, metric, value

forecast_accuracy
  run_id, settlement_start_utc, region,
  predicted_p, actual_p, error_p, horizon_bucket
```

Volume is modest. Four runs a day × 144 half-hours (72h) × one reference
region is ~576 forecast rows a day, about 210k a year — comfortably inside
D1's free tier, and regional variants are computed on read rather than stored.

Actuals are joined in later by a validation job, which is also the moment a
confirmed price supersedes a forecast.

### 4.6 Infrastructure

| Question | Answer |
| -------- | ------ |
| Inference in Workers? | **Only for small models — measured, see below.** |
| Data collection? | Yes — the existing cron already runs every five minutes; collectors need only a few slots a day. |
| Storage? | D1 for forecasts, inputs and accuracy. R2 only if raw payload archives are wanted later. |
| Training? | Not in a Worker. GitHub Actions on a schedule, publishing a model artefact the Worker reads. |
| Paid infrastructure? | None required for the proposed tiers. |

Model artefacts should be versioned, integrity-checked and either bundled or
published immutably — not fetched as mutable data at request time — and the
version recorded on every forecast, so a change in accuracy can be attributed
to a change in model.

### Measured inference cost

Workers Free allows **10 ms of CPU per invocation**. An earlier draft asserted
inference "runs in microseconds" without measuring it, then quoted single
figures from an unseeded run that did not reproduce. What follows is a
*sizing experiment*, not a benchmark: `docs/research/bench-inference.mjs`,
seeded, 15 repeats, forecasting 144 periods with 12 features.

| Model | Median | p95 | Verdict |
| ----- | ------ | --- | ------- |
| Linear | 0.01 ms | 0.01 ms | fits |
| 100 trees, depth 6 (0.5 MB) | ~0.9 ms | ~1.1 ms | fits |
| 300 trees, depth 6 (1.6 MB) | ~2.9 ms | ~3.5 ms | fits |
| 500 trees, depth 8 (10.7 MB) | 13–17 ms | 14–25 ms | **over budget** |
| 1000 trees, depth 8 (21.4 MB) | 30–51 ms | 33–68 ms | **over budget** |

The ranges are deliberate. The small cases are stable run to run; the large
ones swing by 50% or more, almost certainly garbage collection under
multi-megabyte structures. **Read the verdict column, not the milliseconds.**
Measured in local Node, not a Worker — same engine, different isolate — and
excluding model parsing, D1 round trips and response building, which also
count against the same 10 ms.

Free-tier feasibility is only *settled* by measuring the chosen model in a
deployed Worker, which reports its own CPU time. This experiment narrows the
search space; it does not close the question.

The conclusion is firm enough to act on: **tiers 1 and 2 are comfortable, and
a full-size ensemble is not.** AgilePredict runs *three* such models together;
that is out of reach on this budget regardless of accuracy. A tree model here
is capped at roughly a few hundred shallow trees, and model *size* binds as
tightly as CPU — a multi-megabyte artefact parsed per invocation would
dominate everything in the table.

**Precomputing on cron does not help.** An earlier draft offered that as the
escape hatch for a larger model. It is wrong: on the Workers Free plan a Cron
Trigger gets the *same* 10 ms CPU allowance as an HTTP request.

| Plan | HTTP | Cron Trigger |
| ---- | ---- | ------------ |
| Free | 10 ms | **10 ms** |
| Paid | 30 s default, 5 min max | 30 s (< 1 h interval), 15 min (≥ 1 h) |

Moving work to the scheduled handler protects request latency and nothing
else. So the real choice is: **keep the model inside the small-model envelope
above, or generate forecasts outside Cloudflare entirely.** GitHub Actions is
already proposed for training and has real CPU; extending it to *produce* the
forecasts and having the Worker ingest immutable results is the honest design
for anything larger. The Worker then only reads D1, which it can do easily.

### 4.7 Failure handling

Forecasting is an enhancement and must not be able to damage the confirmed-price
path. Concretely:

- Collectors and the forecast job run in their own cron branch. A failure is
  logged and abandoned; it must never mark a pricing day retrieved, touch the
  price tables, or throw into the existing poller.
- A forecast run records which inputs it had. **If a required input is
  missing, produce no forecast** rather than a quietly worse one.
- The UI shows forecast age and marks it stale beyond a threshold. Stale is
  shown as stale; it is not silently refreshed or hidden.
- Every forecast surface degrades to "no forecast available" while confirmed
  prices continue to work exactly as now.

---

### 4.8 Judging a model, and calibrating confidence

MAE alone is the wrong yardstick, because it is not what the application is
for. The decisions this app supports are "when should I run the dishwasher",
"will it go negative", and "when should I avoid". A model can improve its MAE
while getting all three of those worse — flattening its predictions towards
the mean reduces average error and destroys exactly the extremes that matter.

Judge candidate models on:

- **Cheap-window regret** — the difference in cost between the window the
  forecast recommended and the cheapest window that actually occurred. This is
  the metric that corresponds to user harm, and it is the one to optimise.
- **Event precision and recall** for negative periods, very cheap periods and
  spikes. These are rare, so they are invisible in an average and need
  counting separately.
- **Pinball loss** for quantile outputs.
- **Interval coverage and width.** A P10–P90 output is *not* an 80% interval
  until observed coverage says it is. If 60% of actuals land inside it the
  label is a lie; if 99% do, it is too wide to be useful. Coverage must be
  measured before any confidence wording is shown to anyone, and re-measured
  whenever the model changes.
- MAE by horizon bucket, as the conventional baseline comparison.

All of these need walk-forward evaluation on identical periods, using the
input vintages from section 3a. Comparing models on different windows, or on
revised inputs, produces numbers that cannot be compared.

## 5. Presentation

Confirmed and forecast prices must never be confusable. Proposed treatment:

- Confirmed periods keep the current solid bars and exact figures.
- Forecast periods are visually distinct — hatched or outlined rather than
  solid — and carry a `Forecast` label wherever a number appears.
- The boundary between confirmed and forecast is drawn explicitly on the
  chart, not merely implied by styling.
- Forecast figures show a range, not a single number, wherever one exists.
- Notification copy states plainly that a price is predicted and unconfirmed,
  and forecast alerts are a separate switch from confirmed-price alerts.

When Octopus publishes, the confirmed price supersedes the forecast for that
settlement period — but the forecast is retained for validation.

### A shipped example: Octopus Watch

**Octopus Watch** (Android, by Smarthound; screenshots supplied by the project
owner, 2026-08-27) forecasts 48 hours ahead and presents it like this:

- Forecast rows sit **inline in the same list** as confirmed rows, in
  chronological order.
- They are distinguished **only by a small glyph** before the price. Same
  typography, same decimal precision, same coloured price-band chip, same
  expand chevron.
- There is **no marker at the boundary** where confirmed becomes forecast.
- Each forecast is a **single value to two decimal places** — e.g.
  `31.69p/kWh` at roughly 48 hours out.

Two things to take from it.

**Inline is right.** Scrolling from confirmed into forecast in one continuous
list is genuinely how people want to read this — "what is it doing tonight"
does not respect the boundary between published and predicted. An earlier
draft of this document implied forecasts might live somewhere separate. They
should not. The owner's own description — "they just appear in the same prices
bit" — is the feature, not the flaw.

**The differentiation is too weak, and the precision is dishonest.** A small
glyph is easy to miss while scrolling, and a band chip rendered identically on
a forecast lends it the authority of a confirmed price. Worse, `31.69p` two
days out claims a precision no forecast has; the second decimal is noise
presented as fact. That is the failure mode `DESIGN.md` warns about, arrived
at not through carelessness but by making forecasts look consistent with
confirmed rows — which is the natural thing to do.

So: keep the inline list, and carry the distinction in the parts that are hard
to miss — round forecast figures to a sensible precision, show a range rather
than a point where one exists, mark the confirmed/forecast boundary explicitly
in the list, and treat the price-band colour as something a forecast has to
earn rather than inherit.

**Its detail view shows carbon intensity and generation mix, not uncertainty.**
Tapping a period opens gCO2/kWh and a fuel-mix breakdown, credited to the
Carbon Intensity API. So the answer to "what do users expect behind a forecast
row" is, in current practice, *context rather than error bars* — no app in
this space appears to publish a range. Showing one would be a differentiator,
but it is unvalidated by market practice and should not be assumed to be what
people want.

### The best idea in it: separate showing from deciding

Its settings split predictions into three switches:

| Setting | Default |
| ------- | ------- |
| Show Predicted Rates | **on** |
| Always Show Agile Predictions (even on another tariff) | **on** |
| **Use Predictions for Slots** — "use predicted rates to find the slot with lowest cost" | **off** |

That third one is the insight. Displaying a forecast and *acting* on it are
different risks, and it defaults to the conservative answer: show the
prediction, but do not let it drive the cheapest-window recommendation unless
the user opts in.

This is the direct mitigation for the cheap-window regret problem in section
4.8 — a bad forecast feeding the window calculator turns a wrong number into
wrong advice, which is worse. **Adopt this.** Forecast display and
forecast-driven recommendations should be separate settings, and the
recommendation one should be off until the measured accuracy justifies
turning it on by default.

Its disclaimer is also worth copying in substance: predictions are
continuously updated, are estimates, and come without warranty.

---

## 6. What this does not yet answer

Honest gaps, to be closed before implementation:

- **ENTSO-E has not been tested.** It needs a registration token. Whether GB
  day-ahead prices are available at a useful time, and how well they predict
  the half-hourly auction, is the single biggest open question.
- **No baseline error figure exists.** Until the seasonal-naive baseline is
  back-tested, "useful" is undefined and there is nothing to judge a model
  against.
- **No licensed gas price source has been found.** The Carbon Intensity
  generation mix gives gas *share*, which may be a usable substitute for gas
  *price* as a marginal-cost signal, but that is a hypothesis to test rather
  than a solved problem.
- **How far ahead the fundamentals carry** — whether 72 hours is achievable at
  useful accuracy, or whether it degrades to little better than seasonal-naive
  after 48 — is unknown and should be measured, not assumed.
- Whether the ~11:00 hourly day-ahead auction is a usable same-day anchor.

---

## 7. Suggested next steps

Following the staged plan, and stopping at each point to check the result is
worth continuing from:

These are ordered so that nothing waits on an unknown, and each step is
worth doing even if the next never happens.

1. ~~**Start archiving the vintage-less sources now**~~ — **done**, see
   section 8.
2. **Implement the regional coefficient fitting** from 1.1, with its health
   check. Independently useful, low risk, and ships on its own.
3. **Back-test the seasonal-naive baseline and publish its error.** Until this
   number exists, "useful" is undefined and no model can be judged.
4. **Add the fundamentals model** and compare against the baseline by
   walk-forward validation on identical periods, using the decision metrics in
   section 4.8 rather than MAE alone. Start with the Carbon Intensity
   generation-mix forecast: it covers 48 hours, is already reconciled by
   National Grid, and gas share is close to a price driver in its own right.
   It may well carry most of the signal that raw wind and demand feeds would.
5. **Then** storage of live forecasts, UI, notifications, accuracy reporting.

**ENTSO-E is an experiment that runs alongside, not a dependency.** It is
worth testing — confirm the exact GB product, resolution, publication time,
completeness and redistribution terms — but even a good result mainly helps
the same-day horizon. It does not solve the 48–72 hour fundamentals problem,
which is where the difficulty actually is. An earlier draft called it "the
single biggest open question", which overstated it: the baseline and the input
archive are what unblock everything, and both can proceed without it.

---

## References

- AgilePredict — <https://github.com/fboundy/agile_predict>
- Octopus Agile pricing explained — <https://octopus.energy/blog/agile-pricing-explained/>
- Octopus price formulas (Guy Lipman, August 2020; coefficients now stale) —
  <https://www.guylipman.com/octopus/formulas.html>
- Elexon BMRS API — <https://developer.data.elexon.co.uk/>
- NESO data portal — <https://www.neso.energy/data-portal>
- Open-Meteo — <https://open-meteo.com/>
- ENTSO-E Transparency Platform — <https://transparency.entsoe.eu/>

---

## 8. Built: the input archive

The first piece of forecasting implemented. It produces no forecasts by
itself and changes nothing a user sees. It exists because the Carbon Intensity
API cannot be asked what it said last week, so a day not collected is a day
that can never be used to validate a later model honestly. NESO does not have
that problem: its official annual archives retain proper issue times.

If the forecasting idea is abandoned tomorrow, the cost is roughly 770 small
database rows a day until retention removes them.

### What it collects

| Source | Rows per run | Contents |
| ------ | ------------ | -------- |
| `carbon_intensity` | 96–97 | Forecast intensity and full generation mix by fuel, 48 hours, national |

NESO was collected initially and has been **removed**: its own archives supply
better data with real issue times (section 3a), so archiving the rolling feed
was storing a worse copy of something already kept. Migration 0007 removes
all legacy `neso_embedded` rows from every installation; the earlier manual
production deletion was not enough.

**Storage, re-measured rather than divided from the old mixed-source figure.**
Two Carbon-only production batches held 97 and 96 rows. Across all 193 rows,
the stored column values averaged **292.8 bytes per row**. At the default
three-hour interval that is about **772 rows and 0.23 MB a day**, or roughly
82 MB a year of column payload before SQLite pages and index overhead. A
**free D1 database is capped at 500 MB** (the 5 GB figure is the per-*account*
total).

Retention is therefore explicit: observations about periods older than
`FORECAST_ARCHIVE_RETENTION_DAYS` (default **180**) are pruned after a
successful collection — never after a failed one, so a broken archive does not
spend its invocation deleting history it is no longer replacing. At 180 days
that is roughly **41 MB of column payload** before SQLite/index overhead, which
fits alongside the price data.

Anything wanting a longer history needs an export to R2 or elsewhere first.
That is not built.

### Corrected after review

Five findings from a review of the first version. Recorded because three of
them were only visible against the live API or the deployed table, not in a
passing test suite.

1. **NESO periods were all collapsed onto midnight.** `DATE_GMT` is the *day*
   (`2026-08-27T00:00:00`); the half-hour lives in `TIME_GMT` (`15:30`).
   Reading the date alone stamped all 48 periods of a day with the same
   instant, and the deployed table showed 144 rows across just 3 distinct
   periods. **The test fixture caused this**: it invented a full timestamp in
   `DATE_GMT`, a shape the API never produces, so the collector passed. The
   fixture now uses the real shape. There was a second bug underneath:
   `DATE_GMT` carries no timezone, so `Date.parse` read it in the runtime's
   zone — the same code produced 23:00Z locally and 00:00Z in the Worker.
   Components are now assembled with `Date.UTC`. The affected rows were
   deleted from production; they could not be repaired because the settlement
   period was not stored either, and it now is.
2. **The archive was not actually isolated from price polling.** All three
   jobs were handed to `Promise.all`, which starts them together — so calling
   the archive "deliberately last" in a comment was simply false, and they
   shared one 10 ms CPU allowance. `runScheduledJobs` now awaits the core work
   before the archive begins, with a test asserting the order.
3. **One succeeding source suppressed retries for a failing one.** A single
   shared last-run marker meant that if Carbon Intensity worked and NESO
   failed, NESO waited the full three hours rather than being retried — losing
   vintages that cannot be recovered. Sources are now scheduled and retried
   independently.
4. **The Worker ignored the configured interval.** `FORECAST_ARCHIVE_INTERVAL_MINUTES`
   existed in the config schema but was never threaded through the Worker's
   `Env`, so production always used the default. Fixed, along with retention.
5. **Growth was understated and unbounded.** See below.

A second review then found three more, two of them P1:

6. **The corrected NESO timestamps were still 30 minutes late** — `TIME_GMT`
   is the period end. Both the original and the correction reached
   production. See section 3a.
7. **NESO vintages were retrievable all along**, from annual archives with a
   real issue time. The premise for collecting it was wrong, and the collector
   has been removed.
8. **Retention scanned the whole table.** The indexes lead with `source`, so
   `DELETE … WHERE target_start < ?` could not use them —
   `EXPLAIN QUERY PLAN` reported `SCAN forecast_inputs`, repeated eight times
   a day over a growing table. Migration 0006 adds an index on
   `target_start`; the plan is now `SEARCH … USING INDEX`.

### Design points worth keeping

- **Insert-only.** A later collection of the same period is a new row, never
  an update. The difference between two vintages *is* the revision a
  back-test must not see, so throwing it away would defeat the purpose.
- **Collection time is the vintage.** Carbon Intensity publishes no issue
  time, so `issued_at` is null and `collected_at` is the best available. The
  column remains because other candidate sources do provide a real issue time.
- **Bounded to the source horizon.** Only the national 48-hour Carbon
  Intensity window is retained. An inclusive boundary can make a batch 97
  rather than 96 periods; the collector validates timestamps and keeps only
  values inside its configured horizon.
- **CPU-aware.** The collector makes two concurrent HTTPS reads, shapes at
  most 97 small records and runs only after confirmed-price and alert work.
  The obsolete 1.5 ms figure measured the removed NESO parser too and is not
  retained as a Carbon-only benchmark.
- **Cannot break anything.** It never throws to its caller, never touches the
  price tables, never marks a pricing day retrieved, and runs last in the
  scheduled handler. If every collector fails it records no run, so the next
  invocation retries rather than waiting out the interval on a failure.

### Known limitation

The retained Carbon forecast reaches 48 hours, not the longer horizon a future
three-day fundamentals model may want. NESO history remains available from its
official archives when that model is back-tested; no local rolling copy is
needed.

### Terms compliance

Every request identifies the application by `User-Agent`, as the Carbon
Intensity terms require, and collection runs eight times a day rather than
continuously. The remaining obligation is **attribution in the UI**, which
falls due when anything derived from this data is first shown to a user — see
the table in section 3.

---

## 9. Built: experimental seasonal-naive baseline

The first user-visible estimate deliberately stops before a large modelling
pipeline. An isolated forecast job maintains the previous 28 complete days of
official Octopus Agile prices. It backfills at most one tariff-day (46, 48 or
50 periods) per five-minute cron invocation rather than attempting roughly
1,350 D1 writes at once; a new installation fills the reference region in
about 2 hours 20 minutes when it is itself the active region, or a
reference/active-region pair in about 4 hours 40 minutes. It runs after
confirmed price polling, alerts and the input archive; failures are logged and
never affect those features. API requests read stored data only and never wait
on an upstream service.

The calculation follows the binding regional finding in section 1:

1. Forecast reference region C from the median of up to eight recent prices
   at the same London-local half-hour on the same kind of day
   (weekday/weekend). At least three comparable observations are required.
2. Report the recent P20–P80 observations as a descriptive **recent range**.
   It is explicitly not presented as a calibrated confidence interval.
3. Fit separate 16:00–19:00 and off-peak linear transforms from overlapping
   confirmed reference and target-region prices. If either fit has fewer than
   48 pairs or R² below 0.9999, publish no forecast rather than use a stale
   regional relationship.
4. Produce estimates for tomorrow and the following day. Any confirmed
   Octopus period suppresses the estimate for the same timestamp.

The UI places estimates inline after confirmed prices, draws an explicit
boundary, labels every estimated row, rounds the point value to one decimal
place and shows the recent range. Forecast bars are outlined. Estimates do
not feed alerts, current/next price, cheapest-window advice or publication
status.

This is an **educated baseline**, not an accuracy claim. It is computed
deterministically from stored history and not yet persisted as forecast runs,
so the next responsible step is to retain its live vintages before deciding
whether fundamentals or machine learning earn their complexity.

### Baseline back-test

`docs/research/backtest-seasonal-baseline.mjs` scores the exact implemented
calculation against fixed, official region-C Agile history. It uses 28 days of
past information for each prediction and scores 2,736 half-hours from 1 July
through 26 August 2026, with no skipped days:

| Measure | Result |
| ------- | ------ |
| Mean absolute error | **3.82p/kWh** |
| Median absolute error | **2.53p/kWh** |
| 90th-percentile absolute error | **9.73p/kWh** |
| Mean bias | **−0.86p/kWh** (under-predicts) |
| Descriptive recent-range coverage | **49.2%** |
| Below-10p precision / recall | **54.6% / 54.9%** |
| Negative-price precision / recall | **0% / 0%** |

These figures explain the product restrictions. The estimate is useful for a
rough shape and price level, but it is not dependable for rare negative prices
or automation, and its displayed range is not calibrated uncertainty. Pooling
only the same weekday was also measured and rejected: MAE worsened to 4.25p
and range coverage collapsed to 17.2% because four observations per slot were
too few. The broader weekday/weekend grouping remains the implemented
baseline because it performed better, not because it merely sounded plausible.
