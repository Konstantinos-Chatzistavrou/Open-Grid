// Apache-2.0 — Real Email + Password Authentication for OpenGrid (Cloudflare Workers Free Plan + Node 24).
// Uses WebCrypto PBKDF2-HMAC-SHA256 (100,000 iterations + 16-byte random salt) and constant-time comparison.
// Zero paid third-party auth vendor required; works identically for WebGPU & UE 5.8 clients.

const PBKDF2_ITERATIONS = 100_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function emailError(email: string): string | null {
  if (!email) return 'Enter an email address.';
  if (email.length > 160 || !EMAIL_RE.test(email)) return 'Enter a valid email address.';
  return null;
}

export function passwordError(pw: string): string | null {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password is too long.';
  return null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time byte comparison to prevent timing side channels on password/HMAC verification. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const salt = saltHex ?? toHex(saltBytes);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return { hash: toHex(new Uint8Array(bits)), salt };
}

export async function verifyPassword(password: string, expectedHash: string, saltHex: string): Promise<boolean> {
  if (!expectedHash || !saltHex) return false;
  const { hash } = await hashPassword(password, saltHex);
  return timingSafeEqualHex(hash, expectedHash);
}

/** HMAC-SHA256 signature verification for billing webhooks (Stripe/Paddle/custom signed webhook). */
export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(sig));
}
