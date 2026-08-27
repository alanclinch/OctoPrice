-- Make retention pruning use an index.
--
-- The existing indexes lead with `source`, so
-- `DELETE FROM forecast_inputs WHERE target_start < ?` could not use either
-- and SQLite reported `SCAN forecast_inputs`. At the documented steady state
-- that is a full scan of hundreds of thousands of rows, eight times a day,
-- to delete nothing most of the time.
--
-- Verified with EXPLAIN QUERY PLAN:
--   before: SCAN forecast_inputs
--   after:  SEARCH forecast_inputs USING INDEX
--           idx_forecast_inputs_retention (target_start<?)

CREATE INDEX idx_forecast_inputs_retention ON forecast_inputs (target_start);
