// Clustered Forward+ WebGPU lighting pass (WGSL compute culling + unified PointLight & SpotLight shading).
//
// Why this replaces stock Three.js ClusteredLighting:
//  1. Stock ClusteredLightsNode runs 60x34x24 = 48,960 clusters (12.5 MB cleared every frame) and ONLY clusters
//     non-shadow PointLights — SpotLights (headlights) still fall back to standard forward shading on every pixel.
//  2. Here we use a compact iGPU-friendly 3D frustum grid (default 24x14x16 = 5,376 clusters, ~9x fewer compute
//     threads and ~18x less cluster-buffer bandwidth), pre-transform active lights to view space once on CPU,
//     compute tight bounding spheres for SpotLight headlight cones, and cull BOTH 100+ dynamic streetlights AND
//     dynamic car headlights in a single WGSL compute pass (`wgslFn` kernels from shaders/clustered_forward.wgsl).
//  3. Fragment cluster lookup uses resolution-independent `screenUV`, so render-scale changes or window resizes
//     NEVER recompile lit materials.
import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  Return,
  attributeArray,
  float,
  int,
  instanceIndex,
  ivec4,
  positionView,
  renderGroup,
  screenUV,
  storage,
  uniform,
  wgslFn,
} from 'three/tsl';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import clusteredWgslSource from './shaders/clustered_forward.wgsl?raw';

/** Extract a single `fn name(...)` block from the shared `.wgsl` shader source for `wgslFn`. */
function extractWgslFn(source: string, fnName: string): string {
  const re = new RegExp(`fn\\s+${fnName}\\b[\\s\\S]*?\\n\\}`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`clustered_forward.wgsl: missing fn ${fnName}`);
  return m[0];
}

const clusterAabbMinWgsl = wgslFn(extractWgslFn(clusteredWgslSource, 'clusterAabbMin'));
const clusterAabbMaxWgsl = wgslFn(extractWgslFn(clusteredWgslSource, 'clusterAabbMax'));
const sphereIntersectsAabbWgsl = wgslFn(extractWgslFn(clusteredWgslSource, 'sphereIntersectsAabb'));
const clusterIndexFromScreenWgsl = wgslFn(extractWgslFn(clusteredWgslSource, 'clusterIndexFromScreen'));
const evalClusteredAttenuationWgsl = wgslFn(extractWgslFn(clusteredWgslSource, 'evalClusteredAttenuation'));

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

const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _cullCenter = new THREE.Vector3();

class ClusteredForwardLightsNode extends THREE.LightsNode {
  static get type() {
    return 'ClusteredForwardLightsNode';
  }

  private materialLights: THREE.Light[] = [];
  private clusteredLights: THREE.Light[] = [];

  readonly maxLights: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly zSlices: number;
  readonly maxLightsPerCluster: number;
  private readonly chunksPerCluster: number;

  // Packed SoA storage buffers (16-byte aligned vec4s, uploaded once per frame)
  private readonly posRangeArr: Float32Array;
  private readonly colorDecayArr: Float32Array;
  private readonly spotDirCosArr: Float32Array;
  private readonly cullSphereArr: Float32Array;
  private readonly spotPenumbraArr: Float32Array;
  private readonly zSliceRangeArr: Int32Array;

  private readonly posRangeAttr: THREE.StorageBufferAttribute;
  private readonly colorDecayAttr: THREE.StorageBufferAttribute;
  private readonly spotDirCosAttr: THREE.StorageBufferAttribute;
  private readonly cullSphereAttr: THREE.StorageBufferAttribute;
  private readonly spotPenumbraAttr: THREE.StorageBufferAttribute;
  private readonly zSliceRangeAttr: THREE.StorageBufferAttribute;

  private readonly posRangeBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly colorDecayBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly spotDirCosBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly cullSphereBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly spotPenumbraBuf: THREE.StorageBufferNode<'float'>;
  private readonly zSliceRangeBuf: THREE.StorageBufferNode<'ivec4'>;

  private lightIndexes: THREE.StorageBufferNode<'ivec4'> | null = null;
  private computeNode: THREE.ComputeNode | null = null;
  private built = false;

  // Scratch buffers for CPU view-space sorting (zero per-frame GC)
  private readonly scratchViewZ: Float32Array;
  private readonly scratchCullX: Float32Array;
  private readonly scratchCullY: Float32Array;
  private readonly scratchCullZ: Float32Array;
  private readonly scratchCullR: Float32Array;
  private readonly scratchPosX: Float32Array;
  private readonly scratchPosY: Float32Array;
  private readonly scratchPosZ: Float32Array;
  private readonly scratchRange: Float32Array;
  private readonly scratchColR: Float32Array;
  private readonly scratchColG: Float32Array;
  private readonly scratchColB: Float32Array;
  private readonly scratchDecay: Float32Array;
  private readonly scratchDirX: Float32Array;
  private readonly scratchDirY: Float32Array;
  private readonly scratchDirZ: Float32Array;
  private readonly scratchConeCos: Float32Array;
  private readonly scratchPenCos: Float32Array;
  private readonly sortOrder: number[] = [];

  private readonly cameraNear = uniform(0.1).setName('cfCameraNear').setGroup(renderGroup);
  private readonly cameraFar = uniform(1000).setName('cfCameraFar').setGroup(renderGroup);
  private readonly invFocalX = uniform(1).setName('cfInvFocalX').setGroup(renderGroup);
  private readonly invFocalY = uniform(1).setName('cfInvFocalY').setGroup(renderGroup);

  readonly stats: ClusteredForwardStats;

  constructor(maxLights = 512, tilesX = 24, tilesY = 14, zSlices = 16, maxLightsPerCluster = 32) {
    super();
    this.maxLights = maxLights;
    this.tilesX = tilesX;
    this.tilesY = tilesY;
    this.zSlices = zSlices;
    this.maxLightsPerCluster = maxLightsPerCluster;
    this.chunksPerCluster = Math.ceil(maxLightsPerCluster / 4);

    this.posRangeArr = new Float32Array(maxLights * 4);
    this.colorDecayArr = new Float32Array(maxLights * 4);
    this.spotDirCosArr = new Float32Array(maxLights * 4);
    this.cullSphereArr = new Float32Array(maxLights * 4);
    this.spotPenumbraArr = new Float32Array(maxLights);
    this.zSliceRangeArr = new Int32Array(zSlices * 4);

    this.posRangeAttr = new THREE.StorageBufferAttribute(this.posRangeArr, 4);
    this.colorDecayAttr = new THREE.StorageBufferAttribute(this.colorDecayArr, 4);
    this.spotDirCosAttr = new THREE.StorageBufferAttribute(this.spotDirCosArr, 4);
    this.cullSphereAttr = new THREE.StorageBufferAttribute(this.cullSphereArr, 4);
    this.spotPenumbraAttr = new THREE.StorageBufferAttribute(this.spotPenumbraArr, 1);
    this.zSliceRangeAttr = new THREE.StorageBufferAttribute(this.zSliceRangeArr, 4);

    this.posRangeBuf = storage(this.posRangeAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.colorDecayBuf = storage(this.colorDecayAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.spotDirCosBuf = storage(this.spotDirCosAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.cullSphereBuf = storage(this.cullSphereAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.spotPenumbraBuf = storage(this.spotPenumbraAttr, 'float', maxLights).toReadOnly() as THREE.StorageBufferNode<'float'>;
    this.zSliceRangeBuf = storage(this.zSliceRangeAttr, 'ivec4', zSlices).toReadOnly() as THREE.StorageBufferNode<'ivec4'>;

    this.scratchViewZ = new Float32Array(maxLights);
    this.scratchCullX = new Float32Array(maxLights);
    this.scratchCullY = new Float32Array(maxLights);
    this.scratchCullZ = new Float32Array(maxLights);
    this.scratchCullR = new Float32Array(maxLights);
    this.scratchPosX = new Float32Array(maxLights);
    this.scratchPosY = new Float32Array(maxLights);
    this.scratchPosZ = new Float32Array(maxLights);
    this.scratchRange = new Float32Array(maxLights);
    this.scratchColR = new Float32Array(maxLights);
    this.scratchColG = new Float32Array(maxLights);
    this.scratchColB = new Float32Array(maxLights);
    this.scratchDecay = new Float32Array(maxLights);
    this.scratchDirX = new Float32Array(maxLights);
    this.scratchDirY = new Float32Array(maxLights);
    this.scratchDirZ = new Float32Array(maxLights);
    this.scratchConeCos = new Float32Array(maxLights);
    this.scratchPenCos = new Float32Array(maxLights);

    this.stats = {
      tilesX,
      tilesY,
      zSlices,
      totalClusters: tilesX * tilesY * zSlices,
      maxLights,
      maxLightsPerCluster,
      activePointLights: 0,
      activeSpotLights: 0,
      totalActiveClustered: 0,
      materialForwardLights: 0,
      lastUploadMs: 0,
    };

    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
    this.buildComputePass();
  }

  private buildComputePass() {
    if (this.built) return;
    this.built = true;

    const NX = this.tilesX;
    const NY = this.tilesY;
    const NZ = this.zSlices;
    const clusterCount = NX * NY * NZ;
    const chunks = this.chunksPerCluster;
    const maxPerCluster = this.maxLightsPerCluster;

    const clusterData = new Int32Array(clusterCount * chunks * 4);
    const lightIndexes = attributeArray(clusterData, 'ivec4').setName('cfLightIndexes') as unknown as THREE.StorageBufferNode<'ivec4'>;
    this.lightIndexes = lightIndexes;
    const clusterId = int(instanceIndex);

    const getChunk = (chunkIdx: THREE.Node<'int'>) =>
      lightIndexes.element(clusterId.mul(int(chunks)).add(int(chunkIdx)));

    const getSlot = (slotIdx: THREE.Node<'int'>) => {
      const s = int(slotIdx);
      const chunkOffset = s.div(int(4));
      const idx = clusterId.mul(int(chunks)).add(chunkOffset);
      return (lightIndexes.element(idx) as unknown as { element(k: THREE.Node<'int'>): THREE.Node<'int'> }).element(s.mod(int(4)));
    };

    this.computeNode = Fn(() => {
      const cx = clusterId.mod(int(NX));
      const cy = clusterId.div(int(NX)).mod(int(NY));
      const cz = clusterId.div(int(NX * NY));

      const aabbMin = (clusterAabbMinWgsl({
        cx,
        cy,
        cz,
        nx: float(NX),
        ny: float(NY),
        nz: float(NZ),
        nearZ: this.cameraNear,
        farZ: this.cameraFar,
        invFocalX: this.invFocalX,
        invFocalY: this.invFocalY,
      }) as unknown as THREE.Node<'vec3'>).toConst();

      const aabbMax = (clusterAabbMaxWgsl({
        cx,
        cy,
        cz,
        nx: float(NX),
        ny: float(NY),
        nz: float(NZ),
        nearZ: this.cameraNear,
        farZ: this.cameraFar,
        invFocalX: this.invFocalX,
        invFocalY: this.invFocalY,
      }) as unknown as THREE.Node<'vec3'>).toConst();

      // Clear previous frame's cluster list (8 ivec4 writes = 128 bytes/cluster)
      Loop(chunks, ({ i }) => {
        getChunk(i as unknown as THREE.Node<'int'>).assign(ivec4(0));
      });

      const zRange = this.zSliceRangeBuf.element(cz);
      const rangeStart = zRange.x;
      const rangeEnd = zRange.y;

      const writeIdx = int(0).toVar();
      const countInSlice = rangeEnd.sub(rangeStart);

      Loop({ start: int(0), end: countInSlice, type: 'int', condition: '<' }, ({ i }) => {
        If(writeIdx.greaterThanEqual(int(maxPerCluster)), () => {
          Return();
        });

        const lightIdx = rangeStart.add(i);
        const sphere = this.cullSphereBuf.element(lightIdx);

        const hit = sphereIntersectsAabbWgsl({
          center: sphere.xyz,
          radius: sphere.w,
          aabbMin,
          aabbMax,
        }) as unknown as THREE.Node<'float'>;

        If(hit.greaterThan(float(0.5)), () => {
          getSlot(writeIdx).assign(lightIdx.add(int(1)));
          writeIdx.addAssign(int(1));
        });
      });
    })()
      .compute(clusterCount, [64])
      .setName('ClusteredForwardPlusCull');
  }

  customCacheKey() {
    return (this.computeNode ? this.computeNode.getCacheKey() : 0) + super.customCacheKey();
  }

  setLights(lights: THREE.Light[]) {
    const { clusteredLights, materialLights } = this;
    let mi = 0;
    let ci = 0;

    for (let i = 0; i < lights.length; i++) {
      const l = lights[i] as THREE.Light & { isPointLight?: boolean; isSpotLight?: boolean };
      // Cluster BOTH non-shadow PointLights (streetlights/signals/neon) AND non-shadow SpotLights (headlights)
      if ((l.isPointLight === true || l.isSpotLight === true) && l.castShadow !== true) {
        clusteredLights[ci++] = l;
      } else {
        materialLights[mi++] = l;
      }
    }

    materialLights.length = mi;
    clusteredLights.length = ci;
    this.stats.materialForwardLights = mi;
    return super.setLights(lights);
  }

  getBuiltinLights() {
    return this.materialLights;
  }

  private uploadLights(camera: THREE.Camera) {
    const t0 = performance.now();
    const viewMatrix = camera.matrixWorldInverse;
    const near = (camera as THREE.PerspectiveCamera).near ?? 0.1;
    const far = (camera as THREE.PerspectiveCamera).far ?? 1000;
    const NZ = this.zSlices;

    let activeCount = 0;
    let pointCount = 0;
    let spotCount = 0;

    for (let i = 0; i < this.clusteredLights.length && activeCount < this.maxLights; i++) {
      const raw = this.clusteredLights[i] as (THREE.PointLight | THREE.SpotLight) & {
        isSpotLight?: boolean;
        target?: THREE.Object3D;
      };
      if (!raw.visible || raw.intensity <= 0.001) continue;
      const range = raw.distance > 0 ? raw.distance : far;
      if (range <= 0.05) continue;

      _pos.setFromMatrixPosition(raw.matrixWorld);
      _pos.applyMatrix4(viewMatrix);

      let cullX = _pos.x;
      let cullY = _pos.y;
      let cullZ = _pos.z;
      let cullR = range;
      let dirX = 0;
      let dirY = 0;
      let dirZ = -1;
      let coneCos = -2.0; // sentinel: PointLight
      let penCos = -2.0;

      if (raw.isSpotLight === true) {
        const spot = raw as THREE.SpotLight;
        _target.setFromMatrixPosition(spot.target.matrixWorld);
        _target.applyMatrix4(viewMatrix);
        _dir.subVectors(_target, _pos);
        const len = _dir.length();
        if (len > 1e-5) _dir.divideScalar(len);
        else _dir.set(0, 0, -1);

        dirX = _dir.x;
        dirY = _dir.y;
        dirZ = _dir.z;

        const angle = Math.max(0.01, Math.min(Math.PI * 0.49, spot.angle));
        const cosA = Math.cos(angle);
        coneCos = cosA;
        penCos = Math.cos(angle * (1 - Math.max(0, Math.min(0.999, spot.penumbra))));

        // Minimal bounding sphere for a finite spotlight cone: keeps headlight culling tight in front of the car.
        if (angle > Math.PI * 0.25) {
          _cullCenter.copy(_pos).addScaledVector(_dir, range * cosA);
          cullR = range * Math.sin(angle);
        } else {
          const d = range / (2.0 * cosA);
          _cullCenter.copy(_pos).addScaledVector(_dir, d);
          cullR = d;
        }
        cullX = _cullCenter.x;
        cullY = _cullCenter.y;
        cullZ = _cullCenter.z;
        spotCount++;
      } else {
        pointCount++;
      }

      // Quick view-Z frustum reject before uploading
      if (cullZ - cullR > -near || cullZ + cullR < -far) continue;

      const idx = activeCount++;
      this.scratchViewZ[idx] = cullZ;
      this.scratchCullX[idx] = cullX;
      this.scratchCullY[idx] = cullY;
      this.scratchCullZ[idx] = cullZ;
      this.scratchCullR[idx] = cullR;
      this.scratchPosX[idx] = _pos.x;
      this.scratchPosY[idx] = _pos.y;
      this.scratchPosZ[idx] = _pos.z;
      this.scratchRange[idx] = range;
      this.scratchColR[idx] = raw.color.r * raw.intensity;
      this.scratchColG[idx] = raw.color.g * raw.intensity;
      this.scratchColB[idx] = raw.color.b * raw.intensity;
      this.scratchDecay[idx] = raw.decay;
      this.scratchDirX[idx] = dirX;
      this.scratchDirY[idx] = dirY;
      this.scratchDirZ[idx] = dirZ;
      this.scratchConeCos[idx] = coneCos;
      this.scratchPenCos[idx] = penCos;
      this.sortOrder[idx] = idx;
    }

    this.sortOrder.length = activeCount;
    const vz = this.scratchViewZ;
    this.sortOrder.sort((a, b) => vz[a] - vz[b]);

    for (let i = 0; i < activeCount; i++) {
      const s = this.sortOrder[i];
      const o = i * 4;
      this.posRangeArr[o] = this.scratchPosX[s];
      this.posRangeArr[o + 1] = this.scratchPosY[s];
      this.posRangeArr[o + 2] = this.scratchPosZ[s];
      this.posRangeArr[o + 3] = this.scratchRange[s];

      this.colorDecayArr[o] = this.scratchColR[s];
      this.colorDecayArr[o + 1] = this.scratchColG[s];
      this.colorDecayArr[o + 2] = this.scratchColB[s];
      this.colorDecayArr[o + 3] = this.scratchDecay[s];

      this.spotDirCosArr[o] = this.scratchDirX[s];
      this.spotDirCosArr[o + 1] = this.scratchDirY[s];
      this.spotDirCosArr[o + 2] = this.scratchDirZ[s];
      this.spotDirCosArr[o + 3] = this.scratchConeCos[s];

      this.cullSphereArr[o] = this.scratchCullX[s];
      this.cullSphereArr[o + 1] = this.scratchCullY[s];
      this.cullSphereArr[o + 2] = this.scratchCullZ[s];
      this.cullSphereArr[o + 3] = this.scratchCullR[s];

      this.spotPenumbraArr[i] = this.scratchPenCos[s];
    }

    // Per Z-slice [start, end) ranges for fast compute-shader early rejection
    const ratio = far / Math.max(near, 0.001);
    for (let z = 0; z < NZ; z++) {
      const sliceNear = -(near * Math.pow(ratio, z / NZ));
      const sliceFar = -(near * Math.pow(ratio, (z + 1) / NZ));
      let start = activeCount;
      let end = 0;
      for (let i = 0; i < activeCount; i++) {
        const s = this.sortOrder[i];
        const cz = this.scratchCullZ[s];
        const r = this.scratchCullR[s];
        if (cz + r >= sliceFar && cz - r <= sliceNear) {
          if (i < start) start = i;
          if (i + 1 > end) end = i + 1;
        }
      }
      if (start >= activeCount) {
        start = 0;
        end = 0;
      }
      this.zSliceRangeArr[z * 4] = start;
      this.zSliceRangeArr[z * 4 + 1] = end;
      this.zSliceRangeArr[z * 4 + 2] = 0;
      this.zSliceRangeArr[z * 4 + 3] = 0;
    }

    this.posRangeAttr.needsUpdate = true;
    this.colorDecayAttr.needsUpdate = true;
    this.spotDirCosAttr.needsUpdate = true;
    this.cullSphereAttr.needsUpdate = true;
    this.spotPenumbraAttr.needsUpdate = true;
    this.zSliceRangeAttr.needsUpdate = true;

    this.stats.activePointLights = pointCount;
    this.stats.activeSpotLights = spotCount;
    this.stats.totalActiveClustered = activeCount;
    this.stats.lastUploadMs = Math.round((performance.now() - t0) * 100) / 100;
  }

  updateBefore(frame: THREE.NodeFrame) {
    const renderer = frame.renderer as unknown as THREE.WebGPURenderer | null;
    const camera = frame.camera;
    if (!renderer || !camera) return undefined;
    this.buildComputePass();

    const persp = camera as THREE.PerspectiveCamera;
    const near = Math.max(persp.near || 0.1, 0.01);
    const far = Math.max(persp.far || 1000, near + 1);
    this.cameraNear.value = near;
    this.cameraFar.value = far;

    const proj = camera.projectionMatrix.elements;
    this.invFocalX.value = proj[0] !== 0 ? 1.0 / proj[0] : 1.0;
    this.invFocalY.value = proj[5] !== 0 ? 1.0 / proj[5] : 1.0;

    this.uploadLights(camera);
    if (this.computeNode) renderer.compute(this.computeNode);
    return undefined;
  }

  setupLights(builder: THREE.NodeBuilder, lightNodes: THREE.LightingNode[]) {
    this.buildComputePass();

    const lightingModel = (builder.context as { reflectedLight: { directDiffuse: THREE.Node; directSpecular: THREE.Node } })
      .reflectedLight;
    lightingModel.directDiffuse.toStack();
    lightingModel.directSpecular.toStack();

    // Standard forward path for DirectionalLight, HemisphereLight, and shadow-casting SpotLight
    super.setupLights(builder, lightNodes);

    const lightIndexes = this.lightIndexes!;
    const NX = this.tilesX;
    const NY = this.tilesY;
    const NZ = this.zSlices;
    const chunks = this.chunksPerCluster;
    const maxPerCluster = this.maxLightsPerCluster;

    Fn(() => {
      const clusterIdx = (clusterIndexFromScreenWgsl({
        suv: screenUV,
        viewDepth: positionView.z.negate(),
        nearZ: this.cameraNear,
        farZ: this.cameraFar,
        nx: int(NX),
        ny: int(NY),
        nz: int(NZ),
      }) as unknown as THREE.Node<'int'>).toConst();

      const baseChunk = clusterIdx.mul(int(chunks)).toConst();

      Loop(maxPerCluster, ({ i }) => {
        const slot = int(i);
        const chunk = baseChunk.add(slot.div(int(4)));
        const encodedIdx = (
          lightIndexes.element(chunk) as unknown as { element(k: THREE.Node<'int'>): THREE.Node<'int'> }
        ).element(slot.mod(int(4)));

        If(encodedIdx.equal(int(0)), () => {
          Break();
        });

        const li = encodedIdx.sub(int(1));
        const posRange = this.posRangeBuf.element(li);
        const colorDecay = this.colorDecayBuf.element(li);
        const spotDirCos = this.spotDirCosBuf.element(li);
        const penCos = this.spotPenumbraBuf.element(li);

        const lightVec = posRange.xyz.sub(positionView).toConst();
        const atten = (evalClusteredAttenuationWgsl({
          lightVec,
          cutoffDist: posRange.w,
          decayExp: colorDecay.w,
          spotDir: spotDirCos.xyz,
          coneCos: spotDirCos.w,
          penumbraCos: penCos,
        }) as unknown as THREE.Node<'float'>).toConst();

        If(atten.greaterThan(float(0.0001)), () => {
          const lightDirection = lightVec.normalize();
          const lightColor = colorDecay.rgb.mul(atten);
          (
            (builder as unknown as {
              lightsNode: {
                setupDirectLight(b: THREE.NodeBuilder, n: unknown, d: { lightDirection: THREE.Node; lightColor: THREE.Node }): void;
              };
            }).lightsNode
          ).setupDirectLight(builder, this, { lightDirection, lightColor });
        });
      });
    }, 'void')();
  }

  dispose() {
    if (this.computeNode) {
      this.computeNode.dispose();
      this.computeNode = null;
    }
    super.dispose();
  }
}

/**
 * Drop-in Clustered Forward+ lighting provider for `THREE.WebGPURenderer.lighting`.
 * Clusters both 100+ dynamic streetlights (PointLight) and dynamic car headlights (SpotLight)
 * in a compact WGSL compute pass. Scenes flagged `userData.plainLights` (e.g. Garage) stay plain forward.
 */
export class ClusteredForwardLighting extends ClusteredLighting {
  private plain = new WeakMap<object, THREE.LightsNode>();
  private lastNode: ClusteredForwardLightsNode | null = null;

  constructor(
    private readonly cfMaxLights = 512,
    private readonly tilesX = 24,
    private readonly tilesY = 14,
    private readonly cfZSlices = 16,
    private readonly cfMaxLightsPerCluster = 32,
  ) {
    super(cfMaxLights, 32, cfZSlices, cfMaxLightsPerCluster);
  }

  get stats(): ClusteredForwardStats | null {
    return this.lastNode?.stats ?? null;
  }

  getNode(scene: THREE.Scene) {
    if ((scene as { isScene?: boolean }).isScene && scene.userData?.plainLights) {
      let n = this.plain.get(scene);
      if (!n) {
        n = new THREE.LightsNode();
        this.plain.set(scene, n);
      }
      return n as unknown as ReturnType<ClusteredLighting['getNode']>;
    }
    return super.getNode(scene);
  }

  createNode(lights: THREE.Light[] = []) {
    const node = new ClusteredForwardLightsNode(
      this.cfMaxLights,
      this.tilesX,
      this.tilesY,
      this.cfZSlices,
      this.cfMaxLightsPerCluster,
    );
    node.setLights(lights);
    this.lastNode = node;
    (globalThis as { __clustered?: ClusteredForwardStats }).__clustered = node.stats;
    return node as unknown as ReturnType<ClusteredLighting['createNode']>;
  }
}
