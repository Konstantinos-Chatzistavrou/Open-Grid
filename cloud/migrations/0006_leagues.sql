-- Hosted Private Leagues (Community Championships, Custom BoP/Rules & League Stewards — $0/mo on Cloudflare D1).
CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  join_code TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',   -- { laps, realism, bop, route, minLicense }
  max_drivers INTEGER NOT NULL DEFAULT 32,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS league_members (
  league_id TEXT NOT NULL,
  account TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'driver',      -- 'owner' | 'steward' | 'driver'
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, account)
);
CREATE INDEX IF NOT EXISTS idx_league_member ON league_members(account);
