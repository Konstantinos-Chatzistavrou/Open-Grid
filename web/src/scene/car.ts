// Car visuals: glTF model, wheels driven by the core's suspension output, headlights, brake lights,
// soft ground contact shadow, and realistic radial spoke motion blur.
import * as THREE from 'three/webgpu';
import { applyPlate } from './plate';
import { abs, float, max, mix, normalView, pow, sin, smoothstep, texture, time, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { noise01 } from '../fx/noiseTex';
import { OUT } from '../physics/core';
import { materialsOf } from './city';
import { assetUrl, loadGLTF } from './loaders';

import type { DamageVisualConfig } from './damage';
import { FINISHES, type Finish } from '../garage';
import { CarCustomizer, installAero, installLivery } from './custom';
import type { CarPaintWgslUniforms } from '../fx/carPaintWgsl';
import { exactBox } from './parts/fit';
import { Driver } from './driver';
import { mergeStaticMeshes } from './merge';

/**
 * The garage's click-a-part classes, in the order main.ts (partTab) tests them on "mesh name + material name + ancestor
 * names". When a part's own or ancestor names give it a class its merged mesh's name and material would not, the merged
 * mesh carries that class's token, so a click on it opens the same tab a click on the original part did (each token
 * matches its own class and no earlier one).
 */
const PICK: [RegExp, string][] = [
  [/wheel|rim|tire|tyre|caliper|disc/i, 'disc'],
  [/headlight|tail|lamp|light/i, 'lamp'],
  [/glass|window|windshield|exhaust/i, 'window'],
  [/wing|spoiler|diffuser|splitter|skirt/i, 'diffuser'],
  [/fender/i, 'fender'],
  [/hood|bumper/i, 'bumper'],
  [/driver|helmet/i, 'helmet'],
];
const pickClass = (s: string) => PICK.findIndex(([re]) => re.test(s));
/** main.ts dimLamps finds the showroom-dimmed lamp materials by material OR mesh name */
const DIM = /light|drl|lens|beam|tail/i;
/** CarVisual.detectExhaustNozzles finds the tailpipes by mesh OR material name (cars without baked exhaust_nozzles) */
const EXH = /exhaust|tailpipe|muffler/i;

export interface CarVisualConfig extends DamageVisualConfig {
  model: string;
  lod_model: string;
  cg_in_model_m: [number, number, number];
  wheel_nodes: { fl: string; fr: string; rl: string; rr: string };
  /** driver's hip point in model space (x = left, y = up, z = forward) and figure scale */
  driver_seat_m?: [number, number, number];
  driver_scale?: number;
  /** opaque cabin shells that would hide the driver (no cockpit is drawn: the driver is) */
  hide_for_driver?: string[];
  /** Model track minus physics track, per side (m): the wheels sit this much further out. */
  wheel_visual_offset_m?: number;
  collision_box: { size_m: [number, number, number]; centre_in_model_m: [number, number, number]; end_lift_m: number; end_lift_start_m: number };
  paint_material: string;
  default_paint: [number, number, number];
  headlights: [number, number, number][];
}

/**
 * Subtle sprayed clear-coat waviness normal map (256x256 tileable fractal value noise).
 * Kept fine so reflections look like mirror-polished factory lacquer rather than pebbled plastic.
 */
let peelTex: THREE.DataTexture | null = null;
function orangePeel() {
  if (peelTex) return peelTex;
  const N = 256, h = new Float32Array(N * N);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let oct = 0, cells = 32, amp = 1; oct < 3; oct++, cells *= 2, amp *= 0.5) {
    const g = new Float32Array(cells * cells).map(rnd);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells, fy = (y / N) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      h[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
  }
  const px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)];
    const dy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
    const nx = -dx * 4.5, ny = -dy * 4.5, l = Math.hypot(nx, ny, 1), i = (y * N + x) * 4;
    px[i] = (nx / l * 0.5 + 0.5) * 255; px[i + 1] = (ny / l * 0.5 + 0.5) * 255; px[i + 2] = (1 / l * 0.5 + 0.5) * 255; px[i + 3] = 255;
  }
  peelTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  peelTex.wrapS = peelTex.wrapT = THREE.RepeatWrapping;
  peelTex.repeat.set(28, 28);
  peelTex.generateMipmaps = true;
  peelTex.minFilter = THREE.LinearMipmapLinearFilter;
  peelTex.magFilter = THREE.LinearFilter;
  peelTex.anisotropy = 4;
  peelTex.needsUpdate = true;
  return peelTex;
}

/**
 * Fine metallic basecoat micro-flake normal map for cars whose GLB paint has no embedded flake map.
 * Gives metallic/pearl/candy finishes authentic sparkling micro-facets beneath the smooth clear coat.
 */
let flakeTex: THREE.DataTexture | null = null;
function metallicFlake() {
  if (flakeTex) return flakeTex;
  const N = 256, px = new Uint8Array(N * N * 4);
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Tileable 2x2 micro-grain cells so adjacent pixels form crisp tiny metallic platelets
  const G = 128, gx = new Float32Array(G * G), gy = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) {
    const ang = rnd() * Math.PI * 2, tilt = 0.08 * Math.sqrt(rnd());
    gx[i] = Math.cos(ang) * tilt;
    gy[i] = Math.sin(ang) * tilt;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = Math.floor((x / N) * G) % G, cy = Math.floor((y / N) * G) % G;
    const nx = gx[cy * G + cx], ny = gy[cy * G + cx], nz = Math.sqrt(Math.max(0.1, 1 - nx * nx - ny * ny));
    const i = (y * N + x) * 4;
    px[i] = (nx * 0.5 + 0.5) * 255;
    px[i + 1] = (ny * 0.5 + 0.5) * 255;
    px[i + 2] = (nz * 0.5 + 0.5) * 255;
    px[i + 3] = 255;
  }
  flakeTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  flakeTex.wrapS = flakeTex.wrapT = THREE.RepeatWrapping;
  // 56 repeats over a ~4 m body put each platelet at a few tenths of a millimetre - invisible at 2 m, which read as
  // "no flake" in the garage. 24 repeats is a ~1.3 mm platelet, the Heat-scale sparkle you can see standing next to it.
  flakeTex.repeat.set(24, 24);
  flakeTex.generateMipmaps = true;
  flakeTex.minFilter = THREE.LinearMipmapLinearFilter;
  flakeTex.magFilter = THREE.LinearFilter;
  flakeTex.anisotropy = 4;
  flakeTex.needsUpdate = true;
  return flakeTex;
}

/**
 * Soft under-chassis + 4-tire contact ambient-occlusion shadow map (256x256).
 * Grounds every car onto wet asphalt and showroom floors without dynamic shadow-map cost.
 */
let shadowTex: THREE.DataTexture | null = null;
function contactShadowTex() {
  if (shadowTex) return shadowTex;
  const N = 256, px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const v = (y / (N - 1)) * 2 - 1; // -1 rear .. +1 front
    for (let x = 0; x < N; x++) {
      const u = (x / (N - 1)) * 2 - 1; // -1 right .. +1 left
      // Rounded-box signed distance for the underbody footprint (u in [-0.70, 0.70], v in [-0.76, 0.76])
      const qx = Math.max(0, Math.abs(u) - 0.56), qy = Math.max(0, Math.abs(v) - 0.62);
      const dist = Math.hypot(qx, qy);
      const bodyAo = Math.max(0, 1 - dist / 0.34);
      const bodySoft = bodyAo * bodyAo * (3 - 2 * bodyAo) * 0.86;
      // Extra concentrated contact patches directly beneath the 4 tires
      let tyreAo = 0;
      for (const tu of [-0.66, 0.66]) {
        for (const tv of [-0.52, 0.50]) {
          const d = Math.hypot((u - tu) / 0.19, (v - tv) / 0.22);
          const w = Math.max(0, 1 - d);
          tyreAo = Math.max(tyreAo, w * w * 0.94);
        }
      }
      const alpha = Math.min(1, Math.max(bodySoft, tyreAo));
      const i = (y * N + x) * 4;
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = Math.round(alpha * 255);
    }
  }
  shadowTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  shadowTex.generateMipmaps = true;
  shadowTex.minFilter = THREE.LinearMipmapLinearFilter;
  shadowTex.magFilter = THREE.LinearFilter;
  shadowTex.needsUpdate = true;
  return shadowTex;
}

/**
 * Radial motion-blurred forged-alloy spoke texture (256x256 RGBA) for high-speed wheels.
 * Keeps semi-transparent swept gaps between blurred spoke arcs so brake calipers & rotors remain subtly visible.
 */
let blurSpokeTex: THREE.DataTexture | null = null;
function spokeBlurTex() {
  if (blurSpokeTex) return blurSpokeTex;
  const N = 256, px = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    const dy = (y / (N - 1)) * 2 - 1;
    for (let x = 0; x < N; x++) {
      const dx = (x / (N - 1)) * 2 - 1;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      // 5 twin-spoke radial blur harmonics + concentric machined rings
      const s5 = 0.5 + 0.5 * Math.cos(ang * 5);
      const s10 = 0.5 + 0.5 * Math.cos(ang * 10 + 0.4);
      const spokeBand = 0.52 + 0.30 * s5 + 0.18 * s10;
      const ring = 0.88 + 0.12 * Math.sin(r * 38);
      const hub = r < 0.28 ? 0.95 : 0;
      const innerFade = THREE.MathUtils.smoothstep(r, 0.16, 0.26);
      const outerFade = 1 - THREE.MathUtils.smoothstep(r, 0.84, 0.98);
      const alpha = Math.max(hub * (1 - THREE.MathUtils.smoothstep(r, 0.22, 0.30)), innerFade * outerFade * (0.38 + 0.42 * spokeBand));
      const lum = Math.round(THREE.MathUtils.clamp((0.26 + 0.28 * spokeBand) * ring, 0, 1) * 255);
      const i = (y * N + x) * 4;
      px[i] = lum;
      px[i + 1] = Math.min(255, Math.round(lum * 1.02));
      px[i + 2] = Math.min(255, Math.round(lum * 1.06));
      px[i + 3] = Math.round(THREE.MathUtils.clamp(alpha, 0, 1) * 255);
    }
  }
  blurSpokeTex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat);
  blurSpokeTex.colorSpace = THREE.SRGBColorSpace;
  blurSpokeTex.generateMipmaps = true;
  blurSpokeTex.minFilter = THREE.LinearMipmapLinearFilter;
  blurSpokeTex.magFilter = THREE.LinearFilter;
  blurSpokeTex.needsUpdate = true;
  return blurSpokeTex;
}

/** Grounded under-car contact shadow plane (shared by player, AI traffic, and remote cars). */
export function createContactShadow(width = 2.35, length = 4.95, centerZ = -0.05, strengthNode?: THREE.Node<'float'>) {
  const geo = new THREE.PlaneGeometry(width, length);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const tex = texture(contactShadowTex(), uv());
  const op = strengthNode ? tex.a.mul(strengthNode) : tex.a.mul(0.88);
  m.colorNode = vec4(0, 0, 0, 1);
  m.opacityNode = op;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'wheel_contact_shadow'; // 'wheel_' prefix: ignored by DamageVisuals denting
  mesh.position.set(0, 0.015, centerZ);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = -1;
  return mesh;
}

/** Deep-clone a cached GLTF scene along with its material table (preserving intra-model material sharing). */
function cloneCarScene(src: THREE.Object3D): THREE.Object3D {
  const root = src.clone(true);
  const clonedMats = new Map<THREE.Material, THREE.Material>();
  const mapMat = (m: THREE.Material) => {
    let c = clonedMats.get(m);
    if (!c) { c = m.clone(); clonedMats.set(m, c); }
    return c;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(mapMat) : mapMat(mesh.material);
  });
  return root;
}

const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1), ONE = new THREE.Vector3(1, 1, 1);
/** Shared unit ring geometries across all cars & wheels (cuts mobile GPU buffer allocations by 8x). */
let sharedBlurRingGeo: THREE.RingGeometry | null = null;
let sharedRotorRingGeo: THREE.RingGeometry | null = null;

/**
 * Game-side material setup shared by the player, AI and remote cars:
 *  - paint: dual-layer automotive clear coat + metallic micro-flake normal + fine lacquer orange peel;
 *  - glass: smoked automotive laminated physical glass with sharp Fresnel clear-coat sky/neon reflections;
 *  - carbon, mirrors, rims, rotors, and tyres tuned for physically plausible night/studio response.
 */
export function setupCarMaterials(model: THREE.Object3D, cfg: CarVisualConfig, paint: THREE.ColorRepresentation | null, shadows = true) {
  let paintMat: THREE.MeshPhysicalMaterial | null = null;
  let glassMat: THREE.MeshPhysicalMaterial | null = null;
  let carbonMat: THREE.MeshPhysicalMaterial | null = null;
  const color = paint === null ? new THREE.Color().setRGB(...cfg.default_paint, THREE.SRGBColorSpace) : new THREE.Color(paint);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.name === 'wheel_contact_shadow') return;
    m.castShadow = true;
    m.receiveShadow = shadows;
    const mats = materialsOf(m);
    mats.forEach((mat, i) => {
      const assign = (next: THREE.Material) => {
        if (Array.isArray(m.material)) m.material[i] = next; else m.material = next;
      };
      if (mat.name === cfg.paint_material) {
        if (!paintMat) {
          const src = mat as unknown as THREE.MeshPhysicalMaterial;
          const nodePaint = new THREE.MeshPhysicalNodeMaterial({
            name: mat.name,
            map: src.map ?? null,
            normalMap: src.normalMap ?? metallicFlake(),
            normalScale: src.normalMap ? src.normalScale.clone() : new THREE.Vector2(0.05, 0.05),
            roughnessMap: src.roughnessMap ?? null,
            metalnessMap: src.metalnessMap ?? null,
            aoMap: src.aoMap ?? null,
            metalness: 0.45,
            roughness: 0.22,
          });
          nodePaint.clearcoat = 1;
          nodePaint.clearcoatRoughness = 0.018;   // hard, near-mirror lacquer coat highlight
          nodePaint.clearcoatNormalMap = orangePeel();
          nodePaint.clearcoatNormalScale.set(0.018, 0.018);
          nodePaint.ior = 1.52;
          nodePaint.specularIntensity = 1.08;
          nodePaint.iridescenceIOR = 1.7;
          nodePaint.iridescenceThicknessRange = [200, 520];
          nodePaint.envMapIntensity = 1.45;
          nodePaint.color.copy(color);
          nodePaint.userData.livery = installLivery(nodePaint as unknown as THREE.MeshPhysicalMaterial);   // dual-layer WGSL car paint + liveries + dirt/wear
          paintMat = nodePaint as unknown as THREE.MeshPhysicalMaterial;
        }
        if (paintMat) assign(paintMat);
        return;
      }
      if (mat.name === 'glass') {
        if (!glassMat) {
          glassMat = new THREE.MeshPhysicalMaterial({
            name: 'glass',
            color: new THREE.Color(0x06080c),
            transparent: true,
            opacity: 0.64,
            roughness: 0.015,
            metalness: 0.04,
            ior: 1.52,
            specularIntensity: 1.0,
            clearcoat: 1.0,
            clearcoatRoughness: 0.01,
            envMapIntensity: 1.9,
            depthWrite: false,
          });
        }
        assign(glassMat);
        return;
      }
      if (mat.name === 'carbon') {
        if (!carbonMat) {
          const std = mat as THREE.MeshStandardMaterial;
          carbonMat = new THREE.MeshPhysicalMaterial({
            name: 'carbon',
            color: std.color ? std.color.clone() : new THREE.Color(0x101215),
            map: std.map ?? null,
            normalMap: std.normalMap ?? null,
            normalScale: std.normalScale ? std.normalScale.clone() : new THREE.Vector2(0.4, 0.4),
            roughnessMap: std.roughnessMap ?? null,
            aoMap: std.aoMap ?? null,
            metalness: 0.24,
            roughness: 0.28,
            clearcoat: 0.82,
            clearcoatRoughness: 0.06,
            envMapIntensity: 1.35,
          });
          carbonMat.userData.aero = installAero(carbonMat);      // garage aero finishes
        }
        assign(carbonMat);
        return;
      }
      if (/^mirror_glass$|^mirror\./i.test(mat.name)) {
        const std = mat as THREE.MeshStandardMaterial;
        std.color?.setHex(0xf2f6ff);
        std.metalness = 1.0;
        std.roughness = 0.015;
        std.envMapIntensity = 1.8;
      } else if (/^tyre/i.test(mat.name)) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.color && std.color.r < 0.025) std.color.setRGB(0.036, 0.038, 0.042);
        std.metalness = 0.0;
        std.roughness = Math.min(Math.max(std.roughness ?? 0.78, 0.68), 0.82);
      } else if (/^rim/i.test(mat.name)) {
        const std = mat as THREE.MeshStandardMaterial;
        std.metalness = Math.max(std.metalness ?? 0.9, 0.88);
        std.roughness = Math.min(std.roughness ?? 0.22, 0.24);
        std.envMapIntensity = 1.5;
      } else if (mat.name === 'disc') {
        const std = mat as THREE.MeshStandardMaterial;
        std.metalness = 0.92;
        std.roughness = 0.26;
        std.envMapIntensity = 1.35;
      }
      if (mat.name === 'light_beam') m.visible = false;   // fake beams: replaced by real spot lights
    });
  });
  model.userData.carMats = { paint: paintMat, glass: glassMat, carbon: carbonMat };
  // Panel badges: if the GLB doesn't already carry our Blender-sculpted OpenGrid 3D crests (`badge_nose`/`badge_rear`),
  // place a clean chrome fallback emblem sized from the model's own bounds.
  try {
    const hasBakedBadges = !!(model.getObjectByName('badge_nose') || model.getObjectByName('badge_rear'));
    const bb = new THREE.Box3().setFromObject(model);
    const h = bb.max.y - bb.min.y;
    if (!hasBakedBadges && h > 0.5) {
      const chrome = new THREE.MeshPhysicalMaterial({ name: 'badge_chrome', color: 0xdfe3e8, metalness: 1, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.04 });
      const ring = new THREE.TorusGeometry(h * 0.042, h * 0.0075, 8, 32);
      const nose = new THREE.Mesh(ring, chrome);
      nose.position.set(0, bb.min.y + h * 0.46, bb.max.z + 0.012);
      nose.name = 'badge_nose';
      const rear = new THREE.Mesh(ring, chrome);
      rear.position.set(0, bb.min.y + h * 0.5, bb.min.z - 0.012);
      rear.name = 'badge_rear';
      model.add(nose, rear);
    }
  } catch { /* badges are cosmetic */ }
  return paintMat as THREE.MeshPhysicalMaterial | null;
}

export class CarVisual {
  readonly root = new THREE.Group();          // placed at the physics body (CG)
  private wheels: { node: THREE.Object3D; rest: THREE.Quaternion; restPos: THREE.Vector3; radius: number; caliper?: THREE.Object3D; caliperRest?: THREE.Quaternion; spin: number; off: boolean; hub: THREE.Vector3; rotorHeat: THREE.UniformNode<'float', number> }[] = [];
  /** seconds between DRAWN frames (main.ts sets it from the cap): decides when the spokes alias and the blur disc takes over */
  renderDt = 1 / 60;
  private blurMat: THREE.MeshStandardNodeMaterial | null = null;
  /** blur disc strength (0..1): a shader uniform, because a plain material.opacity change is not picked up after the first compile */
  private blurOp = uniform(0);
  private shadowOp = uniform(0.92);
  private contactShadow: THREE.Mesh;
  private tailMats: THREE.MeshStandardMaterial[] = [];
  private lastUpdate = 0;
  /** headlight strength factor: 1 driving, ~0.015 in the showroom (title/garage), where bright nose spots otherwise bloom into a fireball */
  dim = 1;
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private tmpCentre = new THREE.Vector3();
  private physInv = new THREE.Matrix4();
  readonly cg: THREE.Vector3;
  headlights: THREE.SpotLight[] = [];
  readonly headlightIntensity = 900;
  /** Headlight switch (L). Off = intensity 0, never visible = false (that recompiles every material). */
  lightsOn = true;
  lightsBroken = false;
  readonly velocity = new THREE.Vector3();   // m/s, world (for debris)
  /** The car's own clone of the paint material (garage colour + finish). */
  readonly paint: THREE.MeshPhysicalMaterial | null;
  /** garage parts and colours (custom.ts) and the driver in the seat (driver.ts) */
  readonly custom: CarCustomizer;
  readonly driver: Driver;

  private constructor(readonly cfg: CarVisualConfig, readonly model: THREE.Object3D, shared?: THREE.SpotLight[]) {
    this.cg = new THREE.Vector3(...cfg.cg_in_model_m);
    model.position.copy(this.cg).negate();
    this.root.add(model);
    const n = cfg.wheel_nodes;
    for (const name of [n.fl, n.fr, n.rl, n.rr]) {
      const node = model.getObjectByName(name)!;
      const caliper = model.getObjectByName(name.replace('wheel', 'caliper'));
      this.recentreWheel(node);
      const rotorHeat = uniform(0);
      const radius = this.addBlurDisc(node, rotorHeat);
      this.wheels.push({
        node,
        rest: node.quaternion.clone(),
        restPos: node.position.clone(),
        radius,
        caliper,
        caliperRest: caliper?.quaternion.clone(),
        spin: 0,
        off: false,
        hub: node.position.clone(),
        rotorHeat,
      });
    }
    this.paint = setupCarMaterials(model, cfg, null);
    // Collect rear taillight materials so braking dynamically boosts tail glow
    const seenTail = new Set<THREE.Material>();
    for (const nm of cfg.rear_lights ?? []) {
      model.getObjectByName(nm)?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        for (const mat of materialsOf(m) as THREE.MeshStandardMaterial[]) {
          if (mat.emissive && (mat.emissive.r > 0.05 || /tail/i.test(mat.name)) && !seenTail.has(mat)) {
            seenTail.add(mat);
            this.tailMats.push(mat);
          }
        }
      });
    }
    // Soft ground contact shadow beneath chassis + 4 tires
    const cb = cfg.collision_box;
    this.contactShadow = createContactShadow(cb.size_m[0] * 1.24, cb.size_m[2] * 1.18, cb.centre_in_model_m[2], this.shadowOp as unknown as THREE.Node<'float'>);
    model.add(this.contactShadow);

    // The player's own car never needs to be in its headlight shadow map (the spots sit at its nose and shine away
    // from it): skipping its triangles + dent shader saves the biggest part of every shadow-update frame.
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = false; });

    for (const [i, hp] of cfg.headlights.entries()) {
      const s = shared?.[i] ?? new THREE.SpotLight(0xfff3e0, this.headlightIntensity, 70, 0.42, 0.45, 2);
      s.position.set(hp[0], hp[1], hp[2]).sub(this.cg);
      s.target.position.copy(s.position).add(new THREE.Vector3(0, -1.1, 14));
      if (!shared) {
        s.castShadow = i === 0;
        s.shadow.mapSize.set(1024, 1024);
        s.shadow.camera.near = 0.3;
        s.shadow.bias = -0.0004;
      }
      this.root.add(s, s.target);
      this.headlights.push(s);
    }
    const mats = model.userData.carMats as { paint: THREE.MeshPhysicalMaterial | null; glass: THREE.MeshPhysicalMaterial | null; carbon: THREE.MeshPhysicalMaterial | null };
    this.custom = new CarCustomizer(model, mats.paint, mats.glass, mats.carbon, this.headlights, this.wheels.map((w) => w.node));
    this.custom.onWidebodyTrack = (m) => { this.widebodyTrackM = m; };
    this.driver = new Driver(new THREE.Vector3(...(cfg.driver_seat_m ?? [0.36, 0.25, -0.3])));
    this.driver.root.scale.setScalar(cfg.driver_scale ?? 0.93);
    model.add(this.driver.root);
    for (const nm of cfg.hide_for_driver ?? []) { const o = model.getObjectByName(nm); if (o) o.visible = false; }
    if (typeof location === 'undefined' || new URLSearchParams(location.search).get('merge') !== '0') this.mergeStatic();
  }

  /**
   * Draw calls: the hero models are 34-143 meshes, and the car is drawn in the main pass, the planar road reflection and
   * the rear-view mirror (each draw costs CPU in three's WebGPU backend). Meshes that never move or change on their own
   * are merged by material (merge.ts) into the model; the rigid parts that move as one (the detachable bumpers and mirrors:
   * they sag and break off) are merged inside themselves. Kept as they are: wheels and calipers, every node the garage
   * swaps, hides or moves (custom.ts ownedNodes), the lamp nodes crash damage darkens (front_lights / rear_lights), a lamp
   * or tailpipe mesh whose material name does not say so (dimLamps and the flame anchors find those by mesh name), the
   * cockpit shells hidden for the driver, the driver, the contact shadow and anything hidden. Dents, paint and part colours
   * are per material and the dent matrices are taken after this (DamageVisuals), so they work on the merged meshes.
   * ?merge=0 keeps every mesh.
   */
  private mergeStatic() {
    const cfg = this.cfg, model = this.model;
    const keep: THREE.Object3D[] = [this.contactShadow, this.driver.root, ...this.custom.ownedNodes()];
    for (const w of this.wheels) { keep.push(w.node); if (w.caliper) keep.push(w.caliper); }
    for (const nm of [...(cfg.front_lights ?? []), ...(cfg.rear_lights ?? []), ...(cfg.hide_for_driver ?? [])]) {
      const o = model.getObjectByName(nm);
      if (o) keep.push(o);
    }
    const scanExhaust = !(cfg as unknown as { exhaust_nozzles?: unknown[] }).exhaust_nozzles?.length;
    const named = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return false;
      const mat = materialsOf(m)[0]?.name ?? '';
      return (DIM.test(m.name) && !DIM.test(mat)) || (scanExhaust && EXH.test(m.name) && !EXH.test(mat));
    };
    // garage click class: the part's (mesh + material + ancestors) against the merged mesh's (name + material + ancestors)
    const tagFor = (root: THREE.Object3D) => {
      let above = '';
      for (let p: THREE.Object3D | null = root; p && p !== model; p = p.parent) above += ` ${p.name}`;
      return (m: THREE.Mesh, mat: THREE.Material, mergedName: string) => {
        let s = `${m.name} ${mat.name}`;
        for (let p = m.parent; p && p !== model; p = p.parent) s += ` ${p.name}`;
        const c = pickClass(s);
        return c < 0 || c === pickClass(`${mergedName} ${mat.name}${above}`) ? '' : PICK[c][1];
      };
    };
    const rigid = Object.keys(cfg.detachable ?? {}).map((nm) => model.getObjectByName(nm)).filter((o): o is THREE.Object3D => !!o);
    let saved = 0;
    for (const r of rigid) saved += mergeStaticMeshes(r, keep.filter((k) => k !== r), named, tagFor(r));
    saved += mergeStaticMeshes(model, [...keep, ...rigid], named, tagFor(model));
    let drawn = 0;
    model.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) drawn++; });
    model.userData.mergedAway = saved;
    console.info(`car ${cfg.model}: ${saved} meshes merged away, ${drawn} visible meshes left`);
  }

  /**
   * Radial spoke motion-blur ring placed slightly inboard of the outer rim lip so the 3D tyre sidewall,
   * outer rim lip, and inner brake caliper/rotor stay sharp while alloy spokes blur naturally at speed.
   * Returns measured outer tyre radius (m).
   */
  /**
   * A wheel node must sit at its hub, in the model's own space: the game steers and spins the node about its origin.
   * A node authored with its origin elsewhere is re-pivoted (the node moves to the hub, its children move back by the
   * same amount); nothing changes on screen.
   */
  private recentreWheel(node: THREE.Object3D) {
    // First: the node hangs directly under the model. Everything below places a wheel in MODEL space (hub position
    // from the physics, steer about the model's Y, spin about its X). The K-Concept's wheels hang under a node turned
    // -90 deg about X (a Z-up export): their "y" was the model's -z, so the car measured its ground 1.8 m too low and
    // stood that far above the garage floor.
    if (node.parent && node.parent !== this.model) { this.model.updateWorldMatrix(true, true); this.model.attach(node); }
    node.updateWorldMatrix(true, true);
    const b = exactBox(node, new THREE.Matrix4().copy(node.matrixWorld).invert(), (m) => m.name.startsWith('wheel_blur_'));
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3());
    if (c.length() < 0.02) return;
    for (const ch of node.children) ch.position.sub(c);
    node.position.add(c.clone().multiply(node.scale).applyQuaternion(node.quaternion));
    node.updateMatrixWorld(true);
  }

  private addBlurDisc(node: THREE.Object3D, rotorHeat: THREE.UniformNode<'float', number>): number {
    const rimBox = new THREE.Box3(), all = new THREE.Box3(), tmp = new THREE.Box3();
    // Boxes in the wheel node's own space. The transform is the whole chain below the node (quantized glTF meshes
    // carry their scale on a node between the wheel and the mesh): with the mesh's local matrix alone the tyre
    // measured 1 m in radius and everything derived from it (contact shadow height, blur disc) was wrong.
    node.updateWorldMatrix(true, true);
    // exact vertex extents (exactBox): a tyre mesh modelled at an angle inflates a transformed bounding box
    const nodeInv = new THREE.Matrix4().copy(node.matrixWorld).invert();
    const isRim = (m: THREE.Object3D) => { for (let o: THREE.Object3D | null = m; o && o !== node; o = o.parent) if (/rim/i.test(o.name)) return true; return false; };
    all.copy(exactBox(node, nodeInv, (m) => m.name.startsWith('wheel_blur_')));
    rimBox.copy(exactBox(node, nodeInv, (m) => m.name.startsWith('wheel_blur_') || !isRim(m)));
    void tmp;
    const box = rimBox.isEmpty() ? all : rimBox;
    const tyreRadius = all.isEmpty() ? 0.335 : Math.max(all.max.y - all.min.y, all.max.z - all.min.z) / 2;
    if (box.isEmpty()) return tyreRadius;
    const rimRadius = Math.min(tyreRadius * 0.76, Math.max(box.max.y - box.min.y, box.max.z - box.min.z) / 2 * 0.92);
    const side = node.position.x >= 0 ? 1 : -1;
    // Place recessed 14 mm inside the outer rim lip so center-lock nuts & rim lips stay crisp in 3D
    const outerX = side > 0 ? box.max.x : box.min.x;
    const x = outerX - side * 0.014;
    if (!this.blurMat) {
      const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.24, metalness: 0.88, transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const st = texture(spokeBlurTex(), uv());
      m.colorNode = vec4(st.rgb, 1);
      m.opacityNode = st.a.mul(this.blurOp);
      this.blurMat = m;
    }
    if (!sharedBlurRingGeo) sharedBlurRingGeo = new THREE.RingGeometry(0.16, 1.0, 36, 1);
    const ring = new THREE.Mesh(sharedBlurRingGeo, this.blurMat);
    ring.scale.setScalar(rimRadius);
    ring.name = `wheel_blur_${node.name}`;   // 'wheel_' prefix: never dented
    ring.rotation.y = side * Math.PI / 2;
    ring.position.set(x, (box.max.y + box.min.y) / 2, (box.max.z + box.min.z) / 2);
    node.add(ring);

    // Thermal incandescent brake rotor glow ring inboard of spokes (uniform-only: 0 extra lights, 0 shader recompiles)
    const rMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const h = rotorHeat;
    const cherry = vec3(1.15, 0.12, 0.01);
    const bright = vec3(2.8, 1.05, 0.22);
    rMat.colorNode = vec4(mix(cherry, bright, smoothstep(float(0.35), float(1.0), h)).mul(h), 1);
    rMat.opacityNode = h.mul(0.88);
    if (!sharedRotorRingGeo) sharedRotorRingGeo = new THREE.RingGeometry(0.42, 0.79, 28, 1);
    const rotorGlow = new THREE.Mesh(sharedRotorRingGeo, rMat);
    rotorGlow.scale.setScalar(rimRadius);
    rotorGlow.name = `wheel_rotor_glow_${node.name}`;
    rotorGlow.rotation.y = side * Math.PI / 2;
    rotorGlow.position.set(outerX - side * 0.052, (box.max.y + box.min.y) / 2, (box.max.z + box.min.z) / 2);
    node.add(rotorGlow);

    return tyreRadius;
  }

  /**
   * Paint for a finish. Clearcoat is the layer that makes paint read as paint instead of plastic (Metalness-only paint
   * looks like coloured plastic); the flake normal is what gives the metallic sparkle under a key light.
   *
   * Only a define change may set `needsUpdate`: colour, metalness, roughness, clearcoat and the flake normal scale are
   * uniforms, and marking the material dirty for those re-compiled the shader every time the garage changed a finish
   * (a visible hitch while browsing paint).
   */
  setPaint(hex: string, finish: Finish) {
    const m = this.paint;
    if (!m) return;
    const f = FINISHES[finish];
    const wasIri = (m.iridescence ?? 0) > 0;
    m.color.set(hex);
    m.clearcoat = f.clearcoat;
    m.clearcoatRoughness = f.ccRough;   // the coat's own highlight: crisp on candy, a sheen on satin
    m.roughness = f.roughness;
    m.metalness = f.metalness;
    m.iridescence = f.iridescence ?? 0;
    m.envMapIntensity = f.env;          // how much of the city mirrors in the coat (probe per frame)
    // NFS Heat read: metallic and candy flake read as glitter standing next to the car, pearl shimmers, gloss has a
    // quiet grain, satin/matte barely any. normalScale is a uniform, so this costs no recompile.
    const flake = finish === 'metallic' ? 0.20 : finish === 'candy' ? 0.24 : finish === 'pearl' ? 0.14 : finish === 'satin' ? 0.05 : finish === 'matte' ? 0 : 0.08;
    m.normalScale.set(flake, flake);
    const lu = m.userData.livery as CarPaintWgslUniforms | undefined;
    if (lu) {
      lu.flakeStrength.value = finish === 'candy' ? 0.55 : finish === 'metallic' ? 0.48 : finish === 'pearl' ? 0.36 : finish === 'gloss' ? 0.18 : finish === 'satin' ? 0.08 : 0.0;
      lu.flopStrength.value = finish === 'pearl' ? 0.85 : finish === 'candy' ? 0.72 : finish === 'metallic' ? 0.58 : finish === 'gloss' ? 0.32 : finish === 'satin' ? 0.18 : 0.06;
    }
    if (wasIri !== ((m.iridescence ?? 0) > 0)) m.needsUpdate = true;
  }

  /** Model-space height of the tyres' lowest point: the garage sets the model down by this much onto its floor. */
  get groundY() { return this.contactShadow.position.y - 0.014; }

  /** Spot intensity from the switch and the damage state. */
  /** The driver's name on the number plate (plate.ts). */
  setPlate(name: string) { applyPlate(this.model, name); }

  applyHeadlights() {
    for (const s of this.headlights) s.intensity = this.lightsOn && !this.lightsBroken ? this.headlightIntensity * this.dim : 0;
  }

  /** Wheel i (FL FR RL RR): its node, tyre radius and current hub centre in MODEL space (crash damage tears wheels off). */
  wheel(i: number): { node: THREE.Object3D; radius: number; hub: THREE.Vector3 } { return this.wheels[i]; }
  /** A torn-off wheel is no longer placed by the suspension (DamageVisuals flies it as debris); false puts it back. */
  setWheelOff(i: number, off: boolean) { this.wheels[i].off = off; }

  /** Wheel hub centres and outer tyre radii in car MODEL space (used by Dents to keep crumpled fenders out of tyres). */
  wheelWells(): { pos: THREE.Vector3; radius: number }[] {
    const off = (this.cfg.wheel_visual_offset_m ?? 0) + this.widebodyTrackM;
    return this.wheels.map((w) => ({
      pos: new THREE.Vector3(w.restPos.x + Math.sign(w.restPos.x) * off, w.restPos.y, w.restPos.z),
      radius: w.radius,
    }));
  }

  /** Visual stance camber (radians, negative = top tilted inward) matching tuned physics camber 1:1. */
  private camberFrontRad = 0;
  private camberRearRad = 0;
  /** Outward wheel track spacer (m) synced with equipped widebody fender kit so wheels sit flush inside widebody arches. */
  private widebodyTrackM = 0;
  private qc = new THREE.Quaternion();
  /** Photorealistic Mach-diamond exhaust-only flamethrower VFX (anchored strictly to real exhaust tips). */
  private flameGroup: THREE.Group | null = null;
  private flameNozzles: THREE.Object3D[] = [];
  private flameIntU: THREE.UniformNode<'float', number> = uniform(0);
  private flameNosU: THREE.UniformNode<'float', number> = uniform(0);
  private flameLight: THREE.PointLight | null = null;
  private flameLevel = 0;

  setStance(camberFrontDeg: number, camberRearDeg: number) {
    this.camberFrontRad = (camberFrontDeg * Math.PI) / 180;
    this.camberRearRad = (camberRearDeg * Math.PI) / 180;
  }

  /** Detect the exact rear-exit mouth (x, y, z) of every real exhaust pipe on this car model. */
  private detectExhaustNozzles(): { x: number; y: number; z: number; r: number }[] {
    const baked = (this.cfg as unknown as { exhaust_nozzles?: { x: number; y: number; z: number; r?: number }[] }).exhaust_nozzles;
    if (Array.isArray(baked) && baked.length) {
      return baked.map((n) => ({ x: n.x, y: n.y, z: n.z, r: n.r ?? 0.055 }));
    }
    this.model.updateMatrixWorld(true);
    const invModel = this.model.matrixWorld.clone().invert();
    const mLocal = new THREE.Matrix4();
    const vTmp = new THREE.Vector3();
    const buckets: { sx: number; sy: number; minZ: number; minY: number; maxY: number; n: number }[] = [];

    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const mats = materialsOf(mesh);
      const isEx = /exhaust|tailpipe|muffler/i.test(mesh.name || '')
        || mats.some((m) => /exhaust|tailpipe|muffler/i.test(m.name || ''));
      if (!isEx || /flame/i.test(mesh.name || '')) return;
      const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || pos.count === 0) return;
      mLocal.multiplyMatrices(invModel, mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        vTmp.fromBufferAttribute(pos, i).applyMatrix4(mLocal);
        // Only consider vertices near the rear half of the car
        if (vTmp.z > -0.5) continue;
        let b = buckets.find((k) => Math.abs(k.sx / k.n - vTmp.x) < 0.14 && Math.abs(k.sy / k.n - vTmp.y) < 0.14);
        if (!b) {
          b = { sx: 0, sy: 0, minZ: Infinity, minY: Infinity, maxY: -Infinity, n: 0 };
          buckets.push(b);
        }
        b.sx += vTmp.x;
        b.sy += vTmp.y;
        if (vTmp.z < b.minZ) b.minZ = vTmp.z;
        if (vTmp.y < b.minY) b.minY = vTmp.y;
        if (vTmp.y > b.maxY) b.maxY = vTmp.y;
        b.n++;
      }
    });

    if (buckets.length > 0) {
      return buckets
        .filter((b) => b.n >= 4)
        .sort((a, b) => a.sx / a.n - b.sx / b.n)
        .slice(0, 4)
        .map((b) => ({
          x: b.sx / b.n,
          y: (b.minY + b.maxY) * 0.5,
          z: b.minZ + 0.02, // tucked 2 cm inside pipe lip so flame erupts strictly from the bore!
          r: Math.max(0.036, Math.min(0.068, (b.maxY - b.minY) * 0.48)),
        }));
    }

    // Fallback for models without named exhaust meshes: tucked directly into the rear diffuser exit
    const cb = this.cfg.collision_box;
    const rearZ = cb.centre_in_model_m[2] - cb.size_m[2] * 0.5 + 0.04;
    const centerExit = /strix|basilisk/i.test(this.cfg.model);
    const xs = centerExit ? [-0.14, 0.14] : [-0.46, 0.46];
    return xs.map((x) => ({ x, y: centerExit ? 0.34 : 0.28, z: rearZ, r: 0.052 }));
  }

  /** Build contoured volumetric flame plume + crossed internal plasma fins (pointing along -Z from bore origin 0). */
  private buildExhaustPlumeGeo(): THREE.BufferGeometry {
    // Smooth aerodynamic jet envelope (v=0 at pipe mouth -> v=1 at flame tip)
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0.035, 0.00),
      new THREE.Vector2(0.060, 0.08),
      new THREE.Vector2(0.072, 0.20),
      new THREE.Vector2(0.062, 0.38),
      new THREE.Vector2(0.042, 0.58),
      new THREE.Vector2(0.018, 0.78),
      new THREE.Vector2(0.001, 0.94),
    ];
    const geo = new THREE.LatheGeometry(pts, 14);
    // Lathe grows along +Y -> rotate -90 deg around X so it shoots straight backward along -Z out of the tailpipe!
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  /** Photorealistic WebGPU TSL Mach-diamond exhaust afterburner shader (zero hard edges, HDR bloom). */
  private createExhaustFlameMat(): THREE.MeshBasicNodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'exhaust_mach_flame';
    m.transparent = true;
    m.blending = THREE.AdditiveBlending;
    m.depthWrite = false;
    m.side = THREE.DoubleSide;

    const p = uv();
    const v = p.y; // 0 = inside exhaust mouth, 1 = flame tip
    const u = p.x;

    // Fast supersonic turbulent gas flow scrolling backward out of the tailpipe
    const flowA = noise01(vec2(u.mul(3.5), v.mul(3.2).sub(time.mul(22.0))));
    const flowB = noise01(vec2(u.mul(7.0).add(2.3), v.mul(6.5).sub(time.mul(34.0))));
    const turb = flowA.mul(0.62).add(flowB.mul(0.38));

    // Standing Mach shock diamonds near the nozzle exit (signature real GT3 / anti-lag / titanium flame physics!)
    const shockWave = pow(max(float(0), sin(v.mul(27.0).sub(time.mul(16.0)))), float(3.2))
      .mul(smoothstep(float(0.02), float(0.10), v))
      .mul(smoothstep(float(0.68), float(0.14), v));

    // Soft view-angle Fresnel fade removes all hard cone silhouette lines from any viewing angle
    const fresnel = pow(abs(normalView.z), float(0.85));
    const throat = smoothstep(float(0.0), float(0.05), v);
    const tailFade = pow(max(float(0), float(1).sub(v).add(turb.sub(0.5).mul(0.26))), float(1.65));

    // Normal gasoline/anti-lag palette: white-blue throat -> electric cyan Mach diamonds -> molten orange -> deep crimson tip
    const gasOuter = mix(vec3(1.0, 0.42, 0.04), vec3(0.85, 0.08, 0.01), smoothstep(float(0.35), float(0.95), v));
    const gasMid = mix(vec3(1.0, 0.86, 0.48), gasOuter, smoothstep(float(0.10), float(0.45), v));
    const gasCol = mix(gasMid, vec3(0.55, 0.88, 1.0), shockWave.mul(0.82))
      .add(vec3(1.0, 0.98, 0.92).mul(smoothstep(float(0.18), float(0.0), v).mul(1.1)));

    // Nitrous oxide [X] plasma palette: white-hot throat -> cyan-cobalt shock diamonds -> electric violet tip
    const nosOuter = mix(vec3(0.12, 0.56, 1.0), vec3(0.42, 0.14, 1.0), smoothstep(float(0.35), float(0.95), v));
    const nosCol = mix(vec3(0.82, 0.98, 1.0), nosOuter, smoothstep(float(0.10), float(0.50), v))
      .add(vec3(1.0, 1.0, 1.0).mul(shockWave.mul(0.95)));

    const flameRgb = mix(gasCol, nosCol, this.flameNosU);
    const alpha = throat.mul(tailFade).mul(fresnel).mul(turb.mul(0.55).add(0.45)).mul(this.flameIntU).clamp(0, 1);
    // HDR energy > 1.5 triggers rich emitter-biased WebGPU bloom right around the tailpipes
    const hdrBoost = float(3.8).add(shockWave.mul(2.4)).mul(this.flameIntU);
    m.colorNode = vec4(flameRgb.mul(hdrBoost), alpha);
    return m;
  }

  /** Trigger or sustain photorealistic Mach-diamond flames shooting strictly from this car's exhaust pipes. */
  setExhaustFlame(intensity: number, blueNos = false) {
    if (!this.flameGroup) {
      const g = new THREE.Group();
      g.name = 'wheel_exhaust_flames';
      const plumeGeo = this.buildExhaustPlumeGeo();
      const plumeMat = this.createExhaustFlameMat();
      const nozzles = this.detectExhaustNozzles();
      let avgX = 0, avgY = 0, avgZ = 0;
      for (const nz of nozzles) {
        const pair = new THREE.Group();
        pair.position.set(nz.x, nz.y, nz.z);
        const rScale = nz.r / 0.052;
        // Outer turbulent plume + tight inner high-velocity supersonic core
        const outer = new THREE.Mesh(plumeGeo, plumeMat);
        outer.scale.set(rScale * 1.15, rScale * 1.15, 0.92);
        const inner = new THREE.Mesh(plumeGeo, plumeMat);
        inner.scale.set(rScale * 0.56, rScale * 0.56, 0.58);
        inner.rotation.z = Math.PI * 0.5;
        pair.add(outer, inner);
        g.add(pair);
        this.flameNozzles.push(pair);
        avgX += nz.x; avgY += nz.y; avgZ += nz.z;
      }
      // Compact rear diffuser & wet-asphalt reflection flash (0 intensity when off -> skipped by Clustered Forward+)
      const n = Math.max(1, nozzles.length);
      this.flameLight = new THREE.PointLight(0xff7418, 0, 4.2, 2);
      this.flameLight.position.set(avgX / n, avgY / n + 0.08, avgZ / n - 0.35);
      g.add(this.flameLight);
      g.visible = false;
      this.model.add(g);
      this.flameGroup = g;
    }

    this.flameLevel = Math.max(this.flameLevel * 0.72, Math.max(0, Math.min(1.4, intensity)));
    const on = this.flameLevel > 0.06;
    this.flameGroup.visible = on;
    this.flameIntU.value = on ? Math.min(1.25, this.flameLevel) : 0;
    this.flameNosU.value = blueNos ? 1 : 0;
    if (this.flameLight) {
      this.flameLight.color.setHex(blueNos ? 0x38bdf8 : 0xff6b14);
      this.flameLight.intensity = on ? (10 + Math.random() * 6) * this.flameLevel : 0;
    }
    if (on) {
      for (let i = 0; i < this.flameNozzles.length; i++) {
        const flick = 0.72 + Math.random() * 0.56;
        const wFlick = 0.85 + Math.random() * 0.30;
        this.flameNozzles[i].scale.set(
          wFlick * (0.78 + this.flameLevel * 0.32),
          wFlick * (0.78 + this.flameLevel * 0.32),
          (0.32 + this.flameLevel * 0.88) * flick,
        );
      }
    }
  }

  static async load(cfg: CarVisualConfig, sharedHeadlights?: THREE.SpotLight[]): Promise<CarVisual> {
    const gltf = await loadGLTF(assetUrl(cfg.model));
    return new CarVisual(cfg, cloneCarScene(gltf.scene), sharedHeadlights);
  }

  update(pos: THREE.Vector3, quat: THREE.Quaternion, out: Float64Array, physPos = pos, physQuat = quat) {
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    this.root.updateMatrixWorld();
    this.custom.sync(pos, quat);
    const inv = this.physInv.compose(physPos, physQuat, ONE).invert();
    const off = (this.cfg.wheel_visual_offset_m ?? 0) + this.widebodyTrackM;
    const tNow = performance.now(), dtS = Math.min(0.05, Math.max(0.001, (tNow - this.lastUpdate) / 1000));
    const first = this.lastUpdate === 0;
    this.lastUpdate = tNow;
    this.driver.update(out[OUT.steer] || 0, out[OUT.steer + 2] || 0, dtS);   // steering applied; body lateral accel (core y = left)

    // Detect uninitialised `out` (all wheel world centres at origin while car isn't at origin)
    const outValid = (out[OUT.wheel(0)] !== 0 || out[OUT.wheel(0) + 1] !== 0 || out[OUT.wheel(0) + 2] !== 0
      || out[OUT.wheel(1)] !== 0 || out[OUT.wheel(1) + 2] !== 0);

    let spinFrame = 0;
    let wheelMinBottom = Infinity;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], o = OUT.wheel(i);
      const side = w.restPos.x >= 0 ? 1 : -1;
      const trackTargetX = w.restPos.x + side * this.widebodyTrackM;
      let centre: THREE.Vector3;
      if (outValid) {
        centre = this.tmpCentre.set(out[o], out[o + 1], out[o + 2]).applyMatrix4(inv).add(this.cg);
        centre.x += Math.sign(centre.x || side) * off;
        // Enforce physical wheel-arch envelope around widebody-adjusted rest track so crash impulses NEVER pop wheels out
        centre.x = THREE.MathUtils.clamp(centre.x, trackTargetX - 0.06, trackTargetX + 0.06);
        centre.y = THREE.MathUtils.clamp(centre.y, w.restPos.y - 0.075, w.restPos.y + 0.062);
        centre.z = THREE.MathUtils.clamp(centre.z, w.restPos.z - 0.032, w.restPos.z + 0.032);
      } else {
        centre = this.tmpCentre.copy(w.restPos);
        centre.x = trackTargetX;
      }
      w.hub.copy(centre);
      if (w.off) {            // torn off (DamageVisuals owns the wheel now): the caliper stays on the hub
        if (w.caliper) w.caliper.position.copy(centre);
        continue;
      }
      wheelMinBottom = Math.min(wheelMinBottom, centre.y - w.radius);

      const steer = outValid ? THREE.MathUtils.clamp(out[o + 3], -0.62, 0.62) : 0;
      const omega = outValid ? out[o + 10] : 0;   // exact wheel angular velocity (rad/s), immune to 2*pi fmod wraps
      if (first || (Math.abs(omega) < 0.02 && Math.abs(out[o + 4]) < 1e-4)) {
        w.spin = outValid ? out[o + 4] : 0;
      } else {
        w.spin = (w.spin + omega * dtS) % (Math.PI * 2);
      }
      spinFrame = Math.max(spinFrame, Math.abs(omega) * this.renderDt);

      const camb = i < 2 ? this.camberFrontRad : this.camberRearRad;
      this.qa.setFromAxisAngle(Y, steer);
      this.qc.setFromAxisAngle(Z, side * camb);
      this.qb.setFromAxisAngle(X, w.spin);
      w.node.position.copy(centre);
      w.node.quaternion.copy(this.qa).multiply(this.qc).multiply(this.qb).multiply(w.rest);
      if (w.caliper) {
        w.caliper.position.copy(centre);
        w.caliper.quaternion.copy(this.qa);
        if (w.caliperRest) w.caliper.quaternion.multiply(w.caliperRest);
      }
      // Thermal incandescent brake rotor glow driven by C++ brake disc temperature (360 C dull cherry -> 900 C bright HDR orange)
      const bt = outValid ? (out[OUT.brakeTemp(i)] || 150) : 150;
      const targetHeat = THREE.MathUtils.smoothstep(bt, 360, 880);
      w.rotorHeat.value += (targetHeat - w.rotorHeat.value) * Math.min(1, dtS * 8);
    }

    // Active Aero rear wing animation (DRS flat low-drag vs. Airbrake high-downforce braking pitch)
    if (outValid) {
      this.custom.setActiveAero((out[OUT.drsActive] || 0) > 0.5, (out[OUT.airbrakeActive] || 0) > 0.5, dtS);
    }

    // Keep soft contact shadow planted right on the road surface beneath the tyres (fading smoothly if airborne)
    if (Number.isFinite(wheelMinBottom)) {
      this.contactShadow.position.y = wheelMinBottom + 0.014;
      const clearance = Math.max(0, wheelMinBottom);
      this.shadowOp.value = 0.92 * (1 - THREE.MathUtils.smoothstep(clearance, 0.04, 0.35));
    }

    // Dynamic brake light response (running tail glow -> crisp HDR crimson under braking)
    if (this.tailMats.length && !this.lightsBroken) {
      const braking = this.dim > 0.5 && out[OUT.brake] > 0.05 ? THREE.MathUtils.clamp(out[OUT.brake], 0, 1) : 0;
      const baseGlow = this.lightsOn ? (this.dim > 0.5 ? 1.85 : 1.15) : 0.08;
      const targetGlow = baseGlow + braking * 7.5;
      for (const tm of this.tailMats) tm.emissiveIntensity = targetGlow;
    }

    if (this.blurMat) {
      const target = 0.88 * THREE.MathUtils.smoothstep(spinFrame, 0.42, 1.35);
      this.blurOp.value += (target - this.blurOp.value) * 0.25;
    }
  }
}
