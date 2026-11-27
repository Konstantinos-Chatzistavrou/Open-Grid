-- Multi-provider OAuth2 identity links (Google, GitHub, Discord) for OpenGrid accounts.
-- Lets one OpenGrid driver sign in via Google, GitHub, Discord, or Email+Password and always land
-- on the exact same profile, DR/SR, license, cars, and Patreon pass.
CREATE TABLE IF NOT EXISTS oauth_identities (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT,
  created INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_account ON oauth_identities(account_id);
