// Ground-floor building breaches (docs/nyc_breach.md): driving fast into a wall OR building corner opens a hole
// and reveals a photorealistic WebGPU TSL PBR architectural interior (polished marble/porcelain floors, hardwood
// planks, exposed NYC brick & fractured concrete, brushed steel/brass, glowing HDR LED coves & interior lighting).
// Heavy collapsing concrete/masonry chunks (55–160 kg) drop from the upper lintel onto the car and visibly dent/damage
// the exact hood/roof/fender panel they hit, then bounce cleanly off via our zero-stall kinematic solver (zero FPS drop,
// zero stuck rubble!).
import * as THREE from 'three/webgpu';
import {
  abs, attribute, bumpMap, clamp, floor, float, fract, max, min, mix, normalWorld, positionWorld, sin, smoothstep, step,
  vec2, vec3, vertexColor,
} from 'three/tsl';
import RAPIER from '@dimforge/rapier3d-compat';
import { noise01 } from '../../fx/noiseTex';
import type { BuildingColliderBox } from './props';
import { instanceSlots } from '../instancing';

export interface BreachSpec { cx: number; cy: number; face: number; u: number; seed: number }
export interface WallHit { spec: BreachSpec; point: { x: number; y: number; z: number }; impulse: number; storefront: boolean }
export interface RubbleHit {
  point: THREE.Vector3;
  dir: THREE.Vector3;
  impulse: number;
  energyJ: number;
  massKg: number;
  glass: boolean;
}
export interface CarObb {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  half: [number, number, number];
  centre: [number, number, number];
}
export interface BreachHost {
  building(handle: number): { key: string; box: BuildingColliderBox } | null | undefined;
  find(cx: number, cy: number): { key: string; box: BuildingColliderBox } | null | undefined;
  replace(key: string, box: BuildingColliderBox, next: RAPIER.ColliderDesc[]): void;
  facadeDepth?(origin: THREE.Vector3, dir: THREE.Vector3, max: number): number | null | undefined;
  burst?(x: number, y: number, z: number, nx: number, nz: number, vx: number, vz: number, storefront: boolean): void;
}

const H = 3.85;
const HOLE_H = 3.1;
const MIN_HOLE = 3.2;
const MAX_HOLE = 4.6;
const MAX_DEPTH = 9.5;
const MIN_DEPTH = 3.6;
const PORTAL_IN = 1.6;
const PORTAL_OUT = 0.25;
const MAX_LIVE = 4;
const MAX_LIGHTS = 2;

const GROUP_WALL = (0x0004 << 16) | 0xffff;
const ORDER_EARLY = -10;
const ORDER_PORTAL = -5;
const ORDER_ROOM = -4;

type RGB = [number, number, number];
/** Surface material kinds encoded in vertex attribute `_mat.w` (0..6):
 *  0 = architectural plaster / drywall / painted wall
 *  1 = polished veined marble / large-format porcelain tile
 *  2 = warm grained hardwood planks
 *  3 = NYC exposed brick / fractured concrete masonry
 *  4 = brushed stainless steel / architectural brass / chrome
 *  5 = architectural glass / backlit display / LED / OLED screen
 *  6 = woven rug / upholstered fabric / leather
 */
type MatSpec = [roughness: number, metalness: number, emissive: number, kind: number];
const MAT_PLASTER: MatSpec = [0.76, 0.02, 0, 0];
const MAT_MARBLE: MatSpec = [0.16, 0.06, 0, 1];
const MAT_WOOD: MatSpec = [0.36, 0.04, 0, 2];
const MAT_BRICK: MatSpec = [0.88, 0.02, 0, 3];
const MAT_METAL: MatSpec = [0.22, 0.88, 0, 4];
const MAT_GLASS: MatSpec = [0.09, 0.14, 0.15, 5];
const MAT_GLOW: MatSpec = [0.12, 0.05, 2.8, 5];
const MAT_NEON: MatSpec = [0.14, 0.05, 3.6, 5];
const MAT_FABRIC: MatSpec = [0.93, 0.0, 0, 6];

/** Deterministic PRNG */
function rng(seed: number) {
  let s = (seed | 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Photorealistic WebGPU TSL PBR shader for building interiors (single draw call per room!).
 * Triplanar world-space marble veins + porcelain grout, hardwood plank grain, running-bond NYC brick & concrete,
 * brushed stainless/brass, woven textile, bump-mapped relief, and true HDR emissive bloom for architectural lighting.
 */
function createInteriorMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'breach_interior_pbr';
  m.envMapIntensity = 0.85;

  const vc = vertexColor();
  const matAttr = attribute('_mat', 'vec4'); // x=rough, y=metal, z=emissive, w=kind
  const kind = matAttr.w;

  // World-space triplanar coordinates (metres) so textures align cleanly on every wall, floor & ceiling at any angle
  const P = positionWorld;
  const N = abs(normalWorld);
  const isHoriz = step(float(0.65), N.y);
  const useXY = step(N.x, N.z);
  const wallUV = mix(vec2(P.z, P.y), vec2(P.x, P.y), useXY);
  const uvM = mix(wallUV, vec2(P.x, P.z), isHoriz);

  // One-hot smooth weights for the 7 procedural PBR materials (zero branching!)
  const wPlaster = step(kind, float(0.5));
  const wMarble = step(float(0.5), kind).mul(step(kind, float(1.5)));
  const wWood = step(float(1.5), kind).mul(step(kind, float(2.5)));
  const wBrick = step(float(2.5), kind).mul(step(kind, float(3.5)));
  const wMetal = step(float(3.5), kind).mul(step(kind, float(4.5)));
  const wGlass = step(float(4.5), kind).mul(step(kind, float(5.5)));
  const wFabric = step(float(5.5), kind);

  // 0. Architectural plaster / Venetian drywall
  const plFine = noise01(uvM.mul(14.0));
  const plBroad = noise01(uvM.mul(1.8));
  const plShade = mix(float(0.90), float(1.06), plBroad.mul(0.65).add(plFine.mul(0.35)));
  const plBump = plFine.mul(0.22);

  // 1. Polished veined Carrara marble / large-format 0.85 m porcelain tile
  const tileScale = uvM.div(0.85);
  const tLoc = fract(tileScale);
  const tEdge = min(min(tLoc.x, float(1).sub(tLoc.x)), min(tLoc.y, float(1).sub(tLoc.y)));
  const grout = float(1).sub(smoothstep(float(0.008), float(0.022), tEdge));
  const warp = noise01(uvM.mul(1.35)).mul(2.8).add(noise01(uvM.mul(4.2)).mul(0.75));
  const vein = float(1).sub(smoothstep(float(0.0), float(0.24), abs(sin(uvM.x.mul(3.1).add(uvM.y.mul(1.9)).add(warp)))));
  const marbleShade = mix(float(1.03), float(0.76), vein.mul(0.55)).mul(mix(float(1.0), float(0.45), grout));
  const marbleRough = mix(matAttr.x.add(vein.mul(0.08)), float(0.86), grout);
  const marbleBump = float(0.5).sub(grout.mul(0.55)).sub(vein.mul(0.08));

  // 2. Grained walnut / oak hardwood planks (0.18 m wide x 1.15 m staggered)
  const plankRow = floor(uvM.x.div(0.18));
  const rowStagger = fract(plankRow.mul(0.37)).mul(1.15);
  const pX = fract(uvM.x.div(0.18));
  const pY = fract(uvM.y.add(rowStagger).div(1.15));
  const pSeam = max(
    float(1).sub(smoothstep(float(0.015), float(0.04), min(pX, float(1).sub(pX)))),
    float(1).sub(smoothstep(float(0.006), float(0.018), min(pY, float(1).sub(pY)))),
  );
  const woodGrain = noise01(vec2(uvM.x.mul(22.0).add(plankRow.mul(3.1)), uvM.y.mul(2.4)));
  const plankTone = mix(float(0.84), float(1.14), fract(plankRow.mul(0.618034)));
  const woodShade = plankTone.mul(mix(float(0.82), float(1.12), woodGrain)).mul(mix(float(1.0), float(0.42), pSeam));
  const woodRough = mix(matAttr.x.add(woodGrain.mul(0.14)), float(0.88), pSeam);
  const woodBump = woodGrain.mul(0.25).sub(pSeam.mul(0.5));

  // 3. Exposed NYC running-bond brick & fractured concrete masonry
  const bRow = floor(uvM.y.div(0.078));
  const bShift = fract(bRow.mul(0.5)).mul(0.23);
  const bx = fract(uvM.x.add(bShift).div(0.23));
  const by = fract(uvM.y.div(0.078));
  const mortar = max(
    float(1).sub(smoothstep(float(0.03), float(0.07), min(bx, float(1).sub(bx)))),
    float(1).sub(smoothstep(float(0.06), float(0.13), min(by, float(1).sub(by)))),
  );
  const bGrit = noise01(uvM.mul(18.0));
  const bVar = mix(float(0.80), float(1.15), noise01(vec2(floor(uvM.x.add(bShift).div(0.23)), bRow).mul(1.37)));
  const brickShade = mix(bVar.mul(mix(float(0.84), float(1.08), bGrit)), float(0.62), mortar);
  const brickBump = bGrit.mul(0.38).sub(mortar.mul(0.65));

  // 4. Brushed stainless steel / warm brass
  const brush = noise01(vec2(uvM.x.mul(4.0), uvM.y.mul(56.0)));
  const metalShade = mix(float(0.88), float(1.12), brush);
  const metalRough = clamp(matAttr.x.add(brush.sub(0.5).mul(0.10)), float(0.10), float(0.45));
  const metalBump = brush.mul(0.12);

  // 5. Glass / backlit display / LED
  const glassShade = float(1.0);
  const glassRough = matAttr.x;

  // 6. Woven rug / upholstered fabric
  const weave = sin(uvM.x.mul(110.0)).mul(sin(uvM.y.mul(110.0))).mul(0.5).add(0.5);
  const fabNoise = noise01(uvM.mul(16.0));
  const fabricShade = mix(float(0.84), float(1.08), weave.mul(0.45).add(fabNoise.mul(0.55)));
  const fabricBump = weave.mul(0.28).add(fabNoise.mul(0.18));

  // Combine per-material PBR responses seamlessly
  const shade = plShade.mul(wPlaster)
    .add(marbleShade.mul(wMarble))
    .add(woodShade.mul(wWood))
    .add(brickShade.mul(wBrick))
    .add(metalShade.mul(wMetal))
    .add(glassShade.mul(wGlass))
    .add(fabricShade.mul(wFabric));

  const rough = clamp(
    matAttr.x.mul(wPlaster.add(wBrick).add(wFabric))
      .add(marbleRough.mul(wMarble))
      .add(woodRough.mul(wWood))
      .add(metalRough.mul(wMetal))
      .add(glassRough.mul(wGlass)),
    float(0.06),
    float(0.96),
  );

  const heightH = plBump.mul(wPlaster)
    .add(marbleBump.mul(wMarble))
    .add(woodBump.mul(wWood))
    .add(brickBump.mul(wBrick))
    .add(metalBump.mul(wMetal))
    .add(fabricBump.mul(wFabric));

  // Subtle floor-to-ceiling architectural light gradient so lower corners ground naturally
  const baseCol = vc.rgb.mul(shade);
  m.colorNode = baseCol;
  m.roughnessNode = rough;
  m.metalnessNode = clamp(matAttr.y, float(0.0), float(0.96));
  m.normalNode = bumpMap(heightH, float(0.34));
  // True HDR bloom emissive on LED ceiling coves, hanging globes, neon menu boards, drink cases & OLED TVs
  m.emissiveNode = vc.rgb.mul(matAttr.z);
  return m;
}

/** Photorealistic fractured concrete & NYC brick rubble material (used by the 1-draw-call InstancedMesh pool). */
function createRubbleMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'breach_rubble_pbr';
  const P = positionWorld;
  const grit = noise01(vec2(P.x.mul(16.0).add(P.z.mul(9.0)), P.y.mul(16.0).sub(P.x.mul(7.0))));
  const coarse = noise01(vec2(P.x.mul(4.5), P.z.mul(4.5).add(P.y.mul(3.0))));
  const strata = mix(float(0.76), float(1.14), grit.mul(0.55).add(coarse.mul(0.45)));
  m.colorNode = vec3(strata, strata, strata);
  m.roughnessNode = mix(float(0.80), float(0.95), grit);
  m.metalness = 0.03;
  m.normalNode = bumpMap(grit.mul(0.55).add(coarse.mul(0.35)), float(0.45));
  return m;
}

/** Room geometry builder with per-vertex PBR material channel `_mat` + crease AO. */
class Geo {
  private p: number[] = [];
  private n: number[] = [];
  private c: number[] = [];
  private m: number[] = [];
  private idx: number[] = [];

  constructor(private map: (u: number, w: number, y: number) => THREE.Vector3, private ao: (u: number, w: number, y: number) => number) {}

  quad(pts: [number, number, number][], nrm: [number, number, number], col: RGB, mat: MatSpec = MAT_PLASTER, glow = 0) {
    const base = this.p.length / 3;
    const nw = this.map(nrm[0], nrm[1], nrm[2]).sub(this.map(0, 0, 0)).normalize();
    const em = glow > 0 ? glow : mat[2];
    for (const [u, w, y] of pts) {
      const v = this.map(u, w, y);
      const a = em > 0.2 ? 1.0 : this.ao(u, w, y);
      this.p.push(v.x, v.y, v.z);
      this.n.push(nw.x, nw.y, nw.z);
      this.c.push(col[0] * a, col[1] * a, col[2] * a);
      this.m.push(mat[0], mat[1], em, mat[3]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  box(u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, col: RGB, mat: MatSpec = MAT_PLASTER, glow = 0) {
    const dark = (f: number): RGB => [col[0] * f, col[1] * f, col[2] * f];
    this.quad([[u0, w0, y1], [u1, w0, y1], [u1, w1, y1], [u0, w1, y1]], [0, 0, 1], col, mat, glow);
    this.quad([[u0, w1, y0], [u1, w1, y0], [u1, w0, y0], [u0, w0, y0]], [0, 0, -1], dark(0.65), mat, glow);
    this.quad([[u0, w0, y0], [u1, w0, y0], [u1, w0, y1], [u0, w0, y1]], [0, -1, 0], dark(0.92), mat, glow);
    this.quad([[u1, w1, y0], [u0, w1, y0], [u0, w1, y1], [u1, w1, y1]], [0, 1, 0], dark(0.86), mat, glow);
    this.quad([[u0, w1, y0], [u0, w0, y0], [u0, w0, y1], [u0, w1, y1]], [-1, 0, 0], dark(0.82), mat, glow);
    this.quad([[u1, w0, y0], [u1, w1, y0], [u1, w1, y1], [u1, w0, y1]], [1, 0, 0], dark(0.82), mat, glow);
  }

  /** Architectural cylinder (fluted column, brass pendant globe, chrome barstool pedestal, planter). */
  cylinder(cu: number, cw: number, r: number, y0: number, y1: number, segs: number, col: RGB, mat: MatSpec = MAT_METAL, glow = 0) {
    const stepA = (Math.PI * 2) / segs;
    for (let i = 0; i < segs; i++) {
      const a0 = i * stepA, a1 = (i + 1) * stepA;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const cm = Math.cos((a0 + a1) * 0.5), sm = Math.sin((a0 + a1) * 0.5);
      const shade = 0.85 + 0.15 * cm;
      const sc: RGB = [col[0] * shade, col[1] * shade, col[2] * shade];
      this.quad(
        [[cu + c0 * r, cw + s0 * r, y0], [cu + c1 * r, cw + s1 * r, y0], [cu + c1 * r, cw + s1 * r, y1], [cu + c0 * r, cw + s0 * r, y1]],
        [cm, sm, 0], sc, mat, glow,
      );
      // Top cap
      this.quad(
        [[cu, cw, y1], [cu + c0 * r, cw + s0 * r, y1], [cu + c1 * r, cw + s1 * r, y1], [cu, cw, y1]],
        [0, 0, 1], col, mat, glow,
      );
    }
  }

  /** Subtle checkerboard / planked floor with per-tile tonal variation (real PBR shader adds grout/veins/grain!). */
  tiledFloor(u0: number, u1: number, w0: number, w1: number, y: number, tileU: number, tileW: number, colA: RGB, colB: RGB, mat: MatSpec) {
    const nu = Math.max(1, Math.min(8, Math.round((u1 - u0) / tileU)));
    const nw = Math.max(1, Math.min(8, Math.round((w1 - w0) / tileW)));
    const du = (u1 - u0) / nu, dw = (w1 - w0) / nw;
    for (let iu = 0; iu < nu; iu++) {
      for (let iw = 0; iw < nw; iw++) {
        const a0 = u0 + iu * du, a1 = a0 + du, b0 = w0 + iw * dw, b1 = b0 + dw;
        const c = (iu + iw) % 2 === 0 ? colA : colB;
        this.quad([[a0, b0, y], [a1, b0, y], [a1, b1, y], [a0, b1, y]], [0, 0, 1], c, mat);
      }
    }
  }

  /** Framed recessed wall display (backlit menu board, 4K OLED TV, refrigerated cooler, framed artwork). */
  framedBackWall(u0: number, u1: number, back: number, y0: number, y1: number, frameC: RGB, innerC: RGB, frameMat: MatSpec = MAT_METAL, glow = 1.6) {
    this.box(u0, u1, back - 0.10, back - 0.01, y0, y1, frameC, frameMat);
    this.quad(
      [[u0 + 0.06, back - 0.11, y0 + 0.06], [u1 - 0.06, back - 0.11, y0 + 0.06],
       [u1 - 0.06, back - 0.11, y1 - 0.06], [u0 + 0.06, back - 0.11, y1 - 0.06]],
      [0, -1, 0], innerC, MAT_GLASS, glow,
    );
  }

  /** Architectural potted indoor plant (ceramic/stone planter + soil + layered foliage fronds). */
  planter(u: number, w: number, potCol: RGB) {
    this.cylinder(u, w, 0.28, 0, 0.52, 8, potCol, MAT_MARBLE);
    this.cylinder(u, w, 0.24, 0.50, 0.55, 8, [0.16, 0.12, 0.08], MAT_BRICK);
    this.cylinder(u, w, 0.04, 0.52, 1.35, 6, [0.24, 0.16, 0.10], MAT_WOOD);
    // Layered foliage canopy blades
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const du = Math.cos(a) * 0.26, dw = Math.sin(a) * 0.26;
      const yBase = 1.05 + (i % 2) * 0.22;
      this.box(u + du - 0.16, u + du + 0.16, w + dw - 0.16, w + dw + 0.16, yBase, yBase + 0.14, i % 2 === 0 ? [0.14, 0.34, 0.15] : [0.18, 0.42, 0.17], MAT_FABRIC);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('_mat', new THREE.Float32BufferAttribute(this.m, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function unitBox() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.deleteAttribute('uv');
  return g;
}

/** Kinematic ballistic debris piece with real mass (kg) & car-denting collision cooldown (0 Rapier bodies -> 0 FPS drop!). */
interface KinPiece {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  angVel: THREE.Vector3;
  size: THREE.Vector3;
  groundY: number;
  slot: number;
  massKg: number;
  heavy: boolean;
  hitCarCd: number;
  delay: number;
  sleeping: boolean;
}

interface Live {
  spec: BreachSpec;
  key: string;
  group: THREE.Group;
  portal: THREE.Mesh;
  light: THREE.PointLight | null;
  face: { ax: 'x' | 'z'; s: 1 | -1; plane: number };
  center: THREE.Vector3;
  quat: THREE.Quaternion;
  pieces: KinPiece[];
  pending: { at: number; make: () => void }[];
  age: number;
}

export class Breaches {
  private specs: BreachSpec[] = [];
  private live: Live[] = [];
  private roomMat: THREE.MeshStandardNodeMaterial;
  private looseMat: THREE.MeshStandardNodeMaterial;
  private pool: THREE.InstancedMesh;
  private free: number[] = [];
  private used = 0;
  private static readonly POOL = 180;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private portalMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  private box = unitBox();
  private warm: THREE.Object3D[] = [];
  private activeLights: THREE.PointLight[] = [];
  private m4 = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private invQ = new THREE.Quaternion();
  private dq = new THREE.Quaternion();
  private axis = new THREE.Vector3();

  /** Callback invoked whenever a heavy falling concrete/masonry block strikes the player's car. */
  onRubbleHit: ((hit: RubbleHit) => void) | null = null;

  constructor(private scene: THREE.Scene, private pw: { world: RAPIER.World }, private host: BreachHost) {
    this.roomMat = createInteriorMaterial();
    this.looseMat = createRubbleMaterial();
    this.portalMat.name = 'breach_portal';
    this.pool = new THREE.InstancedMesh(this.box, this.looseMat, instanceSlots(Breaches.POOL));
    this.pool.name = 'breach_pieces';
    for (let i = 0; i < Breaches.POOL; i++) {
      this.pool.setMatrixAt(i, this.zero);
      this.pool.setColorAt(i, new THREE.Color(1, 1, 1));
      this.free.push(Breaches.POOL - 1 - i);
    }
    this.pool.count = 1;
    this.pool.frustumCulled = false;
    this.pool.renderOrder = ORDER_EARLY;
    scene.add(this.pool);
  }

  private take(color: THREE.Color) {
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    this.pool.setColorAt(slot, color);
    this.pool.instanceColor!.needsUpdate = true;
    this.used = Math.max(this.used, slot + 1);
    this.pool.count = Math.max(1, this.used);
    return slot;
  }

  private release(slot: number) {
    if (slot < 0) return;
    this.pool.setMatrixAt(slot, this.zero);
    this.pool.instanceMatrix.needsUpdate = true;
    this.free.push(slot);
  }

  get count() { return this.live.length; }

  warmup(on: boolean, p?: THREE.Vector3) {
    if (!on) { for (const o of this.warm) o.removeFromParent(); this.warm.length = 0; return; }
    const g = new Geo((u, w, y) => new THREE.Vector3(u, y, w), () => 1);
    g.box(0, 0.01, 0, 0.01, 0, 0.01, [0.5, 0.5, 0.5], MAT_MARBLE);
    const room = new THREE.Mesh(g.build(), this.roomMat);
    const portal = new THREE.Mesh(this.box, this.portalMat);
    for (const o of [room, portal]) {
      o.position.copy(p ?? new THREE.Vector3()).y -= 3;
      o.scale.setScalar(0.01);
      o.frustumCulled = false;
      (o as THREE.Mesh).renderOrder = ORDER_ROOM;
      this.scene.add(o);
      this.warm.push(o);
    }
  }

  /** Check whether the car hit a building wall OR corner hard enough to breach it cleanly. */
  check(carCol: RAPIER.Collider, body: RAPIER.RigidBody, mass: number, preV: { x: number; y: number; z: number }, preW: { x: number; y: number; z: number }): WallHit | null {
    const w = this.pw.world;
    let found: { key: string; box: BuildingColliderBox } | null = null;
    w.contactPairsWith(carCol, (o) => {
      if (found) return;
      const b = this.host.building(o.handle);
      if (!b) return;
      let touching = false;
      w.contactPair(carCol, o, (m) => {
        for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < 0.06) touching = true;
      });
      if (touching) found = b;
    });
    if (!found) return null;

    const box = (found as { box: BuildingColliderBox }).box;
    const t = body.translation();
    const { center, quat } = this.frame(box);
    const lp = this.v.set(t.x, t.y, t.z).sub(center).applyQuaternion(this.q.copy(quat).invert());
    const dx = Math.abs(lp.x) - box.hx, dz = Math.abs(lp.z) - box.hy;

    let face = dx > dz ? (lp.x > 0 ? 0 : 1) : (lp.z > 0 ? 2 : 3);
    const nearCorner = Math.abs(dx - dz) < 1.8;
    if (nearCorner) {
      const fX = lp.x > 0 ? 0 : 1, fZ = lp.z > 0 ? 2 : 3;
      const nX = new THREE.Vector3(fX === 0 ? 1 : -1, 0, 0).applyQuaternion(quat);
      const nZ = new THREE.Vector3(0, 0, fZ === 2 ? 1 : -1).applyQuaternion(quat);
      const vnX = -(preV.x * nX.x + preV.z * nX.z);
      const vnZ = -(preV.x * nZ.x + preV.z * nZ.z);
      face = vnX >= vnZ ? fX : fZ;
    }

    const f = this.faceOf(box, face);
    const nW = new THREE.Vector3(f.ax === 'x' ? f.s : 0, 0, f.ax === 'z' ? f.s : 0).applyQuaternion(quat);
    const vnRaw = -(preV.x * nW.x + preV.z * nW.z);
    const horizSpeed = Math.hypot(preV.x, preV.z);
    const vn = nearCorner ? Math.max(vnRaw, horizSpeed * 0.86) : vnRaw;
    if (vn <= 1.0) return null;

    const height = box.z1 - box.z0;
    const seed = Math.floor(Math.abs(box.cx * 7.31 + box.cy * 3.17) * 100) % 100000;
    const masonry = height < 22 ? true : height > 60 ? false : seed % 3 === 0;
    const E = masonry ? 320e3 : 100e3;
    if (0.5 * mass * vn * vn < E) return null;

    const uLocal = f.ax === 'x' ? lp.z : lp.x;
    if (2 * f.half < 3.6 || 2 * f.uHalf < 3.2 || height < H + 0.1) return null;

    const spec: BreachSpec = { cx: box.cx, cy: box.cy, face, u: uLocal, seed };
    const vn2 = Math.sqrt(Math.max(0, vn * vn - (2 * E) / mass)) * 0.65;
    const vtx = preV.x + nW.x * Math.max(0, vnRaw);
    const vtz = preV.z + nW.z * Math.max(0, vnRaw);
    const nv = { x: vtx * 0.72 - nW.x * vn2, y: preV.y, z: vtz * 0.72 - nW.z * vn2 };
    if (!this.open(spec, { carPos: { x: t.x, y: t.y, z: t.z }, carVel: nv, preV })) return null;

    body.setLinvel(nv, true);
    body.setAngvel({ x: preW.x * 0.45, y: preW.y * 0.45, z: preW.z * 0.45 }, true);
    const lost = 0.5 * mass * ((preV.x ** 2 + preV.z ** 2) - (nv.x ** 2 + nv.z ** 2));
    const wallPt = this.map(box, face, uLocal, 0, 0.8);
    return { spec, point: { x: wallPt.x, y: wallPt.y, z: wallPt.z }, impulse: Math.sqrt(2 * mass * Math.max(0, lost)), storefront: !masonry };
  }

  private frame(box: BuildingColliderBox) {
    return {
      center: new THREE.Vector3(box.cx, box.z0, -box.cy),
      quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), box.yaw),
    };
  }

  private faceOf(box: BuildingColliderBox, face: number) {
    const ax: 'x' | 'z' = face < 2 ? 'x' : 'z';
    const s: 1 | -1 = face % 2 === 0 ? 1 : -1;
    return { ax, s, half: ax === 'x' ? box.hx : box.hy, uHalf: ax === 'x' ? box.hy : box.hx };
  }

  private map(box: BuildingColliderBox, face: number, u: number, w: number, y: number) {
    const { center, quat } = this.frame(box);
    const f = this.faceOf(box, face);
    const p = f.ax === 'x' ? new THREE.Vector3(f.s * (f.half - w), y, u) : new THREE.Vector3(u, y, f.s * (f.half - w));
    return p.applyQuaternion(quat).add(center);
  }

  open(
    spec: BreachSpec,
    crash?: { carPos: { x: number; y: number; z: number }; carVel: { x: number; y: number; z: number }; preV: { x: number; y: number; z: number } },
  ): boolean {
    const b = this.host.find(spec.cx, spec.cy);
    if (!b) return false;
    const box = b.box;
    if (this.live.some((l) => Math.hypot(l.spec.cx - spec.cx, l.spec.cy - spec.cy) < 1)) return false;
    if (!this.specs.some((s) => Math.hypot(s.cx - spec.cx, s.cy - spec.cy) < 1)) this.specs.push(spec);

    const f = this.faceOf(box, spec.face);
    const height = box.z1 - box.z0;
    const D = Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, 2 * f.half - 1.2));
    const holeW = Math.min(MAX_HOLE, Math.max(MIN_HOLE, 2 * f.uHalf - 0.4));
    const h0 = THREE.MathUtils.clamp(spec.u - holeW / 2, -f.uHalf + 0.08, f.uHalf - 0.08 - holeW);
    const h1 = h0 + holeW;
    const W = Math.min(2 * f.uHalf - 0.16, Math.max(holeW + 1.8, 7.6));
    const L = THREE.MathUtils.clamp((h0 + h1) / 2 - W / 2, -f.uHalf + 0.08, f.uHalf - 0.08 - W);
    const Rr = L + W;
    const { center, quat } = this.frame(box);

    let wo = 0;
    if (this.host.facadeDepth) {
      const nW = new THREE.Vector3(f.ax === 'x' ? f.s : 0, 0, f.ax === 'z' ? f.s : 0).applyQuaternion(quat);
      const orig = this.map(box, spec.face, (h0 + h1) / 2, -3, 1.5);
      const d = this.host.facadeDepth(orig, nW.clone().negate(), 6);
      if (d != null && d > 0.2 && d < 5.5) wo = THREE.MathUtils.clamp(d - 3, -0.3, 2.2);
    }

    const local = (u: number, w: number, y: number) =>
      f.ax === 'x' ? new THREE.Vector3(f.s * (f.half - wo - w), y, u) : new THREE.Vector3(u, y, f.s * (f.half - wo - w));
    const mapW = (u: number, w: number, y: number) => local(u, w, y).applyQuaternion(quat).add(center);

    const cols: RAPIER.ColliderDesc[] = [];
    const wallCol = (u0: number, u1: number, w0: number, w1: number, y0: number, y1: number) => {
      if (u1 - u0 < 0.06 || w1 - w0 < 0.06 || y1 - y0 < 0.06) return;
      const c = mapW((u0 + u1) / 2, (w0 + w1) / 2, (y0 + y1) / 2);
      const hx = (f.ax === 'x' ? w1 - w0 : u1 - u0) / 2;
      const hz = (f.ax === 'x' ? u1 - u0 : w1 - w0) / 2;
      cols.push(
        RAPIER.ColliderDesc.cuboid(hx, (y1 - y0) / 2, hz)
          .setTranslation(c.x, c.y, c.z)
          .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
          .setFriction(0.5)
          .setCollisionGroups(GROUP_WALL),
      );
    };

    const wallT = 0.45;
    wallCol(-f.uHalf, f.uHalf, 0, 2 * f.half, H, height);
    wallCol(h0, h1, 0, wallT, HOLE_H, H);
    wallCol(-f.uHalf, h0, 0, wallT, 0, H);
    wallCol(h1, f.uHalf, 0, wallT, 0, H);
    wallCol(-f.uHalf, L, wallT, D, 0, H);
    wallCol(Rr, f.uHalf, wallT, D, 0, H);
    wallCol(-f.uHalf, f.uHalf, D, 2 * f.half, 0, H);
    const fc = mapW((L + Rr) / 2, D / 2, -0.2);
    cols.push(
      RAPIER.ColliderDesc.cuboid((f.ax === 'x' ? D : W) / 2, 0.2, (f.ax === 'x' ? W : D) / 2)
        .setTranslation(fc.x, fc.y, fc.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setFriction(0.95),
    );

    const R = rng(spec.seed);
    const kind = height > 60 ? 'lobby' : (['shop', 'deli', 'apartment', 'lobby'] as const)[Math.floor(R() * 4)];
    const ao = (u: number, w: number, y: number) => {
      const edge = Math.min(u - L, Rr - u, D - w, y, H - y);
      const d = Math.min(1, Math.max(0, edge) / 1.15);
      const depthFade = 0.80 + 0.20 * (1 - w / Math.max(1, D));
      return (0.48 + 0.52 * d) * depthFade;
    };
    const geo = new Geo(local, ao);
    const flip = (pts: [number, number, number][]) => (f.s === 1 && f.ax === 'x') || (f.s === -1 && f.ax === 'z') ? pts.slice().reverse() : pts;
    const back = D - 0.12;
    const mid = (L + Rr) / 2;

    // ---- Architectural palette & floor/wall materials per archetype
    const floorMat = kind === 'apartment' ? MAT_WOOD : MAT_MARBLE;
    const floorA: RGB = kind === 'lobby' ? [0.76, 0.74, 0.70] : kind === 'deli' ? [0.68, 0.64, 0.58] : kind === 'apartment' ? [0.42, 0.27, 0.16] : [0.70, 0.72, 0.74];
    const floorB: RGB = kind === 'lobby' ? [0.64, 0.62, 0.58] : kind === 'deli' ? [0.22, 0.23, 0.25] : kind === 'apartment' ? [0.36, 0.23, 0.13] : [0.58, 0.60, 0.63];
    const wallColC: RGB = kind === 'lobby' ? [0.72, 0.70, 0.66] : kind === 'apartment' ? [0.66, 0.62, 0.56] : kind === 'deli' ? [0.64, 0.56, 0.44] : [0.64, 0.66, 0.68];
    const wallMat = kind === 'lobby' ? MAT_MARBLE : MAT_PLASTER;
    const ceilC: RGB = [0.74, 0.73, 0.71];
    const trimC: RGB = kind === 'lobby' ? [0.74, 0.58, 0.30] : [0.22, 0.20, 0.19];
    const trimMat = kind === 'lobby' ? MAT_METAL : MAT_WOOD;

    // Photorealistic floor & architectural ceiling
    geo.tiledFloor(L, Rr, 0, D, 0.015, kind === 'apartment' ? 0.9 : 1.0, kind === 'apartment' ? 1.1 : 1.0, floorA, floorB, floorMat);
    geo.quad(flip([[L, 0, H], [L, D, H], [Rr, D, H], [Rr, 0, H]]), [0, 0, -1], ceilC, MAT_PLASTER);

    // Back wall + left/right side walls (apartments & delis feature exposed NYC red-brick accent walls!)
    geo.quad(flip([[L, D, 0], [L, D, H], [Rr, D, H], [Rr, D, 0]]), [0, -1, 0], wallColC, wallMat);
    const leftBrick = kind === 'apartment' || kind === 'deli';
    geo.quad(flip([[L, 0, 0], [L, 0, H], [L, D, H], [L, D, 0]]), [1, 0, 0], leftBrick ? [0.54, 0.24, 0.16] : wallColC, leftBrick ? MAT_BRICK : wallMat);
    geo.quad(flip([[Rr, D, 0], [Rr, D, H], [Rr, 0, H], [Rr, 0, 0]]), [-1, 0, 0], wallColC, wallMat);

    // Architectural wainscoting panels + baseboards + crown molding + recessed LED coves
    geo.box(L, Rr, D - 0.07, D, 0.01, 0.18, trimC, trimMat);
    geo.box(L, L + 0.07, 0.2, D, 0.01, 0.18, trimC, trimMat);
    geo.box(Rr - 0.07, Rr, 0.2, D, 0.01, 0.18, trimC, trimMat);
    geo.box(L, Rr, D - 0.11, D, H - 0.20, H, trimC, trimMat);
    geo.box(L, L + 0.11, 0.2, D, H - 0.20, H, trimC, trimMat);
    geo.box(Rr - 0.11, Rr, 0.2, D, H - 0.20, H, trimC, trimMat);
    // Warm architectural indirect cove LED strips tucked along crown moldings!
    geo.box(L + 0.15, Rr - 0.15, D - 0.14, D - 0.09, H - 0.24, H - 0.20, [1.0, 0.88, 0.68], MAT_GLOW, 2.2);
    // Wainscoting chair rail on right & back walls
    geo.box(Rr - 0.05, Rr, 0.3, D - 0.1, 1.05, 1.12, trimC, trimMat);
    geo.box(L + 0.06, Rr - 0.06, D - 0.05, D, 1.05, 1.12, trimC, trimMat);

    // Inner front wall surround framing the hole
    if (h0 > L + 0.05) geo.quad(flip([[L, 0.06, 0], [h0, 0.06, 0], [h0, 0.06, H], [L, 0.06, H]]), [0, 1, 0], wallColC, wallMat);
    if (Rr > h1 + 0.05) geo.quad(flip([[h1, 0.06, 0], [Rr, 0.06, 0], [Rr, 0.06, H], [h1, 0.06, H]]), [0, 1, 0], wallColC, wallMat);
    geo.quad(flip([[h0, 0.06, HOLE_H], [h1, 0.06, HOLE_H], [h1, 0.06, H], [h0, 0.06, H]]), [0, 1, 0], wallColC, wallMat);

    // ---- Shattered masonry / drywall studs + bent steel rebar around the breach opening
    const masonryCol: RGB = [0.44, 0.24, 0.18];
    const concreteCol: RGB = [0.46, 0.45, 0.43];
    const rebarCol: RGB = [0.38, 0.34, 0.32];
    for (let k = 0; k < 6; k++) {
      const y0 = (k / 6) * HOLE_H, y1 = ((k + 1) / 6) * HOLE_H;
      const jL = 0.06 + R() * 0.20, jR = 0.06 + R() * 0.20;
      geo.box(h0 - 0.08, h0 + jL, -0.04, 0.44, y0, y1, k % 2 === 0 ? masonryCol : concreteCol, MAT_BRICK);
      geo.box(h1 - jR, h1 + 0.08, -0.04, 0.44, y0, y1, k % 2 === 0 ? concreteCol : masonryCol, MAT_BRICK);
      if (k % 2 === 1) {
        geo.box(h0 + jL - 0.02, h0 + jL + 0.24, 0.16, 0.22, y0 + 0.14, y0 + 0.175, rebarCol, MAT_METAL);
        geo.box(h1 - jR - 0.24, h1 - jR + 0.02, 0.16, 0.22, y0 + 0.24, y0 + 0.275, rebarCol, MAT_METAL);
      }
    }
    for (let k = 0; k < 7; k++) {
      const u0 = h0 + (k / 7) * holeW, u1 = h0 + ((k + 1) / 7) * holeW;
      const drop = 0.06 + R() * 0.24;
      geo.box(u0, u1, -0.04, 0.44, HOLE_H - drop, HOLE_H + 0.16, k % 2 === 0 ? concreteCol : masonryCol, MAT_BRICK);
      if (k % 2 === 0) geo.box(u0 + 0.14, u0 + 0.175, 0.14, 0.20, HOLE_H - drop - 0.24, HOLE_H - drop, rebarCol, MAT_METAL);
    }

    // ---- Architectural ceiling beams + recessed HDR LED linear light panels + brass/chrome pendant globes
    const nBeams = Math.max(2, Math.floor(D / 2.2));
    const ledTint: RGB = kind === 'shop' ? [0.92, 0.96, 1.0] : [1.0, 0.90, 0.72];
    for (let i = 1; i <= nBeams; i++) {
      const w = (i / (nBeams + 1)) * D;
      geo.box(L + 0.1, Rr - 0.1, w - 0.14, w + 0.14, H - 0.24, H, kind === 'apartment' ? [0.34, 0.22, 0.13] : [0.22, 0.23, 0.26], kind === 'apartment' ? MAT_WOOD : MAT_PLASTER);
      // Recessed glowing LED panel
      geo.box(mid - Math.min(2.0, W * 0.32), mid + Math.min(2.0, W * 0.32), w - 0.07, w + 0.07, H - 0.265, H - 0.23, ledTint, MAT_GLOW, 3.0);
      if (i % 2 === 1 && D > 4.2) {
        for (const pu of [mid - W * 0.24, mid + W * 0.24]) {
          geo.cylinder(pu, w, 0.015, H - 0.88, H - 0.22, 6, [0.76, 0.62, 0.34], MAT_METAL);
          geo.cylinder(pu, w, 0.14, H - 1.04, H - 0.86, 10, [1.0, 0.92, 0.74], MAT_GLOW, 3.2);
          geo.cylinder(pu, w, 0.18, H - 0.88, H - 0.82, 10, [0.72, 0.56, 0.28], MAT_METAL);
        }
      }
    }

    // Fluted marble/stone columns near back corners
    for (const cu of [L + 0.42, Rr - 0.42]) {
      geo.cylinder(cu, back - 0.42, 0.22, 0.02, H - 0.02, 12, kind === 'lobby' ? [0.76, 0.73, 0.68] : [0.58, 0.57, 0.55], MAT_MARBLE);
      geo.box(cu - 0.28, cu + 0.28, back - 0.70, back - 0.14, 0.01, 0.24, trimC, trimMat);
      geo.box(cu - 0.28, cu + 0.28, back - 0.70, back - 0.14, H - 0.26, H - 0.02, trimC, trimMat);
    }

    const stat = (u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, c: RGB, mat: MatSpec = MAT_WOOD) => {
      geo.box(u0, u1, w0, w1, y0, y1, c, mat);
      wallCol(u0, u1, w0, w1, y0, y1);
    };
    const debrisSpec: { u: number; w: number; y: number; su: number; sw: number; sy: number; c: RGB; mass: number }[] = [];
    const addDebris = (u: number, w: number, su: number, sw: number, sy: number, c: RGB, mass = 16) => {
      debrisSpec.push({ u, w, y: sy / 2 + 0.03, su, sw, sy, c, mass });
    };
    const bright = (): RGB => ([[0.88, 0.22, 0.18], [0.16, 0.52, 0.86], [0.92, 0.72, 0.16], [0.18, 0.70, 0.36], [0.92, 0.90, 0.86], [0.85, 0.34, 0.62]] as RGB[])[Math.floor(R() * 6)];

    // ---- High-detail photorealistic furnishings per room archetype
    if (kind === 'shop') {
      // Modern NYC boutique / sneaker & electronics store: walnut shelving with steel brackets, backlit glass showcase,
      // quartz checkout island with chrome espresso/POS, neon signage, glass refrigerator wall & indoor planters
      for (const [a, bb] of [[L + 0.05, L + 0.58], [Rr - 0.58, Rr - 0.05]] as [number, number][]) {
        stat(a, bb, 1.4, Math.max(2.2, back - 1.5), 0, 0.36, [0.24, 0.16, 0.11], MAT_WOOD);
        // Vertical brushed-steel rack uprights
        for (let w = 1.5; w <= back - 1.6; w += 1.2) {
          geo.box(a + 0.04, a + 0.09, w - 0.02, w + 0.02, 0.36, 2.35, [0.68, 0.70, 0.74], MAT_METAL);
        }
        for (let y = 0.36; y <= 2.20; y += 0.46) {
          geo.box(a, bb, 1.4, Math.max(2.2, back - 1.5), y, y + 0.045, [0.38, 0.25, 0.15], MAT_WOOD);
          // Under-shelf warm LED display strip
          geo.box(a + 0.08, bb - 0.08, 1.45, Math.max(2.15, back - 1.55), y - 0.015, y, [1.0, 0.92, 0.76], MAT_GLOW, 1.8);
          if (y < 2.0) {
            for (let w = 1.56; w < back - 1.75; w += 0.38) {
              const hItem = 0.18 + R() * 0.17;
              geo.box(a + 0.10, bb - 0.10, w, w + 0.25, y + 0.045, y + 0.045 + hItem, bright(), MAT_GLASS);
            }
          }
        }
      }
      // Quartz & brushed-brass checkout counter + dual POS displays
      stat(mid - 1.55, mid + 0.95, back - 1.75, back - 1.02, 0, 0.98, [0.18, 0.19, 0.22], MAT_MARBLE);
      geo.box(mid - 1.60, mid + 1.00, back - 1.80, back - 0.98, 0.98, 1.06, [0.84, 0.83, 0.80], MAT_MARBLE);
      geo.box(mid - 1.56, mid + 0.96, back - 1.78, back - 1.73, 0.04, 0.08, [0.80, 0.66, 0.32], MAT_METAL);
      geo.box(mid - 0.65, mid - 0.22, back - 1.44, back - 1.38, 1.06, 1.40, [0.12, 0.13, 0.15], MAT_METAL);
      geo.quad([[mid - 0.62, back - 1.45, 1.11], [mid - 0.25, back - 1.45, 1.11], [mid - 0.25, back - 1.45, 1.37], [mid - 0.62, back - 1.45, 1.37]], [0, -1, 0], [0.40, 0.84, 1.0], MAT_GLASS, 2.4);
      // Backlit frosted glass showcase wall + glowing neon logo bar
      geo.framedBackWall(L + 0.78, Rr - 0.78, back, 0.30, 2.35, [0.22, 0.23, 0.26], [0.74, 0.90, 1.0], MAT_METAL, 1.9);
      geo.framedBackWall(mid - 1.3, mid + 1.3, back, 2.55, 3.15, [0.14, 0.14, 0.16], [1.0, 0.22, 0.50], MAT_METAL, 3.2);
      geo.planter(L + 0.92, back - 0.52, [0.76, 0.75, 0.72]);
      geo.planter(Rr - 0.92, back - 0.52, [0.76, 0.75, 0.72]);
      addDebris(mid - 0.95, D * 0.42, 0.95, 0.62, 0.88, [0.42, 0.28, 0.18], 24);
      addDebris(mid + 0.95, D * 0.54, 0.95, 0.62, 0.88, [0.42, 0.28, 0.18], 24);
    } else if (kind === 'deli') {
      // NYC Bistro / Corner Café: checkerboard marble floor, exposed brick left wall, brushed-stainless counter,
      // illuminated pastry/deli glass vitrine, chrome espresso machine, warm glowing menu boards & marble bistro tables
      stat(L + 0.42, Rr - 0.42, back - 1.42, back - 0.65, 0, 1.02, [0.64, 0.66, 0.70], MAT_METAL);
      geo.box(L + 0.46, Rr - 0.46, back - 1.38, back - 0.70, 1.02, 1.48, [0.80, 0.92, 0.96], MAT_GLASS, 1.35);
      // Chrome espresso machine on the right end of counter
      geo.box(Rr - 1.15, Rr - 0.58, back - 1.25, back - 0.78, 1.04, 1.56, [0.78, 0.80, 0.84], MAT_METAL);
      for (let u = L + 0.62; u < Rr - 1.30; u += 0.52) {
        geo.box(u, u + 0.40, back - 1.26, back - 0.82, 1.04, 1.16, bright(), MAT_PLASTER);
      }
      // Twin illuminated warm menu boards + neon espresso sign
      geo.framedBackWall(mid - 2.0, mid - 0.15, back, 2.05, 3.05, [0.16, 0.15, 0.14], [1.0, 0.70, 0.28], MAT_METAL, 2.4);
      geo.framedBackWall(mid + 0.15, mid + 2.0, back, 2.05, 3.05, [0.16, 0.15, 0.14], [0.98, 0.84, 0.42], MAT_METAL, 2.2);
      // Marble-top round bistro tables + chrome pedestals + upholstered leather chairs
      for (const [du, w] of [[-1.42, 2.4], [1.42, 2.4], [-1.42, 4.9], [1.42, 4.9]]) {
        if (w > back - 2.0 || Math.abs(du) > W * 0.38) continue;
        geo.cylinder(mid + du, w, 0.22, 0.015, 0.05, 10, [0.72, 0.74, 0.78], MAT_METAL);
        geo.cylinder(mid + du, w, 0.045, 0.05, 0.74, 8, [0.72, 0.74, 0.78], MAT_METAL);
        geo.cylinder(mid + du, w, 0.46, 0.74, 0.79, 14, [0.84, 0.82, 0.78], MAT_MARBLE);
        for (const cx of [-0.64, 0.64]) {
          geo.box(mid + du + cx - 0.20, mid + du + cx + 0.20, w - 0.20, w + 0.20, 0.44, 0.50, [0.36, 0.18, 0.12], MAT_FABRIC);
          geo.box(mid + du + cx + (cx > 0 ? 0.16 : -0.20), mid + du + cx + (cx > 0 ? 0.20 : -0.16), w - 0.19, w + 0.19, 0.50, 0.90, [0.36, 0.18, 0.12], MAT_FABRIC);
        }
        addDebris(mid + du, w, 0.44, 0.44, 0.48, [0.46, 0.30, 0.20], 18);
      }
      geo.planter(L + 0.85, back - 1.95, [0.38, 0.24, 0.16]);
    } else if (kind === 'apartment') {
      // SoHo / Tribeca Loft: hardwood plank floor, exposed red brick left wall, plush woven rug, floor-to-ceiling
      // walnut bookcase, tufted leather sectional sofa, marble coffee table, glowing 4K OLED TV, brass floor lamp & ficus
      geo.quad([[mid - 1.9, 2.0, 0.022], [mid + 1.9, 2.0, 0.022], [mid + 1.9, Math.min(back - 0.5, 5.5), 0.022], [mid - 1.9, Math.min(back - 0.5, 5.5), 0.022]], [0, 0, 1], [0.48, 0.22, 0.18], MAT_FABRIC);
      geo.quad([[mid - 1.65, 2.25, 0.026], [mid + 1.65, 2.25, 0.026], [mid + 1.65, Math.min(back - 0.75, 5.25), 0.026], [mid - 1.65, Math.min(back - 0.75, 5.25), 0.026]], [0, 0, 1], [0.64, 0.54, 0.42], MAT_FABRIC);
      // Walnut floor-to-ceiling bookcase along right wall
      stat(Rr - 0.46, Rr - 0.03, 1.4, Math.min(back - 0.5, 5.0), 0, 2.45, [0.32, 0.20, 0.12], MAT_WOOD);
      for (let y = 0.32; y < 2.25; y += 0.44) {
        for (let w = 1.55; w < Math.min(back - 0.65, 4.85); w += 0.14) {
          geo.box(Rr - 0.40, Rr - 0.08, w, w + 0.10, y, y + 0.24 + R() * 0.12, bright(), MAT_FABRIC);
        }
      }
      // Tufted leather sectional sofa + warm accent throw pillows
      const sy = Math.min(back - 1.15, 5.3);
      geo.box(mid - 1.25, mid + 1.25, sy - 0.44, sy + 0.44, 0.12, 0.46, [0.24, 0.28, 0.36], MAT_FABRIC);
      geo.box(mid - 1.25, mid + 1.25, sy + 0.24, sy + 0.46, 0.46, 0.94, [0.22, 0.26, 0.34], MAT_FABRIC);
      geo.box(mid - 1.36, mid - 1.16, sy - 0.44, sy + 0.46, 0.12, 0.68, [0.20, 0.24, 0.32], MAT_FABRIC);
      geo.box(mid + 1.16, mid + 1.36, sy - 0.44, sy + 0.46, 0.12, 0.68, [0.20, 0.24, 0.32], MAT_FABRIC);
      geo.box(mid - 0.96, mid - 0.60, sy + 0.05, sy + 0.22, 0.46, 0.74, [0.86, 0.44, 0.22], MAT_FABRIC);
      geo.box(mid + 0.60, mid + 0.96, sy + 0.05, sy + 0.22, 0.46, 0.74, [0.88, 0.74, 0.26], MAT_FABRIC);
      // Wall-mounted 4K OLED TV + media console + glowing brass floor lamp + indoor ficus
      geo.box(mid - 1.45, mid + 1.45, back - 0.48, back - 0.04, 0.06, 0.56, [0.34, 0.22, 0.14], MAT_WOOD);
      geo.framedBackWall(mid - 1.25, mid + 1.25, back, 1.25, 2.48, [0.10, 0.10, 0.12], [0.28, 0.54, 0.86], MAT_METAL, 2.2);
      geo.cylinder(L + 0.55, back - 0.55, 0.16, 0.015, 0.05, 10, [0.76, 0.60, 0.30], MAT_METAL);
      geo.cylinder(L + 0.55, back - 0.55, 0.025, 0.05, 1.65, 8, [0.76, 0.60, 0.30], MAT_METAL);
      geo.cylinder(L + 0.55, back - 0.55, 0.22, 1.52, 1.88, 12, [1.0, 0.84, 0.52], MAT_GLOW, 2.8);
      geo.planter(Rr - 0.72, back - 0.55, [0.78, 0.76, 0.72]);
      addDebris(mid, Math.max(2.0, sy - 1.35), 1.18, 0.64, 0.42, [0.78, 0.76, 0.72], 22);
    } else {
      // Manhattan Tower Lobby: polished bookmatched Carrara marble floor & walls, brushed-brass inlays, twin stainless
      // elevators with glowing floor indicators, curved marble concierge desk with glowing monitors & sculptural planters
      for (const eu of [mid - 1.35, mid + 1.35]) {
        geo.box(eu - 0.92, eu + 0.92, back - 0.14, back, 0, 2.68, [0.74, 0.60, 0.30], MAT_METAL);
        geo.box(eu - 0.80, eu - 0.02, back - 0.10, back - 0.02, 0.02, 2.56, [0.68, 0.71, 0.76], MAT_METAL);
        geo.box(eu + 0.02, eu + 0.80, back - 0.10, back - 0.02, 0.02, 2.56, [0.68, 0.71, 0.76], MAT_METAL);
        // Glowing elevator floor indicator above doors
        geo.box(eu - 0.24, eu + 0.24, back - 0.16, back - 0.10, 2.74, 2.94, [1.0, 0.76, 0.34], MAT_NEON, 3.0);
      }
      // Illuminated concierge desk with veined marble front & brass trim
      stat(mid - 1.90, mid + 1.90, D * 0.48, D * 0.48 + 0.96, 0, 1.04, [0.76, 0.74, 0.70], MAT_MARBLE);
      geo.box(mid - 1.96, mid + 1.96, D * 0.48 - 0.05, D * 0.48 + 1.02, 1.04, 1.12, [0.86, 0.84, 0.80], MAT_MARBLE);
      geo.box(mid - 1.88, mid + 1.88, D * 0.48 - 0.04, D * 0.48 + 0.01, 0.08, 0.14, [1.0, 0.84, 0.52], MAT_GLOW, 2.4);
      geo.box(mid - 0.70, mid - 0.22, D * 0.48 + 0.35, D * 0.48 + 0.41, 1.12, 1.46, [0.14, 0.15, 0.18], MAT_METAL);
      geo.box(mid + 0.22, mid + 0.70, D * 0.48 + 0.35, D * 0.48 + 0.41, 1.12, 1.46, [0.14, 0.15, 0.18], MAT_METAL);
      for (const pu of [L + 0.82, Rr - 0.82]) {
        geo.planter(pu, D * 0.56, [0.74, 0.72, 0.68]);
      }
      addDebris(mid, D * 0.26, 0.95, 0.48, 0.48, [0.74, 0.72, 0.68], 26);
    }

    this.host.replace(b.key, box, cols);

    // ---- Room visual mesh + depth portal + real architectural interior PointLight
    const group = new THREE.Group();
    group.position.copy(center);
    group.quaternion.copy(quat);
    const room = new THREE.Mesh(geo.build(), this.roomMat);
    room.renderOrder = ORDER_ROOM;
    group.add(room);
    const portal = new THREE.Mesh(this.box, this.portalMat);
    portal.renderOrder = ORDER_PORTAL;
    const pc = local((h0 + h1) / 2, (PORTAL_IN - PORTAL_OUT) / 2, HOLE_H / 2 + 0.03);
    portal.position.copy(pc);
    portal.scale.set(f.ax === 'x' ? PORTAL_IN + PORTAL_OUT : holeW, HOLE_H - 0.06, f.ax === 'x' ? holeW : PORTAL_IN + PORTAL_OUT);
    group.add(portal);

    // Real interior architectural light (Clustered Forward+, zero shadow cost): bathes the room & car hood in warm light!
    let light: THREE.PointLight | null = null;
    while (this.activeLights.length >= MAX_LIGHTS) {
      const oldL = this.activeLights.shift();
      oldL?.removeFromParent();
    }
    light = new THREE.PointLight(kind === 'shop' ? 0xeef5ff : 0xffddb0, 16, 18, 2);
    light.position.copy(local(mid, Math.min(D * 0.45, 3.2), H - 0.55));
    group.add(light);
    this.activeLights.push(light);

    this.scene.add(group);
    group.updateMatrixWorld(true);

    const live: Live = {
      spec, key: b.key, group, portal, light,
      face: { ax: f.ax, s: f.s, plane: f.half - wo },
      center, quat, pieces: [], pending: [], age: 0,
    };

    const spawnKin = (p: THREE.Vector3, size: THREE.Vector3, c: RGB, vel: THREE.Vector3, massKg: number, delay = 0) => {
      const slot = this.take(new THREE.Color(...c));
      if (slot < 0) return;
      const piece: KinPiece = {
        pos: p.clone(),
        vel: vel.clone(),
        quat: quat.clone(),
        angVel: new THREE.Vector3((R() - 0.5) * 6, (R() - 0.5) * 5, (R() - 0.5) * 6),
        size: size.clone(),
        groundY: box.z0 + size.y * 0.5,
        slot,
        massKg,
        heavy: massKg >= 35,
        hitCarCd: 0,
        delay,
        sleeping: false,
      };
      live.pieces.push(piece);
    };

    const inDir = mapW((h0 + h1) / 2, 1.0, 0).sub(mapW((h0 + h1) / 2, 0.0, 0)).normalize();
    const tanDir = new THREE.Vector3(-inDir.z, 0, inDir.x);
    for (const d of debrisSpec) {
      const p = local(d.u, d.w, d.y).applyQuaternion(quat).add(center);
      const size = new THREE.Vector3(f.ax === 'x' ? d.sw : d.su, d.sy, f.ax === 'x' ? d.su : d.sw);
      const sidePush = (d.u >= mid ? 1 : -1) * (2.5 + R() * 2.5);
      const vel = crash
        ? inDir.clone().multiplyScalar(3.5 + R() * 4).addScaledVector(tanDir, sidePush).add(new THREE.Vector3(0, 1.5 + R() * 2.0, 0))
        : new THREE.Vector3(0, 0, 0);
      spawnKin(p, size, d.c, vel, d.mass);
    }

    // ---- Kinematic ballistic rubble:
    //  1) 10 fast wall-blast fragments spraying out & sideways (12-32 kg)
    //  2) 7 HEAVY collapsing upper-lintel concrete/brick chunks (55-155 kg) cascading down onto the car's hood/roof!
    if (crash) {
      const out = inDir.clone().negate();
      const storefront = height >= 22 && !(height <= 60 && spec.seed % 3 === 0);
      this.host.burst?.(pc.x, box.z0, pc.z, out.x, out.z, crash.preV.x, crash.preV.z, storefront);
      for (let i = 0; i < 10; i++) {
        const s = 0.15 + R() * 0.20;
        const brick = R() < 0.55;
        const p = mapW(h0 + 0.2 + R() * Math.max(0.4, holeW - 0.4), -0.15 + R() * 0.8, 0.5 + R() * (HOLE_H - 0.7));
        const size = new THREE.Vector3(s * (0.9 + R() * 0.8), s * 0.7, s * (0.8 + R() * 0.6));
        const spray = (R() - 0.5) * 7.5;
        const fwd = 2.4 + R() * 5.2;
        const vel = inDir.clone().multiplyScalar(fwd * (R() < 0.65 ? 1 : -0.45))
          .addScaledVector(tanDir, spray)
          .add(new THREE.Vector3(0, 1.4 + R() * 3.4, 0));
        spawnKin(p, size, brick ? [0.46, 0.22, 0.16] : [0.44, 0.43, 0.41], vel, 12 + R() * 20);
      }
      // Heavy upper-lintel concrete & masonry slabs dropping down right onto the car!
      for (let i = 0; i < 7; i++) {
        const s = 0.30 + R() * 0.22;
        const brick = R() < 0.45;
        const uDrop = (h0 + h1) * 0.5 + (R() - 0.5) * Math.min(2.4, holeW * 0.65);
        const wDrop = -0.35 + R() * 2.2;
        const p = mapW(uDrop, wDrop, HOLE_H + 0.35 + R() * 1.15);
        const size = new THREE.Vector3(s * (0.95 + R() * 0.55), s * (0.65 + R() * 0.35), s * (0.9 + R() * 0.5));
        const massKg = Math.round(55 + (s - 0.30) * 450); // 55..155 kg heavy concrete/masonry blocks!
        const vel = new THREE.Vector3(
          crash.carVel.x * (0.25 + R() * 0.35) + (R() - 0.5) * 1.8,
          -0.6 - R() * 1.8,
          crash.carVel.z * (0.25 + R() * 0.35) + (R() - 0.5) * 1.8,
        );
        spawnKin(p, size, brick ? [0.48, 0.23, 0.17] : [0.46, 0.45, 0.43], vel, massKg, 0.04 + i * 0.11);
      }
    }

    this.live.push(live);
    this.sync(live);
    while (this.live.length > MAX_LIVE) this.dropOldest();
    return true;
  }

  private removeLight(l: Live) {
    if (!l.light) return;
    l.light.removeFromParent();
    const idx = this.activeLights.indexOf(l.light);
    if (idx >= 0) this.activeLights.splice(idx, 1);
    l.light = null;
  }

  private dropOldest() {
    const oldest = this.live.shift();
    if (!oldest) return;
    this.removeLight(oldest);
    oldest.group.removeFromParent();
    (oldest.group.children[0] as THREE.Mesh).geometry.dispose();
    for (const p of oldest.pieces) this.release(p.slot);
  }

  private sync(l: Live) {
    for (const p of l.pieces) {
      if (p.delay > 0) {
        this.pool.setMatrixAt(p.slot, this.zero);
        continue;
      }
      this.m4.compose(p.pos, p.quat, p.size);
      this.pool.setMatrixAt(p.slot, this.m4);
    }
    this.pool.instanceMatrix.needsUpdate = true;
  }

  /**
   * Ultra-fast kinematic ballistic update (<0.04 ms CPU) + exact car-hull OBB hit detection:
   * heavy falling concrete/masonry blocks visibly dent & damage the exact hood/roof/fender they strike, then bounce off cleanly!
   */
  update(dt: number, camera: THREE.Camera, carBox?: CarObb | null, carVel?: { x: number; y: number; z: number }) {
    const h = Math.min(dt, 0.033);
    if (carBox) this.invQ.copy(carBox.quat).invert();
    const cvx = carVel?.x ?? 0, cvy = carVel?.y ?? 0, cvz = carVel?.z ?? 0;

    for (const l of this.live) {
      l.age += h;
      for (let i = l.pending.length - 1; i >= 0; i--) {
        if (l.age >= l.pending[i].at) { l.pending[i].make(); l.pending.splice(i, 1); }
      }
      const lc = this.v.copy(camera.position).sub(l.center).applyQuaternion(this.q.copy(l.quat).invert());
      l.portal.visible = l.face.s * (l.face.ax === 'x' ? lc.x : lc.z) > l.face.plane - 0.05;

      let moved = false;
      for (const p of l.pieces) {
        if (p.sleeping) continue;
        if (p.delay > 0) {
          p.delay -= h;
          if (p.delay <= 0) moved = true;
          continue;
        }
        if (p.hitCarCd > 0) p.hitCarCd -= h;

        p.vel.y -= 11.5 * h;
        p.pos.addScaledVector(p.vel, h);
        const wMag = p.angVel.length();
        if (wMag > 1e-3) {
          this.axis.copy(p.angVel).divideScalar(wMag);
          this.dq.setFromAxisAngle(this.axis, wMag * h);
          p.quat.premultiply(this.dq).normalize();
        }

        // Exact OBB check against player car: heavy chunks falling onto hood/roof/trunk DENT & DAMAGE the car, then deflect cleanly!
        if (carBox && p.hitCarCd <= 0) {
          const r = Math.max(p.size.x, p.size.y, p.size.z) * 0.48;
          const lp = this.v2.copy(p.pos).sub(carBox.pos).applyQuaternion(this.invQ);
          const lx = lp.x - carBox.centre[0];
          const ly = lp.y - carBox.centre[1];
          const lz = lp.z - carBox.centre[2];
          const hx = carBox.half[0] + r, hy = carBox.half[1] + r, hz = carBox.half[2] + r;
          if (Math.abs(lx) < hx && Math.abs(ly) < hy && Math.abs(lz) < hz) {
            const vRel = Math.hypot(p.vel.x - cvx, p.vel.y - cvy, p.vel.z - cvz);
            if (p.heavy && (p.vel.y < -1.0 || vRel > 3.2)) {
              const energyJ = 0.5 * p.massKg * vRel * vRel * 2.4;
              const impulse = p.massKg * vRel * 2.5;
              const glass = ly > carBox.half[1] * 0.20 && lz > -0.35 && lz < 1.25;
              this.onRubbleHit?.({
                point: p.pos.clone(),
                dir: new THREE.Vector3(0, -1, 0),
                impulse,
                energyJ,
                massKg: p.massKg,
                glass,
              });
            }
            // Deflect chunk cleanly up & away from the car body so it NEVER traps inside the car!
            const pushSide = lx >= 0 ? 1 : -1;
            const outW = this.v.set(pushSide * (2.4 + Math.random() * 2.2), Math.abs(p.vel.y) * 0.38 + 2.2, (lz >= 0 ? 1 : -1) * 1.4).applyQuaternion(carBox.quat);
            p.vel.set(outW.x + cvx * 0.35, Math.max(2.0, outW.y), outW.z + cvz * 0.35);
            p.pos.y = Math.max(p.pos.y, carBox.pos.y + carBox.centre[1] + carBox.half[1] + r * 0.65);
            p.angVel.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
            p.hitCarCd = 0.7;
          }
        }

        if (p.pos.y <= p.groundY) {
          p.pos.y = p.groundY;
          if (Math.abs(p.vel.y) > 0.85) {
            p.vel.y = -p.vel.y * 0.28;
            p.vel.x *= 0.62;
            p.vel.z *= 0.62;
            p.angVel.multiplyScalar(0.55);
          } else {
            p.vel.y = 0;
            p.vel.x *= 0.78;
            p.vel.z *= 0.78;
            p.angVel.multiplyScalar(0.7);
            if (p.vel.lengthSq() < 0.03 || l.age > 4.2) {
              p.vel.set(0, 0, 0);
              p.angVel.set(0, 0, 0);
              p.sleeping = true;
            }
          }
        }
        moved = true;
      }
      if (moved) this.sync(l);
    }
  }

  clear() {
    for (const l of this.live) {
      this.removeLight(l);
      l.group.removeFromParent();
      (l.group.children[0] as THREE.Mesh).geometry.dispose();
      for (const p of l.pieces) this.release(p.slot);
    }
    this.live = [];
    this.specs = [];
    for (const o of this.warm) o.removeFromParent();
    this.warm.length = 0;
    this.pool.removeFromParent();
    this.pool.dispose();
    this.box.dispose();
    this.roomMat.dispose();
    this.looseMat.dispose();
    this.portalMat.dispose();
  }

  dropTile(key: string) {
    for (const l of this.live.filter((x) => x.key === key)) {
      this.removeLight(l);
      l.group.removeFromParent();
      (l.group.children[0] as THREE.Mesh).geometry.dispose();
      for (const p of l.pieces) this.release(p.slot);
    }
    this.live = this.live.filter((x) => x.key !== key);
  }

  reapply(key: string) {
    for (const s of this.specs) {
      const b = this.host.find(s.cx, s.cy);
      if (b && b.key === key && !this.live.some((l) => l.spec === s)) this.open(s);
    }
  }

  breakNearest(p: THREE.Vector3, list: { key: string; box: BuildingColliderBox }[]) {
    let best: { key: string; box: BuildingColliderBox } | null = null, bd = 80;
    for (const b of list) {
      const d = Math.hypot(b.box.cx - p.x, b.box.cy + p.z) - Math.max(b.box.hx, b.box.hy);
      if (d < bd) { bd = d; best = b; }
    }
    if (!best) return false;
    const { center, quat } = this.frame(best.box);
    const lp = this.v.copy(p).sub(center).applyQuaternion(this.q.copy(quat).invert());
    const dx = Math.abs(lp.x) - best.box.hx, dz = Math.abs(lp.z) - best.box.hy;
    const face = dx > dz ? (lp.x > 0 ? 0 : 1) : (lp.z > 0 ? 2 : 3);
    const seed = Math.floor(Math.abs(best.box.cx * 7.31 + best.box.cy * 3.17) * 100) % 100000;
    return this.open({ cx: best.box.cx, cy: best.box.cy, face, u: face < 2 ? lp.z : lp.x, seed }, { carPos: p, carVel: { x: 0, y: 0, z: 0 }, preV: { x: 0, y: 0, z: 0 } });
  }
}

export function drawEarly(root: THREE.Object3D) {
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.renderOrder = ORDER_EARLY; });
}
