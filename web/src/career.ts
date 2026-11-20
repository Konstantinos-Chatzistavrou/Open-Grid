// The two careers (progression.ts has the rules):
//   SpCareer  single player, this device: XP unlocks levels + Auction Credits (Cr) fuel the live CS2-style Auction House,
//             salvage flips, direct Garage upgrades, and selling any car (with free untradeable Stock Loaner fallback).
//   MpCareer  online, kept by the server (cloud.ts): XP and credits from ranked races; a level makes an item buyable,
//             credits pay for it. This class only shows the server's profile and asks it to buy things.
import { CAR_REQ, MOD_REQ, SKIN_REQ, STARTER_CAR, levelOf, xpToNext, type Career as CareerKind, type Req } from './progression';
import { MOD_KEYS, type CatalogCar, type ModKey, type Selection } from './garage';
import { SKINS } from './scene/driver';
import type { Cloud, Profile } from './cloud';

export const fmt = (n: number) => `${Math.round(n).toLocaleString('en-US')} Cr`;
export const fmtXp = (n: number) => `${Math.round(n).toLocaleString('en-US')} XP`;

/** What the last session earned (shown on the title / results). */
export interface Earned { xp: number; cr: number; reason: string; parts?: { label: string; xp: number }[]; levelUp?: number; unlocked?: string[] }

export interface Career {
  readonly kind: CareerKind;
  readonly xp: number;
  readonly credits: number;
  readonly ready: boolean;        // online: profile loaded
  readonly note: string;          // online: why it is not ready
  last: Earned | null;
  /** True if the player can drive this car (includes free untradeable Stock Loaner when garage is empty). */
  owns(car: string): boolean;
  /** True if the player genuinely owns this car as a sellable asset (false for the free Stock Loaner). */
  ownsSellable(car: string): boolean;
  /** True if the player sold all their cars and is currently driving the free untradeable Stock Loaner. */
  isUsingLoaner(catalogIds: string[]): boolean;
  stage(car: string, k: ModKey): number;
  ownsSkin(id: string): boolean;
  /** what an item needs, for the auction / garage */
  req(kind: 'car' | 'mod' | 'skin', id: string, stage?: number): Req;
  buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number): Promise<string>;
  /** Buy a car at its live Auction Market price (or rotating lot price). */
  buyAuctionCar(carId: string, priceCr: number): Promise<string>;
  /** Instant-sell an owned car to the Auction House for netPayoutCr (may leave garage at 0 -> Stock Loaner). */
  sellAuctionCar(carId: string, netPayoutCr: number): Promise<string>;
  /** the selection may only use what this career has (fallbacks) */
  fit(sel: Selection): void;
}

const reqOf = (kind: 'car' | 'mod' | 'skin', id: string, stage = 1): Req =>
  kind === 'car' ? CAR_REQ[id] ?? { spLevel: 1, mpLevel: 1, price: 0 }
  : kind === 'skin' ? SKIN_REQ[id] ?? { spLevel: 1, mpLevel: 1, price: 0 }
  : MOD_REQ[id as ModKey]?.[stage - 1] ?? { spLevel: 99, mpLevel: 99, price: 0 };

const fitSel = (c: Career, sel: Selection) => {
  if (!c.owns(sel.car)) sel.car = STARTER_CAR;
  if (!c.ownsSkin(sel.skin)) sel.skin = SKINS[0].id;
  for (const [car, m] of Object.entries(sel.mods)) for (const k of MOD_KEYS) m[k] = Math.min(m[k], c.stage(car, k));
};

// ---- single player ----------------------------------------------------------------------------------------------------
const SP_KEY = 'nr.sp.v1';
const TEST_KEY = 'nr.testing.v1';

interface SpSaveData {
  xp: number;
  credits: number;
  auctionOwned: string[];
  soldCars: string[];
  boughtMods: Record<string, Partial<Record<ModKey, number>>>;
  boughtSkins: string[];
}

export class SpCareer implements Career {
  readonly kind = 'sp' as const;
  readonly ready = true;
  readonly note = '';
  last: Earned | null = null;
  private data: SpSaveData = { xp: 0, credits: 45_000, auctionOwned: [], soldCars: [], boughtMods: {}, boughtSkins: [] };
  private _testing = false;

  constructor(private unlockAll = false) {
    try {
      const s = JSON.parse(localStorage.getItem(SP_KEY) ?? 'null');
      if (s && Number.isFinite(s.xp)) {
        this.data.xp = Math.max(0, Math.floor(s.xp));
        const lvl = levelOf(this.data.xp).level;
        this.data.credits = Number.isFinite(s.credits) ? Math.max(0, Math.floor(s.credits)) : 45_000 + lvl * 12_000;
        if (Array.isArray(s.auctionOwned)) this.data.auctionOwned = s.auctionOwned.filter((x: unknown) => typeof x === 'string');
        if (Array.isArray(s.soldCars)) this.data.soldCars = s.soldCars.filter((x: unknown) => typeof x === 'string');
        if (s.boughtMods && typeof s.boughtMods === 'object') this.data.boughtMods = s.boughtMods;
        if (Array.isArray(s.boughtSkins)) this.data.boughtSkins = s.boughtSkins.filter((x: unknown) => typeof x === 'string');
      } else {
        this.migrate();
      }
      this._testing = localStorage.getItem(TEST_KEY) === '1';
    } catch { /* storage blocked */ }
  }

  /** Testing Purposes sandbox mode: every car, upgrade stage, swap, skin, and service is 100% free & instantly accessible. */
  get testingMode() { return this.unlockAll || this._testing; }
  setTestingMode(on: boolean) {
    this._testing = on;
    try { localStorage.setItem(TEST_KEY, on ? '1' : '0'); } catch { /* blocked */ }
    (this as { onChange?: () => void }).onChange?.();
  }

  /** Players of the one-day credits shop keep the best car they bought: they start at the level that unlocks it. */
  private migrate() {
    try {
      const w = JSON.parse(localStorage.getItem('nr.wallet.v2') ?? 'null');
      const need = Math.max(1, ...((w?.cars ?? []) as string[]).map((c) => CAR_REQ[c]?.spLevel ?? 1));
      let xp = 0;
      for (let l = 1; l < need; l++) xp += xpToNext(l);
      this.data.xp = xp;
      this.data.credits = 45_000 + need * 12_000;
      this.save();
    } catch { /* nothing to migrate */ }
  }

  private save() { try { localStorage.setItem(SP_KEY, JSON.stringify(this.data)); } catch { /* blocked */ } }
  get xp() { return this.testingMode ? 10_000_000 : this.data.xp; }
  get credits() { return this.testingMode ? 99_999_999 : this.data.credits; }
  get level() { return levelOf(this.xp).level; }

  ownsSellable(car: string): boolean {
    if (this.testingMode) return true;
    if (this.data.soldCars.includes(car)) return false;
    return this.data.auctionOwned.includes(car) || this.level >= reqOf('car', car).spLevel;
  }

  isUsingLoaner(catalogIds: string[]): boolean {
    if (this.testingMode) return false;
    return !catalogIds.some((id) => this.ownsSellable(id));
  }

  owns(car: string): boolean {
    if (this.ownsSellable(car)) return true;
    // CS2-style free untradeable default loadout: if the player sold all cars, the stock starter loaner is always drivable
    if (car === STARTER_CAR && !Object.keys(CAR_REQ).some((id) => this.ownsSellable(id))) return true;
    return false;
  }

  stage(car: string, k: ModKey): number {
    if (this.testingMode) return MOD_REQ[k].length;
    const byLvl = MOD_REQ[k].filter((r) => r.spLevel <= this.level).length;
    const byBuy = this.data.boughtMods[car]?.[k] ?? 0;
    return Math.max(byLvl, byBuy);
  }

  ownsSkin(id: string): boolean {
    return this.testingMode || this.data.boughtSkins.includes(id) || this.level >= reqOf('skin', id).spLevel;
  }

  req = reqOf;

  async buy(kind: 'car' | 'mod' | 'skin', id: string, stage = 1): Promise<string> {
    if (this.testingMode) return '✓ Free in Testing Mode.';
    if (kind === 'car') {
      const r = reqOf('car', id);
      return this.buyAuctionCar(id, r.price || 48_000);
    }
    if (kind === 'skin') {
      if (this.ownsSkin(id)) return '✓ Already owned.';
      const price = reqOf('skin', id).price;
      if (this.data.credits < price) return `Need ${fmt(price - this.data.credits)} more.`;
      this.data.credits -= price;
      if (!this.data.boughtSkins.includes(id)) this.data.boughtSkins.push(id);
      this.save();
      (this as { onChange?: () => void }).onChange?.();
      return `✓ ${SKINS.find((s) => s.id === id)?.name ?? id} gear bought for ${fmt(price)}.`;
    }
    // mod: id can be "car:key" or just "key"
    const [carId, keyStr] = id.includes(':') ? id.split(':') : [STARTER_CAR, id];
    const key = keyStr as ModKey;
    const cur = this.stage(carId, key);
    if (stage <= cur) return '✓ Already unlocked.';
    let price = 0;
    for (let s = cur + 1; s <= stage; s++) price += reqOf('mod', key, s).price;
    if (this.data.credits < price) return `Need ${fmt(price - this.data.credits)} more.`;
    this.data.credits -= price;
    (this.data.boughtMods[carId] ??= {})[key] = stage;
    this.save();
    (this as { onChange?: () => void }).onChange?.();
    return `✓ Stage ${stage} ${key} installed (${fmt(price)}).`;
  }

  async buyAuctionCar(carId: string, priceCr: number): Promise<string> {
    const cost = Math.max(0, Math.round(priceCr));
    if (!this.testingMode) {
      if (this.data.credits < cost) return `Need ${fmt(cost - this.data.credits)} more to win this auction.`;
      this.data.credits -= cost;
    }
    this.data.soldCars = this.data.soldCars.filter((x) => x !== carId);
    if (!this.data.auctionOwned.includes(carId)) this.data.auctionOwned.push(carId);
    this.save();
    (this as { onChange?: () => void }).onChange?.();
    return `✓ Auction won for ${this.testingMode ? 'FREE (Testing)' : fmt(cost)}! Added to your Garage.`;
  }

  async sellAuctionCar(carId: string, netPayoutCr: number): Promise<string> {
    if (!this.ownsSellable(carId)) return 'Cannot sell the free untradeable Stock Loaner.';
    const payout = Math.max(0, Math.round(netPayoutCr));
    if (!this.testingMode) {
      this.data.credits += payout;
      this.data.auctionOwned = this.data.auctionOwned.filter((x) => x !== carId);
      if (!this.data.soldCars.includes(carId)) this.data.soldCars.push(carId);
      // Clear bought stage mods on sold chassis so re-buying starts fresh
      delete this.data.boughtMods[carId];
      this.save();
    }
    (this as { onChange?: () => void }).onChange?.();
    return `✓ Sold to Auction House! +${fmt(payout)} credited to your balance.`;
  }

  fit(sel: Selection) { fitSel(this, sel); }

  /** Spend reputation: an impound fine, or paying to lay low (docs/design/heat-and-cops.md). */
  penalty(xp: number): number {
    if (this.testingMode) return this.xp;
    this.data.xp = Math.max(0, this.data.xp - Math.max(0, Math.round(xp)));
    this.save();
    (this as { onChange?: () => void }).onChange?.();
    return this.data.xp;
  }

  /** Add XP + matching Single-Player Auction Credits; returns what it did (level-ups, newly unlocked items). */
  earn(xp: number, reason: string, parts?: Earned['parts']): Earned {
    const before = this.level;
    const gainXp = Math.max(0, Math.round(xp));
    const gainCr = Math.round(gainXp * 16);
    this.data.xp += gainXp;
    this.data.credits += gainCr;
    this.save();
    const after = this.level, unlocked: string[] = [];
    if (after > before) {
      for (const [id, r] of Object.entries(CAR_REQ)) {
        if (r.spLevel > before && r.spLevel <= after) {
          this.data.soldCars = this.data.soldCars.filter((x) => x !== id);
          unlocked.push(`car:${id}`);
        }
      }
      for (const [id, r] of Object.entries(SKIN_REQ)) if (r.spLevel > before && r.spLevel <= after) unlocked.push(`skin:${id}`);
      for (const k of MOD_KEYS) MOD_REQ[k].forEach((r, i) => { if (r.spLevel > before && r.spLevel <= after) unlocked.push(`mod:${k}:${i + 1}`); });
      this.save();
    }
    this.last = { xp: gainXp, cr: gainCr, reason, parts, levelUp: after > before ? after : undefined, unlocked };
    return this.last;
  }
}

// ---- online --------------------------------------------------------------------------------------------------------------
export class MpCareer implements Career {
  readonly kind = 'mp' as const;
  last: Earned | null = null;
  profile: Profile | null = null;
  note = 'Connecting to the online service…';
  onChange = () => {};

  constructor(readonly cloud: Cloud, private catalog: CatalogCar[]) {}

  get ready() { return !!this.profile; }
  get xp() { return this.profile?.xp ?? 0; }
  get credits() { return this.profile?.credits ?? 0; }
  get level() { return levelOf(this.xp).level; }
  ownsSellable(car: string) { return !!this.profile?.cars.includes(car); }
  isUsingLoaner(catalogIds: string[]) { return !catalogIds.some((id) => this.ownsSellable(id)); }
  owns(car: string) { return car === STARTER_CAR || !!this.profile?.cars.includes(car); }
  stage(car: string, k: ModKey) { return this.profile?.mods[car]?.[k] ?? 0; }
  ownsSkin(id: string) { return id === SKINS[0].id || !!this.profile?.skins.includes(id); }
  req = reqOf;
  fit(sel: Selection) { if (this.profile) fitSel(this, sel); }

  /** Load (and on first use create) the online account. */
  async refresh() {
    if (!this.cloud.available) { this.note = 'The online service is not set up for this build.'; this.onChange(); return; }
    try { this.profile = await this.cloud.me(); this.note = ''; }
    catch (e) { this.note = `Online service unreachable: ${(e as Error).message}`; }
    this.onChange();
  }

  async buy(kind: 'car' | 'mod' | 'skin', id: string, stage?: number) {
    if (!this.profile) return this.note;
    const r = reqOf(kind, id, stage);
    if (this.level < r.mpLevel) return `Needs online level ${r.mpLevel}.`;
    try {
      this.profile = await this.cloud.buy(kind, id, stage);
      this.onChange();
      const name = kind === 'car' ? this.catalog.find((c) => c.id === id)?.name ?? id : kind === 'skin' ? (SKINS.find((s) => s.id === id)?.name ?? id) + ' gear' : 'Upgrade';
      return `✓ ${name} bought.`;
    } catch (e) { return (e as Error).message; }
  }

  async buyAuctionCar(carId: string, _priceCr: number) {
    return this.buy('car', carId);
  }

  async sellAuctionCar(_carId: string, _netPayoutCr: number) {
    return 'Online server-authoritative sell sync activates once the cloud worker is deployed. Switch to Single Player to trade live locally.';
  }

  /** The server paid a race (from the race room's result message). */
  paid(e: Earned, profile: Profile) { this.profile = profile; this.last = e; this.onChange(); }
}
