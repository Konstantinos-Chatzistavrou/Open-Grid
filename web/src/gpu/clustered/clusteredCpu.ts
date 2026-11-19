// Engine-agnostic Clustered Forward+ CPU light packer & Z-slice sorter (ZERO Three.js imports).
// Pre-transforms active dynamic lights (PointLight + SpotLight) into view space once per frame,
// computes minimal bounding spheres for SpotLight headlight cones, sorts by view-Z, and packs
// 16-byte-aligned SoA TypedArrays ready for WebGPU storage buffer upload.
import { transformPointMat4, type Mat4Like } from '../math';

export interface ClusteredGridConfig {
  maxLights: number;
  tilesX: number;
  tilesY: number;
  zSlices: number;
  maxLightsPerCluster: number;
}

export const DEFAULT_CLUSTERED_CONFIG: ClusteredGridConfig = {
  maxLights: 512,
  tilesX: 24,
  tilesY: 14,
  zSlices: 16,
  maxLightsPerCluster: 32,
};

export interface ClusterCameraInput {
  /** Column-major world -> view matrix (16 floats). */
  viewMatrix: Mat4Like;
  /** Column-major projection matrix (16 floats). */
  projectionMatrix: Mat4Like;
  near: number;
  far: number;
}

export interface ClusterLightInput {
  kind: 'point' | 'spot';
  /** World-space position (x, y, z). */
  posX: number;
  posY: number;
  posZ: number;
  /** Linear RGB color (pre-intensity or unscaled; multiplied by `intensity`). */
  r: number;
  g: number;
  b: number;
  intensity: number;
  range: number;
  decay: number;
  /** SpotLight only: world-space target point (x, y, z), outer half-angle (rad), penumbra [0..1]. */
  targetX?: number;
  targetY?: number;
  targetZ?: number;
  angle?: number;
  penumbra?: number;
}

export interface ClusteredForwardStats {
  tilesX: number;
  tilesY: number;
  zSlices: number;
  totalClusters: number;
  maxLights: number;
  maxLightsPerCluster: number;
  activePointLights: number;
  activeSpotLights: number;
  totalActiveClustered: number;
  materialForwardLights: number;
  lastUploadMs: number;
}

/**
 * Pure CPU packing & view-space Z-sorting kernel for Clustered Forward+.
 * Owns pre-allocated TypedArrays so per-frame updates generate ZERO garbage.
 */
export class ClusteredLightPacker {
  readonly cfg: ClusteredGridConfig;
  readonly chunksPerCluster: number;

  // GPU-ready SoA output arrays (16-byte aligned vec4 / ivec4)
  readonly posRange: Float32Array;     // vec4: viewPos.xyz, range
  readonly colorDecay: Float32Array;   // vec4: color.rgb * intensity, decay
  readonly spotDirCos: Float32Array;   // vec4: viewDir.xyz, coneCos (-2.0 for point lights)
  readonly cullSpheres: Float32Array;  // vec4: cullCenterView.xyz, cullRadius
  readonly spotPenumbra: Float32Array; // f32:  penumbraCos
  readonly zSliceRanges: Int32Array;   // ivec4: [start, end, 0, 0] per Z-slice

  // Reusable scratch buffers
  private readonly sViewZ: Float32Array;
  private readonly sCullX: Float32Array;
  private readonly sCullY: Float32Array;
  private readonly sCullZ: Float32Array;
  private readonly sCullR: Float32Array;
  private readonly sPosX: Float32Array;
  private readonly sPosY: Float32Array;
  private readonly sPosZ: Float32Array;
  private readonly sRange: Float32Array;
  private readonly sColR: Float32Array;
  private readonly sColG: Float32Array;
  private readonly sColB: Float32Array;
  private readonly sDecay: Float32Array;
  private readonly sDirX: Float32Array;
  private readonly sDirY: Float32Array;
  private readonly sDirZ: Float32Array;
  private readonly sConeCos: Float32Array;
  private readonly sPenCos: Float32Array;
  private readonly sortOrder: number[] = [];

  private readonly tmpPos: [number, number, number] = [0, 0, 0];
  private readonly tmpTgt: [number, number, number] = [0, 0, 0];

  readonly stats: ClusteredForwardStats;

  constructor(config: Partial<ClusteredGridConfig> = {}) {
    const cfg: ClusteredGridConfig = { ...DEFAULT_CLUSTERED_CONFIG, ...config };
    this.cfg = cfg;
    this.chunksPerCluster = Math.ceil(cfg.maxLightsPerCluster / 4);
    const M = cfg.maxLights;

    this.posRange = new Float32Array(M * 4);
    this.colorDecay = new Float32Array(M * 4);
    this.spotDirCos = new Float32Array(M * 4);
    this.cullSpheres = new Float32Array(M * 4);
    this.spotPenumbra = new Float32Array(M);
    this.zSliceRanges = new Int32Array(cfg.zSlices * 4);

    this.sViewZ = new Float32Array(M);
    this.sCullX = new Float32Array(M);
    this.sCullY = new Float32Array(M);
    this.sCullZ = new Float32Array(M);
    this.sCullR = new Float32Array(M);
    this.sPosX = new Float32Array(M);
    this.sPosY = new Float32Array(M);
    this.sPosZ = new Float32Array(M);
    this.sRange = new Float32Array(M);
    this.sColR = new Float32Array(M);
    this.sColG = new Float32Array(M);
    this.sColB = new Float32Array(M);
    this.sDecay = new Float32Array(M);
    this.sDirX = new Float32Array(M);
    this.sDirY = new Float32Array(M);
    this.sDirZ = new Float32Array(M);
    this.sConeCos = new Float32Array(M);
    this.sPenCos = new Float32Array(M);

    this.stats = {
      tilesX: cfg.tilesX,
      tilesY: cfg.tilesY,
      zSlices: cfg.zSlices,
      totalClusters: cfg.tilesX * cfg.tilesY * cfg.zSlices,
      maxLights: M,
      maxLightsPerCluster: cfg.maxLightsPerCluster,
      activePointLights: 0,
      activeSpotLights: 0,
      totalActiveClustered: 0,
      materialForwardLights: 0,
      lastUploadMs: 0,
    };
  }

  /**
   * Transform and pack active lights into the SoA arrays + per-Z-slice culling ranges.
   * Accepts an iterator callback `forEachLight` so adapters need not allocate intermediate light objects.
   */
  pack(
    camera: ClusterCameraInput,
    count: number,
    readLight: (index: number, out: ClusterLightInput) => boolean,
  ): number {
    const t0 = performance.now();
    const vm = camera.viewMatrix;
    const near = Math.max(camera.near, 0.01);
    const far = Math.max(camera.far, near + 1);
    const maxL = this.cfg.maxLights;
    const NZ = this.cfg.zSlices;

    const scratchLight: ClusterLightInput = {
      kind: 'point',
      posX: 0, posY: 0, posZ: 0,
      r: 1, g: 1, b: 1,
      intensity: 0, range: 0, decay: 2,
    };

    let activeCount = 0;
    let pointCount = 0;
    let spotCount = 0;

    for (let i = 0; i < count && activeCount < maxL; i++) {
      if (!readLight(i, scratchLight)) continue;
      if (scratchLight.intensity <= 0.001) continue;
      const range = scratchLight.range > 0 ? scratchLight.range : far;
      if (range <= 0.05) continue;

      const vp = transformPointMat4(vm, scratchLight.posX, scratchLight.posY, scratchLight.posZ, this.tmpPos);
      let cullX = vp[0], cullY = vp[1], cullZ = vp[2], cullR = range;
      let dirX = 0, dirY = 0, dirZ = -1;
      let coneCos = -2.0;
      let penCos = -2.0;

      if (scratchLight.kind === 'spot') {
        const vt = transformPointMat4(
          vm,
          scratchLight.targetX ?? scratchLight.posX,
          scratchLight.targetY ?? scratchLight.posY - 1,
          scratchLight.targetZ ?? scratchLight.posZ - 1,
          this.tmpTgt,
        );
        let dx = vt[0] - vp[0], dy = vt[1] - vp[1], dz = vt[2] - vp[2];
        const len = Math.hypot(dx, dy, dz);
        if (len > 1e-5) { dx /= len; dy /= len; dz /= len; }
        else { dx = 0; dy = 0; dz = -1; }
        dirX = dx; dirY = dy; dirZ = dz;

        const angle = Math.max(0.01, Math.min(Math.PI * 0.49, scratchLight.angle ?? 0.42));
        const penumbra = Math.max(0, Math.min(0.999, scratchLight.penumbra ?? 0.5));
        const cosA = Math.cos(angle);
        coneCos = cosA;
        penCos = Math.cos(angle * (1 - penumbra));

        // Tight minimal bounding sphere of finite spotlight cone
        if (angle > Math.PI * 0.25) {
          const offset = range * cosA;
          cullX = vp[0] + dx * offset;
          cullY = vp[1] + dy * offset;
          cullZ = vp[2] + dz * offset;
          cullR = range * Math.sin(angle);
        } else {
          const d = range / (2.0 * cosA);
          cullX = vp[0] + dx * d;
          cullY = vp[1] + dy * d;
          cullZ = vp[2] + dz * d;
          cullR = d;
        }
        spotCount++;
      } else {
        pointCount++;
      }

      // View-Z frustum reject
      if (cullZ - cullR > -near || cullZ + cullR < -far) continue;

      const idx = activeCount++;
      this.sViewZ[idx] = cullZ;
      this.sCullX[idx] = cullX;
      this.sCullY[idx] = cullY;
      this.sCullZ[idx] = cullZ;
      this.sCullR[idx] = cullR;
      this.sPosX[idx] = vp[0];
      this.sPosY[idx] = vp[1];
      this.sPosZ[idx] = vp[2];
      this.sRange[idx] = range;
      this.sColR[idx] = scratchLight.r * scratchLight.intensity;
      this.sColG[idx] = scratchLight.g * scratchLight.intensity;
      this.sColB[idx] = scratchLight.b * scratchLight.intensity;
      this.sDecay[idx] = scratchLight.decay;
      this.sDirX[idx] = dirX;
      this.sDirY[idx] = dirY;
      this.sDirZ[idx] = dirZ;
      this.sConeCos[idx] = coneCos;
      this.sPenCos[idx] = penCos;
      this.sortOrder[idx] = idx;
    }

    this.sortOrder.length = activeCount;
    const vz = this.sViewZ;
    this.sortOrder.sort((a, b) => vz[a] - vz[b]);

    for (let i = 0; i < activeCount; i++) {
      const s = this.sortOrder[i];
      const o = i * 4;
      this.posRange[o] = this.sPosX[s];
      this.posRange[o + 1] = this.sPosY[s];
      this.posRange[o + 2] = this.sPosZ[s];
      this.posRange[o + 3] = this.sRange[s];

      this.colorDecay[o] = this.sColR[s];
      this.colorDecay[o + 1] = this.sColG[s];
      this.colorDecay[o + 2] = this.sColB[s];
      this.colorDecay[o + 3] = this.sDecay[s];

      this.spotDirCos[o] = this.sDirX[s];
      this.spotDirCos[o + 1] = this.sDirY[s];
      this.spotDirCos[o + 2] = this.sDirZ[s];
      this.spotDirCos[o + 3] = this.sConeCos[s];

      this.cullSpheres[o] = this.sCullX[s];
      this.cullSpheres[o + 1] = this.sCullY[s];
      this.cullSpheres[o + 2] = this.sCullZ[s];
      this.cullSpheres[o + 3] = this.sCullR[s];

      this.spotPenumbra[i] = this.sPenCos[s];
    }

    const ratio = far / near;
    for (let z = 0; z < NZ; z++) {
      const sliceNear = -(near * Math.pow(ratio, z / NZ));
      const sliceFar = -(near * Math.pow(ratio, (z + 1) / NZ));
      let start = activeCount;
      let end = 0;
      for (let i = 0; i < activeCount; i++) {
        const s = this.sortOrder[i];
        const cz = this.sCullZ[s];
        const r = this.sCullR[s];
        if (cz + r >= sliceFar && cz - r <= sliceNear) {
          if (i < start) start = i;
          if (i + 1 > end) end = i + 1;
        }
      }
      if (start >= activeCount) {
        start = 0;
        end = 0;
      }
      this.zSliceRanges[z * 4] = start;
      this.zSliceRanges[z * 4 + 1] = end;
      this.zSliceRanges[z * 4 + 2] = 0;
      this.zSliceRanges[z * 4 + 3] = 0;
    }

    this.stats.activePointLights = pointCount;
    this.stats.activeSpotLights = spotCount;
    this.stats.totalActiveClustered = activeCount;
    this.stats.lastUploadMs = Math.round((performance.now() - t0) * 100) / 100;
    return activeCount;
  }
}
