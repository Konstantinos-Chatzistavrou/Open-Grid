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
  const camY = Math.max(camPos[1], roadY + 0.35);

  const lookX = camPos[0] + camForward[0] * 40;
  const lookY = camPos[1] + camForward[1] * 40;
  const lookZ = camPos[2] + camForward[2] * 40;

  out.position[0] = camPos[0];
  out.position[1] = 2 * roadY - camY;
  out.position[2] = camPos[2];

  out.lookAt[0] = lookX;
  out.lookAt[1] = 2 * roadY - lookY;
  out.lookAt[2] = lookZ;

  out.fovYDeg = fovYDeg;
  out.aspect = aspect;
  out.near = Math.max(0.3, Math.min(2.0, (camY - roadY) * 0.45));
  out.far = Math.min(360, far);

  makeLookAt(
    out.position[0], out.position[1], out.position[2],
    out.lookAt[0], out.lookAt[1], out.lookAt[2],
    0, 1, 0,
    out.viewMatrix,
  );
  makePerspective(out.fovYDeg, out.aspect, out.near, out.far, input.depthZeroToOne ?? true, out.projectionMatrix);
  mulMat4(out.projectionMatrix, out.viewMatrix, out.viewProjMatrix);
  return out;
}
