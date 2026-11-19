// Thin Three.js WebGPU adapter for the engine-agnostic Dual-Layer PBR Car Paint core (`web/src/gpu/materials/`).
// Samples the pre-baked 512x512 tileable RGBA dirt/splatter/streak texture (`car_dirt_mask_rgba.png`)
// instead of running procedural 3D FBM loops per pixel (~5-6x lower fragment ALU on integrated GPUs).
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
  texture,
  uniform,
  vec2,
  vec4,
  wgslFn,
} from 'three/tsl';
import {
  CAR_DIRT_MASK_TEXTURE_PATH,
  CAR_PAINT_FINISHES,
  advancePaintWear,
  carPaintWgslSource,
  createPaintWearState,
  resetPaintWear,
  type CarPaintFinishName,
  type PaintWearAccumulator,
  type PaintWearFrameInput,
} from '../gpu/materials/carPaint';

export {
  CAR_PAINT_FINISHES,
  advancePaintWear,
  createPaintWearState,
  resetPaintWear,
  type CarPaintFinishName,
  type PaintWearAccumulator,
  type PaintWearFrameInput,
};

function extractFn(source: string, name: string): string {
  const re = new RegExp(`fn\\s+${name}\\b[\\s\\S]*?\\n\\}`, 'm');
  const m = source.match(re);
  if (!m) throw new Error(`car_paint.wgsl: missing fn ${name}`);
  return m[0];
}

type WgslInclude = Parameters<typeof wgslFn>[1];
const hash3dPaintWgsl = wgslFn(extractFn(carPaintWgslSource, 'hash3dPaint'));
const evalCarDirtWearTexWgsl = wgslFn(extractFn(carPaintWgslSource, 'evalCarDirtWearTex'));
const evalDualLayerPaintColorWgsl = wgslFn(
  extractFn(carPaintWgslSource, 'evalDualLayerPaintColor'),
  [hash3dPaintWgsl] as unknown as WgslInclude,
);

let sharedDirtTex: THREE.Texture | null = null;
/** Shared 512x512 tileable RGBA dirt/splatter/streak mask loaded once for all cars. */
function getCarDirtMaskTexture(): THREE.Texture {
  if (sharedDirtTex) return sharedDirtTex;
  const tex = new THREE.TextureLoader().load(CAR_DIRT_MASK_TEXTURE_PATH);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  sharedDirtTex = tex;
  return tex;
}

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
  /** Gameplay-driven dirt/wear, scrape/damage scuff, and rival wake spray [0..1] */
  wear: THREE.UniformNode<'float', number>;
  scuff: THREE.UniformNode<'float', number>;
  wakeSpray: THREE.UniformNode<'float', number>;
}

/**
 * Installs the dual-layer PBR clear-coat WGSL shader + livery stripes + texture-sampled dirt/wear mask
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
    scuff: uniform(0),
    wakeSpray: uniform(0),
  };

  const pLocal = u.inv.mul(vec4(positionWorld, 1)).xyz;
  const nLocal = u.inv.mul(vec4(normalWorld, 0)).xyz.normalize();
  const vWorld = cameraPosition.sub(positionWorld).normalize();

  // Model-space livery mask
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

  // Two hardware-filtered samples of the 512x512 tileable RGBA dirt/splatter/streak mask
  const dirtTex = getCarDirtMaskTexture();
  const sideUv = vec2(pLocal.z.mul(0.55), pLocal.y.mul(0.85));
  const topUv = vec2(pLocal.x.mul(0.65), pLocal.z.mul(0.45));
  const texSide = texture(dirtTex, sideUv);
  const texTop = texture(dirtTex, topUv);

  const dirtMask = evalCarDirtWearTexWgsl({
    pLocal,
    nLocal,
    bottomY: u.bottom,
    topY: u.top,
    wear: u.wear,
    scuff: u.scuff,
    wakeSpray: u.wakeSpray,
    texSide,
    texTop,
  }) as unknown as THREE.Node<'vec3'>;

  const basePaint = mix(materialColor, rgb(u.color), liveryMask);

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

  paint.roughnessNode = mix(materialRoughness, float(0.88), dirtMask.x.max(dirtMask.z.mul(0.35))).clamp(0.04, 0.96);
  paint.metalnessNode = materialMetalness.mul(float(1).sub(dirtMask.x.mul(0.92))).clamp(0, 1);
  paint.clearcoatNode = materialClearcoat.mul(float(1).sub(dirtMask.x.mul(0.94))).clamp(0, 1);
  paint.clearcoatRoughnessNode = mix(
    materialClearcoatRoughness,
    float(0.46),
    dirtMask.x.mul(0.85).add(dirtMask.z.mul(0.4)).clamp(0, 1),
  ).clamp(0.01, 0.65);

  const hLow = pLocal.y.sub(u.bottom).div(u.top.sub(u.bottom).max(0.25));
  const under = float(1).sub(smoothstep(0.02, 0.2, hLow));
  paint.emissiveNode = rgb(u.glow).mul(u.glowAmt.mul(under).mul(0.18));

  return u;
}
