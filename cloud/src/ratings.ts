// Apache-2.0 — OpenGrid Competitive Rating, License, Fault-Aware Safety, SOF Split Matchmaking & Championship Engine.
// Mirrors core/src/esports.cpp (Glicko-2 MMR, CPI, Bad-Sport Quarantine) and extends it with iRacing/LMU-grade
// License Ladder (R -> D -> C -> B -> A -> PRO), Fault-Aware Victim Protection (0x), Restorative Protests,
// Balanced SOF Splits, and Scheduled Official Series Calendars. Pure TypeScript (zero Worker-only globals).

export type LicenseClass = 'R' | 'D' | 'C' | 'B' | 'A' | 'PRO';
export type DriverGrade = 'E' | 'D' | 'C' | 'B' | 'A' | 'A+' | 'S';
export type SubTier = 'none' | 'trial' | 'pro' | 'team_pro';

export const LICENSE_ORDER: readonly LicenseClass[] = ['R', 'D', 'C', 'B', 'A', 'PRO'] as const;
export const TRIAL_DURATION_MS = 7 * 24 * 3600 * 1000; // 7-day ad-free Rookie Online Trial for new accounts

export function licenseRank(l: string): number {
  const idx = LICENSE_ORDER.indexOf(l as LicenseClass);
  return idx >= 0 ? idx : 0;
}

export function driverGradeOf(dr: number): DriverGrade {
  if (dr >= 2700) return 'S';
  if (dr >= 2350) return 'A+';
  if (dr >= 2000) return 'A';
  if (dr >= 1650) return 'B';
  if (dr >= 1350) return 'C';
  if (dr >= 1100) return 'D';
  return 'E';
}

export function isSubscriptionActive(tier: string | undefined, expiresAt: number | undefined, now = Date.now()): boolean {
  if (tier === 'pro' || tier === 'team_pro') return !expiresAt || expiresAt > now;
  if (tier === 'trial') return !!expiresAt && expiresAt > now;
  return false;
}

export function currentSeasonId(now = Date.now()): string {
  const d = new Date(now);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-S${q}`;
}

export function currentIsoWeek(now = Date.now()): string {
  const d = new Date(now);
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const wk = Math.ceil(((d.getTime() - jan1) / 86_400_000 + new Date(jan1).getUTCDay() + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// ---- 1. Glicko-2 / Pairwise SOF Driver Rating ----------------------------------------------------

export interface RatingDriver {
  id: string;
  dr: number;
  rd: number;
  finished: boolean;
  dnf: boolean;
}

export interface RatingUpdate {
  id: string;
  drBefore: number;
  drAfter: number;
  drDelta: number;
  rdAfter: number;
}

/** Strength of Field (iRacing exponential-weighted average DR so high-DR aliens lift top-split SOF properly). */
export function computeSof(drs: readonly number[]): number {
  if (!drs.length) return 1500;
  const scale = 1600 / Math.log(2);
  let sumExp = 0;
  for (const r of drs) sumExp += Math.exp(-Math.max(600, Math.min(4000, r)) / scale);
  const avg = sumExp / drs.length;
  return Math.round(Math.max(800, Math.min(3500, -scale * Math.log(Math.max(1e-9, avg)))));
}

/**
 * Pairwise Glicko-2 skill rating update across finishers in exact P1..Pn order (matches core/src/esports.cpp).
 * Zero-sum across equal-RD drivers, uncertainty-weighted so established drivers stay stable while rookies converge fast.
 */
export function updateDriverRatings(finishersInOrder: readonly RatingDriver[]): { sof: number; updates: Map<string, RatingUpdate> } {
  const n = finishersInOrder.length;
  const sof = computeSof(finishersInOrder.map((d) => d.dr));
  const updates = new Map<string, RatingUpdate>();
  if (n < 2) {
    for (const d of finishersInOrder) {
      updates.set(d.id, { id: d.id, drBefore: d.dr, drAfter: d.dr, drDelta: 0, rdAfter: d.rd });
    }
    return { sof, updates };
  }

  for (let i = 0; i < n; i++) {
    const me = finishersInOrder[i];
    const kBase = Math.max(14, Math.min(64, 16 + (me.rd / 180) * 32));
    let expectedSum = 0;
    let actualSum = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const opp = finishersInOrder[j];
      const gOpp = 1 / Math.sqrt(1 + (3 * Math.pow(opp.rd / 400, 2)) / (Math.PI * Math.PI));
      const exp = 1 / (1 + Math.pow(10, (gOpp * (opp.dr - me.dr)) / 400));
      expectedSum += exp;
      actualSum += i < j ? 1.0 : 0.0;
    }
    const normDelta = (actualSum - expectedSum) / (n - 1);
    const rawDelta = kBase * normDelta * Math.sqrt(Math.min(n, 20) / 6);
    const drAfter = Math.round(Math.max(800, Math.min(3500, me.dr + rawDelta)) * 10) / 10;
    const rdAfter = Math.round(Math.max(45, me.rd * 0.94) * 10) / 10;
    updates.set(me.id, {
      id: me.id,
      drBefore: me.dr,
      drAfter,
      drDelta: Math.round((drAfter - me.dr) * 10) / 10,
      rdAfter,
    });
  }
  return { sof, updates };
}

// ---- 2. Fault-Aware Safety Rating (0.00..4.99), License Ladder & Bad-Sport Quarantine ------------

export interface SafetyInput {
  sr: number;               // 0.00..4.99
  license: LicenseClass;
  mprRaces: number;
  rollingCpi: number;
  badSport: boolean;
  cleanStreak: number;
  cornersCompleted: number;
  offTrack1x: number;       // 1x each
  lossControl2x: number;    // 2x each
  atFaultContact4x: number; // 4x each (at-fault collisions only!)
  victimShield0x: number;   // 0x each (blameless victim rear-ends / unsafe rejoins -> NO SR PENALTY!)
  isOfficialMprEligible: boolean;
}

export interface SafetyResult {
  srBefore: number;
  srAfter: number;
  srDelta: number;
  licenseBefore: LicenseClass;
  licenseAfter: LicenseClass;
  promoted: boolean;
  demoted: boolean;
  mprRacesAfter: number;
  rollingCpiAfter: number;
  badSportAfter: boolean;
  cleanStreakAfter: number;
  incidentPoints: number;
}

/**
 * Fault-aware Safety Rating & License progression:
 * - Innocent victims (victimShield0x) suffer ZERO incident points (beats iRacing/LMU's no-fault 4x!).
 * - Rolling Corners-Per-Incident (CPI) smoothly scales SR 0.00..4.99; clean races build SR & lift quarantine.
 * - Fast-Track Promotion: SR >= 4.00 and MPR >= 4 races at current license -> advances R->D->C->B->A->PRO (SR resets to 3.40).
 * - Demotion: SR < 1.00 (above Rookie) -> steps down 1 license class (SR resets to 2.20).
 * - Bad-Sport Quarantine: SR < 1.25 or rolling CPI < 6.0 -> isolated from clean splits until 15 consecutive clean corners!
 */
export function evaluateSafetyAndLicense(inData: SafetyInput): SafetyResult {
  const corners = Math.max(1, Math.round(inData.cornersCompleted));
  const incPts = Math.max(0, inData.offTrack1x * 1 + inData.lossControl2x * 2 + inData.atFaultContact4x * 4);

  // Rolling CPI blend (exponential window over recent ~160 corners, matching iRacing/OpenGrid philosophy)
  const raceCpi = incPts === 0 ? Math.min(80, corners * 1.5) : corners / incPts;
  const blend = Math.min(0.45, corners / 140);
  const rollingCpiAfter = Math.round(Math.max(1, Math.min(90, inData.rollingCpi * (1 - blend) + raceCpi * blend)) * 100) / 100;

  // Target SR rises logarithmically with CPI (higher licenses expect cleaner CPI!)
  const licIdx = licenseRank(inData.license);
  const cpiFor30 = 14 + licIdx * 4.5; // R: 14 CPI -> 3.00 SR; A/PRO: 32..36 CPI -> 3.00 SR
  const cleanGain = incPts === 0 ? Math.min(0.42, 0.09 + corners * 0.008) : 0;
  const perfShift = ((raceCpi - cpiFor30) / Math.max(10, cpiFor30)) * 0.28;
  const incPenalty = incPts * (0.045 + licIdx * 0.006);
  const rawDelta = incPts === 0 ? Math.max(0.08, cleanGain) : Math.max(-0.85, Math.min(0.20, perfShift - incPenalty * 0.55));

  let srAfter = Math.max(0.0, Math.min(4.99, inData.sr + rawDelta));
  let licenseAfter: LicenseClass = inData.license;
  let mprRacesAfter = inData.mprRaces + (inData.isOfficialMprEligible && incPts <= 12 ? 1 : 0);
  let promoted = false;
  let demoted = false;

  // Fast-track promotion (R -> D -> C -> B -> A -> PRO)
  const nextIdx = licIdx + 1;
  if (nextIdx < LICENSE_ORDER.length && srAfter >= 4.0 && mprRacesAfter >= 4) {
    licenseAfter = LICENSE_ORDER[nextIdx];
    srAfter = 3.4;
    mprRacesAfter = 0;
    promoted = true;
  } else if (licIdx > 0 && srAfter < 1.0) {
    licenseAfter = LICENSE_ORDER[licIdx - 1];
    srAfter = 2.2;
    mprRacesAfter = 0;
    demoted = true;
  }

  // Bad-Sport Rammer Quarantine: 15 consecutive clean corners lifts quarantine; severe wrecking triggers it
  let cleanStreakAfter = incPts === 0 ? inData.cleanStreak + corners : 0;
  let badSportAfter = inData.badSport;
  if (srAfter < 1.25 || (incPts >= 12 && rollingCpiAfter < 6.0)) {
    badSportAfter = true;
    cleanStreakAfter = 0;
  } else if (badSportAfter && cleanStreakAfter >= 15 && srAfter >= 1.5) {
    badSportAfter = false;
  }

  srAfter = Math.round(srAfter * 100) / 100;
  return {
    srBefore: Math.round(inData.sr * 100) / 100,
    srAfter,
    srDelta: Math.round((srAfter - inData.sr) * 100) / 100,
    licenseBefore: inData.license,
    licenseAfter,
    promoted,
    demoted,
    mprRacesAfter,
    rollingCpiAfter,
    badSportAfter,
    cleanStreakAfter,
    incidentPoints: incPts,
  };
}

// ---- 3. Scheduled Official Series Calendar & Balanced SOF Split Seeding --------------------------

export interface OfficialSeriesSpec {
  id: string;
  title: string;
  subtitle: string;
  minLicense: LicenseClass;
  intervalMin: number;     // race start cadence (20m, 45m, 60m, 120m)
  maxPerSplit: number;
  minGrid: number;
  laps: number;
  route: 'nyc' | 'city';
  realism: boolean;
  fixedSetup: boolean;
  bopEnabled: boolean;
  pointsMul: number;       // 1.0 normal, 2.0 Endurance Special
  teamEligible: boolean;
  championshipEligible: boolean;
  maxWeeklyAttempts: number; // LMU-style limited championship scoring attempts per week (0 = unlimited)
}

export const OFFICIAL_SERIES: readonly OfficialSeriesSpec[] = [
  {
    id: 'rookie_sprint',
    title: 'OpenGrid Rookie GT Sprint',
    subtitle: 'Fixed Setup · Fast 20-min cadence · Build SR & unlock Class D',
    minLicense: 'R',
    intervalMin: 20,
    maxPerSplit: 12,
    minGrid: 6,
    laps: 3,
    route: 'nyc',
    realism: true,
    fixedSetup: true,
    bopEnabled: true,
    pointsMul: 1.0,
    teamEligible: false,
    championshipEligible: true,
    maxWeeklyAttempts: 0,
  },
  {
    id: 'gt3_championship',
    title: 'OpenGrid GT3 World Championship',
    subtitle: 'BoP Equalized · 45-min cadence · SOF Splits · Car-Locked Season',
    minLicense: 'D',
    intervalMin: 45,
    maxPerSplit: 16,
    minGrid: 6,
    laps: 5,
    route: 'nyc',
    realism: true,
    fixedSetup: false,
    bopEnabled: true,
    pointsMul: 1.25,
    teamEligible: false,
    championshipEligible: true,
    maxWeeklyAttempts: 4,
  },
  {
    id: 'hypercar_pro',
    title: 'OpenGrid Hypercar Pro Series',
    subtitle: 'Open Setup · Full Damage · High-SOF Class C+ Competition',
    minLicense: 'C',
    intervalMin: 60,
    maxPerSplit: 16,
    minGrid: 6,
    laps: 6,
    route: 'nyc',
    realism: true,
    fixedSetup: false,
    bopEnabled: true,
    pointsMul: 1.5,
    teamEligible: false,
    championshipEligible: true,
    maxWeeklyAttempts: 3,
  },
  {
    id: 'endurance_special',
    title: 'OpenGrid Multiclass Endurance',
    subtitle: '2x Championship Points · Team Eligible · Driver-Swap Ready · Class B+',
    minLicense: 'B',
    intervalMin: 120,
    maxPerSplit: 20,
    minGrid: 6,
    laps: 10,
    route: 'nyc',
    realism: true,
    fixedSetup: false,
    bopEnabled: true,
    pointsMul: 2.0,
    teamEligible: true,
    championshipEligible: true,
    maxWeeklyAttempts: 2,
  },
] as const;

export function getSeriesById(id: string): OfficialSeriesSpec | undefined {
  return OFFICIAL_SERIES.find((s) => s.id === id);
}

/** Deterministic UTC slot boundary for a series (e.g. 'gt3_championship:2026-11-26T21:00Z'). */
export function nextEventForSeries(series: OfficialSeriesSpec, nowMs = Date.now()) {
  const stepMs = series.intervalMin * 60_000;
  const nextStartMs = Math.ceil(nowMs / stepMs) * stepMs;
  const iso = new Date(nextStartMs).toISOString().slice(0, 16) + 'Z';
  return {
    eventKey: `${series.id}:${iso}`,
    seriesId: series.id,
    startsAt: nextStartMs,
    startsInSec: Math.max(0, Math.round((nextStartMs - nowMs) / 1000)),
    registrationOpen: nextStartMs - nowMs <= stepMs,
  };
}

export interface SplitRegistrant {
  account: string;
  dr: number;
  sr: number;
  badSport: boolean;
}

export interface SeededSplit {
  splitNo: number; // 1 = top SOF split, 2..N; -1 = quarantined bad-sport split
  sof: number;
  badSportSplit: boolean;
  partyCode: string;
  accounts: string[];
}

/**
 * Balanced SOF Split Seeding (iRacing + OpenGrid Bad-Sport Isolation):
 * - Clean drivers sorted strictly by DR descending and divided into evenly sized splits (e.g. 22 -> 11 + 11).
 * - Quarantined Bad-Sport rammers NEVER enter clean splits; they are grouped into splitNo = -1.
 */
export function seedBalancedSplits(
  eventKey: string,
  registrants: readonly SplitRegistrant[],
  maxPerSplit: number,
): SeededSplit[] {
  const clean = registrants.filter((r) => !r.badSport).slice().sort((a, b) => b.dr - a.dr || b.sr - a.sr || a.account.localeCompare(b.account));
  const rammers = registrants.filter((r) => r.badSport).slice().sort((a, b) => b.dr - a.dr || a.account.localeCompare(b.account));

  // Deterministic 4-char event hash for unique, valid 8-char room codes (A-Z0-9)
  let h = 2166136261;
  for (let i = 0; i < eventKey.length; i++) {
    h ^= eventKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const tag = (h >>> 0).toString(36).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padStart(4, '0').slice(0, 4);

  const out: SeededSplit[] = [];
  if (clean.length > 0) {
    const nSplits = Math.max(1, Math.ceil(clean.length / Math.max(2, maxPerSplit)));
    const baseSize = Math.floor(clean.length / nSplits);
    const extra = clean.length % nSplits;
    let cursor = 0;
    for (let s = 0; s < nSplits; s++) {
      const sz = baseSize + (s < extra ? 1 : 0);
      const slice = clean.slice(cursor, cursor + sz);
      cursor += sz;
      out.push({
        splitNo: s + 1,
        sof: computeSof(slice.map((r) => r.dr)),
        badSportSplit: false,
        partyCode: `OG${tag}S${s + 1}`.slice(0, 10),
        accounts: slice.map((r) => r.account),
      });
    }
  }
  if (rammers.length > 0) {
    out.push({
      splitNo: -1,
      sof: computeSof(rammers.map((r) => r.dr)),
      badSportSplit: true,
      partyCode: `OG${tag}BQ`.slice(0, 10),
      accounts: rammers.map((r) => r.account),
    });
  }
  return out;
}

// ---- 4. SOF-Weighted Championship Points (iRacing + LMU Drop-Week Rules) -------------------------

/**
 * Computes official championship points for finishing `pos` (1..fieldSize) in a split of Strength of Field `sof`.
 * Winner of a 1500 SOF split gets ~94 pts; winner of a 3000 SOF Split 1 gets ~188 pts; scaled by series `pointsMul`.
 */
export function calcChampionshipPoints(pos: number, fieldSize: number, sof: number, pointsMul = 1.0): number {
  if (pos < 1 || fieldSize < 2 || pos > fieldSize) return 0;
  const maxPts = (sof / 16) * pointsMul;
  const frac = (fieldSize - pos) / (fieldSize - 1);
  return Math.round(maxPts * (0.15 + 0.85 * Math.pow(frac, 1.15)) * 10) / 10;
}

/** Keeps the best `keepCount` (default 8 of 12 weeks = 4 drop weeks!) round scores for seasonal standings. */
export function applyDropWeeks(roundScores: readonly number[], keepCount = 8): { total: number; kept: number[] } {
  const sorted = roundScores.slice().sort((a, b) => b - a);
  const kept = sorted.slice(0, keepCount);
  const total = Math.round(kept.reduce((s, x) => s + x, 0) * 10) / 10;
  return { total, kept };
}

// ---- 5. Restorative Protest Refund Calculation (OpenGrid Moat vs iRacing!) -----------------------

/**
 * When a steward upholds a protest (intentional wreck / ramming / unsafe rejoin):
 * - Innocent victim receives 100% restoration of any lost DR and lost SR from that race!
 * - Offender receives a strike, heavy SR penalty (-0.75 SR), and Bad-Sport Quarantine on intentional wreck/ramming.
 */
export function computeRestorativeVerdict(
  victimDrBefore: number,
  victimDrAfter: number,
  victimSrBefore: number,
  victimSrAfter: number,
  incidentType: string,
) {
  const drRefund = Math.round(Math.max(0, victimDrBefore - victimDrAfter) * 10) / 10;
  const srRefund = Math.round(Math.max(0, victimSrBefore - victimSrAfter) * 100) / 100;
  const severe = incidentType === 'intentional_wreck' || incidentType === 'ramming';
  return {
    drRefund,
    srRefund,
    offenderSrPenalty: severe ? 0.75 : 0.35,
    offenderQuarantine: severe,
    offenderStrike: severe,
  };
}
