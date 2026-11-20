// Thin Three.js WebGPU adapter for the engine-agnostic Clustered Forward+ core (`web/src/gpu/clustered/`).
// Bridges `THREE.Light` / `THREE.WebGPURenderer` / TSL to `ClusteredLightPacker` and `clustered_forward.wgsl`.
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
import {
  ClusteredLightPacker,
  type ClusterCameraInput,
  type ClusterLightInput,
  type ClusteredForwardStats,
} from '../gpu/clustered/clusteredCpu';
import clusteredWgslSource from '../gpu/clustered/clustered_forward.wgsl?raw';

export type { ClusteredForwardStats };

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
// Fragment-side attenuation: the same math as evalClusteredAttenuation in clustered_forward.wgsl (the engine-agnostic
// core keeps the general form), with the physical inverse-square case (decay 2: every street lamp and headlight) done on
// the squared distance: no sqrt and no pow (log2 + exp2) per light per pixel. max(dist^2, 0.01) == max(distSq, 0.01) and
// (dist / cutoff)^2 == distSq / cutoff^2, so the result is the same; the spot cone uses inverseSqrt for its direction.
const evalClusteredAttenuationWgsl = wgslFn(/* wgsl */ `
fn evalClusteredAttenuationFast(
  lightVec: vec3<f32>,
  cutoffDist: f32,
  decayExp: f32,
  spotDir: vec3<f32>,
  coneCos: f32,
  penumbraCos: f32
) -> f32 {
  let distSq = max(dot(lightVec, lightVec), 1e-6);
  let cutoffSq = cutoffDist * cutoffDist;
  if (cutoffDist > 0.0 && distSq >= cutoffSq) {
    return 0.0;
  }

  var atten = 0.0;
  if (abs(decayExp - 2.0) < 1e-4) {
    atten = 1.0 / max(distSq, 0.01);
  } else {
    atten = 1.0 / max(pow(sqrt(distSq), decayExp), 0.01);
  }
  if (cutoffDist > 0.0) {
    let ratio2 = distSq / cutoffSq;
    let falloff = clamp(1.0 - ratio2 * ratio2, 0.0, 1.0);
    atten *= falloff * falloff;
  }

  if (coneCos > -1.5) {
    let fromLight = -lightVec * inverseSqrt(distSq);
    let angleCos = dot(fromLight, spotDir);
    let spot = smoothstep(coneCos, max(penumbraCos, coneCos + 1e-4), angleCos);
    atten *= spot;
  }

  return atten;
}`);

const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();

class ClusteredForwardLightsNode extends THREE.LightsNode {
  static get type() {
    return 'ClusteredForwardLightsNode';
  }

  private readonly packer: ClusteredLightPacker;
  private materialLights: THREE.Light[] = [];
  private clusteredLights: THREE.Light[] = [];

  private readonly posRangeAttr: THREE.StorageBufferAttribute;
  private readonly colorDecayAttr: THREE.StorageBufferAttribute;
  private readonly spotDirCosAttr: THREE.StorageBufferAttribute;
  private readonly cullSphereAttr: THREE.StorageBufferAttribute;
  private readonly spotPenumbraAttr: THREE.StorageBufferAttribute;
  private readonly zSliceRangeAttr: THREE.StorageBufferAttribute;
  private readonly lightAttrs4: THREE.StorageBufferAttribute[];

  private readonly posRangeBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly colorDecayBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly spotDirCosBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly cullSphereBuf: THREE.StorageBufferNode<'vec4'>;
  private readonly spotPenumbraBuf: THREE.StorageBufferNode<'float'>;
  private readonly zSliceRangeBuf: THREE.StorageBufferNode<'ivec4'>;

  private lightIndexes: THREE.StorageBufferNode<'ivec4'> | null = null;
  private computeNode: THREE.ComputeNode | null = null;
  private built = false;

  private readonly cameraNear = uniform(0.1).setName('cfCameraNear').setGroup(renderGroup);
  private readonly cameraFar = uniform(1000).setName('cfCameraFar').setGroup(renderGroup);
  private readonly invFocalX = uniform(1).setName('cfInvFocalX').setGroup(renderGroup);
  private readonly invFocalY = uniform(1).setName('cfInvFocalY').setGroup(renderGroup);

  private readonly camInput: ClusterCameraInput = {
    viewMatrix: new Float32Array(16),
    projectionMatrix: new Float32Array(16),
    near: 0.1,
    far: 1000,
  };

  constructor(maxLights = 512, tilesX = 24, tilesY = 14, zSlices = 16, maxLightsPerCluster = 32) {
    super();
    this.packer = new ClusteredLightPacker({ maxLights, tilesX, tilesY, zSlices, maxLightsPerCluster });

    this.posRangeAttr = new THREE.StorageBufferAttribute(this.packer.posRange, 4);
    this.colorDecayAttr = new THREE.StorageBufferAttribute(this.packer.colorDecay, 4);
    this.spotDirCosAttr = new THREE.StorageBufferAttribute(this.packer.spotDirCos, 4);
    this.cullSphereAttr = new THREE.StorageBufferAttribute(this.packer.cullSpheres, 4);
    this.spotPenumbraAttr = new THREE.StorageBufferAttribute(this.packer.spotPenumbra, 1);
    this.zSliceRangeAttr = new THREE.StorageBufferAttribute(this.packer.zSliceRanges, 4);
    this.lightAttrs4 = [this.posRangeAttr, this.colorDecayAttr, this.spotDirCosAttr, this.cullSphereAttr];

    this.posRangeBuf = storage(this.posRangeAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.colorDecayBuf = storage(this.colorDecayAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.spotDirCosBuf = storage(this.spotDirCosAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.cullSphereBuf = storage(this.cullSphereAttr, 'vec4', maxLights).toReadOnly() as THREE.StorageBufferNode<'vec4'>;
    this.spotPenumbraBuf = storage(this.spotPenumbraAttr, 'float', maxLights).toReadOnly() as THREE.StorageBufferNode<'float'>;
    this.zSliceRangeBuf = storage(this.zSliceRangeAttr, 'ivec4', zSlices).toReadOnly() as THREE.StorageBufferNode<'ivec4'>;

    this.updateBeforeType = THREE.NodeUpdateType.RENDER;
    this.buildComputePass();
  }

  get stats(): ClusteredForwardStats {
    return this.packer.stats;
  }

  private buildComputePass() {
    if (this.built) return;
    this.built = true;

    const { tilesX: NX, tilesY: NY, zSlices: NZ, maxLightsPerCluster: maxPerCluster } = this.packer.cfg;
    const clusterCount = NX * NY * NZ;
    const chunks = this.packer.chunksPerCluster;

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
        cx, cy, cz,
        nx: float(NX), ny: float(NY), nz: float(NZ),
        nearZ: this.cameraNear, farZ: this.cameraFar,
        invFocalX: this.invFocalX, invFocalY: this.invFocalY,
      }) as unknown as THREE.Node<'vec3'>).toConst();

      const aabbMax = (clusterAabbMaxWgsl({
        cx, cy, cz,
        nx: float(NX), ny: float(NY), nz: float(NZ),
        nearZ: this.cameraNear, farZ: this.cameraFar,
        invFocalX: this.invFocalX, invFocalY: this.invFocalY,
      }) as unknown as THREE.Node<'vec3'>).toConst();

      Loop(chunks, ({ i }) => {
        getChunk(i as unknown as THREE.Node<'int'>).assign(ivec4(0));
      });

      const zRange = this.zSliceRangeBuf.element(cz);
      const rangeStart = zRange.x;
      const countInSlice = zRange.y.sub(rangeStart);
      const writeIdx = int(0).toVar();

      Loop({ start: int(0), end: countInSlice, type: 'int', condition: '<' }, ({ i }) => {
        If(writeIdx.greaterThanEqual(int(maxPerCluster)), () => {
          Return();
        });
        const lightIdx = rangeStart.add(i);
        const sphere = this.cullSphereBuf.element(lightIdx);
        const hit = sphereIntersectsAabbWgsl({
          center: sphere.xyz, radius: sphere.w, aabbMin, aabbMax,
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
      if ((l.isPointLight === true || l.isSpotLight === true) && l.castShadow !== true) {
        clusteredLights[ci++] = l;
      } else {
        materialLights[mi++] = l;
      }
    }

    materialLights.length = mi;
    clusteredLights.length = ci;
    this.packer.stats.materialForwardLights = mi;
    return super.setLights(lights);
  }

  getBuiltinLights() {
    return this.materialLights;
  }

  private readonly readThreeLight = (index: number, out: ClusterLightInput): boolean => {
    const raw = this.clusteredLights[index] as (THREE.PointLight | THREE.SpotLight) & {
      isSpotLight?: boolean;
      target?: THREE.Object3D;
    };
    if (!raw.visible || raw.intensity <= 0.001) return false;
    _pos.setFromMatrixPosition(raw.matrixWorld);
    out.posX = _pos.x;
    out.posY = _pos.y;
    out.posZ = _pos.z;
    out.r = raw.color.r;
    out.g = raw.color.g;
    out.b = raw.color.b;
    out.intensity = raw.intensity;
    out.range = raw.distance;
    out.decay = raw.decay;
    if (raw.isSpotLight === true) {
      const spot = raw as THREE.SpotLight;
      _target.setFromMatrixPosition(spot.target.matrixWorld);
      out.kind = 'spot';
      out.targetX = _target.x;
      out.targetY = _target.y;
      out.targetZ = _target.z;
      out.angle = spot.angle;
      out.penumbra = spot.penumbra;
    } else {
      out.kind = 'point';
    }
    return true;
  };

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

    this.camInput.viewMatrix = camera.matrixWorldInverse.elements;
    this.camInput.projectionMatrix = proj;
    this.camInput.near = near;
    this.camInput.far = far;
    const active = this.packer.pack(this.camInput, this.clusteredLights.length, this.readThreeLight);

    // Upload only the packed lights, not all maxLights slots (512 x 4 vec4 + floats, ~34 KB, every lit pass): the
    // cluster pass and the fragment loop only read indices inside the z-slice ranges, which all lie below `active`.
    // The WebGPU backend honours updateRanges for storage attributes (writeBuffer per range, then clears them).
    if (active > 0) {
      for (const a of this.lightAttrs4) { a.addUpdateRange(0, active * 4); a.needsUpdate = true; }
      this.spotPenumbraAttr.addUpdateRange(0, active);
      this.spotPenumbraAttr.needsUpdate = true;
    }
    this.zSliceRangeAttr.needsUpdate = true;

    if (this.computeNode) renderer.compute(this.computeNode);
    return undefined;
  }

  setupLights(builder: THREE.NodeBuilder, lightNodes: THREE.LightingNode[]) {
    this.buildComputePass();

    const lightingModel = (builder.context as { reflectedLight: { directDiffuse: THREE.Node; directSpecular: THREE.Node } })
      .reflectedLight;
    lightingModel.directDiffuse.toStack();
    lightingModel.directSpecular.toStack();

    super.setupLights(builder, lightNodes);

    const lightIndexes = this.lightIndexes!;
    const { tilesX: NX, tilesY: NY, zSlices: NZ, maxLightsPerCluster: maxPerCluster } = this.packer.cfg;
    const chunks = this.packer.chunksPerCluster;

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
