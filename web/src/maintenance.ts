// Persistent Multiplayer Damage, Tow Truck Fees, Pre-Race Insurance & Moderation (OpenGrid).
// - Structural crash damage from multiplayer/race events persists per car until repaired in the Garage,
//   discouraging griefing and ramming.
// - Totaling a car incurs a Tow Truck Fee deducted from race winnings (or billed to return to the Garage).
// - Optional Pre-Race Insurance cuts repair & tow costs by 50% in exchange for a small upfront premium.
// - Automated hate-speech / slur guard for custom usernames & license plates + in-game Player Report helper.
import type { Cloud } from './cloud';

export interface CarCondition {
  /** Persistent structural damage 0 (mint) .. 1 (totaled). */
  damage: number;
  /** True when the car was totaled and requires tow + full rebuild. */
  totaled: boolean;
  /** Accumulated odometer in km (used by Night Runners maintenance loop). */
  km: number;
}

export interface MaintenanceStore {
  cars: Record<string, CarCondition>;
  /** Whether the player has pre-race Insurance toggled ON for their next race. */
  insured: boolean;
  /** Local audit log of submitted moderation reports (fallback when cloud is offline). */
  reports: { at: number; raceId: string; player: string; reason: string }[];
}

export const INSURANCE_PREMIUM_XP = 75;
export const INSURANCE_PREMIUM_CR = 350;
export const TOW_TRUCK_BASE_XP = 250;
export const TOW_TRUCK_BASE_CR = 1200;
export const MAX_REPAIR_BASE_XP = 420;
export const MAX_REPAIR_BASE_CR = 2400;

const MAINT_KEY = 'nr.maint.v1';

export function loadMaintenance(): MaintenanceStore {
  const def: MaintenanceStore = { cars: {}, insured: false, reports: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(MAINT_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (raw.cars && typeof raw.cars === 'object') def.cars = raw.cars;
      if (typeof raw.insured === 'boolean') def.insured = raw.insured;
      if (Array.isArray(raw.reports)) def.reports = raw.reports.slice(-50);
    }
  } catch { /* storage blocked */ }
  return def;
}

export function saveMaintenance(m: MaintenanceStore) {
  try { localStorage.setItem(MAINT_KEY, JSON.stringify(m)); } catch { /* storage blocked */ }
}

export function conditionOf(m: MaintenanceStore, carId: string): CarCondition {
  return (m.cars[carId] ??= { damage: 0, totaled: false, km: 0 });
}

/** Calculate repair cost (XP / Credits) for a car's persistent damage (50% cheaper when insured). */
export function repairCostOf(cond: CarCondition, insured: boolean): { xp: number; cr: number; pct: number } {
  const d = Math.max(0, Math.min(1, cond.damage));
  if (d < 0.03 && !cond.totaled) return { xp: 0, cr: 0, pct: 0 };
  const mul = insured ? 0.5 : 1.0;
  const eff = cond.totaled ? 1.0 : d;
  return {
    xp: Math.round(MAX_REPAIR_BASE_XP * eff * mul),
    cr: Math.round(MAX_REPAIR_BASE_CR * eff * mul),
    pct: Math.round(eff * 100),
  };
}

/** Calculate Tow Truck Fee when a car is totaled in a race/multiplayer event (50% cheaper when insured). */
export function towFeeOf(totaled: boolean, insured: boolean): { xp: number; cr: number } {
  if (!totaled) return { xp: 0, cr: 0 };
  const mul = insured ? 0.5 : 1.0;
  return {
    xp: Math.round(TOW_TRUCK_BASE_XP * mul),
    cr: Math.round(TOW_TRUCK_BASE_CR * mul),
  };
}

/** Save post-race damage onto the car (persistent in multiplayer & race events to discourage griefing). */
export function recordRaceDamage(m: MaintenanceStore, carId: string, severity: number, totaled: boolean) {
  const c = conditionOf(m, carId);
  const clamped = Math.max(0, Math.min(1, severity));
  c.damage = Math.max(c.damage, totaled ? 1.0 : clamped);
  if (totaled) c.totaled = true;
  saveMaintenance(m);
}

/** Repair a car back to 100% mint condition in the Garage. */
export function repairCarCondition(m: MaintenanceStore, carId: string) {
  const c = conditionOf(m, carId);
  c.damage = 0;
  c.totaled = false;
  saveMaintenance(m);
}

/**
 * Lightweight client-side hate-speech / slur guard for custom usernames and license plates.
 * Complements server-side moderation and the player-report queue.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\bn[i1!|]gg[ae3r]+/i,
  /\bf[a@4]gg?[o0]t/i,
  /\bk[i1!]ke\b/i,
  /\bh[i1!]tl[e3]r/i,
  /\bn[a@4]z[i1!]/i,
  /\bch[i1!]nk\b/i,
  /\bsp[i1!]c\b/i,
  /\btr[a@4]nn[yi1]/i,
  /\br[e3]t[a@4]rd/i,
  /\bkkk\b/i,
];

export function moderationError(text: string): string | null {
  const clean = text.replace(/[\s_.-]+/g, '');
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(text) || re.test(clean)) {
      return 'Blocked by community moderation filter (hate speech / slurs not allowed on plates or names).';
    }
  }
  return null;
}

export type ReportCategory = 'hate_livery_plate' | 'griefing_ramming' | 'cheating';

export const REPORT_LABELS: Record<ReportCategory, string> = {
  hate_livery_plate: 'Hate Speech Livery / Plate',
  griefing_ramming: 'Intentional Ramming / Griefing',
  cheating: 'Speed / Physics Cheating',
};

/** Submit a moderation report to the cloud backend (with local audit fallback when offline). */
export async function submitModerationReport(
  cloud: Cloud,
  m: MaintenanceStore,
  raceId: string,
  player: string,
  category: ReportCategory,
): Promise<{ sent: boolean; message: string }> {
  const reason = REPORT_LABELS[category];
  m.reports.push({ at: Date.now(), raceId, player, reason });
  if (m.reports.length > 50) m.reports.shift();
  saveMaintenance(m);
  if (cloud.available) {
    try {
      await cloud.report(raceId, player, `${category}: ${reason}`);
      return { sent: true, message: `Reported ${player} (${reason}) to moderation queue.` };
    } catch { /* fall through to local queue */ }
  }
  return { sent: false, message: `Logged report for ${player} (${reason}) locally.` };
}
