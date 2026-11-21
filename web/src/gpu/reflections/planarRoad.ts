// Engine-agnostic Real-Time Planar Wet-Road Reflection Camera Math (ZERO Three.js imports).
// Computes a right-handed (det = +1) virtual camera mirrored across the horizontal road plane `y = roadY`:
//   - Standard front-face winding (zero inverted-cull pipelines)
//   - Upward-facing single-sided road meshes naturally back-face cull from underneath
//   - Produces exact view, projection, and viewProj matrices ready for any WebGPU / wgpu renderer.
import { makeLookAt, makePerspective, mulMat4, type Vec3Tuple } from '../math';
import roadReflectionsWgslSource from './road_reflections.wgsl?raw';

export { roadReflectionsWgslSource };

export interface PlanarCameraInput {
  camPos: Vec3Tuple;
  camForward: Vec3Tuple;
  fovYDeg: number;
  aspect: number;
  far: number;
  roadY: number;
  /** The road plane's unit normal (default straight up) and a point on it (default under the camera at roadY): a city on
   *  hills mirrors across the slope under the car, not a horizontal plane at its height. */
  normal?: Vec3Tuple;
  planePoint?: Vec3Tuple;
  /** True for native WebGPU depth [0, 1]; false for OpenGL [-1, 1]. */
  depthZeroToOne?: boolean;
}

export interface PlanarCameraOutput {
  position: [number, number, number];
  lookAt: [number, number, number];
  near: number;
  far: number;
  fovYDeg: number;
  aspect: number;
  viewMatrix: Float32Array;
  projectionMatrix: Float32Array;
  viewProjMatrix: Float32Array;
}

const UP: Vec3Tuple = [0, 1, 0];

export function createPlanarCameraOutput(): PlanarCameraOutput {
  return {
    position: [0, -1, 0],
    lookAt: [0, 0, -10],
    near: 0.35,
    far: 320,
    fovYDeg: 60,
    aspect: 16 / 9,
    viewMatrix: new Float32Array(16),
    projectionMatrix: new Float32Array(16),
    viewProjMatrix: new Float32Array(16),
  };
}

/**
 * Compute the mirrored right-handed planar reflection camera for road elevation `roadY`.
 * Writes in-place into `out` (zero per-frame heap allocations).
 */
export function computePlanarReflectionCamera(
  input: PlanarCameraInput,
  out: PlanarCameraOutput,
): PlanarCameraOutput {
  const { camPos, camForward, fovYDeg, aspect, far, roadY } = input;
  const n = input.normal ?? UP, P0 = input.planePoint ?? [camPos[0], roadY, camPos[2]];
  const dist = (x: number, y: number, z: number) => (x - P0[0]) * n[0] + (y - P0[1]) * n[1] + (z - P0[2]) * n[2];
  // the camera at least 0.35 m above the plane, then mirrored across it (horizontal plane: y' = 2 * roadY - y)
  const dc = dist(camPos[0], camPos[1], camPos[2]), camD = Math.max(dc, 0.35), kc = dc + camD;
  out.position[0] = camPos[0] - kc * n[0];
  out.position[1] = camPos[1] - kc * n[1];
  out.position[2] = camPos[2] - kc * n[2];

  const lookX = camPos[0] + camForward[0] * 40;
  const lookY = camPos[1] + camForward[1] * 40;
  const lookZ = camPos[2] + camForward[2] * 40;
  const kl = 2 * dist(lookX, lookY, lookZ);
  out.lookAt[0] = lookX - kl * n[0];
  out.lookAt[1] = lookY - kl * n[1];
  out.lookAt[2] = lookZ - kl * n[2];

  out.fovYDeg = fovYDeg;
  out.aspect = aspect;
  out.near = Math.max(0.3, Math.min(2.0, camD * 0.45));
  out.far = Math.min(360, far);

  makeLookAt(
    out.position[0], out.position[1], out.position[2],
    out.lookAt[0], out.lookAt[1], out.lookAt[2],
    n[0], n[1], n[2],
    out.viewMatrix,
  );
  makePerspective(out.fovYDeg, out.aspect, out.near, out.far, input.depthZeroToOne ?? true, out.projectionMatrix);
  mulMat4(out.projectionMatrix, out.viewMatrix, out.viewProjMatrix);
  return out;
}
