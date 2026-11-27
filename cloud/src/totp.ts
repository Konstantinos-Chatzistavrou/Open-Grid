// Apache-2.0 — Pure WebCrypto RFC 6238 TOTP Authenticator 2FA + One-Time Recovery/Backup Codes.
// Zero external dependencies; works identically on Cloudflare Workers and Node 24+.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BACKUP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // Excludes ambiguous 0/O/1/I/L

/** RFC 4648 Base32 encode (unpadded uppercase). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** RFC 4648 Base32 decode (case-insensitive; ignores spaces, dashes, and '=' padding). */
export function base32Decode(input: string): Uint8Array {
  const cleaned = String(input ?? '').toUpperCase().replace(/[\s=-]+/g, '');
  if (!cleaned) return new Uint8Array(0);
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) throw new Error(`Invalid Base32 character: ${cleaned[i]}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Generate a cryptographically random RFC 4648 Base32 TOTP secret (default 20 bytes = 160 bits). */
export function generateBase32Secret(byteLen = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return base32Encode(bytes);
}

/** Constant-time string comparison for fixed-length numeric codes. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** RFC 6238 / RFC 4226 TOTP generation using WebCrypto HMAC-SHA1. */
export async function generateTotp(
  secretBase32: string,
  timeMs = Date.now(),
  stepSec = 30,
  digits = 6,
): Promise<string> {
  const keyBytes = base32Decode(secretBase32);
  if (keyBytes.length === 0) throw new Error('Empty TOTP secret');
  const counter = Math.floor(timeMs / 1000 / stepSec);
  const counterBuf = new Uint8Array(8);
  const view = new DataView(counterBuf.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));
  const offset = mac[mac.length - 1] & 0x0f;
  const binCode =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(binCode % mod).padStart(digits, '0');
}

/**
 * Verify a 6-digit TOTP code across [-window .. +window] 30-second steps using constant-time comparison.
 * Strips spaces and dashes from the user input before checking.
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  window = 1,
  timeMs = Date.now(),
): Promise<boolean> {
  const cleaned = String(code ?? '').replace(/[\s-]+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  if (!secretBase32) return false;
  let matched = false;
  try {
    for (let offset = -window; offset <= window; offset++) {
      const expected = await generateTotp(secretBase32, timeMs + offset * 30_000, 30, 6);
      if (timingSafeEqualStr(cleaned, expected)) matched = true;
    }
  } catch {
    return false;
  }
  return matched;
}

/** Build an otpauth:// URI compatible with Google Authenticator, Authy, 1Password, Bitwarden, etc. */
export function buildOtpAuthUri(issuer: string, accountLabel: string, secretBase32: string): string {
  const encIssuer = encodeURIComponent(issuer);
  const encLabel = encodeURIComponent(accountLabel);
  const cleanSecret = secretBase32.replace(/[\s=-]+/g, '').toUpperCase();
  return `otpauth://totp/${encIssuer}:${encLabel}?secret=${cleanSecret}&issuer=${encIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/** Normalize a recovery/backup or reset code for hashing/comparison (uppercase, strip spaces/dashes). */
export function normalizeBackupCode(s: string): string {
  return String(s ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

/** Generate `count` unambiguous uppercase alphanumeric backup/recovery codes formatted `XXXX-XXXX`. */
export function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  const limit = Math.floor(256 / BACKUP_ALPHABET.length) * BACKUP_ALPHABET.length;
  const buf = new Uint8Array(16);
  for (let i = 0; i < count; i++) {
    let raw = '';
    while (raw.length < 8) {
      crypto.getRandomValues(buf);
      for (let j = 0; j < buf.length && raw.length < 8; j++) {
        if (buf[j] < limit) {
          raw += BACKUP_ALPHABET[buf[j] % BACKUP_ALPHABET.length];
        }
      }
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}
