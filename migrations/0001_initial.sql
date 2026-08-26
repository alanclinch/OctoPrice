CREATE TABLE prices (
  id            TEXT PRIMARY KEY,
  tariff_code   TEXT NOT NULL,
  region        TEXT NOT NULL,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT NOT NULL,
  price_inc_vat REAL NOT NULL,
  price_exc_vat REAL NOT NULL,
  retrieved_at  TEXT NOT NULL,
  UNIQUE (tariff_code, valid_from)
);
CREATE INDEX idx_prices_tariff_from ON prices (tariff_code, valid_from);

CREATE TABLE alert_rules (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  name                     TEXT NOT NULL,
  enabled                  INTEGER NOT NULL DEFAULT 1,
  comparison_operator      TEXT NOT NULL,
  price_threshold          REAL NOT NULL,
  minimum_duration_minutes INTEGER NOT NULL DEFAULT 30,
  time_start               TEXT,
  time_end                 TEXT,
  notify                   INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  last_triggered_at        TEXT
);
CREATE INDEX idx_rules_user ON alert_rules (user_id);

CREATE TABLE notification_subscriptions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  provider          TEXT NOT NULL,
  subscription_data TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  last_success      TEXT,
  last_failure      TEXT,
  UNIQUE (user_id, subscription_data)
);

CREATE TABLE notification_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  rule_id    TEXT,
  type       TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT
);
CREATE INDEX idx_log_user_created ON notification_log (user_id, created_at);

CREATE TABLE settings (
  user_id              TEXT PRIMARY KEY,
  region               TEXT NOT NULL,
  product_code         TEXT NOT NULL,
  notify_daily_prices  INTEGER NOT NULL DEFAULT 1,
  notify_rule_matches  INTEGER NOT NULL DEFAULT 1,
  hour12               INTEGER NOT NULL DEFAULT 0,
  theme                TEXT NOT NULL DEFAULT 'system',
  updated_at           TEXT NOT NULL
);

CREATE TABLE app_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
