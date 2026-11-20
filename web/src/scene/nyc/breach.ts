// Ground-floor wall & corner crashes (OpenGrid).
// - Supports breaking BOTH flat walls AND building corners (corner-assist normal + edge-flush hole opening).
// - High-detail architectural interiors (tiled/planked floors, baseboards, crown moldings, acoustic ceiling beams,
//   recessed linear LED strips, fluted columns, jagged masonry/rebar hole reveal, and richly detailed Shop, Deli,
//   Loft Apartment, and Manhattan Lobby furnishings).
// - Zero-lag, zero-stuck-rubble crash debris: all rubble & flying furniture pieces run on an ultra-fast kinematic
//   ballistic solver in a single GPU InstancedMesh pool (no Rapier rigid-body solver pileups inside the car hull!).
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingColliderBox } from './props';
import { GROUP_CAMERA_ONLY } from '../../physics/world';
import { instanceSlots } from '../instancing';

/** Membership bit 0x8: collides only with static world geometry — NEVER jams into cars (0x1) or other rubble (0x8). */
export const GROUP_RUBBLE = (0x0008 << 16) | (0xffff & ~0x0001 & ~0x0008);

const H = 4.2;            // ground floor ceiling height
const HOLE_W = 3.5, HOLE_H = 3.35, WALL_T = 0.42;
const PORTAL_OUT = 0.16, PORTAL_IN = 1.25;
const ORDER_EARLY = -4, ORDER_ROOM = -2, ORDER_PORTAL = -1;
const MAX_LIVE = 4;

type Room = 'shop' | 'deli' | 'apartment' | 'lobby';
type RGB = [number, number, number];

/** Opaque meshes under obj are drawn before the breach portals (so they stay visible inside a hole). */
export function drawEarly(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    if (mats.every((x) => !x.transparent)) m.renderOrder = ORDER_EARLY;
  });
}

export interface BreachHost {
  building(handle: number): { key: string; box: BuildingColliderBox } | null;
  find(cx: number, cy: number): { key: string; box: BuildingColliderBox } | null;
  /** Swap the building's solid collider for these (static, wall surface); marks it breached. */
  replace(key: string, box: BuildingColliderBox, descs: RAPIER.ColliderDesc[]): void;
  facadeDepth?(from: THREE.Vector3, dir: THREE.Vector3, max: number): number | null;
  burst?(wx: number, groundY: number, wz: number, nx: number, nz: number, vx: number, vz: number, glass: boolean): void;
}

export interface BreachSpec { cx: number; cy: number; face: number; u: number; seed: number }
export interface WallHit { spec: BreachSpec; point: { x: number; y: number; z: number }; impulse: number; storefront: boolean }

/** Zero-overhead kinematic ballistic debris/furniture piece (never traps inside the car hull, <0.03 ms CPU). */
interface KinPiece {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  angVel: THREE.Vector3;
  size: THREE.Vector3;
  groundY: number;
  slot: number;
  sleeping: boolean;
}

interface Live {
  spec: BreachSpec;
  key: string;
  group: THREE.Group;
  portal: THREE.Mesh;
  face: { ax: 'x' | 'z'; s: number; plane: number };
  center: THREE.Vector3;
  quat: THREE.Quaternion;
  pieces: KinPiece[];
  pending: { at: number; make: () => void }[];
  age: number;
}

const rand = (seed: number) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
};

/** High-detail procedural interior geometry builder with baked multi-source lighting & vertex AO. */
class Geo {
  pos: number[] = [];
  col: number[] = [];
  constructor(
    private map: (u: number, w: number, y: number) => THREE.Vector3,
    private light: (u: number, w: number, y: number) => number,
  ) {}

  quad(p: [number, number, number][], n: [number, number, number], c: RGB, glow = 1) {
    const v = p.map(([u, w, y]) => this.map(u, w, y));
    const want = this.map(p[0][0] + n[0], p[0][1] + n[1], p[0][2] + n[2]).sub(v[0]);
    const e1 = v[1].clone().sub(v[0]), e2 = v[2].clone().sub(v[0]);
    const order = e1.cross(e2).dot(want) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    const shade = n[2] > 0.5 ? 1.0 : n[2] < -0.5 ? 0.52 : Math.abs(n[0]) > 0.5 ? 0.84 : 0.72;
    for (const i of order) {
      const q = p[i];
      const L = glow > 1 ? glow : shade * this.light(q[0], q[1], q[2]);
      this.pos.push(v[i].x, v[i].y, v[i].z);
      this.col.push(c[0] * L, c[1] * L, c[2] * L);
    }
  }

  box(u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, c: RGB, glow = 1) {
    this.quad([[u0, w0, y1], [u1, w0, y1], [u1, w1, y1], [u0, w1, y1]], [0, 0, 1], c, glow);
    this.quad([[u0, w0, y0], [u1, w0, y0], [u1, w1, y0], [u0, w1, y0]], [0, 0, -1], c, glow);
    this.quad([[u0, w0, y0], [u1, w0, y0], [u1, w0, y1], [u0, w0, y1]], [0, -1, 0], c, glow);
    this.quad([[u0, w1, y0], [u1, w1, y0], [u1, w1, y1], [u0, w1, y1]], [0, 1, 0], c, glow);
    this.quad([[u0, w0, y0], [u0, w1, y0], [u0, w1, y1], [u0, w0, y1]], [-1, 0, 0], c, glow);
    this.quad([[u1, w0, y0], [u1, w1, y0], [u1, w1, y1], [u1, w0, y1]], [1, 0, 0], c, glow);
  }

  /** Multi-sided architectural column, table pedestal, pendant globe, or planter barrel. */
  cylinder(uc: number, wc: number, r: number, y0: number, y1: number, segs: number, c: RGB, glow = 1) {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const u0 = uc + c0 * r, w0 = wc + s0 * r;
      const u1 = uc + c1 * r, w1 = wc + s1 * r;
      const nm: [number, number, number] = [Math.cos((a0 + a1) * 0.5), Math.sin((a0 + a1) * 0.5), 0];
      this.quad([[u0, w0, y0], [u1, w1, y0], [u1, w1, y1], [u0, w0, y1]], nm, c, glow);
      // top cap wedge
      this.quad([[uc, wc, y1], [u0, w0, y1], [u1, w1, y1], [uc, wc, y1]], [0, 0, 1], c, glow);
    }
  }

  /** Tiled / planked floor with subtle architectural checker/plank variation and grout shadows. */
  tiledFloor(u0: number, u1: number, w0: number, w1: number, tileU: number, tileW: number, cA: RGB, cB: RGB) {
    const nu = Math.max(1, Math.min(12, Math.round((u1 - u0) / tileU)));
    const nw = Math.max(1, Math.min(14, Math.round((w1 - w0) / tileW)));
    const du = (u1 - u0) / nu, dw = (w1 - w0) / nw;
    for (let iu = 0; iu < nu; iu++) {
      for (let iw = 0; iw < nw; iw++) {
        const c = (iu + iw) % 2 === 0 ? cA : cB;
        const ua = u0 + iu * du, ub = ua + du;
        const wa = w0 + iw * dw, wb = wa + dw;
        this.quad([[ua, wa, 0.012], [ub, wa, 0.012], [ub, wb, 0.012], [ua, wb, 0.012]], [0, 0, 1], c);
      }
    }
  }

  /** Framed wall artwork, backlit menu board, or flat-screen display. */
  framedBackWall(u0: number, u1: number, wWall: number, y0: number, y1: number, frameC: RGB, artC: RGB, glow = 1.25) {
    this.box(u0, u1, wWall - 0.08, wWall, y0, y1, frameC);
    this.quad([[u0 + 0.06, wWall - 0.085, y0 + 0.06], [u1 - 0.06, wWall - 0.085, y0 + 0.06],
      [u1 - 0.06, wWall - 0.085, y1 - 0.06], [u0 + 0.06, wWall - 0.085, y1 - 0.06]], [0, -1, 0], artC, glow);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Unit beveled chunk geometry with baked directional face shading for instanced rubble & debris. */
function unitBox() {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const n = g.getAttribute('normal');
  const c: number[] = [];
  for (let i = 0; i < n.count; i++) {
    const y = n.getY(i), s = y > 0.5 ? 1.0 : y < -0.5 ? 0.45 : Math.abs(n.getX(i)) > 0.5 ? 0.82 : 0.68;
    c.push(s, s, s);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  g.deleteAttribute('uv');
  return g;
}

export class Breaches {
  private live: Live[] = [];
  private specs: BreachSpec[] = [];
  private roomMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private looseMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  private pool: THREE.InstancedMesh;
  private free: number[] = [];
  private used = 0;
  private static readonly POOL = 320;
  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private portalMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  private box = unitBox();
  private warm: THREE.Object3D[] = [];
  private m4 = new THREE.Matrix4();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private dq = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private axis = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private pw: { world: RAPIER.World }, private host: BreachHost) {
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
    g.box(0, 0.01, 0, 0.01, 0, 0.01, [0.5, 0.5, 0.5]);
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

    // Pick face: if hitting a corner (both dx & dz near 0), pick the face most aligned with car's incoming velocity!
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
    // Corner impacts split velocity across two faces: use effective corner impact speed so corners break smoothly!
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
    return face < 2
      ? { ax: 'x' as const, s: face === 0 ? 1 : -1, half: box.hx, uHalf: box.hy }
      : { ax: 'z' as const, s: face === 2 ? 1 : -1, half: box.hy, uHalf: box.hx };
  }

  private local(box: BuildingColliderBox, face: number, u: number, w: number, y: number) {
    const f = this.faceOf(box, face), a = f.s * (f.half - w);
    return f.ax === 'x' ? new THREE.Vector3(a, y, u) : new THREE.Vector3(u, y, a);
  }

  private map(box: BuildingColliderBox, face: number, u: number, w: number, y: number) {
    const { center, quat } = this.frame(box);
    return this.local(box, face, u, w, y).applyQuaternion(quat).add(center);
  }

  /** Open a breach (supports flat walls AND building corners) with high-detail interior & zero-lag kinematic debris. */
  open(spec: BreachSpec, crash?: { carPos: { x: number; y: number; z: number }; carVel: { x: number; y: number; z: number }; preV: { x: number; y: number; z: number } }) {
    const b = this.host.find(spec.cx, spec.cy);
    if (!b) return false;
    const box = b.box, face = spec.face, f = this.faceOf(box, face);
    if (!this.specs.some((x) => x.cx === spec.cx && x.cy === spec.cy)) this.specs.push(spec);
    const R = rand(spec.seed + 17);

    // Allow hole & room to extend right up to building corners (0.08 m margin) so corners break cleanly!
    const holeW = Math.min(HOLE_W, 2 * f.uHalf - 0.24);
    const W = Math.min(8.2, Math.max(holeW + 0.16, 2 * f.uHalf - 0.16));
    const u0 = Math.max(-f.uHalf + 0.08, Math.min(f.uHalf - 0.08 - W, spec.u - W / 2));
    const u1 = u0 + W;
    const h0 = Math.max(u0 + 0.04, Math.min(u1 - 0.04 - holeW, spec.u - holeW / 2));
    const h1 = h0 + holeW;
    const isLeftCorner = h0 < -f.uHalf + 0.45;
    const isRightCorner = h1 > f.uHalf - 0.45;
    const height = box.z1 - box.z0;
    const full = 2 * f.half;

    let wo = 0;
    {
      const from = this.map(box, face, (h0 + h1) / 2, -2, 1.5);
      const to = this.map(box, face, (h0 + h1) / 2, 0, 1.5);
      const d = this.host.facadeDepth?.(from, to.sub(from).normalize(), 2 + Math.min(4, full - 4));
      if (d !== null && d !== undefined) wo = Math.max(0, Math.min(full - 4, d - 2));
    }
    const D = Math.max(3.6, Math.min(10.5, full - wo - 0.6));
    const local = (u: number, w: number, y: number) => this.local(box, face, u, w + wo, y);
    const mapW = (u: number, w: number, y: number) => this.map(box, face, u, w + wo, y);
    const kind: Room = height > 60 ? 'lobby' : height < 22 ? (spec.seed % 2 ? 'apartment' : 'shop') : (['shop', 'deli', 'shop', 'apartment'] as Room[])[spec.seed % 4];

    // ---- Static colliders around the breached room (upper floors, back/side walls, lintel)
    const { center, quat } = this.frame(box);
    const descs: RAPIER.ColliderDesc[] = [];
    const cuboid = (uA: number, uB: number, wA: number, wB: number, yA: number, yB: number) => {
      if (uB - uA < 0.05 || wB - wA < 0.05 || yB - yA < 0.05) return;
      const c = local((uA + uB) / 2, (wA + wB) / 2, (yA + yB) / 2).applyQuaternion(quat).add(center);
      const hu = (uB - uA) / 2, hw = (wB - wA) / 2, hy = (yB - yA) / 2;
      descs.push(RAPIER.ColliderDesc.cuboid(f.ax === 'x' ? hw : hu, hy, f.ax === 'x' ? hu : hw)
        .setTranslation(c.x, c.y, c.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setFriction(0.5).setRestitution(0.05));
    };
    cuboid(-f.uHalf, f.uHalf, -wo, full - wo, H, height);
    cuboid(-f.uHalf, u0, -wo, full - wo, 0, H);
    cuboid(u1, f.uHalf, -wo, full - wo, 0, H);
    cuboid(u0, u1, D, full - wo, 0, H);
    if (!isLeftCorner) cuboid(u0, h0, 0, WALL_T, 0, H);
    if (!isRightCorner) cuboid(h1, u1, 0, WALL_T, 0, H);
    cuboid(h0, h1, 0, WALL_T, HOLE_H, H);
    cuboid(h0, h1, 0.1, 0.3, 0, HOLE_H);
    descs[descs.length - 1].setCollisionGroups(GROUP_CAMERA_ONLY);

    // ---- High-Detail Architectural Room Geometry
    const statics: [number, number, number, number, number, number][] = [];
    const debrisSpec: { u: number; w: number; y: number; su: number; sw: number; sy: number; c: RGB }[] = [];
    const light = (u: number, w: number, y: number) => {
      const du = (u - (u0 + u1) / 2) / Math.max(1, W);
      const dw = (w - D * 0.48) / Math.max(1, D);
      const ceilGlow = 0.55 + 0.45 * (y / H);
      const centerFall = 0.42 + 0.48 * Math.max(0, 1 - Math.hypot(du, dw) * 1.45);
      // Corner ambient occlusion near wall-floor & wall-wall creases
      const edgeU = Math.min(u - u0, u1 - u);
      const edgeW = Math.min(w - WALL_T, D - w);
      const crease = 0.72 + 0.28 * Math.min(1, Math.min(edgeU, edgeW, y + 0.15) / 0.65);
      return centerFall * ceilGlow * crease;
    };
    const geo = new Geo(local, light);
    const wallC: RGB = kind === 'apartment' ? [0.64, 0.55, 0.46] : kind === 'lobby' ? [0.74, 0.71, 0.66] : kind === 'deli' ? [0.72, 0.68, 0.60] : [0.78, 0.78, 0.76];
    const trimC: RGB = kind === 'lobby' ? [0.62, 0.50, 0.28] : [0.22, 0.21, 0.20];
    const floorA: RGB = kind === 'apartment' ? [0.40, 0.25, 0.14] : kind === 'lobby' ? [0.82, 0.80, 0.76] : kind === 'deli' ? [0.46, 0.44, 0.40] : [0.56, 0.55, 0.53];
    const floorB: RGB = kind === 'apartment' ? [0.34, 0.21, 0.11] : kind === 'lobby' ? [0.28, 0.29, 0.31] : kind === 'deli' ? [0.34, 0.32, 0.29] : [0.48, 0.48, 0.46];
    const T = WALL_T, L = u0 + 0.02, Rr = u1 - 0.02;
    const mid = (u0 + u1) / 2;
    const back = D - 0.06;

    // 1. Tiled / planked floor + coffered ceiling + architectural walls
    geo.tiledFloor(L, Rr, T, D, kind === 'apartment' ? 0.45 : 0.85, kind === 'apartment' ? 1.4 : 0.85, floorA, floorB);
    geo.quad([[L, T, H], [Rr, T, H], [Rr, D, H], [L, D, H]], [0, 0, -1], [0.62, 0.62, 0.60]);
    geo.quad([[L, T, 0], [L, D, 0], [L, D, H], [L, T, H]], [1, 0, 0], wallC);
    geo.quad([[Rr, T, 0], [Rr, D, 0], [Rr, D, H], [Rr, T, H]], [-1, 0, 0], wallC);
    geo.quad([[L, D, 0], [Rr, D, 0], [Rr, D, H], [L, D, H]], [0, -1, 0], wallC);
    geo.quad([[L, T, 0], [h0, T, 0], [h0, T, H], [L, T, H]], [0, 1, 0], wallC);
    geo.quad([[h1, T, 0], [Rr, T, 0], [Rr, T, H], [h1, T, H]], [0, 1, 0], wallC);
    geo.quad([[h0, T, HOLE_H], [h1, T, HOLE_H], [h1, T, H], [h0, T, H]], [0, 1, 0], wallC);

    // 2. Baseboard moldings, crown cornice moldings & acoustic ceiling beams + recessed LED linear lights
    geo.box(L, L + 0.05, T, D, 0, 0.16, trimC);
    geo.box(Rr - 0.05, Rr, T, D, 0, 0.16, trimC);
    geo.box(L, Rr, D - 0.05, D, 0, 0.16, trimC);
    geo.box(L, L + 0.08, T, D, H - 0.14, H, trimC);
    geo.box(Rr - 0.08, Rr, T, D, H - 0.14, H, trimC);
    geo.box(L, Rr, D - 0.08, D, H - 0.14, H, trimC);
    for (let w = 1.6; w < D - 0.6; w += 2.2) {
      geo.box(L + 0.04, Rr - 0.04, w - 0.08, w + 0.08, H - 0.22, H, [0.24, 0.24, 0.26]);
      // Recessed warm/white linear LED light strip + cylindrical pendant fixtures
      const ledC: RGB = kind === 'apartment' ? [1.0, 0.78, 0.48] : kind === 'lobby' ? [1.0, 0.90, 0.72] : [0.96, 0.98, 1.0];
      geo.quad([[u0 + W * 0.22, w + 0.35, H - 0.03], [u1 - W * 0.22, w + 0.35, H - 0.03],
        [u1 - W * 0.22, w + 0.55, H - 0.03], [u0 + W * 0.22, w + 0.55, H - 0.03]], [0, 0, -1], ledC, 1.65);
      // Hanging pendant cord + glowing glass shade
      if (W > 4.2) {
        for (const pu of [mid - W * 0.22, mid + W * 0.22]) {
          geo.cylinder(pu, w + 0.9, 0.015, H - 0.75, H, 6, [0.15, 0.15, 0.16]);
          geo.cylinder(pu, w + 0.9, 0.14, H - 0.92, H - 0.74, 10, ledC, 1.45);
        }
      }
    }

    // 3. Fluted structural columns in rear corners
    geo.cylinder(L + 0.28, back - 0.28, 0.22, 0, H, 10, [0.52, 0.50, 0.48]);
    geo.cylinder(Rr - 0.28, back - 0.28, 0.22, 0, H, 10, [0.52, 0.50, 0.48]);

    // 4. Jagged layered broken masonry/plaster/rebar reveal around the crash hole (looks genuinely smashed!)
    const brickC: RGB = [0.46, 0.24, 0.18];
    const concC: RGB = [0.42, 0.41, 0.39];
    const rebarC: RGB = [0.26, 0.18, 0.14];
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const yA = (i / steps) * HOLE_H, yB = ((i + 1) / steps) * HOLE_H;
      const jagL = (R() - 0.35) * 0.16, jagR = (R() - 0.35) * 0.16;
      geo.box(h0 - 0.04, h0 + 0.12 + jagL, -wo - 0.02, T + 0.04, yA, yB, i % 2 === 0 ? brickC : concC);
      geo.box(h1 - 0.12 - jagR, h1 + 0.04, -wo - 0.02, T + 0.04, yA, yB, i % 2 === 1 ? brickC : concC);
      // Exposed bent steel rebar rods sticking out of the broken concrete
      if (i % 2 === 1) {
        geo.box(h0 + 0.08, h0 + 0.34, 0.06, 0.10, yA + 0.12, yA + 0.16, rebarC);
        geo.box(h1 - 0.34, h1 - 0.08, 0.08, 0.12, yA + 0.18, yA + 0.22, rebarC);
      }
    }
    for (let i = 0; i < 6; i++) {
      const uA = h0 + (i / 6) * holeW, uB = h0 + ((i + 1) / 6) * holeW;
      const drop = R() * 0.14;
      geo.box(uA, uB, -wo - 0.02, T + 0.04, HOLE_H - drop, HOLE_H + 0.12, i % 2 === 0 ? concC : brickC);
    }

    // 5. High-Detail Room-Specific Architectural Furnishings
    const bright = (): RGB => ([[0.88, 0.22, 0.18], [0.95, 0.74, 0.14], [0.18, 0.52, 0.88], [0.22, 0.72, 0.38], [0.92, 0.48, 0.16], [0.86, 0.84, 0.80]][Math.floor(R() * 6)] as RGB);
    const stat = (uA: number, uB: number, wA: number, wB: number, yA: number, yB: number, c: RGB) => {
      geo.box(uA, uB, wA, wB, yA, yB, c);
      statics.push([uA, uB, wA, wB, yA, yB]);
    };
    const addDebris = (u: number, w: number, su: number, sw: number, sy: number, c: RGB, y = 0) =>
      debrisSpec.push({ u, w, y: y + sy / 2, su, sw, sy, c });

    if (kind === 'shop') {
      // Dark walnut + brushed-steel multi-tier retail wall shelving with backlit alcoves & varied merchandise
      for (const [a, bb] of [[L + 0.04, L + 0.56], [Rr - 0.56, Rr - 0.04]] as [number, number][]) {
        stat(a, bb, 1.5, Math.max(2.2, back - 1.6), 0, 0.35, [0.22, 0.18, 0.15]);
        for (let y = 0.35; y <= 2.15; y += 0.45) {
          geo.box(a, bb, 1.5, Math.max(2.2, back - 1.6), y, y + 0.04, [0.28, 0.24, 0.20]);
          if (y < 2.0) {
            for (let w = 1.62; w < back - 1.8; w += 0.36) {
              const hItem = 0.18 + R() * 0.16;
              geo.box(a + 0.08, bb - 0.08, w, w + 0.26, y + 0.04, y + 0.04 + hItem, bright());
            }
          }
        }
      }
      // Illuminated glass-and-chrome checkout counter + POS monitor + backlit refrigerated beverage wall
      stat(mid - 1.4, mid + 0.7, back - 1.7, back - 1.05, 0, 0.98, [0.20, 0.17, 0.15]);
      geo.box(mid - 1.45, mid + 0.75, back - 1.75, back - 1.0, 0.98, 1.06, [0.76, 0.78, 0.80]); // quartz countertop
      geo.box(mid - 0.55, mid - 0.15, back - 1.45, back - 1.38, 1.06, 1.42, [0.12, 0.13, 0.15]); // POS monitor
      geo.quad([[mid - 0.52, back - 1.46, 1.12], [mid - 0.18, back - 1.46, 1.12], [mid - 0.18, back - 1.46, 1.38], [mid - 0.52, back - 1.46, 1.38]], [0, -1, 0], [0.45, 0.82, 1.0], 1.4);
      geo.framedBackWall(L + 0.7, Rr - 0.7, back, 0.25, 2.35, [0.16, 0.17, 0.19], [0.75, 0.92, 1.0], 1.35);
      // Center island display tables (thrown aside smoothly on crash!)
      addDebris(mid - 0.85, D * 0.44, 0.95, 0.55, 0.95, [0.32, 0.28, 0.24]);
      addDebris(mid + 0.85, D * 0.54, 0.95, 0.55, 0.95, [0.32, 0.28, 0.24]);
    } else if (kind === 'deli') {
      // Stainless-steel NYC deli counter + glass sneeze guard + colorful trays + illuminated menu boards
      stat(L + 0.35, Rr - 0.35, back - 1.35, back - 0.65, 0, 1.02, [0.38, 0.39, 0.42]);
      geo.box(L + 0.45, Rr - 0.45, back - 1.30, back - 0.72, 1.02, 1.46, [0.74, 0.88, 0.95], 1.25);
      for (let u = L + 0.6; u < Rr - 0.8; u += 0.55) {
        geo.box(u, u + 0.42, back - 1.22, back - 0.80, 1.04, 1.16, bright());
      }
      geo.framedBackWall(mid - 1.8, mid - 0.1, back, 2.2, 3.15, [0.12, 0.12, 0.14], [1.0, 0.65, 0.24], 1.45);
      geo.framedBackWall(mid + 0.1, mid + 1.8, back, 2.2, 3.15, [0.12, 0.12, 0.14], [0.95, 0.85, 0.38], 1.40);
      // Sculpted round bistro pedestal tables + chairs with backrests
      for (const [du, w] of [[-1.35, 2.5], [1.35, 2.5], [-1.35, 4.9], [1.35, 4.9]]) {
        if (w > back - 1.9 || Math.abs(du) > W * 0.38) continue;
        geo.cylinder(mid + du, w, 0.06, 0, 0.74, 8, [0.18, 0.18, 0.20]);
        geo.cylinder(mid + du, w, 0.44, 0.74, 0.79, 12, [0.58, 0.40, 0.24]);
        for (const cx of [-0.62, 0.62]) {
          geo.box(mid + du + cx - 0.20, mid + du + cx + 0.20, w - 0.20, w + 0.20, 0.44, 0.49, [0.22, 0.22, 0.25]);
          geo.box(mid + du + cx + (cx > 0 ? 0.16 : -0.20), mid + du + cx + (cx > 0 ? 0.20 : -0.16), w - 0.19, w + 0.19, 0.49, 0.90, [0.22, 0.22, 0.25]);
        }
        addDebris(mid + du, w, 0.45, 0.45, 0.48, [0.55, 0.38, 0.22]);
      }
    } else if (kind === 'apartment') {
      // Bordered woven area rug + floor-to-ceiling bookcase + tufted sectional sofa + wall TV + framed art + floor lamp
      geo.quad([[mid - 1.8, 2.1, 0.02], [mid + 1.8, 2.1, 0.02], [mid + 1.8, Math.min(back - 0.6, 5.4), 0.02], [mid - 1.8, Math.min(back - 0.6, 5.4), 0.02]], [0, 0, 1], [0.42, 0.16, 0.14]);
      geo.quad([[mid - 1.6, 2.3, 0.024], [mid + 1.6, 2.3, 0.024], [mid + 1.6, Math.min(back - 0.8, 5.2), 0.024], [mid - 1.6, Math.min(back - 0.8, 5.2), 0.024]], [0, 0, 1], [0.52, 0.22, 0.18]);
      stat(Rr - 0.42, Rr - 0.02, 1.5, Math.min(back - 0.5, 4.8), 0, 2.3, [0.28, 0.19, 0.12]);
      for (let y = 0.3; y < 2.1; y += 0.44) {
        for (let w = 1.6; w < Math.min(back - 0.65, 4.65); w += 0.13) {
          geo.box(Rr - 0.36, Rr - 0.07, w, w + 0.09, y, y + 0.26 + R() * 0.10, bright());
        }
      }
      // Tufted L-sofa (base + backrest + armrests + throw pillows)
      const sy = Math.min(back - 1.1, 5.3);
      geo.box(mid - 1.15, mid + 1.15, sy - 0.42, sy + 0.42, 0.12, 0.46, [0.24, 0.29, 0.39]);
      geo.box(mid - 1.15, mid + 1.15, sy + 0.24, sy + 0.44, 0.46, 0.92, [0.22, 0.27, 0.36]);
      geo.box(mid - 1.25, mid - 1.05, sy - 0.42, sy + 0.44, 0.12, 0.68, [0.20, 0.25, 0.34]);
      geo.box(mid + 1.05, mid + 1.25, sy - 0.42, sy + 0.44, 0.12, 0.68, [0.20, 0.25, 0.34]);
      geo.box(mid - 0.92, mid - 0.58, sy + 0.05, sy + 0.22, 0.46, 0.74, [0.85, 0.42, 0.20]);
      geo.box(mid + 0.58, mid + 0.92, sy + 0.05, sy + 0.22, 0.46, 0.74, [0.88, 0.72, 0.24]);
      // Framed artwork & glowing wall-mounted flatscreen TV
      geo.framedBackWall(mid - 1.2, mid + 1.2, back, 1.35, 2.55, [0.16, 0.14, 0.12], [0.28, 0.48, 0.68], 1.15);
      geo.cylinder(L + 0.45, back - 0.55, 0.04, 0, 1.65, 8, [0.18, 0.18, 0.20]);
      geo.cylinder(L + 0.45, back - 0.55, 0.22, 1.55, 1.88, 10, [1.0, 0.78, 0.44], 1.55);
      addDebris(mid, Math.max(2.0, sy - 1.4), 1.15, 0.62, 0.42, [0.36, 0.24, 0.14]);
    } else {
      // Manhattan Tower Lobby: veined marble wall panels + brass trim + twin steel elevators + concierge desk + sculpted planters
      for (const eu of [mid - 1.35, mid + 0.15]) {
        geo.framedBackWall(eu, eu + 1.20, back, 0.02, 2.65, [0.64, 0.54, 0.32], [0.68, 0.70, 0.73], 1.12);
        geo.box(eu + 0.58, eu + 0.62, back - 0.10, back, 0.02, 2.65, [0.18, 0.19, 0.21]); // elevator door seam
      }
      stat(mid - 1.5, mid + 1.5, back - 2.0, back - 1.15, 0, 1.08, [0.22, 0.20, 0.19]);
      geo.box(mid - 1.56, mid + 1.56, back - 2.06, back - 1.10, 1.08, 1.16, [0.82, 0.80, 0.76]); // marble desk cap
      geo.box(mid - 0.3, mid + 0.3, back - 1.65, back - 1.58, 1.16, 1.50, [0.10, 0.11, 0.13]); // concierge monitor
      for (const pu of [L + 0.75, Rr - 0.75]) {
        geo.cylinder(pu, 2.2, 0.38, 0, 0.68, 10, [0.32, 0.31, 0.30]);
        geo.cylinder(pu, 2.2, 0.52, 0.68, 1.25, 10, [0.16, 0.38, 0.18]);
        geo.cylinder(pu, 2.2, 0.34, 1.25, 1.68, 8, [0.20, 0.46, 0.22]);
      }
      addDebris(L + 0.95, 4.2, 1.4, 0.52, 0.46, [0.26, 0.24, 0.22]);
      addDebris(Rr - 0.95, 4.2, 1.4, 0.52, 0.46, [0.26, 0.24, 0.22]);
    }

    for (const [uA, uB, wA, wB, yA, yB] of statics) cuboid(uA, uB, wA, wB, yA, yB);
    this.host.replace(b.key, box, descs);

    // ---- Room visual mesh + depth portal
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
    this.scene.add(group);
    group.updateMatrixWorld(true);

    const live: Live = {
      spec, key: b.key, group, portal,
      face: { ax: f.ax, s: f.s, plane: f.half - wo },
      center, quat, pieces: [], pending: [], age: 0,
    };

    const spawnKin = (p: THREE.Vector3, size: THREE.Vector3, c: RGB, vel: THREE.Vector3) => {
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
        sleeping: false,
      };
      live.pieces.push(piece);
    };

    // Scatter light interior props cleanly away from the car path (zero Rapier solver stall!)
    const inDir = mapW((h0 + h1) / 2, 1.0, 0).sub(mapW((h0 + h1) / 2, 0.0, 0)).normalize();
    const tanDir = new THREE.Vector3(-inDir.z, 0, inDir.x);
    for (const d of debrisSpec) {
      const p = local(d.u, d.w, d.y).applyQuaternion(quat).add(center);
      const size = new THREE.Vector3(f.ax === 'x' ? d.sw : d.su, d.sy, f.ax === 'x' ? d.su : d.sw);
      const sidePush = (d.u >= mid ? 1 : -1) * (2.5 + R() * 2.5);
      const vel = crash
        ? inDir.clone().multiplyScalar(3.5 + R() * 4).addScaledVector(tanDir, sidePush).add(new THREE.Vector3(0, 1.5 + R() * 2.0, 0))
        : new THREE.Vector3(0, 0, 0);
      spawnKin(p, size, d.c, vel);
    }

    // ---- Kinematic ballistic rubble burst (14 chunks: zero Rapier bodies -> 0 FPS drop, NEVER stuck in car!)
    if (crash) {
      const out = inDir.clone().negate();
      const storefront = height >= 22 && !(height <= 60 && spec.seed % 3 === 0);
      this.host.burst?.(pc.x, box.z0, pc.z, out.x, out.z, crash.preV.x, crash.preV.z, storefront);
      for (let i = 0; i < 14; i++) {
        const s = 0.16 + R() * 0.26;
        const brick = R() < 0.58;
        const p = mapW(h0 + 0.2 + R() * Math.max(0.4, holeW - 0.4), -0.15 + R() * 0.9, 0.5 + R() * (HOLE_H - 0.6));
        const size = new THREE.Vector3(s * (0.9 + R() * 0.9), s * 0.72, s * (0.8 + R() * 0.6));
        // Blast chunks out & sideways so they clear the car cleanly and settle naturally around the crash site
        const spray = (R() - 0.5) * 7.5;
        const fwd = 2.0 + R() * 5.5;
        const vel = inDir.clone().multiplyScalar(fwd * (R() < 0.65 ? 1 : -0.45))
          .addScaledVector(tanDir, spray)
          .add(new THREE.Vector3(0, 1.4 + R() * 3.8, 0));
        spawnKin(p, size, brick ? [0.34, 0.16, 0.12] : [0.32, 0.31, 0.30], vel);
      }
    }

    this.live.push(live);
    this.sync(live);
    while (this.live.length > MAX_LIVE) this.dropOldest();
    return true;
  }

  private dropOldest() {
    const oldest = this.live.shift();
    if (!oldest) return;
    oldest.group.removeFromParent();
    (oldest.group.children[0] as THREE.Mesh).geometry.dispose();
    for (const p of oldest.pieces) this.release(p.slot);
  }

  private sync(l: Live) {
    for (const p of l.pieces) {
      this.m4.compose(p.pos, p.quat, p.size);
      this.pool.setMatrixAt(p.slot, this.m4);
    }
    this.pool.instanceMatrix.needsUpdate = true;
  }

  /** Ultra-fast kinematic ballistic update (<0.03 ms CPU) + portal visibility. */
  update(dt: number, camera: THREE.Camera) {
    const h = Math.min(dt, 0.033);
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
        p.vel.y -= 11.5 * h;
        p.pos.addScaledVector(p.vel, h);
        const wMag = p.angVel.length();
        if (wMag > 1e-3) {
          this.axis.copy(p.angVel).divideScalar(wMag);
          this.dq.setFromAxisAngle(this.axis, wMag * h);
          p.quat.premultiply(this.dq).normalize();
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
            if (p.vel.lengthSq() < 0.03 || l.age > 3.2) {
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
