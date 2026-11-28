-- Short-lived one-time tickets for popup OAuth handoff inside cross-origin isolated iframes
-- (e.g. itch.io HTML5 embeds with SharedArrayBuffer / COOP where window.opener is severed).
CREATE TABLE IF NOT EXISTS oauth_tickets (
  ticket_hash TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  provider TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
