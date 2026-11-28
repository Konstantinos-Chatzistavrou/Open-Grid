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
import { FREE_ROAM_MAX_PLAYERS, RACE_MAX_PLAYERS, cleanCode, type GarageStateNetMsg, type Party, type PartyMode } from './party';
import type { ControlsUi } from './controls-menu';
import { PRESET_INFO, applyPreset, assistsOffCount, matchPreset, type AssistSettings, type BrakingAssistLevel, type Preset, type SteeringAssistLevel } from './assists';
import { fmt, fmtXp, type Career, type MpCareer, type SpCareer } from './career';
import type { Cloud, Friend, OAuthProvider, OAuthProvidersStatus, OfficialSeriesEvent } from './cloud';
import type { RankedResult } from './ranked';
import { STARTER_CAR, levelOf } from './progression';
import type { Loader } from './loading';
import { AERO_FINISHES, DIFFUSERS, FENDERS, FRONT_BUMPERS, GLOW_COLOURS, HEAD_TINTS, HOODS, LIVERIES, PART_COLOURS, REAR_BUMPERS, RIM_FINISHES, RIMS, SKIRTS, SPLITTERS, WINGS, type Custom } from './scene/custom';
import { SKINS, helmetSvg, skinOf } from './scene/driver';
import { LANGS, getLang, setLang, t, type LangCode } from './i18n';
import type { AccessibilitySettings, ColorblindMode, UiScale } from './accessibility';
import type { AvatarGear } from './carMeet';
import { INSURANCE_PREMIUM_CR, INSURANCE_PREMIUM_XP, conditionOf, recordRaceDamage, repairCarCondition, repairCostOf, saveMaintenance, type MaintenanceStore, type ReportCategory } from './maintenance';
import { ENGINE_SWAPS, MANIFOLDS, NOS_MAX_LITERS, NOS_PRICE_PER_LITER_XP, TURBOS, engineOf, saveNightRunners, stanceOf, type ManifoldId, type NightRunnersStore, type SwapId, type TurboId } from './nightRunners';
import { AUCTION_MARKET_FEE, DEALER_SPREAD, MOD_OVERPAY_RATE, appraiseCarForSale, generateLiveAuctionLots, gradeFromFloat, loadAuctionMarket, marketEntryOf, recordMarketTrade, renderPriceSparklineSvg, saveAuctionMarket, trendPctOf, type AuctionMarketStore, type LiveAuctionLot } from './auctionMarket';
import { brandBadgeSvg, brandOfCar, stockEngineOfCar } from './brands';
import { PARTY_BONUS_MUL, type RetentionStore } from './retention';
import { checkSplitScreen, type SplitLayout } from './splitScreen';
import { MOD_CATALOG, loadModHub, toggleModSub, type ModHubStore } from './modHub';
import { ACADEMY_LESSONS, WEEKLY_CALENDAR, loadCompletedLessons, todayCalendarEvent, type AcademyLesson, type CalendarEvent } from './careerEvents';
import { AI_DIFFICULTY_PRESETS, difficultyProfile } from './aiPlanner';
import { renderQrSvg } from './qrSvg';
import { clearGate, markGate } from './gate';

/** Look of the small cards inside the account forms (Profile screen and the welcome gate). */
const AUTH_CARD_STYLE = 'margin-top:10px;padding:12px 14px;border-radius:10px;background:#0A0A0A;border:1px solid rgba(255,255,255,.14)';

/** Sign-in provider marks for the welcome gate's icon buttons: four-colour Google G, white GitHub mark, Discord blurple. */
const BRAND_NAME: Record<OAuthProvider, string> = { google: 'Google', github: 'GitHub', discord: 'Discord' };
const BRAND_ICON: Record<OAuthProvider, string> = {
  google: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
  github: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  discord: '<svg viewBox="0 0 24 24" fill="#5865F2" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>',
};

type GaragePillar = 'rides' | 'style' | 'perf' | 'driver';

/** Granular NFS Heat-inspired Garage sub-categories: each focuses on ONE zone & swings the camera onto that exact part. */
const GTABS: { id: string; pillar: GaragePillar; label: string; cam: string }[] = [
  // Pillar 2: Style & Body (granular — never lumped into giant mixed walls!)
  { id: 'paint',   pillar: 'style',  label: 'Paint',          cam: '0.8,0.17,6.4' },
  { id: 'wraps',   pillar: 'style',  label: 'Wraps & Livery', cam: '1.15,0.18,6.5' },
  { id: 'front',   pillar: 'style',  label: 'Front & Lip',    cam: '0.28,0.10,5.2' },
  { id: 'rear',    pillar: 'style',  label: 'Rear & Diffuser',cam: '2.92,0.12,5.2' },
  { id: 'wing',    pillar: 'style',  label: 'Rear Wing',      cam: '2.45,0.24,5.6' },
  { id: 'hood',    pillar: 'style',  label: 'Hood',           cam: '0.35,0.28,5.0' },
  { id: 'bodykit', pillar: 'style',  label: 'Fenders & Skirts',cam: '1.38,0.10,5.4' },
  { id: 'wheels',  pillar: 'style',  label: 'Wheels & Brakes',cam: '1.42,0.05,4.1' },
  { id: 'lights',  pillar: 'style',  label: 'Lighting & Glow',cam: '0.35,0.10,5.6' },
  { id: 'exhaust', pillar: 'style',  label: 'Exhaust & Tint', cam: '2.95,0.08,4.6' },
  // Pillar 3: Performance
  { id: 'swaps',   pillar: 'perf',   label: 'Engine Swaps',   cam: '2.85,0.12,5.0' },
  { id: 'boost',   pillar: 'perf',   label: 'Turbo & Exhaust',cam: '0.25,0.22,4.6' },
  { id: 'perf',    pillar: 'perf',   label: 'Stage Upgrades', cam: '0.85,0.17,6.3' },
  { id: 'stance',  pillar: 'perf',   label: 'Stance & Susp.', cam: '1.45,0.04,4.8' },
  { id: 'care',    pillar: 'perf',   label: 'Nitrous & Care', cam: '0.45,0.20,5.0' },
  // Pillar 4: Driver
  { id: 'driver',  pillar: 'driver', label: 'Driver Gear',    cam: '1.45,0.16,4.2' },
];

const GARAGE_CAMS: { label: string; v: string }[] = [
  { label: 'Orbit',  v: 'orbit' },
  { label: '3/4',    v: '0.8,0.17,6.5' },
  { label: 'Front',  v: '0,0.12,5.8' },
  { label: 'Side',   v: '1.57,0.08,6.2' },
  { label: 'Rear',   v: '3.14,0.13,5.4' },
  { label: 'Low',    v: '1.35,0.03,4.8' },
  { label: 'Top',    v: '0.9,0.55,6.8' },
];

export type Gfx = 'auto' | 'max' | 'ultra' | 'high' | 'medium' | 'low' | 'potato';
export type Screen = 'none' | 'welcome' | 'title' | 'garage' | 'modes' | 'lobby' | 'pause' | 'results' | 'busy' | 'controls' | 'settings' | 'shop' | 'profile';
/** One line of the race standings. fin: finish time (s) or -1; d: distance covered (m); dnf: out of the race. */
export interface Standing { name: string; you: boolean; fin: number; d: number; best: number; ai: boolean; dnf?: boolean; why?: string }
export interface ResultData {
  total: number; best: number; laps: number[]; laps_target: number; standings: Standing[]; routeLength: number; online: boolean;
  /** credits/XP paid for this race */ earned?: number;
  /** Tow Truck Fee deducted when totaled, saved structural damage %, Insurance discount, and race time penalties */
  towFeeXp?: number; repairBillXp?: number; insured?: boolean; damagePct?: number; penaltySec?: number;
  /** Assist Graduation ladder tip when player drove cleanly with low assist intervention */
  graduationTip?: string;
}

export interface MenuHooks {
  /** a visual choice changed (car, paint, finish): main updates the preview */
  preview(): void;
  /** game modes screen: start a single-player session */
  play(mode: Mode): void;
  /** game modes screen: start 2-player local Split-Screen (Laptop + Smart TV / 2 Controllers / Shared Keyboard) */
  playSplit?(mode: 'race' | 'free', layout: SplitLayout, p2CarId: string): void;
  gfx(g: Gfx): void;
  resume(): void;
  restart(): void;
  /** leave the session for the main menu / game modes (single player) or the lobby (party) */
  quit(to: 'title' | 'modes'): void;
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
  garageDyno?(): void;
  garageRev?(): void;
  garageRevHold?(held: boolean): void;
  garageWalk?(on: boolean): void;
  garageInvite?(): void;
  garageVisitJoin?(): void;
  garageVisitLeave?(): void;
  garageEmote?(text: string): void;
  nrChanged?(): void;
  buyAuction?(lotId: string): void;
  prestigeReset?(): void;
  voiceToggle?(): void;
  voiceMode?(m: 'ptt' | 'open'): void;
  voiceMutePeer?(peerId: string): void;
  voiceBlockPeer?(peerId: string): void;
  publicMatchmake?(): void;
  musicToggle?(on: boolean): void;
  audioEngineMode?(mode: 'real_samples' | 'engine_sim'): void;
  spotterToggle?(on: boolean): void;
  registerOfficialSeries?(seriesId: string): void;
  joinOfficialSplit?(eventKey: string): void;
  refreshSchedule?(): void;
  refreshHubTab?(tab: 'splits' | 'champs' | 'hotlaps' | 'leagues', seriesId?: string): void;
  connectPatreon?(): void;
  refreshSubscription?(): void;
  createTeam?(name: string, tag: string): void;
  createLeague?(spec: { name: string; description?: string; seriesRules?: string; password?: string }): void;
  joinLeague?(code: string, password?: string): void;
  fileProtest?(raceId: string, accused: string, incidentType: 'intentional_wreck' | 'unsafe_rejoin' | 'blocking' | 'ramming' | 'chat_abuse'): void;
  useJoker?(raceId: string): void;
  launchAcademy?(lesson: AcademyLesson): void;
  launchCalendar?(ev: CalendarEvent): void;
  specClassToggle?(on: boolean): void;
  sanctionedToggle?(on: boolean): void;
  onAiDifficulty?(pct: number, adaptive: boolean): void;
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
  inviteKind: 'party' | 'garage' = 'party';
  visitingGarage: GarageStateNetMsg | null = null;
  garageFeed: string[] = [];
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
  private authEmail = '';
  private authPass = '';
  private authTotp = '';
  private authNeeds2fa = false;
  private authForgotOpen = false;
  private authResetEmail = '';
  private authResetCode = '';
  private authResetPass = '';
  private recoveryCodes: string[] = [];
  private totpSetup: { secret: string; otpauthUri: string } | null = null;
  private totpVerifyCode = '';
  private totpDisableOpen = false;
  private totpDisableCode = '';
  private pwPanelOpen = false;
  private pwCur = '';
  private pwNew = '';
  private delPanelOpen = false;
  private delPass = '';
  private delConfirm = '';
  authNote = '';
  private authBusy = false;
  officialEvents: OfficialSeriesEvent[] = [];
  officialSeason = '';
  officialNote = '';
  patreonInfo: { patreonUrl?: string | null; patreonConnected?: boolean; patreonOAuthEnabled?: boolean; proMinUsd?: number; teamMinUsd?: number; daysLeft?: number } | null = null;
  oauthProviders: OAuthProvidersStatus = { google: false, github: false, discord: false };
  lobbyTab: 'splits' | 'champs' | 'hotlaps' | 'leagues' = 'splits';
  champSeries = 'gt3_championship';
  champStandings: { account: string; name: string; license: string; dr: number; locked_car: string; points: number; starts: number; wins: number; podiums: number }[] = [];
  hotlapEntries: { id: string; username: string; car: string; lap_ms: number; created: number }[] = [];
  myTeams: { id: string; name: string; tag: string; role: string }[] = [];
  publicLeagues: { id: string; name: string; code: string; description: string; series_rules: string; bop_enabled: number; max_drivers: number; is_private: number; member_count: number; created: number }[] = [];
  private teamNameDraft = '';
  private teamTagDraft = '';
  private leagueNameDraft = '';
  private leagueDescDraft = '';
  private leaguePassDraft = '';
  private leagueJoinCode = '';
  private leagueJoinPass = '';
  protestNote = '';
  spotterOn = true;
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
  voiceMutedPeers = new Set<string>();
  garageWalkActive = false;
  garageEngineOn = false;
  private revHoldActive = false;
  musicOn = true;
  audioEngineMode: 'real_samples' | 'engine_sim' = 'real_samples';
  specClass = false;
  sanctionedMode = false;
  modHub: ModHubStore = loadModHub();
  completedLessons: string[] = loadCompletedLessons();
  private carFilter: 'all' | 'fav' | 'S' | 'A' | 'B' = 'all';
  private carSort: 'name' | 'power' | 'weight' = 'name';
  private favCars: string[] = (() => { try { return JSON.parse(localStorage.getItem('nr.favcars.v1') ?? '[]'); } catch { return []; } })();
  private reportTarget = '';
  simhubOn = false;
  telemetrySamples = 0;
  private shopTab: 'lots' | 'market' | 'sell' | 'mods' = 'lots';
  private splitLayout: SplitLayout = 'horizontal';
  private splitP2Car = '';
  market!: AuctionMarketStore;
  private lotWindowOffset = 0;
  private garageNote = '';
  /** the rear-view mirror at the top of the screen while driving */
  mirror = true;
  assists!: AssistSettings;
  private settingsFrom: Screen = 'title';
  /** the loading screen ('busy' shows it; main may hold it while the game warms up) */
  loader!: Loader;
  private shopNote = '';
  private garagePillar: GaragePillar = 'style';
  private garageTab = 'paint';
  private garageCamIdx = 0;
  garageHideUi = false;
  /** Persistent scroll positions (vertical + horizontal) across re-renders until the menu screen itself is closed. */
  private scrollMem = new Map<string, { top: number; left: number }>();
  /** True when the Garage right/bottom customization drawer is visible (so camera frames car cleanly on the left/upper stage). */
  get garageDrawerOpen(): boolean { return this.screen === 'garage' && !this.visitingGarage && this.garagePillar !== 'rides' && !this.garageHideUi; }
  /** the option under the pointer: the live panel previews its effect without applying it */
  private hover: { k: string; v: string | number } | null = null;

  constructor(readonly sel: Selection, private cars: CatalogCar[], private physics: Record<string, unknown>, private hooks: MenuHooks) {
    this.market = loadAuctionMarket(this.cars.map((c) => c.id));
    this.root.addEventListener('click', (e) => this.click(e));
    // Press-and-hold momentary Garage Rev button (mouse + touch, never toggled, no DOM re-render mid-hold)
    const releaseRev = () => {
      if (!this.revHoldActive) return;
      this.revHoldActive = false;
      this.hooks.garageRevHold?.(false);
      this.root.querySelectorAll('.g-rev-btn.revving').forEach((el) => el.classList.remove('revving'));
    };
    this.root.addEventListener('pointerdown', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.('[data-hold="g-rev"]') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      this.revHoldActive = true;
      btn.classList.add('revving');
      this.hooks.garageRevHold?.(true);
      // Sync Ignition toggle button in-place without re-rendering (keeps pointer hold uninterrupted!)
      const ign = document.getElementById('g-ign-btn');
      if (ign && this.garageEngineOn) {
        ign.classList.add('on');
        const lbl = ign.querySelector('.lbl');
        if (lbl) lbl.textContent = ' Stop';
      }
    });
    this.root.addEventListener('pointerout', (e) => {
      if (!this.revHoldActive) return;
      const btn = (e.target as HTMLElement | null)?.closest?.('[data-hold="g-rev"]') as HTMLElement | null;
      if (!btn) return;
      const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
      if (to && btn.contains(to)) return;
      releaseRev();
    });
    window.addEventListener('pointerup', releaseRev);
    window.addEventListener('pointercancel', releaseRev);
    window.addEventListener('blur', releaseRev);
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
      // welcome gate: Enter in the email / password / 2FA box logs in (a new account needs the explicit Create Account button)
      if (e.key === 'Enter' && this.screen === 'welcome' && (t.id === 'auth-email' || t.id === 'auth-pass' || t.id === 'auth-totp')) void this.submitAuth('login');
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text') e.stopPropagation();   // typing a name or code never drives the car
    });
  }

  show(s: Screen, busyText = '') {
    clearInterval(this.friendsTimer);
    if (s !== this.screen) this.scrollMem.clear();
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

  /** Public helper for 3D click-on-part customization in the Garage. */
  openGarageTab(tabId: string) {
    if (this.screen !== 'garage') return;
    // Map legacy 3D click aliases to our new granular NFS Heat sub-categories
    const alias: Record<string, string> = { body: 'front', aero: 'wing', fenders: 'bodykit', glass: 'exhaust', engine: 'swaps' };
    const id = alias[tabId] ?? tabId;
    const t = GTABS.find((x) => x.id === id);
    if (!t) return;
    this.garagePillar = t.pillar;
    this.garageTab = t.id;
    const [az, el, dist] = t.cam.split(',').map(Number);
    this.hooks.cam?.(az, el, dist);
    this.render();
  }

  private car() { return this.cars.find((c) => c.id === this.sel.car)!; }
  private save() { saveSelection(this.sel); }

  render() {
    // don't rebuild under the cursor while someone types a name or code
    const focused = document.activeElement as HTMLInputElement | null;
    const keep = focused && this.root.contains(focused) && focused.tagName === 'INPUT' ? { id: focused.id, a: focused.selectionStart, b: focused.selectionEnd } : null;
    // Persist BOTH scrollTop & scrollLeft across ALL scrollable menus/drawers until the menu itself is closed!
    const SCROLL_SELS = [
      '.g-stage-scroll', '.g-rail', '.g-rides-strip', '.g-rides-dock', '.g-pillars', '.g-rides-bar',
      '.title', '.modes-screen', '.lobby-screen', '.lobby-card', '.settings-card', '.controls-card',
      '.shop-card', '.pause-card', '.results-card', '.members', '.gtabs', '.city-row',
    ];
    for (const sel of SCROLL_SELS) {
      const el = this.root.querySelector(sel);
      if (el) this.scrollMem.set(sel, { top: el.scrollTop, left: el.scrollLeft });
    }
    const html = {
      none: () => '', welcome: () => this.welcome(), title: () => this.title(), garage: () => this.garage(), modes: () => this.modes(), lobby: () => this.lobby(),
      pause: () => this.pause(), controls: () => this.ctl?.html() ?? '', settings: () => this.settings(), shop: () => this.shop(), profile: () => this.profile(), results: () => (this.lastResults ? this.results(this.lastResults) : ''),
      busy: () => '',   // the loading screen (loading.ts) covers it
    }[this.screen]();
    this.root.innerHTML = html;
    for (const sel of SCROLL_SELS) {
      const mem = this.scrollMem.get(sel);
      if (!mem) continue;
      const el = this.root.querySelector(sel);
      if (el) {
        if (mem.top > 0) el.scrollTop = mem.top;
        if (mem.left > 0) el.scrollLeft = mem.left;
      }
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
    const sel = this.sel;
    const dis = this.tuning ? 'disabled' : '';
    const invite = this.invite && !this.party ? `<div class="invite og-invite"><span>You're invited to ${this.inviteKind === 'garage' ? "a friend's Live Garage" : 'party'} <b>${esc(this.invite)}</b></span>
        <div class="og-invite-acts"><button class="primary small" data-act="invite" ${dis}>${this.inviteKind === 'garage' ? 'Join Live Garage' : 'Join Party'}</button><button class="small" data-act="noinvite" aria-label="Dismiss">✕</button></div></div>` : '';
    const last = this.sp.last ?? this.mp.last;
    const earned = last && (last.xp || last.cr) ? `<div class="earned og-earned">+${fmtXp(last.xp)}${last.cr ? ` · +${fmt(last.cr)}` : ''} <span class="dim">${esc(last.reason)}</span>${last.levelUp ? ` <b class="lvup">LEVEL ${last.levelUp}</b>` : ''}</div>` : '';
    if (this.identity.needsPick && !this.tuning) return this.pickName();

    const st = statsOf(applyMods(this.physics[sel.car], modsOf(sel)));
    const cls = st.power > 420 ? 'S' : st.power > 330 ? 'A' : st.power > 250 ? 'B' : 'C';
    const engCur = engineOf(this.nr, curCar.id);
    const engLbl = engCur.swap === 'stock' ? stockEngineOfCar(curCar.id).label : ENGINE_SWAPS[engCur.swap].label;
    const cs = this.hooks.cities?.();
    const curCity = cs?.list.find((c) => c.id === cs.current);
    const mp = this.mp.profile;
    const lic = mp?.license ?? 'R';
    const dr = Math.round(mp?.dr ?? 1500);
    const sr = (mp?.sr ?? 2.5).toFixed(2);
    const todayEv = todayCalendarEvent();
    const aiPct = Math.max(60, Math.min(110, Math.round(sel.aiDiff || 88)));
    const aiPreset = AI_DIFFICULTY_PRESETS.find((p) => p.id !== 'adaptive' && Math.abs(p.pct - aiPct) <= 2);
    const aiDiffLabel = sel.aiAdaptive ? `Adaptive (${aiPct}%)` : (aiPreset?.label ?? `AI ${aiPct}%`);
    const assistLabel = this.assists.preset ? this.assists.preset[0].toUpperCase() + this.assists.preset.slice(1) : 'Custom';
    const reqCount = this.identity.friends.incoming.length;

    const ico = (d: string, size = 20) =>
      `<svg class="og-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

    const IC = {
      speaker: ico('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.8 5.2a9.5 9.5 0 0 1 0 13.6"/>', 14),
      play: '<svg class="og-play-ico" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
      flag: ico('<path d="M4 21V4"/><path d="M4 4h14l-2.5 5L18 14H4"/><path d="M9 4v10"/><path d="M13.5 4v10"/><path d="M4 9h11.5"/>', 20),
      users: ico('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 20),
      trophy: ico('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>', 20),
      compass: ico('<circle cx="12" cy="12" r="9"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>', 20),
      route: ico('<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>', 18),
      car: ico('<path d="M5 17h14"/><path d="M3 13l2-5a2 2 0 0 1 1.85-1.25h10.3A2 2 0 0 1 19 8l2 5v4a1 1 0 0 1-1 1h-1.5a1.5 1.5 0 0 1-1.5-1.5V16H7v.5A1.5 1.5 0 0 1 5.5 18H4a1 1 0 0 1-1-1v-4Z"/><circle cx="7" cy="13" r="1"/><circle cx="17" cy="13" r="1"/>', 18),
      sliders: ico('<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2"/>', 18),
      wrench: ico('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/>', 18),
      tag: ico('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42Z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/>', 18),
      gear: ico('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 .99-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51.99H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>', 18),
      shield: ico('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>', 14),
      wheel: ico('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 14v7"/><path d="M3.5 9.5h17"/>', 14),
      timer: ico('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9 2h6"/>', 14),
      chat: ico('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>', 14),
      video: ico('<polygon points="5 3 19 12 5 21 5 3"/>', 14),
      heart: ico('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z"/>', 14),
      code: ico('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>', 14),
      lock: ico('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', 14),
      radio: ico('<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/>', 14),
    };

    const navRow = (act: string, icon: string, label: string, sub: string, dataV = '') =>
      `<button class="og-nav-row" data-act="${act}" ${dataV ? `data-v="${dataV}"` : ''} ${dis}>
        <span class="og-nav-ico">${icon}</span>
        <span class="og-nav-text">
          <b>${label}</b>
          <small>${sub}</small>
        </span>
      </button>`;

    const cfgItem = (act: string, icon: string, label: string, val: string) =>
      `<button class="og-cfg-item" data-act="${act}" ${dis}>
        <span class="og-cfg-head">${icon}<b>${label}</b></span>
        <span class="og-cfg-val">${val}</span>
      </button>`;

    return `${this.tuning ? '<div class="cover"><div class="card center"><div class="spin"></div><p>Tuning graphics for this device…</p><span class="dim">Measuring the street once to pick resolution and effects.</span></div></div>' : ''}
      <div class="og-home">
        <header class="og-topbar">
          <div class="og-brand-wrap">
            <div class="og-logo">OPEN <span>GRID</span></div>
            <span class="og-badge">400 HZ · WEBGPU · FREE</span>
          </div>
          <div class="og-status-bar">
            <button class="og-pill ${this.audioEngineMode === 'real_samples' ? 'is-on' : ''}" data-act="audio-engine-toggle" ${dis} title="Switch live between Real Recorded Supercars (CC-BY) and Engine-Sim + Muffler IR (WASM)">${IC.speaker}<span>${this.audioEngineMode === 'real_samples' ? 'Real Cars' : 'Sim + IR'}</span></button>
            <button class="og-pill og-rank-pill" data-act="lobby" ${dis} title="Open Free Community Multiplayer">CLASS ${esc(lic)} · ${dr} DR · ${sr} SR</button>
            ${this.heat > 0 ? `<div class="og-pill og-heat ${this.heat >= 5 ? 'maxed' : this.heat >= 4 ? 'hot' : ''}" title="Street Heat Level ${this.heat}/5">
              <span>HEAT</span>
              <span class="og-heat-bars">${Array.from({ length: this.heat }, () => '<i class="on"></i>').join('')}</span>
              ${this.layLowCost >= 0 ? `<button class="og-heat-clear" data-act="laylow" ${this.sp.xp < this.layLowCost ? 'disabled' : ''} title="Pay ${this.layLowCost} XP to clear street heat">Clear</button>` : ''}
            </div>` : ''}
            <button class="og-pill og-me" data-act="profile-open" ${dis}>
              <span class="og-avatar">${helmetSvg(skinOf(sel.skin), 20)}</span>
              <b>${esc(this.identity.name)}</b>
              <span class="og-me-sub ${mp?.email ? 'synced' : ''}">${reqCount ? `${reqCount} req` : mp?.email ? '✓' : this.cloud.available ? 'Upgrade' : 'Guest'}</span>
            </button>
          </div>
        </header>

        ${(invite || earned) ? `<div class="og-notices">${invite}${earned}</div>` : ''}

        <main class="og-stage">
          <section class="og-primary-col" aria-label="Primary Navigation">
            <button class="og-drive-btn" data-act="start-race" ${dis}>${IC.play}<span>DRIVE</span></button>
            <nav class="og-nav-list">
              ${navRow('play', IC.flag, 'RACE EVENTS', `${esc(curCity?.name ?? 'NYC Midtown')} · ${sel.laps} Laps · ${esc(aiDiffLabel)} · ${sel.copMode ? 'Cops ON' : 'Clean'}`)}
              ${navRow('lobby', IC.users, 'MULTIPLAYER', this.party ? `In Party ${esc(this.party.code)}` : 'Free Community Splits · Championships · Parties')}
              ${navRow('cal-go', IC.trophy, 'WEEKLY CHALLENGE', `${esc(todayEv.day)} · ${esc(todayEv.title)} · +${todayEv.bonusXp.toLocaleString('en-US')} XP`, String(todayEv.dayIdx))}
              ${navRow('start-free', IC.compass, 'FREE ROAM', `${cs?.list.length ?? 18} Cities & Circuits · Car Meets · Speed Traps · 1v1 Drags`)}
            </nav>
          </section>

          <section class="og-secondary-col" aria-label="Quick Configuration &amp; Links">
            <div class="og-config-grid">
              ${cfgItem('play', IC.route, 'CITY & TRACK', `${esc(curCity?.name ?? 'NYC Midtown')}${curCity?.district ? ` · ${esc(curCity.district)}` : ''}`)}
              ${cfgItem('garage-open', IC.car, 'CAR', `${esc(curCar.name)} · Class ${cls} (${Math.round(st.power)} kW)`)}
              ${cfgItem('settings-open', IC.sliders, 'AI & ASSISTS', `${esc(aiDiffLabel)} · ${esc(assistLabel)}`)}
              ${cfgItem('garage-open', IC.wrench, 'GARAGE', `Showroom · ${esc(engLbl)}`)}
              ${cfgItem('shop-open', IC.tag, 'AUCTION & MODS', `${fmt(this.career.credits)} · Live Market`)}
              ${cfgItem('settings-open', IC.gear, 'SETTINGS', 'Graphics · Audio · FFB Wheels')}
            </div>

            <div class="og-divider" role="separator"></div>

            <div class="og-link-grid">
              <button class="og-link-item" data-act="profile-open" ${dis}>${IC.shield}<span>Profile &amp; 2FA</span></button>
              <button class="og-link-item" data-act="controls-open" ${dis}>${IC.wheel}<span>Controls &amp; Wheel</span></button>
              <button class="og-link-item" data-act="lobby-tab-open" data-v="hotlaps" ${dis}>${IC.timer}<span>Hotlaps</span></button>

              <a class="og-link-item" href="https://discord.gg/RhKdTvAdf" target="_blank" rel="noopener noreferrer">${IC.chat}<span>Discord ↗</span></a>
              <a class="og-link-item" href="https://youtube.com/@open_grid_motorsport" target="_blank" rel="noopener noreferrer">${IC.video}<span>YouTube ↗</span></a>
              <a class="og-link-item" href="https://www.patreon.com/Open_Grid" target="_blank" rel="noopener noreferrer">${IC.heart}<span>Patreon ↗</span></a>

              <a class="og-link-item" href="https://github.com/Konstantinos-Chatzistavrou/Open-Grid" target="_blank" rel="noopener noreferrer">${IC.code}<span>GitHub ↗</span></a>
              <a class="og-link-item" href="/privacy.html" target="_blank" rel="noopener noreferrer">${IC.lock}<span>Privacy ↗</span></a>
              <button class="og-link-item ${this.spotterOn ? 'is-on' : ''}" data-act="spotter" data-v="${this.spotterOn ? '0' : '1'}" ${dis}>${IC.radio}<span>Spotter ${this.spotterOn ? 'ON' : 'OFF'}</span></button>
            </div>
          </section>
        </main>

        <footer class="og-foot">
          <span>${this.cars.length} Cars · ${cs?.list.length ?? 18} Real-Scale Cities · Apache-2.0 · Zero Ads${this.gfxNote ? ` · ${esc(this.gfxNote)}` : ''}</span>
        </footer>
      </div>`;
  }

  private aiDiffUi(): string {
    const sel = this.sel;
    const pct = Math.max(60, Math.min(110, Math.round(sel.aiDiff || 88)));
    const dp = difficultyProfile(pct);
    const nonAdaptive = AI_DIFFICULTY_PRESETS.filter((p) => p.id !== 'adaptive');
    const activeId = sel.aiAdaptive
      ? 'adaptive'
      : nonAdaptive.reduce((best, p) => (Math.abs(p.pct - pct) < Math.abs(best.pct - pct) ? p : best), nonAdaptive[0]).id;
    const chips = AI_DIFFICULTY_PRESETS.map(
      (p) => `<button class="chip ${activeId === p.id ? 'on' : ''}" data-act="ai-preset" data-v="${p.id}" title="${esc(p.desc)}">${esc(p.label)}</button>`,
    ).join('');
    const valLabel = sel.aiAdaptive ? `ADAPTIVE (START ${pct}%)` : `${pct}%`;
    const spec = `Grip ${Math.round(dp.gripUtil * 100)}% · Reaction ${Math.round(dp.reactionSec * 1000)} ms · Optimal Line ${Math.round(dp.apexAccuracy * 100)}%`;
    return `<div class="opts" style="flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span class="dim">AI DIFFICULTY</span>
        <div class="chips">${chips}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <input id="ai-diff-slider" type="range" min="60" max="110" step="2" value="${pct}" style="flex:1;min-width:140px;accent-color:#f59e0b" />
        <span class="pill ${sel.aiAdaptive ? 'gold' : ''}" id="ai-diff-val">${valLabel}</span>
      </div>
      <div class="dim small-note" id="ai-diff-desc">${spec}</div>
    </div>`;
  }

  private settings() {
    const a = this.assists, inSession = this.settingsFrom === 'pause';
    const chip = (act: string, v: string, label: string, on: boolean) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`;
    const row = (label: string, chips: string, note: string) => `<div class="srow2"><span class="dim">${label}</span><div class="chips">${chips}</div><small class="dim">${note}</small></div>`;
    const presets = (['beginner', 'intermediate', 'expert', 'custom'] as Preset[]).map((p) => chip('as-preset', p, p[0].toUpperCase() + p.slice(1), a.preset === p)).join('');
    const assists = `
      <div class="chips">${presets}<span class="pill gold">Skill Bonus: ${assistsOffCount(a)}/7 Aids Off</span></div><div class="dim note">${PRESET_INFO[a.preset]}</div>
      ${row('STEERING FILTER', chip('as-sa', 'off', 'Off (Raw)', a.steeringAssist === 'off') + chip('as-sa', 'sim', 'Sim (Peak Grip)', a.steeringAssist === 'sim') + chip('as-sa', 'assisted', 'Assisted (Forza Feel)', a.steeringAssist === 'assisted'), 'Physics-up front-axle slip ceiling for controllers & keyboards (never affects real steering wheels). Keeps tyres biting instead of washing out.')}
      ${row('BRAKING ASSIST', chip('as-ba', 'off', 'Off', a.brakingAssist === 'off') + chip('as-ba', 'low', 'Low (Safety Net)', a.brakingAssist === 'low') + chip('as-ba', 'high', 'High (Guided)', a.brakingAssist === 'high'), 'Optional beginner on-ramp driven by the Driving Line corner-speed physics. Peel this off first as you learn braking points.')}
      ${row('ABS', chip('as-abs', 'off', 'Off', a.abs === 'off') + chip('as-abs', 'weak', 'Weak', a.abs === 'weak') + chip('as-abs', 'default', 'Default', a.abs === 'default'), 'Stops the wheels locking under braking. Weak lets them slip further first.')}
      ${row('TRACTION', [0, 1, 2, 3, 4, 5].map((n) => chip('as-tc', String(n), n ? String(n) : 'Off', a.tc === n)).join(''), 'Cuts power when the rear wheels spin. 5 steps in earliest.')}
      ${row('STABILITY', chip('as-esc', '0', 'Off', !a.stability) + chip('as-esc', '1', 'On', a.stability), 'Brakes single wheels to stop a spin or a slide wide.')}
      ${row('COUNTERSTEER', chip('as-cs', 'off', 'Off', a.countersteer === 'off') + chip('as-cs', 'weak', 'Weak', a.countersteer === 'weak') + chip('as-cs', 'strong', 'Strong', a.countersteer === 'strong'), 'Steers into a slide for you when the rear steps out (keyboard and controller).')}
      ${row('GEARBOX', chip('as-gb', 'auto', 'Automatic', a.gearbox === 'auto') + chip('as-gb', 'manual', 'Manual', a.gearbox === 'manual'), 'Manual: Q / E, bumpers or paddles.')}
      ${row('AUTO-CLUTCH', chip('as-ac', 'perfect', 'On', a.autoClutch === 'perfect') + chip('as-ac', 'off', 'Off (my own clutch pedal)', a.autoClutch === 'off'), 'On: the car works the clutch for you. Off is only for a wheel with a clutch pedal: with a keyboard or touch the car cannot pull away. Dual-clutch and automatic cars always clutch themselves.')}
      ${row('DRIVING LINE', chip('as-line', 'off', 'Off', a.line === 'off') + chip('as-line', 'braking', 'Braking zones', a.line === 'braking') + chip('as-line', 'full', 'Full', a.line === 'full'), 'The racing line on the road: blue = keep going, yellow = ease off, red = brake.')}
      ${row('CAMERA', (['chase', 'far', 'cinematic', 'drift', 'free', 'hood', 'cockpit', 'bumper', 'orbit'] as const).map((k) => chip('cam-mode', k, k === 'free' ? 'Free Cam' : k[0].toUpperCase() + k.slice(1), this.camMode === k)).join(''), 'Drag mouse or touch on screen while driving to look around freely (double-tap / right-click to recenter, scroll wheel to zoom). Free Cam keeps your custom angle locked without auto-recenter. C cycles views.')}
      ${row('REAR MIRROR', chip('mirror', '0', 'Off', !this.mirror) + chip('mirror', '1', 'On', this.mirror), 'The view behind the car, top centre, in every camera. Off saves a few frames per second.')}
      <div class="dim note">Assists never change the car: same physics and tyres for everyone; they only help with your inputs. Keys 1 / 2 / 3 / 5 switch ABS / traction / stability / gearbox while driving.</div>`;
    const g = (k: Gfx, label: string) => chip('gfx', k, label, this.gfx === k);
    const more = inSession ? '<div class="dim note">Race rules and graphics can be changed from the main menu.</div>' : `
      <h3>Race rules</h3>
      <div class="chips">${chip('realism', '1', 'Full Realism', this.sel.realism)}${chip('realism', '0', 'Respawns', !this.sel.realism)}</div>
      <div class="dim note">${this.sel.realism ? RULES.realism : RULES.respawn}</div>
      ${this.aiDiffUi()}
      <h3>Graphics</h3>
      <div class="chips">${g('auto', 'Auto')}${g('max', 'Max')}${g('ultra', 'Ultra')}${g('high', 'High')}${g('medium', 'Medium')}${g('low', 'Low')}${g('potato', 'Potato')}</div>
      <div class="dim note">${esc(this.gfxNote || 'Auto tunes resolution and effects for this device once.')}</div>`;
    return `<div class="lobby-screen"><div class="card lobby-card settings-card">
      <div class="lobby-head"><button data-act="settings-back" class="back-btn">← Back</button><div><div class="kicker">OPTIONS</div><h2>Settings</h2></div></div>
      <h3>🔊 Audio &amp; Engine Sound (A/B Test)</h3>
      ${row('ENGINE AUDIO ENGINE', chip('audio-engine', 'real_samples', '🎙 Real Recorded Cars (CC-BY)', this.audioEngineMode === 'real_samples') + chip('audio-engine', 'engine_sim', '⚙ Engine-Sim + Muffler IR (WASM)', this.audioEngineMode === 'engine_sim'), 'Switch live while driving or in Garage: compare Real Recorded Supercars (Z06, Mustang, Ferrari 458/F12/812, GT3, Huracán, GT-R, Supra, RX-7) vs Thermodynamic Engine-Sim + 192-tap Exhaust Muffler IR.')}
      ${row('DYNAMIC ADAPTIVE MUSIC', chip('music', '1', '🎵 Adaptive ON', this.musicOn) + chip('music', '0', 'OFF', !this.musicOn), 'Reacts to speed, shifts into chase tempo during police pursuits, and swells at the finish line.')}
      ${row('RACE SPOTTER / CREW CHIEF', chip('spotter', '1', '📻 Spotter ON', this.spotterOn) + chip('spotter', '0', 'OFF', !this.spotterOn), 'iRacing-style live proximity radio ("Car left", "Car right", "Three wide", "Clear") + FIA flag callouts (100% client-side).')}
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

  /** A career's level, XP bar and auction credits. */
  private careerCard(k: 'sp' | 'mp') {
    const c = k === 'sp' ? this.sp : this.mp, L = levelOf(c.xp);
    const pct = L.need ? Math.round((L.into / L.need) * 100) : 100;
    const extra = k === 'mp'
      ? (this.mp.ready ? `<span class="credits">${fmt(c.credits)}</span>` : `<span class="dim">${esc(this.mp.note || 'Offline')}</span>`)
      : (this.sp.testingMode ? `<span class="pill gold">🧪 FREE</span>` : `<span class="credits">${fmt(c.credits)}</span>`);
    return `<div class="ccard"><span class="dim">${k === 'sp' ? 'SINGLE PLAYER' : 'ONLINE'}</span><div class="ccard-top"><b>Lv ${L.level}</b>${extra}</div>
      <div class="xpbar"><i style="width:${pct}%"></i></div><small class="dim">${this.sp.testingMode && k === 'sp' ? 'All unlocked' : L.need ? `${fmtXp(L.into)} / ${fmtXp(L.need)}` : 'Max level'}</small></div>`;
  }
  /** The single player / online switch on the garage and auction house. */
  private careerBar() {
    const sp = levelOf(this.sp.xp).level, mp = levelOf(this.mp.xp).level;
    return `<div class="career-bar"><button class="chip ${this.sel.career === 'sp' ? 'on' : ''}" data-act="career" data-v="sp">Single player · Lv ${sp} · ${this.sp.testingMode ? 'FREE' : fmt(this.sp.credits)}</button>
      <button class="chip ${this.sel.career === 'mp' ? 'on' : ''}" data-act="career" data-v="mp">Online · Lv ${mp}${this.mp.ready ? ` · ${fmt(this.mp.credits)}` : ''}</button></div>`;
  }

  private currentLiveLots(): LiveAuctionLot[] {
    const slot = Math.floor(Date.now() / (15 * 60_000)) + this.lotWindowOffset;
    const nameOf = (id: string) => this.cars.find((c) => c.id === id)?.name ?? id;
    return generateLiveAuctionLots(this.market, this.cars.map((c) => c.id), nameOf, slot);
  }

  /** CS2-inspired Live Supply & Demand Auction House (replaces Shop completely). */
  private shop() {
    const w = this.career, sp = w.kind === 'sp';
    const testing = sp && this.sp.testingMode;
    const carIds = this.cars.map((c) => c.id);
    const loanerActive = w.isUsingLoaner(carIds);
    const lots = this.currentLiveLots();

    // 1. Live Rotating Lots (Salvage Finds, Pre-Swapped Builds, Limited 1/1 Collector Specs)
    const lotCards = lots.map((lot) => {
      const sold = this.market.boughtDynamicLots.includes(lot.id);
      const grade = gradeFromFloat(lot.floatVal);
      const br = brandOfCar(lot.carId);
      const tags = lot.tags.map((tg) => `<span class="tag-chip">${esc(tg)}</span>`).join('');
      const canAfford = testing || w.credits >= lot.priceCr;
      const badgeCls = lot.kind === 'limited' ? 'gold' : lot.kind === 'salvage' ? 'hot' : 'cy';
      return `<div class="scard auc-card ${sold ? 'owned' : ''}">
        <div class="car-head">
          <span class="brand-inline">${brandBadgeSvg(lot.carId, 22)}<b>${esc(lot.title)}</b></span>
          <i class="car-badge auc-b-${badgeCls}">${esc(lot.rarityLabel)}</i>
        </div>
        <div class="brand-meta">${esc(br.fullName)} · ${esc(lot.subtitle)}</div>
        <div class="auc-float-row">
          <span class="auc-float-pill" style="border-color:${grade.color};color:${grade.color}">FLOAT ${grade.floatVal.toFixed(3)} · ${grade.short} (${grade.label})</span>
          <span class="dim">${lot.mileageKm.toLocaleString()} km · Eng ${lot.startHealth}% · Dmg ${Math.round(lot.startDamage * 100)}%</span>
        </div>
        <div class="auc-tags">${tags}</div>
        <div class="auc-price-row">
          <div>
            <b class="auc-price">${testing ? 'FREE' : fmt(lot.priceCr)}</b>
            <small class="dim">vs Live Market ${fmt(lot.marketRefCr)} <em class="up">(-${lot.discountPct}%)</em></small>
          </div>
          <button class="small ${sold ? '' : 'primary'}" data-act="buy-live-lot" data-v="${esc(lot.id)}" ${sold || (!canAfford && !sold) ? 'disabled' : ''}>
            ${sold ? '✓ Won Lot' : canAfford ? '🔨 Instant Buy' : `Need ${fmt(lot.priceCr - w.credits)}`}
          </button>
        </div>
      </div>`;
    }).join('');

    // 2. Open Market (All Car Models · Uncapped Supply & Demand + Live SVG Price History Chart)
    const marketCards = this.cars.map((c) => {
      const st = statsOf(this.physics[c.id]);
      const ownedReal = w.ownsSellable(c.id);
      const br = brandOfCar(c.id);
      const entry = marketEntryOf(this.market, c.id);
      const trend = trendPctOf(entry);
      const up = trend >= 0;
      const hi = Math.max(...entry.history);
      const lo = Math.min(...entry.history);
      const canAfford = testing || w.credits >= entry.price;
      const demandTag = entry.buys24h > entry.sells24h + 6 ? '🔥 HIGH DEMAND' : entry.sells24h > entry.buys24h + 6 ? '📉 OVERSUPPLIED' : '⚖ BALANCED';
      const actionBtn = ownedReal
        ? `<button class="small" data-act="shop-drive" data-v="${c.id}">${c.id === this.sel.car ? '✓ Driving' : 'Drive'}</button>`
        : `<button class="small primary" data-act="buy-market-car" data-v="${c.id}" ${canAfford ? '' : 'disabled'}>${canAfford ? `Buy · ${testing ? 'FREE' : fmt(entry.price)}` : `Need ${fmt(entry.price - w.credits)}`}</button>`;
      return `<div class="scard auc-card ${ownedReal ? 'owned' : ''}">
        <div class="car-head">
          <span class="brand-inline">${brandBadgeSvg(c.id, 22)}<b>${esc(c.name)}</b></span>
          <span class="mkt-trend ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}%</span>
        </div>
        <div class="brand-meta">${esc(br.fullName)} · ${esc(stockEngineOfCar(c.id).label)} · ${demandTag}</div>
        <div class="mkt-chart-row">
          ${renderPriceSparklineSvg(entry.history, 148, 38)}
          <div class="mkt-stats">
            <b class="auc-price">${fmt(entry.price)}</b>
            <small class="dim">24h L ${fmt(lo)} · H ${fmt(hi)}</small>
            <small class="dim">Vol: ${entry.buys24h} buys / ${entry.sells24h} sells</small>
          </div>
        </div>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
        ${actionBtn}
      </div>`;
    }).join('');

    // 3. Sell & Appraise (Sell EVERYTHING · Float + 35% Mod/Swap Overpay · Dealer Spread · 15% Market Fee · Free Loaner Fallback)
    const sellableCars = this.cars.filter((c) => w.ownsSellable(c.id));
    const sellCards = sellableCars.map((c) => {
      const cond = conditionOf(this.maint, c.id);
      const eng = engineOf(this.nr, c.id);
      const mods = this.sel.mods[c.id] ?? { engine: 0, tyres: 0, weight: 0, aero: 0 };
      const ap = appraiseCarForSale(this.market, c.id, cond, eng, mods);
      const entry = marketEntryOf(this.market, c.id);
      const br = brandOfCar(c.id);
      const up = ap.trendPct >= 0;
      const engName = eng.swap === 'stock' ? stockEngineOfCar(c.id).label : `${ENGINE_SWAPS[eng.swap].label} (Swapped)`;
      return `<div class="scard auc-card sell-card">
        <div class="car-head">
          <span class="brand-inline">${brandBadgeSvg(c.id, 22)}<b>${esc(c.name)}</b></span>
          <span class="mkt-trend ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(ap.trendPct).toFixed(1)}%</span>
        </div>
        <div class="brand-meta">${esc(br.fullName)} · ${esc(engName)} · ${Math.round(eng.mileageKm).toLocaleString()} km</div>
        <div class="mkt-chart-row">
          ${renderPriceSparklineSvg(entry.history, 134, 34)}
          <div class="mkt-stats">
            <span class="auc-float-pill" style="border-color:${ap.floatGrade.color};color:${ap.floatGrade.color}">FLOAT ${ap.floatGrade.floatVal.toFixed(3)} · ${ap.floatGrade.label}</span>
            <small class="dim">Condition multiplier: ${Math.round(ap.floatGrade.priceMul * 100)}%</small>
          </div>
        </div>
        <div class="appraise-box">
          <div class="arow"><span>Live Market Price</span><b>${fmt(ap.liveMarketPrice)}</b></div>
          <div class="arow"><span>Float Condition (${ap.floatGrade.short})</span><b>${fmt(ap.conditionAdjusted)}</b></div>
          <div class="arow"><span>Mods &amp; Engine Swap (+${Math.round(MOD_OVERPAY_RATE * 100)}%)</span><b class="${ap.modOverpay > 0 ? 'up' : ''}">+${fmt(ap.modOverpay)}</b></div>
          <div class="arow"><span>Dealer Spread (${Math.round(DEALER_SPREAD * 100)}% bid)</span><b>${fmt(ap.dealerBid)}</b></div>
          <div class="arow"><span>Auction Market Fee (-${Math.round(AUCTION_MARKET_FEE * 100)}%)</span><b class="down">-${fmt(ap.marketFee)}</b></div>
          <div class="arow total"><span>INSTANT PAYOUT</span><b class="up">+${fmt(ap.netPayout)}</b></div>
        </div>
        <div class="auc-price-row">
          <small class="dim">${ap.cooldownSec > 0 ? `⏱ Anti-spoof dampening (${ap.cooldownSec}s)` : 'Selling adds supply & moves live price'}</small>
          <button class="small primary" data-act="sell-car" data-v="${c.id}">💰 Instant Sell · +${fmt(ap.netPayout)}</button>
        </div>
      </div>`;
    }).join('');

    const modCards = MOD_CATALOG.map((m) => {
      const sub = this.modHub.subscribed.includes(m.id);
      return `<div class="scard ${sub ? 'owned' : ''}">
        <div class="car-head"><b>${esc(m.title)}</b><i class="car-badge">${m.kind.toUpperCase()} · v${esc(m.version)}</i></div>
        <div class="dim small-note">by ${esc(m.author)} · ${m.downloads} subs · ${m.polyCount ? `${(m.polyCount / 1000).toFixed(1)}k tris` : '2D Pack'} · ${m.hasLods ? 'LOD ✓' : ''} · ${m.validated ? 'Anti-Cheat ✓' : ''} · ${esc(m.workshopId)}</div>
        <p class="dim small-note">${esc(m.blurb)}</p>
        <button class="small ${sub ? '' : 'primary'}" data-act="mod-sub" data-v="${m.id}">${sub ? '✓ Subscribed (Auto-Sync)' : '＋ Subscribe Mod'}</button>
      </div>`;
    }).join('');

    const tab = (id: typeof this.shopTab, label: string) => `<button class="gtab ${this.shopTab === id ? 'on' : ''}" data-act="stab" data-v="${id}">${label}</button>`;

    const loanerBanner = loanerActive
      ? `<div class="pnote"><b>🚗 FREE UNTRADEABLE STOCK LOANER ACTIVE:</b> You liquidated your entire garage! You can still race &amp; free-roam in the stock Valenza Vela GT loaner (untradeable) until you buy your next car from Live Lots or Open Market.</div>`
      : '';

    const content = this.shopTab === 'lots'
      ? `<div class="auc-bar"><p class="dim small-note">Rotating supply pools (Salvage Bargains, Pre-Swapped Builds &amp; Limited 1/1 Mint Drops). Repair wrecked salvage cars in Garage &amp; flip when demand spikes!</p><button class="small" data-act="refresh-lots">↻ Scout Next Floor Rotation</button></div><div class="shop-cars">${lotCards}</div>`
      : this.shopTab === 'market'
      ? `<p class="dim small-note">Uncapped CS2-style live supply &amp; demand: every buy drives prices up, every sell adds supply and pulls prices down. No forced MSRP resets. Upgrades &amp; Driver Gear are bought directly inside your Garage.</p><div class="shop-cars">${marketCards}</div>`
      : this.shopTab === 'sell'
      ? `${loanerBanner}<p class="dim small-note">Instant Market-Maker Sell: includes live supply/demand price, CS2 Wear Float grade, +${Math.round(MOD_OVERPAY_RATE * 100)}% overpay on installed upgrades &amp; engine swaps, dealer spread, and ${Math.round(AUCTION_MARKET_FEE * 100)}% Auction Market Fee. You can sell every car you own (free Stock Loaner fallback).</p>${sellCards ? `<div class="shop-cars">${sellCards}</div>` : ''}`
      : `<p class="dim small-note">In-Game Mod Hub (Steam Workshop &amp; OpenGrid validated packs — poly limit &lt;= 120k tris, LODs verified, zero unsafe scripts).</p><div class="shop-cars">${modCards}</div>`;

    const how = sp
      ? `Live Auction Market · ${this.market.totalFlipped} cars traded · ${fmt(this.market.totalVolumeCr)} lifetime volume · Upgrades & Driver Gear are now bought directly inside Garage.`
      : 'Online ranked credits & XP come from ranked party races (6+ players). Single Player mode runs the full live supply-and-demand Auction House locally.';

    return `<div class="lobby-screen"><div class="card lobby-card shop-card">
      <div class="lobby-head"><button data-act="home" class="back-btn">← Main Menu</button><div><div class="kicker">LIVE SUPPLY &amp; DEMAND · 15% MARKET FEE</div><h2>Auction</h2></div><div class="wallet-pill">${testing ? '∞ FREE' : (sp || this.mp.ready ? fmt(w.credits) : '—')}</div></div>
      ${this.careerBar()}
      <div class="gtabs">${tab('lots', '🔨 Live Lots')}${tab('market', '📈 Open Market')}${tab('sell', `💰 Sell & Appraise (${sellableCars.length})`)}${tab('mods', `🧩 Mod Hub (${this.modHub.subscribed.length})`)}</div>
      ${this.shopNote ? `<div class="pnote ${this.shopNote.startsWith('✓') ? '' : 'bad'}">${esc(this.shopNote)}</div>` : ''}
      ${content}
      <div class="dim note">${how}</div>
      <div class="lobby-foot"><button data-act="garage-open">⚙ Garage</button><button class="primary" data-act="play">Play ▶</button></div>
    </div></div>`;
  }

  private garage() {
    const camNow = GARAGE_CAMS[this.garageCamIdx % GARAGE_CAMS.length];
    if (this.visitingGarage) {
      const vg = this.visitingGarage;
      const vCar = this.cars.find((c) => c.id === vg.car);
      const vBr = brandOfCar(vg.car);
      const vSwap = ENGINE_SWAPS[vg.swap as SwapId]?.label ?? stockEngineOfCar(vg.car).label;
      const vTurbo = TURBOS[vg.turbo as TurboId]?.label ?? 'Stock';
      const watchers = Math.max(1, (this.party?.members.length ?? 2) - 1);
      const feedHtml = this.garageFeed.slice(-4).reverse().map((line) => `<div class="dim small-note">${esc(line)}</div>`).join('');
      return `<div class="nfs-garage ${this.garageHideUi ? 'ui-hidden' : ''}" data-pillar="rides">
        <header class="g-topbar">
          <div class="g-top-left">
            <button data-act="g-visit-leave" class="back-btn">← Leave Garage</button>
            <div class="g-id">
              ${brandBadgeSvg(vg.car, 30)}
              <div>
                <div class="g-id-sub">🔧 LIVE CO-OP GARAGE · ${esc(vg.hostName.toUpperCase())} · ${watchers} WATCHING</div>
                <div class="g-id-name">${esc(vCar?.name ?? vg.car)} <i>${esc(vBr.name)} · ${esc(vSwap)} · ${esc(vTurbo)}</i></div>
              </div>
            </div>
          </div>
          <div class="g-top-actions">
            <button class="chip g-eye-btn" data-act="g-hide-ui" title="Hide UI &amp; inspect full-screen">👁<span class="lbl"> View</span></button>
            <button class="chip" data-act="g-cam-cycle" title="Cycle showroom camera angle">📷<span class="lbl"> ${camNow.label}</span></button>
            <button class="chip ${this.garageWalkActive ? 'on' : ''}" data-act="g-walk" title="Walk around your friend's car (WASD)">🚶<span class="lbl"> Walk</span></button>
            <button class="chip ${this.voiceOn ? 'on' : ''}" data-act="voice-toggle" title="Toggle WebRTC Voice Chat ([Z] PTT / Open Mic)">🎙<span class="lbl"> ${this.voiceOn ? 'Live' : 'Voice'}</span></button>
          </div>
        </header>
        <section class="g-rides-dock panel" style="padding:10px 14px">
          <div class="g-rides-bar" style="flex-wrap:wrap;gap:8px">
            <div class="chips">
              <span class="pill gold">👀 WATCHING ${esc(vg.hostName.toUpperCase())} BUILD LIVE</span>
              <button class="chip" data-act="g-emote" data-v="🔥 Fire Build!">🔥 Fire!</button>
              <button class="chip" data-act="g-emote" data-v="🔊 Rev It!">🔊 Rev It!</button>
              <button class="chip" data-act="g-emote" data-v="👏 Super Clean!">👏 Clean!</button>
              <button class="chip" data-act="g-emote" data-v="💎 Mint Spec!">💎 Mint!</button>
            </div>
            <div class="dim small-note">${this.garageWalkActive ? 'WASD to walk around the car · Mouse drag to look' : 'Drag to orbit · Scroll to zoom · Live updates as host modifies parts'}</div>
          </div>
          ${feedHtml ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">${feedHtml}</div>` : ''}
        </section>
        <button class="chip primary g-show-ui-fab" data-act="g-hide-ui" aria-label="Show Garage UI">👁 Show UI</button>
      </div>`;
    }
    const sel = this.sel;
    const w = this.career;
    const ownedList = this.cars.filter((c) => w.owns(c.id));
    const classOfCar = (id: string) => { const p = statsOf(this.physics[id]).power; return p > 420 ? 'S' : p > 330 ? 'A' : 'B'; };
    const filtered = ownedList
      .filter((c) => this.carFilter === 'all' ? true : this.carFilter === 'fav' ? this.favCars.includes(c.id) : classOfCar(c.id) === this.carFilter)
      .sort((a, b) => {
        if (this.carSort === 'power') return statsOf(this.physics[b.id]).power - statsOf(this.physics[a.id]).power;
        if (this.carSort === 'weight') return statsOf(this.physics[a.id]).mass - statsOf(this.physics[b.id]).mass;
        return a.name.localeCompare(b.name);
      });
    const carIds = this.cars.map((c) => c.id);
    const loanerActive = w.isUsingLoaner(carIds);
    const cards = filtered.map((c) => {
      const st = statsOf(this.physics[c.id]);
      const fav = this.favCars.includes(c.id);
      const br = brandOfCar(c.id);
      const isLoanerCard = loanerActive && c.id === STARTER_CAR;
      return `<button class="car ${c.id === sel.car ? 'on' : ''}" data-act="car" data-v="${c.id}">
        <div class="car-head"><span class="brand-inline">${brandBadgeSvg(c.id, 20)}<b>${esc(c.name)}</b></span><span data-act="fav-car" data-v="${c.id}" title="Favorite">${fav ? '★' : '☆'}</span><i class="car-badge">${isLoanerCard ? 'LOANER' : c.id === sel.car ? 'ACTIVE' : 'DRIVE'}</i></div>
        <div class="brand-meta">${esc(br.name)} · ${esc(stockEngineOfCar(c.id).label)}</div>
        <div class="mini"><em>${Math.round(st.power)} kW</em><em>${Math.round(st.mass)} kg</em><em>${st.grip.toFixed(2)} µ</em></div>
      </button>`;
    }).join('') || '<div class="dim small-note">No cars match this filter.</div>';

    const mods = modsOf(sel);
    const now = statsOf(applyMods(this.physics[sel.car], mods));
    const cls = now.power > 420 ? 'S' : now.power > 330 ? 'A' : now.power > 250 ? 'B' : 'C';
    const br = brandOfCar(sel.car);
    const engCur = engineOf(this.nr, sel.car);
    const engLbl = engCur.swap === 'stock' ? stockEngineOfCar(sel.car).label : ENGINE_SWAPS[engCur.swap].label;

    const pillar = this.garagePillar;
    const pillars: { id: GaragePillar; n: string; label: string }[] = [
      { id: 'rides',  n: '01', label: `My Rides (${ownedList.length})` },
      { id: 'style',  n: '02', label: 'Style & Body' },
      { id: 'perf',   n: '03', label: 'Performance' },
      { id: 'driver', n: '04', label: 'Driver' },
    ];
    const pillarBar = pillars.map((p) =>
      `<button class="gpillar ${pillar === p.id ? 'on' : ''}" data-act="gpillar" data-v="${p.id}"><i>${p.n}</i><b>${p.label}</b></button>`,
    ).join('');

    const subTabs = GTABS.filter((t) => t.pillar === pillar);
    if (pillar !== 'rides' && !subTabs.some((t) => t.id === this.garageTab) && subTabs[0]) {
      this.garageTab = subTabs[0].id;
    }
    const activeTabObj = GTABS.find((t) => t.id === this.garageTab) ?? subTabs[0];
    const rail = subTabs.length > 1
      ? `<nav class="g-rail">${subTabs.map((t, i) => `<button class="rail ${this.garageTab === t.id ? 'on' : ''}" data-act="gtab" data-v="${t.id}"><i>${String(i + 1).padStart(2, '0')}</i><b>${t.label}</b></button>`).join('')}</nav>`
      : '';

    const tabRenderers: Record<string, () => string> = {
      paint:   () => this.gPaint(),
      wraps:   () => this.gWraps(),
      front:   () => this.gFront(),
      rear:    () => this.gRear(),
      wing:    () => this.gWing(),
      hood:    () => this.gHood(),
      bodykit: () => this.gBodykit(),
      wheels:  () => this.gWheels(),
      lights:  () => this.gLights(),
      exhaust: () => this.gExhaust(),
      swaps:   () => this.gSwaps(),
      boost:   () => this.gBoost(),
      perf:    () => this.gPerf(),
      stance:  () => this.gStance(),
      care:    () => this.gCare(),
      driver:  () => this.gDriver(),
    };
    const stagePanel = pillar === 'rides' ? '' : `
      <section class="g-stage panel">
        <div class="g-tabtitle">${esc((activeTabObj?.label ?? this.garageTab).toUpperCase())}</div>
        <div class="g-stage-scroll">
          ${pillar === 'style' ? this.lookNow() : ''}
          ${tabRenderers[this.garageTab]?.() ?? ''}
        </div>
      </section>`;

    const ridesDock = pillar !== 'rides' ? '' : `
      <section class="g-rides-dock panel">
        <div class="g-rides-bar">
          <div class="chips">
            <button class="chip ${this.sp.testingMode ? 'on' : ''}" data-act="toggle-testing" title="Unlock all cars, upgrades &amp; engine swaps for free">${this.sp.testingMode ? '🧪 Testing Mode ON (All Free)' : '🧪 Unlock All (Testing)'}</button>
            ${(['all', 'fav', 'S', 'A', 'B'] as const).map((f) => `<button class="chip ${this.carFilter === f ? 'on' : ''}" data-act="gfilter" data-v="${f}">${f === 'fav' ? '★' : f.toUpperCase()}</button>`).join('')}
            ${(['name', 'power', 'weight'] as const).map((s) => `<button class="chip ${this.carSort === s ? 'on' : ''}" data-act="gsort" data-v="${s}">⇅ ${s}</button>`).join('')}
          </div>
          <div class="chips">
            ${loanerActive ? '<span class="pill">🚗 Free Untradeable Loaner</span>' : '<button class="small" data-act="auction-sell-open">💰 Sell / Appraise</button>'}
            <button class="small primary" data-act="shop-open">🔨 Auction House</button>
          </div>
        </div>
        <div class="g-rides-strip">${cards}</div>
      </section>`;

    const cond = conditionOf(this.maint, sel.car);
    const rep = repairCostOf(cond, this.maint.insured);
    const dmgPill = rep.pct > 0 ? `<button class="chip on" data-act="repair-car">🔧 Repair (${this.sp.testingMode ? 'FREE' : `${rep.xp} XP`})</button>` : '';
    const friendsWatching = this.party ? Math.max(0, this.party.members.length - 1) : 0;
    const coopBtn = this.party
      ? `<button class="chip on" data-act="g-invite" title="Copy Live Garage invite link (${esc(this.party.code)}) so friends can watch you mod this car">👥 ${esc(this.party.code)}${friendsWatching ? ` · ${friendsWatching}` : ''}</button><button class="chip ${this.voiceOn ? 'on' : ''}" data-act="voice-toggle" title="Garage Voice Chat ([Z] PTT / Open Mic)">🎙</button>`
      : `<button class="chip" data-act="g-invite" title="Invite friends into your 3D garage to watch you customize &amp; rev your car live">👥<span class="lbl"> Invite</span></button>`;

    return `<div class="nfs-garage ${this.garageHideUi ? 'ui-hidden' : ''}" data-pillar="${pillar}">
      <header class="g-topbar">
        <div class="g-top-left">
          <button data-act="home" class="back-btn">← Menu</button>
          <div class="g-id">
            ${brandBadgeSvg(sel.car, 30)}
            <div>
              <div class="g-id-sub">${esc(br.fullName)} · ${esc(engLbl)}</div>
              <div class="g-id-name">${esc(this.car().name)} <i>CLASS ${cls}</i></div>
            </div>
          </div>
        </div>
        <nav class="g-pillars">${pillarBar}</nav>
        <div class="g-top-actions">
          ${dmgPill}
          ${coopBtn}
          <button class="chip g-eye-btn" data-act="g-hide-ui" title="Hide UI &amp; inspect car full-screen">👁<span class="lbl"> View</span></button>
          <button id="g-ign-btn" class="chip ${this.garageEngineOn ? 'on' : ''}" data-act="g-ignition" title="Toggle engine ignition ON / OFF">🔑<span class="lbl"> ${this.garageEngineOn ? 'Stop' : 'Start'}</span></button>
          <button class="chip" data-act="g-dyno" title="Put the car on the dyno: run it, hear it, measure power and top speed">📈<span class="lbl"> Dyno</span></button>
          <button class="chip g-rev-btn" data-hold="g-rev" title="Hold to rev engine &amp; shoot exhaust flames" oncontextmenu="return false">🔥<span class="lbl"> Rev</span></button>
          <button class="chip on" data-act="audio-engine-toggle" title="A/B compare Real Recorded Cars (CC-BY) vs Engine-Sim + Muffler IR (WASM)">🔊 ${this.audioEngineMode === 'real_samples' ? 'Real' : 'Sim+IR'}</button>
          <button class="chip" data-act="g-cam-cycle" title="Cycle showroom camera angle">📷<span class="lbl"> ${camNow.label}</span></button>
          ${this.nr.walkableGarage ? `<button class="chip ${this.garageWalkActive ? 'on' : ''}" data-act="g-walk" title="Walk around your car">🚶</button>` : ''}
          <button class="primary g-drive-btn" data-act="play">DRIVE ▶</button>
        </div>
      </header>
      ${rail}
      ${stagePanel}
      ${ridesDock}
      <section class="g-live-compact" id="g-live">${this.liveStats()}</section>
      <button class="chip primary g-show-ui-fab" data-act="g-hide-ui" aria-label="Show Garage UI">👁 Show UI</button>
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
      row('0-100', accel.toFixed(1) + ' s', 'launch', (6.5 - accel) / 5, dl(accel, paccel, 's', 1, true)),
      row('TOP SPEED', Math.round(vmax) + ' km/h', 'vmax', vmax / 360, dl(vmax, pvmax, 'km/h')),
      row('WEIGHT', Math.round(mass) + ' kg', 'curb', (1700 - mass) / 600, dl(mass, pmass, 'kg', 0, true)),
      row('AERO', df.toFixed(2) + ' m²', 'downforce', df / 0.95, dl(df, pdf, 'm²', 2)),
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
    const sel = this.sel, paint = paintOf(sel, this.cars).toLowerCase();
    const sw = SWATCHES.map((x) => `<button class="sw ${x === paint ? 'on' : ''}" style="background:${x}" data-act="paint" data-v="${x}" aria-label="${x}"></button>`).join('');
    const fin = (Object.keys(FINISHES) as Finish[]).map((f) => `<button class="chip ${sel.finish === f ? 'on' : ''}" data-act="finish" data-v="${f}">${FINISHES[f].label}</button>`).join('');
    const looks = LOOK_PRESETS.map((p) => `<button class="chip" data-act="look" data-v="${p.id}" title="${esc(p.blurb)}">${esc(p.label)}</button>`).join('');
    return `<h3>Body Colour</h3>
      <div class="sws">${sw}<label class="sw custom" title="Custom colour"><input id="custom" type="color" value="${paint}" /></label></div>
      <h3>Paint Finish</h3><div class="chips">${fin}</div>
      <h3>Quick Style Presets</h3><div class="chips">${looks}</div>`;
  }
  private gWraps() {
    const c = customOf(this.sel);
    return `<h3>Livery Pattern</h3><div class="chips">${LIVERIES.map((l, i) => this.cu('livery', i, l, c.livery === i)).join('')}</div>
      ${c.livery ? `<h3>Accent Colour</h3>${this.swatches('liveryColor', c.liveryColor)}` : '<div class="dim small-note" style="margin-top:10px">Pick a livery pattern above to customize its colour.</div>'}`;
  }
  private gFront() {
    const c = customOf(this.sel);
    const bumpers = Object.keys(FRONT_BUMPERS).filter((id) => id === 'stock' || this.fits(id));
    return `<h3>Front Bumper</h3><div class="chips">${bumpers.map((id) => this.cu('frontB', id, FRONT_BUMPERS[id], c.frontB === id, bodyHint('front', id, FRONT_BUMPERS[id]))).join('')}</div>
      <h3>Front Splitter <small class="dim">front-end grip</small></h3><div class="chips">${Object.keys(SPLITTERS).map((k) => this.cu('splitter', k, SPLITTERS[k], c.splitter === k, kitHint('splitter', k))).join('')}</div>`;
  }
  private gRear() {
    const c = customOf(this.sel);
    const bumpers = Object.keys(REAR_BUMPERS).filter((id) => id === 'stock' || this.fits(id));
    return `<h3>Rear Bumper</h3><div class="chips">${bumpers.map((id) => this.cu('rearB', id, REAR_BUMPERS[id], c.rearB === id, bodyHint('rear', id, REAR_BUMPERS[id]))).join('')}</div>
      <h3>Rear Diffuser <small class="dim">high-speed stability</small></h3><div class="chips">${Object.keys(DIFFUSERS).map((k) => this.cu('diffuser', k, DIFFUSERS[k], c.diffuser === k, kitHint('diffuser', k))).join('')}</div>`;
  }
  private gWing() {
    const c = customOf(this.sel);
    return `<h3>Rear Wing <small class="dim">downforce vs top speed</small></h3><div class="chips">${(Object.keys(WINGS) as (keyof typeof WINGS)[]).map((k) => this.cu('wing', k, WINGS[k], c.wing === k, wingHint(k as string))).join('')}</div>
      <h3>Aero Carbon / Gloss Finish</h3><div class="chips">${(Object.keys(AERO_FINISHES) as (keyof typeof AERO_FINISHES)[]).map((k) => this.cu('aero', k, AERO_FINISHES[k], c.aero === k)).join('')}</div>`;
  }
  private gHood() {
    const c = customOf(this.sel);
    const hoods = Object.keys(HOODS).filter((id) => id === 'stock' || this.fits(id));
    return `<h3>Hood Style</h3><div class="chips">${hoods.map((id) => this.cu('hood', id, HOODS[id], c.hood === id, bodyHint('hood', id, HOODS[id]))).join('')}</div>`;
  }
  private gBodykit() {
    const c = customOf(this.sel);
    return `<h3>Fender Flares <small class="dim">widebody stance</small></h3><div class="chips">${Object.keys(FENDERS).map((id) => this.cu('fenders', id, FENDERS[id], c.fenders === id, bodyHint('fender', id, FENDERS[id]))).join('')}</div>
      <h3>Side Skirts</h3><div class="chips">${Object.keys(SKIRTS).map((k) => this.cu('skirt', k, SKIRTS[k], c.skirt === k, kitHint('skirt', k))).join('')}</div>`;
  }
  private gWheels() {
    const c = customOf(this.sel);
    return `<h3>Rim Design <small class="dim">lighter = quicker launch</small></h3><div class="chips">${(Object.keys(RIMS) as string[]).map((k) => this.cu('rims', k, RIMS[k], c.rims === k, rimHint(k))).join('')}</div>
      <h3>Rim Colour</h3>${this.swatches('rimColor', c.rimColor)}
      <h3>Rim Finish</h3><div class="chips">${(Object.keys(RIM_FINISHES) as (keyof typeof RIM_FINISHES)[]).map((k) => this.cu('rimFinish', k, RIM_FINISHES[k], c.rimFinish === k)).join('')}</div>
      <h3>Brake Calipers</h3>${this.swatches('caliper', c.caliper)}`;
  }
  private gLights() {
    const c = customOf(this.sel);
    return `<h3>Headlights</h3><div class="chips">${(Object.keys(HEAD_TINTS) as (keyof typeof HEAD_TINTS)[]).map((k) => this.cu('headlights', k, HEAD_TINTS[k], c.headlights === k)).join('')}</div>
      <h3>Tail Lights</h3><div class="chips">${this.cu('smokedTails', false, 'Clear Red', !c.smokedTails)}${this.cu('smokedTails', true, 'Smoked', c.smokedTails)}</div>
      <h3>Underglow Neon</h3>${this.swatches('underglow', c.underglow, GLOW_COLOURS)}`;
  }
  private gExhaust() {
    const c = customOf(this.sel);
    return `<h3>Exhaust Tips <small class="dim">hit 🔥 Rev above to test flames</small></h3><div class="chips">${this.cu('exhaust', 'chrome', 'Chrome', c.exhaust === 'chrome')}${this.cu('exhaust', 'black', 'Stealth Black', c.exhaust === 'black')}${this.cu('exhaust', 'titanium', 'Burnt Titanium', c.exhaust === 'titanium')}</div>
      <h3>Window Tint</h3><div class="chips">${['Light', 'Dark', 'Limo'].map((l, i) => this.cu('tint', i, l, c.tint === i)).join('')}</div>`;
  }
  private gDriver() {
    const w = this.career;
    const cards = SKINS.map((k) => {
      const owned = w.ownsSkin(k.id);
      const r = w.req('skin', k.id);
      if (owned) {
        return `<button class="skin ${this.sel.skin === k.id ? 'on' : ''}" data-act="skin" data-v="${k.id}">${helmetSvg(k, 42)}<span>${esc(k.name)}</span></button>`;
      }
      const canBuy = w.credits >= r.price && (w.kind === 'sp' || (this.mp.ready && levelOf(this.mp.xp).level >= r.mpLevel));
      return `<button class="skin locked" data-act="garage-buy-skin" data-v="${k.id}" title="Buy &amp; equip ${esc(k.name)} gear (${fmt(r.price)})" ${canBuy ? '' : 'disabled'}>${helmetSvg(k, 42)}<span>${esc(k.name)}</span><em class="skin-price">${fmt(r.price)}</em></button>`;
    }).join('');
    const gear = this.sel.avatarGear;
    const gearSwatches = (slot: keyof AvatarGear, cur: string) =>
      `<div class="sws">${PART_COLOURS.filter(Boolean).map((c) => `<button class="sw ${c === cur ? 'on' : ''}" style="background:${c}" data-act="gear" data-k="${slot}" data-v="${c}" aria-label="${c}"></button>`).join('')}</div>`;
    return `${this.garageNote ? `<div class="pnote ${this.garageNote.startsWith('✓') ? '' : 'bad'}">${esc(this.garageNote)}</div>` : ''}
      <h3>Driver Gear <small class="dim">Balance: ${fmt(w.credits)}</small></h3>
      <div class="chips" style="margin-bottom:10px"><button class="chip on" data-act="gear-match">🎨 Match Car Paint</button></div>
      <div class="skins">${cards}</div>
      <h3>Helmet Colour</h3>${gearSwatches('helmet', gear.helmet)}
      <h3>Visor Accent</h3>${gearSwatches('accent', gear.accent)}
      <h3>Racing Suit</h3>${gearSwatches('suit', gear.suit)}
      <h3>Gloves &amp; Shoes</h3>${gearSwatches('gloves', gear.gloves)}`;
  }
  /** does the car in the garage have this bumper / hood option? (main.ts: the customiser knows) */
  fits: (id: string) => boolean = () => true;

  private gStance() {
    const st = stanceOf(this.nr, this.sel.car);
    const pick = (k: string, vals: number[], cur: number, fmtV: (n: number) => string) =>
      `<div class="chips">${vals.map((v) => `<button class="chip ${Math.abs(cur - v) < 0.05 ? 'on' : ''}" data-act="nr-stance" data-k="${k}" data-v="${v}">${fmtV(v)}</button>`).join('')}</div>`;
    return `<h3>Front Camber</h3>${pick('camberFront', [-7, -5, -3.5, -1.8, 0], st.camberFront, (v) => `${v}°`)}
      <h3>Rear Camber</h3>${pick('camberRear', [-7, -5, -3.5, -1.5, 0], st.camberRear, (v) => `${v}°`)}
      <h3>Ride Height</h3>${pick('rideHeightMm', [-40, -25, -10, 0, 15], st.rideHeightMm, (v) => `${v > 0 ? '+' : ''}${v} mm`)}
      <h3>Spring Stiffness</h3>${pick('springMul', [0.75, 1.0, 1.25, 1.5], st.springMul, (v) => `${Math.round(v * 100)}%`)}`;
  }

  private gSwaps() {
    const eng = engineOf(this.nr, this.sel.car);
    const stockSpec = stockEngineOfCar(this.sel.car);
    const swapCards = (Object.keys(ENGINE_SWAPS) as SwapId[]).map((id) => {
      const sw = ENGINE_SWAPS[id];
      const active = eng.swap === id;
      const title = id === 'stock' ? `Factory · ${stockSpec.label}` : sw.label;
      const sub = id === 'stock' ? 'Original manufacturer powertrain & factory acoustic voice' : sw.arch;
      const massTxt = sw.massDeltaKg === 0 ? '±0 kg' : `${sw.massDeltaKg > 0 ? '+' : ''}${sw.massDeltaKg} kg`;
      const pwrTxt = sw.powerMul === 1 ? 'Base' : `+${Math.round((sw.powerMul - 1) * 100)}% pwr`;
      return `<button class="swap-card ${active ? 'on' : ''}" data-act="nr-swap" data-v="${id}" title="Click to install &amp; hear engine rev">
        <div class="swap-top"><b>${esc(title)}</b><i>${esc(sw.short)}</i></div>
        <span class="dim">${esc(sub)}</span>
        <div class="swap-meta"><em>${pwrTxt}</em><em>${massTxt}</em><em>${active ? '✓ INSTALLED' : '🔊 SWAP &amp; REV'}</em></div>
      </button>`;
    }).join('');
    return `<div class="dim small-note" style="margin-bottom:8px">Click any engine block to swap physics, redline, weight &amp; immediately rev its exhaust note!</div>
      <div class="swap-grid">${swapCards}</div>`;
  }

  private gBoost() {
    const eng = engineOf(this.nr, this.sel.car);
    const turboBtns = (Object.keys(TURBOS) as TurboId[]).map((id) =>
      `<button class="chip ${eng.turbo === id ? 'on' : ''}" data-act="nr-turbo" data-v="${id}">${TURBOS[id].label} (${Math.round((TURBOS[id].powerMul - 1) * 100)}%)</button>`).join('');
    const manBtns = (Object.keys(MANIFOLDS) as ManifoldId[]).map((id) =>
      `<button class="chip ${eng.manifold === id ? 'on' : ''}" data-act="nr-man" data-v="${id}">${MANIFOLDS[id].label}</button>`).join('');
    return `<h3>Turbocharger <small class="dim">boost &amp; BOV flutter</small></h3><div class="chips">${turboBtns}</div>
      <h3>Exhaust Manifold <small class="dim">backfire flames &amp; flow</small></h3><div class="chips">${manBtns}</div>`;
  }

  private gCare() {
    const eng = engineOf(this.nr, this.sel.car);
    const freeTest = this.sp.testingMode && this.sel.career === 'sp';
    const tagsHtml = eng.tags.length ? `<div style="margin:6px 0">${eng.tags.map((tg) => `<span class="tag-chip">${esc(tg)}</span>`).join('')}</div>` : '';
    return `<h3>Nitrous Oxide <small class="dim">${eng.nosLiters.toFixed(1)} / ${NOS_MAX_LITERS} L · press [X]</small></h3>
      <div class="chips"><button class="chip on" data-act="nr-nos" data-v="5">+5 L (${freeTest ? 'FREE' : `${5 * NOS_PRICE_PER_LITER_XP} XP`})</button><button class="chip" data-act="nr-nos" data-v="15">Fill Bottle${freeTest ? ' (FREE)' : ''}</button></div>
      <h3>Engine Maintenance</h3>
      <div class="dim small-note">Health: <b>${Math.round(eng.health)}%</b> · Oil: <b>${Math.round(eng.oilLife)}%</b> · Odometer: <b>${Math.round(eng.mileageKm).toLocaleString()} km</b></div>
      ${tagsHtml}
      <div class="chips" style="margin-top:8px">
        <button class="chip" data-act="nr-oil">🛢 Change Oil (${freeTest ? 'FREE' : '50 XP'})</button>
        <button class="chip" data-act="nr-rebuild">🔧 Overhaul (${freeTest ? 'FREE' : '350 XP'})</button>
      </div>`;
  }

  private gPerf() {
    const sel = this.sel, w = this.career, mods = modsOf(sel);
    const rows = MOD_KEYS.map((k) => {
      const m = MODS[k];
      const own = w.stage(sel.car, k);
      const pips = m.levels.map((l, i) => {
        if (i <= own) {
          return `<button class="pip ${i <= mods[k] && mods[k] > 0 ? 'on' : ''} ${i === mods[k] ? 'cur' : ''}" data-act="mod" data-k="${k}" data-v="${i}" title="${l}">${i === 0 ? 'STK' : 'S' + i}</button>`;
        }
        let price = 0;
        for (let s = own + 1; s <= i; s++) price += w.req('mod', k, s).price;
        const canBuy = w.credits >= price && (w.kind === 'sp' || (this.mp.ready && levelOf(this.mp.xp).level >= w.req('mod', k, i).mpLevel));
        return `<button class="pip locked ${canBuy ? 'buyable' : ''}" data-act="garage-buy-mod" data-k="${k}" data-v="${i}" title="Buy &amp; fit ${l} for ${fmt(price)} (or unlock at Lv ${w.req('mod', k, i).spLevel})" ${canBuy ? '' : 'disabled'}>S${i} · ${Math.round(price / 1000)}k</button>`;
      }).join('');
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
    return `${this.garageNote ? `<div class="pnote ${this.garageNote.startsWith('✓') ? '' : 'bad'}">${esc(this.garageNote)}</div>` : ''}
      <h3>Stage Upgrades <small class="dim">Balance: ${fmt(w.credits)} · +35% value returned on Auction sale</small></h3>${rows}
      <h3>Telemetry <small class="dim">(red marker = stock)</small></h3>${stats}`;
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
          <div class="mcard-top"><span class="micon">01</span><b>Race Event</b><span class="dim">${this.sanctionedMode ? '☀ Sanctioned Day Circuit · FIA Rules' : '🌙 Midnight Street Underground · Tactical Cops'}</span></div>
          <p class="dim">${this.sanctionedMode ? 'Daytime sanctioned championship racing: closed road, zero cops, zero civilian traffic, pure motorsport pace & FIA track rules.' : 'High-stakes midnight street races where hardcore physics and tactical police AI (roadblocks & pull-over pursuits) matter. Heat & outlaw payouts live here.'}</p>
          <div class="opts"><span class="dim">DISCIPLINE</span><button class="chip ${!this.sanctionedMode ? 'on' : ''}" data-act="sanctioned" data-v="0">🌙 Underground Night Street</button><button class="chip ${this.sanctionedMode ? 'on' : ''}" data-act="sanctioned" data-v="1">☀ Sanctioned Day Circuit</button></div>
          ${this.sanctionedMode ? '<div class="opts"><span class="pill gold">🏁 SANCTIONED · NO COPS · NO TRAFFIC</span><span class="dim small-note">Closed circuit discipline for pure sim &amp; hotlap mastery</span></div>' : `<div class="opts"><span class="dim">COPS</span>${cur?.mandatoryCops
            ? `<span class="pill gold">🚨 PATROLLED DISTRICT · ALWAYS ON</span><span class="dim small-note">${esc(cur.patrolNote)}</span>`
            : `<button class="chip ${sel.copMode ? 'on' : ''}" data-act="copmode" data-v="1">Cop Mode ON</button><button class="chip ${!sel.copMode ? 'on' : ''}" data-act="copmode" data-v="0">OFF</button><span class="dim small-note">${sel.copMode ? '+50%+ Rep/Cr · Bust = heavy fine / pink slip risk' : 'Clean track battle · standard payout'}</span>`}</div>`}
          <div class="opts"><span class="dim">INSURANCE</span><button class="chip ${this.maint.insured ? 'on' : ''}" data-act="insure" data-v="1">🛡 Insured ON</button><button class="chip ${!this.maint.insured ? 'on' : ''}" data-act="insure" data-v="0">OFF</button><span class="dim small-note">${this.maint.insured ? `${INSURANCE_PREMIUM_XP} XP / $${INSURANCE_PREMIUM_CR} premium · -50% off repairs &amp; tow if wrecked` : 'Full repair &amp; Tow Truck Fee if totaled'}</span></div>
          ${(() => { const r = repairCostOf(conditionOf(this.maint, sel.car), this.maint.insured); return r.pct > 0 ? `<div class="opts"><span class="pill gold">🔧 ${r.pct}% SAVED DAMAGE</span><button class="chip" data-act="repair-car">Repair (${r.xp} XP)</button></div>` : ''; })()}
          <div class="opts"><span class="dim">RULES</span><span class="pill ${sel.realism ? 'gold' : ''}">${sel.realism ? 'FULL REALISM' : 'RESPAWNS'}</span><span class="dim small-note">change on main menu</span></div>
          <div class="opts"><span class="dim">SPEC CLASS</span><button class="chip ${this.specClass ? 'on' : ''}" data-act="spec-class" data-v="1">🏆 Equal Spec Car</button><button class="chip ${!this.specClass ? 'on' : ''}" data-act="spec-class" data-v="0">Open Tune</button><span class="dim small-note">${this.specClass ? 'All upgrades locked to identical stock spec (pure driver skill)' : 'Bring your tuned Garage build'}</span></div>
          ${this.aiDiffUi()}
          <div class="opts"><span class="dim">LAPS</span>${laps}</div>
          <button class="primary huge" data-act="start-race">Start Race · ${sel.laps} Lap${sel.laps > 1 ? 's' : ''}</button>
        </div>
        <div class="mcard">
          <div class="mcard-top"><span class="micon">02</span><b>Free Roam</b><span class="dim">No Cops · AI Traffic · Social Sandbox</span></div>
          <p class="dim">Cruising, car meets, Speed Traps &amp; Drift Zones with Global Leaderboards, and spontaneous headlight-flash [F] 1v1 Cash or Pink Slip drags from traffic lights.</p>
          <div class="opts"><span class="pill">NO POLICE</span><span class="dim small-note">[F] Flash Wager · [V] Cash/Pink Slip · [B] Leaderboards</span></div>
          <div class="opts" style="margin-top:4px;gap:8px;flex-wrap:wrap">
            <button class="primary huge" data-act="start-free" style="flex:1;min-width:160px">Cruise Free Roam</button>
          </div>
          <div class="opts" style="margin-top:8px;padding-top:10px;border-top:1px solid #ffffff16;flex-direction:column;align-items:stretch;gap:6px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
              <span class="pill gold">🧪 TESTING PURPOSES</span>
              <span class="dim small-note">All ${this.cars.length} cars, Stage 3 mods, turbos &amp; engine swaps 100% FREE</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="primary" data-act="start-test-free" style="flex:1">🧪 Testing Free Roam (All Cars Free)</button>
              <button class="small" data-act="start-test-garage">🔧 Testing Garage</button>
              ${this.sp.testingMode ? '<button class="small" data-act="toggle-testing" title="Return to normal progression">Exit Testing</button>' : ''}
            </div>
          </div>
        </div>
        <div class="mcard">
          <div class="mcard-top"><span class="micon">03</span><b>Multiplayer</b><span class="dim">${FREE_ROAM_MAX_PLAYERS} Free Roam · ${RACE_MAX_PLAYERS} Race Events</span></div>
          <p class="dim">16-player chill Free Roam lobbies with spontaneous 1v1 drag wagers &amp; zone leaderboards, or instanced 8–12 player Race Events with optional Tactical Cop Mode.</p>
          <div class="opts">${inParty || '<span class="dim">Create or join a party</span>'}</div>
          <button class="primary huge" data-act="lobby">Party Lobby</button>
        </div>
        ${(() => {
          const ss = checkSplitScreen();
          const p2Id = this.splitP2Car && this.cars.some((c) => c.id === this.splitP2Car)
            ? this.splitP2Car
            : (this.cars.find((c) => c.id !== sel.car)?.id ?? this.cars[0]?.id ?? sel.car);
          this.splitP2Car = p2Id;
          const p2Chips = this.cars.map((c) => `<button class="chip ${c.id === p2Id ? 'on' : ''}" data-act="split-p2car" data-v="${c.id}">${esc(c.name)}</button>`).join('');
          return `<div class="mcard">
            <div class="mcard-top"><span class="micon">04</span><b>Split-Screen</b><span class="dim">2P Couch · Laptop + Smart TV</span></div>
            <p class="dim">${esc(ss.reason)}</p>
            <div class="opts">
              <span class="dim">PADS</span>
              <span class="pill ${ss.padsCount >= 2 ? 'gold' : ''}">🎮 ${ss.padsCount}/2 · ${esc(ss.modeLabel)}</span>
            </div>
            <div class="opts">
              <span class="dim">LAYOUT</span>
              <button class="chip ${this.splitLayout === 'horizontal' ? 'on' : ''}" data-act="split-layout" data-v="horizontal">📺 Top / Bottom (TV)</button>
              <button class="chip ${this.splitLayout === 'vertical' ? 'on' : ''}" data-act="split-layout" data-v="vertical">🖥 Left / Right</button>
            </div>
            <div class="opts" style="flex-direction:column;align-items:stretch;gap:6px">
              <span class="dim">PLAYER 2 CAR (P1 = ${esc(this.car().name)})</span>
              <div class="chips" style="max-height:92px;overflow-y:auto">${p2Chips}</div>
            </div>
            <div class="opts" style="margin-top:4px;gap:8px;flex-wrap:wrap">
              <button class="primary huge" data-act="start-split-race" style="flex:1;min-width:150px" ${ss.eligible ? '' : 'disabled'}>🏁 2P Race (${sel.laps}L)</button>
              <button class="huge" data-act="start-split-free" style="flex:1;min-width:150px" ${ss.eligible ? '' : 'disabled'}>🌆 2P Free Roam</button>
            </div>
          </div>`;
        })()}
      </div>
      <div class="career-strips">
        <div class="cstrip">
          <div class="kicker">📈 GT7-STYLE WEEKLY CALENDAR · TODAY: ${esc(todayCalendarEvent().day)}</div>
          <div class="chips">${WEEKLY_CALENDAR.map((ev) => `<button class="chip ${ev.dayIdx === todayCalendarEvent().dayIdx ? 'on' : ''}" data-act="cal-go" data-v="${ev.dayIdx}" title="${esc(ev.kind)} (+${ev.bonusXp} XP)"><b>${ev.day}</b> ${esc(ev.title)}</button>`).join('')}</div>
        </div>
        <div class="cstrip">
          <div class="kicker">🎓 DRIVING ACADEMY (${this.completedLessons.length}/${ACADEMY_LESSONS.length} COMPLETED)</div>
          <div class="chips">${ACADEMY_LESSONS.map((l) => `<button class="chip ${this.completedLessons.includes(l.id) ? 'on' : ''}" data-act="ac-go" data-v="${l.id}" title="${esc(l.goal)}">${this.completedLessons.includes(l.id) ? '✓' : `0${l.num}`} ${esc(l.title)} (+${l.xpReward} XP)</button>`).join('')}</div>
        </div>
      </div>
    </div>`;
  }

  private lobby() {
    const p = this.party, sel = this.sel;
    const note = this.partyNote ? `<div class="pnote ${/^(✓|Copied)/.test(this.partyNote) ? '' : 'bad'}">${esc(this.partyNote)}</div>` : '';
    const nameRow = `<div class="field"><span class="dim">YOU RACE AS</span><b class="uname">${esc(sel.name)}</b><button class="small" data-act="profile-open">Change · Friends</button></div>`;
    if (!p) {
      const mp = this.mp.profile;
      const lic = mp?.license ?? 'R';
      const dr = Math.round(mp?.dr ?? 1500);
      const drGrade = mp?.drGrade ?? 'C';
      const sr = (mp?.sr ?? 2.5).toFixed(2);
      const jokers = mp?.jokersLeft ?? 2;
      const netStatus = this.cloud.available ? '✓ 100% Free Community Servers · Zero Ads' : 'Offline / Local';
      const sponsorBar = `<div class="opts" style="margin-bottom:10px;padding:8px 10px;border:1px solid #ffffff1c;border-radius:10px;background:#ffffff08;flex-wrap:wrap;gap:8px">
          <span class="dim small-note">♥ <b>Free Open-Source Hobby Project:</b> Every server, split, championship, hotlap &amp; P2P lobby is 100% free (best-effort community servers, zero ads, no trials). Penalties &amp; replay checks are automated.</span>
          <a class="chip" style="text-decoration:none;color:#eef2ff" href="https://www.patreon.com/Open_Grid" target="_blank" rel="noopener noreferrer">♥ Patreon</a>
        </div>`;
      const seriesCards = (this.officialEvents.length ? this.officialEvents : [
        { id: 'rookie_sprint', title: 'OpenGrid Rookie GT Sprint', subtitle: 'Fixed Setup · 20m cadence · Class R+', minLicense: 'R', intervalMin: 20, maxPerSplit: 12, laps: 3, startsInSec: 600, registrants: 0, eligible: true, eventKey: '', myEntry: null },
        { id: 'gt3_championship', title: 'OpenGrid GT3 World Championship', subtitle: 'BoP Equalized · 45m cadence · SOF Splits · Class D+', minLicense: 'D', intervalMin: 45, maxPerSplit: 16, laps: 5, startsInSec: 1800, registrants: 0, eligible: false, eventKey: '', myEntry: null },
        { id: 'hypercar_pro', title: 'OpenGrid Hypercar Pro Series', subtitle: 'Open Setup · Full Damage · Class C+', minLicense: 'C', intervalMin: 60, maxPerSplit: 16, laps: 6, startsInSec: 2400, registrants: 0, eligible: false, eventKey: '', myEntry: null },
        { id: 'endurance_special', title: 'OpenGrid Multiclass Endurance', subtitle: '2x Championship Pts · Team Driver Swaps · Class B+', minLicense: 'B', intervalMin: 120, maxPerSplit: 20, laps: 10, startsInSec: 3600, registrants: 0, eligible: false, eventKey: '', myEntry: null },
      ] as OfficialSeriesEvent[]).map((ev) => {
        const reg = ev.myEntry?.status === 'registered' || ev.myEntry?.status === 'seeded';
        const mins = Math.max(1, Math.ceil((ev.startsInSec || 60) / 60));
        return `<div class="scard ${reg ? 'owned' : ''}">
          <div class="car-head"><b>${esc(ev.title)}</b><i class="car-badge">CLASS ${esc(ev.minLicense)}+ · ${ev.laps} LAPS</i></div>
          <div class="dim small-note">${esc(ev.subtitle)}</div>
          <div class="mini"><em>Next split: ${mins}m</em><em>${ev.registrants} registered</em><em>Max ${ev.maxPerSplit}/split</em></div>
          <div class="chips" style="margin-top:8px">
            ${reg && ev.eventKey
              ? `<button class="small primary" data-act="official-join" data-v="${esc(ev.eventKey)}">▶ Enter SOF Split</button>`
              : `<button class="small primary" data-act="official-reg" data-v="${esc(ev.id)}" ${!this.cloud.available || !ev.eligible ? 'disabled' : ''}>${ev.eligible ? '🏁 Register for Split' : `🔒 Needs Class ${esc(ev.minLicense)}`}</button>`}
          </div>
        </div>`;
      }).join('');
      return `<div class="lobby-screen"><div class="card lobby-card">
        <div class="lobby-head"><div class="chips"><button data-act="home" class="back-btn">← Main Menu</button><button data-act="modes" class="back-btn">Modes</button></div><div><div class="kicker">OPEN GRID COMMUNITY NETWORK · 100% FREE &amp; AD-FREE</div><h2>Multiplayer</h2></div></div>
        ${nameRow}
        <div class="opts" style="margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <span class="pill gold">LICENSE CLASS ${esc(lic)}</span>
          <span class="pill">DR ${dr} (${esc(drGrade)})</span>
          <span class="pill">SR ${sr} / 4.99</span>
          <span class="pill">🛡 Jokers: ${jokers}</span>
          <span class="pill ${this.cloud.available ? 'gold' : ''}">${esc(netStatus)}</span>
          ${mp?.badSport ? '<span class="pill" style="border-color:#ff4757;color:#ff4757">⚠ BAD-SPORT QUARANTINE</span>' : ''}
          ${this.cloud.available ? '<button class="small" data-act="official-refresh">↻ Refresh</button>' : ''}
        </div>
        ${sponsorBar}
        <div class="chips" style="margin-bottom:12px">
          <button class="chip ${this.lobbyTab === 'splits' ? 'on' : ''}" data-act="lobby-tab" data-v="splits">🏁 Scheduled Splits</button>
          <button class="chip ${this.lobbyTab === 'champs' ? 'on' : ''}" data-act="lobby-tab" data-v="champs">🏆 Championships</button>
          <button class="chip ${this.lobbyTab === 'hotlaps' ? 'on' : ''}" data-act="lobby-tab" data-v="hotlaps">⏱ Global Hotlaps</button>
          <button class="chip ${this.lobbyTab === 'leagues' ? 'on' : ''}" data-act="lobby-tab" data-v="leagues">🤝 Teams &amp; Leagues</button>
        </div>
        ${this.lobbyTab === 'splits' ? `
          <h3>🏁 Community Scheduled Splits ${this.officialSeason ? `<small class="dim">Season ${esc(this.officialSeason)} · Automated Fault-Aware 0x Victim Shield · 100% Free</small>` : ''}</h3>
          <div class="shop-cars">${seriesCards}</div>
          ${this.officialNote ? `<div class="pnote ${this.officialNote.startsWith('✓') ? '' : 'bad'}">${esc(this.officialNote)}</div>` : ''}
          <h3 style="margin-top:16px">Private Parties &amp; P2P (Free Forever)</h3>
          <div class="lobby-cols">
            <div class="lcol"><h3>Host</h3><p class="dim">Start a private party and invite friends with a link or 5-letter code (+${Math.round((PARTY_BONUS_MUL - 1) * 100)}% Party XP/CR Bonus).</p>
              <button class="primary huge" data-act="pcreate" ${this.partyBusy ? 'disabled' : ''}>＋ Create Party</button></div>
            <div class="lcol"><h3>Quick Ranked Match</h3><p class="dim">Auto-join the active OpenGrid Rookie Sprint split (or open public room).</p>
              <button class="primary huge" data-act="pmatch" ${this.partyBusy ? 'disabled' : ''}>🌐 Quick Match</button></div>
            <div class="lcol"><h3>Join by Code</h3><p class="dim">Got a code from a friend? Type it here.</p>
              <div class="joinrow"><input id="joincode" type="text" maxlength="10" value="${esc(this.joinCode)}" placeholder="CODE" spellcheck="false" autocomplete="off" />
              <button class="primary" data-act="pjoin" ${this.partyBusy ? 'disabled' : ''}>Join</button></div></div>
          </div>`
        : this.lobbyTab === 'champs' ? `
          <h3>🏆 Season Championships <small class="dim">SOF-weighted points · Best 8 of 12 rounds</small></h3>
          <div class="chips" style="margin-bottom:10px">
            ${([['rookie_sprint', 'Rookie GT Sprint'], ['gt3_championship', 'GT3 World Champ'], ['hypercar_pro', 'Hypercar Pro'], ['endurance_special', 'Endurance']] as const).map(([id, lbl]) =>
              `<button class="chip ${this.champSeries === id ? 'on' : ''}" data-act="champ-series" data-v="${id}">${lbl}</button>`).join('')}
          </div>
          ${this.champStandings.length
            ? `<div class="standings">${this.champStandings.map((s, i) => `<div class="srow"><span class="spos">${i + 1}</span><b>${esc(s.name)}</b><span class="pill">${esc(s.license)} · DR ${Math.round(s.dr)}</span><span class="dim">${esc(s.locked_car || '—')} · ${s.wins}W/${s.podiums}P</span><span class="sgap"><b>${s.points} pts</b></span></div>`).join('')}</div>`
            : `<div class="dim note">${this.cloud.available ? 'No championship rounds scored yet this season — register in Official Splits and finish a ranked race to take P1!' : 'Connect to the OpenGrid cloud backend to view live global Championship Standings.'}</div>`}`
        : this.lobbyTab === 'hotlaps' ? `
          <h3>⏱ Verified Global Hotlap Leaderboard <small class="dim">Clean laps auto-upload · C++20 replay verified</small></h3>
          ${this.hotlapEntries.length
            ? `<div class="standings">${this.hotlapEntries.map((e, i) => `<div class="srow"><span class="spos">${i + 1}</span><b>${esc(e.username)}</b><span class="dim">${esc(this.cars.find((c) => c.id === e.car)?.name ?? e.car)}</span><span class="sgap"><b class="best-inline">${formatLap(e.lap_ms / 1000)}</b></span></div>`).join('')}</div>`
            : `<div class="dim note">${this.cloud.available ? 'No verified hotlaps posted on this circuit yet — complete a clean lap to set the World Record!' : 'Connect to the OpenGrid cloud backend to submit and view Global Hotlaps.'}</div>`}`
        : `
          <h3>🤝 Endurance Teams <small class="dim">Team Driver Swaps &amp; Multiclass Endurance</small></h3>
          <div class="joinrow" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
            <input id="team-name" type="text" maxlength="32" value="${esc(this.teamNameDraft)}" placeholder="Team Name (e.g. Apex Racing)" />
            <input id="team-tag" type="text" maxlength="5" style="max-width:110px" value="${esc(this.teamTagDraft)}" placeholder="TAG" />
            <button class="primary" data-act="team-create" ${this.cloud.available ? '' : 'disabled'}>＋ Create Team</button>
          </div>
          <div class="members" style="margin-bottom:14px">${this.myTeams.length
            ? this.myTeams.map((tm) => `<div class="member"><div class="mtext"><div class="mname"><span class="pill gold">[${esc(tm.tag)}]</span> <b>${esc(tm.name)}</b></div><span class="dim">Role: ${esc(tm.role)}</span></div></div>`).join('')
            : '<div class="dim note">You are not in an endurance team yet. Create one above to run Team Endurance races!</div>'}</div>
          <h3>🏛 Hosted Private Leagues <small class="dim">Custom rules, BoP &amp; password-protected leagues</small></h3>
          <div class="joinrow" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
            <input id="lg-name" type="text" maxlength="40" value="${esc(this.leagueNameDraft)}" placeholder="New League Name" />
            <input id="lg-desc" type="text" maxlength="80" value="${esc(this.leagueDescDraft)}" placeholder="Rules / BoP notes" />
            <input id="lg-pass" type="password" maxlength="40" style="max-width:160px" value="${esc(this.leaguePassDraft)}" placeholder="Password (optional)" />
            <button class="primary" data-act="league-create" ${this.cloud.available ? '' : 'disabled'}>＋ Create League</button>
          </div>
          <div class="joinrow" style="flex-wrap:wrap;gap:6px;margin-bottom:10px">
            <input id="lg-jcode" type="text" maxlength="10" style="max-width:140px" value="${esc(this.leagueJoinCode)}" placeholder="LEAGUE CODE" />
            <input id="lg-jpass" type="password" maxlength="40" style="max-width:180px" value="${esc(this.leagueJoinPass)}" placeholder="Password (if private)" />
            <button class="small primary" data-act="league-join" ${this.cloud.available ? '' : 'disabled'}>Join League</button>
          </div>
          ${this.officialNote ? `<div class="pnote ${this.officialNote.startsWith('✓') ? '' : 'bad'}">${esc(this.officialNote)}</div>` : ''}
          <div class="members">${this.publicLeagues.length
            ? this.publicLeagues.map((lg) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(lg.name)}</b> <span class="pill">${esc(lg.code)}</span>${lg.is_private ? '<span class="pill gold">🔒 PRIVATE</span>' : ''}</div><span class="dim">${esc(lg.description || 'Custom OpenGrid League')} · ${lg.member_count}/${lg.max_drivers} drivers</span></div><button class="small primary" data-act="league-quickjoin" data-v="${esc(lg.code)}">Join</button></div>`).join('')
            : '<div class="dim note">No public leagues hosted yet — create the first one above!</div>'}</div>`}
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
        ${m.id !== p.selfId ? `<button class="small" data-act="voice-mute" data-v="${esc(m.id)}" title="Mute voice">${this.voiceMutedPeers.has(m.id) ? '🔇' : '🔊'}</button><button class="small" data-act="voice-block" data-v="${esc(m.id)}" title="Block player">🚫</button>` : ''}
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
      ${p.liveGarage && p.liveGarage.hostId !== p.selfId ? `<div class="opts" style="margin:8px 0;padding:8px 10px;border:1px solid #ff6b3d66;border-radius:10px;background:#ff6b3d18;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span>🔧 <b>${esc(p.liveGarage.hostName)}</b> is customizing their <b>${esc(carName(p.liveGarage.car))}</b> live in the Garage!</span>
        <button class="small primary" data-act="g-visit-join">👀 Join Live Garage</button>
      </div>` : ''}
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
    const reportBar = this.reportTarget ? `<div class="pnote"><b>🚩 Flag ${esc(this.reportTarget)} (Automated Log):</b>
      <button class="small" data-act="report-send" data-k="hate_livery_plate" data-v="${esc(this.reportTarget)}">Hate Speech Livery/Plate</button>
      <button class="small" data-act="report-send" data-k="cheating" data-v="${esc(this.reportTarget)}">Suspected Cheating</button>
      <button class="small" data-act="report-cancel">Cancel</button></div>` : (this.protestNote ? `<div class="pnote ${this.protestNote.startsWith('✓') ? '' : 'bad'}">${esc(this.protestNote)}</div>` : '');
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
      ${r.graduationTip ? `<div class="pnote">${esc(r.graduationTip)}</div>` : ''}
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
      const drStr = y && typeof y.drDelta === 'number'
        ? `DR ${Math.round(y.drBefore ?? 1500)} → <b>${Math.round(y.drAfter ?? 1500)}</b> (${y.drDelta >= 0 ? '+' : ''}${Math.round(y.drDelta)})`
        : '';
      const srStr = y && typeof y.srDelta === 'number'
        ? `SR ${(y.srBefore ?? 2.5).toFixed(2)} → <b>${(y.srAfter ?? 2.5).toFixed(2)}</b> (${y.srDelta >= 0 ? '+' : ''}${y.srDelta.toFixed(2)})`
        : '';
      const canJoker = !!x.raceId && (dnf || (y?.drDelta ?? 0) < 0) && (x.profile?.jokersLeft ?? this.mp.profile?.jokersLeft ?? 0) > 0;
      return `<div class="reward"><div class="kicker">${x.ranked ? `OFFICIAL RANKED RACE${x.sof ? ` · SOF ${Math.round(x.sof)}` : ''}` : 'UNRANKED'}</div>
        ${y && (y.xp || y.cr) ? `<div class="earned center">+${fmtXp(y.xp)} · +${fmt(y.cr)}${y.champPts ? ` · +${y.champPts} Champ Pts` : ''}</div>` : ''}
        ${(drStr || srStr) ? `<div class="opts" style="justify-content:center;gap:8px;flex-wrap:wrap;margin:6px 0">
          ${y?.license ? `<span class="pill gold">CLASS ${esc(y.license)}${y.promoted ? ' ▲ PROMOTED!' : y.demoted ? ' ▼ DEMOTED' : ''}</span>` : ''}
          ${drStr ? `<span class="pill">${drStr}</span>` : ''}
          ${srStr ? `<span class="pill">${srStr}</span>` : ''}
          ${typeof y?.incidentPoints === 'number' ? `<span class="pill">${y.incidentPoints}x Incidents</span>` : ''}
        </div>` : ''}
        ${canJoker ? `<div style="margin:6px 0"><button class="small primary" data-act="use-joker" data-v="${esc(x.raceId)}">🛡 Use Season Disconnect Joker (${x.profile?.jokersLeft ?? this.mp.profile?.jokersLeft ?? 0} left) — Restore Lost DR/SR</button></div>` : ''}
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
    if (['play', 'garage-open', 'start-race', 'start-free', 'start-test-free', 'start-test-garage', 'pstart', 'invite', 'prejoin'].includes(act)) this.askFullscreen();
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
      case 'garage-open': this.garageHideUi = false; this.garageNote = ''; this.show('garage'); this.hooks.preview(); break;
      case 'home': this.show('title'); break;
      // welcome gate (gate.ts): play as a guest, or carry on after signing in / saving the recovery codes of a new account
      case 'gate-guest': markGate('guest'); this.authNote = ''; this.show('title'); break;
      case 'gate-continue': markGate('account'); this.authNote = ''; this.recoveryCodes = []; this.show('title'); break;
      case 'profile-open': this.profileFrom = this.screen === 'profile' ? this.profileFrom : this.screen; this.unameDraft = null; this.unameNote = ''; this.friendNote = ''; this.show('profile'); break;
      case 'profile-back': this.show(this.profileFrom); break;
      case 'uname-save': void this.saveName(); break;
      case 'friend-add': void this.friendAct(this.friendDraft, 'add'); break;
      case 'friend-accept': void this.friendAct(v, 'accept'); break;
      case 'friend-remove': void this.friendAct(v, 'remove'); break;
      case 'friend-join': this.joinCode = v; this.setCareer('mp'); this.show('lobby'); this.hooks.partyJoin(v); break;
      case 'shop-open': this.shopNote = ''; this.shopTab = 'lots'; this.show('shop'); break;
      case 'auction-sell-open': this.shopNote = ''; this.shopTab = 'sell'; this.show('shop'); break;
      case 'shop-gear': this.garagePillar = 'driver'; this.garageTab = 'driver'; this.show('garage'); break;
      case 'stab': this.shopTab = v as typeof this.shopTab; this.shopNote = ''; this.render(); break;
      case 'refresh-lots': this.lotWindowOffset += 1; this.shopNote = '✓ Scouted next Auction Floor rotation.'; this.render(); break;
      case 'buy-live-lot': {
        const lot = this.currentLiveLots().find((x) => x.id === v);
        if (!lot || this.market.boughtDynamicLots.includes(lot.id)) break;
        this.shopNote = '…'; this.render();
        void this.career.buyAuctionCar(lot.carId, lot.priceCr).then((note) => {
          this.shopNote = note;
          if (note.startsWith('✓')) {
            this.market.boughtDynamicLots.push(lot.id);
            recordMarketTrade(this.market, lot.carId, 'buy', lot.priceCr);
            const eng = engineOf(this.nr, lot.carId);
            eng.health = lot.startHealth;
            eng.mileageKm = lot.mileageKm;
            eng.oilLife = lot.kind === 'salvage' ? 28 : 100;
            eng.tags = [...lot.tags];
            if (lot.swap) eng.swap = lot.swap;
            if (lot.turbo) eng.turbo = lot.turbo;
            if (lot.manifold) eng.manifold = lot.manifold;
            saveNightRunners(this.nr);
            if (lot.startDamage > 0.02) recordRaceDamage(this.maint, lot.carId, lot.startDamage, false);
            else repairCarCondition(this.maint, lot.carId);
            saveMaintenance(this.maint);
            sel.car = lot.carId;
            this.save();
            this.hooks.nrChanged?.();
            this.hooks.preview();
          }
          this.render();
        });
        break;
      }
      case 'buy-market-car': {
        const entry = marketEntryOf(this.market, v);
        const price = entry.price;
        this.shopNote = '…'; this.render();
        void this.career.buyAuctionCar(v, price).then((note) => {
          this.shopNote = note;
          if (note.startsWith('✓')) {
            recordMarketTrade(this.market, v, 'buy', price);
            const eng = engineOf(this.nr, v);
            eng.health = 100; eng.oilLife = 100; eng.mileageKm = 420; eng.tags = [];
            saveNightRunners(this.nr);
            repairCarCondition(this.maint, v);
            saveMaintenance(this.maint);
            sel.car = v;
            this.save();
            this.hooks.nrChanged?.();
            this.hooks.preview();
          }
          this.render();
        });
        break;
      }
      case 'sell-car': {
        const cond = conditionOf(this.maint, v);
        const eng = engineOf(this.nr, v);
        const mods = this.sel.mods[v] ?? { engine: 0, tyres: 0, weight: 0, aero: 0 };
        const ap = appraiseCarForSale(this.market, v, cond, eng, mods);
        this.shopNote = '…'; this.render();
        void this.career.sellAuctionCar(v, ap.netPayout).then((note) => {
          this.shopNote = note;
          if (note.startsWith('✓')) {
            recordMarketTrade(this.market, v, 'sell', ap.netPayout);
            // Reset sold car's mods/engine/damage cleanly so re-buying starts fresh
            delete sel.mods[v];
            eng.swap = 'stock'; eng.turbo = 'stock'; eng.manifold = 'stock';
            eng.health = 100; eng.oilLife = 100; eng.mileageKm = 1_200; eng.tags = [];
            saveNightRunners(this.nr);
            repairCarCondition(this.maint, v);
            saveMaintenance(this.maint);
            this.career.fit(sel);
            this.save();
            this.hooks.nrChanged?.();
            this.hooks.preview();
          }
          this.render();
        });
        break;
      }
      case 'garage-buy-mod': {
        const k = b.dataset.k as ModKey;
        const st = Number(v);
        this.garageNote = '…'; this.render();
        void this.career.buy('mod', `${sel.car}:${k}`, st).then((note) => {
          this.garageNote = note;
          if (note.startsWith('✓')) {
            const m = { ...modsOf(sel) };
            m[k] = st;
            sel.mods[sel.car] = m;
            this.save();
            this.hooks.nrChanged?.();
          }
          this.render();
        });
        break;
      }
      case 'garage-buy-skin': {
        this.garageNote = '…'; this.render();
        void this.career.buy('skin', v).then((note) => {
          this.garageNote = note;
          if (note.startsWith('✓') && this.career.ownsSkin(v)) {
            sel.skin = v;
            const sk = skinOf(v);
            Object.assign(sel.avatarGear, { helmet: sk.helmet, accent: sk.accent, visor: sk.visor, suit: sk.suit, gloves: sk.gloves });
            this.save();
            this.hooks.look();
            this.hooks.partyMe();
          }
          this.render();
        });
        break;
      }
      case 'gpillar': {
        this.garagePillar = v as GaragePillar;
        this.scrollMem.delete('.g-stage-scroll');
        this.scrollMem.delete('.g-rail');
        if (this.garagePillar === 'rides') {
          this.hooks.cam?.(NaN, 0, 0);
        } else {
          const first = GTABS.find((x) => x.pillar === this.garagePillar);
          if (first) {
            this.garageTab = first.id;
            const [az, el, dist] = first.cam.split(',').map(Number);
            this.hooks.cam?.(az, el, dist);
          }
        }
        this.render();
        break;
      }
      case 'g-cam-cycle': {
        this.garageCamIdx = (this.garageCamIdx + 1) % GARAGE_CAMS.length;
        const c = GARAGE_CAMS[this.garageCamIdx];
        if (c.v === 'orbit') this.hooks.cam?.(NaN, 0, 0);
        else { const [az, el, dist] = c.v.split(',').map(Number); this.hooks.cam?.(az, el, dist); }
        this.render();
        break;
      }
      case 'gtab': { this.garageTab = v; this.scrollMem.delete('.g-stage-scroll'); const t = GTABS.find((x) => x.id === v); if (t) { this.garagePillar = t.pillar; const [az, el, dist] = t.cam.split(',').map(Number); this.hooks.cam?.(az, el, dist); } this.render(); break; }
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
      case 'g-hide-ui': this.garageHideUi = !this.garageHideUi; this.render(); break;
      case 'g-ignition': this.hooks.garageIgnition?.(); break;
      case 'g-dyno': this.hooks.garageDyno?.(); break;
      case 'g-rev': this.hooks.garageRev?.(); break;
      case 'g-walk': this.garageWalkActive = !this.garageWalkActive; this.hooks.garageWalk?.(this.garageWalkActive); this.render(); break;
      case 'g-invite': this.hooks.garageInvite?.(); break;
      case 'g-invite-open':
        this.garageHideUi = false;
        this.show('garage');
        this.hooks.preview();
        this.hooks.garageInvite?.();
        break;
      case 'quick-day-race':
        this.sanctionedMode = true;
        this.hooks.sanctionedToggle?.(true);
        sel.mode = 'race';
        this.setCareer('sp');
        this.save();
        this.hooks.play('race');
        break;
      case 'quick-night-race':
        this.sanctionedMode = false;
        this.hooks.sanctionedToggle?.(false);
        sel.mode = 'race';
        this.setCareer('sp');
        this.save();
        this.hooks.play('race');
        break;
      case 'lobby-tab-open':
        this.partyNote = '';
        this.lobbyTab = (v as typeof this.lobbyTab) || 'splits';
        this.setCareer('mp');
        this.show('lobby');
        this.hooks.refreshSchedule?.();
        this.hooks.refreshHubTab?.(this.lobbyTab, this.champSeries);
        break;
      case 'g-visit-join': this.hooks.garageVisitJoin?.(); break;
      case 'g-visit-leave': this.hooks.garageVisitLeave?.(); break;
      case 'g-emote': this.hooks.garageEmote?.(v); break;
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
        eng.swap = v as SwapId;
        eng.health = 100;
        eng.oilLife = 100;
        this.hooks.nrChanged?.();
        this.hooks.garageRev?.();
        this.render();
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
      case 'voice-mute': this.hooks.voiceMutePeer?.(v); this.render(); break;
      case 'voice-block': this.hooks.voiceBlockPeer?.(v); this.render(); break;
      case 'pmatch': this.hooks.publicMatchmake?.(); break;
      case 'official-reg': this.hooks.registerOfficialSeries?.(v); break;
      case 'official-join': this.hooks.joinOfficialSplit?.(v); break;
      case 'official-refresh': this.hooks.refreshHubTab?.(this.lobbyTab, this.champSeries); this.hooks.refreshSchedule?.(); break;
      case 'patreon-connect': this.hooks.connectPatreon?.(); break;
      case 'patreon-refresh': this.hooks.refreshSubscription?.(); break;
      case 'lobby-tab':
        this.lobbyTab = (v as typeof this.lobbyTab) || 'splits';
        this.officialNote = '';
        this.hooks.refreshHubTab?.(this.lobbyTab, this.champSeries);
        this.render();
        break;
      case 'champ-series':
        this.champSeries = v || 'gt3_championship';
        this.hooks.refreshHubTab?.('champs', this.champSeries);
        this.render();
        break;
      case 'team-create':
        if (this.teamNameDraft.trim() && this.teamTagDraft.trim()) {
          this.hooks.createTeam?.(this.teamNameDraft.trim(), this.teamTagDraft.trim());
          this.teamNameDraft = '';
          this.teamTagDraft = '';
        }
        break;
      case 'league-create':
        if (this.leagueNameDraft.trim()) {
          this.hooks.createLeague?.({ name: this.leagueNameDraft.trim(), description: this.leagueDescDraft.trim(), password: this.leaguePassDraft || undefined });
          this.leagueNameDraft = '';
          this.leagueDescDraft = '';
          this.leaguePassDraft = '';
        }
        break;
      case 'league-join':
        if (this.leagueJoinCode.trim()) {
          this.hooks.joinLeague?.(this.leagueJoinCode.trim().toUpperCase(), this.leagueJoinPass || undefined);
          this.leagueJoinPass = '';
        }
        break;
      case 'league-quickjoin':
        this.hooks.joinLeague?.(v, this.leagueJoinPass || undefined);
        break;
      case 'protest-send': {
        const itype = b.dataset.k as 'intentional_wreck' | 'unsafe_rejoin' | 'blocking' | 'ramming' | 'chat_abuse';
        const raceId = this.rankedRes?.raceId ?? '';
        this.reportTarget = '';
        if (raceId) this.hooks.fileProtest?.(raceId, v, itype);
        this.render();
        break;
      }
      case 'use-joker':
        this.hooks.useJoker?.(v);
        break;
      case 'spotter':
        this.spotterOn = v === '1';
        this.hooks.spotterToggle?.(this.spotterOn);
        this.render();
        break;
      case 'auth-register': void this.submitAuth('register'); break;
      case 'auth-login': void this.submitAuth('login'); break;
      case 'auth-2fa-login-cancel':
        this.authNeeds2fa = false;
        this.authTotp = '';
        this.authNote = '';
        this.render();
        break;
      case 'auth-forgot-toggle':
        this.authForgotOpen = !this.authForgotOpen;
        if (this.authForgotOpen && !this.authResetEmail && this.authEmail) this.authResetEmail = this.authEmail;
        if (this.authForgotOpen) { this.authNeeds2fa = false; this.authTotp = ''; }
        this.authNote = '';
        this.render();
        break;
      case 'auth-forgot-send': void this.submitForgotPassword(); break;
      case 'auth-reset-submit': void this.submitResetPassword(); break;
      case 'auth-copy-codes': this.copyRecoveryCodes(); break;
      case 'auth-dismiss-codes':
        this.recoveryCodes = [];
        if (this.screen === 'welcome' && this.mp.profile?.email) { markGate('account'); this.authNote = ''; this.show('title'); }   // codes saved: the gate is done
        else this.render();
        break;
      case 'auth-2fa-setup': void this.start2faSetup(); break;
      case 'auth-2fa-enable': void this.submitEnable2fa(); break;
      case 'auth-2fa-cancel':
        this.totpSetup = null;
        this.totpVerifyCode = '';
        this.render();
        break;
      case 'auth-2fa-disable-toggle':
        this.totpDisableOpen = !this.totpDisableOpen;
        this.totpDisableCode = '';
        if (this.totpDisableOpen) { this.totpSetup = null; this.pwPanelOpen = false; this.delPanelOpen = false; }
        this.render();
        break;
      case 'auth-2fa-disable-submit': void this.submitDisable2fa(); break;
      case 'auth-pw-toggle':
        this.pwPanelOpen = !this.pwPanelOpen;
        this.pwCur = '';
        this.pwNew = '';
        if (this.pwPanelOpen) { this.totpSetup = null; this.totpDisableOpen = false; this.delPanelOpen = false; }
        this.render();
        break;
      case 'auth-pw-submit': void this.submitChangePassword(); break;
      case 'auth-recovery-regen': void this.submitRegenerateRecoveryCodes(); break;
      case 'auth-delete-toggle':
        this.delPanelOpen = !this.delPanelOpen;
        this.delPass = '';
        this.delConfirm = '';
        if (this.delPanelOpen) { this.totpSetup = null; this.totpDisableOpen = false; this.pwPanelOpen = false; }
        this.render();
        break;
      case 'auth-delete-submit': void this.submitDeleteAccount(); break;
      case 'auth-oauth': {
        const prov = v as OAuthProvider;
        if (prov === 'google' || prov === 'github' || prov === 'discord') void this.startOAuthLogin(prov);
        break;
      }
      case 'auth-logout': void this.submitLogout(); break;
      case 'music': this.musicOn = v === '1'; this.hooks.musicToggle?.(this.musicOn); this.render(); break;
      case 'audio-engine': {
        const m = v === 'engine_sim' ? 'engine_sim' : 'real_samples';
        this.audioEngineMode = m;
        this.hooks.audioEngineMode?.(m);
        this.render();
        break;
      }
      case 'audio-engine-toggle': {
        const m = this.audioEngineMode === 'real_samples' ? 'engine_sim' : 'real_samples';
        this.audioEngineMode = m;
        this.hooks.audioEngineMode?.(m);
        this.render();
        break;
      }
      case 'spec-class': this.specClass = v === '1'; this.hooks.specClassToggle?.(this.specClass); this.render(); break;
      case 'sanctioned': this.sanctionedMode = v === '1'; this.hooks.sanctionedToggle?.(this.sanctionedMode); this.render(); break;
      case 'mod-sub': {
        const on = toggleModSub(this.modHub, v);
        this.shopNote = on ? '✓ Mod subscribed & verified.' : 'Mod unsubscribed.';
        this.render();
        break;
      }
      case 'gfilter': this.carFilter = v as typeof this.carFilter; this.render(); break;
      case 'gsort': this.carSort = v as typeof this.carSort; this.render(); break;
      case 'fav-car': {
        const i = this.favCars.indexOf(v);
        if (i >= 0) this.favCars.splice(i, 1); else this.favCars.push(v);
        try { localStorage.setItem('nr.favcars.v1', JSON.stringify(this.favCars)); } catch { /* blocked */ }
        this.render();
        break;
      }
      case 'cal-go': {
        const ev = WEEKLY_CALENDAR.find((x) => x.dayIdx === Number(v));
        if (ev) this.hooks.launchCalendar?.(ev);
        break;
      }
      case 'ac-go': {
        const l = ACADEMY_LESSONS.find((x) => x.id === v);
        if (l) this.hooks.launchAcademy?.(l);
        break;
      }
      case 'wear-skin': if (this.career.ownsSkin(v)) { sel.skin = v; this.save(); this.hooks.look(); this.hooks.partyMe(); this.render(); } break;
      case 'shop-drive': sel.car = v; this.save(); this.render(); this.hooks.preview(); break;
      case 'buy': {
        const st = b.dataset.stage ? Number(b.dataset.stage) : undefined;
        this.shopNote = '…'; this.render();
        void this.career.buy(b.dataset.kind as 'car' | 'mod' | 'skin', v, st).then((note) => { this.shopNote = note; this.render(); });
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
      case 'lobby': this.partyNote = ''; this.setCareer('mp'); this.show('lobby'); this.hooks.refreshSchedule?.(); break;
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
      case 'ai-preset': {
        if (v === 'adaptive') {
          sel.aiAdaptive = true;
        } else {
          const preset = AI_DIFFICULTY_PRESETS.find((p) => p.id === v);
          if (preset) {
            sel.aiAdaptive = false;
            sel.aiDiff = preset.pct;
          }
        }
        this.save();
        this.hooks.onAiDifficulty?.(sel.aiDiff, sel.aiAdaptive);
        this.render();
        break;
      }
      case 'start-race': sel.mode = 'race'; this.setCareer('sp'); this.save(); this.hooks.play('race'); break;
      case 'start-free': sel.mode = 'free'; this.setCareer('sp'); this.save(); this.hooks.play('free'); break;
      case 'split-layout': this.splitLayout = v === 'vertical' ? 'vertical' : 'horizontal'; this.render(); break;
      case 'split-p2car': this.splitP2Car = v; this.render(); break;
      case 'start-split-race': sel.mode = 'race'; this.setCareer('sp'); this.save(); this.hooks.playSplit?.('race', this.splitLayout, this.splitP2Car); break;
      case 'start-split-free': sel.mode = 'free'; this.setCareer('sp'); this.save(); this.hooks.playSplit?.('free', this.splitLayout, this.splitP2Car); break;
      case 'start-test-free':
        this.sp.setTestingMode(true);
        sel.mode = 'free';
        this.setCareer('sp');
        this.save();
        this.hooks.play('free');
        break;
      case 'start-test-garage':
        this.sp.setTestingMode(true);
        this.setCareer('sp');
        this.save();
        this.show('garage');
        this.hooks.preview();
        break;
      case 'toggle-testing':
        this.sp.setTestingMode(!this.sp.testingMode);
        this.setCareer('sp');
        this.career.fit(sel);
        this.save();
        this.render();
        this.hooks.preview();
        break;
      case 'resume': this.hooks.resume(); break;
      case 'restart': this.hooks.restart(); break;
      case 'quit': this.lastResults = null; this.hooks.quit('title'); break;
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
      if (act === 'as-sa') a.steeringAssist = v as SteeringAssistLevel;
      if (act === 'as-ba') a.brakingAssist = v as BrakingAssistLevel;
      if (act === 'as-abs') a.abs = v as typeof a.abs;
      if (act === 'as-tc') a.tc = Number(v);
      if (act === 'as-esc') a.stability = v === '1';
      if (act === 'as-cs') a.countersteer = v as typeof a.countersteer;
      if (act === 'as-gb') a.gearbox = v as typeof a.gearbox;
      if (act === 'as-ac') a.autoClutch = v as typeof a.autoClutch;
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

  // ---- welcome gate (gate.ts) ----------------------------------------------------------------------------------------------
  /** The first screen on a new device: play as a guest, or log in / sign up. Then the title (a new player gets the username card there).
   *  One centred column, every row the same width: guest, provider icons, email + password, two equal buttons. */
  private welcome() {
    const online = this.cloud.available;
    const busy = this.authBusy ? 'disabled' : '';
    const head = (kicker: string, title: string) => `<div class="gate-head"><div class="kicker">${kicker}</div><h2>${title}</h2></div>`;
    // a brand-new account first has to see its one-time recovery codes (shown only once)
    if (this.recoveryCodes.length > 0) {
      return `<div class="lobby-screen"><div class="card lobby-card pick-card gate-card">
        ${head('ACCOUNT CREATED', 'Save your recovery codes')}
        ${this.recoveryCardHtml()}
        <button class="primary gate-main" style="margin-top:16px" data-act="gate-continue">Continue</button>
        <p class="gate-hint">You can make a new set any time in Profile.</p>
      </div></div>`;
    }
    const socials = (['google', 'github', 'discord'] as const).filter((p) => this.oauthProviders[p]).map((p) => {
      const label = `Continue with ${BRAND_NAME[p]}`;
      return `<button class="gate-social" data-act="auth-oauth" data-v="${p}" aria-label="${label}" title="${label}" ${busy}>${BRAND_ICON[p]}</button>`;
    }).join('');
    const secondStep = this.authNeeds2fa || this.authForgotOpen;   // 2FA code / password reset replace the plain form
    // prompts (2FA code, signed out) are neutral, confirmations green, everything else an error
    const noteCls = /^(Enter the 6-digit|Signed out)/.test(this.authNote) ? 'info' : (this.authBusy || this.authNote.startsWith('✓')) ? '' : 'bad';
    const note = this.authNote ? `<div class="pnote ${noteCls}">${this.authBusy ? '<span class="spin inline"></span> ' : ''}${esc(this.authNote)}</div>` : '';
    const signIn = !online
      ? `<div class="dim note gate-offline">Accounts need the online service, which cannot be reached right now. Guest play works fully offline, and you can sign in later from your Profile.</div>`
      : `${secondStep ? '' : `<div class="gate-or"><span>or</span></div>
        ${socials ? `<div class="gate-socials">${socials}</div>` : ''}
        <div class="gate-form">
          <input id="auth-email" type="email" value="${esc(this.authEmail)}" placeholder="Email address" autocomplete="email" />
          <input id="auth-pass" type="password" value="${esc(this.authPass)}" placeholder="Password (8+ characters)" autocomplete="current-password" />
        </div>
        <div class="gate-actions">
          <button class="primary" data-act="auth-login" ${busy}>Log in</button>
          <button data-act="auth-register" ${busy}>Create account</button>
        </div>
        <button class="gate-link" data-act="auth-forgot-toggle" ${busy}>Forgot password?</button>`}
        ${this.gateStepHtml(busy)}`;
    return `<div class="lobby-screen"><div class="card lobby-card pick-card gate-card">
      ${head('OPEN GRID', 'Welcome')}
      <button class="primary gate-main" data-act="gate-guest" ${busy}>Continue as guest</button>
      <p class="gate-hint">No account needed. Upgrade any time from your Profile.</p>
      ${signIn}
      ${note}
    </div></div>`;
  }

  /** The welcome gate's second step, stacked to the card's width: the 2FA code, or the password reset (same ids / actions as the Profile's). */
  private gateStepHtml(busy: string) {
    if (this.authNeeds2fa) {
      return `<div class="gate-step">
        <div class="gate-step-title">Two-factor code</div>
        <div class="gate-form"><input id="auth-totp" type="text" inputmode="numeric" maxlength="16" value="${esc(this.authTotp)}" placeholder="6-digit or backup code" autocomplete="one-time-code" /></div>
        <div class="gate-actions"><button class="primary" data-act="auth-login" ${busy}>Verify</button><button data-act="auth-2fa-login-cancel" ${busy}>Back</button></div>
      </div>`;
    }
    if (this.authForgotOpen) {
      return `<div class="gate-step">
        <div class="gate-step-title">Reset password</div>
        <p class="gate-hint">Get a code by email, or use one of your saved recovery codes.</p>
        <div class="gate-form">
          <input id="auth-reset-email" type="email" value="${esc(this.authResetEmail)}" placeholder="Account email" autocomplete="email" />
          <button data-act="auth-forgot-send" ${busy}>Send reset code</button>
          <input id="auth-reset-code" type="text" value="${esc(this.authResetCode)}" placeholder="Reset or recovery code" autocomplete="one-time-code" spellcheck="false" />
          <input id="auth-reset-pass" type="password" value="${esc(this.authResetPass)}" placeholder="New password (8+ characters)" autocomplete="new-password" />
        </div>
        <div class="gate-actions"><button class="primary" data-act="auth-reset-submit" ${busy}>Reset &amp; log in</button><button data-act="auth-forgot-toggle" ${busy}>Back</button></div>
      </div>`;
    }
    return '';
  }

  // ---- username and friends (identity.ts) -----------------------------------------------------------------------------------
  /** First start: a username before anything else (how friends find you; shown in races and on your plate). */
  private pickName() {
    const draft = this.unameDraft ?? (usernameError(this.sel.name) ? '' : this.sel.name);
    return `<div class="lobby-screen"><div class="card lobby-card pick-card">
      <div class="kicker">ONE LAST STEP</div><h2>Choose your username</h2>
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
  private resetSecurityPanels() {
    this.authNeeds2fa = false;
    this.authTotp = '';
    this.authForgotOpen = false;
    this.authResetCode = '';
    this.authResetPass = '';
    this.totpSetup = null;
    this.totpVerifyCode = '';
    this.totpDisableOpen = false;
    this.totpDisableCode = '';
    this.pwPanelOpen = false;
    this.pwCur = '';
    this.pwNew = '';
    this.delPanelOpen = false;
    this.delPass = '';
    this.delConfirm = '';
  }

  private async submitAuth(kind: 'register' | 'login') {
    if (this.authBusy || !this.cloud.available) return;
    this.authBusy = true;
    this.authNote = kind === 'register' ? 'Saving account…' : (this.authNeeds2fa ? 'Verifying 2FA code…' : 'Signing in…');
    this.render();
    try {
      if (kind === 'register') {
        // a first-time player has no valid username yet (the default name is reserved and the server rejects it): send one only when valid
        const wanted = this.identity.claimed ? '' : (this.unameDraft ?? this.sel.name).trim();
        const res = await this.cloud.registerEmail(this.authEmail, this.authPass, wanted && !usernameError(wanted) ? wanted : undefined);
        this.mp.profile = res.profile;
        if (res.profile.username) { this.sel.name = res.profile.username; this.save(); }
        this.authPass = '';
        this.resetSecurityPanels();
        if (res.recoveryCodes?.length) this.recoveryCodes = res.recoveryCodes;
        this.authNote = `✓ Account saved for ${res.profile.email ?? this.authEmail} — works across Web & UE 5.8!`;
        void this.mp.refresh();
        void this.identity.sync(res.profile);
        this.gatePassed();
      } else {
        const res = await this.cloud.loginEmail(this.authEmail, this.authPass, this.authNeeds2fa ? this.authTotp.trim() : undefined);
        if (res.requires2fa) {
          this.authNeeds2fa = true;
          this.authTotp = '';
          this.authNote = 'Enter the 6-digit code from your authenticator app (or an 8-character backup code).';
        } else {
          this.mp.profile = res.profile;
          if (res.profile.username) { this.sel.name = res.profile.username; this.save(); }
          this.authPass = '';
          this.resetSecurityPanels();
          this.authNote = `✓ Welcome back, ${res.profile.name}!`;
          void this.mp.refresh();
          void this.identity.sync(res.profile);
          this.gatePassed();
        }
      }
    } catch (e) {
      this.authNote = (e as Error).message || 'Authentication failed.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitForgotPassword() {
    if (this.authBusy || !this.cloud.available) return;
    const email = this.authResetEmail.trim();
    if (!email) { this.authNote = 'Enter your account email address first.'; this.render(); return; }
    this.authBusy = true;
    this.authNote = 'Requesting password reset code…';
    this.render();
    try {
      const r = await this.cloud.forgotPassword(email);
      this.authNote = r.message
        ? (r.emailSent ? `✓ ${r.message}` : r.message)
        : (r.emailSent ? '✓ Reset code sent! Check your email inbox.' : 'Enter one of your saved 8-character recovery codes below to reset your password.');
    } catch (e) {
      this.authNote = (e as Error).message || 'Could not request password reset.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitResetPassword() {
    if (this.authBusy || !this.cloud.available) return;
    const email = this.authResetEmail.trim();
    const code = this.authResetCode.trim();
    const pw = this.authResetPass;
    if (!email || !code || !pw) {
      this.authNote = 'Enter your email, reset/recovery code, and new password (8+ chars).';
      this.render();
      return;
    }
    this.authBusy = true;
    this.authNote = 'Resetting password…';
    this.render();
    try {
      const res = await this.cloud.resetPassword(email, code, pw);
      this.mp.profile = res.profile;
      if (res.profile.username) { this.sel.name = res.profile.username; this.save(); }
      this.authEmail = email;
      this.authPass = '';
      this.resetSecurityPanels();
      this.authNote = `✓ Password reset! Signed in as ${res.profile.name}.`;
      void this.mp.refresh();
      void this.identity.sync(res.profile);
      this.gatePassed();
    } catch (e) {
      this.authNote = (e as Error).message || 'Password reset failed.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async start2faSetup() {
    if (this.authBusy || !this.cloud.available) return;
    this.authBusy = true;
    this.authNote = 'Generating 2FA secret…';
    this.render();
    try {
      this.totpDisableOpen = false;
      this.pwPanelOpen = false;
      this.delPanelOpen = false;
      this.totpSetup = await this.cloud.setup2fa();
      this.totpVerifyCode = '';
      this.authNote = 'Scan the QR code in your authenticator app (generated locally in your browser) and enter the 6-digit code.';
    } catch (e) {
      this.authNote = (e as Error).message || 'Could not start 2FA setup.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitEnable2fa() {
    if (this.authBusy || !this.cloud.available) return;
    const code = this.totpVerifyCode.trim();
    if (!code) { this.authNote = 'Enter the 6-digit code from your authenticator app.'; this.render(); return; }
    this.authBusy = true;
    this.authNote = 'Verifying 2FA code…';
    this.render();
    try {
      const res = await this.cloud.enable2fa(code);
      if (res.profile) this.mp.profile = res.profile;
      else if (this.mp.profile) this.mp.profile = { ...this.mp.profile, totpEnabled: true };
      this.totpSetup = null;
      this.totpVerifyCode = '';
      if (res.backupCodes?.length) this.recoveryCodes = res.backupCodes;
      this.authNote = '✓ Authenticator 2FA enabled! Save your 8 backup codes below.';
      void this.mp.refresh();
    } catch (e) {
      this.authNote = (e as Error).message || 'Invalid 2FA code.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitDisable2fa() {
    if (this.authBusy || !this.cloud.available) return;
    const code = this.totpDisableCode.trim();
    if (!code) { this.authNote = 'Enter your 6-digit authenticator code or a backup code.'; this.render(); return; }
    this.authBusy = true;
    this.authNote = 'Disabling 2FA…';
    this.render();
    try {
      const res = await this.cloud.disable2fa(code);
      if (res.profile) this.mp.profile = res.profile;
      else if (this.mp.profile) this.mp.profile = { ...this.mp.profile, totpEnabled: false };
      this.totpDisableOpen = false;
      this.totpDisableCode = '';
      this.authNote = '✓ Authenticator 2FA disabled.';
      void this.mp.refresh();
    } catch (e) {
      this.authNote = (e as Error).message || 'Could not disable 2FA.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitChangePassword() {
    if (this.authBusy || !this.cloud.available) return;
    const hasPw = Boolean(this.mp.profile?.hasPassword);
    if (hasPw && !this.pwCur) { this.authNote = 'Enter your current password.'; this.render(); return; }
    if (this.pwNew.length < 8) { this.authNote = 'New password must be at least 8 characters.'; this.render(); return; }
    this.authBusy = true;
    this.authNote = hasPw ? 'Updating password…' : 'Setting password…';
    this.render();
    try {
      await this.cloud.changePassword(hasPw ? this.pwCur : '', this.pwNew);
      if (this.mp.profile) this.mp.profile = { ...this.mp.profile, hasPassword: true };
      this.pwPanelOpen = false;
      this.pwCur = '';
      this.pwNew = '';
      this.authNote = '✓ Password updated! Your session token was securely rotated.';
    } catch (e) {
      this.authNote = (e as Error).message || 'Could not update password.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitRegenerateRecoveryCodes() {
    if (this.authBusy || !this.cloud.available) return;
    this.authBusy = true;
    this.authNote = 'Generating fresh recovery codes…';
    this.render();
    try {
      const res = await this.cloud.regenerateRecoveryCodes();
      this.recoveryCodes = res.recoveryCodes ?? [];
      this.authNote = '✓ Generated 8 new one-time recovery codes (previous codes invalidated).';
    } catch (e) {
      this.authNote = (e as Error).message || 'Could not regenerate recovery codes.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private async submitDeleteAccount() {
    if (this.authBusy || !this.cloud.available) return;
    if (this.delConfirm.trim() !== 'DELETE') {
      this.authNote = 'Type DELETE in all caps to confirm permanent account deletion.';
      this.render();
      return;
    }
    this.authBusy = true;
    this.authNote = 'Deleting account…';
    this.render();
    try {
      await this.cloud.deleteAccount(this.delConfirm.trim(), this.delPass || undefined);
      this.mp.profile = null;
      this.authEmail = '';
      this.authPass = '';
      this.recoveryCodes = [];
      this.resetSecurityPanels();
      this.authNote = '✓ Account permanently deleted on this service.';
    } catch (e) {
      this.authNote = (e as Error).message || 'Could not delete account.';
    } finally {
      this.authBusy = false;
      this.render();
    }
  }

  private copyRecoveryCodes() {
    if (!this.recoveryCodes.length) return;
    const text = this.recoveryCodes.join('\n');
    const done = (ok: boolean) => {
      this.authNote = ok ? '✓ Copied all 8 recovery codes to clipboard.' : 'Select and copy the codes manually.';
      this.render();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
    else done(false);
  }

  private async submitLogout() {
    if (this.authBusy) return;
    this.authBusy = true;
    await this.cloud.logout();
    this.mp.profile = null;
    this.authPass = '';
    this.recoveryCodes = [];
    this.resetSecurityPanels();
    this.authNote = 'Signed out on this device.';
    this.authBusy = false;
    clearGate();            // signing out brings the welcome screen back (guest / log in / sign up)
    this.show('welcome');
  }

  /** Signed in or signed up from the welcome screen: on to the title. A brand-new account first has to see its one-time
   *  recovery codes, so then the gate stays up (its Continue button moves on). */
  private gatePassed() {
    if (this.screen !== 'welcome') return;
    markGate('account');
    if (this.recoveryCodes.length) return;
    this.authNote = '';
    this.show('title');
  }

  private async startOAuthLogin(provider: OAuthProvider) {
    if (this.authBusy) return;
    const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();
    // Open popup synchronously inside the user gesture before any await so popup blockers never block it.
    const popup = inIframe
      ? window.open('about:blank', 'opengrid_oauth', 'width=540,height=680,menubar=no,toolbar=no,status=no')
      : null;

    this.authBusy = true;
    const label = BRAND_NAME[provider];
    this.authNote = inIframe ? `Complete ${label} sign-in in the popup window…` : `Connecting to ${label}…`;
    this.render();

    try {
      const { url: authUrl, ticket } = await this.cloud.startOAuthSession(provider, undefined, inIframe);
      if (!inIframe) {
        location.href = authUrl;
        return;
      }
      if (popup && !popup.closed) {
        popup.location.href = authUrl;
        try { popup.focus(); } catch { /* ignore */ }
      } else {
        // Fallback if browser blocked the popup: try opening directly in a new tab
        const tab = window.open(authUrl, '_blank', 'noopener');
        if (!tab) {
          this.authNote = `Popup blocked — allow popups for this page to sign in with ${label}, or use Email + Password below.`;
          this.authBusy = false;
          this.render();
          return;
        }
      }

      // Listen for BOTH instant postMessage (when window.opener survives) AND one-time ticket polling
      // (when itch.io SharedArrayBuffer / COOP severs window.opener cross-origin).
      const cloudOrigin = (() => { try { return new URL(this.cloud.base).origin; } catch { return ''; } })();
      const result = await new Promise<{ code: string; provider: OAuthProvider } | null>((resolve) => {
        let settled = false;
        let pollTimer = 0;
        const deadline = Date.now() + 180_000;
        const finish = (val: { code: string; provider: OAuthProvider } | null) => {
          if (settled) return;
          settled = true;
          window.removeEventListener('message', onMsg);
          clearInterval(pollTimer);
          resolve(val);
        };
        const onMsg = (ev: MessageEvent) => {
          if (cloudOrigin && ev.origin !== cloudOrigin) return;
          const d = ev.data as { type?: string; code?: string; provider?: string } | null;
          if (d?.type === 'og_auth' && typeof d.code === 'string' && d.code) {
            const p = (d.provider === 'google' || d.provider === 'github' || d.provider === 'discord') ? d.provider : provider;
            finish({ code: d.code, provider: p });
          }
        };
        window.addEventListener('message', onMsg);

        pollTimer = window.setInterval(() => {
          if (settled) return;
          if (Date.now() > deadline) { finish(null); return; }
          if (ticket) {
            void this.cloud.pollOAuthTicket(ticket).then((r) => {
              if (r.ready && r.code) {
                finish({ code: r.code, provider: r.provider ?? provider });
              }
            }).catch(() => { /* keep polling */ });
          } else if (popup && popup.closed) {
            finish(null);
          }
        }, 1500);
      });

      if (result && this.cloud.restore(result.code)) {
        this.cloud.oauthSignedInProvider = result.provider;
        await this.mp.refresh();
        this.authNote = `✓ Signed in with ${BRAND_NAME[result.provider]}.`;
        this.authBusy = false;
        this.gatePassed();
        this.render();
      } else {
        this.authNote = `${label} sign-in did not complete. Try again or sign in with Email + Password.`;
        this.authBusy = false;
        this.render();
      }
    } catch (e) {
      if (popup && !popup.closed) { try { popup.close(); } catch { /* ignore */ } }
      this.authNote = e instanceof Error ? e.message : `Could not start ${label} login.`;
      this.authBusy = false;
      this.render();
    }
  }

  // ---- shared by the Profile screen and the welcome gate ----------------------------------------------------------------
  private recoveryCardHtml() {
    const cardStyle = AUTH_CARD_STYLE;
    return this.recoveryCodes.length > 0 ? `<div style="${cardStyle};border-color:rgba(255,17,17,.55)">
      <div style="font-weight:700;color:#fbbf24;margin-bottom:4px">🛡 Save these 8 one-time recovery/backup codes somewhere safe — shown once!</div>
      <p class="dim small-note" style="margin:0 0 8px">Each code can recover your account or bypass 2FA once if you lose access to your authenticator.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(124px,1fr));gap:6px;margin-bottom:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">
        ${this.recoveryCodes.map((c) => `<code style="padding:5px 8px;border-radius:6px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);text-align:center;letter-spacing:.08em;user-select:all">${esc(c)}</code>`).join('')}
      </div>
      <div class="opts" style="gap:8px">
        <button class="small primary" data-act="auth-copy-codes">📋 Copy Codes</button>
        <button class="small" data-act="auth-dismiss-codes">Dismiss</button>
      </div>
    </div>` : '';
  }

  private auth2faCardHtml() {
    const cardStyle = AUTH_CARD_STYLE;
    return this.authNeeds2fa ? `<div style="${cardStyle};border-color:rgba(255,17,17,.45)">
      <div style="font-weight:700;margin-bottom:6px">🔐 Two-Factor Authentication Required</div>
      <div class="joinrow" style="flex-wrap:wrap;gap:6px">
        <input id="auth-totp" type="text" inputmode="numeric" maxlength="16" value="${esc(this.authTotp)}" placeholder="6-digit 2FA or backup code" autocomplete="one-time-code" style="max-width:210px" />
        <button class="primary" data-act="auth-login" ${this.authBusy ? 'disabled' : ''}>Verify 2FA &amp; Log In</button>
        <button class="small" data-act="auth-2fa-login-cancel" ${this.authBusy ? 'disabled' : ''}>Cancel</button>
      </div>
    </div>` : '';
  }

  private authForgotCardHtml() {
    const cardStyle = AUTH_CARD_STYLE;
    return this.authForgotOpen ? `<div style="${cardStyle}">
      <div style="font-weight:700;margin-bottom:4px">🔑 Reset Password</div>
      <p class="dim small-note" style="margin:0 0 8px">Request a reset code by email or use one of your saved 8-character recovery codes.</p>
      <div class="joinrow" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
        <input id="auth-reset-email" type="email" value="${esc(this.authResetEmail)}" placeholder="Account email address" autocomplete="email" />
        <button class="small" data-act="auth-forgot-send" ${this.authBusy ? 'disabled' : ''}>Send Reset Code</button>
      </div>
      <div class="joinrow" style="flex-wrap:wrap;gap:6px">
        <input id="auth-reset-code" type="text" value="${esc(this.authResetCode)}" placeholder="Reset or recovery code" autocomplete="one-time-code" spellcheck="false" />
        <input id="auth-reset-pass" type="password" value="${esc(this.authResetPass)}" placeholder="New password (8+ chars)" autocomplete="new-password" />
        <button class="primary" data-act="auth-reset-submit" ${this.authBusy ? 'disabled' : ''}>Reset Password &amp; Sign In</button>
        <button class="small" data-act="auth-forgot-toggle" ${this.authBusy ? 'disabled' : ''}>Cancel</button>
      </div>
    </div>` : '';
  }

  private profile() {
    const id = this.identity, f = id.friends, online = this.cloud.available;
    const mp = this.mp.profile;
    const draft = this.unameDraft ?? this.sel.name;
    const status = !online ? 'Saved on this device. The online service is not set up for this build, so the name cannot be reserved yet.'
      : id.claimed ? '✓ Reserved for you on the online service.' : id.note || 'Not confirmed by the online service yet.';
    const seen = (x: Friend) => (typeof x.seenAgo === 'number' ? `Offline · last seen ${agoText(x.seenAgo + Math.max(0, Date.now() - id.friendsAt))}` : 'Offline');
    const friend = (x: Friend) => `<div class="member">
        <span class="avatar"><i class="dot ${x.online ? 'on' : ''}"></i></span>
        <div class="mtext"><div class="mname"><b>${esc(x.username)}</b><span class="pill">Lv ${x.level}</span>${x.license ? `<span class="pill gold">${esc(x.license)} · DR ${x.dr ?? 1500}</span>` : ''}</div>
        <span class="dim">${x.online ? (x.party ? `Online · in party ${esc(x.party)}` : 'Online') : seen(x)}</span></div>
        ${x.party && !this.party ? `<button class="small primary" data-act="friend-join" data-v="${esc(x.party)}">Join</button>` : ''}
        <button class="small" data-act="friend-remove" data-v="${esc(x.username)}" title="Remove friend">✕</button>
      </div>`;
    const incoming = f.incoming.map((u) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(u)}</b></div><span class="dim">wants to be friends</span></div>
        <button class="small primary" data-act="friend-accept" data-v="${esc(u)}">Accept</button><button class="small" data-act="friend-remove" data-v="${esc(u)}">Decline</button></div>`).join('');
    const outgoing = f.outgoing.map((u) => `<div class="member"><div class="mtext"><div class="mname"><b>${esc(u)}</b></div><span class="dim">request sent</span></div>
        <button class="small" data-act="friend-remove" data-v="${esc(u)}">Cancel</button></div>`).join('');
    const oauthBtns = [
      this.oauthProviders.google ? `<button class="small og-oauth google" data-act="auth-oauth" data-v="google" ${this.authBusy ? 'disabled' : ''}>G · Continue with Google</button>` : '',
      this.oauthProviders.github ? `<button class="small og-oauth github" data-act="auth-oauth" data-v="github" ${this.authBusy ? 'disabled' : ''}>⌥ · Continue with GitHub</button>` : '',
      this.oauthProviders.discord ? `<button class="small og-oauth discord" data-act="auth-oauth" data-v="discord" ${this.authBusy ? 'disabled' : ''}>💬 · Continue with Discord</button>` : '',
    ].filter(Boolean).join('');
    const cardStyle = 'margin-top:10px;padding:12px 14px;border-radius:10px;background:#0A0A0A;border:1px solid rgba(255,255,255,.14)';
    const recoveryCodesCard = this.recoveryCardHtml();
    let securityPanel = '';
    if (mp?.email) {
      if (this.totpSetup) {
        let qrMarkup = '';
        try { qrMarkup = renderQrSvg(this.totpSetup.otpauthUri, 168); } catch { qrMarkup = ''; }
        securityPanel = `<div style="${cardStyle}">
          <div style="font-weight:700;margin-bottom:6px">🔐 Set Up Authenticator 2FA</div>
          <p class="dim small-note" style="margin:0 0 10px">Scan this QR code with Google Authenticator, Authy, Bitwarden, or 1Password (generated 100% locally in your browser — your secret never leaves your device).</p>
          <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:10px">
            ${qrMarkup ? `<div style="padding:6px;background:#fff;border-radius:8px;line-height:0;flex:0 0 auto">${qrMarkup}</div>` : ''}
            <div style="min-width:200px;flex:1">
              <div class="dim small-note" style="margin-bottom:4px">Manual setup key (Base32):</div>
              <code style="display:block;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;user-select:all;margin-bottom:8px">${esc(this.totpSetup.secret)}</code>
              <div class="joinrow" style="flex-wrap:wrap;gap:6px">
                <input id="auth-2fa-verify" type="text" inputmode="numeric" maxlength="10" value="${esc(this.totpVerifyCode)}" placeholder="6-digit code" autocomplete="one-time-code" style="max-width:150px" />
                <button class="small primary" data-act="auth-2fa-enable" ${this.authBusy ? 'disabled' : ''}>Verify &amp; Enable 2FA</button>
                <button class="small" data-act="auth-2fa-cancel" ${this.authBusy ? 'disabled' : ''}>Cancel</button>
              </div>
            </div>
          </div>
        </div>`;
      } else if (this.totpDisableOpen) {
        securityPanel = `<div style="${cardStyle}">
          <div style="font-weight:700;margin-bottom:6px">🔓 Disable Authenticator 2FA</div>
          <p class="dim small-note" style="margin:0 0 8px">Enter your current 6-digit authenticator code (or a backup code) to turn off 2FA.</p>
          <div class="joinrow" style="flex-wrap:wrap;gap:6px">
            <input id="auth-2fa-disable-code" type="text" inputmode="numeric" maxlength="16" value="${esc(this.totpDisableCode)}" placeholder="6-digit or backup code" autocomplete="one-time-code" style="max-width:190px" />
            <button class="small primary" data-act="auth-2fa-disable-submit" ${this.authBusy ? 'disabled' : ''}>Confirm Disable 2FA</button>
            <button class="small" data-act="auth-2fa-disable-toggle" ${this.authBusy ? 'disabled' : ''}>Cancel</button>
          </div>
        </div>`;
      } else if (this.pwPanelOpen) {
        securityPanel = `<div style="${cardStyle}">
          <div style="font-weight:700;margin-bottom:6px">🔑 ${mp.hasPassword ? 'Change Password' : 'Set Account Password'}</div>
          <div class="joinrow" style="flex-wrap:wrap;gap:6px">
            ${mp.hasPassword ? `<input id="auth-pw-cur" type="password" value="${esc(this.pwCur)}" placeholder="Current password" autocomplete="current-password" />` : ''}
            <input id="auth-pw-new" type="password" value="${esc(this.pwNew)}" placeholder="New password (8+ chars)" autocomplete="new-password" />
            <button class="small primary" data-act="auth-pw-submit" ${this.authBusy ? 'disabled' : ''}>Update Password</button>
            <button class="small" data-act="auth-pw-toggle" ${this.authBusy ? 'disabled' : ''}>Cancel</button>
          </div>
        </div>`;
      } else if (this.delPanelOpen) {
        securityPanel = `<div style="${cardStyle};border-color:rgba(255,17,17,.6)">
          <div style="font-weight:700;color:#ff4d4d;margin-bottom:4px">⚠ Permanently Delete Account</div>
          <p class="dim small-note" style="margin:0 0 8px">This permanently erases your Open Grid cloud profile, cars, Driver Rating, Safety Rating, friends &amp; login credentials. This cannot be undone.</p>
          <div class="joinrow" style="flex-wrap:wrap;gap:6px">
            ${mp.hasPassword ? `<input id="auth-del-pass" type="password" value="${esc(this.delPass)}" placeholder="Current password" autocomplete="current-password" />` : ''}
            <input id="auth-del-confirm" type="text" value="${esc(this.delConfirm)}" placeholder="Type DELETE to confirm" autocomplete="off" spellcheck="false" />
            <button class="small" style="background:#FF1111;border-color:#FF1111;color:#fff;font-weight:700" data-act="auth-delete-submit" ${this.authBusy ? 'disabled' : ''}>Permanently Delete Account</button>
            <button class="small" data-act="auth-delete-toggle" ${this.authBusy ? 'disabled' : ''}>Cancel</button>
          </div>
        </div>`;
      }
    }
    const auth2faChallenge = this.auth2faCardHtml();
    const authForgotCard = this.authForgotCardHtml();
    const authBlock = !online ? '<div class="dim note">Email login activates automatically once connected to the Open Grid cloud backend.</div>'
      : mp?.email ? `<div class="opts" style="flex-wrap:wrap;gap:8px">
          <span class="pill gold">✓ SIGNED IN · ${esc(mp.email)}</span>
          <span class="pill">CLASS ${esc(mp.license ?? 'R')} · DR ${Math.round(mp.dr ?? 1500)} · SR ${(mp.sr ?? 2.5).toFixed(2)}</span>
          <span class="pill ${mp.totpEnabled ? 'gold' : ''}">${mp.totpEnabled ? '✓ 2FA ON' : '2FA OFF'}</span>
          <button class="small" data-act="auth-logout" ${this.authBusy ? 'disabled' : ''}>Sign Out</button>
        </div>
        ${recoveryCodesCard}
        <h3 style="margin-top:14px">🛡 Account Security</h3>
        <div class="opts" style="flex-wrap:wrap;gap:6px">
          ${mp.totpEnabled
            ? `<button class="small" data-act="auth-2fa-disable-toggle" ${this.authBusy ? 'disabled' : ''}>🔓 Disable 2FA</button>`
            : `<button class="small" data-act="auth-2fa-setup" ${this.authBusy ? 'disabled' : ''}>🔐 Enable 2FA (Authenticator)</button>`}
          <button class="small" data-act="auth-pw-toggle" ${this.authBusy ? 'disabled' : ''}>🔑 ${mp.hasPassword ? 'Change Password' : 'Set Password'}</button>
          <button class="small" data-act="auth-recovery-regen" ${this.authBusy ? 'disabled' : ''}>🛡 New Recovery Codes</button>
          <button class="small" style="border-color:rgba(255,17,17,.5);color:#ff6b6b" data-act="auth-delete-toggle" ${this.authBusy ? 'disabled' : ''}>⚠ Delete Account</button>
        </div>
        ${securityPanel}`
      : `<p class="dim small-note">Save your career, cars, Driver Rating, License &amp; Friends across browsers and UE 5.8 (upgrades your current guest account in-place with zero progress lost).</p>
        ${oauthBtns ? `<div class="chips" style="margin:8px 0 10px;gap:8px">${oauthBtns}</div>` : ''}
        <div class="joinrow" style="flex-wrap:wrap;gap:6px">
          <input id="auth-email" type="email" value="${esc(this.authEmail)}" placeholder="Email address" autocomplete="email" />
          <input id="auth-pass" type="password" value="${esc(this.authPass)}" placeholder="Password (8+ chars)" autocomplete="current-password" />
          <button class="primary" data-act="auth-register" ${this.authBusy ? 'disabled' : ''}>Save / Sign Up</button>
          <button class="small" data-act="auth-login" ${this.authBusy ? 'disabled' : ''}>Log In</button>
          <button class="small" style="opacity:.8" data-act="auth-forgot-toggle" ${this.authBusy ? 'disabled' : ''}>Forgot password?</button>
        </div>
        ${auth2faChallenge}
        ${authForgotCard}`;
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
      <div class="lobby-head"><button data-act="profile-back" class="back-btn">← Back</button><div><div class="kicker">OPEN GRID DRIVER PROFILE</div><h2>${esc(this.sel.name)}</h2></div></div>
      <h3>🔐 Open Grid Account Login</h3>
      ${authBlock}
      ${this.authNote ? `<div class="pnote ${this.authNote.startsWith('✓') ? '' : 'bad'}">${esc(this.authNote)}</div>` : ''}
      <h3>♥ Support Open Grid (Optional)</h3>
      <p class="dim small-note">Open Grid is a free, open-source, ad-free hobby project — all cars, cities, online splits, championships, hotlaps &amp; private P2P lobbies are 100% free for everyone. Optional Patreon support helps cover domain &amp; hosting and gets you a supporter role in the Discord.</p>
      <div class="opts" style="flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <span class="pill gold">✓ 100% Free Forever</span>
        <a class="chip on" style="text-decoration:none;color:#fff" href="https://www.patreon.com/Open_Grid" target="_blank" rel="noopener noreferrer">♥ Support on Patreon</a>
        <a class="chip" style="text-decoration:none;color:#eef2ff" href="https://discord.gg/RhKdTvAdf" target="_blank" rel="noopener noreferrer">💬 Discord</a>
        <a class="chip" style="text-decoration:none;color:#eef2ff" href="https://github.com/Konstantinos-Chatzistavrou/Open-Grid" target="_blank" rel="noopener noreferrer">★ GitHub</a>
        <a class="chip" style="text-decoration:none;color:#eef2ff" href="https://youtube.com/@open_grid_motorsport" target="_blank" rel="noopener noreferrer">▶ YouTube</a>
      </div>
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
    if (t.id === 'auth-email') this.authEmail = t.value;
    if (t.id === 'auth-pass') this.authPass = t.value;
    if (t.id === 'auth-totp') this.authTotp = t.value;
    if (t.id === 'auth-reset-email') this.authResetEmail = t.value;
    if (t.id === 'auth-reset-code') this.authResetCode = t.value;
    if (t.id === 'auth-reset-pass') this.authResetPass = t.value;
    if (t.id === 'auth-2fa-verify') this.totpVerifyCode = t.value;
    if (t.id === 'auth-2fa-disable-code') this.totpDisableCode = t.value;
    if (t.id === 'auth-pw-cur') this.pwCur = t.value;
    if (t.id === 'auth-pw-new') this.pwNew = t.value;
    if (t.id === 'auth-del-pass') this.delPass = t.value;
    if (t.id === 'auth-del-confirm') this.delConfirm = t.value;
    if (t.id === 'team-name') this.teamNameDraft = t.value;
    if (t.id === 'team-tag') this.teamTagDraft = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (t.id === 'lg-name') this.leagueNameDraft = t.value;
    if (t.id === 'lg-desc') this.leagueDescDraft = t.value;
    if (t.id === 'lg-pass') this.leaguePassDraft = t.value;
    if (t.id === 'lg-jcode') this.leagueJoinCode = cleanCode(t.value);
    if (t.id === 'lg-jpass') this.leagueJoinPass = t.value;
    if (t.id === 'ai-diff-slider') {
      const pct = Math.max(60, Math.min(110, Math.round(Number(t.value) || 88)));
      this.sel.aiDiff = pct;
      this.sel.aiAdaptive = false;
      const valEl = document.getElementById('ai-diff-val');
      if (valEl) {
        valEl.textContent = `${pct}%`;
        valEl.classList.remove('gold');
      }
      const descEl = document.getElementById('ai-diff-desc');
      if (descEl) {
        const dp = difficultyProfile(pct);
        descEl.textContent = `Grip ${Math.round(dp.gripUtil * 100)}% · Reaction ${Math.round(dp.reactionSec * 1000)} ms · Optimal Line ${Math.round(dp.apexAccuracy * 100)}%`;
      }
      this.hooks.onAiDifficulty?.(this.sel.aiDiff, this.sel.aiAdaptive);
      return;
    }
    if (t.type === 'range') this.ctl?.slide(t);
  }
  private change(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.id === 'custom') { this.save(); this.render(); }
    if (t.id === 'ai-diff-slider') {
      const pct = Math.max(60, Math.min(110, Math.round(Number(t.value) || 88)));
      this.sel.aiDiff = pct;
      this.sel.aiAdaptive = false;
      this.save();
      this.hooks.onAiDifficulty?.(this.sel.aiDiff, this.sel.aiAdaptive);
      this.render();
    }
  }
}
