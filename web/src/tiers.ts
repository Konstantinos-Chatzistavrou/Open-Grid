// Apache-2.0 - the free-roam feature tiers: how many cars and people the world has at each graphics preset (docs/minimum_spec.md). Pure: no three.js, no DOM.
//
// The MINIMUM configuration is the 'low' preset at 1280x720 held at 30 fps on the maintainer's laptop (an i3-1315U with 7.4 GiB, integrated graphics). Every tier above it
// adds cars and people; features scale with the hardware instead of requiring it. `measured` is true only where the counts were run on the minimum laptop: 'low' (background traffic up to
// MEASURED_LOW_TRAFFIC cars cost nothing above the noise, docs/minimum_spec.md). The other tiers are budgets that need a stronger machine, and `measured` says so.
// The adaptive tuner (main.ts) moves between presets at run time, and the counts follow it.
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
  potato: { rivalCars: 5, backgroundTraffic: 8, pedestrians: 0, measured: false },    // phones: a few cars so the street is not empty; not measured on a phone
  low: { rivalCars: 5, backgroundTraffic: 32, pedestrians: 0, measured: true },       // the minimum, measured on it with up to 256 cars; pedestrians do not exist yet
  medium: { rivalCars: 5, backgroundTraffic: 48, pedestrians: 16, measured: false },
  high: { rivalCars: 5, backgroundTraffic: 64, pedestrians: 32, measured: false },
  ultra: { rivalCars: 5, backgroundTraffic: 96, pedestrians: 64, measured: false },
  max: { rivalCars: 5, backgroundTraffic: 128, pedestrians: 96, measured: false },
};

/** The most background cars run on the minimum configuration (web/tools/probes/traffic_cost.js): their frame-time cost was below the noise. 'low' must not be set above it. */
export const MEASURED_LOW_TRAFFIC = 256;

/** The preset names from the cheapest to the dearest, the order the counts must not decrease along. */
export const TIER_ORDER: PresetName[] = ['potato', 'low', 'medium', 'high', 'ultra', 'max'];

export const tierFor = (preset: PresetName): FeatureTier => TIERS[preset] ?? TIERS.low;
