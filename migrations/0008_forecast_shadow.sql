-- Compact prepared-day rows and immutable forecast vintages for the
-- fundamentals-analogue shadow model. Neither table is read by the public API;
-- confirmed prices and the visible seasonal baseline remain isolated.

CREATE TABLE forecast_prepared_days (
  tariff_code           TEXT NOT NULL,
  pricing_date          TEXT NOT NULL,
  issue_cutoff          TEXT NOT NULL,
  residual_demand       TEXT NOT NULL,
  baseline_prices       TEXT,
  actual_prices         TEXT,
  input_vintages        TEXT NOT NULL,
  prepared_at           TEXT NOT NULL,
  PRIMARY KEY (tariff_code, pricing_date)
);

CREATE TABLE forecast_runs (
  id                    TEXT PRIMARY KEY,
  model                 TEXT NOT NULL,
  tariff_code           TEXT NOT NULL,
  target_date           TEXT NOT NULL,
  generated_at          TEXT NOT NULL,
  issue_cutoff          TEXT NOT NULL,
  periods               TEXT NOT NULL,
  input_vintages        TEXT NOT NULL,
  scored_at             TEXT,
  mae_pence             REAL,
  cheapest_3h_regret    REAL,
  within_60_minutes     INTEGER,
  UNIQUE (model, tariff_code, target_date, issue_cutoff)
);

CREATE INDEX idx_forecast_runs_unscored
  ON forecast_runs (scored_at, target_date);
