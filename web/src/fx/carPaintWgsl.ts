// Dual-Layer PBR Clear-Coat Car Paint WGSL Node Wrapper (Three.js WebGPU + TSL wgslFn).
// Compiles native WGSL functions from shaders/car_paint.wgsl directly into a car's MeshPhysicalNodeMaterial,
// preserving garage paint colors/finishes, model-space livery stripes, underglow sill wash, and vertex dents.
import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  cameraPosition,
  float,
  materialClearcoat,
  materialClearcoatRoughness,
  materialColor,
  materialMetalness,
  materialRoughness,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  uniform,
  vec4,
  wgslFn,
} from 'three/tsl';
import carPaintWgslSource from './shaders/car_paint.wgsl?raw';

function extractFn(source: string, name: string): string {
  const re = new RegExp(`fn\\s+${name}\\b[\\s\\S]*?\\n\\}`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`car_paint.wgsl: missing fn ${name}`);
  return m[0];
}

type WgslInclude = Parameters<typeof wgslFn>[1];
const hash3dPaintWgsl = wgslFn(extractFn(carPaintWgslSource, 'hash3dPaint'));
const valueNoise3dPaintWgsl = wgslFn(extractFn(carPaintWgslSource, 'valueNoise3dPaint'), [hash3dPaintWgsl] as unknown as WgslInclude);
const fbm3dPaintWgsl = wgslFn(extractFn(carPaintWgslSource, 'fbm3dPaint'), [valueNoise3dPaintWgsl] as unknown as WgslInclude);

const evalCarDirtWearWgsl = wgslFn(
  extractFn(carPaintWgslSource, 'evalCarDirtWear'),
  [valueNoise3dPaintWgsl, fbm3dPaintWgsl] as unknown as WgslInclude,
);

const evalDualLayerPaintColorWgsl = wgslFn(
  extractFn(carPaintWgslSource, 'evalDualLayerPaintColor'),
  [hash3dPaintWgsl] as unknown as WgslInclude,
);

const rgb = (u: THREE.UniformNode<'color', THREE.Color>) => u as unknown as THREE.Node<'vec3'>;

export interface CarPaintWgslUniforms {
  /** Livery style index (0=none, 1=twin, 2=wide, 3=side, 4=two-tone) */
  style: THREE.UniformNode<'float', number>;
  color: THREE.UniformNode<'color', THREE.Color>;
  inv: THREE.UniformNode<'mat4', THREE.Matrix4>;
  bottom: THREE.UniformNode<'float', number>;
  top: THREE.UniformNode<'float', number>;
  /** Underglow wash on lower sills */
  glow: THREE.UniformNode<'color', THREE.Color>;
  glowAmt: THREE.UniformNode<'float', number>;
  /** Dual-layer paint tuning (uniforms updated by finish, no shader recompile) */
  flopStrength: THREE.UniformNode<'float', number>;
  flakeStrength: THREE.UniformNode<'float', number>;
  /** Dynamic dirt/wear accumulation [0..1] + cumulative driving time (seconds) */
  wear: THREE.UniformNode<'float', number>;
  driveTime: THREE.UniformNode<'float', number>;
}

/**
 * Installs the dual-layer PBR clear-coat WGSL shader + livery stripes + dynamic dirt/wear mask
 * onto a `THREE.MeshPhysicalNodeMaterial`. All finish, livery, underglow, and wear updates are pure
 * uniform writes (zero shader recompiles).
 */
export function installDualLayerCarPaint(paint: THREE.MeshPhysicalNodeMaterial): CarPaintWgslUniforms {
  const u: CarPaintWgslUniforms = {
    style: uniform(0),
    color: uniform(new THREE.Color(1, 1, 1)),
    inv: uniform(new THREE.Matrix4()),
    bottom: uniform(0.15),
    top: uniform(1.25),
    glow: uniform(new THREE.Color(0x000000)),
    glowAmt: uniform(0),
    flopStrength: uniform(0.42),
    flakeStrength: uniform(0.28),
    wear: uniform(0),
    driveTime: uniform(0),
  };

  const pLocal = u.inv.mul(vec4(positionWorld, 1)).xyz;
  const nLocal = u.inv.mul(vec4(normalWorld, 0)).xyz.normalize();
  const vWorld = cameraPosition.sub(positionWorld).normalize();

  // Model-space livery mask (same layout as original installLivery)
  const liveryMask = Fn(() => {
    const p = pLocal;
    const ax = abs(p.x);
    const aa = float(0.006);
    const h = p.y.sub(u.bottom).div(u.top.sub(u.bottom).max(0.25));
    const band = (x: THREE.Node<'float'>, a: number, b: number) =>
      smoothstep(a - 0.006, a + 0.006, x).mul(float(1).sub(smoothstep(b - 0.006, b + 0.006, x)));
    const twin = band(ax, 0.07, 0.2);
    const wide = float(1).sub(smoothstep(float(0.24).sub(aa), float(0.24).add(aa), ax));
    const side = smoothstep(0.62, 0.7, ax).mul(band(h, 0.36, 0.45));
    const two = float(1).sub(smoothstep(0.405, 0.415, h));
    const is = (k: number) => float(1).sub(smoothstep(0.4, 0.6, abs(u.style.sub(k))));
    return twin.mul(is(1)).add(wide.mul(is(2))).add(side.mul(is(3))).add(two.mul(is(4))).clamp(0, 1);
  })();

  // Dynamic WGSL dirt & wear mask (x=dirtCoverage, y=wetSplatter, z=wearHaze)
  const dirtMask = evalCarDirtWearWgsl({
    pLocal,
    nLocal,
    bottomY: u.bottom,
    topY: u.top,
    wear: u.wear,
    driveTime: u.driveTime,
  }) as unknown as THREE.Node<'vec3'>;

  const basePaint = mix(materialColor, rgb(u.color), liveryMask);

  // Layer 1 + Layer 2 color response in WGSL (metallic flop + 3D micro-flakes + grime blend)
  paint.colorNode = evalDualLayerPaintColorWgsl({
    baseColor: basePaint,
    pLocal,
    nWorld: normalWorld,
    vWorld,
    flopStrength: u.flopStrength,
    flakeStrength: u.flakeStrength,
    clearcoatAmt: materialClearcoat,
    dirtMask,
  }) as unknown as THREE.Node<'vec3'>;

  // Dynamic PBR parameter modulation from dirt/wear mask:
  // - Base roughness rises toward matte mud/dust (0.88)
  // - Metalness drops to 0 under opaque grime
  // - Clearcoat drops toward 0 where mud covers lacquer
  // - Clearcoat roughness rises with fine road-film haze + grime
  paint.roughnessNode = mix(materialRoughness, float(0.88), dirtMask.x.max(dirtMask.z.mul(0.35))).clamp(0.04, 0.96);
  paint.metalnessNode = materialMetalness.mul(float(1).sub(dirtMask.x.mul(0.92))).clamp(0, 1);
  paint.clearcoatNode = materialClearcoat.mul(float(1).sub(dirtMask.x.mul(0.94))).clamp(0, 1);
  paint.clearcoatRoughnessNode = mix(
    materialClearcoatRoughness,
    float(0.46),
    dirtMask.x.mul(0.85).add(dirtMask.z.mul(0.4)).clamp(0, 1),
  ).clamp(0.01, 0.65);

  // Underglow sill wash (unchanged visual contract)
  const hLow = pLocal.y.sub(u.bottom).div(u.top.sub(u.bottom).max(0.25));
  const under = float(1).sub(smoothstep(0.02, 0.2, hLow));
  paint.emissiveNode = rgb(u.glow).mul(u.glowAmt.mul(under).mul(0.18));

  return u;
}
