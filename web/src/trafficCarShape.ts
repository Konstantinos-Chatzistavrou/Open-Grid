// Apache-2.0 - the shape of a background traffic car (cityTraffic.ts): a lofted low-poly saloon, about 180 triangles, as plain arrays so it can be tested without three.js.
// Two meshes share the instance transforms: the BODY (paint takes the instance colour; glass, tyres and the underside are near black so the tint does not show on them) and the LIGHTS
// (head and tail lights, not tinted, brightened at night). Units: metres; +x forward, +y up, +z the car's right-hand side; base size 4.5 x 1.45 x 1.82, scaled per instance.
export interface ShapeArrays { position: Float32Array; normal: Float32Array; color: Float32Array }
export const BASE_LENGTH = 4.5;
export const BASE_WIDTH = 1.82;
export const BASE_HEIGHT = 1.45;

// stations along the car: x, bottom y, belt line y, roof y, half width at the belt, half width at the roof
const ST: number[][] = [
  [-2.25, 0.30, 0.78, 0.78, 0.84, 0.80],   // 0 rear face
  [-2.10, 0.26, 0.92, 0.92, 0.90, 0.86],   // 1 tail
  [-1.55, 0.24, 0.98, 0.98, 0.91, 0.86],   // 2 boot lid
  [-1.15, 0.24, 0.98, 1.38, 0.91, 0.70],   // 3 foot of the rear window (the roof starts)
  [-0.30, 0.24, 0.98, 1.45, 0.91, 0.72],   // 4 roof
  [0.35, 0.24, 0.98, 1.43, 0.91, 0.72],    // 5 roof end
  [1.20, 0.24, 0.98, 0.98, 0.91, 0.86],    // 6 foot of the windscreen
  [1.85, 0.26, 0.90, 0.90, 0.90, 0.86],    // 7 bonnet
  [2.25, 0.30, 0.70, 0.70, 0.84, 0.80],    // 8 front face
];
const GLASS_SIDE = new Set([2, 3, 4, 5]);   // station pairs (i, i+1) whose side faces are windows
const GLASS_TOP = new Set([2, 5]);          // pairs whose top face is the rear window / the windscreen
const BODY: [number, number, number] = [1, 1, 1];
const GLASS: [number, number, number] = [0.045, 0.055, 0.07];
const DARK: [number, number, number] = [0.025, 0.025, 0.028];
const GRILLE: [number, number, number] = [0.06, 0.06, 0.07];

class Builder {
  p: number[] = []; n: number[] = []; c: number[] = [];
  /** a triangle whose normal is made to point away from `inside` */
  tri(a: number[], b: number[], c: number[], col: number[], inside: number[]) {
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const cx = (a[0] + b[0] + c[0]) / 3 - inside[0], cy = (a[1] + b[1] + c[1]) / 3 - inside[1], cz = (a[2] + b[2] + c[2]) / 3 - inside[2];
    if (nx * cx + ny * cy + nz * cz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    for (const q of [a, b, c]) { this.p.push(q[0], q[1], q[2]); this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); }
  }
  quad(a: number[], b: number[], c: number[], d: number[], col: number[], inside: number[]) { this.tri(a, b, c, col, inside); this.tri(a, c, d, col, inside); }
  out(): ShapeArrays { return { position: Float32Array.from(this.p), normal: Float32Array.from(this.n), color: Float32Array.from(this.c) }; }
}

/** the six cross-section points of a station, left (z < 0) to right */
function ring(s: number[]): number[][] {
  const [x, yb, ybelt, yroof, hwB, hwR] = s;
  return [[x, yb, -hwB], [x, ybelt, -hwB], [x, yroof, -hwR], [x, yroof, hwR], [x, ybelt, hwB], [x, yb, hwB]];
}

function wheel(b: Builder, x: number, z: number) {
  const R = 0.32, W = 0.22, N = 6, y = R;
  const inside = [x, y, z];
  for (let i = 0; i < N; i++) {
    // the polygon is turned by 30 degrees so one corner points straight down and the tyre stands on the ground
    const a0 = ((i + 0.5) / N) * Math.PI * 2, a1 = ((i + 1.5) / N) * Math.PI * 2;
    const p = (a: number, dz: number) => [x + Math.cos(a) * R, y + Math.sin(a) * R, z + dz];
    const z0 = z - W / 2, z1 = z + W / 2;
    b.quad(p(a0, z0 - z), p(a1, z0 - z), p(a1, z1 - z), p(a0, z1 - z), DARK, inside);
    b.tri([x, y, z1], p(a0, z1 - z), p(a1, z1 - z), DARK, inside);
    b.tri([x, y, z0], p(a0, z0 - z), p(a1, z0 - z), DARK, inside);
  }
}

export function buildCarBody(): ShapeArrays {
  const b = new Builder();
  const centre = [0, 0.8, 0];
  const rings = ST.map(ring);
  for (let i = 0; i + 1 < ST.length; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let e = 0; e < 5; e++) {
      // edges: 0 lower left side, 1 left side glass line, 2 top, 3 right glass line, 4 lower right side
      const col = e === 1 || e === 3 ? (GLASS_SIDE.has(i) ? GLASS : BODY) : e === 2 ? (GLASS_TOP.has(i) ? GLASS : BODY) : BODY;
      b.quad(A[e], A[e + 1], B[e + 1], B[e], col, centre);
    }
    b.quad(A[5], A[0], B[0], B[5], DARK, centre);   // underside
  }
  // front and rear faces
  for (const [k, col] of [[0, BODY], [ST.length - 1, GRILLE]] as [number, number[]][]) {
    const R = rings[k];
    for (let j = 1; j + 1 < R.length; j++) b.tri(R[0], R[j], R[j + 1], col, centre);
  }
  for (const x of [-1.42, 1.38]) for (const s of [-1, 1]) wheel(b, x, s * 0.80);
  return b.out();
}

/** Head lights (white) on the front face, tail lights (red) on the rear one. Colours above 1 on purpose: the night glow multiplies them. */
export function buildCarLights(): ShapeArrays {
  const b = new Builder();
  const front = ST[ST.length - 1][0] + 0.004, rear = ST[0][0] - 0.004;
  const add = (x: number, z: number, y: number, w: number, h: number, col: number[], dir: number) => {
    const q = (dz: number, dy: number) => [x, y + dy, z + dz];
    b.quad(q(-w / 2, -h / 2), q(w / 2, -h / 2), q(w / 2, h / 2), q(-w / 2, h / 2), col, [x - dir, y, z]);
  };
  for (const s of [-1, 1]) {
    add(front, s * 0.58, 0.55, 0.36, 0.12, [1, 0.96, 0.82], 1);
    add(rear, s * 0.62, 0.64, 0.42, 0.10, [1, 0.06, 0.04], -1);
  }
  return b.out();
}
