# Agile price forecasting — research and proposed architecture

**Status: research and design only. Nothing here is implemented yet.**

This document covers stages 1–4 of the staged plan in the feature request:
review prior art, investigate data sources, propose an architecture, and
establish what fits the existing Cloudflare free-tier deployment. It exists so
that the design and its reasoning are on record before any substantial code is
written.

Everything marked **verified** was tested against the live API on 2026-08-27
from this repository. Everything else is proposal or secondary reading.

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

This is also a better answer to "do not hard-code pricing formulas" than
citing a published formula: the coefficients are *derived from Octopus's own
published prices*, refitted periodically, and the fit quality is itself a
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

<https://github.com/fboundy/agile_predict> is the reference implementation and
is considerably more ambitious than what is proposed here.

- **Data:** Elexon (nuclear availability, demand), NESO (wind, solar, embedded
  generation, operating margin), ENTSO-E (French nuclear, as an interconnector
  signal), Open-Meteo (UK and French weather with ensemble perturbations),
  Nord Pool (GB day-ahead), Yahoo Finance (TTF gas futures), Octopus (actuals).
- **Models:** a three-model ensemble — CatBoost, LightGBM and ExtraTrees —
  trained on a rolling 90-day window, with training samples weighted by linear
  z-score so spikes and negative prices are prioritised.
- **Features:** a fixed base set (generation mix, demand, margin surplus,
  calendar flags) plus experimental features evaluated every 14 days by
  walk-forward cross-validation, weighted 3× for horizons under three days.
- **Horizon:** up to 14 days, all regions A–P.
- **Explainability:** per-slot SHAP contributions in £/MWh.

**What to take:** the data-source list, the emphasis on weighting extreme
prices during training, and walk-forward validation as the honest way to
measure a time-series model.

**What not to take:** the whole stack. It is a Python service with a
substantial training pipeline. This application is a Cloudflare Worker with a
D1 database and a hard preference for the free tier. Its per-region modelling
is also unnecessary given finding 1.1 — the regional variation it models is
arithmetic.

---

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
| Octopus | existing client | Confirmed Agile prices and history, all regions |

All returned JSON over plain HTTPS with no authentication, which means all of
them are reachable from a Worker with no secret management.

### Requires registration

- **ENTSO-E Transparency Platform** — GB day-ahead prices, cross-border flows,
  French nuclear availability. Free but needs an API token, which would be a
  Worker secret. This is the most valuable unverified source, because it is
  the closest thing to the actual wholesale input (see 1.2).

### Investigated and rejected or deferred

- **Nord Pool** — publishes GB day-ahead prices, but redistribution is
  licence-restricted. Not appropriate for a public deployment without
  checking terms. AgilePredict's use of it does not make it licensed for ours.
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
| Inference in Workers? | Yes — linear coefficients or JSON trees. No Python, no native libraries, no WASM needed. |
| Data collection? | Yes — the existing cron already runs every five minutes; collectors need only a few slots a day. |
| Storage? | D1 for forecasts, inputs and accuracy. R2 only if raw payload archives are wanted later. |
| Training? | Not in a Worker. GitHub Actions on a schedule, publishing a model artefact the Worker reads. |
| Paid infrastructure? | None required for the proposed tiers. |

Model artefacts should be versioned and the version recorded on every
forecast, so a change in accuracy can be attributed to a change in model.

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

---

## 6. What this does not yet answer

Honest gaps, to be closed before implementation:

- **ENTSO-E has not been tested.** It needs a registration token. Whether GB
  day-ahead prices are available at a useful time, and how well they predict
  the half-hourly auction, is the single biggest open question.
- **No baseline error figure exists.** Until the seasonal-naive baseline is
  back-tested, "useful" is undefined and there is nothing to judge a model
  against.
- **No licensed gas price source has been found.**
- **How far ahead the fundamentals carry** — whether 72 hours is achievable at
  useful accuracy, or whether it degrades to little better than seasonal-naive
  after 48 — is unknown and should be measured, not assumed.
- Whether the ~11:00 hourly day-ahead auction is a usable same-day anchor.

---

## 7. Suggested next steps

Following the staged plan, and stopping at each point to check the result is
worth continuing from:

1. Register for ENTSO-E and test GB day-ahead availability and timing.
2. Build the historical dataset from sources already verified, storing raw
   observations from the start.
3. Implement and back-test the seasonal-naive baseline. **Publish its error.**
4. Implement the regional coefficient fitting from 1.1, with its health check.
   This is independently useful and low-risk.
5. Add the fundamentals model and compare against the baseline by walk-forward
   validation over the same periods.
6. Only then: storage of live forecasts, UI, notifications, accuracy
   reporting.

Steps 3 and 4 are the ones that pay off soonest, and step 4 can ship on its
own regardless of whether the forecasting model ever proves good enough.

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
