// WebGPU Compute Meshlet Culler + drawIndexedIndirect Runtime ('Nanite' Pipeline, OpenGrid).
//
// Features:
//  1. Runtime meshletization via official meshoptimizer 1.1 (`MeshoptClusterizer`) OR zero-parse loading of
//     offline `.mlet` containers compiled by `web/tools/meshlet-cli.mjs`.
//  2. Two-stage WebGPU compute pipeline per batch:
//       - Reset pass: clears the 5-word DrawIndexedIndirectArgs buffer ([0, 1, 0, 0, 0]) and atomic stats.
//       - Cull + Stream-Compaction pass (@workgroup_size(64)): tests every meshlet's bounding sphere against
//         6 frustum planes + meshoptimizer normal-cone backface test + optional distance cutoff (`meshlet_cull.wgsl`).
//         Surviving meshlets atomically reserve space in `indirectArgs[0]` and compact their triangle indices
//         into `visibleIndexBuffer` (GPUBufferUsage.INDEX | STORAGE).
//  3. Single `passEncoderGPU.drawIndexedIndirect(indirectBuffer, 0)` draw call per material batch via
//     Three.js `geometry.setIndirect(indirectAttr, 0)` — zero CPU readback, zero culled triangles shaded.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  Return,
  atomicAdd,
  atomicStore,
  instanceIndex,
  int,
  storage,
  uint,
  uniform,
  wgslFn,
} from 'three/tsl';
import { MeshoptClusterizer } from 'three/addons/libs/meshopt_clusterizer.module.js';
import {
  MLET_MAGIC,
  parseMletBuffer,
  type MeshletBatchGpuStats,
  type MletGroupMeta,
  type MletMeta,
  type ParsedMlet,
} from '../gpu/meshlets/mletFormat';
import meshletCullWgslSource from '../gpu/meshlets/meshlet_cull.wgsl?raw';

export { parseMletBuffer, MLET_MAGIC, type MeshletBatchGpuStats, type MletGroupMeta, type MletMeta, type ParsedMlet };

const cullMeshletTestWgsl = wgslFn(meshletCullWgslSource);

let clusterizerReady = false;
const clusterizerPromise = MeshoptClusterizer.ready.then(() => {
  clusterizerReady = true;
});

/** Wait for the meshoptimizer WASM clusterizer to finish initializing (usually < 5 ms). */
export function ensureMeshoptClusterizer(): Promise<void> {
  return clusterizerPromise;
}

export function isMeshoptClusterizerReady(): boolean {
  return clusterizerReady;
}

export interface MeshletBuildResult {
  meshletCount: number;
  indices: Uint32Array;
  spheres: Float32Array; // vec4 * meshletCount: center.xyz, radius
  cones: Float32Array;   // vec4 * meshletCount: axis.xyz, cutoff
  apices: Float32Array;  // vec4 * meshletCount: apex.xyz, 0
  slices: Uint32Array;   // uvec4 * meshletCount: localFirstIndex, indexCount, 0, 0
}

/**
 * Partition an indexed triangle list into meshoptimizer meshlets (default 64 verts / 124 tris)
 * with bounding spheres and normal-cone backface culling bounds.
 */
export function buildMeshletsFromGeometry(
  positions: Float32Array,
  indices: Uint32Array,
  maxVerts = 64,
  maxTris = 124,
  coneWeight = 0.5,
): MeshletBuildResult {
  const ml = MeshoptClusterizer.buildMeshlets(indices, positions, 3, maxVerts, maxTris, coneWeight);
  const bounds = MeshoptClusterizer.computeMeshletBounds(ml, positions, 3);
  const count = ml.meshletCount;

  // Total expanded index count equals sum of triangleCount * 3
  let totalIdx = 0;
  for (let m = 0; m < count; m++) totalIdx += ml.meshlets[m * 4 + 3] * 3;

  const outIndices = new Uint32Array(totalIdx);
  const spheres = new Float32Array(count * 4);
  const cones = new Float32Array(count * 4);
  const apices = new Float32Array(count * 4);
  const slices = new Uint32Array(count * 4);

  let writeIdx = 0;
  for (let m = 0; m < count; m++) {
    const vOff = ml.meshlets[m * 4 + 0];
    const tOff = ml.meshlets[m * 4 + 1];
    const tCount = ml.meshlets[m * 4 + 3];
    const idxCount = tCount * 3;
    const firstIndex = writeIdx;

    for (let t = 0; t < tCount; t++) {
      outIndices[writeIdx++] = ml.vertices[vOff + ml.triangles[tOff + t * 3 + 0]];
      outIndices[writeIdx++] = ml.vertices[vOff + ml.triangles[tOff + t * 3 + 1]];
      outIndices[writeIdx++] = ml.vertices[vOff + ml.triangles[tOff + t * 3 + 2]];
    }

    const b = bounds[m];
    const o = m * 4;
    spheres[o] = b.centerX;
    spheres[o + 1] = b.centerY;
    spheres[o + 2] = b.centerZ;
    spheres[o + 3] = b.radius;

    cones[o] = b.coneAxisX;
    cones[o + 1] = b.coneAxisY;
    cones[o + 2] = b.coneAxisZ;
    cones[o + 3] = b.coneCutoff;

    apices[o] = b.coneApexX;
    apices[o + 1] = b.coneApexY;
    apices[o + 2] = b.coneApexZ;
    apices[o + 3] = 0;

    slices[o] = firstIndex;
    slices[o + 1] = idxCount;
    slices[o + 2] = 0;
    slices[o + 3] = 0;
  }

  return { meshletCount: count, indices: outIndices, spheres, cones, apices, slices };
}

const _vp = new THREE.Matrix4();
const _invWorld = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _camLocal = new THREE.Vector3();

/**
 * GPU-driven compute meshlet culler attached to a `THREE.BufferGeometry`.
 * Owns the indirect draw buffer (`IndirectStorageBufferAttribute`), the compacted visible index buffer
 * (`GPUBufferUsage.INDEX | STORAGE`), and the two WGSL compute passes (reset + cull/compact).
 */
export class GpuMeshletCuller {
  private capMeshlets = 0;
  private capIndices = 0;
  activeMeshlets = 0;
  totalIndices = 0;

  private spheresArr!: Float32Array;
  private conesArr!: Float32Array;
  private apicesArr!: Float32Array;
  private slicesArr!: Uint32Array;
  private sourceIdxArr!: Uint32Array;

  private spheresAttr!: THREE.StorageBufferAttribute;
  private conesAttr!: THREE.StorageBufferAttribute;
  private apicesAttr!: THREE.StorageBufferAttribute;
  private slicesAttr!: THREE.StorageBufferAttribute;
  private sourceIdxAttr!: THREE.StorageBufferAttribute;
  private visibleIdxAttr!: THREE.StorageBufferAttribute;
  private indirectAttr!: THREE.IndirectStorageBufferAttribute;
  private statsAttr!: THREE.StorageBufferAttribute;

  private resetCompute: THREE.ComputeNode | null = null;
  private cullCompute: THREE.ComputeNode | null = null;
  private indexRegistered = false;

  // Per-frame uniforms (camera + 6 frustum planes in object/world space)
  private readonly uActiveMeshlets = uniform(0, 'uint');
  private readonly uMaxDist = uniform(0, 'float');
  private readonly uCamPos = uniform(new THREE.Vector3());
  private readonly uPlanes = Array.from({ length: 6 }, () => uniform(new THREE.Vector4()));

  constructor(private readonly geometry: THREE.BufferGeometry, initialMeshlets = 256, initialIndices = 65536) {
    this.allocate(Math.max(64, initialMeshlets), Math.max(1024, initialIndices));
  }

  get capacityMeshlets() {
    return this.capMeshlets;
  }

  get capacityIndices() {
    return this.capIndices;
  }

  private disposePipelines() {
    this.resetCompute?.dispose();
    this.cullCompute?.dispose();
    this.resetCompute = null;
    this.cullCompute = null;
    this.indexRegistered = false;
  }

  /** Allocate or grow GPU storage & indirect buffers while preserving existing meshlet data. */
  allocate(newCapMeshlets: number, newCapIndices: number) {
    const capM = Math.max(64, newCapMeshlets);
    const capI = Math.max(1024, newCapIndices);

    const nextSpheres = new Float32Array(capM * 4);
    const nextCones = new Float32Array(capM * 4);
    const nextApices = new Float32Array(capM * 4);
    const nextSlices = new Uint32Array(capM * 4);
    const nextSrcIdx = new Uint32Array(capI);

    if (this.spheresArr) {
      const copyM = Math.min(this.activeMeshlets, capM);
      nextSpheres.set(this.spheresArr.subarray(0, copyM * 4));
      nextCones.set(this.conesArr.subarray(0, copyM * 4));
      nextApices.set(this.apicesArr.subarray(0, copyM * 4));
      nextSlices.set(this.slicesArr.subarray(0, copyM * 4));
      const copyI = Math.min(this.totalIndices, capI);
      nextSrcIdx.set(this.sourceIdxArr.subarray(0, copyI));
    }

    this.disposePipelines();

    this.capMeshlets = capM;
    this.capIndices = capI;
    this.spheresArr = nextSpheres;
    this.conesArr = nextCones;
    this.apicesArr = nextApices;
    this.slicesArr = nextSlices;
    this.sourceIdxArr = nextSrcIdx;

    this.spheresAttr = new THREE.StorageBufferAttribute(this.spheresArr, 4);
    this.conesAttr = new THREE.StorageBufferAttribute(this.conesArr, 4);
    this.apicesAttr = new THREE.StorageBufferAttribute(this.apicesArr, 4);
    this.slicesAttr = new THREE.StorageBufferAttribute(this.slicesArr, 4);
    this.sourceIdxAttr = new THREE.StorageBufferAttribute(this.sourceIdxArr, 1);

    // Compacted visible index buffer: receives INDEX | STORAGE flags when registered before compute.
    this.visibleIdxAttr = new THREE.StorageBufferAttribute(new Uint32Array(capI), 1);
    // DrawIndexedIndirectArgs: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
    this.indirectAttr = new THREE.IndirectStorageBufferAttribute(new Uint32Array([0, 1, 0, 0, 0]), 1);
    this.statsAttr = new THREE.StorageBufferAttribute(new Uint32Array(4), 1);

    this.geometry.setIndex(this.visibleIdxAttr);
    this.geometry.setIndirect(this.indirectAttr, 0);

    this.buildComputePipelines();
  }

  private buildComputePipelines() {
    const capM = this.capMeshlets;
    const capI = this.capIndices;

    const spheresBuf = storage(this.spheresAttr, 'vec4', capM).toReadOnly();
    const conesBuf = storage(this.conesAttr, 'vec4', capM).toReadOnly();
    const apicesBuf = storage(this.apicesAttr, 'vec4', capM).toReadOnly();
    const slicesBuf = storage(this.slicesAttr, 'uvec4', capM).toReadOnly();
    const srcIdxBuf = storage(this.sourceIdxAttr, 'uint', capI).toReadOnly();
    const visIdxBuf = storage(this.visibleIdxAttr, 'uint', capI);
    const indirectAtomic = storage(this.indirectAttr, 'uint', 5).toAtomic();
    const statsAtomic = storage(this.statsAttr, 'uint', 4).toAtomic();

    // Pass 1: Reset DrawIndexedIndirectArgs + GPU culling counters
    this.resetCompute = Fn(() => {
      atomicStore(indirectAtomic.element(0), uint(0));
      atomicStore(indirectAtomic.element(1), uint(1));
      atomicStore(indirectAtomic.element(2), uint(0));
      atomicStore(indirectAtomic.element(3), uint(0));
      atomicStore(indirectAtomic.element(4), uint(0));
      atomicStore(statsAtomic.element(0), uint(0));
      atomicStore(statsAtomic.element(1), uint(0));
      atomicStore(statsAtomic.element(2), uint(0));
      atomicStore(statsAtomic.element(3), uint(0));
    })()
      .compute(1, [1])
      .setName('MeshletCullReset');

    // Pass 2: Frustum + Normal-Cone Backface Culling + Atomic Index Stream Compaction
    const p0 = this.uPlanes[0], p1 = this.uPlanes[1], p2 = this.uPlanes[2];
    const p3 = this.uPlanes[3], p4 = this.uPlanes[4], p5 = this.uPlanes[5];

    this.cullCompute = Fn(() => {
      const m = instanceIndex;
      If(m.greaterThanEqual(this.uActiveMeshlets), () => {
        Return();
      });

      const slice = slicesBuf.element(m);
      const firstIndex = slice.x;
      const indexCount = slice.y;
      If(indexCount.equal(uint(0)), () => {
        Return();
      });

      const sphere = spheresBuf.element(m);
      const cone = conesBuf.element(m);
      const apex = apicesBuf.element(m);

      const code = (cullMeshletTestWgsl({
        sphere,
        cone,
        apex,
        camPos: this.uCamPos,
        p0,
        p1,
        p2,
        p3,
        p4,
        p5,
        maxDist: this.uMaxDist,
      }) as unknown as THREE.Node<'int'>).toConst();

      If(code.equal(int(0)), () => {
        // Reserve contiguous slice in the compacted visible index buffer
        const outBase = atomicAdd(indirectAtomic.element(0), indexCount).toConst();
        atomicAdd(statsAtomic.element(0), uint(1));
        atomicAdd(statsAtomic.element(3), indexCount);

        Loop({ start: uint(0), end: indexCount, type: 'uint', condition: '<' }, ({ i }) => {
          visIdxBuf.element(outBase.add(i)).assign(srcIdxBuf.element(firstIndex.add(i)));
        });
      })
        .ElseIf(code.equal(int(1)), () => {
          atomicAdd(statsAtomic.element(1), uint(1));
        })
        .Else(() => {
          atomicAdd(statsAtomic.element(2), uint(1));
        });
    })()
      .compute(capM, [64])
      .setName('MeshletCullCompact');
  }

  /**
   * Append a meshletized chunk into this GPU culler's buffers.
   * Returns the allocated meshlet/index range so callers can later disable/free it (e.g. tile unload).
   */
  append(
    ml: MeshletBuildResult,
    vertexOffset = 0,
    indexOffsetInSrc?: number,
  ): { meshletStart: number; meshletCount: number; indexStart: number; indexCount: number } {
    const needM = this.activeMeshlets + ml.meshletCount;
    const idxStart = indexOffsetInSrc ?? this.totalIndices;
    const needI = Math.max(this.totalIndices, idxStart + ml.indices.length);

    if (needM > this.capMeshlets || needI > this.capIndices) {
      this.allocate(
        Math.max(this.capMeshlets * 2, needM + 256),
        Math.max(this.capIndices * 2, needI + 16384),
      );
    }

    const mStart = this.activeMeshlets;
    const count = ml.meshletCount;

    for (let j = 0; j < ml.indices.length; j++) {
      this.sourceIdxArr[idxStart + j] = ml.indices[j] + vertexOffset;
    }

    this.spheresArr.set(ml.spheres, mStart * 4);
    this.conesArr.set(ml.cones, mStart * 4);
    this.apicesArr.set(ml.apices, mStart * 4);

    for (let m = 0; m < count; m++) {
      const o = (mStart + m) * 4;
      this.slicesArr[o] = idxStart + ml.slices[m * 4];
      this.slicesArr[o + 1] = ml.slices[m * 4 + 1];
      this.slicesArr[o + 2] = 0;
      this.slicesArr[o + 3] = 0;
    }

    this.activeMeshlets = needM;
    this.totalIndices = needI;
    this.uActiveMeshlets.value = this.activeMeshlets;

    this.sourceIdxAttr.needsUpdate = true;
    this.spheresAttr.needsUpdate = true;
    this.conesAttr.needsUpdate = true;
    this.apicesAttr.needsUpdate = true;
    this.slicesAttr.needsUpdate = true;

    return { meshletStart: mStart, meshletCount: count, indexStart: idxStart, indexCount: ml.indices.length };
  }

  /** Mark a range of meshlets dead (e.g. unloaded tile): skipped immediately in compute with zero ghost triangles. */
  disableRange(meshletStart: number, meshletCount: number) {
    const end = Math.min(this.activeMeshlets, meshletStart + meshletCount);
    for (let m = meshletStart; m < end; m++) {
      this.slicesArr[m * 4 + 1] = 0;
    }
    this.slicesAttr.needsUpdate = true;
  }

  /** Re-attach the GPU compacted index buffer and indirect draw buffer after vertex attribute rebuilds. */
  rebindGeometry() {
    this.geometry.setIndex(this.visibleIdxAttr);
    this.geometry.setIndirect(this.indirectAttr, 0);
  }

  /** Compact live meshlet ranges in-place after vertex buffer compaction (rebasing vertex indices without re-clustering). */
  compactRanges(ranges: { meshletStart: number; meshletCount: number; indexStart: number; indexCount: number; vertDelta: number }[]) {
    let totalM = 0;
    let totalI = 0;
    for (const r of ranges) {
      totalM += r.meshletCount;
      totalI += r.indexCount;
    }
    const nextIdx = new Uint32Array(Math.max(1, totalI));
    const nextSpheres = new Float32Array(Math.max(1, totalM) * 4);
    const nextCones = new Float32Array(Math.max(1, totalM) * 4);
    const nextApices = new Float32Array(Math.max(1, totalM) * 4);
    const nextSlices = new Uint32Array(Math.max(1, totalM) * 4);

    let outM = 0;
    let outI = 0;
    for (const r of ranges) {
      const oldIdxBase = r.indexStart;
      const newIdxBase = outI;
      for (let j = 0; j < r.indexCount; j++) {
        nextIdx[outI++] = this.sourceIdxArr[oldIdxBase + j] + r.vertDelta;
      }
      const mStart = r.meshletStart;
      const mCount = r.meshletCount;
      nextSpheres.set(this.spheresArr.subarray(mStart * 4, (mStart + mCount) * 4), outM * 4);
      nextCones.set(this.conesArr.subarray(mStart * 4, (mStart + mCount) * 4), outM * 4);
      nextApices.set(this.apicesArr.subarray(mStart * 4, (mStart + mCount) * 4), outM * 4);
      const idxDelta = newIdxBase - oldIdxBase;
      for (let m = 0; m < mCount; m++) {
        const so = (mStart + m) * 4;
        const doff = (outM + m) * 4;
        nextSlices[doff] = this.slicesArr[so] + idxDelta;
        nextSlices[doff + 1] = this.slicesArr[so + 1];
        nextSlices[doff + 2] = 0;
        nextSlices[doff + 3] = 0;
      }
      r.meshletStart = outM;
      r.indexStart = newIdxBase;
      outM += mCount;
    }

    this.setAll(nextIdx.subarray(0, outI), nextSpheres, nextCones, nextApices, nextSlices, outM);
  }

  /** Replace all meshlets in bulk (used after buffer compaction or loading an offline `.mlet` file). */
  setAll(
    indices: Uint32Array,
    spheres: Float32Array,
    cones: Float32Array,
    apices: Float32Array,
    slices: Uint32Array,
    meshletCount: number,
  ) {
    if (meshletCount > this.capMeshlets || indices.length > this.capIndices) {
      this.allocate(Math.max(64, meshletCount), Math.max(1024, indices.length));
    }
    this.sourceIdxArr.set(indices, 0);
    this.spheresArr.set(spheres.subarray(0, meshletCount * 4), 0);
    this.conesArr.set(cones.subarray(0, meshletCount * 4), 0);
    this.apicesArr.set(apices.subarray(0, meshletCount * 4), 0);
    this.slicesArr.set(slices.subarray(0, meshletCount * 4), 0);

    this.activeMeshlets = meshletCount;
    this.totalIndices = indices.length;
    this.uActiveMeshlets.value = meshletCount;

    this.sourceIdxAttr.needsUpdate = true;
    this.spheresAttr.needsUpdate = true;
    this.conesAttr.needsUpdate = true;
    this.apicesAttr.needsUpdate = true;
    this.slicesAttr.needsUpdate = true;
  }

  /**
   * Dispatch the WebGPU compute culling pass (reset + frustum/cone cull + index stream compaction).
   * Call once per frame before rendering the scene.
   */
  cull(renderer: THREE.WebGPURenderer, camera: THREE.Camera, worldMatrix?: THREE.Matrix4, maxDist = 0) {
    if (!this.resetCompute || !this.cullCompute) return;

    // Ensure `visibleIdxAttr` is created with GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE BEFORE the first compute dispatch!
    if (!this.indexRegistered) {
      const backend = renderer.backend as unknown as {
        isWebGPUBackend?: boolean;
        createIndexAttribute?: (attr: THREE.BufferAttribute) => void;
      };
      if (backend.isWebGPUBackend && backend.createIndexAttribute) {
        backend.createIndexAttribute(this.visibleIdxAttr);
        this.indexRegistered = true;
      } else {
        return;
      }
    }

    camera.updateMatrixWorld();
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (worldMatrix) {
      _vp.multiply(worldMatrix);
      _invWorld.copy(worldMatrix).invert();
      _camLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_invWorld);
    } else {
      _camLocal.setFromMatrixPosition(camera.matrixWorld);
    }

    _frustum.setFromProjectionMatrix(_vp, camera.coordinateSystem);
    for (let i = 0; i < 6; i++) {
      const pl = _frustum.planes[i];
      this.uPlanes[i].value.set(pl.normal.x, pl.normal.y, pl.normal.z, pl.constant);
    }
    this.uCamPos.value.copy(_camLocal);
    this.uMaxDist.value = maxDist;
    this.uActiveMeshlets.value = this.activeMeshlets;

    renderer.compute(this.resetCompute);
    if (this.activeMeshlets > 0) {
      renderer.compute(this.cullCompute);
    }
  }

  /** Async GPU readback of exact culling counters for profiling/verification (never call in hot render loop). */
  async readStats(renderer: THREE.WebGPURenderer): Promise<MeshletBatchGpuStats> {
    const ab = await renderer.getArrayBufferAsync(this.statsAttr);
    const u32 = new Uint32Array(ab);
    return {
      meshletCount: this.activeMeshlets,
      visibleMeshlets: u32[0] ?? 0,
      frustumCulled: u32[1] ?? 0,
      coneCulled: u32[2] ?? 0,
      visibleIndices: u32[3] ?? 0,
      totalIndices: this.totalIndices,
    };
  }

  dispose() {
    this.disposePipelines();
  }
}

// ---- Offline `.mlet` Binary Loader (thin Three.js adapter over `gpu/meshlets/mletFormat`) ------------------------------
export interface LoadedMeshletAsset {
  group: THREE.Group;
  meta: MletMeta;
  cullers: { mesh: THREE.Mesh; culler: GpuMeshletCuller }[];
  cull(renderer: THREE.WebGPURenderer, camera: THREE.Camera, maxDist?: number): void;
  readStats(renderer: THREE.WebGPURenderer): Promise<MeshletBatchGpuStats>;
  dispose(): void;
}

/**
 * Load an offline-compiled `.mlet` meshlet asset and build GPU-culled `drawIndexedIndirect` meshes
 * for each material group.
 */
export async function loadMeshletAsset(
  url: string,
  materialResolver?: (materialName: string) => THREE.Material,
): Promise<LoadedMeshletAsset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch .mlet asset (${res.status}): ${url}`);
  const parsed = parseMletBuffer(await res.arrayBuffer());
  const group = new THREE.Group();
  const cullers: { mesh: THREE.Mesh; culler: GpuMeshletCuller }[] = [];

  for (const g of parsed.meta.groups) {
    if (g.meshletCount === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(parsed.positions.slice(g.firstVertex * 3, (g.firstVertex + g.vertexCount) * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(parsed.normals.slice(g.firstVertex * 3, (g.firstVertex + g.vertexCount) * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(parsed.uvs.slice(g.firstVertex * 2, (g.firstVertex + g.vertexCount) * 2), 2));

    // Rebase indices & slices to the material group's local vertex/index buffers
    const localIdx = new Uint32Array(g.indexCount);
    for (let i = 0; i < g.indexCount; i++) localIdx[i] = parsed.indices[g.firstIndex + i] - g.firstVertex;

    const localSlices = new Uint32Array(g.meshletCount * 4);
    for (let m = 0; m < g.meshletCount; m++) {
      const srcO = (g.firstMeshlet + m) * 4;
      localSlices[m * 4] = parsed.meshletSlices[srcO] - g.firstIndex;
      localSlices[m * 4 + 1] = parsed.meshletSlices[srcO + 1];
    }

    const culler = new GpuMeshletCuller(geo, g.meshletCount, g.indexCount);
    culler.setAll(
      localIdx,
      parsed.meshletSpheres.subarray(g.firstMeshlet * 4, (g.firstMeshlet + g.meshletCount) * 4),
      parsed.meshletCones.subarray(g.firstMeshlet * 4, (g.firstMeshlet + g.meshletCount) * 4),
      parsed.meshletApices.subarray(g.firstMeshlet * 4, (g.firstMeshlet + g.meshletCount) * 4),
      localSlices,
      g.meshletCount,
    );

    const mat = materialResolver
      ? materialResolver(g.materialName)
      : new THREE.MeshStandardMaterial({ name: g.materialName, color: 0xcccccc, roughness: 0.4, metalness: 0.2 });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `mlet_${g.materialName}`;
    mesh.frustumCulled = false; // culled per-meshlet on the GPU!
    group.add(mesh);
    cullers.push({ mesh, culler });
  }

  return {
    group,
    meta: parsed.meta,
    cullers,
    cull(renderer, camera, maxDist = 0) {
      group.updateMatrixWorld(true);
      for (const { mesh, culler } of cullers) {
        culler.cull(renderer, camera, mesh.matrixWorld, maxDist);
      }
    },
    async readStats(renderer) {
      const acc: MeshletBatchGpuStats = { meshletCount: 0, visibleMeshlets: 0, frustumCulled: 0, coneCulled: 0, visibleIndices: 0, totalIndices: 0 };
      for (const { culler } of cullers) {
        const s = await culler.readStats(renderer);
        acc.meshletCount += s.meshletCount;
        acc.visibleMeshlets += s.visibleMeshlets;
        acc.frustumCulled += s.frustumCulled;
        acc.coneCulled += s.coneCulled;
        acc.visibleIndices += s.visibleIndices;
        acc.totalIndices += s.totalIndices;
      }
      return acc;
    },
    dispose() {
      for (const { mesh, culler } of cullers) {
        culler.dispose();
        mesh.geometry.dispose();
      }
    },
  };
}
