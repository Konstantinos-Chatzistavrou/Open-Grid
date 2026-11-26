-- OpenGrid Competitive Online Moat (Phase 1):
-- Real Email+Password Auth (PBKDF2-SHA256, 100% Cloudflare Free Plan!), Ad-free Subscription Entitlements,
-- Dual-Rating (DR/SR + License R..PRO + Bad-Sport Quarantine + Jokers),
-- Scheduled Official Series & SOF Splits, Seasonal Championships, Restorative Protests,
-- Verified Global Hotlap Leaderboards, and Endurance Teams.

ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN password_hash TEXT;
ALTER TABLE accounts ADD COLUMN password_salt TEXT;
ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email COLLATE NOCASE) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_attempts (
  net TEXT NOT NULL,
  window_min INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (net, window_min)
);

ALTER TABLE accounts ADD COLUMN sub_tier TEXT NOT NULL DEFAULT 'trial';        -- 'none' | 'trial' | 'pro' | 'team_pro'
ALTER TABLE accounts ADD COLUMN sub_expires_at INTEGER NOT NULL DEFAULT 0;     -- unix ms (0 = inactive unless lifetime)
ALTER TABLE accounts ADD COLUMN billing_customer_id TEXT;

ALTER TABLE accounts ADD COLUMN dr REAL NOT NULL DEFAULT 1500.0;               -- Glicko-2 Driver Rating (800..3500)
ALTER TABLE accounts ADD COLUMN dr_rd REAL NOT NULL DEFAULT 180.0;             -- Rating Deviation (45..350)
ALTER TABLE accounts ADD COLUMN sr REAL NOT NULL DEFAULT 2.50;                 -- Safety Rating (0.00..4.99)
ALTER TABLE accounts ADD COLUMN license TEXT NOT NULL DEFAULT 'R';             -- 'R' | 'D' | 'C' | 'B' | 'A' | 'PRO'
ALTER TABLE accounts ADD COLUMN mpr_races INTEGER NOT NULL DEFAULT 0;          -- MPR races at current license
ALTER TABLE accounts ADD COLUMN rolling_cpi REAL NOT NULL DEFAULT 25.0;        -- Rolling Corners-Per-Incident
ALTER TABLE accounts ADD COLUMN bad_sport INTEGER NOT NULL DEFAULT 0;          -- 1 = rammer quarantine split only
ALTER TABLE accounts ADD COLUMN clean_streak INTEGER NOT NULL DEFAULT 0;       -- Consecutive clean corners (15 lifts quarantine)
ALTER TABLE accounts ADD COLUMN jokers_left INTEGER NOT NULL DEFAULT 2;        -- Season disconnect/crash Jokers
ALTER TABLE accounts ADD COLUMN starts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN wins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN podiums INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN poles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN total_incidents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN total_corners INTEGER NOT NULL DEFAULT 0;

-- Two-party wager confirmation columns (fixes client-trusted single-party settlement)
ALTER TABLE wager_escrows ADD COLUMN challenger_claim TEXT;                    -- 'won' | 'lost'
ALTER TABLE wager_escrows ADD COLUMN opponent_claim TEXT;                      -- 'won' | 'lost'
ALTER TABLE wager_escrows ADD COLUMN race_id TEXT;

-- Scheduled Official Series Registrations & SOF Split Assignments
CREATE TABLE IF NOT EXISTS series_entries (
  event_key TEXT NOT NULL,           -- e.g. 'gt3_fixed:2026-11-26T21:00Z'
  series_id TEXT NOT NULL,
  account TEXT NOT NULL,
  car TEXT NOT NULL,
  dr REAL NOT NULL,
  sr REAL NOT NULL,
  license TEXT NOT NULL,
  bad_sport INTEGER NOT NULL DEFAULT 0,
  split_no INTEGER,                  -- 1 = top SOF split, 2..N, -1 = bad-sport split
  sof REAL,
  party_code TEXT,                   -- assigned RaceRoom / party code for this split
  status TEXT NOT NULL DEFAULT 'registered', -- 'registered' | 'seeded' | 'raced' | 'withdrawn'
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (event_key, account)
);
CREATE INDEX IF NOT EXISTS idx_series_event ON series_entries(event_key, status);

-- Official Seasonal Championship Standings (car lock, SOF-weighted points, best-of-N rounds)
CREATE TABLE IF NOT EXISTS championship_standings (
  season_id TEXT NOT NULL,           -- e.g. '2026-S4'
  series_id TEXT NOT NULL,
  account TEXT NOT NULL,
  locked_car TEXT NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  best_rounds_json TEXT NOT NULL DEFAULT '[]',
  starts INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  podiums INTEGER NOT NULL DEFAULT 0,
  attempts_week INTEGER NOT NULL DEFAULT 0,
  last_week TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, series_id, account)
);
CREATE INDEX IF NOT EXISTS idx_champ_points ON championship_standings(season_id, series_id, points DESC);

-- Per-race rating ledger (enables Restorative Protests & Season Disconnect Jokers!)
CREATE TABLE IF NOT EXISTS race_rating_ledger (
  race_id TEXT NOT NULL,
  account TEXT NOT NULL,
  series_id TEXT NOT NULL DEFAULT 'open',
  dr_before REAL NOT NULL,
  dr_after REAL NOT NULL,
  sr_before REAL NOT NULL,
  sr_after REAL NOT NULL,
  incidents INTEGER NOT NULL DEFAULT 0,
  victim_shields INTEGER NOT NULL DEFAULT 0,
  disconnected INTEGER NOT NULL DEFAULT 0,
  joker_used INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  PRIMARY KEY (race_id, account)
);

-- Restorative Protests & Stewarding Queue (upheld protests REFUND victim DR & SR!)
CREATE TABLE IF NOT EXISTS protests (
  id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL,
  reporter TEXT NOT NULL,
  accused TEXT NOT NULL,
  incident_type TEXT NOT NULL,       -- 'intentional_wreck' | 'unsafe_rejoin' | 'blocking' | 'ramming' | 'chat_abuse'
  lap INTEGER NOT NULL DEFAULT 1,
  corner TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  replay_clip TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'upheld' | 'dismissed'
  verdict_note TEXT,
  dr_refunded REAL NOT NULL DEFAULT 0,
  sr_refunded REAL NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_protests_status ON protests(status, created);

-- Verified Global Hotlap / Time Trial Leaderboards (with Ghost & Telemetry Hash)
CREATE TABLE IF NOT EXISTS hotlaps (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL,
  car TEXT NOT NULL,
  weather TEXT NOT NULL DEFAULT 'dry',
  account TEXT NOT NULL,
  username TEXT NOT NULL,
  lap_ms INTEGER NOT NULL,
  sectors_json TEXT NOT NULL DEFAULT '[]',
  telemetry_hash TEXT NOT NULL DEFAULT '',
  ghost_data TEXT,
  verified INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hotlaps_best ON hotlaps(track, car, weather, account);
CREATE INDEX IF NOT EXISTS idx_hotlaps_board ON hotlaps(track, car, weather, verified, lap_ms ASC);

-- Endurance Teams & Rosters (foundation for multi-hour Driver Swap events)
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  tag TEXT NOT NULL,
  owner TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  account TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'driver', -- 'owner' | 'driver' | 'engineer'
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, account)
);
