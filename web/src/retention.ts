// Player Retention Systems (OpenGrid):
// - Daily Challenges (3 rotating UTC daily goals awarding XP + Separate Reputation)
// - Party Bonus Multiplier (+25% XP/CR when racing with friends in a party)
// - Separate Reputation (Heat/Street Cred) track independent from XP/Cash
// - Annual Ranked Season Prestige Reset (wipes rank/level for Prestige badges ★, NEVER wipes cars or garage!)

export interface DailyChallenge {
  id: string;
  title: string;
  target: number;
  progress: number;
  unit: string;
  xpReward: number;
  repReward: number;
  claimed: boolean;
}

export interface RetentionStore {
  dayKey: string;
  challenges: DailyChallenge[];
  reputation: number;
  prestige: number;
  seasonYear: number;
  badges: string[];
}

export const PARTY_BONUS_MUL = 1.25; // +25% XP/CR when racing with friends

const RET_KEY = 'nr.retention.v1';

const POOL: Omit<DailyChallenge, 'progress' | 'claimed'>[] = [
  { id: 'speed_trap', title: 'Clock 180+ km/h at a Speed Trap', target: 1, unit: 'trap', xpReward: 900, repReward: 150 },
  { id: 'drift_pts',  title: 'Score 3,500+ pts in a Drift Zone', target: 1, unit: 'zone', xpReward: 1000, repReward: 180 },
  { id: 'wager_win',  title: 'Win a Spontaneous [F] Street Drag', target: 1, unit: 'win',  xpReward: 1200, repReward: 250 },
  { id: 'cop_race',   title: 'Finish a Tactical Cop Race Event',  target: 1, unit: 'race', xpReward: 1400, repReward: 320 },
  { id: 'cruise_km',  title: 'Cruise 5 km in Free Roam',          target: 5, unit: 'km',   xpReward: 750,  repReward: 100 },
  { id: 'photo_shot', title: 'Shoot a Photo in 4K Photo Mode',    target: 1, unit: 'shot', xpReward: 600,  repReward: 90 },
];

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function makeDailySet(dayKey: string): DailyChallenge[] {
  let h = 2166136261;
  for (let i = 0; i < dayKey.length; i++) h = Math.imul(h ^ dayKey.charCodeAt(i), 16777619) >>> 0;
  const picks: DailyChallenge[] = [];
  const used = new Set<number>();
  while (picks.length < 3) {
    const idx = h % POOL.length;
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    if (used.has(idx)) continue;
    used.add(idx);
    picks.push({ ...POOL[idx], progress: 0, claimed: false });
  }
  return picks;
}

export function loadRetention(): RetentionStore {
  const today = utcDayKey();
  const year = new Date().getUTCFullYear();
  const def: RetentionStore = {
    dayKey: today,
    challenges: makeDailySet(today),
    reputation: 0,
    prestige: 0,
    seasonYear: year,
    badges: [],
  };
  try {
    const raw = JSON.parse(localStorage.getItem(RET_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (typeof raw.reputation === 'number') def.reputation = Math.max(0, Math.round(raw.reputation));
      if (typeof raw.prestige === 'number') def.prestige = Math.max(0, Math.round(raw.prestige));
      if (typeof raw.seasonYear === 'number') def.seasonYear = raw.seasonYear;
      if (Array.isArray(raw.badges)) def.badges = raw.badges;
      if (raw.dayKey === today && Array.isArray(raw.challenges) && raw.challenges.length === 3) {
        def.challenges = raw.challenges;
      }
    }
  } catch { /* blocked */ }
  saveRetention(def);
  return def;
}

export function saveRetention(r: RetentionStore) {
  try { localStorage.setItem(RET_KEY, JSON.stringify(r)); } catch { /* blocked */ }
}

/** Advance a daily challenge; returns the newly completed challenge when its target is reached. */
export function advanceChallenge(r: RetentionStore, id: string, delta = 1): DailyChallenge | null {
  const ch = r.challenges.find((c) => c.id === id && !c.claimed);
  if (!ch) return null;
  ch.progress = Math.min(ch.target, +(ch.progress + delta).toFixed(2));
  if (ch.progress >= ch.target) {
    ch.claimed = true;
    r.reputation += ch.repReward;
    saveRetention(r);
    return ch;
  }
  saveRetention(r);
  return null;
}

/**
 * Annual Season Prestige Reset: increments Prestige badge (★) and resets rank/XP cleanly,
 * while NEVER wiping owned cars, garage builds, liveries, or driver gear!
 */
export function triggerPrestigeReset(r: RetentionStore): { prestige: number; badge: string } {
  r.prestige += 1;
  const yr = new Date().getUTCFullYear();
  r.seasonYear = yr;
  const badge = `S${yr} · PRESTIGE ★${r.prestige}`;
  if (!r.badges.includes(badge)) r.badges.push(badge);
  saveRetention(r);
  return { prestige: r.prestige, badge };
}
