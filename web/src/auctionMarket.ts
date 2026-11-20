// CS2-Inspired Live Supply & Demand Car Auction House (OpenGrid).
// Combines all 6 CS2 market pillars with Instant Market-Maker settlement:
//   1. Uncapped supply & demand pricing (no forced snap-back to MSRP).
//   2. 15% Market Fee + realistic Dealer Spread (prevents infinite buy->sell loops; salvage & demand spikes profit).
//   3. Float Value condition grading (0.000 Factory Mint -> 0.999 Battle-Scarred) + 35% Mod & Engine Swap Overpay.
//   4. Sell EVERYTHING (falls back to free untradeable Stock Loaner so players can never soft-lock).
//   5. Rotating Limited-Run / Salvage / Pre-Tuned supply pools that create real scarcity.
//   6. Live SVG Price History Sparkline + anti-spoof velocity dampening / cooldown.

import { CAR_REQ, MOD_REQ, STARTER_CAR } from './progression';
import { MOD_KEYS, type ModKey, type Mods } from './garage';
import type { CarCondition } from './maintenance';
import { ENGINE_SWAPS, MANIFOLDS, TURBOS, type EngineState, type ManifoldId, type SwapId, type TurboId } from './nightRunners';

export const AUCTION_MARKET_FEE = 0.15;     // 15% CS2-style transaction sink (5% house + 10% registry)
export const DEALER_SPREAD = 0.80;          // 20% bid/ask spread on fresh showroom cars before fee
export const MOD_OVERPAY_RATE = 0.35;       // +35% of installed upgrades, turbos & engine swaps returned on sale
export const TRADE_COOLDOWN_MS = 18_000;    // Anti-spoof dampening window per car

export interface MarketEntry {
  carId: string;
  price: number;           // Current uncapped live market price (Cr)
  buys24h: number;
  sells24h: number;
  history: number[];       // Last 24 price ticks for SVG sparkline
  lastTickHour: number;
  lastPlayerTradeAt: number;
}

export interface AuctionMarketStore {
  entries: Record<string, MarketEntry>;
  boughtDynamicLots: string[];
  totalFlipped: number;
  totalVolumeCr: number;
}

export type LotKind = 'salvage' | 'limited' | 'tuned';

export interface LiveAuctionLot {
  id: string;
  carId: string;
  kind: LotKind;
  title: string;
  subtitle: string;
  floatVal: number;
  mileageKm: number;
  startHealth: number;
  startDamage: number;
  priceCr: number;
  marketRefCr: number;
  discountPct: number;     // positive = bargain below live market, negative = scarce collector premium
  tags: string[];
  swap?: SwapId;
  turbo?: TurboId;
  manifold?: ManifoldId;
  rarityLabel: string;
}

export interface FloatGrade {
  floatVal: number;        // 0.000 (Factory Mint) .. 0.999 (Battle-Scarred)
  label: string;
  short: string;
  color: string;
  priceMul: number;
}

export interface AppraisalResult {
  carId: string;
  liveMarketPrice: number;
  floatGrade: FloatGrade;
  conditionAdjusted: number;
  installedPartsValue: number;
  modOverpay: number;
  grossBeforeSpread: number;
  dealerBid: number;
  marketFee: number;
  netPayout: number;
  trendPct: number;
  cooldownSec: number;
}

/** Realistic base reference valuation for every car (including starter car Vela GT). */
export const BASE_CAR_VALUATION: Record<string, number> = {
  vela_gt: 48_000,
  hayate: 54_000,
  k_concept: 120_000,
  kestrel_gt: 140_000,
  harrier_gt: 160_000,
  tornado_gt: 175_000,
  basilisk_v12: 210_000,
  strix_gt7: 260_000,
  tornado_gt3: 295_000,
};

/** Part values for Engine Swaps, Turbos, and Manifolds (used in +35% Mod Overpay). */
export const SWAP_VALUE_CR: Record<SwapId, number> = {
  stock: 0,
  i6_forged: 18_000,
  v6_tt: 22_000,
  v8_twin_turbo: 26_000,
  v8_supercharged: 28_000,
  v8_flatplane: 32_000,
  flat6_na: 30_000,
  flat8_na: 38_000,
  rotary_4: 34_000,
  v10_screamer: 44_000,
  v12_na: 55_000,
};

export const TURBO_VALUE_CR: Record<TurboId, number> = {
  stock: 0,
  twin_scroll: 7_500,
  big_single: 16_000,
  twin_turbo: 24_000,
};

export const MANIFOLD_VALUE_CR: Record<ManifoldId, number> = {
  stock: 0,
  equal_length: 6_500,
  titanium_headers: 14_500,
};

const MARKET_KEY = 'nr.auction.market.v1';

/** Deterministic hash helper for organic hourly market waves & rotating auction lots. */
function hashNum(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function baseValueOfCar(carId: string): number {
  return BASE_CAR_VALUATION[carId] ?? Math.max(45_000, CAR_REQ[carId]?.price ?? 60_000);
}

/** CS2-style Wear Float (0.000 = Factory Mint .. 0.999 = Battle-Scarred / Wrecked). */
export function computeCarFloat(cond: CarCondition, eng: EngineState): FloatGrade {
  const dmg = Math.max(0, Math.min(1, cond.totaled ? 1 : cond.damage));
  const wear = Math.max(0, Math.min(1, 1 - eng.health / 100));
  const oilWear = Math.max(0, Math.min(1, 1 - eng.oilLife / 100));
  const kmWear = Math.min(0.28, Math.max(0, eng.mileageKm - 5_000) / 550_000);
  const raw = Math.min(0.999, Math.max(0.004, dmg * 0.52 + wear * 0.32 + oilWear * 0.08 + kmWear));
  return gradeFromFloat(raw);
}

export function gradeFromFloat(floatVal: number): FloatGrade {
  const f = Math.min(0.999, Math.max(0.001, floatVal));
  if (f < 0.07) return { floatVal: f, label: 'Factory Mint', short: 'FN', color: '#4ade80', priceMul: 1.12 };
  if (f < 0.18) return { floatVal: f, label: 'Minimal Wear', short: 'MW', color: '#38bdf8', priceMul: 1.03 };
  if (f < 0.38) return { floatVal: f, label: 'Field-Driven', short: 'FT', color: '#facc15', priceMul: 0.94 };
  if (f < 0.65) return { floatVal: f, label: 'Well-Worn', short: 'WW', color: '#fb923c', priceMul: 0.80 };
  return { floatVal: f, label: 'Battle-Scarred', short: 'BS', color: '#fb7185', priceMul: 0.64 };
}

/** Total Cr value of installed performance stages, turbo, exhaust manifold & engine swap. */
export function installedPartsValueOf(mods: Mods, eng: EngineState): number {
  let sum = 0;
  for (const k of MOD_KEYS) {
    const st = Math.max(0, Math.min(3, mods[k] ?? 0));
    for (let i = 0; i < st; i++) sum += MOD_REQ[k][i]?.price ?? 0;
  }
  sum += SWAP_VALUE_CR[eng.swap] ?? 0;
  sum += TURBO_VALUE_CR[eng.turbo] ?? 0;
  sum += MANIFOLD_VALUE_CR[eng.manifold] ?? 0;
  return sum;
}

function seedEntry(carId: string, nowHour: number): MarketEntry {
  const base = baseValueOfCar(carId);
  const history: number[] = [];
  let p = base;
  // Build 24 hours of organic uncapped supply/demand history (no forced snap-back to base).
  for (let i = 23; i >= 0; i--) {
    const h = nowHour - i;
    const r = hashNum(`${carId}:tick:${h}`) - 0.485; // slight organic collector drift upward over time
    const step = r * 0.075;
    p = Math.max(5_000, Math.round((p * (1 + step)) / 100) * 100);
    history.push(p);
  }
  const buys24h = 8 + Math.floor(hashNum(`${carId}:b:${nowHour}`) * 42);
  const sells24h = 6 + Math.floor(hashNum(`${carId}:s:${nowHour}`) * 38);
  return {
    carId,
    price: history[history.length - 1],
    buys24h,
    sells24h,
    history,
    lastTickHour: nowHour,
    lastPlayerTradeAt: 0,
  };
}

export function loadAuctionMarket(carIds: string[]): AuctionMarketStore {
  const nowHour = Math.floor(Date.now() / 3_600_000);
  const store: AuctionMarketStore = { entries: {}, boughtDynamicLots: [], totalFlipped: 0, totalVolumeCr: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(MARKET_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (raw.entries && typeof raw.entries === 'object') store.entries = raw.entries;
      if (Array.isArray(raw.boughtDynamicLots)) store.boughtDynamicLots = raw.boughtDynamicLots.slice(-40);
      if (typeof raw.totalFlipped === 'number') store.totalFlipped = raw.totalFlipped;
      if (typeof raw.totalVolumeCr === 'number') store.totalVolumeCr = raw.totalVolumeCr;
    }
  } catch { /* storage blocked */ }

  let dirty = false;
  for (const id of carIds) {
    if (!store.entries[id]) {
      store.entries[id] = seedEntry(id, nowHour);
      dirty = true;
    } else {
      const e = store.entries[id];
      // Advance uncapped market ticks for elapsed hours since last visit (capped at 48 ticks per load)
      const deltaH = Math.min(48, Math.max(0, nowHour - (e.lastTickHour || nowHour)));
      if (deltaH > 0) {
        let p = e.price;
        for (let k = 1; k <= deltaH; k++) {
          const h = e.lastTickHour + k;
          const r = hashNum(`${id}:tick:${h}`) - 0.49;
          p = Math.max(5_000, Math.round((p * (1 + r * 0.065)) / 100) * 100);
          e.history.push(p);
          if (e.history.length > 24) e.history.shift();
        }
        e.price = p;
        e.lastTickHour = nowHour;
        e.buys24h = Math.max(2, Math.round(e.buys24h * 0.85 + hashNum(`${id}:b:${nowHour}`) * 14));
        e.sells24h = Math.max(2, Math.round(e.sells24h * 0.85 + hashNum(`${id}:s:${nowHour}`) * 14));
        dirty = true;
      }
    }
  }
  if (dirty) saveAuctionMarket(store);
  return store;
}

export function saveAuctionMarket(store: AuctionMarketStore) {
  try { localStorage.setItem(MARKET_KEY, JSON.stringify(store)); } catch { /* blocked */ }
}

export function marketEntryOf(store: AuctionMarketStore, carId: string): MarketEntry {
  const nowHour = Math.floor(Date.now() / 3_600_000);
  return (store.entries[carId] ??= seedEntry(carId, nowHour));
}

export function trendPctOf(e: MarketEntry): number {
  const first = e.history[0] || e.price;
  if (!first) return 0;
  return ((e.price - first) / first) * 100;
}

/**
 * Record a real player buy or sell into the live uncapped supply-and-demand curve.
 * Includes anti-spoof dampening if the same car is traded repeatedly inside TRADE_COOLDOWN_MS.
 */
export function recordMarketTrade(store: AuctionMarketStore, carId: string, side: 'buy' | 'sell', amountCr: number) {
  const e = marketEntryOf(store, carId);
  const now = Date.now();
  const inCooldown = now - e.lastPlayerTradeAt < TRADE_COOLDOWN_MS;
  // Uncapped supply/demand move: buying pushes price up, selling pushes price down (dampened during rapid spam)
  const impact = inCooldown ? 0.008 : 0.042;
  if (side === 'buy') {
    e.buys24h += 1;
    e.price = Math.max(5_000, Math.round((e.price * (1 + impact)) / 100) * 100);
  } else {
    e.sells24h += 1;
    e.price = Math.max(5_000, Math.round((e.price * (1 - impact)) / 100) * 100);
    store.totalFlipped += 1;
  }
  e.history.push(e.price);
  if (e.history.length > 24) e.history.shift();
  e.lastPlayerTradeAt = now;
  store.totalVolumeCr += Math.max(0, Math.round(amountCr));
  saveAuctionMarket(store);
}

/** Full CS2-style Appraisal Breakdown for selling an owned car right now. */
export function appraiseCarForSale(
  store: AuctionMarketStore,
  carId: string,
  cond: CarCondition,
  eng: EngineState,
  mods: Mods,
): AppraisalResult {
  const entry = marketEntryOf(store, carId);
  const floatGrade = computeCarFloat(cond, eng);
  const liveMarketPrice = entry.price;
  const conditionAdjusted = Math.round((liveMarketPrice * floatGrade.priceMul) / 50) * 50;
  const installedPartsValue = installedPartsValueOf(mods, eng);
  const modOverpay = Math.round((installedPartsValue * MOD_OVERPAY_RATE) / 50) * 50;
  const grossBeforeSpread = conditionAdjusted + modOverpay;
  // Dealer bid spread stops infinite showroom buy->sell exploits while rewarding salvage flips & demand spikes
  const dealerBid = Math.round((grossBeforeSpread * DEALER_SPREAD) / 50) * 50;
  const marketFee = Math.round((dealerBid * AUCTION_MARKET_FEE) / 50) * 50;
  const netPayout = Math.max(1_000, dealerBid - marketFee);
  const cooldownMs = Math.max(0, TRADE_COOLDOWN_MS - (Date.now() - entry.lastPlayerTradeAt));
  return {
    carId,
    liveMarketPrice,
    floatGrade,
    conditionAdjusted,
    installedPartsValue,
    modOverpay,
    grossBeforeSpread,
    dealerBid,
    marketFee,
    netPayout,
    trendPct: trendPctOf(entry),
    cooldownSec: Math.ceil(cooldownMs / 1000),
  };
}

/**
 * Generate rotating CS2-style supply pools (rotates every 15 minutes):
 *   - Wrecked Salvage Finds (35-55% below live market — repair & flip for profit!)
 *   - Limited-Run Factory Mint Collector Specs (scarce 1-of-1 low float!)
 *   - Pre-Tuned / Engine-Swapped Street Builds (discounted turn-key swaps!)
 */
export function generateLiveAuctionLots(
  store: AuctionMarketStore,
  carIds: string[],
  carNameOf: (id: string) => string,
  windowSlot = Math.floor(Date.now() / (15 * 60_000)),
): LiveAuctionLot[] {
  const pool = carIds.filter((id) => id !== STARTER_CAR);
  if (!pool.length) return [];

  const pick = (salt: string, list: readonly string[]) => list[Math.floor(hashNum(`${windowSlot}:${salt}`) * list.length) % list.length];
  const used = new Set<string>();
  const pickUniqueCar = (salt: string) => {
    for (let tries = 0; tries < 8; tries++) {
      const id = pick(`${salt}:${tries}`, pool);
      if (!used.has(id)) { used.add(id); return id; }
    }
    return pick(salt, pool);
  };

  const lots: LiveAuctionLot[] = [];

  // 1-2: Two Wrecked Salvage Flipper Lots (high float, deep discount below live market!)
  const salvageTemplates = [
    { suffix: 'Insurance Salvage', tags: ['Salvage Title', 'Repair & Flip Ready', 'Body Damage'], dmg: 0.44, hp: 38, km: 148_200, disc: 44 },
    { suffix: 'Impound Blown Motor', tags: ['Knocking Rod', 'Engine Swap Candidate', 'Stripped Bay'], dmg: 0.34, hp: 16, km: 184_600, disc: 52 },
  ];
  salvageTemplates.forEach((tpl, i) => {
    const carId = pickUniqueCar(`salvage_${i}`);
    const ref = marketEntryOf(store, carId).price;
    const priceCr = Math.max(8_000, Math.round((ref * (1 - tpl.disc / 100)) / 500) * 500);
    const floatVal = Math.min(0.96, 0.66 + hashNum(`${windowSlot}:sf:${i}`) * 0.28);
    lots.push({
      id: `lot_${windowSlot}_sal_${i}_${carId}`,
      carId,
      kind: 'salvage',
      title: `${carNameOf(carId)} · ${tpl.suffix}`,
      subtitle: 'Buy cheap, repair in Garage, flip on a market spike',
      floatVal,
      mileageKm: tpl.km + Math.floor(hashNum(`${windowSlot}:skm:${i}`) * 25_000),
      startHealth: tpl.hp,
      startDamage: tpl.dmg,
      priceCr,
      marketRefCr: ref,
      discountPct: tpl.disc,
      tags: tpl.tags,
      rarityLabel: 'SALVAGE BARGAIN',
    });
  });

  // 3: Pre-Tuned / Engine-Swapped Street Build (ready-to-drive swapped build below parts+car value!)
  {
    const carId = pickUniqueCar('tuned');
    const swapPool: SwapId[] = ['v10_screamer', 'v12_na', 'flat6_na', 'v8_supercharged', 'rotary_4', 'v8_flatplane'];
    const swap = pick('tuned_swap', swapPool) as SwapId;
    const turbo: TurboId = hashNum(`${windowSlot}:tt`) > 0.45 ? 'twin_turbo' : 'big_single';
    const manifold: ManifoldId = 'titanium_headers';
    const ref = marketEntryOf(store, carId).price;
    const partsVal = (SWAP_VALUE_CR[swap] ?? 0) + (TURBO_VALUE_CR[turbo] ?? 0) + (MANIFOLD_VALUE_CR[manifold] ?? 0);
    const bundleVal = ref + partsVal;
    const disc = 22;
    const priceCr = Math.round((bundleVal * (1 - disc / 100)) / 500) * 500;
    const floatVal = 0.10 + hashNum(`${windowSlot}:tf`) * 0.14;
    lots.push({
      id: `lot_${windowSlot}_tun_${carId}`,
      carId,
      kind: 'tuned',
      title: `${carNameOf(carId)} · ${ENGINE_SWAPS[swap].short} Swapped`,
      subtitle: `Pre-installed ${ENGINE_SWAPS[swap].label} + ${TURBOS[turbo].label} + ${MANIFOLDS[manifold].label}`,
      floatVal,
      mileageKm: 28_400 + Math.floor(hashNum(`${windowSlot}:tkm`) * 32_000),
      startHealth: 92,
      startDamage: 0.04,
      priceCr,
      marketRefCr: bundleVal,
      discountPct: disc,
      tags: [ENGINE_SWAPS[swap].short + ' Swap', TURBOS[turbo].label, 'Dyno Tuned'],
      swap,
      turbo,
      manifold,
      rarityLabel: 'SWAPPED BUILD',
    });
  }

  // 4: Limited-Run Factory Mint Collector Spec (ultra-low float, 1-of-1 scarce drop!)
  {
    const carId = pickUniqueCar('limited');
    const ref = marketEntryOf(store, carId).price;
    const floatVal = 0.008 + hashNum(`${windowSlot}:lf`) * 0.036;
    const disc = 8; // slight collector auction opportunity on factory-mint low-km chassis
    const priceCr = Math.round((ref * (1 - disc / 100)) / 500) * 500;
    lots.push({
      id: `lot_${windowSlot}_lim_${carId}`,
      carId,
      kind: 'limited',
      title: `${carNameOf(carId)} · Collector Spec #01`,
      subtitle: 'Delivery-mileage Factory Mint chassis — zero damage, ultra-low float',
      floatVal,
      mileageKm: 180 + Math.floor(hashNum(`${windowSlot}:lkm`) * 650),
      startHealth: 100,
      startDamage: 0,
      priceCr,
      marketRefCr: ref,
      discountPct: disc,
      tags: ['Factory Mint', 'Delivery Miles', 'Limited Pool'],
      rarityLabel: '★ LIMITED 1/1',
    });
  }

  return lots;
}

/** Clean inline SVG sparkline chart for CS2-style live price history. */
export function renderPriceSparklineSvg(history: number[], width = 128, height = 34): string {
  const pts = history.length >= 2 ? history : [history[0] ?? 50_000, history[0] ?? 50_000];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(1, max - min);
  const up = pts[pts.length - 1] >= pts[0];
  const stroke = up ? '#4ade80' : '#fb7185';
  const fill = up ? 'rgba(74,222,128,0.16)' : 'rgba(251,113,133,0.16)';
  const padY = 4;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * width;
    const y = padY + (1 - (v - min) / span) * (height - padY * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${coords.join(' ')} ${width},${height}`;
  const last = coords[coords.length - 1].split(',');
  return `<svg class="mkt-spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <polygon points="${area}" fill="${fill}" />
    <polyline points="${coords.join(' ')}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="${stroke}" />
  </svg>`;
}
