-- Multiple users.
--
-- Until now every table was keyed by `user_id`, but the value was always the
-- constant 'default': one shared account behind an unauthenticated public
-- URL. This adds the people.
--
-- A user *is* an invite. The owner creates a row with an access token, sends
-- the link, and the row records when it was first used. There are no
-- passwords and no email, which suits a handful of friends and family and
-- avoids storing credentials that could be lost or leaked.
--
-- Only the SHA-256 of a token is stored, so a copy of this database does not
-- hand over anyone's access. A lost link is replaced by regenerating the
-- token; the user id never changes, so their rules and devices survive.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  -- Friendly label chosen by the owner, e.g. "Mum". Not a login name.
  name         TEXT NOT NULL,
  -- SHA-256 hex of the access token. Null means a link has not been issued.
  token_hash   TEXT UNIQUE,
  is_owner     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  -- First time the link was opened. Null means the invite is unused.
  claimed_at   TEXT,
  last_seen_at TEXT
);

CREATE INDEX idx_users_token_hash ON users (token_hash);

-- Promote the existing shared account to the owner, keeping its id so that
-- every rule, setting, subscription and notification already recorded against
-- 'default' continues to belong to it.
INSERT OR IGNORE INTO users (id, name, token_hash, is_owner, created_at)
VALUES ('default', 'Owner', NULL, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
