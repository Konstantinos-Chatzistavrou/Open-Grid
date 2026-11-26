// Apache-2.0 — Zero-dependency Patreon API v2 & Webhook integration for OpenGrid (Cloudflare Workers Free Plan).
// Handles:
//   1. RFC 1321 MD5 & RFC 2104 HMAC-MD5 (`X-Patreon-Signature` webhook authentication) with constant-time compare.
//   2. Patreon v2 webhook parsing (`members:pledge:create`, `members:pledge:update`, `members:pledge:delete`).
//   3. Patreon v2 OAuth2 `/identity?include=memberships` pledge parsing for 1-click "Connect Patreon".
// Non-profit server funding: Patreon acts as Merchant of Record (global VAT/tax/renewals), $0/mo fixed cost.
import type { SubTier } from './ratings';

export const PATREON_RENEWAL_BUFFER_MS = 35 * 24 * 60 * 60 * 1000; // 35-day rolling window (covers monthly billing grace)
export const DEFAULT_PRO_MIN_CENTS = 500;   // $5/mo -> OpenGrid Pro (Official Online Pass)
export const DEFAULT_TEAM_MIN_CENTS = 1000; // $10/mo -> OpenGrid Team Pro (Endurance Teams + Leagues)

// ---- RFC 1321 MD5 (needed because WebCrypto intentionally omits MD5, while Patreon signs webhooks with HMAC-MD5) ----
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20, 5,  9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

function md5Bytes(input: Uint8Array): Uint8Array {
  const origLen = input.length;
  const padLen = ((56 - ((origLen + 1) % 64)) + 64) % 64;
  const buf = new Uint8Array(origLen + 1 + padLen + 8);
  buf.set(input, 0);
  buf[origLen] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLenLo = (origLen * 8) >>> 0;
  const bitLenHi = Math.floor((origLen * 8) / 0x100000000) >>> 0;
  dv.setUint32(buf.length - 8, bitLenLo, true);
  dv.setUint32(buf.length - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; }
      else if (i < 32) { F = (D & B) | ((~D) & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | (~D)); g = (7 * i) % 16; }
      const sum = (F + A + MD5_K[i] + M[g]) >>> 0;
      const rot = ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]))) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rot) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function md5Hex(text: string): string {
  return bytesToHex(md5Bytes(new TextEncoder().encode(text)));
}

/** RFC 2104 HMAC-MD5 hex digest (matches Patreon's `X-Patreon-Signature` header). */
export function hmacMd5Hex(secret: string, payload: string): string {
  const enc = new TextEncoder();
  let key = enc.encode(secret);
  if (key.length > 64) key = md5Bytes(key);
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < key.length; i++) {
    ipad[i] ^= key[i];
    opad[i] ^= key[i];
  }
  const msg = enc.encode(payload);
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad, 0);
  inner.set(msg, 64);
  const innerHash = md5Bytes(inner);
  const outer = new Uint8Array(64 + 16);
  outer.set(opad, 0);
  outer.set(innerHash, 64);
  return bytesToHex(md5Bytes(outer));
}

export interface PatreonEntitlementOpts {
  proMinCents?: number;
  teamMinCents?: number;
  campaignId?: string;
  nowMs?: number;
}

export interface PatreonEntitlementResult {
  patreonUserId: string | null;
  email: string | null;
  patronStatus: string;
  entitledCents: number;
  tier: SubTier;
  expiresAt: number;
  resetJokers: boolean;
}

/** Map Patreon member status + pledged cents into OpenGrid's ad-free subscription tier. */
export function tierFromPatreonCents(
  patronStatus: string,
  entitledCents: number,
  opts: PatreonEntitlementOpts = {},
): SubTier {
  if (patronStatus !== 'active_patron') return 'none';
  const proMin = Math.max(100, Math.round(opts.proMinCents ?? DEFAULT_PRO_MIN_CENTS));
  const teamMin = Math.max(proMin, Math.round(opts.teamMinCents ?? DEFAULT_TEAM_MIN_CENTS));
  if (entitledCents >= teamMin) return 'team_pro';
  if (entitledCents >= proMin) return 'pro';
  return 'none';
}

/** Parse a Patreon API v2 webhook payload (`members:pledge:create` / `update` / `delete`). */
export function parsePatreonWebhook(
  eventHeader: string,
  payload: Record<string, unknown>,
  opts: PatreonEntitlementOpts = {},
): PatreonEntitlementResult {
  const now = opts.nowMs ?? Date.now();
  const data = (payload?.data ?? {}) as Record<string, unknown>;
  const attrs = (data?.attributes ?? {}) as Record<string, unknown>;
  const rels = (data?.relationships ?? {}) as Record<string, unknown>;
  const included = Array.isArray(payload?.included) ? (payload.included as Record<string, unknown>[]) : [];

  // Campaign filter (optional if creator runs multiple Patreon pages)
  const campaignData = (rels?.campaign as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
  const campaignId = campaignData?.id ? String(campaignData.id) : null;
  if (opts.campaignId && campaignId && campaignId !== opts.campaignId) {
    return { patreonUserId: null, email: null, patronStatus: 'other_campaign', entitledCents: 0, tier: 'none', expiresAt: 0, resetJokers: false };
  }

  const userData = (rels?.user as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined;
  const patreonUserId = userData?.id ? String(userData.id) : null;
  const includedUser = included.find((x) => x?.type === 'user' && (!patreonUserId || String(x?.id) === patreonUserId));
  const userAttrs = (includedUser?.attributes ?? {}) as Record<string, unknown>;
  const rawEmail = String(attrs.email ?? userAttrs.email ?? '').trim().toLowerCase();
  const email = rawEmail.includes('@') ? rawEmail : null;

  const isDelete = eventHeader.includes('delete');
  const patronStatus = isDelete ? 'former_patron' : String(attrs.patron_status ?? 'none');
  const entitledCents = isDelete ? 0 : Math.max(0, Math.round(Number(attrs.currently_entitled_amount_cents ?? attrs.pledge_amount_cents ?? 0)));
  const tier = tierFromPatreonCents(patronStatus, entitledCents, opts);
  const expiresAt = tier === 'none' ? 0 : now + PATREON_RENEWAL_BUFFER_MS;

  return {
    patreonUserId,
    email,
    patronStatus,
    entitledCents,
    tier,
    expiresAt,
    resetJokers: tier !== 'none' && eventHeader.includes('create'),
  };
}

/** Parse Patreon API v2 OAuth `/identity?include=memberships` JSON response. */
export function parsePatreonIdentity(
  payload: Record<string, unknown>,
  opts: PatreonEntitlementOpts = {},
): PatreonEntitlementResult {
  const now = opts.nowMs ?? Date.now();
  const data = (payload?.data ?? {}) as Record<string, unknown>;
  const userAttrs = (data?.attributes ?? {}) as Record<string, unknown>;
  const patreonUserId = data?.id ? String(data.id) : null;
  const rawEmail = String(userAttrs.email ?? '').trim().toLowerCase();
  const email = rawEmail.includes('@') ? rawEmail : null;
  const included = Array.isArray(payload?.included) ? (payload.included as Record<string, unknown>[]) : [];

  let bestStatus = 'none';
  let bestCents = 0;
  for (const item of included) {
    if (item?.type !== 'member') continue;
    const rels = (item?.relationships ?? {}) as Record<string, unknown>;
    const cId = ((rels?.campaign as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.id;
    if (opts.campaignId && cId && String(cId) !== opts.campaignId) continue;
    const ma = (item?.attributes ?? {}) as Record<string, unknown>;
    const st = String(ma.patron_status ?? 'none');
    const cents = Math.max(0, Math.round(Number(ma.currently_entitled_amount_cents ?? 0)));
    if (st === 'active_patron' && cents >= bestCents) {
      bestStatus = st;
      bestCents = cents;
    }
  }

  const tier = tierFromPatreonCents(bestStatus, bestCents, opts);
  return {
    patreonUserId,
    email,
    patronStatus: bestStatus,
    entitledCents: bestCents,
    tier,
    expiresAt: tier === 'none' ? 0 : now + PATREON_RENEWAL_BUFFER_MS,
    resetJokers: false,
  };
}
