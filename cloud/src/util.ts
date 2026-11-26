// Helpers shared by the API and the race room.
import { driverGradeOf, isSubscriptionActive, type LicenseClass, type SubTier } from './ratings';

export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  /** secret salt for network hashes (wrangler secret put IP_SALT) */
  IP_SALT?: string;
  /** replay checker & steward key (wrangler secret put VERIFIER_KEY) */
  VERIFIER_KEY?: string;
  /** HMAC-SHA256 webhook secret for Stripe/Paddle subscription updates (wrangler secret put BILLING_SECRET) */
  BILLING_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  /** local tests only (.dev.vars): honour the x-test-ip header to simulate players on different networks */
  ALLOW_TEST_IP?: string;
}

export interface AccountRow {
  id: string; token_hash: string; name: string; created: number; xp: number; credits: number;
  cars: string; mods: string; skins: string; clean: number; strikes: number; banned: number; net: string | null;
  username: string | null; username_at: number | null; seen: number | null; party: string | null;
  looks: string;
  save_version?: number; save_prefs?: string; avatar_gear?: string;
  email?: string | null; password_hash?: string | null; password_salt?: string | null; email_verified?: number;
  sub_tier?: string; sub_expires_at?: number; billing_customer_id?: string | null;
  dr?: number; dr_rd?: number; sr?: number; license?: string; mpr_races?: number;
  rolling_cpi?: number; bad_sport?: number; clean_streak?: number; jokers_left?: number;
  starts?: number; wins?: number; podiums?: number; poles?: number;
  total_incidents?: number; total_corners?: number;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function cors(r: Response, env: Env) {
  if (r.status === 101) return r;   // WebSocket upgrade: headers are immutable
  const h = new Headers(r.headers);
  h.set('access-control-allow-origin', env.ALLOWED_ORIGINS === '*' || !env.ALLOWED_ORIGINS ? '*' : env.ALLOWED_ORIGINS.split(',')[0]);
  h.set('access-control-allow-headers', 'content-type, authorization, x-opengrid-signature');
  h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  return new Response(r.body, { status: r.status, headers: h });
}

export async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(n: number) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join('');
}

/** UTC day, for daily caps */
export const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/**
 * The player's network as a salted hash: an IPv4 address, or the /64 prefix of an IPv6 address (one household or one
 * phone line). The raw address is never stored.
 */
export async function netOf(req: Request, env: Env) {
  let ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  if (env.ALLOW_TEST_IP === '1' && req.headers.get('x-test-ip')) ip = req.headers.get('x-test-ip')!;
  if (env.ALLOW_TEST_IP === '1' && new URL(req.url).searchParams.get('testip')) ip = new URL(req.url).searchParams.get('testip')!;
  const key = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
  return (await sha256(`${env.IP_SALT ?? 'dev-salt'}|${key}`)).slice(0, 24);
}

/** The account from "Authorization: Bearer <id>.<token>" (or ?auth= on WebSockets, which cannot send headers). */
export async function accountOf(req: Request, env: Env): Promise<AccountRow | null> {
  const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('auth') || '';
  const [id, token] = raw.split('.');
  if (!id || !token || id.length > 40 || token.length > 200) return null;
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
  if (!row || row.token_hash !== (await sha256(token))) return null;
  return row;
}

export const profileOf = (a: AccountRow) => {
  const dr = Math.round((a.dr ?? 1500) * 10) / 10;
  const sr = Math.round((a.sr ?? 2.5) * 100) / 100;
  const subTier = (a.sub_tier ?? 'trial') as SubTier;
  const subExpiresAt = a.sub_expires_at ?? 0;
  return {
    id: a.id, name: a.username ?? a.name, username: a.username, usernameAt: a.username_at, xp: a.xp, credits: a.credits,
    email: a.email ?? null, hasPassword: !!a.password_hash,
    cars: JSON.parse(a.cars) as string[], mods: JSON.parse(a.mods), skins: JSON.parse(a.skins) as string[],
    looks: JSON.parse(a.looks ?? '{}') as Record<string, unknown>,
    saveVersion: a.save_version ?? 1,
    prefs: JSON.parse(a.save_prefs ?? '{}') as Record<string, unknown>,
    avatarGear: JSON.parse(a.avatar_gear ?? '{}') as Record<string, unknown>,
    clean: a.clean, strikes: a.strikes, banned: !!a.banned, created: a.created,
    // Competitive OpenGrid Network profile (iRacing / LMU / RaceRoom parity+)
    subTier,
    subExpiresAt,
    subActive: isSubscriptionActive(subTier, subExpiresAt),
    dr,
    drRd: Math.round((a.dr_rd ?? 180) * 10) / 10,
    drGrade: driverGradeOf(dr),
    sr,
    license: (a.license ?? 'R') as LicenseClass,
    mprRaces: a.mpr_races ?? 0,
    rollingCpi: Math.round((a.rolling_cpi ?? 25) * 100) / 100,
    badSport: !!(a.bad_sport ?? 0),
    cleanStreak: a.clean_streak ?? 0,
    jokersLeft: a.jokers_left ?? 2,
    stats: {
      starts: a.starts ?? 0,
      wins: a.wins ?? 0,
      podiums: a.podiums ?? 0,
      poles: a.poles ?? 0,
      incidents: a.total_incidents ?? 0,
      corners: a.total_corners ?? 0,
    },
  };
};

/** A confirmed cheat or severe steward verdict: a strike; three bar the account from ranked races. */
export async function strike(env: Env, account: string) {
  await env.DB.prepare('UPDATE accounts SET strikes = strikes + 1, banned = CASE WHEN strikes + 1 >= 3 THEN 1 ELSE banned END WHERE id = ?').bind(account).run();
}
