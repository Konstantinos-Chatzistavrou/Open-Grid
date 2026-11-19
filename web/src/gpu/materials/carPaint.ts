// Engine-agnostic Dual-Layer PBR Car Paint state, finish presets, wear model, and std140 UBO packer (ZERO Three.js).
import type { Mat4Like, Vec3Tuple } from '../math';
import carPaintWgslSource from './car_paint.wgsl?raw';

export { carPaintWgslSource };

export type CarPaintFinishName = 'gloss' | 'satin' | 'metallic' | 'pearl' | 'candy' | 'matte';

export interface CarPaintFinishSpec {
  clearcoat: number;
  clearcoatRoughness: number;
  roughness: number;
  metalness: number;
  flakeStrength: number;
  flopStrength: number;
}

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
  driveTimeSec: number;
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
  out[32] = d.flakeStrength; out[33] = d.wear; out[34] = d.driveTimeSec; out[35] = d.bottomY;
  out[36] = d.topY; out[37] = 0; out[38] = 0; out[39] = 0;
  return out;
}

export interface PaintWearAccumulator {
  driveTimeSec: number;
  distanceKm: number;
  wear: number;
}

/** Advance dynamic paint wear from driving speed (m/s) and frame dt (s). Pure simulation step. */
export function advancePaintWear(
  state: PaintWearAccumulator,
  speedMs: number,
  dtSec: number,
  fullTimeSec = 240,
  fullDistKm = 40,
): PaintWearAccumulator {
  if (speedMs > 1.5 && dtSec > 0) {
    state.driveTimeSec += dtSec;
    state.distanceKm += (speedMs * dtSec) / 1000;
    state.wear = Math.min(1, Math.max(state.driveTimeSec / fullTimeSec, state.distanceKm / fullDistKm));
  }
  return state;
}
