// Night Runners-Inspired Garage & Economy Systems (OpenGrid):
// - Used-Car Auction House with opaque condition tags ("Missing Keys", "Airbags Deployed", "Oil Leak", High Mileage)
// - Engine Health & Maintenance Loop (overheat/redline/NOS wear; Engine Swap unlocks ONLY when worn <= 20%)
// - Under-the-Hood upgrades (Turbo, Exhaust Manifold, Engine Swaps — trade reliability for power)
// - Nitrous Oxide bought per liter (0..15 L; overusing spikes engine heat & degrades health)
// - Stance & Suspension tuning (Front/Rear Camber, Ride Height, Spring Stiffness — synced to physics + visuals)
// - Walkable Garage setting (default ON: walk to Hood, Oil Cap, or Storage Locker)

export type TurboId = 'stock' | 'twin_scroll' | 'big_single' | 'twin_turbo';
export type ManifoldId = 'stock' | 'equal_length' | 'titanium_headers';
export type SwapId = 'stock' | 'i6_forged' | 'v8_twin_turbo' | 'v10_screamer';

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

export const TURBOS: Record<TurboId, { label: string; powerMul: number; relPenalty: number; xpCost: number }> = {
  stock:       { label: 'Stock Aspiration',     powerMul: 1.00, relPenalty: 1.0, xpCost: 0 },
  twin_scroll: { label: 'Twin-Scroll Turbo',    powerMul: 1.12, relPenalty: 1.25, xpCost: 600 },
  big_single:  { label: 'Big Single GTX Turbo', powerMul: 1.24, relPenalty: 1.55, xpCost: 1400 },
  twin_turbo:  { label: 'Forged Twin-Turbo',    powerMul: 1.32, relPenalty: 1.85, xpCost: 2400 },
};

export const MANIFOLDS: Record<ManifoldId, { label: string; powerMul: number; flameChance: number; xpCost: number }> = {
  stock:            { label: 'Cast OEM Manifold',   powerMul: 1.00, flameChance: 0.25, xpCost: 0 },
  equal_length:     { label: 'Equal-Length Runner', powerMul: 1.06, flameChance: 0.60, xpCost: 500 },
  titanium_headers: { label: 'Titanium Race Headers', powerMul: 1.11, flameChance: 0.95, xpCost: 1200 },
};

export const ENGINE_SWAPS: Record<SwapId, { label: string; powerMul: number; redlineBonus: number; xpCost: number }> = {
  stock:         { label: 'Factory Block',           powerMul: 1.00, redlineBonus: 0,    xpCost: 0 },
  i6_forged:     { label: 'Forged 3.2L I6 Turbo',    powerMul: 1.18, redlineBonus: 600,  xpCost: 1800 },
  v8_twin_turbo: { label: 'Aftermarket V8 Twin-T',   powerMul: 1.30, redlineBonus: 400,  xpCost: 3000 },
  v10_screamer:  { label: '5.2L V10 Screamer',       powerMul: 1.38, redlineBonus: 1200, xpCost: 4500 },
};

export const AUCTION_LOTS: AuctionLot[] = [
  {
    id: 'lot_vela_keys', carId: 'vela_gt', title: '1999 Vela GT · Impound Auction',
    mileageKm: 138_400, priceXp: 400, priceCr: 9_500, discountPct: 45,
    tags: ['Missing Keys', 'Oil Leak', 'High Mileage'], startHealth: 48, startDamage: 0.28,
  },
  {
    id: 'lot_kestrel_airbag', carId: 'kestrel_gt', title: '2004 Kestrel GT · Salvage Lot',
    mileageKm: 164_200, priceXp: 1100, priceCr: 22_000, discountPct: 40,
    tags: ['Airbags Deployed', 'Bent Tie-Rod', 'Track Rat'], startHealth: 36, startDamage: 0.42,
  },
  {
    id: 'lot_harrier_barn', carId: 'harrier_gt', title: '2008 Harrier GT · Storage Lien',
    mileageKm: 112_900, priceXp: 1800, priceCr: 34_000, discountPct: 35,
    tags: ['Oil Leak', 'Unknown Tune', 'No Service History'], startHealth: 54, startDamage: 0.18,
  },
  {
    id: 'lot_strix_blown', carId: 'strix_gt7', title: '2016 Strix GT7 · Blown Motor',
    mileageKm: 189_500, priceXp: 2400, priceCr: 48_000, discountPct: 50,
    tags: ['Knocking Rod', 'Ready for Engine Swap!', 'Stripped Interior'], startHealth: 14, startDamage: 0.35,
  },
];

export const NOS_PRICE_PER_LITER_XP = 35;
export const NOS_MAX_LITERS = 15;
export const ENGINE_SWAP_THRESHOLD = 20; // Cannot swap engine until worn <= 20% health!

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
  return (s.engines[carId] ??= {
    health: 100, tempC: 88, oilLife: 100, mileageKm: 12_400, nosLiters: 5,
    turbo: 'stock', manifold: 'stock', swap: 'stock', tags: [],
  });
}

export function stanceOf(s: NightRunnersStore, carId: string): StanceSetup {
  return (s.stance[carId] ??= { camberFront: -1.8, camberRear: -1.5, rideHeightMm: 0, springMul: 1.0 });
}

/** Patch a cloned physics JSON with Stance/Suspension + Under-the-Hood upgrades + Engine wear degradation. */
export function applyNightRunnersToPhysics(phys: any, eng: EngineState, st: StanceSetup): any {
  const d = JSON.parse(JSON.stringify(phys));
  const turbo = TURBOS[eng.turbo] ?? TURBOS.stock;
  const man = MANIFOLDS[eng.manifold] ?? MANIFOLDS.stock;
  const sw = ENGINE_SWAPS[eng.swap] ?? ENGINE_SWAPS.stock;

  // High mileage + worn engine health degrade peak torque (encouraging oil changes & eventual engine swaps)
  const mileFactor = Math.max(0.86, 1 - Math.max(0, eng.mileageKm - 50_000) / 1_200_000);
  const healthFactor = 0.78 + 0.22 * (Math.max(0, Math.min(100, eng.health)) / 100);
  const powerMul = turbo.powerMul * man.powerMul * sw.powerMul * mileFactor * healthFactor;

  if (d.engine?.torque_curve) {
    d.engine.torque_curve = d.engine.torque_curve.map(([r, t]: [number, number]) => [r, t * powerMul]);
  }
  if (d.engine?.redline_rpm && sw.redlineBonus) {
    d.engine.redline_rpm += sw.redlineBonus;
  }
  // Apply Stance & Suspension tuning directly to axle physics (hitboxes/ride height match visuals!)
  for (const [k, camb] of [['front', st.camberFront], ['rear', st.camberRear]] as const) {
    if (!d[k]) continue;
    d[k].static_camber_deg = camb;
    if (typeof d[k].spring_rate === 'number') d[k].spring_rate *= st.springMul;
    if (typeof d[k].spring_rest_length === 'number') {
      d[k].spring_rest_length = Math.max(0.14, d[k].spring_rest_length + st.rideHeightMm / 1000);
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

  // Consume Nitrous (0.55 L/s under full purge) and spike engine temperature!
  if (nosActive) {
    eng.nosLiters = Math.max(0, eng.nosLiters - dt * 0.55);
    eng.tempC = Math.min(142, eng.tempC + dt * 11.5 * relPenalty);
  } else {
    const targetTemp = 88 + Math.max(0, rpmFrac - 0.72) * 58 * relPenalty - Math.min(8, speedMs * 0.12);
    eng.tempC += (targetTemp - eng.tempC) * Math.min(1, dt * 0.45);
  }

  // Odometer & Oil Life
  if (speedMs > 1) {
    const dKm = (speedMs * dt) / 1000;
    eng.mileageKm += dKm;
    eng.oilLife = Math.max(0, eng.oilLife - dKm * (eng.tags.includes('Oil Leak') ? 0.85 : 0.25));
  }

  // Overheating (> 116 C) or sustained redlining (> 94%) degrades engine health!
  const overheated = eng.tempC > 116;
  if (overheated || rpmFrac > 0.94 || eng.oilLife < 5) {
    const wearRate = (overheated ? (eng.tempC - 114) * 0.16 : 0) + (rpmFrac > 0.94 ? 0.35 : 0) + (nosActive && overheated ? 1.4 : 0);
    eng.health = Math.max(0, eng.health - wearRate * relPenalty * dt);
  }

  const nosThrustN = nosActive ? (overheated ? 4200 : 6800) : 0;
  const flameBurst = nosActive || (rpmFrac > 0.88 && Math.random() < (MANIFOLDS[eng.manifold]?.flameChance ?? 0.3) * dt * 12);
  return { nosActive, nosThrustN, overheated, flameBurst };
}
