-- Cross-progression cloud save state + server-authoritative anti-save-scumming wager escrow.
ALTER TABLE accounts ADD COLUMN save_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN save_prefs TEXT NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN avatar_gear TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS wager_escrows (
  id TEXT PRIMARY KEY,
  challenger TEXT NOT NULL,
  opponent TEXT NOT NULL,
  stake TEXT NOT NULL,           -- 'cash' | 'pinkslip'
  amount INTEGER NOT NULL DEFAULT 0,
  challenger_car TEXT NOT NULL,
  opponent_car TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'locked',  -- 'locked' | 'settled' | 'forfeited'
  winner TEXT,
  created INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_escrow_status ON wager_escrows(status, created);
