// Garage Mechanical & Engine Swap Systems (OpenGrid):
// - Used-Car Auction House with opaque condition tags ("Missing Keys", "Airbags Deployed", "Oil Leak", High Mileage)
// - Engine Health & Maintenance Loop (overheat/redline/NOS wear; Engine Swap unlocks when worn <= 20% OR anytime in Testing Mode)
// - Real multi-architecture Engine Swaps (V12, V10, Cross-Plane V8, Flat-Plane V8, Supercharged V8, Twin-Turbo V6,
//   High-Rev Flat-6, Motorsport Flat-8, Forged Inline-6 Turbo, Quad-Rotor 26B) with real torque curves, redlines,
//   engine weight changes, and dedicated acoustic engine synthesis!
// - Nitrous Oxide bought per liter (0..15 L; overusing spikes engine heat & degrades health)
// - Stance & Suspension tuning (Front/Rear Camber, Ride Height, Spring Stiffness — synced to physics + visuals)
// - Walkable Garage setting (default ON: walk to Hood, Oil Cap, or Storage Locker)
import type { EngineVoiceId } from './brands';

export type TurboId = 'stock' | 'twin_scroll' | 'big_single' | 'twin_turbo';
export type ManifoldId = 'stock' | 'equal_length' | 'titanium_headers';
export type SwapId =
  | 'stock'
  | 'i6_forged'
  | 'v6_tt'
  | 'flat6_na'
  | 'flat8_na'
  | 'v8_flatplane'
  | 'v8_twin_turbo'
  | 'v8_supercharged'
  | 'v10_screamer'
  | 'v12_na'
  | 'rotary_4';

export interface StanceSetup {
  camberFront: number; // deg (-8 .. 0)
  camberRear: number;  // deg (-8 .. 0)
  rideHeightMm: number; // mm (-45 .. +20)
  springMul: number;   // 0.7 .. 1.6
}

export interface EngineState {
  /** 0 (blown/worn out — eligible for Engine Swap!) .. 100 (fresh) */
  health: number;
  /** Live coolant/oil temperature in C (90 nominal, > 118 overheating!) */
  tempC: number;
  /** Oil life 0..100% */
  oilLife: number;
  /** Odometer km (high mileage permanently caps peak power slightly until swapped) */
  mileageKm: number;
  /** Nitrous bottle remaining in liters (bought per liter, max 15 L) */
  nosLiters: number;
  turbo: TurboId;
  manifold: ManifoldId;
  swap: SwapId;
  /** Opaque Auction House condition tags inherited by this car */
  tags: string[];
}

export interface AuctionLot {
  id: string;
  carId: string;
  title: string;
  mileageKm: number;
  priceXp: number;
  priceCr: number;
  discountPct: number;
  tags: string[];
  startHealth: number;
  startDamage: number;
}

export interface NightRunnersStore {
  engines: Record<string, EngineState>;
  stance: Record<string, StanceSetup>;
  walkableGarage: boolean;
  boughtLots: string[];
}

export interface EngineSwapSpec {
  label: string;
  short: string;
  arch: string;
  powerMul: number;
  /** Target redline RPM when installed (0 = keep stock car's redline) */
  targetRedline: number;
  redlineBonus: number;
  /** Mass difference vs typical V6/V8 block (kg) — affects real chassis inertia & handling! */
  massDeltaKg: number;
  /** Torque curve shape across RPM */
  torqueShape: 'stock' | 'low_end' | 'balanced' | 'high_rev' | 'rotary';
  /** Forced induction character for audio & C++ turbo BOV stage */
  induction: 'stock' | 'na' | 'turbo' | 'supercharger';
  /** Acoustic voice ID (null = use car's stock factory voice) */
  voice: EngineVoiceId | null;
  xpCost: number;
}

export const TURBOS: Record<TurboId, { label: string; powerMul: number; relPenalty: number; xpCost: number }> = {
  stock:       { label: 'Stock Aspiration',     powerMul: 1.00, relPenalty: 1.0,  xpCost: 0 },
  twin_scroll: { label: 'Twin-Scroll Turbo',    powerMul: 1.12, relPenalty: 1.25, xpCost: 600 },
  big_single:  { label: 'Big Single GTX Turbo', powerMul: 1.24, relPenalty: 1.55, xpCost: 1400 },
  twin_turbo:  { label: 'Forged Twin-Turbo',    powerMul: 1.32, relPenalty: 1.85, xpCost: 2400 },
};

export const MANIFOLDS: Record<ManifoldId, { label: string; powerMul: number; flameChance: number; xpCost: number }> = {
  stock:            { label: 'Cast OEM Manifold',     powerMul: 1.00, flameChance: 0.25, xpCost: 0 },
  equal_length:     { label: 'Equal-Length Runner',   powerMul: 1.06, flameChance: 0.60, xpCost: 500 },
  titanium_headers: { label: 'Titanium Race Headers', powerMul: 1.11, flameChance: 0.95, xpCost: 1200 },
};

export const ENGINE_SWAPS: Record<SwapId, EngineSwapSpec> = {
  stock: {
    label: 'Factory Block', short: 'STOCK', arch: 'OEM Factory Engine',
    powerMul: 1.00, targetRedline: 0, redlineBonus: 0, massDeltaKg: 0,
    torqueShape: 'stock', induction: 'stock', voice: null, xpCost: 0,
  },
  i6_forged: {
    label: '3.2L Forged I6 Turbo', short: 'I6-T', arch: 'Inline-6 · Single/Twin Turbo · 8,200 RPM',
    powerMul: 1.18, targetRedline: 8200, redlineBonus: 600, massDeltaKg: -8,
    torqueShape: 'balanced', induction: 'turbo', voice: 'i6_forged', xpCost: 1800,
  },
  v6_tt: {
    label: '3.5L Twin-Turbo V6', short: 'V6-TT', arch: '60° V6 · Twin-Turbo · 8,000 RPM',
    powerMul: 1.22, targetRedline: 8000, redlineBonus: 500, massDeltaKg: -14,
    torqueShape: 'balanced', induction: 'turbo', voice: 'v6_tt', xpCost: 2100,
  },
  flat6_na: {
    label: '4.0L High-Rev Flat-6', short: 'FLAT-6', arch: '180° Boxer-6 · NA Screamer · 9,000 RPM',
    powerMul: 1.24, targetRedline: 9000, redlineBonus: 1100, massDeltaKg: -18,
    torqueShape: 'high_rev', induction: 'na', voice: 'flat6_na', xpCost: 2600,
  },
  flat8_na: {
    label: '3.8L Motorsport Flat-8', short: 'FLAT-8', arch: '180° Boxer-8 · Prototype NA · 9,400 RPM',
    powerMul: 1.32, targetRedline: 9400, redlineBonus: 1400, massDeltaKg: -10,
    torqueShape: 'high_rev', induction: 'na', voice: 'flat8_na', xpCost: 3400,
  },
  v8_flatplane: {
    label: '4.5L Flat-Plane V8', short: 'FP-V8', arch: '180° Flat-Plane V8 · NA Exotic · 9,000 RPM',
    powerMul: 1.30, targetRedline: 9000, redlineBonus: 1100, massDeltaKg: 4,
    torqueShape: 'high_rev', induction: 'na', voice: 'v8_flatplane', xpCost: 3200,
  },
  v8_twin_turbo: {
    label: '4.4L Cross-Plane V8 TT', short: 'V8-TT', arch: '90° Cross-Plane V8 · Twin-Turbo · 7,800 RPM',
    powerMul: 1.34, targetRedline: 7800, redlineBonus: 400, massDeltaKg: 20,
    torqueShape: 'low_end', induction: 'turbo', voice: 'v8_twin_turbo', xpCost: 3500,
  },
  v8_supercharged: {
    label: '6.2L Supercharged V8', short: 'V8-SC', arch: '90° V8 · Helical Blower Whine · 7,200 RPM',
    powerMul: 1.36, targetRedline: 7200, redlineBonus: 200, massDeltaKg: 34,
    torqueShape: 'low_end', induction: 'supercharger', voice: 'v8_supercharged', xpCost: 3800,
  },
  v10_screamer: {
    label: '5.2L NA V10 Screamer', short: 'V10', arch: '72° Odd-Fire V10 · NA Howler · 9,000 RPM',
    powerMul: 1.40, targetRedline: 9000, redlineBonus: 1300, massDeltaKg: 26,
    torqueShape: 'high_rev', induction: 'na', voice: 'v10_screamer', xpCost: 4500,
  },
  v12_na: {
    label: '6.5L NA 65° V12', short: 'V12', arch: '65° V12 · F1 Soprano Shriek · 9,300 RPM',
    powerMul: 1.48, targetRedline: 9300, redlineBonus: 1600, massDeltaKg: 44,
    torqueShape: 'high_rev', induction: 'na', voice: 'v12_na', xpCost: 5400,
  },
  rotary_4: {
    label: '2.6L Quad-Rotor 26B', short: '4-ROTOR', arch: '4-Rotor Wankel · Le Mans Siren · 10,200 RPM',
    powerMul: 1.36, targetRedline: 10200, redlineBonus: 2200, massDeltaKg: -55,
    torqueShape: 'rotary', induction: 'na', voice: 'rotary_4', xpCost: 4800,
  },
};

export const AUCTION_LOTS: AuctionLot[] = [
  {
    id: 'lot_vela_keys', carId: 'vela_gt', title: '1999 Valenza Vela GT · Impound Auction',
    mileageKm: 138_400, priceXp: 400, priceCr: 9_500, discountPct: 45,
    tags: ['Missing Keys', 'Oil Leak', 'High Mileage'], startHealth: 48, startDamage: 0.28,
  },
  {
    id: 'lot_kestrel_airbag', carId: 'kestrel_gt', title: '2004 Falcorn Kestrel GT · Salvage Lot',
    mileageKm: 164_200, priceXp: 1100, priceCr: 22_000, discountPct: 40,
    tags: ['Airbags Deployed', 'Bent Tie-Rod', 'Track Rat'], startHealth: 36, startDamage: 0.42,
  },
  {
    id: 'lot_harrier_barn', carId: 'harrier_gt', title: '2008 Falcorn Harrier GT · Storage Lien',
    mileageKm: 112_900, priceXp: 1800, priceCr: 34_000, discountPct: 35,
    tags: ['Oil Leak', 'Unknown Tune', 'No Service History'], startHealth: 54, startDamage: 0.18,
  },
  {
    id: 'lot_strix_blown', carId: 'strix_gt7', title: '2016 Aether Strix GT7 · Blown Motor',
    mileageKm: 189_500, priceXp: 2400, priceCr: 48_000, discountPct: 50,
    tags: ['Knocking Rod', 'Ready for Engine Swap!', 'Stripped Interior'], startHealth: 14, startDamage: 0.35,
  },
];

export const NOS_PRICE_PER_LITER_XP = 35;
export const NOS_MAX_LITERS = 15;
export const ENGINE_SWAP_THRESHOLD = 20; // Cannot swap engine until worn <= 20% health (or Testing Mode ON)

const NR_KEY = 'nr.nightrunners.v1';

export function loadNightRunners(): NightRunnersStore {
  const def: NightRunnersStore = { engines: {}, stance: {}, walkableGarage: true, boughtLots: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(NR_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (raw.engines && typeof raw.engines === 'object') def.engines = raw.engines;
      if (raw.stance && typeof raw.stance === 'object') def.stance = raw.stance;
      if (typeof raw.walkableGarage === 'boolean') def.walkableGarage = raw.walkableGarage;
      if (Array.isArray(raw.boughtLots)) def.boughtLots = raw.boughtLots;
    }
  } catch { /* blocked */ }
  return def;
}

export function saveNightRunners(s: NightRunnersStore) {
  try { localStorage.setItem(NR_KEY, JSON.stringify(s)); } catch { /* blocked */ }
}

export function engineOf(s: NightRunnersStore, carId: string): EngineState {
  const eng = (s.engines[carId] ??= {
    health: 100, tempC: 88, oilLife: 100, mileageKm: 12_400, nosLiters: 5,
    turbo: 'stock', manifold: 'stock', swap: 'stock', tags: [],
  });
  if (!ENGINE_SWAPS[eng.swap]) eng.swap = 'stock';
  return eng;
}

export function stanceOf(s: NightRunnersStore, carId: string): StanceSetup {
  return (s.stance[carId] ??= { camberFront: -1.8, camberRear: -1.5, rideHeightMm: 0, springMul: 1.0 });
}

/** Patch a cloned physics JSON with Stance/Suspension + Engine Swap torque/redline/mass + Under-the-Hood upgrades. */
export function applyNightRunnersToPhysics(phys: any, eng: EngineState, st: StanceSetup): any {
  const d = JSON.parse(JSON.stringify(phys));
  const turbo = TURBOS[eng.turbo] ?? TURBOS.stock;
  const man = MANIFOLDS[eng.manifold] ?? MANIFOLDS.stock;
  const sw = ENGINE_SWAPS[eng.swap] ?? ENGINE_SWAPS.stock;

  const mileFactor = Math.max(0.86, 1 - Math.max(0, eng.mileageKm - 50_000) / 1_200_000);
  const healthFactor = 0.78 + 0.22 * (Math.max(0, Math.min(100, eng.health)) / 100);
  const powerMul = turbo.powerMul * man.powerMul * sw.powerMul * mileFactor * healthFactor;

  const baseRedline: number = d.engine?.redline_rpm ?? 7500;
  const nextRedline = sw.targetRedline > 0 ? Math.max(sw.targetRedline, baseRedline + Math.round(sw.redlineBonus * 0.35)) : baseRedline;
  if (d.engine) {
    d.engine.redline_rpm = nextRedline;
    if (d.engine.rev_limiter_rpm) d.engine.rev_limiter_rpm = Math.max(nextRedline + 150, d.engine.rev_limiter_rpm);
  }
  if (d.engine?.torque_curve && Array.isArray(d.engine.torque_curve)) {
    const scaleRpm = baseRedline > 0 ? nextRedline / baseRedline : 1;
    d.engine.torque_curve = d.engine.torque_curve.map(([r, t]: [number, number]) => {
      const nr = Math.round(r * (sw.targetRedline > 0 ? scaleRpm : 1));
      const f = Math.min(1, nr / Math.max(1000, nextRedline));
      let shapeMul = 1.0;
      if (sw.torqueShape === 'low_end') shapeMul = 1.14 - 0.16 * f;
      else if (sw.torqueShape === 'high_rev') shapeMul = 0.88 + 0.22 * f;
      else if (sw.torqueShape === 'rotary') shapeMul = 0.76 + 0.36 * f * f;
      return [nr, t * powerMul * shapeMul];
    });
    // Upgrade clutch clamp capacity alongside engine/turbo/swap torque so high-power builds never cook their clutch
    if (d.drivetrain && typeof d.drivetrain.clutch_max_torque_nm === 'number') {
      const peakT = Math.max(...d.engine.torque_curve.map(([, t]: [number, number]) => t));
      d.drivetrain.clutch_max_torque_nm = Math.max(d.drivetrain.clutch_max_torque_nm * Math.max(1, powerMul), peakT * 1.75);
    }
  }
  if (d.chassis && typeof d.chassis.mass_kg === 'number' && sw.massDeltaKg) {
    d.chassis.mass_kg = Math.max(850, d.chassis.mass_kg + sw.massDeltaKg);
  }
  // Apply Stance & Suspension tuning directly to axle physics (hitboxes/ride height match visuals!)
  for (const [k, camb] of [['front_axle', st.camberFront], ['rear_axle', st.camberRear]] as const) {
    const ax = d[k] ?? d[k.replace('_axle', '')];
    if (!ax) continue;
    ax.static_camber_deg = camb;
    if (typeof ax.spring_rate_n_per_m === 'number') ax.spring_rate_n_per_m *= st.springMul;
    else if (typeof ax.spring_rate === 'number') ax.spring_rate *= st.springMul;
    if (typeof ax.spring_rest_length_m === 'number') {
      ax.spring_rest_length_m = Math.max(0.14, ax.spring_rest_length_m + st.rideHeightMm / 1000);
    } else if (typeof ax.spring_rest_length === 'number') {
      ax.spring_rest_length = Math.max(0.14, ax.spring_rest_length + st.rideHeightMm / 1000);
    }
  }
  if (d.chassis && typeof d.chassis.cg_height_m === 'number') {
    d.chassis.cg_height_m = Math.max(0.32, d.chassis.cg_height_m + st.rideHeightMm / 1000);
  }
  return d;
}

/**
 * Per-frame Engine Maintenance & Nitrous thermal loop while driving.
 * Returns { nosActive, nosThrustN, overheated, flameBurst }.
 */
export function tickEngineAndNos(
  eng: EngineState,
  dt: number,
  rpm: number,
  redline: number,
  speedMs: number,
  nosPressed: boolean,
): { nosActive: boolean; nosThrustN: number; overheated: boolean; flameBurst: boolean } {
  const relPenalty = (TURBOS[eng.turbo]?.relPenalty ?? 1.0) * (eng.tags.includes('Oil Leak') ? 1.35 : 1.0);
  const rpmFrac = redline > 0 ? rpm / redline : 0;
  const nosActive = nosPressed && eng.nosLiters > 0.01 && eng.health > 2;

  if (nosActive) {
    eng.nosLiters = Math.max(0, eng.nosLiters - dt * 0.55);
    eng.tempC = Math.min(142, eng.tempC + dt * 11.5 * relPenalty);
  } else {
    const targetTemp = 88 + Math.max(0, rpmFrac - 0.72) * 58 * relPenalty - Math.min(8, speedMs * 0.12);
    eng.tempC += (targetTemp - eng.tempC) * Math.min(1, dt * 0.45);
  }

  if (speedMs > 1) {
    const dKm = (speedMs * dt) / 1000;
    eng.mileageKm += dKm;
    eng.oilLife = Math.max(0, eng.oilLife - dKm * (eng.tags.includes('Oil Leak') ? 0.85 : 0.25));
  }

  const overheated = eng.tempC > 116;
  if (overheated || rpmFrac > 0.94 || eng.oilLife < 5) {
    const wearRate = (overheated ? (eng.tempC - 114) * 0.16 : 0) + (rpmFrac > 0.94 ? 0.35 : 0) + (nosActive && overheated ? 1.4 : 0);
    eng.health = Math.max(0, eng.health - wearRate * relPenalty * dt);
  }

  const nosThrustN = nosActive ? (overheated ? 4200 : 6800) : 0;
  const flameBurst = nosActive || (rpmFrac > 0.88 && Math.random() < (MANIFOLDS[eng.manifold]?.flameChance ?? 0.3) * dt * 12);
  return { nosActive, nosThrustN, overheated, flameBurst };
}
