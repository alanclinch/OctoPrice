-- Whether a person has actually chosen their electricity region.
--
-- The first-run region prompt used to be remembered in browser local storage,
-- which is per *device*, not per person. Once anyone had chosen a region on a
-- device, everybody who later signed in there skipped the prompt and was left
-- silently on the default region, seeing prices from the wrong part of the
-- country.
--
-- Region is a property of the person, so the record of having chosen one
-- belongs beside it, and follows them to any device they sign in on.

ALTER TABLE settings ADD COLUMN region_confirmed INTEGER NOT NULL DEFAULT 0;

-- Anyone who already exists has been using the app and chosen their region,
-- so they must not be asked again.
UPDATE settings SET region_confirmed = 1;
