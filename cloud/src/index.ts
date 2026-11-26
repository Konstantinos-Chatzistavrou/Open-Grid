// Open Grid online service (Cloudflare Worker — Ad-Free Subscription Moat + Real Email/Password Auth).
// Auth & Profile:
//   POST /v1/account                  anonymous guest account (7-day ad-free Rookie trial; max 5/net/day)
//   POST /v1/auth/register            real email + PBKDF2-SHA256 password signup (or upgrades current guest account!)
//   POST /v1/auth/login               email + password login (rate-limited, rotates token)
//   POST /v1/auth/logout              revokes current bearer token
//   POST /v1/auth/password            change password
//   GET  /v1/me, POST /v1/look, GET/POST /v1/username, GET/POST /v1/friends, POST /v1/presence, POST /v1/buy
//   GET/POST /v1/save                 monotonic version-checked cloud save
//   POST /v1/wager/lock, /v1/wager/settle  two-party / server-race-verified escrow settlement
// Competitive Online Moat (Subscription: 7-day Trial / OpenGrid Pro — ZERO ads!):
//   GET  /v1/subscription, POST /v1/billing/webhook (HMAC-SHA256 signed Stripe/Paddle webhook)
//   GET  /v1/schedule, POST /v1/schedule/register, POST /v1/schedule/withdraw, POST /v1/schedule/seed
//   GET  /v1/championships            official seasonal SOF-weighted standings (car lock + drop weeks)
//   POST /v1/protests, GET /v1/protests, POST /v1/protests/:id/resolve (Restorative Protests: refunds victim DR & SR!)
//   POST /v1/joker                    Season Disconnect Joker (restores unforced disconnect DR/SR loss)
//   GET  /v1/leaderboards, POST /v1/hotlap (verified global hotlaps + ghost/telemetry hash)
//   GET/POST /v1/teams                Endurance Teams & rosters
//   GET  /v1/room/:party              WebSocket RaceRoom Durable Object (room.ts)
//   GET  /v1/replays/pending, POST /v1/replays/:race/:account (VERIFIER_KEY)
import { CAR_REQ, CAR_VMAX_KMH, MOD_REQ, SKIN_REQ, levelOf } from '../../web/src/progression';
import { cleanCustom } from '../../web/src/custom-data';
import { usernameError } from '../../web/src/username';
import { emailError, hashPassword, hmacSha256Hex, normalizeEmail, passwordError, timingSafeEqualHex, verifyPassword } from './auth';
import { DEFAULT_PRO_MIN_CENTS, DEFAULT_TEAM_MIN_CENTS, hmacMd5Hex, parsePatreonIdentity, parsePatreonWebhook } from './patreon';
import { paceOf } from './pace';
import {
  OFFICIAL_SERIES, TRIAL_DURATION_MS, computeRestorativeVerdict, currentSeasonId,
  getSeriesById, isSubscriptionActive, licenseRank, nextEventForSeries, seedBalancedSplits,
} from './ratings';
import { RaceRoom } from './room';
import { type Env, accountOf, cors, day, json, netOf, profileOf, randomId, sha256, strike, type AccountRow } from './util';

export { RaceRoom };

const MOD_KEYS = ['engine', 'tyres', 'weight', 'aero'] as const;
const RENAME_MS = 30 * 24 * 3600 * 1000;
const ONLINE_MS = 150_000;
const MAX_FRIENDS = 200;
const MAX_LOGIN_ATTEMPTS_15M = 10;
const PROTEST_TYPES = new Set(['intentional_wreck', 'unsafe_rejoin', 'blocking', 'ramming', 'chat_abuse']);

const byName = (env: Env, u: string) => env.DB.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE').bind(u).first<AccountRow>();
const byEmail = (env: Env, e: string) => env.DB.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE').bind(e).first<AccountRow>();

function requireActiveSub(acct: AccountRow): Response | null {
  if (isSubscriptionActive(acct.sub_tier, acct.sub_expires_at)) return null;
  return json({
    error: 'Your 7-day free trial ended. Official ranked splits, championships, and restorative protests are funded by our non-profit Patreon Pass (100% ad-free). Single-player, garage, cars, tracks, and private P2P lobbies remain free forever!',
    code: 'SUBSCRIPTION_REQUIRED',
  }, 402);
}

function patreonOpts(env: Env) {
  return {
    proMinCents: Number(env.PATREON_PRO_CENTS) || DEFAULT_PRO_MIN_CENTS,
    teamMinCents: Number(env.PATREON_TEAM_CENTS) || DEFAULT_TEAM_MIN_CENTS,
    campaignId: env.PATREON_CAMPAIGN_ID || undefined,
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    try { return cors(await route(req, env), env); }
    catch (e) { return cors(json({ error: (e as Error).message || 'server error' }, 500), env); }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/' || path === '/v1') return json({ service: 'opengrid', ok: true, season: currentSeasonId(), adFree: true });

  // ---- Patreon Non-Profit Supporter Webhook (HMAC-MD5 X-Patreon-Signature, $0/mo automated unlock!) ----
  if (path === '/v1/patreon/webhook' && req.method === 'POST') {
    if (!env.PATREON_WEBHOOK_SECRET) return json({ error: 'patreon webhook not configured' }, 503);
    const rawBody = await req.text();
    const sig = (req.headers.get('x-patreon-signature') ?? '').trim().toLowerCase();
    const expected = hmacMd5Hex(env.PATREON_WEBHOOK_SECRET, rawBody);
    if (!timingSafeEqualHex(sig, expected)) return json({ error: 'invalid patreon signature' }, 403);
    const evType = (req.headers.get('x-patreon-event') ?? 'members:pledge:update').toLowerCase();
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(rawBody); } catch { return json({ error: 'bad json' }, 400); }
    const ent = parsePatreonWebhook(evType, payload, patreonOpts(env));
    if (ent.patronStatus === 'other_campaign') return json({ ok: true, ignored: true });
    const custId = ent.patreonUserId ? `patreon:${ent.patreonUserId}` : null;
    let target: { id: string } | null = null;
    if (custId) {
      target = await env.DB.prepare('SELECT id FROM accounts WHERE billing_customer_id = ?').bind(custId).first<{ id: string }>();
    }
    if (!target && ent.email) {
      target = await env.DB.prepare('SELECT id FROM accounts WHERE LOWER(email) = ?').bind(ent.email).first<{ id: string }>();
    }
    if (!target) return json({ ok: true, matched: false });
    await env.DB.prepare(
      'UPDATE accounts SET sub_tier = ?, sub_expires_at = ?, billing_customer_id = COALESCE(?, billing_customer_id), jokers_left = CASE WHEN ? = 1 THEN 2 ELSE jokers_left END WHERE id = ?',
    ).bind(ent.tier, ent.expiresAt, custId, ent.resetJokers ? 1 : 0, target.id).run();
    return json({ ok: true, matched: true, accountId: target.id, tier: ent.tier });
  }

  // ---- Patreon OAuth2 Callback (1-click "Connect Patreon" -> instant D1 Pro activation) ----
  if (path === '/v1/patreon/callback' && req.method === 'GET') {
    if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) return new Response('Patreon OAuth not configured', { status: 503 });
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const [acctId, expStr, sig] = state.split('.');
    const exp = Number(expStr) || 0;
    const stateSecret = env.PATREON_CLIENT_SECRET + '|' + (env.IP_SALT ?? 'opengrid-patreon');
    const expectedSig = await hmacSha256Hex(stateSecret, `${acctId}.${exp}`);
    if (!code || !acctId || exp < Date.now() || !timingSafeEqualHex((sig ?? '').toLowerCase(), expectedSig)) {
      return new Response('Invalid or expired Patreon authorization link. Return to OpenGrid and try again.', { status: 400 });
    }
    const redirectUri = `${url.origin}/v1/patreon/callback`;
    const tokRes = await fetch('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: env.PATREON_CLIENT_ID,
        client_secret: env.PATREON_CLIENT_SECRET,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokRes.ok) return new Response('Could not verify Patreon login. Please try again from OpenGrid.', { status: 502 });
    const tok = await tokRes.json<{ access_token?: string }>();
    if (!tok.access_token) return new Response('Missing Patreon access token.', { status: 502 });
    const idRes = await fetch(
      'https://www.patreon.com/api/oauth2/v2/identity?include=memberships,memberships.campaign&fields%5Buser%5D=email,full_name&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents',
      { headers: { authorization: `Bearer ${tok.access_token}` } },
    );
    if (!idRes.ok) return new Response('Could not read Patreon membership status.', { status: 502 });
    const idJson = await idRes.json<Record<string, unknown>>();
    const ent = parsePatreonIdentity(idJson, patreonOpts(env));
    const custId = ent.patreonUserId ? `patreon:${ent.patreonUserId}` : null;
    await env.DB.prepare(
      'UPDATE accounts SET sub_tier = CASE WHEN ? != \'none\' THEN ? ELSE sub_tier END, sub_expires_at = CASE WHEN ? != \'none\' THEN ? ELSE sub_expires_at END, billing_customer_id = COALESCE(?, billing_customer_id) WHERE id = ?',
    ).bind(ent.tier, ent.tier, ent.tier, ent.expiresAt, custId, acctId).run();
    const okMsg = ent.tier !== 'none'
      ? `OpenGrid ${ent.tier === 'team_pro' ? 'Team Pro' : 'Pro'} Pass ACTIVATED! You can close this tab and click "Refresh Pass" in OpenGrid.`
      : 'Patreon linked, but no active OpenGrid supporter pledge was found yet. Subscribe on Patreon and click "Refresh Pass" in OpenGrid.';
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>OpenGrid Patreon</title><body style="background:#0d1017;color:#eef2ff;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><div style="max-width:460px;padding:28px;border:1px solid #ffffff22;border-radius:14px;background:#141925"><h2>🧡 OpenGrid Patreon Pass</h2><p>${okMsg}</p><p style="opacity:.7;font-size:13px">Thank you for funding our non-profit, 100% ad-free racing servers!</p></div></body>`,
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }

  // ---- Generic Admin Billing Webhook (HMAC-SHA256 signed with BILLING_SECRET for manual grants/giveaways) ----
  if (path === '/v1/billing/webhook' && req.method === 'POST') {
    if (!env.BILLING_SECRET) return json({ error: 'billing not configured' }, 503);
    const rawBody = await req.text();
    const sig = (req.headers.get('x-opengrid-signature') ?? '').trim().toLowerCase();
    const expected = await hmacSha256Hex(env.BILLING_SECRET, rawBody);
    if (!timingSafeEqualHex(sig, expected)) return json({ error: 'invalid signature' }, 403);
    const ev = JSON.parse(rawBody) as { accountId?: string; tier?: string; expiresAt?: number; customerId?: string; resetJokers?: boolean };
    if (!ev.accountId || !['none', 'trial', 'pro', 'team_pro'].includes(String(ev.tier))) return json({ error: 'bad billing event' }, 400);
    const exp = Math.max(0, Math.round(Number(ev.expiresAt) || 0));
    await env.DB.prepare(
      'UPDATE accounts SET sub_tier = ?, sub_expires_at = ?, billing_customer_id = COALESCE(?, billing_customer_id), jokers_left = CASE WHEN ? = 1 THEN 2 ELSE jokers_left END WHERE id = ?',
    ).bind(ev.tier, exp, ev.customerId ?? null, ev.resetJokers ? 1 : 0, ev.accountId).run();
    return json({ ok: true });
  }

  // ---- Anonymous Guest Account (7-day ad-free Rookie Online Trial included) ----
  if (path === '/v1/account' && req.method === 'POST') {
    const net = await netOf(req, env), today = day(), now = Date.now();
    const row = await env.DB.prepare('SELECT n FROM signups WHERE net = ? AND day = ?').bind(net, today).first<{ n: number }>();
    if ((row?.n ?? 0) >= 5) return json({ error: 'Too many new accounts from this network today.' }, 429);
    const id = randomId(12), token = randomId(32);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO accounts (id, token_hash, name, created, net, sub_tier, sub_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, await sha256(token), `Driver ${id.slice(0, 4).toUpperCase()}`, now, net, 'trial', now + TRIAL_DURATION_MS),
      env.DB.prepare('INSERT INTO signups (net, day, n) VALUES (?, ?, 1) ON CONFLICT (net, day) DO UPDATE SET n = n + 1').bind(net, today),
    ]);
    return json({ id, token });
  }

  // ---- Real Email + Password Registration (creates new OR upgrades existing guest account!) ----
  if (path === '/v1/auth/register' && req.method === 'POST') {
    const b = await req.json<{ email?: string; password?: string; username?: string }>();
    const email = normalizeEmail(b.email);
    const eErr = emailError(email);
    if (eErr) return json({ error: eErr }, 400);
    const pw = String(b.password ?? '');
    const pErr = passwordError(pw);
    if (pErr) return json({ error: pErr }, 400);
    if (await byEmail(env, email)) return json({ error: 'An account with that email already exists.' }, 409);

    const reqUsername = b.username ? String(b.username).trim() : '';
    if (reqUsername) {
      const uErr = usernameError(reqUsername);
      if (uErr) return json({ error: uErr }, 400);
      if (await byName(env, reqUsername)) return json({ error: 'That username is taken.' }, 409);
    }

    const { hash, salt } = await hashPassword(pw);
    const now = Date.now();
    // If caller already has a guest Bearer account without an email, upgrade it in place so they keep all progress!
    const existing = await accountOf(req, env);
    if (existing && !existing.email) {
      const newToken = randomId(32);
      const uFinal = reqUsername || existing.username;
      const nFinal = uFinal ?? existing.name;
      await env.DB.prepare(
        'UPDATE accounts SET email = ?, password_hash = ?, password_salt = ?, token_hash = ?, username = COALESCE(?, username), name = ?, username_at = COALESCE(username_at, ?) WHERE id = ?',
      ).bind(email, hash, salt, await sha256(newToken), reqUsername || null, nFinal, reqUsername ? now : null, existing.id).run();
      const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(existing.id).first<AccountRow>();
      return json({ id: existing.id, token: newToken, upgraded: true, profile: profileOf(fresh!) });
    }

    const net = await netOf(req, env), today = day(now);
    const row = await env.DB.prepare('SELECT n FROM signups WHERE net = ? AND day = ?').bind(net, today).first<{ n: number }>();
    if ((row?.n ?? 0) >= 5) return json({ error: 'Too many new accounts from this network today.' }, 429);
    const id = randomId(12), token = randomId(32);
    const dispName = reqUsername || `Driver ${id.slice(0, 4).toUpperCase()}`;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO accounts (id, token_hash, name, username, username_at, created, net, email, password_hash, password_salt, sub_tier, sub_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, await sha256(token), dispName, reqUsername || null, reqUsername ? now : null, now, net, email, hash, salt, 'trial', now + TRIAL_DURATION_MS),
      env.DB.prepare('INSERT INTO signups (net, day, n) VALUES (?, ?, 1) ON CONFLICT (net, day) DO UPDATE SET n = n + 1').bind(net, today),
    ]);
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
    return json({ id, token, upgraded: false, profile: profileOf(fresh!) });
  }

  // ---- Real Email + Password Login (brute-force protected, rotates bearer token) ----
  if (path === '/v1/auth/login' && req.method === 'POST') {
    const net = await netOf(req, env);
    const winMin = Math.floor(Date.now() / (15 * 60_000));
    const att = await env.DB.prepare('SELECT n FROM auth_attempts WHERE net = ? AND window_min = ?').bind(net, winMin).first<{ n: number }>();
    if ((att?.n ?? 0) >= MAX_LOGIN_ATTEMPTS_15M) return json({ error: 'Too many login attempts. Try again in 15 minutes.' }, 429);

    const b = await req.json<{ email?: string; password?: string }>();
    const email = normalizeEmail(b.email), pw = String(b.password ?? '');
    const row = email ? await byEmail(env, email) : null;
    const ok = row && row.password_hash && row.password_salt ? await verifyPassword(pw, row.password_hash, row.password_salt) : false;
    if (!ok || !row) {
      await env.DB.prepare('INSERT INTO auth_attempts (net, window_min, n) VALUES (?, ?, 1) ON CONFLICT (net, window_min) DO UPDATE SET n = n + 1').bind(net, winMin).run();
      return json({ error: 'Invalid email or password.' }, 401);
    }
    const token = randomId(32);
    await env.DB.prepare('UPDATE accounts SET token_hash = ?, seen = ? WHERE id = ?').bind(await sha256(token), Date.now(), row.id).run();
    return json({ id: row.id, token, profile: profileOf(row) });
  }

  // ---- Verifier / Steward Key Routes (GitHub Actions replay verifier + Restorative Stewarding) ----
  if (path.startsWith('/v1/replays')) {
    if (!env.VERIFIER_KEY || req.headers.get('authorization') !== `Bearer ${env.VERIFIER_KEY}`) return json({ error: 'forbidden' }, 403);
    if (path === '/v1/replays/pending' && req.method === 'GET') {
      const r = await env.DB.prepare("SELECT race, account, claimed_ms, data FROM replays WHERE status = 'uploaded' LIMIT 20").all();
      return json({ replays: r.results });
    }
    const m = /^\/v1\/replays\/([^/]+)\/([^/]+)$/.exec(path);
    if (m && req.method === 'POST') {
      const { verdict } = await req.json<{ verdict: 'ok' | 'mismatch' | 'unverifiable' }>();
      if (!['ok', 'mismatch', 'unverifiable'].includes(verdict)) return json({ error: 'bad verdict' }, 400);
      await env.DB.prepare('UPDATE replays SET status = ?, data = NULL WHERE race = ? AND account = ?').bind(verdict, m[1], m[2]).run();
      if (verdict === 'mismatch') await strike(env, m[2]);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  // Steward resolution endpoint for Restorative Protests (VERIFIER_KEY)
  const protestResolve = /^\/v1\/protests\/([^/]+)\/resolve$/.exec(path);
  if (protestResolve && req.method === 'POST') {
    if (!env.VERIFIER_KEY || req.headers.get('authorization') !== `Bearer ${env.VERIFIER_KEY}`) return json({ error: 'forbidden' }, 403);
    const b = await req.json<{ status?: 'upheld' | 'dismissed'; note?: string }>();
    if (b.status !== 'upheld' && b.status !== 'dismissed') return json({ error: 'bad verdict' }, 400);
    const p = await env.DB.prepare("SELECT * FROM protests WHERE id = ? AND status = 'open'").bind(protestResolve[1]).first<{
      id: string; race_id: string; reporter: string; accused: string; incident_type: string;
    }>();
    if (!p) return json({ error: 'open protest not found' }, 404);

    let drRefund = 0, srRefund = 0;
    const stmts: D1PreparedStatement[] = [];
    if (b.status === 'upheld') {
      const ledger = await env.DB.prepare('SELECT * FROM race_rating_ledger WHERE race_id = ? AND account = ? AND refunded = 0')
        .bind(p.race_id, p.reporter).first<{ dr_before: number; dr_after: number; sr_before: number; sr_after: number }>();
      const v = computeRestorativeVerdict(
        ledger?.dr_before ?? 1500, ledger?.dr_after ?? 1500,
        ledger?.sr_before ?? 2.5, ledger?.sr_after ?? 2.5,
        p.incident_type,
      );
      drRefund = v.drRefund;
      srRefund = v.srRefund;
      if (ledger && (drRefund > 0 || srRefund > 0)) {
        stmts.push(env.DB.prepare('UPDATE accounts SET dr = MIN(3500, dr + ?), sr = MIN(4.99, sr + ?) WHERE id = ?').bind(drRefund, srRefund, p.reporter));
        stmts.push(env.DB.prepare('UPDATE race_rating_ledger SET refunded = 1 WHERE race_id = ? AND account = ?').bind(p.race_id, p.reporter));
      }
      stmts.push(env.DB.prepare(
        'UPDATE accounts SET sr = MAX(0.0, sr - ?), bad_sport = CASE WHEN ? = 1 THEN 1 ELSE bad_sport END, strikes = strikes + ?, banned = CASE WHEN strikes + ? >= 3 THEN 1 ELSE banned END WHERE id = ?',
      ).bind(v.offenderSrPenalty, v.offenderQuarantine ? 1 : 0, v.offenderStrike ? 1 : 0, v.offenderStrike ? 1 : 0, p.accused));
    }
    stmts.push(env.DB.prepare('UPDATE protests SET status = ?, verdict_note = ?, dr_refunded = ?, sr_refunded = ?, resolved_at = ? WHERE id = ?')
      .bind(b.status, String(b.note ?? '').slice(0, 300), drRefund, srRefund, Date.now(), p.id));
    await env.DB.batch(stmts);
    return json({ ok: true, status: b.status, drRefunded: drRefund, srRefunded: srRefund });
  }

  // ---- WebSocket RaceRoom ----
  const room = /^\/v1\/room\/([A-Za-z0-9]{4,10})$/.exec(path);
  if (room) {
    if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'websocket expected' }, 426);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room[1].toUpperCase()));
    return stub.fetch(req);
  }

  // ---- Public Read-Only Endpoints ----
  if (path === '/v1/username' && req.method === 'GET') {
    const u = (url.searchParams.get('u') ?? '').trim(), err = usernameError(u);
    if (err) return json({ ok: false, error: err });
    return json((await byName(env, u)) ? { ok: false, error: 'That username is taken.' } : { ok: true });
  }

  if (path === '/v1/schedule' && req.method === 'GET') {
    const now = Date.now();
    const maybeAcct = await accountOf(req, env);
    const events = [];
    for (const s of OFFICIAL_SERIES) {
      const ev = nextEventForSeries(s, now);
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM series_entries WHERE event_key = ? AND status IN ('registered','seeded')").bind(ev.eventKey).first<{ n: number }>();
      let myEntry: { status: string; split_no: number | null; party_code: string | null; sof: number | null; car: string } | null = null;
      if (maybeAcct) {
        myEntry = await env.DB.prepare('SELECT status, split_no, party_code, sof, car FROM series_entries WHERE event_key = ? AND account = ?')
          .bind(ev.eventKey, maybeAcct.id).first();
      }
      events.push({
        ...s,
        ...ev,
        registrants: cnt?.n ?? 0,
        eligible: maybeAcct ? licenseRank(maybeAcct.license ?? 'R') >= licenseRank(s.minLicense) : s.minLicense === 'R',
        myEntry,
      });
    }
    return json({ season: currentSeasonId(now), adFree: true, events });
  }

  if (path === '/v1/championships' && req.method === 'GET') {
    const season = url.searchParams.get('season') || currentSeasonId();
    const seriesId = url.searchParams.get('series') || 'gt3_championship';
    const rows = await env.DB.prepare(
      `SELECT c.account, COALESCE(a.username, a.name) AS name, a.license, a.dr, c.locked_car, c.points, c.starts, c.wins, c.podiums
       FROM championship_standings c JOIN accounts a ON a.id = c.account
       WHERE c.season_id = ? AND c.series_id = ? ORDER BY c.points DESC, c.wins DESC LIMIT 100`,
    ).bind(season, seriesId).all();
    return json({ season, seriesId, standings: rows.results });
  }

  if (path === '/v1/leaderboards' && req.method === 'GET') {
    const track = String(url.searchParams.get('track') || 'nyc').slice(0, 40);
    const car = String(url.searchParams.get('car') || '').slice(0, 40);
    const weather = String(url.searchParams.get('weather') || 'dry').slice(0, 20);
    const q = car
      ? env.DB.prepare('SELECT id, track, car, weather, account, username, lap_ms, sectors_json, telemetry_hash, created FROM hotlaps WHERE track = ? AND car = ? AND weather = ? AND verified = 1 ORDER BY lap_ms ASC LIMIT 100').bind(track, car, weather)
      : env.DB.prepare('SELECT id, track, car, weather, account, username, lap_ms, sectors_json, telemetry_hash, created FROM hotlaps WHERE track = ? AND weather = ? AND verified = 1 ORDER BY lap_ms ASC LIMIT 100').bind(track, weather);
    const rows = await q.all();
    return json({ track, car: car || 'all', weather, entries: rows.results });
  }

  // ---- Authenticated Account Routes ----
  const acct = await accountOf(req, env);
  if (!acct) return json({ error: 'sign in again (unknown account)' }, 401);

  if (path === '/v1/me' && req.method === 'GET') return json(profileOf(acct));

  if (path === '/v1/auth/logout' && req.method === 'POST') {
    await env.DB.prepare('UPDATE accounts SET token_hash = ? WHERE id = ?').bind(await sha256(randomId(32)), acct.id).run();
    return json({ ok: true });
  }

  if (path === '/v1/auth/password' && req.method === 'POST') {
    const b = await req.json<{ currentPassword?: string; newPassword?: string }>();
    if (acct.password_hash && acct.password_salt) {
      const ok = await verifyPassword(String(b.currentPassword ?? ''), acct.password_hash, acct.password_salt);
      if (!ok) return json({ error: 'Current password is incorrect.' }, 401);
    }
    const newPw = String(b.newPassword ?? '');
    const pErr = passwordError(newPw);
    if (pErr) return json({ error: pErr }, 400);
    const { hash, salt } = await hashPassword(newPw);
    const token = randomId(32);
    await env.DB.prepare('UPDATE accounts SET password_hash = ?, password_salt = ?, token_hash = ? WHERE id = ?')
      .bind(hash, salt, await sha256(token), acct.id).run();
    return json({ ok: true, id: acct.id, token });
  }

  if (path === '/v1/subscription' && req.method === 'GET') {
    const tier = acct.sub_tier ?? 'trial';
    const exp = acct.sub_expires_at ?? 0;
    const active = isSubscriptionActive(tier, exp);
    const daysLeft = exp > Date.now() ? Math.ceil((exp - Date.now()) / 86_400_000) : 0;
    const opts = patreonOpts(env);
    const patreonOAuthEnabled = Boolean(env.PATREON_CLIENT_ID && env.PATREON_CLIENT_SECRET);
    return json({
      tier, active, expiresAt: exp, daysLeft, adFree: true, nonProfit: true,
      patreonUrl: env.PATREON_URL || null,
      patreonConnected: Boolean(acct.billing_customer_id?.startsWith('patreon:')),
      patreonOAuthEnabled,
      proMinUsd: opts.proMinCents / 100,
      teamMinUsd: opts.teamMinCents / 100,
      benefits: [
        '100% Non-Profit & Ad-Free: Patreon funds our official online servers & D1 cloud database',
        'Scheduled 20m / 45m / 60m SOF Splits & License Ladder (R -> PRO)',
        'Official Multi-Week Championships & Multiclass Endurance Teams',
        'Fault-Aware Safety Rating (0x Victim Shield) & Restorative Protests (DR/SR Refunds)',
        'Season Disconnect Jokers & C++20 Verified Global Hotlap Leaderboards',
        'Hosted Private Leagues & Custom Rules',
        'Zero Hostage Content: All Cars, Tracks, SP & Private P2P Stay Free Forever',
      ],
    });
  }

  // ---- Patreon OAuth2 Start URL (signed CSRF state tied to this OpenGrid account) ----
  if (path === '/v1/patreon/connect' && req.method === 'GET') {
    if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) {
      return json({ error: 'Patreon OAuth is not configured yet — use the same email on Patreon & OpenGrid for automatic webhook unlock!' }, 503);
    }
    const exp = Date.now() + 15 * 60_000;
    const stateSecret = env.PATREON_CLIENT_SECRET + '|' + (env.IP_SALT ?? 'opengrid-patreon');
    const sig = await hmacSha256Hex(stateSecret, `${acct.id}.${exp}`);
    const state = `${acct.id}.${exp}.${sig}`;
    const redirectUri = `${url.origin}/v1/patreon/callback`;
    const authUrl = `https://www.patreon.com/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(env.PATREON_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent('identity identity[email] identity.memberships')}&state=${encodeURIComponent(state)}`;
    return json({ url: authUrl });
  }

  // ---- Hosted Private Leagues (Custom Rules, BoP, Passwords & Community Stewards) ----
  if (path === '/v1/leagues' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT l.id, l.name, l.join_code AS code, l.join_code, l.owner, l.config_json, l.max_drivers, l.created,
              CASE WHEN l.password_hash IS NOT NULL THEN 1 ELSE 0 END AS is_private,
              (SELECT COUNT(*) FROM league_members x WHERE x.league_id = l.id) AS member_count
       FROM leagues l ORDER BY l.created DESC LIMIT 50`,
    ).all();
    const leagues = (rows.results as Record<string, unknown>[]).map((r) => {
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(String(r.config_json ?? '{}')); } catch { /* default */ }
      return {
        ...r,
        description: String(cfg.description ?? 'Custom OpenGrid League'),
        series_rules: `${cfg.laps ?? 5}L · ${cfg.bop !== false ? 'BoP' : 'Open'} · ${cfg.realism !== false ? 'Realism' : 'Respawns'}`,
        bop_enabled: cfg.bop !== false ? 1 : 0,
      };
    });
    return json({ leagues });
  }

  if (path === '/v1/leagues' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    const b = await req.json<{ name?: string; description?: string; password?: string; laps?: number; realism?: boolean; bop?: boolean; route?: string; maxDrivers?: number }>();
    const name = String(b.name ?? '').trim().slice(0, 40);
    if (name.length < 3) return json({ error: 'League name must be at least 3 characters.' }, 400);
    const pw = b.password ? String(b.password) : '';
    const hashed = pw ? await hashPassword(pw) : null;
    const lid = randomId(12);
    const joinCode = `LG${randomId(6).toUpperCase()}`;
    const cfg = JSON.stringify({
      description: String(b.description ?? '').trim().slice(0, 120),
      laps: Math.max(1, Math.min(20, Math.round(Number(b.laps) || 5))),
      realism: b.realism !== false,
      bop: b.bop !== false,
      route: b.route === 'city' ? 'city' : 'nyc',
    });
    const maxDrivers = Math.max(4, Math.min(64, Math.round(Number(b.maxDrivers) || 32)));
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO leagues (id, name, join_code, owner, password_hash, password_salt, config_json, max_drivers, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(lid, name, joinCode, acct.id, hashed?.hash ?? null, hashed?.salt ?? null, cfg, maxDrivers, now),
        env.DB.prepare("INSERT INTO league_members (league_id, account, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(lid, acct.id, now),
      ]);
    } catch {
      return json({ error: 'That league name is already taken.' }, 409);
    }
    return json({ ok: true, id: lid, name, code: joinCode, joinCode, isPrivate: Boolean(hashed), config: JSON.parse(cfg) });
  }

  if (path === '/v1/leagues/join' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    const b = await req.json<{ code?: string; joinCode?: string; password?: string }>();
    const code = String(b.joinCode ?? b.code ?? '').trim().toUpperCase().slice(0, 16);
    const lg = await env.DB.prepare('SELECT * FROM leagues WHERE join_code = ?').bind(code).first<{
      id: string; name: string; join_code: string; password_hash: string | null; password_salt: string | null; max_drivers: number;
    }>();
    if (!lg) return json({ error: 'No league with that join code.' }, 404);
    if (lg.password_hash && lg.password_salt) {
      const ok = await verifyPassword(String(b.password ?? ''), lg.password_hash, lg.password_salt);
      if (!ok) return json({ error: 'Incorrect league password.' }, 403);
    }
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM league_members WHERE league_id = ?').bind(lg.id).first<{ n: number }>();
    if ((cnt?.n ?? 0) >= lg.max_drivers) return json({ error: 'This league is full.' }, 409);
    await env.DB.prepare("INSERT OR IGNORE INTO league_members (league_id, account, role, joined_at) VALUES (?, ?, 'driver', ?)").bind(lg.id, acct.id, Date.now()).run();
    return json({ ok: true, id: lg.id, leagueId: lg.id, name: lg.name, code: lg.join_code, joinCode: lg.join_code });
  }

  // ---- Scheduled Official Series Registration & Balanced SOF Split Seeding ----
  if (path === '/v1/schedule/register' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    if (acct.banned) return json({ error: 'This account is barred from official ranked racing.' }, 403);
    const b = await req.json<{ seriesId?: string; car?: string }>();
    const series = getSeriesById(String(b.seriesId ?? ''));
    if (!series) return json({ error: 'unknown series' }, 400);
    if (licenseRank(acct.license ?? 'R') < licenseRank(series.minLicense)) {
      return json({ error: `Requires Class ${series.minLicense} license (you hold Class ${acct.license ?? 'R'}).` }, 403);
    }
    const car = String(b.car ?? 'vela_gt');
    if (!(car in CAR_VMAX_KMH)) return json({ error: 'no such car' }, 400);
    const owned: string[] = JSON.parse(acct.cars);
    if (car !== 'vela_gt' && !owned.includes(car)) return json({ error: 'You do not own that car.' }, 403);
    const ev = nextEventForSeries(series);
    await env.DB.prepare(
      `INSERT INTO series_entries (event_key, series_id, account, car, dr, sr, license, bad_sport, status, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)
       ON CONFLICT (event_key, account) DO UPDATE SET car = excluded.car, dr = excluded.dr, sr = excluded.sr, bad_sport = excluded.bad_sport, status = 'registered', registered_at = excluded.registered_at`,
    ).bind(ev.eventKey, series.id, acct.id, car, acct.dr ?? 1500, acct.sr ?? 2.5, acct.license ?? 'R', acct.bad_sport ?? 0, Date.now()).run();
    const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM series_entries WHERE event_key = ? AND status IN ('registered','seeded')").bind(ev.eventKey).first<{ n: number }>();
    return json({ ok: true, eventKey: ev.eventKey, seriesId: series.id, startsAt: ev.startsAt, registrants: cnt?.n ?? 1 });
  }

  if (path === '/v1/schedule/withdraw' && req.method === 'POST') {
    const b = await req.json<{ eventKey?: string }>();
    if (!b.eventKey) return json({ error: 'missing eventKey' }, 400);
    await env.DB.prepare("UPDATE series_entries SET status = 'withdrawn' WHERE event_key = ? AND account = ?").bind(String(b.eventKey), acct.id).run();
    return json({ ok: true });
  }

  if (path === '/v1/schedule/seed' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    const b = await req.json<{ eventKey?: string }>();
    const eventKey = String(b.eventKey ?? '');
    const seriesId = eventKey.split(':')[0];
    const series = getSeriesById(seriesId);
    if (!series) return json({ error: 'unknown eventKey' }, 400);
    const rows = await env.DB.prepare("SELECT account, dr, sr, bad_sport FROM series_entries WHERE event_key = ? AND status IN ('registered','seeded')").bind(eventKey).all<{
      account: string; dr: number; sr: number; bad_sport: number;
    }>();
    const splits = seedBalancedSplits(
      eventKey,
      rows.results.map((r) => ({ account: r.account, dr: r.dr, sr: r.sr, badSport: !!r.bad_sport })),
      series.maxPerSplit,
    );
    const stmts: D1PreparedStatement[] = [];
    let mySplit: { splitNo: number; sof: number; partyCode: string; badSportSplit: boolean; drivers: number } | null = null;
    for (const sp of splits) {
      for (const a of sp.accounts) {
        stmts.push(env.DB.prepare("UPDATE series_entries SET split_no = ?, sof = ?, party_code = ?, status = 'seeded' WHERE event_key = ? AND account = ?")
          .bind(sp.splitNo, sp.sof, sp.partyCode, eventKey, a));
        if (a === acct.id) mySplit = { splitNo: sp.splitNo, sof: sp.sof, partyCode: sp.partyCode, badSportSplit: sp.badSportSplit, drivers: sp.accounts.length };
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, eventKey, totalSplits: splits.length, mySplit, splits: splits.map((s) => ({ splitNo: s.splitNo, sof: s.sof, badSportSplit: s.badSportSplit, drivers: s.accounts.length })) });
  }

  // ---- Restorative Protests (file & inspect) ----
  if (path === '/v1/protests' && req.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, race_id, accused, incident_type, lap, corner, status, verdict_note, dr_refunded, sr_refunded, created, resolved_at FROM protests WHERE reporter = ? ORDER BY created DESC LIMIT 30').bind(acct.id).all();
    return json({ protests: rows.results });
  }

  if (path === '/v1/protests' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    const b = await req.json<{ raceId?: string; accused?: string; incidentType?: string; lap?: number; corner?: string; notes?: string; replayClip?: string }>();
    const raceId = String(b.raceId ?? '').slice(0, 40);
    const accused = String(b.accused ?? '').slice(0, 40);
    const itype = String(b.incidentType ?? 'ramming');
    if (!raceId || !accused || accused === acct.id || !PROTEST_TYPES.has(itype)) return json({ error: 'invalid protest' }, 400);
    const clip = typeof b.replayClip === 'string' ? b.replayClip.slice(0, 200_000) : null;
    const pid = randomId(14);
    await env.DB.prepare(
      "INSERT INTO protests (id, race_id, reporter, accused, incident_type, lap, corner, notes, replay_clip, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
    ).bind(pid, raceId, acct.id, accused, itype, Math.max(1, Math.round(Number(b.lap) || 1)), String(b.corner ?? '').slice(0, 60), String(b.notes ?? '').slice(0, 400), clip, Date.now()).run();
    return json({ ok: true, protestId: pid });
  }

  // ---- Season Disconnect Joker (LMU-inspired unforced disconnect DR/SR shield!) ----
  if (path === '/v1/joker' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    if ((acct.jokers_left ?? 0) <= 0) return json({ error: 'No season Disconnect Jokers remaining.' }, 400);
    const b = await req.json<{ raceId?: string }>();
    const raceId = String(b.raceId ?? '').slice(0, 40);
    const ledger = await env.DB.prepare('SELECT * FROM race_rating_ledger WHERE race_id = ? AND account = ? AND disconnected = 1 AND joker_used = 0')
      .bind(raceId, acct.id).first<{ dr_before: number; dr_after: number; sr_before: number; sr_after: number; created: number }>();
    if (!ledger) return json({ error: 'No eligible disconnected race found for a Joker.' }, 404);
    if (Date.now() - ledger.created > 24 * 3600_000) return json({ error: 'Disconnect Jokers must be claimed within 24 hours.' }, 400);
    const drRestore = Math.max(0, ledger.dr_before - ledger.dr_after);
    const srRestore = Math.max(0, ledger.sr_before - ledger.sr_after);
    await env.DB.batch([
      env.DB.prepare('UPDATE accounts SET dr = MIN(3500, dr + ?), sr = MIN(4.99, sr + ?), jokers_left = jokers_left - 1 WHERE id = ? AND jokers_left > 0')
        .bind(drRestore, srRestore, acct.id),
      env.DB.prepare('UPDATE race_rating_ledger SET joker_used = 1, refunded = 1 WHERE race_id = ? AND account = ?').bind(raceId, acct.id),
    ]);
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
    return json({ ok: true, drRestored: Math.round(drRestore * 10) / 10, srRestored: Math.round(srRestore * 100) / 100, profile: profileOf(fresh!) });
  }

  // ---- Verified Global Hotlap / Time Trial Submission ----
  if (path === '/v1/hotlap' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    if (acct.banned) return json({ error: 'Account barred from official leaderboards.' }, 403);
    const b = await req.json<{ track?: string; car?: string; weather?: string; lapMs?: number; trackLengthM?: number; sectors?: number[]; telemetryHash?: string; ghostData?: string }>();
    const track = String(b.track ?? '').slice(0, 40), car = String(b.car ?? ''), weather = String(b.weather ?? 'dry').slice(0, 20);
    const lapMs = Math.round(Number(b.lapMs) || 0);
    const trackLenM = Math.max(800, Math.min(30_000, Number(b.trackLengthM) || 3200));
    if (!track || !(car in CAR_VMAX_KMH) || lapMs < 10_000 || lapMs > 1_800_000) return json({ error: 'invalid hotlap' }, 400);
    const avgKmh = (trackLenM / (lapMs / 1000)) * 3.6;
    if (paceOf(avgKmh, CAR_VMAX_KMH[car]) === 'impossible') {
      await strike(env, acct.id);
      return json({ error: 'Impossible lap time rejected by anti-cheat.' }, 400);
    }
    const existing = await env.DB.prepare('SELECT lap_ms FROM hotlaps WHERE track = ? AND car = ? AND weather = ? AND account = ?')
      .bind(track, car, weather, acct.id).first<{ lap_ms: number }>();
    if (existing && existing.lap_ms <= lapMs) return json({ ok: true, personalBest: false, bestLapMs: existing.lap_ms });
    const sectors = Array.isArray(b.sectors) ? JSON.stringify(b.sectors.slice(0, 12).map((x) => Math.round(Number(x) || 0))) : '[]';
    const ghost = typeof b.ghostData === 'string' ? b.ghostData.slice(0, 180_000) : null;
    await env.DB.prepare(
      `INSERT INTO hotlaps (id, track, car, weather, account, username, lap_ms, sectors_json, telemetry_hash, ghost_data, verified, created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (track, car, weather, account) DO UPDATE SET lap_ms = excluded.lap_ms, username = excluded.username, sectors_json = excluded.sectors_json, telemetry_hash = excluded.telemetry_hash, ghost_data = excluded.ghost_data, created = excluded.created`,
    ).bind(randomId(14), track, car, weather, acct.id, acct.username ?? acct.name, lapMs, sectors, String(b.telemetryHash ?? '').slice(0, 64), ghost, Date.now()).run();
    return json({ ok: true, personalBest: true, bestLapMs: lapMs });
  }

  // ---- Endurance Teams ----
  if (path === '/v1/teams' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT t.id, t.name, t.tag, t.owner, m.role, t.created FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.account = ? ORDER BY t.created DESC',
    ).bind(acct.id).all();
    return json({ teams: rows.results });
  }

  if (path === '/v1/teams' && req.method === 'POST') {
    const subErr = requireActiveSub(acct);
    if (subErr) return subErr;
    const b = await req.json<{ name?: string; tag?: string }>();
    const name = String(b.name ?? '').trim().slice(0, 32);
    const tag = String(b.tag ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (name.length < 3 || tag.length < 2) return json({ error: 'Team name (3+ chars) and tag (2-5 chars) required.' }, 400);
    const tid = randomId(12), now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO teams (id, name, tag, owner, created) VALUES (?, ?, ?, ?, ?)').bind(tid, name, tag, acct.id, now),
        env.DB.prepare("INSERT INTO team_members (team_id, account, role, joined_at) VALUES (?, ?, 'owner', ?)").bind(tid, acct.id, now),
      ]);
    } catch {
      return json({ error: 'That team name is already taken.' }, 409);
    }
    return json({ ok: true, id: tid, name, tag });
  }

  // ---- Car Looks, Username, Friends, Presence, Shop (Free Forever!) ----
  if (path === '/v1/look' && req.method === 'POST') {
    const b = await req.json<{ car?: unknown; look?: unknown }>();
    const car = String(b.car ?? '');
    if (!(car in CAR_VMAX_KMH)) return json({ error: 'no such car' }, 400);
    const looks = JSON.parse(acct.looks || '{}') as Record<string, unknown>;
    looks[car] = cleanCustom(b.look);
    const next = JSON.stringify(looks);
    if (Object.keys(looks).length > 16 || next.length > 8192) return json({ error: 'too many saved looks' }, 400);
    await env.DB.prepare('UPDATE accounts SET looks = ? WHERE id = ?').bind(next, acct.id).run();
    return json(profileOf({ ...acct, looks: next }));
  }

  if ((path === '/v1/username' || path === '/v1/name') && req.method === 'POST') {
    const b = await req.json<{ username?: string; name?: string }>();
    const u = String(b.username ?? b.name ?? '').trim(), err = usernameError(u);
    if (err) return json({ error: err }, 400);
    if (acct.username === u) return json(profileOf(acct));
    const sameIgnoringCase = acct.username?.toLowerCase() === u.toLowerCase();
    if (acct.username && !sameIgnoringCase && acct.username_at && Date.now() - acct.username_at < RENAME_MS) {
      const days = Math.ceil((acct.username_at + RENAME_MS - Date.now()) / 86_400_000);
      return json({ error: `You can change your username again in ${days} day${days > 1 ? 's' : ''}.` }, 429);
    }
    const at = sameIgnoringCase ? acct.username_at : Date.now();
    try {
      await env.DB.prepare('UPDATE accounts SET username = ?, name = ?, username_at = ? WHERE id = ?').bind(u, u, at, acct.id).run();
    } catch {
      return json({ error: 'That username is taken.' }, 409);
    }
    return json(profileOf({ ...acct, username: u, name: u, username_at: at }));
  }

  if (path === '/v1/presence' && req.method === 'POST') {
    const b = await req.json<{ party?: string }>().catch(() => ({} as { party?: string }));
    const party = /^[A-Za-z0-9]{4,10}$/.test(String(b.party ?? '')) ? String(b.party).toUpperCase() : null;
    await env.DB.prepare('UPDATE accounts SET seen = ?, party = ? WHERE id = ?').bind(Date.now(), party, acct.id).run();
    return json({ ok: true });
  }

  if (path === '/v1/friends' && req.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT f.state, f.a, f.b, x.username, x.xp, x.seen, x.party, x.license, x.dr FROM friends f JOIN accounts x
      ON x.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE (f.a = ? OR (f.b = ? AND f.state = 'pending')) AND x.username IS NOT NULL ORDER BY x.username COLLATE NOCASE`)
      .bind(acct.id, acct.id, acct.id).all<{ state: string; a: string; b: string; username: string; xp: number; seen: number | null; party: string | null; license?: string; dr?: number }>();
    const now = Date.now(), friends = [], incoming = [], outgoing = [];
    for (const r of rows.results) {
      if (r.state === 'friends') {
        const online = !!r.seen && now - r.seen < ONLINE_MS;
        friends.push({ username: r.username, level: levelOf(r.xp).level, license: r.license ?? 'R', dr: Math.round(r.dr ?? 1500), online, party: online ? r.party : null, seenAgo: r.seen ? Math.max(0, now - r.seen) : null });
      } else if (r.a === acct.id) outgoing.push(r.username);
      else incoming.push(r.username);
    }
    return json({ friends, incoming, outgoing });
  }

  if (path === '/v1/friends' && req.method === 'POST') {
    const b = await req.json<{ username?: string; action?: string }>();
    if (!acct.username) return json({ error: 'Pick your username first.' }, 400);
    const other = await byName(env, String(b.username ?? '').trim());
    if (!other) return json({ error: 'No player with that username.' }, 404);
    if (other.id === acct.id) return json({ error: "That's you." }, 400);
    const get = (a: string, c: string) => env.DB.prepare('SELECT state FROM friends WHERE a = ? AND b = ?').bind(a, c).first<{ state: string }>();
    const mine = await get(acct.id, other.id), theirs = await get(other.id, acct.id);
    const both = () => env.DB.batch([
      env.DB.prepare("INSERT INTO friends (a, b, state, created) VALUES (?, ?, 'friends', ?) ON CONFLICT (a, b) DO UPDATE SET state = 'friends'").bind(acct.id, other.id, Date.now()),
      env.DB.prepare("INSERT INTO friends (a, b, state, created) VALUES (?, ?, 'friends', ?) ON CONFLICT (a, b) DO UPDATE SET state = 'friends'").bind(other.id, acct.id, Date.now()),
    ]);
    if (b.action === 'remove') {
      await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(acct.id, other.id, other.id, acct.id).run();
      return json({ ok: true, state: 'none' });
    }
    if (b.action === 'accept') {
      if (theirs?.state !== 'pending') return json({ error: 'No request from that player.' }, 400);
      await both();
      return json({ ok: true, state: 'friends' });
    }
    if (b.action === 'add') {
      if (mine?.state === 'friends') return json({ ok: true, state: 'friends' });
      if (theirs?.state === 'pending') { await both(); return json({ ok: true, state: 'friends' }); }
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE a = ?').bind(acct.id).first<{ n: number }>();
      if ((n?.n ?? 0) >= MAX_FRIENDS) return json({ error: `At most ${MAX_FRIENDS} friends and requests.` }, 400);
      await env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, state, created) VALUES (?, ?, 'pending', ?)").bind(acct.id, other.id, Date.now()).run();
      return json({ ok: true, state: 'pending' });
    }
    return json({ error: 'bad request' }, 400);
  }

  if (path === '/v1/buy' && req.method === 'POST') {
    const b = await req.json<{ kind?: string; id?: string; stage?: number }>();
    const level = levelOf(acct.xp).level;
    const cars: string[] = JSON.parse(acct.cars), skins: string[] = JSON.parse(acct.skins), mods: Record<string, Record<string, number>> = JSON.parse(acct.mods);
    let price = 0;
    if (b.kind === 'car') {
      const r = CAR_REQ[b.id ?? ''];
      if (!r) return json({ error: 'no such car' }, 400);
      if (cars.includes(b.id!) || r.price === 0) return json({ error: 'You already own it.' }, 400);
      if (level < r.mpLevel) return json({ error: `Needs online level ${r.mpLevel}.` }, 403);
      price = r.price; cars.push(b.id!);
    } else if (b.kind === 'skin') {
      const r = SKIN_REQ[b.id ?? ''];
      if (!r) return json({ error: 'no such gear' }, 400);
      if (skins.includes(b.id!) || r.price === 0) return json({ error: 'You already own it.' }, 400);
      if (level < r.mpLevel) return json({ error: `Needs online level ${r.mpLevel}.` }, 403);
      price = r.price; skins.push(b.id!);
    } else if (b.kind === 'mod') {
      const [car, key] = String(b.id ?? '').split(':');
      const stage = Number(b.stage);
      if (!CAR_REQ[car] || !(MOD_KEYS as readonly string[]).includes(key) || !(stage >= 1 && stage <= 3)) return json({ error: 'no such upgrade' }, 400);
      if (car !== 'vela_gt' && !cars.includes(car)) return json({ error: 'Buy the car first.' }, 400);
      const have = mods[car]?.[key] ?? 0;
      if (stage <= have) return json({ error: 'You already own it.' }, 400);
      for (let s = have + 1; s <= stage; s++) {
        const r = MOD_REQ[key as typeof MOD_KEYS[number]][s - 1];
        if (level < r.mpLevel) return json({ error: `Needs online level ${r.mpLevel}.` }, 403);
        price += r.price;
      }
      mods[car] = { engine: 0, tyres: 0, weight: 0, aero: 0, ...(mods[car] ?? {}), [key]: stage };
    } else return json({ error: 'bad request' }, 400);
    const res = await env.DB.prepare('UPDATE accounts SET credits = credits - ?, cars = ?, skins = ?, mods = ? WHERE id = ? AND credits >= ?')
      .bind(price, JSON.stringify(cars), JSON.stringify(skins), JSON.stringify(mods), acct.id, price).run();
    if (!res.meta.changes) return json({ error: 'Not enough credits.' }, 402);
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
    return json(profileOf(fresh!));
  }

  if (path === '/v1/report' && req.method === 'POST') {
    const b = await req.json<{ raceId?: string; player?: string; why?: string }>();
    if (!b.raceId || !b.player) return json({ error: 'bad request' }, 400);
    await env.DB.prepare('INSERT INTO reports (race, reporter, player, why, created) VALUES (?, ?, ?, ?, ?)')
      .bind(String(b.raceId).slice(0, 40), acct.id, String(b.player).slice(0, 40), String(b.why ?? '').slice(0, 200), Date.now()).run();
    return json({ ok: true });
  }

  const rp = /^\/v1\/replay\/([^/]+)$/.exec(path);
  if (rp && req.method === 'POST') {
    const { data } = await req.json<{ data?: string }>();
    if (typeof data !== 'string' || data.length > 900_000) return json({ error: 'bad recording' }, 400);
    const res = await env.DB.prepare("UPDATE replays SET data = ?, status = 'uploaded' WHERE race = ? AND account = ? AND status = 'requested'").bind(data, rp[1], acct.id).run();
    return json(res.meta.changes ? { ok: true } : { error: 'no replay was requested' }, res.meta.changes ? 200 : 404);
  }

  // ---- Cross-Progression Cloud Save (ENFORCED monotonic version check!) ----
  if (path === '/v1/save' && req.method === 'GET') {
    const profile = profileOf(acct);
    const checksum = await sha256(`${acct.id}|${profile.saveVersion}|${acct.credits}|${acct.xp}|${acct.cars}`);
    return json({ profile, checksum });
  }
  if (path === '/v1/save' && req.method === 'POST') {
    const b = await req.json<{ prefs?: unknown; avatarGear?: unknown; clientVersion?: number }>();
    const curVer = acct.save_version ?? 1;
    if (typeof b.clientVersion === 'number' && b.clientVersion < curVer) {
      return json({ error: 'stale save version — server is newer', profile: profileOf(acct) }, 409);
    }
    const prefsStr = JSON.stringify(b.prefs && typeof b.prefs === 'object' ? b.prefs : JSON.parse(acct.save_prefs ?? '{}'));
    const gearStr = JSON.stringify(b.avatarGear && typeof b.avatarGear === 'object' ? b.avatarGear : JSON.parse(acct.avatar_gear ?? '{}'));
    if (prefsStr.length > 4096 || gearStr.length > 4096) return json({ error: 'save payload too large' }, 400);
    const nextVer = curVer + 1;
    const upd = await env.DB.prepare('UPDATE accounts SET save_version = ?, save_prefs = ?, avatar_gear = ? WHERE id = ? AND save_version = ?')
      .bind(nextVer, prefsStr, gearStr, acct.id, curVer).run();
    if (!upd.meta.changes) {
      const latest = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
      return json({ error: 'concurrent save conflict', profile: profileOf(latest!) }, 409);
    }
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
    const profile = profileOf(fresh!);
    const checksum = await sha256(`${acct.id}|${profile.saveVersion}|${fresh!.credits}|${fresh!.xp}|${fresh!.cars}`);
    return json({ profile, checksum });
  }

  // ---- Hardened Anti-Save-Scumming Wager Escrow (Two-Party OR Server-Verified Race Settlement!) ----
  if (path === '/v1/wager/lock' && req.method === 'POST') {
    const b = await req.json<{ wagerId?: string; opponentId?: string; stake?: 'cash' | 'pinkslip'; amount?: number; car?: string; opponentCar?: string; raceId?: string }>();
    const wid = String(b.wagerId ?? '').slice(0, 48);
    const oppId = String(b.opponentId ?? '').slice(0, 48);
    const stake = b.stake === 'pinkslip' ? 'pinkslip' : 'cash';
    const amount = stake === 'cash' ? Math.max(0, Math.min(250_000, Math.round(Number(b.amount) || 5000))) : 0;
    const car = String(b.car ?? 'vela_gt'), oppCar = String(b.opponentCar ?? 'vela_gt');
    if (!wid || !oppId || oppId === acct.id) return json({ error: 'invalid wager lock' }, 400);
    const opp = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(oppId).first<AccountRow>();
    if (!opp) return json({ error: 'opponent not found' }, 404);
    const myCars: string[] = JSON.parse(acct.cars);
    if (stake === 'pinkslip' && car !== 'vela_gt' && !myCars.includes(car)) return json({ error: 'you do not own the staked car' }, 403);
    if (stake === 'cash' && acct.credits < amount) return json({ error: 'not enough credits for cash wager' }, 402);
    if (stake === 'cash' && amount > 0) {
      const r = await env.DB.prepare('UPDATE accounts SET credits = credits - ? WHERE id = ? AND credits >= ?').bind(amount, acct.id, amount).run();
      if (!r.meta.changes) return json({ error: 'not enough credits' }, 402);
    }
    await env.DB.prepare(
      "INSERT OR IGNORE INTO wager_escrows (id, challenger, opponent, stake, amount, challenger_car, opponent_car, race_id, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'locked', ?)",
    ).bind(wid, acct.id, oppId, stake, amount, car, oppCar, b.raceId ? String(b.raceId).slice(0, 40) : null, Date.now()).run();
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
    return json({ ok: true, wagerId: wid, profile: profileOf(fresh!) });
  }

  if (path === '/v1/wager/settle' && req.method === 'POST') {
    const b = await req.json<{ wagerId?: string; won?: boolean; raceId?: string }>();
    const wid = String(b.wagerId ?? '').slice(0, 48);
    const escrow = await env.DB.prepare("SELECT * FROM wager_escrows WHERE id = ? AND status = 'locked'").bind(wid).first<{
      id: string; challenger: string; opponent: string; stake: string; amount: number;
      challenger_car: string; opponent_car: string; challenger_claim: string | null; opponent_claim: string | null; race_id: string | null;
    }>();
    if (!escrow || (escrow.challenger !== acct.id && escrow.opponent !== acct.id)) return json({ error: 'no active wager escrow' }, 404);

    // 1. Check authoritative server race result first (cannot be spoofed!)
    let verifiedWinner: string | null = null;
    const rid = b.raceId ? String(b.raceId).slice(0, 40) : escrow.race_id;
    if (rid) {
      const raceRow = await env.DB.prepare('SELECT result FROM races WHERE id = ?').bind(rid).first<{ result: string }>();
      if (raceRow) {
        const table = JSON.parse(raceRow.result) as { id: string; pos: number; flagged?: boolean }[];
        const cEntry = table.find((r) => r.id === escrow.challenger && !r.flagged);
        const oEntry = table.find((r) => r.id === escrow.opponent && !r.flagged);
        if (cEntry && oEntry) verifiedWinner = cEntry.pos < oEntry.pos ? escrow.challenger : escrow.opponent;
      }
    }

    // 2. Otherwise require two-party mutual confirmation (single client can NEVER self-award!)
    if (!verifiedWinner) {
      const claim = b.won ? 'won' : 'lost';
      const isChallenger = escrow.challenger === acct.id;
      const col = isChallenger ? 'challenger_claim' : 'opponent_claim';
      await env.DB.prepare(`UPDATE wager_escrows SET ${col} = ? WHERE id = ? AND status = 'locked'`).bind(claim, wid).run();
      const cClaim = isChallenger ? claim : escrow.challenger_claim;
      const oClaim = isChallenger ? escrow.opponent_claim : claim;
      if (!cClaim || !oClaim) {
        return json({ ok: true, pending: true, message: 'Recorded your result — waiting for opponent confirmation or server race verification.' });
      }
      if (cClaim === oClaim) {
        return json({ error: 'Disputed wager claims — provide the official server raceId for authoritative settlement.' }, 409);
      }
      verifiedWinner = cClaim === 'won' ? escrow.challenger : escrow.opponent;
    }

    const loserId = verifiedWinner === escrow.challenger ? escrow.opponent : escrow.challenger;
    const winnerRow = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(verifiedWinner).first<AccountRow>();
    const loserRow = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(loserId).first<AccountRow>();
    if (!winnerRow || !loserRow) return json({ error: 'wager accounts missing' }, 404);

    let winCars: string[] = JSON.parse(winnerRow.cars);
    let loseCars: string[] = JSON.parse(loserRow.cars);
    const winCr = escrow.stake === 'cash' ? escrow.amount * 2 : 0;
    if (escrow.stake === 'pinkslip') {
      const prizeCar = verifiedWinner === escrow.challenger ? escrow.opponent_car : escrow.challenger_car;
      if (prizeCar in CAR_VMAX_KMH && !winCars.includes(prizeCar)) winCars = [...winCars, prizeCar];
      if (prizeCar !== 'vela_gt') loseCars = loseCars.filter((c) => c !== prizeCar);
    }

    await env.DB.batch([
      env.DB.prepare("UPDATE wager_escrows SET status = 'settled', winner = ?, settled_at = ? WHERE id = ? AND status = 'locked'").bind(verifiedWinner, Date.now(), wid),
      env.DB.prepare('UPDATE accounts SET credits = credits + ?, cars = ?, save_version = save_version + 1 WHERE id = ?').bind(winCr, JSON.stringify(winCars), verifiedWinner),
      env.DB.prepare('UPDATE accounts SET cars = ?, save_version = save_version + 1 WHERE id = ?').bind(JSON.stringify(loseCars), loserId),
    ]);
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
    return json({ ok: true, settled: true, won: verifiedWinner === acct.id, winnerId: verifiedWinner, profile: profileOf(fresh!) });
  }

  return json({ error: 'not found' }, 404);
}
