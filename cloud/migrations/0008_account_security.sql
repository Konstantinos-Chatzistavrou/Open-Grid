-- Account Security: Pure WebCrypto RFC 6238 TOTP 2FA, hashed one-time Recovery/Backup codes,
-- and optional 15-minute password reset tokens (works $0/mo via recovery codes or via Resend REST API).
ALTER TABLE accounts ADD COLUMN totp_secret TEXT;
ALTER TABLE accounts ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE accounts ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN backup_codes_json TEXT;
ALTER TABLE accounts ADD COLUMN reset_token_hash TEXT;
ALTER TABLE accounts ADD COLUMN reset_token_expires INTEGER NOT NULL DEFAULT 0;
