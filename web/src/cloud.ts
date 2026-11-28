// Client for the OpenGrid online service (cloud/, Cloudflare Worker + D1 + Durable Objects):
// - Real Email + Password Login/Sign-Up (PBKDF2-SHA256) OR instant guest account (upgradable anytime)
// - Ad-Free Online Pass (7-day Trial / OpenGrid Pro), Dual-Rating (DR/SR + License R..PRO + Jokers)
// - Scheduled Official SOF Splits, Seasonal Championships, Restorative Protests, Global Hotlaps, Teams
// - Server-timed RaceRoom WebSocket & atomic purchases.
import type { Mods } from './garage';
import type { Custom } from './custom-data';

export type LicenseClass = 'R' | 'D' | 'C' | 'B' | 'A' | 'PRO';
export type SubTier = 'none' | 'trial' | 'pro' | 'team_pro';
export type OAuthProvider = 'google' | 'github' | 'discord';
export interface OAuthProvidersStatus { google: boolean; github: boolean; discord: boolean; emailReset?: boolean }

export interface Profile {
  id: string; name: string; username: string | null; usernameAt: number | null; xp: number; credits: number;
  email?: string | null; hasPassword?: boolean; totpEnabled?: boolean;
  cars: string[]; mods: Record<string, Mods>; skins: string[];
  looks: Record<string, Custom>;
  saveVersion?: number;
  prefs?: Record<string, unknown>;
  avatarGear?: Record<string, unknown>;
  clean: number; strikes: number; banned: boolean; created: number;
  subTier?: SubTier; subExpiresAt?: number; subActive?: boolean; patreonLinked?: boolean;
  dr?: number; drRd?: number; drGrade?: string; sr?: number; license?: LicenseClass;
  mprRaces?: number; rollingCpi?: number; badSport?: boolean; cleanStreak?: number; jokersLeft?: number;
  stats?: { starts: number; wins: number; podiums: number; poles: number; incidents: number; corners: number };
}

export interface OfficialSeriesEvent {
  id: string; title: string; subtitle: string; minLicense: LicenseClass;
  intervalMin: number; maxPerSplit: number; minGrid: number; laps: number;
  route: 'nyc' | 'city'; realism: boolean; fixedSetup: boolean; bopEnabled: boolean;
  pointsMul: number; teamEligible: boolean;
  eventKey: string; startsAt: number; startsInSec: number; registrationOpen: boolean;
  registrants: number; eligible: boolean;
  myEntry: { status: string; split_no: number | null; party_code: string | null; sof: number | null; car: string } | null;
}

export interface ScheduleResponse { season: string; adFree: boolean; events: OfficialSeriesEvent[] }

const KEY = 'nr.cloud.v1';
const envUrl = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
const isLocalHost = typeof location !== 'undefined' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const defaultProdBase = isLocalHost ? '' : 'https://opengrid.opengrid-racing.workers.dev';
const BASE = String(envUrl.VITE_CLOUD_URL ?? (envUrl.DEV ? 'http://127.0.0.1:8787' : defaultProdBase)).replace(/\/$/, '');

export interface Friend { username: string; level: number; license?: string; dr?: number; online: boolean; party: string | null; seenAgo?: number | null }
export interface Friends { friends: Friend[]; incoming: string[]; outgoing: string[] }

export class Cloud {
  readonly base = BASE;
  private acct: { id: string; token: string } | null = null;
  /** Set when returning from a 1-click Google / GitHub / Discord OAuth redirect (#og_auth=...). */
  oauthSignedInProvider: OAuthProvider | null = null;

  constructor() {
    try { const s = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (s?.id && s?.token) this.acct = s; } catch { /* blocked */ }
    this.consumeOAuthHash();
  }

  private consumeOAuthHash() {
    if (typeof location === 'undefined' || !location.hash || !location.hash.includes('og_auth=')) return;
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const code = params.get('og_auth') ?? '';
      const prov = params.get('og_provider') ?? '';
      if (this.restore(code)) {
        if (prov === 'google' || prov === 'github' || prov === 'discord') this.oauthSignedInProvider = prov;
      }
      // Immediately strip credentials from the URL bar so tokens never linger in browser history!
      history.replaceState(null, '', location.pathname + location.search);
    } catch { /* ignore */ }
  }
  get available() { return !!this.base; }
  get id() { return this.acct?.id ?? ''; }
  get recoveryCode() { return this.acct ? `${this.acct.id}.${this.acct.token}` : ''; }

  private saveAcct(id: string, token: string) {
    this.acct = { id, token };
    try { localStorage.setItem(KEY, JSON.stringify(this.acct)); } catch { /* blocked */ }
  }

  restore(code: string) {
    const [id, token] = code.trim().split('.');
    if (!/^[a-z0-9]{8,32}$/i.test(id ?? '') || !/^[A-Za-z0-9_-]{20,128}$/.test(token ?? '')) return false;
    this.saveAcct(id, token);
    return true;
  }

  private async call<T>(method: string, path: string, body?: unknown, skipAutoCreate = false): Promise<T> {
    if (!this.base) throw new Error('no online service');
    if (!this.acct && !skipAutoCreate && path !== '/v1/account') await this.create();
    const r = await fetch(this.base + path, {
      method, headers: { 'content-type': 'application/json', ...(this.acct ? { authorization: `Bearer ${this.acct.id}.${this.acct.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j as T;
  }

  private async create() {
    const j = await this.call<{ id: string; token: string }>('POST', '/v1/account', {}, true);
    this.saveAcct(j.id, j.token);
  }

  /** Real email + password registration (upgrades current guest account in-place so zero progress is lost!). */
  async registerEmail(email: string, password: string, username?: string): Promise<{ profile: Profile; recoveryCodes?: string[] }> {
    const j = await this.call<{ id: string; token: string; profile: Profile; recoveryCodes?: string[] }>('POST', '/v1/auth/register', { email, password, username }, true);
    this.saveAcct(j.id, j.token);
    return { profile: j.profile, recoveryCodes: Array.isArray(j.recoveryCodes) ? j.recoveryCodes : undefined };
  }

  /** Real email + password login from any browser, PC, or UE 5.8 client (with optional 2FA TOTP or backup code). */
  async loginEmail(email: string, password: string, totpCode?: string): Promise<{ requires2fa: true } | { requires2fa: false; profile: Profile }> {
    const body = totpCode ? { email, password, totpCode } : { email, password };
    const j = await this.call<{ requires2fa?: boolean; id?: string; token?: string; profile?: Profile }>('POST', '/v1/auth/login', body, true);
    if (j.requires2fa) return { requires2fa: true };
    if (!j.id || !j.token || !j.profile) throw new Error('Invalid login response.');
    this.saveAcct(j.id, j.token);
    return { requires2fa: false, profile: j.profile };
  }

  /** Change or set account password (rotates bearer token on success). */
  async changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    const j = await this.call<{ ok?: boolean; id?: string; token?: string }>('POST', '/v1/auth/password', { currentPassword, newPassword });
    if (j.token && (j.id || this.acct?.id)) this.saveAcct(j.id ?? this.acct!.id, j.token);
    return { ok: Boolean(j.ok ?? true) };
  }

  /** Begin optional TOTP Authenticator 2FA setup (returns Base32 secret + otpauth URI rendered locally as SVG QR). */
  async setup2fa(): Promise<{ secret: string; otpauthUri: string }> {
    return this.call<{ secret: string; otpauthUri: string }>('POST', '/v1/auth/2fa/setup', {});
  }

  /** Verify first 6-digit TOTP code to enable 2FA and receive 8 one-time backup codes. */
  async enable2fa(code: string): Promise<{ ok: boolean; backupCodes: string[]; profile: Profile }> {
    return this.call<{ ok: boolean; backupCodes: string[]; profile: Profile }>('POST', '/v1/auth/2fa/enable', { code });
  }

  /** Disable 2FA using an active 6-digit authenticator/backup code or account password. */
  async disable2fa(code?: string, password?: string): Promise<{ ok: boolean; profile: Profile }> {
    return this.call<{ ok: boolean; profile: Profile }>('POST', '/v1/auth/2fa/disable', {
      ...(code ? { code } : {}),
      ...(password ? { password } : {}),
    });
  }

  /** Regenerate 8 fresh one-time account recovery / backup codes (invalidates previous codes). */
  async regenerateRecoveryCodes(): Promise<{ ok: boolean; recoveryCodes: string[] }> {
    return this.call<{ ok: boolean; recoveryCodes: string[] }>('POST', '/v1/auth/recovery-codes', {});
  }

  /** Request a password reset code by email (falls back to offline recovery codes if email delivery isn't configured). */
  async forgotPassword(email: string): Promise<{ ok: boolean; emailSent: boolean; message: string }> {
    return this.call<{ ok: boolean; emailSent: boolean; message: string }>('POST', '/v1/auth/forgot-password', { email }, true);
  }

  /** Complete password reset using an emailed reset code or one-time recovery code (signs in immediately). */
  async resetPassword(email: string, resetCode: string, newPassword: string): Promise<{ ok: boolean; profile: Profile }> {
    const j = await this.call<{ ok?: boolean; id: string; token: string; profile: Profile }>('POST', '/v1/auth/reset-password', { email, resetCode, newPassword }, true);
    this.saveAcct(j.id, j.token);
    return { ok: Boolean(j.ok ?? true), profile: j.profile };
  }

  /** Permanently delete the signed-in account and clear local credentials. */
  async deleteAccount(confirm: string, password?: string): Promise<{ ok: boolean }> {
    const j = await this.call<{ ok?: boolean }>('POST', '/v1/auth/delete', {
      confirm,
      ...(password ? { password } : {}),
    });
    this.acct = null;
    try { localStorage.removeItem(KEY); } catch { /* blocked */ }
    return { ok: Boolean(j.ok ?? true) };
  }

  async logout(): Promise<void> {
    if (this.acct && this.base) {
      await this.call('POST', '/v1/auth/logout', {}, true).catch(() => {});
    }
    this.acct = null;
    try { localStorage.removeItem(KEY); } catch { /* blocked */ }
  }

  /** Discover which 1-click OAuth providers (Google, GitHub, Discord) are active on the cloud server. */
  async authProviders(): Promise<OAuthProvidersStatus> {
    if (!this.base) return { google: false, github: false, discord: false, emailReset: false };
    try {
      const r = await fetch(`${this.base}/v1/auth/providers`);
      if (!r.ok) return { google: false, github: false, discord: false, emailReset: false };
      const j = await r.json() as Partial<OAuthProvidersStatus>;
      return { google: Boolean(j.google), github: Boolean(j.github), discord: Boolean(j.discord), emailReset: Boolean(j.emailReset) };
    } catch {
      return { google: false, github: false, discord: false, emailReset: false };
    }
  }

  /** Start a 1-click Google / GitHub / Discord OAuth login (automatically upgrades current guest account in-place!). */
  async startOAuthSession(
    provider: OAuthProvider,
    returnTo = `${location.origin}${location.pathname}${location.search}`,
    popup = false,
  ): Promise<{ url: string; ticket?: string }> {
    return this.call<{ url: string; ticket?: string }>('POST', `/v1/auth/oauth/${provider}/start`, { returnTo, popup }, true);
  }

  async startOAuth(provider: OAuthProvider, returnTo = `${location.origin}${location.pathname}${location.search}`): Promise<string> {
    const j = await this.startOAuthSession(provider, returnTo, false);
    return j.url;
  }

  /** Poll one-time popup OAuth ticket (works inside COOP / SharedArrayBuffer iframes where window.opener is severed). */
  async pollOAuthTicket(ticket: string): Promise<{ ready: boolean; code?: string; provider?: OAuthProvider }> {
    return this.call<{ ready: boolean; code?: string; provider?: OAuthProvider }>('POST', '/v1/auth/oauth/poll', { ticket }, true);
  }

  me() { return this.call<Profile>('GET', '/v1/me'); }
  async usernameFree(u: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.base) throw new Error('no online service');
    const r = await fetch(`${this.base}/v1/username?u=${encodeURIComponent(u)}`);
    return r.json();
  }
  claimUsername(username: string) { return this.call<Profile>('POST', '/v1/username', { username }); }
  friends() { return this.call<Friends>('GET', '/v1/friends'); }
  friend(username: string, action: 'add' | 'accept' | 'remove') { return this.call<{ ok: true; state: string }>('POST', '/v1/friends', { username, action }); }
  presence(party: string | null) { return this.call<{ ok: true }>('POST', '/v1/presence', { party: party ?? '' }); }
  buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number) { return this.call<Profile>('POST', '/v1/buy', { kind, id, stage }); }
  saveLook(car: string, look: Custom) { return this.call<Profile>('POST', '/v1/look', { car, look }); }
  getSave() { return this.call<{ profile: Profile; checksum: string }>('GET', '/v1/save'); }
  syncSave(prefs: Record<string, unknown>, avatarGear?: object, clientVersion?: number) {
    return this.call<{ profile: Profile; checksum: string }>('POST', '/v1/save', { prefs, avatarGear, clientVersion });
  }
  lockWagerEscrow(spec: { wagerId: string; opponentId: string; stake: 'cash' | 'pinkslip'; amount: number; car: string; opponentCar: string; raceId?: string }) {
    return this.call<{ ok: true; wagerId: string; profile: Profile }>('POST', '/v1/wager/lock', spec);
  }
  settleWagerEscrow(wagerId: string, won: boolean, raceId?: string) {
    return this.call<{ ok: true; settled?: boolean; pending?: boolean; won?: boolean; profile?: Profile }>('POST', '/v1/wager/settle', { wagerId, won, raceId });
  }
  report(raceId: string, player: string, why: string) { return this.call<{ ok: true }>('POST', '/v1/report', { raceId, player, why }); }
  replay(raceId: string, data: string) { return this.call<{ ok: true }>('POST', `/v1/replay/${encodeURIComponent(raceId)}`, { data }); }

  // ---- Free Community OpenGrid Online Network (100% Ad-Free · Best-Effort Free Servers) ----
  subscription() {
    return this.call<{
      tier: SubTier; active: boolean; expiresAt: number; daysLeft: number; adFree: boolean; nonProfit?: boolean;
      patreonUrl?: string | null; patreonConnected?: boolean; patreonOAuthEnabled?: boolean;
      proMinUsd?: number; teamMinUsd?: number; benefits: string[];
    }>('GET', '/v1/subscription');
  }
  patreonConnectUrl() { return this.call<{ url: string }>('GET', '/v1/patreon/connect'); }
  schedule() { return this.call<ScheduleResponse>('GET', '/v1/schedule', undefined, true); }
  registerSeries(seriesId: string, car: string) {
    return this.call<{ ok: true; eventKey: string; seriesId: string; startsAt: number; registrants: number }>('POST', '/v1/schedule/register', { seriesId, car });
  }
  withdrawSeries(eventKey: string) { return this.call<{ ok: true }>('POST', '/v1/schedule/withdraw', { eventKey }); }
  seedSeries(eventKey: string) {
    return this.call<{ ok: true; eventKey: string; totalSplits: number; mySplit: { splitNo: number; sof: number; partyCode: string; badSportSplit: boolean; drivers: number } | null }>('POST', '/v1/schedule/seed', { eventKey });
  }
  championships(seriesId = 'gt3_championship') {
    return this.call<{ season: string; seriesId: string; standings: { account: string; name: string; license: string; dr: number; locked_car: string; points: number; starts: number; wins: number; podiums: number }[] }>('GET', `/v1/championships?series=${encodeURIComponent(seriesId)}`, undefined, true);
  }
  leaderboards(track = 'nyc', car = '', weather = 'dry') {
    return this.call<{ track: string; car: string; weather: string; entries: { id: string; username: string; car: string; lap_ms: number; created: number }[] }>(
      'GET', `/v1/leaderboards?track=${encodeURIComponent(track)}&car=${encodeURIComponent(car)}&weather=${encodeURIComponent(weather)}`, undefined, true,
    );
  }
  submitHotlap(spec: { track: string; car: string; weather?: string; lapMs: number; trackLengthM?: number; sectors?: number[]; telemetryHash?: string; ghostData?: string }) {
    return this.call<{ ok: true; personalBest: boolean; bestLapMs: number }>('POST', '/v1/hotlap', spec);
  }
  fileProtest(spec: { raceId: string; accused: string; incidentType: 'intentional_wreck' | 'unsafe_rejoin' | 'blocking' | 'ramming' | 'chat_abuse'; lap?: number; corner?: string; notes?: string; replayClip?: string }) {
    return this.call<{ ok: true; protestId: string }>('POST', '/v1/protests', spec);
  }
  useJoker(raceId: string) {
    return this.call<{ ok: true; drRestored: number; srRestored: number; profile: Profile }>('POST', '/v1/joker', { raceId });
  }
  teams() { return this.call<{ teams: { id: string; name: string; tag: string; role: string }[] }>('GET', '/v1/teams'); }
  createTeam(name: string, tag: string) { return this.call<{ ok: true; id: string; name: string; tag: string }>('POST', '/v1/teams', { name, tag }); }
  leagues() {
    return this.call<{ leagues: { id: string; name: string; code: string; description: string; series_rules: string; bop_enabled: number; max_drivers: number; is_private: number; member_count: number; created: number }[] }>('GET', '/v1/leagues', undefined, true);
  }
  createLeague(spec: { name: string; description?: string; seriesRules?: string; bopEnabled?: boolean; maxDrivers?: number; password?: string }) {
    return this.call<{ ok: true; id: string; name: string; code: string; isPrivate: boolean }>('POST', '/v1/leagues', spec);
  }
  joinLeague(code: string, password?: string) {
    return this.call<{ ok: true; leagueId: string; name: string; code: string }>('POST', '/v1/leagues/join', { code, password });
  }

  room(party: string): WebSocket {
    if (!this.acct) throw new Error('no account');
    const u = new URL(this.base.replace(/^http/, 'ws') + `/v1/room/${encodeURIComponent(party)}`);
    u.searchParams.set('auth', `${this.acct.id}.${this.acct.token}`);
    return new WebSocket(u);
  }
}
