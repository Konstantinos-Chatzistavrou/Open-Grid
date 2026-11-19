// Front end: title, garage, game modes, party lobby, pause, results, countdown. Plain DOM over the
// live 3D scene (the canvas keeps rendering behind it: the car on the start line is the backdrop).
// main.ts owns the state machine; this file draws and reports choices through callbacks.
//
// Flow: title -> Play -> game modes (Race / Free Roam / Multiplayer)
//       title -> Garage (cars, paint, upgrades only) -> Main Menu, or Continue -> game modes
import { agoText, type Identity } from './identity';
import { PLATE_MAX, USERNAME_MAX, USERNAME_MIN, usernameError } from './username';
import { FINISHES, LOOK_PRESETS, MODS, MOD_KEYS, SWATCHES, applyLookPreset, applyMods, bodyEffect, bodyHint, customOf, kitEffect, kitHint, modsOf, paintOf, partEffect, rimHint, saveSelection, statsOf, wingHint,
  type CatalogCar, type Finish, type Mode, type ModKey, type Selection } from './garage';
import { formatLap } from './hud';
import { FREE_ROAM_MAX_PLAYERS, RACE_MAX_PLAYERS, cleanCode, type Party, type PartyMode } from './party';
import type { ControlsUi } from './controls-menu';
import { PRESET_INFO, applyPreset, matchPreset, type AssistSettings, type Preset } from './assists';
import { fmt, fmtXp, type Career, type MpCareer, type SpCareer } from './career';
import type { Cloud, Friend } from './cloud';
import type { RankedResult } from './ranked';
import { levelOf } from './progression';
import type { Loader } from './loading';
import { AERO_FINISHES, DIFFUSERS, FENDERS, FRONT_BUMPERS, GLOW_COLOURS, HEAD_TINTS, HOODS, LIVERIES, PART_COLOURS, REAR_BUMPERS, RIM_FINISHES, RIMS, SKIRTS, SPLITTERS, WINGS, type Custom } from './scene/custom';
import { SKINS, helmetSvg, skinOf } from './scene/driver';
import { LANGS, getLang, setLang, t, type LangCode } from './i18n';
import type { AccessibilitySettings, ColorblindMode, UiScale } from './accessibility';
import type { AvatarGear } from './carMeet';
import { INSURANCE_PREMIUM_CR, INSURANCE_PREMIUM_XP, conditionOf, repairCostOf, type MaintenanceStore, type ReportCategory } from './maintenance';
import { AUCTION_LOTS, ENGINE_SWAPS, ENGINE_SWAP_THRESHOLD, MANIFOLDS, NOS_MAX_LITERS, NOS_PRICE_PER_LITER_XP, TURBOS, engineOf, stanceOf, type ManifoldId, type NightRunnersStore, type SwapId, type TurboId } from './nightRunners';
import { PARTY_BONUS_MUL, type RetentionStore } from './retention';
import { checkSplitScreen } from './splitScreen';

/** Garage tabs: name, camera (azimuth, elevation, distance) that shows those parts. */
const GTABS: { id: string; label: string; cam: string }[] = [
  { id: 'paint', label: 'Paint', cam: '0.8,0.17,6.5' },
  { id: 'body', label: 'Body', cam: '0.5,0.2,6.8' },
  { id: 'aero', label: 'Aero', cam: '2.45,0.24,6.0' },
  { id: 'fenders', label: 'Fenders', cam: '1.2,0.12,5.2' },
  { id: 'wheels', label: 'Wheels', cam: '1.25,0.04,4.4' },
  { id: 'lights', label: 'Lights', cam: '0.35,0.1,5.6' },
  { id: 'glass', label: 'Glass', cam: '2.85,0.14,5.2' },
  { id: 'driver', label: 'Driver', cam: '1.45,0.14,4.3' },
  { id: 'stance', label: 'Stance', cam: '1.35,0.04,4.8' },
  { id: 'engine', label: 'Engine', cam: '0.15,0.22,4.4' },
  { id: 'perf', label: 'Tune', cam: '0.8,0.17,6.5' },
];

export type Gfx = 'auto' | 'max' | 'ultra' | 'high' | 'medium' | 'low' | 'potato';
export type Screen = 'none' | 'title' | 'garage' | 'modes' | 'lobby' | 'pause' | 'results' | 'busy' | 'controls' | 'settings' | 'shop' | 'profile';
/** One line of the race standings. fin: finish time (s) or -1; d: distance covered (m); dnf: out of the race. */
export interface Standing { name: string; you: boolean; fin: number; d: number; best: number; ai: boolean; dnf?: boolean; why?: string }
export interface ResultData {
  total: number; best: number; laps: number[]; laps_target: number; standings: Standing[]; routeLength: number; online: boolean;
  /** credits/XP paid for this race */ earned?: number;
  /** Tow Truck Fee deducted when totaled, saved structural damage %, and Insurance discount */
  towFeeXp?: number; repairBillXp?: number; insured?: boolean; damagePct?: number;
}

export interface MenuHooks {
  /** a visual choice changed (car, paint, finish): main updates the preview */
  preview(): void;
  /** game modes screen: start a single-player session */
  play(mode: Mode): void;
  gfx(g: Gfx): void;
  resume(): void;
  restart(): void;
  /** leave the session for the main menu / game modes (single player) or the lobby (party) */
  quit(to: 'title' | 'modes'): void;
  /** title buttons: benchmark (about a minute) / soak test (several minutes) */
  bench(soak: boolean): void;
  /** spend reputation to clear the wanted level (the bank/pay choice, docs/design/heat-and-cops.md) */
  layLow?(): void;
  /** the shown screen changed (title <-> garage move the camera) */
  screen(s: Screen): void;
  /** garage camera preset */
  cam?(az: number, el: number, dist: number): void;
  /** the driving camera mode chosen in Settings */
  camMode?(mode: string): void;
  mirror?(on: boolean): void;
  /** pick the real-scale city (cities.ts): main reloads into it */
  city?(id: string): void;
  cities?(): { list: { id: string; name: string; district: string; country: string; blurb: string; mandatoryCops: boolean; patrolNote: string }[]; current: string };
  partyCreate(): void;
  partyJoin(code: string): void;
  partyLeave(): void;
  partyMode(mode: PartyMode, laps: number, realism: boolean, copMode: boolean): void;
  partyStart(): void;
  /** leader: everybody back to the lobby */
  partyLobby(): void;
  /** rejoin a free roam the party is already driving */
  partyRejoin(): void;
  /** our name changed */
  partyMe(): void;
  /** driving assists changed (settings screen) */
  assists(): void;
  /** a visual part, colour or the driver's skin changed: apply to the car on show (no reload) */
  look(): void;
  /** results screen: watch the cars still racing */
  spectate(): void;
  /** Content Creator Suite, Telemetry, Car Meet, Accessibility & Localization hooks */
  photoMode?(): void;
  replayMode?(): void;
  exportMotec?(): void;
  simhubToggle?(on: boolean): void;
  carMeet?(): void;
  returnFreeRoam?(): void;
  accessibility?(): void;
  language?(code: LangCode): void;
  cloudSync?(): void;
  repairCar?(): void;
  toggleInsurance?(on: boolean): void;
  reportPlayer?(player: string, category: ReportCategory): void;
  garageIgnition?(): void;
  garageRev?(): void;
  garageWalk?(on: boolean): void;
  nrChanged?(): void;
  buyAuction?(lotId: string): void;
  prestigeReset?(): void;
  voiceToggle?(): void;
  voiceMode?(m: 'ptt' | 'open'): void;
  publicMatchmake?(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const bar = (f: number) => `<i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i>`;
const hex = (n: number) => '#' + (n >>> 0 & 0xffffff).toString(16).padStart(6, '0');

/** Standings order: finished (by time), then still racing, then out (DNF); each by distance covered. */
export function rank(list: Standing[]) {
  return list.slice().sort((a, b) => {
    if ((a.fin >= 0) !== (b.fin >= 0)) return a.fin >= 0 ? -1 : 1;
    if (a.fin >= 0) return a.fin - b.fin;
    if (!!a.dnf !== !!b.dnf) return a.dnf ? 1 : -1;
    return b.d - a.d;
  });
}
const RULES = {
  realism: 'No resets in races: a wreck, a rollover or 30 s stuck puts you out (DNF) and you spectate the rest.',
  respawn: 'R puts you back on the road, repaired, any time.',
};

export class Menu {
  private root = document.getElementById('menu')!;
  screen: Screen = 'none';
  /** graphics tuning in progress: the title shows a cover instead of the live scene */
  tuning = false;
  gfx: Gfx = 'auto';
  gfxNote = '';
  private busyText = '';
  /** multiplayer: the party we are in (main owns it), a status / error line, an invite from the URL */
  party: Party | null = null;
  partyNote = '';
  partyBusy = false;
  invite = '';
  private joinCode = '';
  private lastResults: ResultData | null = null;
  /** the Controls screen (main sets it up: it needs the input and force-feedback objects) */
  ctl: ControlsUi | null = null;
  private controlsFrom: Screen = 'title';
  /** credits / owned cars and upgrades, and the driving assists (main sets them up) */
  sp!: SpCareer;
  mp!: MpCareer;
  cloud!: Cloud;
  /** username and friends (identity.ts) */
  identity!: Identity;
  private unameDraft: string | null = null;
  private unameNote = '';
  private unameBusy = false;
  private unameSeq = 0;
  /** wanted heat 0-5, shown on the title so the dial is visible outside a session (docs/design/heat-and-cops.md) */
  heat = 0;
  /** XP the Lay low button costs, shown on it (-1 hides the button: the online career has no spend path yet) */
  layLowCost = -1;
  private friendDraft = '';
  private friendNote = '';
  private profileFrom: Screen = 'title';
  private friendsTimer = 0;
  /** the career the garage and shop show (single player / online) */
  get career(): Career { return this.sel.career === 'mp' ? this.mp : this.sp; }
  /** the online race room's verdict on the last party race */
  private rankedRes: RankedResult | null = null;
  private recoveryShown = false;
  private settingsNote = '';
  /** the driving camera chosen in Settings (main owns the rig) */
  camMode = 'chase';
  /** console-cert accessibility (colorblind mode + HUD UI scale), telemetry & cloud save status */
  a11y: AccessibilitySettings = { colorblind: 'off', uiScale: 1 };
  maint: MaintenanceStore = { cars: {}, insured: false, reports: [] };
  nr: NightRunnersStore = { engines: {}, stance: {}, walkableGarage: true, boughtLots: [] };
  ret: RetentionStore = { dayKey: '', challenges: [], reputation: 0, prestige: 0, seasonYear: new Date().getUTCFullYear(), badges: [] };
  voiceStatus = 'Voice Off';
  voiceOn = false;
  voiceMode: 'ptt' | 'open' = 'ptt';
  garageWalkActive = false;
  private reportTarget = '';
  simhubOn = false;
  telemetrySamples = 0;
  /** the rear-view mirror at the top of the screen while driving */
  mirror = true;
  assists!: AssistSettings;
  private settingsFrom: Screen = 'title';
  /** the loading screen ('busy' shows it; main may hold it while the game warms up) */
  loader!: Loader;
  private shopNote = '';
  private garageTab = 'paint';
  /** the option under the pointer: the live panel previews its effect without applying it */
  private hover: { k: string; v: string | number } | null = null;
  private shopTab: 'cars' | 'upgrades' | 'gear' | 'auction' = 'cars';
  private shopCar = '';

  constructor(readonly sel: Selection, private cars: CatalogCar[], private physics: Record<string, unknown>, private hooks: MenuHooks) {
    this.root.addEventListener('click', (e) => this.click(e));
    // live previews: hovering a part shows what it would do without applying it
    this.root.addEventListener('pointerover', (e) => this.hoverPart(e, true));
    this.root.addEventListener('pointerout', (e) => this.hoverPart(e, false));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.change(e));
    this.root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Enter' && t.id === 'joincode') this.hooks.partyJoin(this.joinCode);
      if (e.key === 'Enter' && t.id === 'uname') void this.saveName();
      if (e.key === 'Enter' && t.id === 'fadd') void this.friendAct(this.friendDraft, 'add');
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') e.stopPropagation();   // typing a name or code never drives the car
    });
  }

  show(s: Screen, busyText = '') {
    clearInterval(this.friendsTimer);
    if (s === 'profile') { void this.identity.loadFriends(); this.friendsTimer = window.setInterval(() => void this.identity.loadFriends(), 20_000); }
    this.screen = s;
    this.busyText = busyText;
    this.root.hidden = s === 'none';
    this.root.dataset.screen = s;
    if (s === 'busy') void this.loader.show(busyText); else this.loader.hide();
    this.render();
    this.hooks.screen(s);
  }

  setTuning(on: boolean, note = '') {
    this.tuning = on;
    this.gfxNote = note;
    if (this.screen === 'title') this.render();
  }

  /** Big number (3, 2, 1, GO) over the scene; '' hides it. */
  countdown(text: string) {
    const el = document.getElementById('countdown')!;
    el.textContent = text;
    el.classList.toggle('show', !!text);
    if (text) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
  }

  private car() { return this.cars.find((c) => c.id === this.sel.car)!; }
  private save() { saveSelection(this.sel); }

  render() {
    // don't rebuild under the cursor while someone types a name or code
    const focused = document.activeElement as HTMLInputElement | null;
    const keep = focused && this.root.contains(focused) && focused.tagName === 'INPUT' ? { id: focused.id, a: focused.selectionStart, b: focused.selectionEnd } : null;
    // Bug fix: preserve scroll position across ALL scrollable panels (Garage, Shop, Settings, Controls, Lobby)
    const SCROLL_SELS = ['.g-stage-scroll', '.g-carlist', '.g-left', '.g-right', '.lobby-card', '.settings-card', '.controls-card', '.shop-card', '.modes-screen'];
    const scrolls = SCROLL_SELS.map((sel) => [sel, this.root.querySelector(sel)?.scrollTop ?? 0] as const);
    const html = {
      none: () => '', title: () => this.title(), garage: () => this.garage(), modes: () => this.modes(), lobby: () => this.lobby(),
      pause: () => this.pause(), controls: () => this.ctl?.html() ?? '', settings: () => this.settings(), shop: () => this.shop(), profile: () => this.profile(), results: () => (this.lastResults ? this.results(this.lastResults) : ''),
      busy: () => '',   // the loading screen (loading.ts) covers it
    }[this.screen]();
    this.root.innerHTML = html;
    for (const [sel, top] of scrolls) {
      if (top > 0) { const el = this.root.querySelector(sel); if (el) el.scrollTop = top; }
    }
    if (keep?.id) {
      const el = document.getElementById(keep.id) as HTMLInputElement | null;
      if (el) { el.focus(); try { el.setSelectionRange(keep.a, keep.b); } catch { /* not a text input */ } }
    }
  }

  showResults(r: ResultData) {
    this.lastResults = r;
    this.screen = 'results';
    this.root.hidden = false;
    this.root.dataset.screen = 'results';
    this.render();
  }
  /** Results already on screen: new finishers came in (party race). */
  updateResults(standings: Standing[]) {
    if (this.screen !== 'results' || !this.lastResults) return;
    this.lastResults.standings = standings;
    this.render();
  }

  // ---- screens ---------------------------------------------------------------------------------
  private title() {
    const curCar = this.car();
    const dis = this.tuning ? 'disabled' : '';
    const invite = this.invite && !this.party ? `<div class="invite"><span>🏁 You're invited to party <b>${esc(this.invite)}</b></span>
        <button class="primary" data-act="invite" ${dis}>Join Party</button><button class="small" data-act="noinvite" aria-label="Dismiss">✕</button></div>` : '';
    const last = this.sp.last ?? this.mp.last;
    const earned = last && (last.xp || last.cr) ? `<div class="earned">+${fmtXp(last.xp)}${last.cr ? ` · +${fmt(last.cr)}` : ''} <span class="dim">${esc(last.reason)}</span>${last.levelUp ? ` <b class="lvup">LEVEL ${last.levelUp}</b>` : ''}</div>` : '';
    if (this.identity.needsPick && !this.tuning) return this.pickName();
    const me = `<button class="me-chip" data-act="profile-open" ${dis}><span class="avatar">${helmetSvg(skinOf(this.sel.skin), 26)}</span><b>${esc(this.identity.name)}</b>
      <span class="dim">${this.identity.friends.incoming.length ? `· ${this.identity.friends.incoming.length} friend request${this.identity.friends.incoming.length > 1 ? 's' : ''}` : '· Profile &amp; friends'}</span></button>`;
    const st = statsOf(applyMods(this.physics[this.sel.car], modsOf(this.sel)));
    const cls = st.power > 420 ? 'S' : st.power > 330 ? 'A' : st.power > 250 ? 'B' : 'C';
    const nav = (act: string, n: string, label: string, sub: string, primary = false, extra = '') =>
      `<button class="tnav huge ${primary ? 'primary' : ''}" data-act="${act}" ${dis} ${extra}><i>${n}</i><b>${label}</b><span>${sub}</span><u aria-hidden="true"></u></button>`;
    return `${this.tuning ? '<div class="cover"><div class="card center"><div class="spin"></div><p>Tuning graphics for this device…</p><span class="dim">Measuring the street once to pick resolution and effects.</span></div></div>' : ''}
      <div class="title">
        <div class="t-brand">
          <div class="kicker">NIGHT SHIFT // OPEN-WORLD STREET RACING</div>
          <div class="logo">OPEN<span>GRID</span></div>
        </div>
        <nav class="title-btns">
          ${nav('play', '01', t('menu.play'), t('menu.play.sub'), true)}
          ${nav('garage-open', '02', t('menu.garage'), t('menu.garage.sub'))}
          ${nav('shop-open', '03', t('menu.shop'), t('menu.shop.sub'))}
          ${nav('settings-open', '04', t('menu.settings'), t('menu.settings.sub'))}
          ${this.heat > 0 && this.layLowCost >= 0 ? nav('laylow', '05', 'Lay low', `Clear your heat · ${this.layLowCost} XP`, false, this.sp.xp < this.layLowCost ? 'disabled title="Not enough reputation"' : '').replace('tnav huge', 'tnav huge lay') : ''}
        </nav>
        ${invite}
        <div class="t-driver">
          ${me}
          <div class="careers">${this.careerCard('sp')}${this.careerCard('mp')}</div>
          ${earned}
          ${this.ret.challenges.length ? `<div class="daily-box">
            <h4>⚡ Daily Challenges · Rep ${this.ret.reputation.toLocaleString()}${this.ret.prestige ? ` · ★${this.ret.prestige}` : ''}</h4>
            ${this.ret.challenges.map((c) => `<div class="drow ${c.claimed ? 'done' : ''}"><span>${esc(c.title)}</span><b>${c.claimed ? '✓ DONE' : `${c.progress}/${c.target} (+${c.xpReward} XP)`}</b></div>`).join('')}
          </div>` : ''}
        </div>
        <div class="t-foot">
          <div class="dim note">${esc(this.gfxNote || 'WebGPU · 240 Hz physics')} · Assists: ${this.assists.preset[0].toUpperCase() + this.assists.preset.slice(1)}</div>
          <a class="source-link dim" href="https://github.com/Konstantinos-Chatzistavrou/Racing-Game" target="_blank" rel="noopener">Source code · code Apache-2.0 · assets CC BY-NC 4.0</a>
        </div>
      </div>
      <div class="t-heat heat-chip ${this.heat >= 5 ? 'maxed' : this.heat === 4 ? 'hot' : ''}"><span>HEAT</span>${Array.from({ length: 5 }, (_, i) => `<i class="${i < this.heat ? 'on' : ''}"></i>`).join('')}<b>${this.heat}/5</b></div>
      <div class="t-car"><span>ACTIVE VEHICLE</span><b>${esc(curCar.name)}</b><em><i>CLASS ${cls}</i>${Math.round(st.power)} kW · ${Math.round(st.mass)} kg</em></div>`;
  }

  private settings() {
    const a = this.assists, inSession = this.settingsFrom === 'pause';
    const chip = (act: string, v: string, label: string, on: boolean) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`;
    const row = (label: string, chips: string, note: string) => `<div class="srow2"><span class="dim">${label}</span><div class="chips">${chips}</div><small class="dim">${note}</small></div>`;
    const presets = (['beginner', 'intermediate', 'expert', 'custom'] as Preset[]).map((p) => chip('as-preset', p, p[0].toUpperCase() + p.slice(1), a.preset === p)).join('');
    const assists = `
      <div class="chips">${presets}</div><div class="dim note">${PRESET_INFO[a.preset]}</div>
      ${row('ABS', chip('as-abs', 'off', 'Off', a.abs === 'off') + chip('as-abs', 'weak', 'Weak', a.abs === 'weak') + chip('as-abs', 'default', 'Default', a.abs === 'default'), 'Stops the wheels locking under braking. Weak lets them slip further first.')}
      ${row('TRACTION', [0, 1, 2, 3, 4, 5].map((n) => chip('as-tc', String(n), n ? String(n) : 'Off', a.tc === n)).join(''), 'Cuts power when the rear wheels spin. 5 steps in earliest.')}
      ${row('STABILITY', chip('as-esc', '0', 'Off', !a.stability) + chip('as-esc', '1', 'On', a.stability), 'Brakes single wheels to stop a spin or a slide wide.')}
      ${row('COUNTERSTEER', chip('as-cs', 'off', 'Off', a.countersteer === 'off') + chip('as-cs', 'weak', 'Weak', a.countersteer === 'weak') + chip('as-cs', 'strong', 'Strong', a.countersteer === 'strong'), 'Steers into a slide for you when the rear steps out (keyboard and controller).')}
      ${row('GEARBOX', chip('as-gb', 'auto', 'Automatic', a.gearbox === 'auto') + chip('as-gb', 'manual', 'Manual', a.gearbox === 'manual'), 'Manual: Q / E, bumpers or paddles.')}
      ${row('DRIVING LINE', chip('as-line', 'off', 'Off', a.line === 'off') + chip('as-line', 'braking', 'Braking zones', a.line === 'braking') + chip('as-line', 'full', 'Full', a.line === 'full'), 'The racing line on the road: blue = keep going, yellow = ease off, red = brake.')}
      ${row('CAMERA', (['chase', 'far', 'cinematic', 'drift', 'hood', 'bumper', 'orbit'] as const).map((k) => chip('cam-mode', k, k[0].toUpperCase() + k.slice(1), this.camMode === k)).join(''), 'Chase is the default; drift keeps the camera on your travel line so the tail hangs out; cinematic is the low wide shot; hood and bumper are first-person; orbit is the showcase pan. C cycles any time while driving.')}
      ${row('REAR MIRROR', chip('mirror', '0', 'Off', !this.mirror) + chip('mirror', '1', 'On', this.mirror), 'The view behind the car, top centre, in every camera. Off saves a few frames per second.')}
      <div class="dim note">Assists never change the car: same physics and tyres for everyone; they only help with your inputs. Keys 1 / 2 / 3 / 5 switch ABS / traction / stability / gearbox while driving.</div>`;
    const g = (k: Gfx, label: string) => chip('gfx', k, label, this.gfx === k);
    const more = inSession ? '<div class="dim note">Race rules, graphics and tests can be changed from the main menu.</div>' : `
      <h3>Race rules</h3>
      <div class="chips">${chip('realism', '1', 'Full Realism', this.sel.realism)}${chip('realism', '0', 'Respawns', !this.sel.realism)}</div>
      <div class="dim note">${this.sel.realism ? RULES.realism : RULES.respawn}</div>
      <h3>Graphics</h3>
      <div class="chips">${g('auto', 'Auto')}${g('max', 'Max')}${g('ultra', 'Ultra')}${g('high', 'High')}${g('medium', 'Medium')}${g('low', 'Low')}${g('potato', 'Potato')}</div>
      <div class="dim note">${esc(this.gfxNote || 'Auto tunes resolution and effects for this device once.')}</div>
      <h3>Performance tests</h3>
      <div class="chips"><button class="small" data-act="bench">⏱ Benchmark</button><button class="small" data-act="soak">🔥 Soak Test</button></div>`;
    return `<div class="lobby-screen"><div class="card lobby-card settings-card">
      <div class="lobby-head"><button data-act="settings-back" class="back-btn">← Back</button><div><div class="kicker">OPTIONS</div><h2>Settings</h2></div></div>
      <h3>Driving assists</h3>${assists}
      <h3>🌍 ${t('settings.language')}</h3>
      <div class="chips">${LANGS.map((l) => chip('lang', l.code, l.native, getLang() === l.code)).join('')}</div>
      <div class="dim note">String-table localization (UE5 Localization Dashboard ready) with automatic text-expansion layouts.</div>
      <h3>♿ ${t('settings.accessibility')}</h3>
      ${row('WALKABLE GARAGE', chip('nr-walk', '1', 'On (Default)', this.nr.walkableGarage) + chip('nr-walk', '0', 'Orbit Only', !this.nr.walkableGarage), 'Walk around your car in the garage to inspect the hood, oil cap, and locker.')}
      ${row('ANNUAL SEASON PRESTIGE', `<button class="chip" data-act="prestige">★ Prestige Reset (Season ${this.ret.seasonYear} · ★${this.ret.prestige})</button>`, 'Resets rank/XP for a permanent Prestige badge while keeping 100% of your owned cars & garage builds.')}
      ${row(t('settings.colorblind').toUpperCase(),
        (['off', 'protanopia', 'deuteranopia', 'tritanopia'] as ColorblindMode[]).map((m) => chip('a11y-cb', m, m[0].toUpperCase() + m.slice(1), this.a11y.colorblind === m)).join(''),
        'Remaps Driving Line and Minimap icons (player, rivals, police, roadblocks, speed/drift zones) to high-contrast colorblind-safe palettes.')}
      ${row(t('settings.uiscale').toUpperCase(),
        ([0.85, 1, 1.15, 1.3] as UiScale[]).map((sc) => chip('a11y-scale', String(sc), `${Math.round(sc * 100)}%`, this.a11y.uiScale === sc)).join(''),
        'Scales the speedometer, minimap, and telemetry HUD widgets cleanly.')}
      <h3>📡 ${t('settings.telemetry')} &amp; MoTeC</h3>
      <div class="chips">
        ${chip('simhub', '1', 'SimHub UDP ON', this.simhubOn)}${chip('simhub', '0', 'OFF', !this.simhubOn)}
        <button class="small" data-act="export-motec">📊 Export MoTeC (.ld / .ldx)${this.telemetrySamples ? ` · ${Math.round(this.telemetrySamples / 60)}s` : ''}</button>
      </div>
      <div class="dim note">Streams 311-byte Forza/SimHub Dash V2 packets (speed, RPM, tire temps, suspension, G-forces) via <code>tools/simhub_udp_bridge.mjs</code> (UDP 20777) &amp; exports MoTeC i2 Pro lap logs.</div>
      <h3>Controls</h3><div class="chips"><button data-act="controls-open">🎮 Controllers, wheels &amp; full button remapping…</button></div>
      <h3>💾 ${t('settings.cloudsave')}</h3>
      <div class="dim note">${this.cloud.available ? `Server-authoritative cross-progression (v${this.mp.profile?.saveVersion ?? 1}): balance, cars, garage, and Pink Slip escrow live on the server to prevent save-scumming.${this.mp.ready ? '' : ` (${esc(this.mp.note)})`}` : 'Cloud saves & Pink Slip escrow sync automatically once connected to the online service.'}</div>
      ${this.cloud.available ? `<div class="chips"><button class="small primary" data-act="cloud-sync">☁ Sync Cloud Save Now</button><button class="small" data-act="recovery">${this.recoveryShown ? 'Hide' : 'Show'} recovery code</button></div>
        ${this.recoveryShown ? `<input id="reccode" type="text" readonly value="${esc(this.cloud.recoveryCode || 'No account yet: open the multiplayer lobby once.')}" />` : ''}
        <div class="joinrow"><input id="restore" type="text" placeholder="Paste a recovery code to use that account here" spellcheck="false" autocomplete="off" /><button class="small" data-act="restore">Use</button></div>
        ${this.settingsNote ? `<div class="pnote ${this.settingsNote.startsWith('✓') ? '' : 'bad'}">${esc(this.settingsNote)}</div>` : ''}` : ''}
      ${more}
      <div class="lobby-foot"><span></span><button data-act="settings-back" class="primary">Done</button></div>
    </div></div>`;
  }

  /** A career's level, XP bar and (online) credits. */
  private careerCard(k: 'sp' | 'mp') {
    const c = k === 'sp' ? this.sp : this.mp, L = levelOf(c.xp);
    const pct = L.need ? Math.round((L.into / L.need) * 100) : 100;
    const extra = k === 'mp' ? (this.mp.ready ? ` · <span class="credits">${fmt(c.credits)}</span>` : ` · <span class="dim">${esc(this.mp.note || 'Offline')}</span>`) : '';
    return `<div class="ccard"><span class="dim">${k === 'sp' ? 'SINGLE PLAYER' : 'ONLINE'}</span><b>Level ${L.level}</b>${extra}
      <div class="xpbar"><i style="width:${pct}%"></i></div><small class="dim">${L.need ? `${fmtXp(L.into)} / ${fmtXp(L.need)}` : 'Max level'}</small></div>`;
  }
  /** The single player / online switch on the garage and shop. */
  private careerBar() {
    const sp = levelOf(this.sp.xp).level, mp = levelOf(this.mp.xp).level;
    return `<div class="career-bar"><button class="chip ${this.sel.career === 'sp' ? 'on' : ''}" data-act="career" data-v="sp">Single player · Lv ${sp}</button>
      <button class="chip ${this.sel.career === 'mp' ? 'on' : ''}" data-act="career" data-v="mp">Online · Lv ${mp}${this.mp.ready ? ` · ${fmt(this.mp.credits)}` : ''}</button></div>`;
  }
  /** The get-it button of a shop item for the active career. */
  private itemBtn(kind: 'car' | 'mod' | 'skin', id: string, stage: number | undefined, label: string, small = true) {
    const c = this.career, r = c.req(kind, id, stage), cls = small ? 'small' : 'pip buy';
    const data = `data-act="buy" data-kind="${kind}" data-v="${id}"${stage ? ` data-stage="${stage}"` : ''}`;
    if (c.kind === 'sp') return `<button class="${cls}" disabled>${label ? `${label} · ` : ''}Unlocks at level ${r.spLevel}</button>`;
    if (!this.mp.ready) return `<button class="${cls}" disabled>${esc(this.mp.note || 'Online service unavailable')}</button>`;
    const lvl = levelOf(this.mp.xp).level;
    let price = r.price;
    if (kind === 'mod') { price = 0; const [car, key] = id.split(':'); for (let s2 = this.mp.stage(car, key as ModKey) + 1; s2 <= (stage ?? 1); s2++) price += c.req('mod', key, s2).price; }
    if (lvl < r.mpLevel) return `<button class="${cls}" disabled>${label ? `${label} · ` : ''}Online level ${r.mpLevel}</button>`;
    if (price > this.mp.credits) return `<button class="${cls}" disabled>${label ? `${label} · ` : ''}Need ${fmt(price - this.mp.credits)} more</button>`;
    return `<button class="${cls} primary" ${data}>${label ? `${label} · ` : ''}Buy · ${fmt(price)}</button>`;
  }

  private shop() {
    const w = this.career, sp = w.kind === 'sp';
    const cars = this.cars.map((c) => {
      const st = statsOf(this.physics[c.id]), owned = w.owns(c.id);
      const btn = owned ? `<button class="small" data-act="shop-drive" data-v="${c.id}">${c.id === this.sel.car ? '✓ Driving' : 'Drive'}</button>` : this.itemBtn('car', c.id, undefined, '');
      const r = w.req('car', c.id);
      return `<div class="scard ${owned ? 'owned' : ''}">
        <div class="car-head"><b>${esc(c.name)}</b><i class="car-badge">${owned ? (sp ? 'UNLOCKED' : 'OWNED') : sp ? `LV ${r.spLevel}` : `LV ${r.mpLevel} · ${fmt(r.price)}`}</i></div>
        <span class="dim">${esc(c.tag)}</span>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
        ${btn}</div>`;
    }).join('');
    const ownedCars = this.cars.filter((c) => w.owns(c.id));
    if (!w.owns(this.shopCar)) this.shopCar = this.sel.car;
    const carChips = ownedCars.map((c) => `<button class="chip ${c.id === this.shopCar ? 'on' : ''}" data-act="shop-car" data-v="${c.id}">${esc(c.name)}</button>`).join('');
    const ups = MOD_KEYS.map((k) => {
      const m = MODS[k], have = w.stage(this.shopCar, k);
      const stages = [1, 2, 3].map((n) => n <= have ? `<button class="pip on" disabled>${m.levels[n]} ✓</button>` : this.itemBtn('mod', sp ? k : `${this.shopCar}:${k}`, n, m.levels[n], false)).join('');
      return `<div class="mod"><div><b>${m.label}</b><span class="dim">${m.hint}</span></div><div class="pips">${stages}</div></div>`;
    }).join('');
    const gear = SKINS.map((k) => {
      const owned = w.ownsSkin(k.id), worn = this.sel.skin === k.id, r = w.req('skin', k.id);
      const btn = owned ? `<button class="small ${worn ? '' : 'primary'}" data-act="wear-skin" data-v="${k.id}" ${worn ? 'disabled' : ''}>${worn ? '✓ Wearing' : 'Wear'}</button>` : this.itemBtn('skin', k.id, undefined, '');
      return `<div class="scard gear ${owned ? 'owned' : ''}">${helmetSvg(k, 64)}<div class="car-head"><b>${esc(k.name)}</b><i class="car-badge">${owned ? (sp ? 'UNLOCKED' : 'OWNED') : sp ? `LV ${r.spLevel}` : fmt(r.price)}</i></div>
        <span class="suit-dot" style="background:${k.suit}"></span>${btn}</div>`;
    }).join('');
    const tab = (id: typeof this.shopTab, label: string) => `<button class="gtab ${this.shopTab === id ? 'on' : ''}" data-act="stab" data-v="${id}">${label}</button>`;
    const auctionCards = AUCTION_LOTS.map((lot) => {
      const sold = this.nr.boughtLots.includes(lot.id);
      const tags = lot.tags.map((tg) => `<span class="tag-chip">${esc(tg)}</span>`).join('');
      return `<div class="scard ${sold ? 'owned' : ''}">
        <div class="car-head"><b>${esc(lot.title)}</b><i class="car-badge">-${lot.discountPct}% LOT</i></div>
        <div class="dim small-note">${lot.mileageKm.toLocaleString()} km · Engine ${lot.startHealth}% · Damage ${Math.round(lot.startDamage * 100)}%</div>
        <div>${tags}</div>
        <button class="small ${sold ? '' : 'primary'}" data-act="buy-auction" data-v="${lot.id}" ${sold ? 'disabled' : ''}>${sold ? '✓ Won Auction' : `🔨 Buy Lot · ${lot.priceXp} XP`}</button>
      </div>`;
    }).join('');
    const content = this.shopTab === 'cars' ? `<div class="shop-cars">${cars}</div>`
      : this.shopTab === 'upgrades' ? `<p class="dim small-note">Fit and remove stages in the Garage → Tune.</p><div class="chips">${carChips}</div>${ups}`
      : this.shopTab === 'auction' ? `<p class="dim small-note">Night Runners Used-Car Auction House: opaque condition tags &amp; high mileage carry real mechanical wear at steep discounts.</p><div class="shop-cars">${auctionCards}</div>`
      : `<p class="dim small-note">Helmet and suit: worn by your driver and shown as your avatar to everyone in a party.</p><div class="shop-cars">${gear}</div>`;
    const how = sp ? 'Single player: everything unlocks as you level up (XP from races and free roam). Nothing to buy.'
      : 'Online: credits and XP come only from ranked party races (6+ players who race; at most 2 per network). Each item needs an online level and credits.';
    return `<div class="lobby-screen"><div class="card lobby-card shop-card">
      <div class="lobby-head"><button data-act="home" class="back-btn">← Main Menu</button><div><div class="kicker">${sp ? 'UNLOCKS' : 'SPEND YOUR CREDITS'}</div><h2>Shop</h2></div>${sp ? '' : `<div class="wallet-pill">${this.mp.ready ? fmt(w.credits) : '—'}</div>`}</div>
      ${this.careerBar()}
      <div class="gtabs">${tab('cars', 'Cars')}${tab('upgrades', 'Upgrades')}${tab('gear', 'Driver gear')}${tab('auction', '🏷 Auction House')}</div>
      ${this.shopNote ? `<div class="pnote ${this.shopNote.startsWith('✓') ? '' : 'bad'}">${esc(this.shopNote)}</div>` : ''}
      ${content}
      <div class="dim note">${how}</div>
      <div class="lobby-foot"><button data-act="garage-open">⚙ Garage</button><button class="primary" data-act="play">Play ▶</button></div>
    </div></div>`;
  }

  private garage() {
    const sel = this.sel;
    const w = this.career;
    const cards = this.cars.filter((c) => w.owns(c.id)).map((c) => {
      const st = statsOf(this.physics[c.id]);
      return `<button class="car ${c.id === sel.car ? 'on' : ''}" data-act="car" data-v="${c.id}">
        <div class="car-head"><b>${esc(c.name)}</b><i class="car-badge">${c.id === sel.car ? 'SELECTED' : 'SELECT'}</i></div>
        <span>${esc(c.tag)}</span>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
      </button>`;
    }).join('');
    const mods = modsOf(sel);
    const now = statsOf(applyMods(this.physics[sel.car], mods));
    const stages = MOD_KEYS.reduce((a, k) => a + mods[k], 0);
    const tabs = GTABS.map((t) => `<button class="gtab ${this.garageTab === t.id ? 'on' : ''}" data-act="gtab" data-v="${t.id}">${t.label}</button>`).join('');
    const body = ({ paint: () => this.gPaint(), body: () => this.gBody(), aero: () => this.gAero(), fenders: () => this.gFenders(), wheels: () => this.gWheels(), lights: () => this.gLights(),
      glass: () => this.gGlass(), driver: () => this.gDriver(), stance: () => this.gStance(), engine: () => this.gEngine(), perf: () => this.gPerf() } as Record<string, () => string>)[this.garageTab]?.() ?? '';
    const rail = GTABS.map((t, i) => `<button class="rail ${this.garageTab === t.id ? 'on' : ''}" data-act="gtab" data-v="${t.id}"><i>${String(i + 1).padStart(2, '0')}</i><b>${t.label}</b></button>`).join('');
    const cls = now.power > 420 ? 'S' : now.power > 330 ? 'A' : now.power > 250 ? 'B' : 'C';
    const cond = conditionOf(this.maint, sel.car);
    const rep = repairCostOf(cond, this.maint.insured);
    const condBadge = rep.pct > 0
      ? `<button class="chip on" data-act="repair-car" title="Repair persistent race damage (${this.maint.insured ? '-50% Insured' : 'Standard rate'})">🔧 ${cond.totaled ? 'TOTALED' : `${rep.pct}% DAMAGED`} · Repair (${rep.xp} XP)</button>`
      : `<span class="pill">✓ 100% MINT</span>`;
    return `<div class="garage">
      <header class="g-head">
        <div class="g-brand">GARAGE<span>BUILD YOUR CAR</span></div>
        <div class="g-carsum">
          <div class="g-name">${esc(this.car().name)}<i>CLASS ${cls}</i> ${condBadge}</div>
          <div class="g-stats">
            <span><b>${Math.round(now.power)}</b> kW</span>
            <span><b>${Math.round(now.mass)}</b> kg</span>
            <span><b>${now.grip.toFixed(2)}</b> µ</span>
          </div>
        </div>
        <div class="g-cams">
          <button class="chip" data-act="cam" data-v="0.8,0.17,6.5">3/4</button>
          <button class="chip" data-act="cam" data-v="-0.75,0.16,6.2">F 3/4</button>
          <button class="chip" data-act="cam" data-v="0,0.14,6.0">Front</button>
          <button class="chip" data-act="cam" data-v="1.57,0.08,6.4">Side</button>
          <button class="chip" data-act="cam" data-v="2.45,0.16,6.2">R 3/4</button>
          <button class="chip" data-act="cam" data-v="3.14,0.15,6.0">Rear</button>
          <button class="chip" data-act="cam" data-v="1.57,0.03,5.0">Low</button>
          <button class="chip" data-act="cam" data-v="0,0.05,4.2">Nose</button>
          <button class="chip" data-act="cam" data-v="1.5,0.05,3.4">Wheel</button>
          <button class="chip" data-act="cam" data-v="0.9,0.55,6.8">Top</button>
          <button class="chip" data-act="cam" data-v="orbit">Orbit</button>
          <button class="chip on" data-act="g-ignition" title="Crank starter &amp; cold-start exhaust bark">🔑 Ignition</button>
          <button class="chip on" data-act="g-rev" title="Rev engine &amp; trigger flamethrower exhaust pops">🔥 Rev</button>
          ${this.nr.walkableGarage ? `<button class="chip ${this.garageWalkActive ? 'on' : ''}" data-act="g-walk">🚶 ${this.garageWalkActive ? 'Stop Walk' : 'Walk Garage'}</button>` : ''}
        </div>
      </header>
      <aside class="g-carlist panel"><h3>Your cars (${this.cars.filter((c) => w.owns(c.id)).length}/${this.cars.length})</h3>${cards}
        ${this.cars.some((c) => !w.owns(c.id)) ? '<button class="small more-cars" data-act="shop-open">+ More cars</button>' : ''}</aside>
      <nav class="g-rail">${rail}</nav>
      <section class="g-stage panel"><div class="g-stage-scroll"><div class="g-tabtitle">${this.garageTab.toUpperCase()}</div>${this.lookNow()}${body}</div></section>
      <section class="g-live" id="g-live">${this.liveStats()}</section>
      <footer class="g-foot">
        <button data-act="home" class="back-btn">← Main Menu</button>
        <div class="g-summary"><b>${esc(this.car().name)}</b><span class="dim">${stages ? `${stages} upgrade stage${stages > 1 ? 's' : ''} fitted` : 'Stock'} · ${FINISHES[sel.finish].label} paint · ${Math.round(now.power)} kW</span></div>
        <button class="primary huge go" data-act="play">Continue</button>
      </footer>
    </div>`;
  }

  /** Live telemetry: bars show the car as it sits, the delta shows what the hovered part would do. */
  private liveStats() {
    const sel = this.sel, parts = customOf(sel);
    const d = applyMods(this.physics[sel.car] as never, modsOf(sel)) as any;
    const st = statsOf(d);
    const fx = (c: ReturnType<typeof customOf>) => {
      const ids = [c.wing, c.splitter, c.diffuser, c.skirt, c.frontB, c.rearB, c.hood, c.fenders, c.rims];
      const parts = ids.map((id) => partEffect(id));
      return {
        df: parts.reduce((a, x) => a + x.df, 0),
        drag: parts.reduce((a, x) => a + x.drag, 0),
        kg: parts.reduce((a, x) => a + x.kg, 0),
      };
    };
    const now = fx(parts);
    const pv = this.hover ? fx({ ...parts, [this.hover.k]: this.hover.v } as ReturnType<typeof customOf>) : null;
    const mass = st.mass + now.kg, pmass = pv ? st.mass + pv.kg : null;
    const drag = st.drag + now.drag, pdrag = pv ? st.drag + pv.drag : null;
    const vmax = st.vmax * Math.cbrt(st.drag / Math.max(0.2, drag));
    const pvmax = pdrag ? st.vmax * Math.cbrt(st.drag / Math.max(0.2, pdrag)) : null;
    const df = st.downforce + now.df, pdf = pv ? st.downforce + pv.df : null;
    const accel = st.accel * (mass / st.mass), paccel = pmass ? st.accel * (pmass / st.mass) : null;
    const dl = (a: number, b: number | null, unit: string, digits = 0, lowerBetter = false) => {
      if (b === null) return '';
      const dv = b - a;
      if (Math.abs(dv) < (digits ? 0.005 : 0.5)) return '<em class="flat">±0</em>';
      return '<em class="' + (lowerBetter ? (dv < 0 ? 'up' : 'down') : (dv > 0 ? 'up' : 'down')) + '">' + (dv > 0 ? '+' : '') + dv.toFixed(digits) + ' ' + unit + '</em>';
    };
    const row = (label: string, text: string, sub: string, frac: number, delta: string) =>
      '<div class="lv"><span>' + label + '</span><div class="lbar">' + bar(frac) + '</div><b>' + text + '</b><i>' + sub + '</i>' + delta + '</div>';
    return [
      row('POWER', Math.round(st.power) + ' kW', Math.round(st.hp) + ' hp', st.power / 600, ''),
      row('WEIGHT', Math.round(mass) + ' kg', 'loaded', (1700 - mass) / 600, dl(mass, pmass, 'kg', 0, true)),
      row('POWER / T', Math.round(st.pwr) + ' kW/t', Math.round(st.ratio) + ' W/kg', st.pwr / 450, ''),
      row('0-100', accel.toFixed(1) + ' s', 'estimate', (6.5 - accel) / 5, dl(accel, paccel, 's', 1, true)),
      row('DOWNFORCE', df.toFixed(2) + ' m²', 'aero', df / 0.95, dl(df, pdf, 'm²', 2)),
      row('TOP SPEED', Math.round(vmax) + ' km/h', 'drag-limited', vmax / 360, dl(vmax, pvmax, 'km/h')),
      row('DRAG', drag.toFixed(2) + ' m²', 'CdA', (0.95 - drag) / 0.8, dl(drag, pdrag, 'm²', 2, true)),
    ].join('');
  }

  /** pointerover/out on a part chip: swap the live panel to the previewed numbers, no garage re-render. */
  private hoverPart(e: Event, on: boolean) {
    const t = (e.target as HTMLElement | null)?.closest?.('[data-act="cu"]') as HTMLElement | null;
    if (!t || this.screen !== 'garage') return;
    if (!on) {
      const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
      if (to && t.contains(to)) return;
    }
    const k = t.dataset.k, v = t.dataset.v;
    this.hover = on && k && v !== undefined ? { k, v } : null;
    const live = document.getElementById('g-live');
    if (live) live.innerHTML = this.liveStats();
  }
  // ---- garage tabs (each a list of rows; every choice is data-act="cu" data-k=<Custom key> data-v=<value>) ----
  private cu(k: keyof Custom, v: string | number | boolean, label: string, on: boolean, hint = '') {
    return `<button class="chip ${on ? 'on' : ''}" data-act="cu" data-k="${k}" data-v="${v}" title="${esc(hint || label)}">${label}</button>`;
  }
  private swatches(k: keyof Custom, cur: string, list = PART_COLOURS) {
    return `<div class="sws">${list.map((c) => c ? `<button class="sw ${c === cur ? 'on' : ''}" style="background:${c}" data-act="cu" data-k="${k}" data-v="${c}" aria-label="${c}"></button>`
      : `<button class="sw off ${cur === '' ? 'on' : ''}" data-act="cu" data-k="${k}" data-v="" aria-label="Off">✕</button>`).join('')}</div>`;
  }
  /** What is on the car right now: the paint swatch and the finish name, right under the tabs (all garage tabs). */
  private lookNow() {
    const paint = paintOf(this.sel, this.cars);
    return `<div class="chips" style="align-items:center;gap:7px;margin:6px 0 0">
      <i aria-hidden="true" style="width:13px;height:13px;border-radius:50%;background:${paint};border:1px solid #ffffff55;box-shadow:0 0 6px ${paint}88"></i>
      <b style="font-size:11px;letter-spacing:.10em;text-transform:uppercase">${FINISHES[this.sel.finish].label}</b>
      <span class="dim" style="font-size:11px">${paint.toUpperCase()}</span></div>`;
  }
  private gPaint() {
    const sel = this.sel, c = customOf(sel), paint = paintOf(sel, this.cars).toLowerCase();
    const sw = SWATCHES.map((x) => `<button class="sw ${x === paint ? 'on' : ''}" style="background:${x}" data-act="paint" data-v="${x}" aria-label="${x}"></button>`).join('');
    const fin = (Object.keys(FINISHES) as Finish[]).map((f) => `<button class="chip ${sel.finish === f ? 'on' : ''}" data-act="finish" data-v="${f}">${FINISHES[f].label}</button>`).join('');
    const looks = LOOK_PRESETS.map((p) => `<button class="chip" data-act="look" data-v="${p.id}" title="${esc(p.blurb)}">${esc(p.label)}</button>`).join('');
    return `<h3>Style presets <small>one click, everything below changes</small></h3><div class="chips">${looks}</div>
      <h3>Body colour</h3>
      <div class="sws">${sw}<label class="sw custom" title="Custom colour"><input id="custom" type="color" value="${paint}" /></label></div>
      <h3>Finish</h3><div class="chips">${fin}</div>
      <h3>Livery</h3><div class="chips">${LIVERIES.map((l, i) => this.cu('livery', i, l, c.livery === i)).join('')}</div>
      ${c.livery ? `<h3>Livery colour</h3>${this.swatches('liveryColor', c.liveryColor)}` : ''}`;
  }
  private gAero() {
    const c = customOf(this.sel);
    return `<h3>Front splitter <small class="dim">front-end bite</small></h3><div class="chips">${(Object.keys(SPLITTERS) as string[]).map((k) => this.cu('splitter', k, SPLITTERS[k], c.splitter === k, kitHint('splitter', k))).join('')}</div>
      <h3>Rear diffuser <small class="dim">rear stability</small></h3><div class="chips">${(Object.keys(DIFFUSERS) as string[]).map((k) => this.cu('diffuser', k, DIFFUSERS[k], c.diffuser === k, kitHint('diffuser', k))).join('')}</div>
      <h3>Side skirts <small class="dim">side stability</small></h3><div class="chips">${(Object.keys(SKIRTS) as string[]).map((k) => this.cu('skirt', k, SKIRTS[k], c.skirt === k, kitHint('skirt', k))).join('')}</div>
      <h3>Splitter, diffuser &amp; wing finish</h3><div class="chips">${(Object.keys(AERO_FINISHES) as (keyof typeof AERO_FINISHES)[]).map((k) => this.cu('aero', k, AERO_FINISHES[k], c.aero === k)).join('')}</div>`;
  }
  private gWheels() {
    const c = customOf(this.sel);
    return `<h3>Rim design <small class="dim">lighter = quicker launch</small></h3><div class="chips">${(Object.keys(RIMS) as string[]).map((k) => this.cu('rims', k, RIMS[k], c.rims === k, rimHint(k))).join('')}</div>
      <h3>Rim colour</h3>${this.swatches('rimColor', c.rimColor)}
      <h3>Rim finish</h3><div class="chips">${(Object.keys(RIM_FINISHES) as (keyof typeof RIM_FINISHES)[]).map((k) => this.cu('rimFinish', k, RIM_FINISHES[k], c.rimFinish === k)).join('')}</div>
      <h3>Brake calipers</h3>${this.swatches('caliper', c.caliper)}`;
  }
  private gLights() {
    const c = customOf(this.sel);
    return `<h3>Headlights</h3><div class="chips">${(Object.keys(HEAD_TINTS) as (keyof typeof HEAD_TINTS)[]).map((k) => this.cu('headlights', k, HEAD_TINTS[k], c.headlights === k)).join('')}</div>
      <h3>Tail lights</h3><div class="chips">${this.cu('smokedTails', false, 'Clear red', !c.smokedTails)}${this.cu('smokedTails', true, 'Smoked', c.smokedTails)}</div>
      <h3>Underglow</h3>${this.swatches('underglow', c.underglow, GLOW_COLOURS)}`;
  }
  private gGlass() {
    const c = customOf(this.sel);
    return `<h3>Window tint</h3><div class="chips">${['Light', 'Dark', 'Limo'].map((l, i) => this.cu('tint', i, l, c.tint === i)).join('')}</div>
      <h3>Exhaust tips</h3><div class="chips">${this.cu('exhaust', 'chrome', 'Chrome', c.exhaust === 'chrome')}${this.cu('exhaust', 'black', 'Black', c.exhaust === 'black')}${this.cu('exhaust', 'titanium', 'Burnt titanium', c.exhaust === 'titanium')}</div>`;
  }
  private gDriver() {
    const owned = SKINS.filter((k) => this.career.ownsSkin(k.id));
    const cards = owned.map((k) => `<button class="skin ${this.sel.skin === k.id ? 'on' : ''}" data-act="skin" data-v="${k.id}">${helmetSvg(k, 42)}<span>${esc(k.name)}</span></button>`).join('');
    const gear = this.sel.avatarGear;
    const gearSwatches = (slot: keyof AvatarGear, cur: string) =>
      `<div class="sws">${PART_COLOURS.filter(Boolean).map((c) => `<button class="sw ${c === cur ? 'on' : ''}" style="background:${c}" data-act="gear" data-k="${slot}" data-v="${c}" aria-label="${c}"></button>`).join('')}</div>`;
    return `<h3>Driver preset <small class="dim">(in-car &amp; walkable Car Meet avatar)</small></h3>
      <div class="chips" style="margin-bottom:10px"><button class="chip on" data-act="gear-match">🎨 Match Car Livery &amp; Paint</button></div>
      <div class="skins">${cards}</div>
      <h3>Helmet colour</h3>${gearSwatches('helmet', gear.helmet)}
      <h3>Helmet accent / visor stripe</h3>${gearSwatches('accent', gear.accent)}
      <h3>Racing suit</h3>${gearSwatches('suit', gear.suit)}
      <h3>Racing gloves</h3>${gearSwatches('gloves', gear.gloves)}
      <h3>Racing shoes</h3>${gearSwatches('shoes', gear.shoes)}
      ${owned.length < SKINS.length ? '<button class="small more-cars" data-act="shop-gear">🛒 More helmets &amp; suits in the Shop</button>' : ''}`;
  }
  /** Body: the big shapes - rear wing, bumpers, hood (generated panels replace the stock ones). */
  /** does the car in the garage have this bumper / hood option? (main.ts: the customiser knows) */
  fits: (id: string) => boolean = () => true;
  private gBody() {
    const c = customOf(this.sel);
    const sec = (k: 'frontB' | 'rearB' | 'hood', map: Record<string, string>, kind: 'front' | 'rear' | 'hood') =>
      `<h3>${kind === 'front' ? 'Front bumper' : kind === 'rear' ? 'Rear bumper' : 'Hood'} <small class="dim">replaces the stock panel</small></h3>` +
      // only the panels this car really has (a panel is a reshaped copy of the car's own, or one authored for it)
      `<div class="chips">${Object.keys(map).filter((id) => id === 'stock' || this.fits(id)).map((id) => this.cu(k, id, map[id], (c as unknown as Record<string, string>)[k] === id, bodyHint(kind, id, map[id]))).join('')}</div>`;
    return `<h3>Rear wing <small class="dim">grip in corners, costs top speed</small></h3><div class="chips">${(Object.keys(WINGS) as (keyof typeof WINGS)[]).map((k) => this.cu('wing', k, WINGS[k], c.wing === k, wingHint(k as string))).join('')}</div>
      ${sec('frontB', FRONT_BUMPERS, 'front')}${sec('rearB', REAR_BUMPERS, 'rear')}${sec('hood', HOODS, 'hood')}`;
  }

  private gFenders() {
    const c = customOf(this.sel);
    return `<h3>Fender flares <small class="dim">wide body, more drag</small></h3><div class="chips">${Object.keys(FENDERS).map((id) => this.cu('fenders', id, FENDERS[id], c.fenders === id, bodyHint('fender', id, FENDERS[id]))).join('')}</div>`;
  }

  private gStance() {
    const st = stanceOf(this.nr, this.sel.car);
    const pick = (k: string, vals: number[], cur: number, fmtV: (n: number) => string) =>
      `<div class="chips">${vals.map((v) => `<button class="chip ${Math.abs(cur - v) < 0.05 ? 'on' : ''}" data-act="nr-stance" data-k="${k}" data-v="${v}">${fmtV(v)}</button>`).join('')}</div>`;
    return `<h3>Stance &amp; Suspension <small class="dim">(visuals &amp; physics hitboxes stay 1:1)</small></h3>
      <h3>Front Camber</h3>${pick('camberFront', [-7, -5, -3.5, -1.8, 0], st.camberFront, (v) => `${v}°`)}
      <h3>Rear Camber</h3>${pick('camberRear', [-7, -5, -3.5, -1.5, 0], st.camberRear, (v) => `${v}°`)}
      <h3>Ride Height</h3>${pick('rideHeightMm', [-40, -25, -10, 0, 15], st.rideHeightMm, (v) => `${v > 0 ? '+' : ''}${v} mm`)}
      <h3>Spring Stiffness</h3>${pick('springMul', [0.75, 1.0, 1.25, 1.5], st.springMul, (v) => `${Math.round(v * 100)}%`)}`;
  }

  private gEngine() {
    const eng = engineOf(this.nr, this.sel.car);
    const canSwap = eng.health <= ENGINE_SWAP_THRESHOLD;
    const tagsHtml = eng.tags.length ? `<div style="margin:6px 0">${eng.tags.map((tg) => `<span class="tag-chip">${esc(tg)}</span>`).join('')}</div>` : '';
    const turboBtns = (Object.keys(TURBOS) as TurboId[]).map((id) =>
      `<button class="chip ${eng.turbo === id ? 'on' : ''}" data-act="nr-turbo" data-v="${id}">${TURBOS[id].label} (${Math.round((TURBOS[id].powerMul - 1) * 100)}% pwr)</button>`).join('');
    const manBtns = (Object.keys(MANIFOLDS) as ManifoldId[]).map((id) =>
      `<button class="chip ${eng.manifold === id ? 'on' : ''}" data-act="nr-man" data-v="${id}">${MANIFOLDS[id].label}</button>`).join('');
    const swapBtns = (Object.keys(ENGINE_SWAPS) as SwapId[]).map((id) =>
      `<button class="chip ${eng.swap === id ? 'on' : ''}" data-act="nr-swap" data-v="${id}" ${!canSwap && id !== 'stock' && id !== eng.swap ? 'disabled title="Wear current engine to <= 20% health to unlock swaps"' : ''}>${ENGINE_SWAPS[id].label}</button>`).join('');
    return `<h3>Maintenance &amp; Health</h3>
      <div class="dim small-note">Engine Health: <b>${Math.round(eng.health)}%</b> · Oil Life: <b>${Math.round(eng.oilLife)}%</b> · Odometer: <b>${Math.round(eng.mileageKm).toLocaleString()} km</b></div>
      ${tagsHtml}
      <div class="chips" style="margin:8px 0">
        <button class="chip" data-act="nr-oil">🛢 Change Oil (50 XP)</button>
        <button class="chip" data-act="nr-rebuild">🔧 Engine Overhaul (350 XP)</button>
      </div>
      <h3>💨 Nitrous Oxide <small class="dim">(${eng.nosLiters.toFixed(1)} / ${NOS_MAX_LITERS} L · [X] in race · overuse fries engine!)</small></h3>
      <div class="chips"><button class="chip on" data-act="nr-nos" data-v="5">+5 L Refill (${5 * NOS_PRICE_PER_LITER_XP} XP)</button><button class="chip" data-act="nr-nos" data-v="15">Fill Full Bottle</button></div>
      <h3>Turbocharger <small class="dim">(trades reliability for boost)</small></h3><div class="chips">${turboBtns}</div>
      <h3>Exhaust Manifold <small class="dim">(more backfire flames &amp; flow)</small></h3><div class="chips">${manBtns}</div>
      <h3>Under-the-Hood Engine Swap <small class="dim">${canSwap ? '✓ UNLOCKED (engine worn <= 20%)' : `🔒 Locked until engine health <= ${ENGINE_SWAP_THRESHOLD}%`}</small></h3><div class="chips">${swapBtns}</div>`;
  }

  private gPerf() {
    const sel = this.sel, w = this.career, mods = modsOf(sel);
    const rows = MOD_KEYS.map((k) => {
      const m = MODS[k];
      const own = w.stage(sel.car, k);
      const pips = m.levels.map((l, i) => i > own
        ? `<button class="pip locked" data-act="shop-open" title="${l}: ${w.kind === 'sp' ? `unlocks at level ${w.req('mod', k, i).spLevel}` : `online level ${w.req('mod', k, i).mpLevel}, ${fmt(w.req('mod', k, i).price)} in the Shop`}">🔒</button>`
        : `<button class="pip ${i <= mods[k] && mods[k] > 0 ? 'on' : ''} ${i === mods[k] ? 'cur' : ''}" data-act="mod" data-k="${k}" data-v="${i}" title="${l}">${i === 0 ? 'STK' : 'S' + i}</button>`).join('');
      return `<div class="mod"><div><b>${m.label}</b><span class="dim">${m.levels[mods[k]]}</span></div><div class="pips">${pips}</div><small class="dim">${m.hint}</small></div>`;
    }).join('');
    const base = statsOf(this.physics[sel.car] as never), now = statsOf(applyMods(this.physics[sel.car], mods));
    const stat = (label: string, text: string, ref: number, f: number) =>
      `<div class="stat"><span>${label}</span><div class="bar">${bar(f)}${ref >= 0 ? `<u style="left:${Math.round(ref * 100)}%"></u>` : ''}</div><b>${text}</b></div>`;
    const stats = [
      stat('Power', `${Math.round(now.power)} kW`, base.power / 480, now.power / 480),
      stat('Grip', now.grip.toFixed(2) + ' µ', (base.grip - 1) / 0.7, (now.grip - 1) / 0.7),
      stat('Light', `${Math.round(now.mass)} kg`, (1700 - base.mass) / 500, (1700 - now.mass) / 500),
      stat('Downforce', `${now.downforce.toFixed(2)} m²`, base.downforce / 1.2, now.downforce / 1.2),
      stat('Power/wt', `${Math.round(now.ratio)} W/kg`, base.ratio / 400, now.ratio / 400),
    ].join('');
    return `<h3>Performance upgrades</h3>${rows}<h3>Telemetry <small class="dim">(red marker = stock)</small></h3>${stats}`;
  }

  private modes() {
    const sel = this.sel;
    const laps = [1, 3, 5, 10].map((n) => `<button class="chip ${sel.laps === n ? 'on' : ''}" data-act="laps" data-v="${n}">${n}</button>`).join('');
    const inParty = this.party ? `<span class="pill">In party ${esc(this.party.code)}</span>` : '';
    const cs = this.hooks.cities?.();
    const cur = cs?.list.find((c) => c.id === cs.current);
    const cityRow = cs && !this.party ? `<div class="city-row">
        <span class="dim">CITY</span>
        ${cs.list.map((c) => `<button class="chip city-chip ${c.id === cs.current ? 'on' : ''}" data-act="city" data-v="${c.id}" title="${esc(c.district)}"><b>${esc(c.name)}</b><small>${esc(c.country)}</small></button>`).join('')}
        ${cur ? `<span class="dim city-blurb">${esc(cur.district)} · 1:1 · ${esc(cur.blurb)}</span>` : ''}
      </div>` : '';
    return `<div class="modes-screen">
      <div class="m-head">
        <button data-act="home" class="back-btn">← Main Menu</button>
        <div><div class="kicker">SELECT EVENT</div><h2>Tonight's run</h2></div>
        <div class="m-car dim">Driving: <b>${esc(this.car().name)}</b></div>
      </div>
      ${cityRow}
      <div class="mode-cards">
        <div class="mcard">
          <div class="mcard-top"><span class="micon">01</span><b>Race Event</b><span class="dim">Instanced · Tactical Cops · Sim Physics</span></div>
          <p class="dim">High-stakes controlled street races where hardcore physics and tactical police AI (PIT maneuvers &amp; roadblocks) matter. Heat &amp; massive payouts live here.</p>
          <div class="opts"><span class="dim">COPS</span>${cur?.mandatoryCops
            ? `<span class="pill gold">🚨 PATROLLED DISTRICT · ALWAYS ON</span><span class="dim small-note">${esc(cur.patrolNote)}</span>`
            : `<button class="chip ${sel.copMode ? 'on' : ''}" data-act="copmode" data-v="1">Cop Mode ON</button><button class="chip ${!sel.copMode ? 'on' : ''}" data-act="copmode" data-v="0">OFF</button><span class="dim small-note">${sel.copMode ? '+50%+ Rep/Cr · Bust = heavy fine / pink slip risk' : 'Clean track battle · standard payout'}</span>`}</div>
          <div class="opts"><span class="dim">INSURANCE</span><button class="chip ${this.maint.insured ? 'on' : ''}" data-act="insure" data-v="1">🛡 Insured ON</button><button class="chip ${!this.maint.insured ? 'on' : ''}" data-act="insure" data-v="0">OFF</button><span class="dim small-note">${this.maint.insured ? `${INSURANCE_PREMIUM_XP} XP / $${INSURANCE_PREMIUM_CR} premium · -50% off repairs &amp; tow if wrecked` : 'Full repair &amp; Tow Truck Fee if totaled'}</span></div>
          ${(() => { const r = repairCostOf(conditionOf(this.maint, sel.car), this.maint.insured); return r.pct > 0 ? `<div class="opts"><span class="pill gold">🔧 ${r.pct}% SAVED DAMAGE</span><button class="chip" data-act="repair-car">Repair (${r.xp} XP)</button></div>` : ''; })()}
          <div class="opts"><span class="dim">RULES</span><span class="pill ${sel.realism ? 'gold' : ''}">${sel.realism ? 'FULL REALISM' : 'RESPAWNS'}</span><span class="dim small-note">change on main menu</span></div>
          <div class="opts"><span class="dim">LAPS</span>${laps}</div>
          <button class="primary huge" data-act="start-race">Start Race · ${sel.laps} Lap${sel.laps > 1 ? 's' : ''}</button>
        </div>
        <div class="mcard">
          <div class="mcard-top"><span class="micon">02</span><b>Free Roam</b><span class="dim">No Cops · AI Traffic · Social Sandbox</span></div>
          <p class="dim">Cruising, car meets, Speed Traps &amp; Drift Zones with Global Leaderboards, and spontaneous headlight-flash [F] 1v1 Cash or Pink Slip drags from traffic lights.</p>
          <div class="opts"><span class="pill">NO POLICE</span><span class="dim small-note">[F] Flash Wager · [V] Cash/Pink Slip · [B] Leaderboards</span></div>
          <button class="primary huge" data-act="start-free">Cruise Free Roam</button>
        </div>
        <div class="mcard">
          <div class="mcard-top"><span class="micon">03</span><b>Multiplayer</b><span class="dim">${FREE_ROAM_MAX_PLAYERS} Free Roam · ${RACE_MAX_PLAYERS} Race Events</span></div>
          <p class="dim">16-player chill Free Roam lobbies with spontaneous 1v1 drag wagers &amp; zone leaderboards, or instanced 8–12 player Race Events with optional Tactical Cop Mode.</p>
          <div class="opts">${inParty || '<span class="dim">Create or join a party</span>'}</div>
          <button class="primary huge" data-act="lobby">Party Lobby</button>
        </div>
      </div>
    </div>`;
  }

  private lobby() {
    const p = this.party, sel = this.sel;
    const note = this.partyNote ? `<div class="pnote ${/^(✓|Copied)/.test(this.partyNote) ? '' : 'bad'}">${esc(this.partyNote)}</div>` : '';
    const nameRow = `<div class="field"><span class="dim">YOU RACE AS</span><b class="uname">${esc(sel.name)}</b><button class="small" data-act="profile-open">Change · Friends</button></div>`;
    if (!p) {
      return `<div class="lobby-screen"><div class="card lobby-card">
        <div class="lobby-head"><button data-act="modes" class="back-btn">← Game Modes</button><div><div class="kicker">MULTIPLAYER</div><h2>Party</h2></div></div>
        ${nameRow}
        <div class="lobby-cols">
          <div class="lcol"><h3>Host</h3><p class="dim">Start a party and invite friends with a link or a 5-letter code (+${Math.round((PARTY_BONUS_MUL - 1) * 100)}% Party XP/CR Bonus).</p>
            <button class="primary huge" data-act="pcreate" ${this.partyBusy ? 'disabled' : ''}>＋ Create Party</button></div>
          <div class="lcol"><h3>Public Matchmaking</h3><p class="dim">Jump straight into an open public lobby with strangers — even solo or with your party.</p>
            <button class="primary huge" data-act="pmatch" ${this.partyBusy ? 'disabled' : ''}>🌐 Quick Public Lobby</button></div>
          <div class="lcol"><h3>Join by Code</h3><p class="dim">Got a code from a friend? Type it here.</p>
            <div class="joinrow"><input id="joincode" type="text" maxlength="8" value="${esc(this.joinCode)}" placeholder="CODE" spellcheck="false" autocomplete="off" />
            <button class="primary" data-act="pjoin" ${this.partyBusy ? 'disabled' : ''}>Join</button></div></div>
        </div>
        ${(() => { const ss = checkSplitScreen(); return `<div class="opts" style="margin-top:12px"><span class="dim">SPLIT-SCREEN</span><span class="pill ${ss.eligible ? 'gold' : ''}">${ss.eligible ? '✓ READY' : 'LOCKED'}</span><span class="dim small-note">${esc(ss.reason)}</span></div>`; })()}
        ${this.partyBusy ? '<div class="pnote"><span class="spin inline"></span> Connecting…</div>' : note}
      </div></div>`;
    }
    const carName = (id: string) => this.cars.find((c) => c.id === id)?.name ?? '—';
    // one city per party: the leader's (members load their own saved city; a guest switches with one click, which reloads)
    const cs = this.hooks.cities?.();
    const cityName = (id?: string) => cs?.list.find((c) => c.id === id)?.name ?? '';
    const leaderCity = p.members.find((m) => m.host)?.city;
    const wrongCity = !!cs && !!leaderCity && cs.current !== leaderCity;
    const spread = p.members.some((m) => m.city && leaderCity && m.city !== leaderCity);
    const members = p.members.map((m) => `<div class="member">
        <span class="avatar">${helmetSvg(skinOf(m.skin), 30)}<i class="dot" style="background:${hex(m.paint)}"></i></span>
        <div class="mtext"><div class="mname"><b>${esc(m.name)}</b>${m.host ? '<span class="pill gold">LEADER</span>' : ''}${m.id === p.selfId ? '<span class="pill">YOU</span>' : ''}</div>
        <span class="dim">${esc(carName(m.car))}${m.city ? ` · ${esc(cityName(m.city))}` : ''} · <span class="mstate ${m.ready ? 'ok' : ''}">${p.phase === 'loading' ? (m.ready ? 'on the grid' : 'loading…') : p.phase === 'driving' ? 'driving' : 'in lobby'}</span></span></div>
      </div>`).join('');
    const maxSlots = p.maxMembers;
    const leaderCityObj = cs?.list.find((c) => c.id === (leaderCity ?? cs.current));
    const mandatoryCops = !!leaderCityObj?.mandatoryCops;
    const empty = Array.from({ length: Math.max(0, maxSlots - p.members.length) }, () => '<div class="member empty"><i class="dot"></i><div class="mtext"><span class="dim">Open slot</span></div></div>').join('');
    const modeChip = (m: PartyMode, label: string) => `<button class="chip ${p.mode === m ? 'on' : ''}" data-act="pmode" data-v="${m}" ${p.isHost ? '' : 'disabled'}>${label}</button>`;
    const lapChip = (n: number) => `<button class="chip ${p.laps === n ? 'on' : ''}" data-act="plaps" data-v="${n}" ${p.isHost ? '' : 'disabled'}>${n}</button>`;
    const realChip = (on: boolean, label: string) => `<button class="chip ${p.realism === on ? 'on' : ''}" data-act="preal" data-v="${on ? 1 : 0}" ${p.isHost ? '' : 'disabled'}>${label}</button>`;
    const copChip = (on: boolean, label: string) => `<button class="chip ${(mandatoryCops ? on : p.copMode === on) ? 'on' : ''}" data-act="pcop" data-v="${on ? 1 : 0}" ${p.isHost && !mandatoryCops ? '' : 'disabled'}>${label}</button>`;
    const rules = `<div class="opts"><span class="dim">MODE</span>${modeChip('race', `Race Event (${RACE_MAX_PLAYERS} max)`)}${modeChip('free', `Free Roam (${FREE_ROAM_MAX_PLAYERS} max)`)}
      ${p.mode === 'race' ? `<span class="dim sep">LAPS</span>${[1, 3, 5, 10].map(lapChip).join('')}` : ''}</div>
      ${p.mode === 'race' ? `<div class="opts"><span class="dim">COP MODE</span>${mandatoryCops ? `<span class="pill gold">🚨 PATROLLED DISTRICT · ALWAYS ON</span><span class="dim small-note">${esc(leaderCityObj?.patrolNote ?? '')}</span>` : `${copChip(true, 'Tactical Cops ON')}${copChip(false, 'Cops OFF')}<span class="dim small-note">PITs, roadblocks &amp; massive payouts</span>`}</div>
      <div class="opts"><span class="dim">RULES</span>${realChip(true, 'Full Realism')}${realChip(false, 'Respawns')}<span class="dim small-note">${p.realism ? RULES.realism : RULES.respawn}</span></div>
      <div class="opts"><span class="dim">INSURANCE</span><button class="chip ${this.maint.insured ? 'on' : ''}" data-act="insure" data-v="1">🛡 Insured (-50% Repairs/Tow)</button><button class="chip ${!this.maint.insured ? 'on' : ''}" data-act="insure" data-v="0">Uninsured</button><span class="dim small-note">Multiplayer damage persists until repaired</span></div>` : '<div class="opts"><span class="pill">NO POLICE</span><span class="dim small-note">16-player sandbox · AI traffic · [F] Headlight 1v1 Wagers · Speed Traps &amp; Drift Zones</span></div>'}`;
    let action: string;
    if (p.phase === 'driving') action = p.mode === 'free' ? '<button class="primary huge" data-act="prejoin">▶ Rejoin Free Roam</button>' : p.isHost ? '<button class="huge" data-act="plobby">Everyone back to lobby</button>' : '<div class="dim wait">The party is racing. You can join the next one.</div>';
    else if (p.phase === 'loading') action = '<div class="dim wait"><span class="spin inline"></span> Loading…</div>';
    else if (wrongCity) action = `<button class="primary huge" data-act="city" data-v="${esc(leaderCity!)}">Switch to ${esc(cityName(leaderCity))}</button>`;
    else if (p.isHost && spread) action = `<div class="dim wait"><span class="spin inline"></span> Waiting for everyone to switch to ${esc(cityName(leaderCity))}…</div>`;
    else action = p.isHost ? `<button class="primary huge" data-act="pstart">▶ Start ${p.mode === 'race' ? `Race · ${p.laps} Lap${p.laps > 1 ? 's' : ''}` : 'Free Roam'}</button>`
      : '<div class="dim wait"><span class="spin inline"></span> Waiting for the leader to start…</div>';
    const share = typeof navigator.share === 'function' ? '<button class="small" data-act="pshare">Share…</button>' : '';
    return `<div class="lobby-screen"><div class="card lobby-card">
      <div class="lobby-head"><button data-act="modes" class="back-btn">← Game Modes</button><div><div class="kicker">MULTIPLAYER · ${p.members.length}/${maxSlots}</div><h2>Party <span class="code">${esc(p.code)}</span></h2></div></div>
      <div class="invite-box"><span class="dim">INVITE</span><input id="plink" type="text" readonly value="${esc(p.link)}" />
        <button class="small" data-act="pcopy">Copy link</button>${share}</div>
      ${nameRow}
      <h3>Drivers <span class="pill gold">+${Math.round((PARTY_BONUS_MUL - 1) * 100)}% PARTY BONUS</span></h3><div class="members">${members}${empty}</div>
      <div class="opts"><span class="dim">VOICE CHAT</span><button class="chip ${this.voiceOn ? 'on' : ''}" data-act="voice-toggle">🎙 ${esc(this.voiceStatus)}</button><button class="chip ${this.voiceMode === 'ptt' ? 'on' : ''}" data-act="voice-mode" data-v="ptt">[Z] Walkie-Talkie PTT</button><button class="chip ${this.voiceMode === 'open' ? 'on' : ''}" data-act="voice-mode" data-v="open">Open Mic</button></div>
      <h3>Event ${p.isHost ? '' : '<small class="dim">(the leader chooses)</small>'}</h3>${rules}
      ${note}
      <div class="lobby-foot"><button data-act="pleave" class="back-btn">${p.isHost ? 'Close Party' : 'Leave Party'}</button>${action}</div>
    </div></div>`;
  }

  private pause() {
    const p = this.party;
    const online = !!p && p.phase !== 'lobby';
    const isFree = this.sel.mode === 'free' || (online && p?.mode === 'free');
    const creator = `<button data-act="photo-open">${t('pause.photo')}</button>
         <button data-act="replay-open">${t('pause.replay')}</button>
         <button data-act="export-motec">${t('pause.motec')}</button>
         ${isFree ? `<button data-act="carmeet-open">${t('pause.carmeet')}</button>` : ''}`;
    const btns = online
      ? `<button class="primary" data-act="resume">${t('pause.resume')}</button>
         ${creator}
         ${p!.isHost ? '<button data-act="plobby">↩ End Session · Everyone to Lobby</button>' : '<button data-act="quit">↩ Back to Lobby</button>'}
         <button data-act="settings-open">${t('pause.settings')}</button>
         <button data-act="pleave">${p!.isHost ? 'Close Party' : 'Leave Party'}</button>`
      : `<button class="primary" data-act="resume">${t('pause.resume')}</button>
         ${creator}
         <button data-act="restart">${t('pause.restart')} ${this.sel.mode === 'race' ? 'Race' : 'Session'}</button>
         <button data-act="settings-open">${t('pause.settings')}</button>
         <button data-act="quit">${t('pause.quit')}</button>`;
    return `<div class="card center pause-card">
      <div class="kicker">${online ? 'PARTY SESSION · OTHERS KEEP DRIVING' : 'SESSION PAUSED'}</div>
      <h2>Paused</h2>
      <div class="btns col">${btns}</div>
    </div>`;
  }

  private results(r: ResultData) {
    const ranked = rank(r.standings);
    const pos = ranked.findIndex((s) => s.you) + 1;
    const leader = ranked[0];
    const gap = (s: Standing) => {
      if (s.dnf) return `DNF${s.why ? ' · ' + s.why : ''}`;
      if (s === leader) return s.fin >= 0 ? formatLap(s.fin) : '—';
      if (s.fin >= 0 && leader.fin >= 0) return '+' + (s.fin - leader.fin).toFixed(3);
      const laps = Math.floor((leader.d - s.d) / r.routeLength);
      return laps >= 1 ? `+${laps} lap${laps > 1 ? 's' : ''}` : 'racing…';
    };
    const ord = (n: number) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
    const table = ranked.length > 1 ? `<div class="standings">${ranked.map((s, i) => `<div class="srow ${s.you ? 'you' : ''}">
        <span class="spos">${i + 1}</span><b>${esc(s.name)}</b><span class="dim">${s.best > 0 ? formatLap(s.best) : ''}</span><span class="sgap">${gap(s)}</span>${!s.you && !s.ai ? `<button class="small" data-act="report-open" data-v="${esc(s.name)}" title="Report hate speech livery/plate, griefing, or cheating">🚩</button>` : ''}</div>`).join('')}</div>` : '';
    const reportBar = this.reportTarget ? `<div class="pnote"><b>🚩 Report ${esc(this.reportTarget)}:</b>
      <button class="small" data-act="report-send" data-k="hate_livery_plate" data-v="${esc(this.reportTarget)}">Hate Speech Livery/Plate</button>
      <button class="small" data-act="report-send" data-k="griefing_ramming" data-v="${esc(this.reportTarget)}">Ramming / Griefing</button>
      <button class="small" data-act="report-send" data-k="cheating" data-v="${esc(this.reportTarget)}">Cheating</button>
      <button class="small" data-act="report-cancel">Cancel</button></div>` : '';
    const maintLines: string[] = [];
    if (r.towFeeXp) maintLines.push(`🚛 Tow Truck Fee (Totaled): -${r.towFeeXp} XP${r.insured ? ' (50% Insured)' : ''}`);
    if (r.damagePct && r.damagePct > 0) maintLines.push(`🔧 Saved Car Damage: ${r.damagePct}% · Est. Repair ${r.repairBillXp ?? 0} XP${r.insured ? ' (-50% Insured)' : ''} — repair in Garage`);
    const maintHtml = maintLines.length ? `<div class="pnote bad">${maintLines.map(esc).join('<br>')}</div>` : '';
    const rows = r.laps.map((t, i) => `<div class="row"><span>LAP ${i + 1}</span><b class="${t === r.best ? 'best' : ''}">${formatLap(t)}</b></div>`).join('');
    const p = this.party;
    const me = ranked.find((s) => s.you);
    const racing = ranked.some((s) => !s.you && s.fin < 0 && !s.dnf);
    const spec = racing ? '<button data-act="spectate">👁 Spectate</button>' : '';
    const btns = r.online
      ? spec + `<button data-act="export-motec">${t('results.export_motec')}</button>` + (p?.isHost ? '<button class="primary" data-act="plobby">↩ Everyone to Lobby</button>' : '<span class="dim wait">Waiting for the leader…</span>') + `<button data-act="pleave">${p?.isHost ? 'Close Party' : 'Leave Party'}</button>`
      : `<button class="primary" data-act="return-freeroam">${t('results.return_freeroam')}</button><button data-act="restart">↻ Race Again</button><button data-act="export-motec">${t('results.export_motec')}</button><button data-act="replay-open">🎬 Replay</button>` + spec + '<button data-act="quit-modes">Game Modes</button><button data-act="quit">Main Menu</button>';
    return `<div class="card center results-card">
      <div class="kicker">${r.online ? 'PARTY RACE' : 'RACE'} RESULT</div>
      <h2>${me?.dnf ? `Did not finish${me.why ? ' · ' + esc(me.why) : ''}` : ranked.length > 1 ? `You finished ${ord(pos)}` : 'Race Complete'}</h2>
      <div class="big ${pos === 1 && !me?.dnf ? 'win' : ''}">${me?.dnf ? 'DNF' : ranked.length > 1 ? `P${pos}<small> / ${ranked.length}</small>` : formatLap(r.total)}</div>
      <div class="dim">${me?.dnf ? `${r.laps.length} of ${r.laps_target} laps` : `${formatLap(r.total)} · ${r.laps_target} lap${r.laps_target > 1 ? 's' : ''}`} · Best lap <b class="best-inline">${formatLap(r.best)}</b></div>
      ${this.rewardHtml(r, !!me?.dnf)}
      ${maintHtml}
      ${reportBar}
      ${table}
      <div class="rows">${rows}</div>
      <div class="btns">${btns}</div>
    </div>`;
  }

  /** XP for a single-player race, or the online race room's verdict (ranked / unranked, XP, credits, notes). */
  private rewardHtml(r: ResultData, dnf: boolean) {
    if (r.online) {
      const x = this.rankedRes;
      if (!x) return `<div class="reward dim">${this.mp.ready ? 'The online race room is timing the race… (results when every car is in)' : 'Unranked: not connected to the online service.'}</div>`;
      const y = x.you;
      return `<div class="reward"><div class="kicker">${x.ranked ? 'RANKED RACE' : 'UNRANKED'}</div>
        ${y && (y.xp || y.cr) ? `<div class="earned center">+${fmtXp(y.xp)} · +${fmt(y.cr)}</div>` : ''}
        ${(y?.parts ?? []).filter((p) => p.xp).map((p) => `<div class="rpart"><span>${esc(p.label)}</span><b>+${p.xp.toLocaleString('en-US')}</b></div>`).join('')}
        ${(y?.notes ?? []).map((n) => `<div class="dim small-note">${esc(n)}</div>`).join('')}</div>`;
    }
    const e = this.sp.last;
    if (!e || r.earned === undefined) return '';
    if (dnf || !e.xp) return '<div class="reward dim">No XP for a DNF</div>';
    const unlocked = (e.unlocked ?? []).map((u) => {
      const [k, id, st] = u.split(':');
      return k === 'car' ? this.cars.find((c) => c.id === id)?.name ?? id : k === 'skin' ? `${skinOf(id).name} gear` : `${MODS[id as ModKey].levels[Number(st)]} (${MODS[id as ModKey].label})`;
    });
    return `<div class="reward"><div class="earned center">+${fmtXp(e.xp)}</div>
      ${(e.parts ?? []).filter((p) => p.xp).map((p) => `<div class="rpart"><span>${esc(p.label)}</span><b>+${p.xp.toLocaleString('en-US')}</b></div>`).join('')}
      ${e.levelUp ? `<div class="lvup big-lv">LEVEL ${e.levelUp}</div>` : ''}${unlocked.length ? `<div class="dim small-note">Unlocked: ${esc(unlocked.join(', '))}</div>` : ''}
      ${this.careerCard('sp')}</div>`;
  }
  /** The online race room's verdict arrived (results screen or later). */
  ranked(r: RankedResult | null) { this.rankedRes = r; if (this.screen === 'results' || this.screen === 'title') this.render(); }

  // ---- events ----------------------------------------------------------------------------------
  /** Fullscreen needs a user gesture, so the first menu click asks for it (once per page; ?fs=0 turns it off, F toggles later). */
  private fsAsked = false;
  private askFullscreen() {
    if (this.fsAsked || document.fullscreenElement || new URLSearchParams(location.search).get('fs') === '0') return;
    this.fsAsked = true;
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).then(() => {
      (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
    }).catch(() => { /* refused (iframe, policy): stay windowed */ });
  }

  private click(e: Event) {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    const act = b.dataset.act!;
    if (['play', 'garage-open', 'start-race', 'start-free', 'pstart', 'invite', 'prejoin'].includes(act)) this.askFullscreen();
    const v = b.dataset.v ?? '', sel = this.sel;
    if (act === 'controls-open') { this.controlsFrom = this.screen; this.show('controls'); return; }
    if (act === 'settings-open') { this.settingsFrom = this.screen; this.show('settings'); return; }
    if (act === 'settings-back') { this.show(this.settingsFrom); return; }
    if (act.startsWith('as-')) { this.assistClick(act, v); return; }
    if (act === 'c-back') { this.ctl?.leave(); this.show(this.controlsFrom); return; }
    if (act.startsWith('c-') && this.ctl?.click(act, v)) return;
    switch (act) {
      case 'play': this.sp.last = this.mp.last = null; this.show('modes'); break;
      case 'cam-mode': this.camMode = v; this.hooks.camMode?.(v); this.render(); break;
      case 'mirror': this.mirror = v === '1'; this.hooks.mirror?.(this.mirror); this.render(); break;
      case 'city': this.hooks.city?.(v); break;
      case 'laylow': this.hooks.layLow?.(); break;
      case 'garage-open': this.show('garage'); this.hooks.preview(); break;
      case 'home': this.show('title'); break;
      case 'profile-open': this.profileFrom = this.screen === 'profile' ? this.profileFrom : this.screen; this.unameDraft = null; this.unameNote = ''; this.friendNote = ''; this.show('profile'); break;
      case 'profile-back': this.show(this.profileFrom); break;
      case 'uname-save': void this.saveName(); break;
      case 'friend-add': void this.friendAct(this.friendDraft, 'add'); break;
      case 'friend-accept': void this.friendAct(v, 'accept'); break;
      case 'friend-remove': void this.friendAct(v, 'remove'); break;
      case 'friend-join': this.joinCode = v; this.setCareer('mp'); this.show('lobby'); this.hooks.partyJoin(v); break;
      case 'shop-open': this.shopNote = ''; this.shopCar = sel.car; this.shopTab = this.garageTab === 'perf' ? 'upgrades' : 'cars'; this.show('shop'); break;
      case 'shop-gear': this.shopNote = ''; this.shopTab = 'gear'; this.show('shop'); break;
      case 'stab': this.shopTab = v as typeof this.shopTab; this.render(); break;
      case 'gtab': { this.garageTab = v; const t = GTABS.find((x) => x.id === v); if (t) { const [az, el, dist] = t.cam.split(',').map(Number); this.hooks.cam?.(az, el, dist); } this.render(); break; }
      case 'cu': {
        const c = customOf(sel), k = b.dataset.k as keyof Custom;
        const val = k === 'livery' || k === 'tint' ? Number(v) : k === 'smokedTails' ? v === 'true' : v;
        (c as unknown as Record<string, unknown>)[k] = val;
        this.save(); this.hooks.look(); this.render();
        break;
      }
      case 'skin': if (this.career.ownsSkin(v)) { sel.skin = v; const sk = skinOf(v); Object.assign(sel.avatarGear, { helmet: sk.helmet, accent: sk.accent, visor: sk.visor, suit: sk.suit, gloves: sk.gloves }); this.save(); this.hooks.look(); this.hooks.partyMe(); this.render(); } break;
      case 'gear': {
        const k = b.dataset.k as keyof AvatarGear;
        if (k) { sel.avatarGear[k] = v; this.save(); this.hooks.look(); this.render(); }
        break;
      }
      case 'gear-match': {
        const paint = paintOf(sel, this.cars);
        const liveryCol = customOf(sel).liveryColor || '#ff2d6a';
        Object.assign(sel.avatarGear, { helmet: paint, accent: liveryCol, suit: paint, gloves: liveryCol, shoes: liveryCol });
        this.save(); this.hooks.look(); this.render();
        break;
      }
      case 'lang': setLang(v as LangCode); this.hooks.language?.(v as LangCode); this.render(); break;
      case 'a11y-cb': this.a11y.colorblind = v as ColorblindMode; this.hooks.accessibility?.(); this.render(); break;
      case 'a11y-scale': this.a11y.uiScale = Number(v) as UiScale; this.hooks.accessibility?.(); this.render(); break;
      case 'simhub': this.simhubOn = v === '1'; this.hooks.simhubToggle?.(this.simhubOn); this.render(); break;
      case 'export-motec': this.hooks.exportMotec?.(); break;
      case 'photo-open': this.hooks.photoMode?.(); break;
      case 'replay-open': this.hooks.replayMode?.(); break;
      case 'carmeet-open': this.hooks.carMeet?.(); break;
      case 'return-freeroam': this.lastResults = null; this.hooks.returnFreeRoam?.(); break;
      case 'cloud-sync': this.hooks.cloudSync?.(); break;
      case 'insure': this.maint.insured = v === '1'; this.hooks.toggleInsurance?.(this.maint.insured); this.render(); break;
      case 'repair-car': this.hooks.repairCar?.(); this.render(); break;
      case 'report-open': this.reportTarget = v; this.render(); break;
      case 'report-cancel': this.reportTarget = ''; this.render(); break;
      case 'report-send': {
        const cat = b.dataset.k as ReportCategory;
        this.reportTarget = '';
        this.hooks.reportPlayer?.(v, cat);
        this.render();
        break;
      }
      case 'g-ignition': this.hooks.garageIgnition?.(); break;
      case 'g-rev': this.hooks.garageRev?.(); break;
      case 'g-walk': this.garageWalkActive = !this.garageWalkActive; this.hooks.garageWalk?.(this.garageWalkActive); this.render(); break;
      case 'nr-walk': this.nr.walkableGarage = v === '1'; if (!this.nr.walkableGarage) this.garageWalkActive = false; this.hooks.nrChanged?.(); this.render(); break;
      case 'nr-stance': {
        const st = stanceOf(this.nr, sel.car);
        const k = b.dataset.k as 'camberFront' | 'camberRear' | 'rideHeightMm' | 'springMul';
        if (k) { st[k] = Number(v); this.hooks.nrChanged?.(); this.render(); }
        break;
      }
      case 'nr-turbo': engineOf(this.nr, sel.car).turbo = v as TurboId; this.hooks.nrChanged?.(); this.render(); break;
      case 'nr-man': engineOf(this.nr, sel.car).manifold = v as ManifoldId; this.hooks.nrChanged?.(); this.render(); break;
      case 'nr-swap': {
        const eng = engineOf(this.nr, sel.car);
        if (eng.health <= ENGINE_SWAP_THRESHOLD || v === 'stock') {
          eng.swap = v as SwapId;
          eng.health = 100;
          eng.oilLife = 100;
          this.hooks.nrChanged?.();
          this.render();
        }
        break;
      }
      case 'nr-oil': {
        const eng = engineOf(this.nr, sel.car);
        eng.oilLife = 100;
        if (this.sp.kind === 'sp') this.sp.penalty(50);
        this.hooks.nrChanged?.();
        this.render();
        break;
      }
      case 'nr-rebuild': {
        const eng = engineOf(this.nr, sel.car);
        eng.health = 100;
        eng.oilLife = 100;
        if (this.sp.kind === 'sp') this.sp.penalty(350);
        this.hooks.nrChanged?.();
        this.render();
        break;
      }
      case 'nr-nos': {
        const eng = engineOf(this.nr, sel.car);
        const add = Math.min(NOS_MAX_LITERS - eng.nosLiters, Number(v) || 5);
        if (add > 0.1) {
          eng.nosLiters = Math.min(NOS_MAX_LITERS, eng.nosLiters + add);
          if (this.sp.kind === 'sp') this.sp.penalty(Math.round(add * NOS_PRICE_PER_LITER_XP));
          this.hooks.nrChanged?.();
          this.render();
        }
        break;
      }
      case 'buy-auction': this.hooks.buyAuction?.(v); this.render(); break;
      case 'prestige': this.hooks.prestigeReset?.(); this.render(); break;
      case 'voice-toggle': this.hooks.voiceToggle?.(); break;
      case 'voice-mode': this.hooks.voiceMode?.(v as 'ptt' | 'open'); this.render(); break;
      case 'pmatch': this.hooks.publicMatchmake?.(); break;
      case 'wear-skin': if (this.career.ownsSkin(v)) { sel.skin = v; this.save(); this.hooks.look(); this.hooks.partyMe(); this.render(); } break;
      case 'shop-car': this.shopCar = v; this.render(); break;
      case 'shop-drive': sel.car = v; this.shopCar = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'buy': {
        const st = b.dataset.stage ? Number(b.dataset.stage) : undefined;
        this.shopNote = '…'; this.render();
        void this.career.buy(b.dataset.kind as 'car' | 'mod' | 'skin', v, st).then((note) => { this.shopNote = note; if (b.dataset.kind === 'car' && this.career.owns(v)) this.shopCar = v; this.render(); });
        break;
      }
      case 'career': {
        sel.career = v === 'mp' ? 'mp' : 'sp';
        this.career.fit(sel); this.save(); this.shopNote = '';
        if (sel.career === 'mp' && !this.mp.ready) void this.mp.refresh();
        this.render(); this.hooks.preview();
        break;
      }
      case 'recovery': this.recoveryShown = !this.recoveryShown; this.render(); break;
      case 'restore': {
        const code = (document.getElementById('restore') as HTMLInputElement | null)?.value ?? '';
        if (this.cloud.restore(code)) { this.mp.profile = null; this.settingsNote = '✓ Account restored on this device.'; void this.mp.refresh(); } else this.settingsNote = 'That is not a recovery code.';
        this.render();
        break;
      }
      case 'modes': this.show('modes'); break;
      case 'quit-modes': this.lastResults = null; this.hooks.quit('modes'); break;
      case 'lobby': this.partyNote = ''; this.setCareer('mp'); this.show('lobby'); break;
      case 'gfx': this.gfx = v as Gfx; this.hooks.gfx(this.gfx); this.render(); break;
      case 'car': sel.car = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'paint': sel.paint[sel.car] = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'finish': sel.finish = v as Finish; this.save(); this.render(); this.hooks.preview(); break;
      case 'look': {
        // one chip sets paint + finish + every part; preview() re-applies the paint and the look uniforms together
        if (applyLookPreset(sel, v)) { this.save(); this.render(); this.hooks.preview(); this.hooks.look(); }
        break;
      }
      case 'mod': { const m = { ...modsOf(sel) }; m[b.dataset.k as ModKey] = Number(v); sel.mods[sel.car] = m; this.save(); this.render(); break; }
      case 'laps': sel.laps = Number(v); this.save(); this.render(); break;
      case 'copmode': sel.copMode = v === '1'; this.save(); this.render(); break;
      case 'start-race': sel.mode = 'race'; this.setCareer('sp'); this.save(); this.hooks.play('race'); break;
      case 'start-free': sel.mode = 'free'; this.setCareer('sp'); this.save(); this.hooks.play('free'); break;
      case 'resume': this.hooks.resume(); break;
      case 'restart': this.hooks.restart(); break;
      case 'quit': this.lastResults = null; this.hooks.quit('title'); break;
      case 'bench': this.hooks.bench(false); break;
      case 'soak': this.hooks.bench(true); break;
      case 'cam': { if (v === 'orbit') { this.hooks.cam?.(NaN, 0, 0); break; } const [az, el, dist] = v.split(',').map(Number); this.hooks.cam?.(az, el, dist); break; }
      // multiplayer
      case 'invite': this.joinCode = this.invite; this.show('lobby'); this.hooks.partyJoin(this.invite); break;
      case 'noinvite': this.invite = ''; this.render(); break;
      case 'pcreate': this.hooks.partyCreate(); break;
      case 'pjoin': this.hooks.partyJoin(this.joinCode); break;
      case 'pleave': this.hooks.partyLeave(); break;
      case 'pmode': this.party && this.hooks.partyMode(v as PartyMode, this.party.laps, this.party.realism, v === 'free' ? false : this.party.copMode); break;
      case 'plaps': this.party && this.hooks.partyMode(this.party.mode, Number(v), this.party.realism, this.party.copMode); break;
      case 'preal': this.party && this.hooks.partyMode(this.party.mode, this.party.laps, v === '1', this.party.copMode); break;
      case 'pcop': this.party && this.hooks.partyMode(this.party.mode, this.party.laps, this.party.realism, v === '1'); break;
      case 'realism': sel.realism = v === '1'; this.save(); this.render(); break;
      case 'spectate': this.hooks.spectate(); break;
      case 'pstart': this.hooks.partyStart(); break;
      case 'plobby': this.hooks.partyLobby(); break;
      case 'prejoin': this.hooks.partyRejoin(); break;
      case 'pcopy': this.copyLink(); break;
      case 'pshare': if (this.party) navigator.share?.({ title: 'OpenGrid party', text: `Join my OpenGrid party (code ${this.party.code})`, url: this.party.link }).catch(() => {}); break;
    }
  }
  private assistClick(act: string, v: string) {
    const a = this.assists;
    if (act === 'as-preset') applyPreset(a, v as Preset);
    else {
      if (act === 'as-abs') a.abs = v as typeof a.abs;
      if (act === 'as-tc') a.tc = Number(v);
      if (act === 'as-esc') a.stability = v === '1';
      if (act === 'as-cs') a.countersteer = v as typeof a.countersteer;
      if (act === 'as-gb') a.gearbox = v as typeof a.gearbox;
      if (act === 'as-line') a.line = v as typeof a.line;
      matchPreset(a);
    }
    this.hooks.assists();
    this.render();
  }

  /** The session about to start belongs to this career: its car / upgrades / gear. */
  private setCareer(k: 'sp' | 'mp') {
    if (this.sel.career === k) return;
    this.sel.career = k;
    this.career.fit(this.sel);
    this.save();
    if (k === 'mp' && !this.mp.ready) void this.mp.refresh();
    this.hooks.preview();
  }

  // ---- username and friends (identity.ts) -----------------------------------------------------------------------------------
  /** First start: a username before anything else (how friends find you; shown in races and on your plate). */
  private pickName() {
    const draft = this.unameDraft ?? (usernameError(this.sel.name) ? '' : this.sel.name);
    return `<div class="lobby-screen"><div class="card lobby-card pick-card">
      <div class="kicker">WELCOME TO OPENGRID</div><h2>Choose your username</h2>
      <p class="dim">Friends add you by it, and everyone sees it in races: on the leaderboard, over your car and on your number plate.
        ${this.cloud.available ? 'It is yours alone: nobody else can take it.' : ''}</p>
      ${this.unameField(draft)}
      <div class="lobby-foot"><span class="dim small-note">${USERNAME_MIN}-${USERNAME_MAX} characters · letters, digits, _ . - · no #</span>
        <button class="primary huge" data-act="uname-save" ${this.unameBusy ? 'disabled' : ''}>Continue ▶</button></div>
    </div></div>`;
  }
  private unameField(draft: string) {
    const bad = this.unameNote && !this.unameNote.startsWith('✓');
    return `<div class="joinrow"><input id="uname" type="text" maxlength="${USERNAME_MAX}" value="${esc(draft)}" placeholder="username" spellcheck="false" autocomplete="off" autocapitalize="off" />
      ${this.screen === 'profile' ? `<button class="primary" data-act="uname-save" ${this.unameBusy ? 'disabled' : ''}>Save</button>` : ''}</div>
      <div class="pnote ${bad ? 'bad' : ''}" id="uname-note">${this.unameBusy ? '<span class="spin inline"></span> ' : ''}${esc(this.unameNote)}</div>`;
  }
  private async liveCheck(u: string) {
    const seq = ++this.unameSeq;
    const local = usernameError(u.trim());
    if (local || !u.trim()) { this.unameNote = u.trim() ? local! : ''; this.paintNote(); return; }
    await new Promise((r) => setTimeout(r, 350));   // typing: ask the server once it pauses
    if (seq !== this.unameSeq) return;
    const why = await this.identity.check(u.trim());
    if (seq !== this.unameSeq) return;
    this.unameNote = why || (this.cloud.available ? '✓ Available' : '');
    this.paintNote();
  }
  /** the note under the username input, without re-rendering (the input keeps its caret) */
  private paintNote() {
    const el = document.getElementById('uname-note');
    if (!el) return;
    el.textContent = this.unameNote;
    el.classList.toggle('bad', !!this.unameNote && !this.unameNote.startsWith('✓'));
  }
  private async saveName() {
    const u = (this.unameDraft ?? this.sel.name).trim();
    this.unameBusy = true; this.render();
    const why = await this.identity.pick(u);
    this.unameBusy = false;
    if (why) { this.unameNote = why; this.render(); return; }
    this.unameDraft = null;
    this.unameNote = this.identity.note || '✓ Saved';
    this.hooks.partyMe();
    this.render();
  }
  private async friendAct(u: string, action: 'add' | 'accept' | 'remove') {
    if (!u.trim()) return;
    this.friendNote = await this.identity.friend(u, action);
    if (action === 'add' && this.friendNote.startsWith('✓')) this.friendDraft = '';
    this.render();
  }
  private profile() {
    const id = this.identity, f = id.friends, online = this.cloud.available;
    const draft = this.unameDraft ?? this.sel.name;
    const status = !online ? 'Saved on this device. The online service is not set up for this build, so the name cannot be reserved yet.'
      : id.claimed ? '✓ Reserved for you on the online service.' : id.note || 'Not confirmed by the online service yet.';
    const seen = (x: Friend) => (typeof x.seenAgo === 'number' ? `Offline · last seen ${agoText(x.seenAgo + Math.max(0, Date.now() - id.friendsAt))}` : 'Offline');
    const friend = (x: Friend) => `<div class="member">
        <span class="avatar"><i class="dot ${x.online ? 'on' : ''}"></i></span>
        <div class="mtext"><div class="mname"><b>${esc(x.username)}</b><span class="pill">Lv ${x.level}</span></div>
        <span class="dim">${x.online ? (x.party ? `Online · in party ${esc(x.party)}` : 'Online') : seen(x)}</span></div>
        ${x.party && !this.party ? `<button class="small primary" data-act="friend-join" data-v="${esc(x.party)}">Join</button>` : ''}
        <button class="small" data-act="friend-remove" data-v="${esc(x.username)}" title="Remove friend">✕</button>
      </div>`;
    const incoming = f.incoming.map((u) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(u)}</b></div><span class="dim">wants to be friends</span></div>
        <button class="small primary" data-act="friend-accept" data-v="${esc(u)}">Accept</button><button class="small" data-act="friend-remove" data-v="${esc(u)}">Decline</button></div>`).join('');
    const outgoing = f.outgoing.map((u) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(u)}</b></div><span class="dim">request sent</span></div>
        <button class="small" data-act="friend-remove" data-v="${esc(u)}">Cancel</button></div>`).join('');
    const friendsBlock = !online ? `<div class="dim note">${esc(id.friendsNote || 'Friends need the online service, which is not set up for this build.')}</div>` : `
      <div class="joinrow"><input id="fadd" type="text" maxlength="${USERNAME_MAX}" value="${esc(this.friendDraft)}" placeholder="Add a friend by username" spellcheck="false" autocomplete="off" autocapitalize="off" />
        <button class="primary" data-act="friend-add" ${id.claimed ? '' : 'disabled'}>Add</button></div>
      ${this.friendNote ? `<div class="pnote ${this.friendNote.startsWith('✓') ? '' : 'bad'}">${esc(this.friendNote)}</div>` : ''}
      ${id.friendsNote ? `<div class="pnote bad">${esc(id.friendsNote)}</div>` : ''}
      ${incoming ? `<h3>Requests</h3><div class="members">${incoming}</div>` : ''}
      <h3>Friends <small class="dim">${f.friends.filter((x) => x.online).length} online · ${f.friends.length}</small></h3>
      <div class="members">${f.friends.map(friend).join('') || '<div class="dim note">No friends yet. Share your username, or add theirs above.</div>'}</div>
      ${outgoing ? `<h3>Sent</h3><div class="members">${outgoing}</div>` : ''}`;
    return `<div class="lobby-screen"><div class="card lobby-card profile-card">
      <div class="lobby-head"><button data-act="profile-back" class="back-btn">← Back</button><div><div class="kicker">PROFILE</div><h2>${esc(this.sel.name)}</h2></div></div>
      <h3>Username</h3>
      <p class="dim">Friends add you by it; it shows on the race leaderboard, over your car and on your number plate (up to ${PLATE_MAX} characters).
        ${online ? 'You can change it once every 30 days.' : ''}</p>
      ${this.unameField(draft)}
      <div class="dim note">${esc(status)}</div>
      <h3>Friends</h3>${friendsBlock}
    </div></div>`;
  }

  private copyLink() {
    if (!this.party) return;
    const link = this.party.link;
    const done = (ok: boolean) => { this.partyNote = ok ? 'Copied the invite link. Send it to your friends.' : 'Select the link and copy it.'; this.render(); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => done(true), () => done(false));
    else { (document.getElementById('plink') as HTMLInputElement | null)?.select(); done(document.execCommand?.('copy') ?? false); }
  }
  private input(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.sel.paint[this.sel.car] = t.value; this.hooks.preview(); }   // live while dragging
    if (t.id === 'joincode') { const c = cleanCode(t.value); if (c !== t.value) t.value = c; this.joinCode = c; }
    if (t.id === 'uname') { this.unameDraft = t.value; void this.liveCheck(t.value); }
    if (t.id === 'fadd') this.friendDraft = t.value;
    if (t.type === 'range') this.ctl?.slide(t);
  }
  private change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.save(); this.render(); }
  }
}
