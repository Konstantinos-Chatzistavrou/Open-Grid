// Apache-2.0 - the street graph of a city as directed lanes, for the traffic and pedestrian simulations (trafficSim.ts). Pure: no three.js, no DOM, so it runs in Node tests.
//
// Input: a city's map.json (tools/nyc/build_index.py): `nodes` [x, y] in metres (x east, y north) and `edges` { a, b, w (width m), hw (OpenStreetMap highway class), oneway?, pts? (the road's
// intermediate points, NOT its end junctions), ms (posted limit, km/h) }. A one-way edge runs from a to b. Each edge becomes one directed arc (one-way) or two (two-way), each with its own polyline.
// Output: arcs with lengths, headings and limits; the outgoing arcs of every junction; a hash grid to find arcs near a point.

export interface RawEdge { a: number; b: number; w: number; hw: string; len?: number; oneway?: boolean; pts?: number[][]; ms?: number; name?: string }
export interface RawGraph { nodes: number[][]; edges: RawEdge[] }

/** Cities where traffic drives on the left. Every other city in the game drives on the right. */
export const LEFT_HAND_CITIES: ReadonlySet<string> = new Set(['london', 'tokyo', 'melbourne', 'singapore']);
export const drivesOnLeft = (cityId: string): boolean => LEFT_HAND_CITIES.has(cityId);

/** road class: 0 local, 1 collector (secondary / tertiary), 2 arterial (primary), 3 highway (trunk / motorway); the same split as the minimap's */
const CLS: Record<string, number> = {
  living_street: 0, residential: 0, unclassified: 0, service: 0, road: 0,
  tertiary: 1, tertiary_link: 1, secondary: 1, secondary_link: 1,
  primary: 2, primary_link: 2,
  trunk: 3, trunk_link: 3, motorway: 3, motorway_link: 3,
};
const DEFAULT_LIMIT_KMH = [30, 50, 60, 100];

export interface Arc {
  id: number;
  from: number;
  to: number;
  edge: number;
  /** the arc running the other way on the same road, or -1 on a one-way road */
  rev: number;
  oneway: boolean;
  len: number;
  /** road width (m) */
  w: number;
  cls: number;
  /** posted limit (m/s) */
  limit: number;
  /** polyline in the direction of travel: x0, y0, x1, y1, ... */
  pts: Float64Array;
  /** distance along the arc at each polyline point */
  cum: Float64Array;
  /** heading (rad, from +x towards +y) at the start and at the end */
  h0: number;
  h1: number;
}

export interface Pose { x: number; y: number; h: number }

export class RoadGraph {
  readonly nodeX: Float64Array;
  readonly nodeY: Float64Array;
  readonly arcs: Arc[] = [];
  /** outgoing arc ids of each junction */
  readonly out: number[][];
  /** how many roads meet at each junction (arcs in and out counted once per road) */
  readonly degree: Uint8Array;
  private readonly cell = 100;
  private readonly grid = new Map<number, number[]>();

  constructor(raw: RawGraph) {
    const n = raw.nodes.length;
    this.nodeX = new Float64Array(n);
    this.nodeY = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.nodeX[i] = raw.nodes[i][0]; this.nodeY[i] = raw.nodes[i][1]; }
    this.out = Array.from({ length: n }, () => []);
    this.degree = new Uint8Array(n);
    raw.edges.forEach((e, ei) => {
      if (!(e.a >= 0 && e.a < n && e.b >= 0 && e.b < n) || e.a === e.b) return;
      this.degree[e.a] = Math.min(255, this.degree[e.a] + 1);
      this.degree[e.b] = Math.min(255, this.degree[e.b] + 1);
      // the road's shape: junction a, its intermediate points, junction b (points that repeat an end junction are dropped)
      const shape: number[] = [this.nodeX[e.a], this.nodeY[e.a]];
      for (const p of e.pts ?? []) {
        const dx = p[0] - shape[shape.length - 2], dy = p[1] - shape[shape.length - 1];
        if (dx * dx + dy * dy > 0.25) shape.push(p[0], p[1]);
      }
      const lx = this.nodeX[e.b] - shape[shape.length - 2], ly = this.nodeY[e.b] - shape[shape.length - 1];
      if (lx * lx + ly * ly > 0.25 || shape.length === 2) shape.push(this.nodeX[e.b], this.nodeY[e.b]);
      else { shape[shape.length - 2] = this.nodeX[e.b]; shape[shape.length - 1] = this.nodeY[e.b]; }
      const cls = CLS[e.hw] ?? 0;
      const limit = (e.ms && e.ms > 0 ? e.ms : DEFAULT_LIMIT_KMH[cls]) / 3.6;
      const fwd = this.addArc(e.a, e.b, ei, Float64Array.from(shape), e.w || 6, cls, limit, !!e.oneway);
      if (!e.oneway) {
        const rev = new Float64Array(shape.length);
        for (let i = 0; i < shape.length; i += 2) { rev[i] = shape[shape.length - 2 - i]; rev[i + 1] = shape[shape.length - 1 - i]; }
        const back = this.addArc(e.b, e.a, ei, rev, e.w || 6, cls, limit, false);
        this.arcs[fwd].rev = back;
        this.arcs[back].rev = fwd;
      }
    });
    for (const a of this.arcs) {
      // register an arc in every grid cell its polyline passes through: walk each segment in steps of half a cell, so a long straight road with only two shape points is found in the cells between them too
      const seen = new Set<number>();
      const mark = (x: number, y: number) => {
        const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
        if (!seen.has(k)) { seen.add(k); (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(a.id); }
      };
      for (let i = 0; i + 3 < a.pts.length + 2; i += 2) {
        const x0 = a.pts[i], y0 = a.pts[i + 1];
        mark(x0, y0);
        if (i + 3 >= a.pts.length) break;
        const dx = a.pts[i + 2] - x0, dy = a.pts[i + 3] - y0;
        const n = Math.ceil(Math.hypot(dx, dy) / (this.cell / 2));
        for (let k = 1; k <= n; k++) mark(x0 + (dx * k) / n, y0 + (dy * k) / n);
      }
    }
  }

  private key(cx: number, cy: number): number { return (cx + 32768) * 65536 + (cy + 32768); }

  private addArc(from: number, to: number, edge: number, pts: Float64Array, w: number, cls: number, limit: number, oneway: boolean): number {
    const m = pts.length / 2;
    const cum = new Float64Array(m);
    for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    const id = this.arcs.length;
    const arc: Arc = {
      id, from, to, edge, rev: -1, oneway, len: cum[m - 1], w, cls, limit, pts, cum,
      h0: Math.atan2(pts[3] - pts[1], pts[2] - pts[0]), h1: Math.atan2(pts[2 * m - 1] - pts[2 * m - 3], pts[2 * m - 2] - pts[2 * m - 4]),
    };
    this.arcs.push(arc);
    this.out[from].push(id);
    return id;
  }

  /** The point `s` metres along `arc` and the heading there. */
  poseAt(arc: Arc, s: number, out: Pose = { x: 0, y: 0, h: 0 }): Pose {
    const c = arc.cum, p = arc.pts;
    const t = Math.max(0, Math.min(arc.len, s));
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= t) lo = mid; else hi = mid; }
    const seg = Math.max(1e-9, c[hi] - c[lo]), f = (t - c[lo]) / seg;
    out.x = p[2 * lo] + (p[2 * hi] - p[2 * lo]) * f;
    out.y = p[2 * lo + 1] + (p[2 * hi + 1] - p[2 * lo + 1]) * f;
    out.h = Math.atan2(p[2 * hi + 1] - p[2 * lo + 1], p[2 * hi] - p[2 * lo]);
    return out;
  }

  /** Ids of the arcs with part of their shape within about `r` + 25 metres of (x, y) (a superset: the caller filters by distance). */
  arcsNear(x: number, y: number, r: number): number[] {
    const out = new Set<number>();
    // roads are registered at samples at most half a cell apart, so any point of a road is within a quarter of a cell of a registered one: widen the window by that much
    const m = r + this.cell / 4;
    const c0 = Math.floor((x - m) / this.cell), c1 = Math.floor((x + m) / this.cell), d0 = Math.floor((y - m) / this.cell), d1 = Math.floor((y + m) / this.cell);
    for (let cx = c0; cx <= c1; cx++) for (let cy = d0; cy <= d1; cy++) for (const id of this.grid.get(this.key(cx, cy)) ?? []) out.add(id);
    return [...out];
  }

  /** The arc nearest to (x, y) within `maxDist` metres (or null) and the distance along it. Used to place a person or a car on the street graph. */
  nearestArc(x: number, y: number, maxDist = 60): { arc: Arc; s: number; dist: number } | null {
    let best: { arc: Arc; s: number; dist: number } | null = null;
    for (const id of this.arcsNear(x, y, maxDist)) {
      const a = this.arcs[id];
      for (let i = 0; i + 1 < a.cum.length; i++) {
        const x0 = a.pts[2 * i], y0 = a.pts[2 * i + 1], x1 = a.pts[2 * i + 2], y1 = a.pts[2 * i + 3];
        const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
        const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
        const d = Math.hypot(x - (x0 + dx * f), y - (y0 + dy * f));
        if (d <= maxDist && (!best || d < best.dist)) best = { arc: a, s: a.cum[i] + f * Math.sqrt(l2), dist: d };
      }
    }
    return best;
  }
}

/** The signed turn (rad, + = left) from the end heading of `from` to the start heading of `to`, wrapped to (-pi, pi]. */
export function turnAngle(from: Arc, to: Arc): number {
  let d = to.h0 - from.h1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
