-- LiM Prompter cloud library. One library per Google account.
-- Apply: npx wrangler d1 execute prompter --remote --file=schema.sql  (--local for dev)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,            -- 'g-' + Google account id ("sub"); no ':' (the OAuth library splits codes on it)
  email TEXT NOT NULL,
  name TEXT,
  rev INTEGER NOT NULL DEFAULT 0, -- bumps on every change to this user's scripts
  created INTEGER NOT NULL
);

-- App sign-ins (one row per signed-in device). Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  updated INTEGER NOT NULL,       -- edit time (ms) from the device that made it; newest wins
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL,           -- users.rev when this row last changed
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS scripts_by_rev ON scripts (user_id, rev);
