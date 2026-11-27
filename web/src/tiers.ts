// Apache-2.0 - the free-roam feature tiers: how many cars and people the world has at each graphics preset (docs/minimum_spec.md). Pure: no three.js, no DOM.
//
// The MINIMUM configuration is the 'low' preset at 1280x720 held at 30 fps on the maintainer's laptop (an i3-1315U with 7.4 GiB, integrated graphics). Every tier above it
// adds cars and people; features scale with the hardware instead of requiring it. The numbers are BUDGETS: only 'low' has been measured (on that laptop); the others are
// estimates that need a stronger machine, and `measured` says so. The adaptive tuner (main.ts) moves between presets at run time, and the counts follow it.
import type { PresetName } from './post';

export interface FeatureTier {
  /** detailed cars (own model, damage rig, headlight and physics body) cruising the route loop: the same cars that are the race rivals. Kept at 5 everywhere. */
  rivalCars: number;
  /** cheap instanced cars on the street graph (trafficSim.ts, cityTraffic.ts) */
  backgroundTraffic: number;
  /** cheap instanced people on the pavements */
  pedestrians: number;
  /** true once this tier's numbers have been measured to hold the 30 fps lock on a real device */
  measured: boolean;
}

export const TIERS: Record<PresetName, FeatureTier> = {
  potato: { rivalCars: 5, backgroundTraffic: 0, pedestrians: 0, measured: false },    // phones: nothing added until measured on one
  low: { rivalCars: 5, backgroundTraffic: 12, pedestrians: 0, measured: false },      // the minimum: the number is set by the measurement in docs/minimum_spec.md
  medium: { rivalCars: 5, backgroundTraffic: 24, pedestrians: 16, measured: false },
  high: { rivalCars: 5, backgroundTraffic: 36, pedestrians: 32, measured: false },
  ultra: { rivalCars: 5, backgroundTraffic: 48, pedestrians: 64, measured: false },
  max: { rivalCars: 5, backgroundTraffic: 64, pedestrians: 96, measured: false },
};

/** The preset names from the cheapest to the dearest, the order the counts must not decrease along. */
export const TIER_ORDER: PresetName[] = ['potato', 'low', 'medium', 'high', 'ultra', 'max'];

export const tierFor = (preset: PresetName): FeatureTier => TIERS[preset] ?? TIERS.low;
