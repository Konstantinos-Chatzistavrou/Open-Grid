// Seamless widebody: the car's OWN body swells around each wheel arch - there is no added flare part, so there is no seam,
// no second paint and no gap. Every body mesh near an arch (fender, door edge, bumper corner, sill, wheel-well liner, and
// the fitted splitters / skirts / diffusers, which must stay flush with it) is moved outward by one smooth field:
//
//   u(x, y, z) = W * arch(y, z) * skin(x, y, z) * below(y)          (an outward push along x, in car model space)
//
//   arch   full over the arch lip, fading to 0 within `reach` m around it (smootherstep: no visible edge in the reflections)
//   skin   1 on the car's outer flanks (from 72 % of ITS half width out), 0 towards the centre line: the underside and the
//          middle of the car stretch instead of moving, so nothing tears open. (A mask sampled from the body's measured
//          side was tried first: its grid steps creased the doors.)
//   below  fades out just above the arch top, so the window line, glass and roof never move
//
// Adjacent panels sample the same field, so the panel gaps the model has stay exactly as wide as they were. Normals are
// corrected with the field's gradient (n' ~ n - grad(u) * n.x / (1 + du/dx)), so the light runs over the new shape the way
// it runs over a pressed panel. The positions are deformed from a copy of the originals, so switching kits never drifts.
// The models are quantized (integer positions under a scaled node): a deformed mesh gets plain float attributes at load,
// before the warm-up, so a kit change never changes a vertex layout (no pipeline compile in the garage).
import * as THREE from 'three/webgpu';
import type { BodyFit, FitWheel } from './fit';

export interface WidebodyP {
  /** outward push at the arch lip (m) */
  w: number;
  /** how far around the arch the swell fades out (m) */
  reach: number;
  /** also swell the sill between the arches (share of w): a full-length widebody side */
  sill?: number;
  /** rivet heads along the arch lip (bolt-on look; the panel itself stays one piece) */
  bolts?: boolean;
}

export const WIDEBODY: Record<string, WidebodyP> = {
  'fender-smooth': { w: 0.022, reach: 0.38 },
  'fender-plus': { w: 0.038, reach: 0.44 },
  'fender-wide': { w: 0.06, reach: 0.5 },
  'fender-bolt': { w: 0.07, reach: 0.52, bolts: true },
  'fender-race': { w: 0.086, reach: 0.58, sill: 0.38 },
  'fender-extreme': { w: 0.11, reach: 0.66, sill: 0.46, bolts: true },
};

/** wheel track spacer (m) that keeps the tyres filling the widened arches */
export const widebodyTrack = (p: WidebodyP | undefined) => (p ? Math.min(0.095, p.w * 0.85) : 0);

/** swells are combined as a p-norm, (a^p + b^p)^(1/p): exactly a where b is 0 (and continuous, with a zero slope, as b
 *  starts), smooth where they overlap. A plain max() left a crease where the arch and sill swells met: a highlight line
 *  across the door. p = 6 rounds that join like a fillet (at most 12 % fuller where both are equal). */
const P_NORM = 6;

const smoother = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

interface Entry {
  mesh: THREE.Mesh;
  pos0: Float32Array;
  nrm0: Float32Array | null;
  toModel: THREE.Matrix4;
  toLocal: THREE.Matrix4;
  nToModel: THREE.Matrix3;
  nToLocal: THREE.Matrix3;
  /** per vertex: the longest edge touching it (m, model space): how coarse the mesh is there */
  edge: Float32Array;
}

/** a float copy of an attribute (quantized / normalized / interleaved in, plain Float32 out) */
function floatCopy(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const n = a.count, k = a.itemSize, out = new Float32Array(n * k);
  // getX..getW denormalize (normalized integer attributes) and read through interleaving
  for (let i = 0; i < n; i++) {
    out[i * k] = a.getX(i);
    if (k > 1) out[i * k + 1] = a.getY(i);
    if (k > 2) out[i * k + 2] = a.getZ(i);
    if (k > 3) out[i * k + 3] = a.getW(i);
  }
  return out;
}

export class WidebodyDeformer {
  private entries: Entry[] = [];
  private wheels: (FitWheel & { s: 1 | -1 })[];
  /** front / rear axle z per side, for the sill bridge */
  private zFront: number;
  private zRear: number;
  private axleY: number;
  /** the body's half width (BodyFit box), for the lateral mask */
  private hw: number;
  private p: WidebodyP | null = null;
  private applied = '';

  constructor(private fit: BodyFit) {
    this.wheels = fit.wheels.map((w) => ({ ...w, s: (w.x >= 0 ? 1 : -1) as 1 | -1 }));
    const zs = fit.wheels.map((w) => w.z);
    this.zFront = zs.length ? Math.max(...zs) : 1.4;
    this.zRear = zs.length ? Math.min(...zs) : -1.4;
    this.axleY = fit.wheels.length ? fit.wheels.reduce((a, w) => a + w.y, 0) / fit.wheels.length : 0.33;
    this.hw = Math.max(0.6, Math.max(Math.abs(fit.box.min.x), Math.abs(fit.box.max.x)));
  }

  /**
   * Collect the meshes the field can reach and give them their own float position / normal attributes (a geometry shared
   * with another car of the same model must not swell with this one). Call once, after the car's draw-call merge and
   * before the load-time warm-up. include(mesh): body, not wheels / interior / driver / wings.
   */
  prepare(model: THREE.Object3D, include: (m: THREE.Mesh) => boolean) {
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert(), box = new THREE.Box3();
    const reachX = Math.max(0.3, (this.fit.box.max.x - this.fit.box.min.x) / 2 * 0.45);   // nothing nearer the centre line moves
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.attributes.position || (m as THREE.SkinnedMesh).isSkinnedMesh || !include(m)) return;
      const toModel = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.copy(m.geometry.boundingBox!).applyMatrix4(toModel);
      if (Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) < reachX) return;   // a centre part: the field is 0 there
      const g = m.geometry.clone();
      const pos0 = floatCopy(g.attributes.position as THREE.BufferAttribute);
      g.setAttribute('position', new THREE.BufferAttribute(pos0.slice(), 3));
      let nrm0: Float32Array | null = null;
      if (g.attributes.normal) { nrm0 = floatCopy(g.attributes.normal as THREE.BufferAttribute); g.setAttribute('normal', new THREE.BufferAttribute(nrm0.slice(), 3)); }
      m.geometry = g;
      const nToModel = new THREE.Matrix3().getNormalMatrix(toModel);
      // the longest edge at each vertex (model space): on a coarse panel the corrected normals step from triangle to triangle
      const n = pos0.length / 3, edge = new Float32Array(n), idx = g.index ? (g.index.array as ArrayLike<number>) : null;
      const sc = new THREE.Vector3().setFromMatrixScale(toModel), ss = Math.max(sc.x, sc.y, sc.z);
      const tri = (a: number, b: number) => {
        const L = Math.hypot(pos0[a * 3] - pos0[b * 3], pos0[a * 3 + 1] - pos0[b * 3 + 1], pos0[a * 3 + 2] - pos0[b * 3 + 2]) * ss;
        if (L > edge[a]) edge[a] = L;
        if (L > edge[b]) edge[b] = L;
      };
      const T = idx ? idx.length : n;
      for (let t = 0; t + 2 < T; t += 3) {
        const a0 = idx ? idx[t] : t, a1 = idx ? idx[t + 1] : t + 1, a2 = idx ? idx[t + 2] : t + 2;
        tri(a0, a1); tri(a1, a2); tri(a2, a0);
      }
      this.entries.push({ mesh: m, pos0, nrm0, toModel, toLocal: toModel.clone().invert(), nToModel, nToLocal: nToModel.clone().invert(), edge });
    });
  }

  /** the swell's shape at (y, z) on one side, 0..1: smooth by construction (analytic falloffs only) */
  private shape(s: 1 | -1, y: number, z: number): number {
    const p = this.p!;
    let acc = 0;
    const add = (v: number) => { if (v > 0) acc += v ** P_NORM; };
    for (const w of this.wheels) {
      if (w.s !== s) continue;
      const d = Math.hypot(y - w.y, z - w.z), core = w.r + 0.07;
      const arch = 1 - smoother(core, core + p.reach, d);
      if (arch <= 0) continue;
      add(arch * (1 - smoother(w.y + w.r + 0.02, w.y + w.r + 0.38, y)));
    }
    if (p.sill) {
      // between the arches, below the axle line: the side skirts out so the two arches read as one widened body
      // long, gentle transitions: a hero model's door is a few large triangles, and a bend packed into one of them shows as a
      // jagged highlight; spread over ~0.5 m it reads as a pressed panel
      const span = smoother(this.zRear - 0.1, this.zRear + 0.85, z) * (1 - smoother(this.zFront - 0.85, this.zFront + 0.1, z));
      add(p.sill * span * (1 - smoother(this.axleY - 0.15, this.axleY + 0.45, y)));
    }
    return acc <= 0 ? 0 : Math.min(1, acc ** (1 / P_NORM));
  }

  /** 1 on the car's outer flanks, 0 towards the centre line: a smooth mask (no sampled data, so no creases) */
  private skin(ax: number): number { return smoother(this.hw * 0.42, this.hw * 0.72, ax); }

  /** the outward push (signed: +x on the left side, -x on the right) at a model-space point */
  field(x: number, y: number, z: number): number {
    if (!this.p) return 0;
    const s: 1 | -1 = x >= 0 ? 1 : -1, sh = this.shape(s, y, z);
    return sh > 0 ? s * this.p.w * sh * this.skin(Math.abs(x)) : 0;
  }

  /** Deform every collected mesh for kit p (null: stock). Cheap enough for a garage click (tens of ms, once). */
  apply(p: WidebodyP | null) {
    const key = p ? `${p.w}:${p.reach}:${p.sill ?? 0}` : '';
    if (key === this.applied) return;
    this.applied = key;
    this.p = p;
    const v = new THREE.Vector3(), n = new THREE.Vector3(), h = 0.004;
    for (const e of this.entries) {
      const pa = e.mesh.geometry.attributes.position as THREE.BufferAttribute, P = pa.array as Float32Array;
      const na = e.mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined, N = na ? (na.array as Float32Array) : null;
      const count = pa.count;
      let moved = false;
      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        if (!p) { P[i3] = e.pos0[i3]; P[i3 + 1] = e.pos0[i3 + 1]; P[i3 + 2] = e.pos0[i3 + 2]; if (N && e.nrm0) { N[i3] = e.nrm0[i3]; N[i3 + 1] = e.nrm0[i3 + 1]; N[i3 + 2] = e.nrm0[i3 + 2]; } continue; }
        v.set(e.pos0[i3], e.pos0[i3 + 1], e.pos0[i3 + 2]).applyMatrix4(e.toModel);
        const u = this.field(v.x, v.y, v.z);
        if (u === 0) {
          P[i3] = e.pos0[i3]; P[i3 + 1] = e.pos0[i3 + 1]; P[i3 + 2] = e.pos0[i3 + 2];
          if (N && e.nrm0) { N[i3] = e.nrm0[i3]; N[i3 + 1] = e.nrm0[i3 + 1]; N[i3 + 2] = e.nrm0[i3 + 2]; }
          continue;
        }
        moved = true;
        if (N && e.nrm0) {
          // gradient of u (forward differences, 4 mm: every term is an analytic smootherstep, so it is smooth). The lateral
          // slope only scales the correction by 1 / (1 + du/dx) on the flanks, where the mask is flat: left out (2 field
          // evaluations per vertex instead of 6: a kit click on a 270k-vertex body went from ~200 ms to well under 100)
          const ux = 0;
          const uy = (this.field(v.x, v.y + h, v.z) - u) / h;
          const uz = (this.field(v.x, v.y, v.z + h) - u) / h;
          n.set(e.nrm0[i3], e.nrm0[i3 + 1], e.nrm0[i3 + 2]).applyMatrix3(e.nToModel).normalize();
          // the full correction where the mesh is fine enough to show the new curvature; none on large flat triangles (a
          // door made of a few of them showed the corrected normals as jagged highlights: there it keeps its own shading)
          const k = (n.x / Math.max(0.2, 1 + ux)) * (1 - smoother(0.07, 0.2, e.edge[i]));
          n.set(n.x - ux * k, n.y - uy * k, n.z - uz * k).normalize().applyMatrix3(e.nToLocal).normalize();
          N[i3] = n.x; N[i3 + 1] = n.y; N[i3 + 2] = n.z;
        }
        v.x += u;
        v.applyMatrix4(e.toLocal);
        P[i3] = v.x; P[i3 + 1] = v.y; P[i3 + 2] = v.z;
      }
      pa.needsUpdate = true;
      if (na) na.needsUpdate = true;
      if (moved || !p) { e.mesh.geometry.computeBoundingSphere(); e.mesh.geometry.computeBoundingBox(); }
    }
  }

  /** meshes / vertices the field can reach, and how many vertices the current kit moved (garage checks, tests) */
  stats() {
    let verts = 0, moved = 0;
    for (const e of this.entries) {
      const P = e.mesh.geometry.attributes.position.array as Float32Array;
      verts += e.pos0.length / 3;
      for (let i = 0; i < e.pos0.length; i += 3) if (Math.abs(P[i] - e.pos0[i]) + Math.abs(P[i + 1] - e.pos0[i + 1]) + Math.abs(P[i + 2] - e.pos0[i + 2]) > 1e-5) moved++;
    }
    return { meshes: this.entries.length, verts, moved, names: this.entries.map((e) => e.mesh.name).slice(0, 40) };
  }

  /** rivet anchors along each arch lip, on the deformed surface: [x, y, z, side] */
  rivetPoints(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [];
    for (const w of this.wheels) {
      const rho = w.r + 0.085;
      for (let k = 0; k < 9; k++) {
        const a = -1.25 + (2.5 * k) / 8;   // from behind the wheel over the top to in front of it
        const y = w.y + rho * Math.cos(a), z = w.z + rho * Math.sin(a);
        if (y < this.fit.ground + 0.12) continue;
        const sx = this.fit.bodySideAt(y, z, w.s);
        const x = w.s * sx;
        out.push([x + this.field(x, y, z), y, z, w.s]);
      }
    }
    return out;
  }
}
