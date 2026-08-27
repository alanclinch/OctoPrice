-- The live NESO collector was removed after its rolling feed proved to be a
-- worse copy of the provider's official vintage archives. Two flawed versions
-- also stored periods at the wrong instant. Remove every local NESO row so an
-- installation upgraded later cannot mistake any of them for training data.
--
-- Idempotent: installations that never collected NESO simply delete zero rows.

DELETE FROM forecast_inputs WHERE source = 'neso_embedded';
