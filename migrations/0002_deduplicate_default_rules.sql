-- The first Worker release could initialise two isolates concurrently. Keep
-- the earliest copy of each built-in rule and remove only exact default-name
-- duplicates; user-created rules with other names are untouched.
DELETE FROM alert_rules
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, name
        ORDER BY created_at ASC, id ASC
      ) AS duplicate_number
    FROM alert_rules
    WHERE name IN ('Negative prices', 'Cheap electricity', 'Two cheap hours')
  )
  WHERE duplicate_number > 1
);
