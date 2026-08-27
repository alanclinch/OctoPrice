-- The forecasting input archive.
--
-- Some sources cannot be asked what they said in the past. Elexon and
-- Open-Meteo expose vintages; NESO and the Carbon Intensity API do not. For
-- those, the only way to back-test without leaking future knowledge is to
-- have written down what they said at the time. Every day without this table
-- is a day that can never be used for honest validation, which is why it is
-- the first piece of forecasting to be built.
--
-- Observations are never updated or replaced. A later collection of the same
-- target period is a new row, because the difference between the two *is* the
-- revision we must not train on.
--
-- The payload is JSON rather than a row per metric. Sources disagree about
-- what they publish, the consumer is a bulk training export rather than a
-- query, and one row per period per run keeps this to a few hundred rows a
-- day instead of a few thousand.

CREATE TABLE forecast_inputs (
  id           TEXT PRIMARY KEY,
  -- 'carbon_intensity' | 'neso_embedded'
  source       TEXT NOT NULL,
  -- Settlement period this observation is *about*, ISO 8601 UTC.
  target_start TEXT NOT NULL,
  -- The source's own publication time, when it provides one. Null means the
  -- source does not say, and collected_at is the best vintage available.
  issued_at    TEXT,
  -- When we fetched it. For a vintage-less source this is the vintage.
  collected_at TEXT NOT NULL,
  -- Source-shaped JSON: generation mix percentages, forecast intensity, etc.
  payload      TEXT NOT NULL
);

-- The common query is "what did we know about this period, and when".
CREATE INDEX idx_forecast_inputs_target ON forecast_inputs (source, target_start, collected_at);

-- Supports pruning and "when did we last collect" without a table scan.
CREATE INDEX idx_forecast_inputs_collected ON forecast_inputs (source, collected_at);
