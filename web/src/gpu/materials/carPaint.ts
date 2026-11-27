// Engine-agnostic Dual-Layer PBR Car Paint state, finish presets, gameplay-driven wear model,
// and std140 UBO packer (ZERO Three.js imports; maps 1:1 to a UE5 Material Parameter Collection).
import type { Mat4Like, Vec3Tuple } from '../math';
import { pubUrl } from '../../assetBase';
import carPaintWgslSource from './car_paint.wgsl?raw';

export { carPaintWgslSource };

/** Path to the shared 512x512 tileable RGBA dirt/splatter/streak mask (also stored in assets_source/textures/ for UE5). */
export const CAR_DIRT_MASK_TEXTURE_PATH = pubUrl('/assets/textures/car_dirt_mask_rgba.png');

export type CarPaintFinishName = 'gloss' | 'satin' | 'metallic' | 'pearl' | 'candy' | 'matte';

export interface CarPaintFinishSpec {
  clearcoat: number;
  clearcoatRoughness: number;
  roughness: number;
  metalness: number;
  flakeStrength: number;
  flopStrength: number;
}

/** Shared automotive finish presets (mirrors `data/materials/car_paint_finishes.json` for WebGPU & UE5 Substrate). */
export const CAR_PAINT_FINISHES: Record<CarPaintFinishName, CarPaintFinishSpec> = {
  gloss:    { clearcoat: 1.0,  clearcoatRoughness: 0.020, roughness: 0.22, metalness: 0.45, flakeStrength: 0.18, flopStrength: 0.32 },
  satin:    { clearcoat: 0.35, clearcoatRoughness: 0.120, roughness: 0.42, metalness: 0.32, flakeStrength: 0.08, flopStrength: 0.18 },
  metallic: { clearcoat: 1.0,  clearcoatRoughness: 0.028, roughness: 0.18, metalness: 0.88, flakeStrength: 0.48, flopStrength: 0.58 },
  pearl:    { clearcoat: 1.0,  clearcoatRoughness: 0.020, roughness: 0.20, metalness: 0.65, flakeStrength: 0.36, flopStrength: 0.85 },
  candy:    { clearcoat: 1.0,  clearcoatRoughness: 0.012, roughness: 0.14, metalness: 0.94, flakeStrength: 0.55, flopStrength: 0.72 },
  matte:    { clearcoat: 0.04, clearcoatRoughness: 0.500, roughness: 0.72, metalness: 0.15, flakeStrength: 0.00, flopStrength: 0.06 },
};

export interface CarPaintUniformData {
  invModel: Mat4Like;
  baseColor: Vec3Tuple;
  metalness: number;
  liveryColor: Vec3Tuple;
  liveryStyle: number;
  glowColor: Vec3Tuple;
  glowAmt: number;
  roughness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  flopStrength: number;
  flakeStrength: number;
  wear: number;
  scuff: number;
  wakeSpray: number;
  bottomY: number;
  topY: number;
}

/** Byte size of WGSL `CarPaintUniforms` (16-byte aligned std140 = 40 floats = 160 bytes). */
export const CAR_PAINT_UBO_FLOATS = 40;
export const CAR_PAINT_UBO_BYTES = CAR_PAINT_UBO_FLOATS * 4;

/** Pack `CarPaintUniformData` into a 40-float `Float32Array` matching `CarPaintUniforms` in `car_paint.wgsl`. */
export function packCarPaintUniforms(d: CarPaintUniformData, out = new Float32Array(CAR_PAINT_UBO_FLOATS)): Float32Array {
  for (let i = 0; i < 16; i++) out[i] = d.invModel[i];
  out[16] = d.baseColor[0]; out[17] = d.baseColor[1]; out[18] = d.baseColor[2]; out[19] = d.metalness;
  out[20] = d.liveryColor[0]; out[21] = d.liveryColor[1]; out[22] = d.liveryColor[2]; out[23] = d.liveryStyle;
  out[24] = d.glowColor[0]; out[25] = d.glowColor[1]; out[26] = d.glowColor[2]; out[27] = d.glowAmt;
  out[28] = d.roughness; out[29] = d.clearcoat; out[30] = d.clearcoatRoughness; out[31] = d.flopStrength;
  out[32] = d.flakeStrength; out[33] = d.wear; out[34] = d.scuff; out[35] = d.bottomY;
  out[36] = d.topY; out[37] = d.wakeSpray; out[38] = 0; out[39] = 0;
  return out;
}

/** Gameplay-driven car paint wear state (portable 1:1 to a UE5 Material Parameter Collection). */
export interface PaintWearAccumulator {
  driveTimeSec: number;
  distanceKm: number;
  /** Overall wet-street road grime & flank splatter [0..1]. */
  wear: number;
  /** Wall-scrape & crash-dent dark matte scuffing [0..1]. */
  scuff: number;
  /** Front-nose & hood mist accumulated while drafting close behind another car [0..1]. */
  wakeSpray: number;
  /** Cumulative high-slip drift seconds (for telemetry/achievements). */
  driftTimeSec: number;
}

export interface PaintWearFrameInput {
  /** Vehicle planar speed (m/s). */
  speedMs: number;
  /** Frame delta time (s). */
  dtSec: number;
  /** Absolute vehicle sideslip angle (rad) — drifting kicks up heavy flank/wheel-arch spray. */
  sideslipRad?: number;
  /** Road wetness factor [0..1] (1.0 = wet night rain streets). */
  wetRoad?: number;
  /** Instantaneous wall/pole/rival scrape impulse this frame (N*s, 0 if none). */
  scrapeImpulse?: number;
  /** Normalized overall chassis crash damage [0..1] from physics core. */
  damageLevel?: number;
  /** Drafting proximity [0..1] when following closely in another car's spray wake. */
  draftingFactor?: number;
}

export function createPaintWearState(): PaintWearAccumulator {
  return { driveTimeSec: 0, distanceKm: 0, wear: 0, scuff: 0, wakeSpray: 0, driftTimeSec: 0 };
}

/** Reset paint wear to showroom-clean (e.g. garage wash / car repair). */
export function resetPaintWear(state: PaintWearAccumulator): PaintWearAccumulator {
  state.driveTimeSec = 0;
  state.distanceKm = 0;
  state.wear = 0;
  state.scuff = 0;
  state.wakeSpray = 0;
  state.driftTimeSec = 0;
  return state;
}

/**
 * Advance dynamic paint wear from real gameplay events (speed, drifting, wet roads, wall scrapes,
 * crash damage, and drafting behind rival cars). Pure deterministic step; zero engine dependencies.
 */
export function advancePaintWear(
  state: PaintWearAccumulator,
  input: PaintWearFrameInput,
): PaintWearAccumulator {
  const dt = Math.max(0, Math.min(0.25, input.dtSec));
  const speed = Math.max(0, input.speedMs);
  const wet = Math.max(0, Math.min(1, input.wetRoad ?? 1.0));
  const slip = Math.abs(input.sideslipRad ?? 0);
  const drafting = Math.max(0, Math.min(1, input.draftingFactor ?? 0));
  const damage = Math.max(0, Math.min(1, input.damageLevel ?? 0));
  const impulse = Math.max(0, input.scrapeImpulse ?? 0);

  if (speed > 1.5 && dt > 0) {
    state.driveTimeSec += dt;
    state.distanceKm += (speed * dt) / 1000;

    // Speed-scaled road spray + strong drift kick-up multiplier (up to 4x while sliding sideways)
    const speedFactor = Math.min(1.8, speed / 22.0);
    const driftFactor = slip > 0.12 ? Math.min(3.0, (slip - 0.12) * 5.0) : 0;
    if (driftFactor > 0.25) state.driftTimeSec += dt;

    const wetMult = 0.45 + 0.85 * wet;
    const baseRate = 1 / 220; // ~3.5 min of brisk wet-street driving to heavy patina
    state.wear = Math.min(1, state.wear + dt * baseRate * speedFactor * wetMult * (1 + driftFactor));

    // Following closely behind another car on wet asphalt coats the nose & hood rapidly
    if (drafting > 0.05 && speed > 8) {
      state.wakeSpray = Math.min(1, state.wakeSpray + dt * 0.045 * drafting * wetMult * speedFactor);
    }
  }

  // Wall scrapes & crash damage immediately add dark matte scuffing around flanks/bumpers
  if (impulse > 400) {
    state.scuff = Math.min(1, state.scuff + Math.min(0.35, impulse / 12000));
  }
  if (damage > state.scuff * 0.85) {
    state.scuff = Math.min(1, Math.max(state.scuff, damage * 0.85));
  }

  return state;
}
