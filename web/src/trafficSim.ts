// Apache-2.0 - background city traffic: cheap cars that drive the street graph (roadGraph.ts). Pure (no three.js, no DOM): it only moves points, so it runs in Node tests, and a renderer draws the points
// (cityTraffic.ts, one instanced mesh for all of them). The detailed rival cars of the race are a different, expensive thing (ai.ts).
//
// What a car does: it drives on the right (or the left: LHT cities) of its road, at the posted limit scaled by its own temperament, follows the car in front with the Intelligent Driver Model, slows for turns,
// takes junctions one at a time (a junction is reserved by the first car to reach it, the others wait at the stop line), never turns back on itself except at a dead end, and stops for the player
// when the player is in its lane. It appears 150 to 300 m from the player and goes away beyond 380 m, so the count the tier asks for is always the count around the player.
// What it does not do: traffic lights, lane changes inside a road, overtaking, parking, or reacting to other things than cars and the player.
import { RoadGraph, turnAngle, type Arc, type Pose } from './roadGraph';

export interface TrafficOptions {
  count: number;
  seed?: number;
  leftHand?: boolean;
  /** cars appear between these distances from the player (m) */
  spawnMin?: number;
  spawnMax?: number;
  /** and are removed beyond this one */
  despawnR?: number;
}
export interface PlayerState { x: number; y: number; vx: number; vy: number }

/** body styles: hatchback, saloon, van (length, width in m) and how common each is */
export const CAR_KINDS = [
  { length: 4.2, width: 1.78, share: 0.40 },
  { length: 4.8, width: 1.86, share: 0.45 },
  { length: 5.7, width: 2.05, share: 0.15 },
] as const;
export const CAR_COLORS = 8;

export interface TrafficAgent {
  id: number;
  arc: Arc;
  /** distance of the FRONT bumper along the arc (m) */
  s: number;
  v: number;
  vDes: number;
  /** how close to the limit this driver drives (0.82 .. 1.10): a fixed trait */
  temper: number;
  /** -1, 0, +1: the lane on a wide one-way road, 0 everywhere else */
  lane: number;
  kind: number;
  color: number;
  length: number;
  width: number;
  nextArc: Arc | null;
  /** pose of the car's centre in the world (x east, y north), heading from +x towards +y */
  x: number; y: number; h: number;
  /** lateral offset to the right of the road's centre line (m) and the heading the car had when it entered this arc: the pose blends from these over the first 10 m */
  off: number; prevOff: number; prevH: number;
  stalled: number;
  /** seconds this car stays stopped after the player hit it */
  hold: number;
  /** junction node this car holds the reservation of, or -1 */
  reserved: number;
  remove: boolean;
}

const IDM = { a: 1.8, b: 2.6, T: 1.4, s0: 2.5 };
const BLEND = 10;          // m over which the pose changes from the old road's lane to the new one's
const LOOKAHEAD = 90;      // m: how far a car looks for a leader on the next road
const BRAKE_PLAN = 2.2;       // m/s^2 a driver plans to brake at when anticipating a lower speed
const STALL_LIMIT = 30;    // s without moving before a car is replaced (a dead end, a jam, or a deadlock)

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/** Acceleration of the Intelligent Driver Model: free road term and the interaction with a leader `gap` metres ahead closing at `dv` m/s. */
export function idmAccel(v: number, vDes: number, gap: number, dv: number): number {
  const free = 1 - Math.pow(v / Math.max(vDes, 0.1), 4);
  if (!(gap < 1e8)) return IDM.a * free;
  const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
  return IDM.a * (free - (sStar / Math.max(gap, 0.1)) ** 2);
}

export class TrafficSim {
  readonly agents: TrafficAgent[] = [];
  readonly stats = { spawned: 0, removed: 0, stalledRemoved: 0, junctionWaits: 0, spawnNoRing: 0, spawnNoPoint: 0, spawnNoSpace: 0 };
  private rng: () => number;
  private nextId = 1;
  private target: number;
  private readonly leftHand: boolean;
  private readonly spawnMin: number;
  private readonly spawnMax: number;
  private readonly despawnR: number;
  private readonly holders = new Map<number, TrafficAgent>();
  private readonly pose: Pose = { x: 0, y: 0, h: 0 };

  constructor(readonly graph: RoadGraph, opt: TrafficOptions) {
    this.rng = mulberry32(opt.seed ?? 1);
    this.target = opt.count;
    this.leftHand = !!opt.leftHand;
    this.spawnMin = opt.spawnMin ?? 150;
    this.spawnMax = opt.spawnMax ?? 300;
    this.despawnR = opt.despawnR ?? 380;
  }

  get count(): number { return this.target; }

  /** Change the target number of cars (a tier change). Extra cars are removed farthest first by the next update. */
  setCount(n: number) { this.target = Math.max(0, Math.floor(n)); }

  /** Drop everything and fill the target count around the player at once (a new session, or after the player moved far). */
  reset(player: PlayerState) {
    this.agents.length = 0;
    this.holders.clear();
    for (let i = 0; i < this.target * 4 && this.agents.length < this.target; i++) this.trySpawn(player);
  }

  // ------------------------------------------------------------------------------------------------ lanes

  /** Lateral offset (m) of a lane to the RIGHT of the road's centre line. */
  laneOffset(arc: Arc, lane: number): number {
    if (arc.oneway) return arc.w >= 7.5 ? lane * arc.w * 0.25 : 0;
    const off = clamp(arc.w * 0.25, 1.4, 3.2);
    return this.leftHand ? -off : off;
  }

  private chooseLane(arc: Arc): number {
    return arc.oneway && arc.w >= 7.5 ? (this.rng() < 0.5 ? -1 : 1) : 0;
  }

  /** The road a car takes after `arc`: not the way it came unless it is a dead end, straight ahead preferred, never onto a road it may not enter. */
  private pickNext(arc: Arc): Arc | null {
    const outs = this.graph.out[arc.to];
    const cand: Arc[] = [];
    for (const id of outs) if (id !== arc.rev) cand.push(this.graph.arcs[id]);
    if (!cand.length) return arc.rev >= 0 ? this.graph.arcs[arc.rev] : null;
    let total = 0;
    const w = cand.map((c) => { const t = turnAngle(arc, c); const x = Math.exp(-((Math.abs(t) / (Math.PI / 3)) ** 2)) * (c.cls >= arc.cls ? 1.4 : 1) + 0.02; total += x; return x; });
    let r = this.rng() * total;
    for (let i = 0; i < cand.length; i++) { r -= w[i]; if (r <= 0) return cand[i]; }
    return cand[cand.length - 1];
  }

  // ------------------------------------------------------------------------------------------------ spawning

  private trySpawn(player: PlayerState): boolean {
    // the arcs that pass through the spawn ring (judged by their two ends and their middle), bigger roads counting more
    const ring: Arc[] = [];
    for (const id of this.graph.arcsNear(player.x, player.y, this.spawnMax + 60)) {
      const arc = this.graph.arcs[id];
      if (arc.len < 18) continue;
      let lo = Infinity, hi = 0;
      for (const f of [0, 0.5, 1]) { const q = this.graph.poseAt(arc, arc.len * f, this.pose); const d = Math.hypot(q.x - player.x, q.y - player.y); lo = Math.min(lo, d); hi = Math.max(hi, d); }
      if (hi >= this.spawnMin && lo <= this.spawnMax) for (let k = 0; k <= arc.cls; k++) ring.push(arc);
    }
    if (!ring.length) { this.stats.spawnNoRing++; return false; }
    for (let attempt = 0; attempt < 16; attempt++) {
      const arc = ring[Math.floor(this.rng() * ring.length)];
      // a point on the road inside the ring: the road is sampled every ~10 m (a long road crosses the ring only in part) and one of the samples in the ring is picked at random
      const K = Math.min(80, Math.max(4, Math.ceil(arc.len / 10)));
      const inRing: number[] = [];
      for (let k = 0; k < K; k++) {
        const t = arc.len * (0.1 + (0.8 * (k + 0.5)) / K);
        const q = this.graph.poseAt(arc, t - 2, this.pose);
        const d = Math.hypot(q.x - player.x, q.y - player.y);
        if (d >= this.spawnMin && d <= this.spawnMax) inRing.push(t);
      }
      if (!inRing.length) { this.stats.spawnNoPoint++; continue; }
      const s = inRing[Math.floor(this.rng() * inRing.length)];
      const p = this.graph.poseAt(arc, s - 2, this.pose);
      const lane = this.chooseLane(arc);
      let kind = 0;
      { let r = this.rng(); for (let i = 0; i < CAR_KINDS.length; i++) { r -= CAR_KINDS[i].share; if (r <= 0) { kind = i; break; } } }
      const spec = CAR_KINDS[kind];
      if (this.agents.some((o) => o.arc === arc && o.lane === lane && Math.abs(o.s - s) < o.length + spec.length + 14)) { this.stats.spawnNoSpace++; continue; }
      const temper = 0.82 + 0.28 * this.rng();
      const vDes = arc.limit * temper;
      const a: TrafficAgent = {
        id: this.nextId++, arc, s, v: vDes * 0.7, vDes, temper, lane, kind, color: Math.floor(this.rng() * CAR_COLORS), length: spec.length, width: spec.width,
        nextArc: null, x: p.x, y: p.y, h: p.h, off: this.laneOffset(arc, lane), prevOff: this.laneOffset(arc, lane), prevH: p.h, stalled: 0, hold: 0, reserved: -1, remove: false,
      };
      a.nextArc = this.pickNext(arc);
      this.agents.push(a);
      this.placePose(a);
      this.stats.spawned++;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------------ update

  update(dt: number, player: PlayerState) {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.25);
    // cars by road, rear to front
    const byArc = new Map<number, TrafficAgent[]>();
    for (const a of this.agents) { const l = byArc.get(a.arc.id); if (l) l.push(a); else byArc.set(a.arc.id, [a]); }
    for (const l of byArc.values()) l.sort((p, q) => p.s - q.s);

    const accel: number[] = new Array(this.agents.length);
    const limitS: number[] = new Array(this.agents.length);
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      let gap = Infinity, dv = 0, hardS = Infinity;
      const distEnd = a.arc.len - a.s;
      // the car in front on this road, in my lane
      const row = byArc.get(a.arc.id)!;
      for (let k = row.indexOf(a) + 1; k < row.length; k++) {
        const o = row[k];
        if (o.lane !== a.lane) continue;
        gap = o.s - o.length - a.s; dv = a.v - o.v; hardS = o.s - o.length - 0.3;
        break;
      }
      // or the last car of the road I am about to take
      if (gap === Infinity && a.nextArc && distEnd < LOOKAHEAD) {
        const nrow = byArc.get(a.nextArc.id);
        if (nrow) {
          const o = nrow.find((x) => x.s - x.length > -2 && (x.lane === a.lane || !a.nextArc!.oneway || a.nextArc!.w < 7.5)) ?? nrow[0];
          const g = distEnd + o.s - o.length;
          if (g < LOOKAHEAD) { gap = g; dv = a.v - o.v; hardS = a.arc.len + o.s - o.length - 0.3; }
        }
      }
      // a junction is entered by one car at a time
      const node = a.arc.to;
      if (a.nextArc && distEnd < 14 && this.graph.degree[node] >= 3 && a.reserved !== node) {
        const h = this.holders.get(node);
        if (!h || h === a || h.remove || !this.agents.includes(h)) { this.holders.set(node, a); a.reserved = node; }
        else {
          const g = distEnd - 1.5;
          if (g < gap) { gap = Math.max(g, 0.05); dv = a.v; hardS = a.arc.len - 1.0; }
          this.stats.junctionWaits++;
        }
      }
      // the player, when they are in my lane ahead
      {
        const dx = player.x - a.x, dy = player.y - a.y;
        const cs = Math.cos(a.h), sn = Math.sin(a.h);
        const f = dx * cs + dy * sn, l = -dx * sn + dy * cs;
        if (f > 0 && f < 32 && Math.abs(l) < 2.3) {
          const g = f - 2.8;
          if (g < gap) { gap = Math.max(g, 0.05); dv = a.v - (player.vx * cs + player.vy * sn); hardS = a.s + Math.max(0, g - 0.5); }
        }
      }
      // brake in time for the speed the next road (and the turn into it) allows: the speed from which a comfortable deceleration reaches it at the end of this road
      let vDes = a.vDes;
      if (a.nextArc) {
        let vEnd = a.nextArc.limit * a.temper;
        const t = Math.abs(turnAngle(a.arc, a.nextArc));
        if (t > 0.25) vEnd = Math.min(vEnd, 3 + 9 * (1 - Math.min(1, t / (Math.PI / 2))));
        if (vEnd < vDes) vDes = Math.min(vDes, Math.sqrt(vEnd * vEnd + 2 * BRAKE_PLAN * Math.max(0, distEnd - 2)));
      }
      accel[i] = Math.max(-9, idmAccel(a.v, vDes, gap, dv));
      limitS[i] = hardS;
      if (a.hold > 0) { a.hold -= step; accel[i] = -5; }   // hit by the player: it slides on with what the impact gave it, brakes to a stop and waits
    }

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const v0 = a.v;
      a.v = Math.max(0, v0 + accel[i] * step);
      let ds = 0.5 * (v0 + a.v) * step;
      if (a.s + ds > limitS[i]) { ds = Math.max(0, limitS[i] - a.s); a.v = Math.min(a.v, ds / step); }
      a.s += ds;
      a.stalled = a.v < 0.2 ? a.stalled + step : 0;
      if (a.stalled > STALL_LIMIT) { a.remove = true; this.stats.stalledRemoved++; }
      // onto the next road
      let guard = 3;
      while (a.s >= a.arc.len && guard-- > 0) {
        const next = a.nextArc;
        if (!next) { a.remove = true; break; }
        a.s -= a.arc.len;
        a.prevH = a.h;
        a.prevOff = a.off;
        a.arc = next;
        a.lane = this.chooseLane(next);
        a.nextArc = this.pickNext(next);
        a.vDes = next.limit * a.temper;
      }
      // the junction is free again once the car is fully through it
      if (a.reserved >= 0 && (a.arc.from === a.reserved ? a.s > a.length + 2 : a.arc.to !== a.reserved)) { if (this.holders.get(a.reserved) === a) this.holders.delete(a.reserved); a.reserved = -1; }
      this.placePose(a);
    }

    // population: away from the player, gone; too many, the farthest go; too few, new ones appear (a few per update)
    for (const a of this.agents) if (Math.hypot(a.x - player.x, a.y - player.y) > this.despawnR) a.remove = true;
    if (this.agents.length - this.agents.filter((a) => a.remove).length > this.target) {
      const live = this.agents.filter((a) => !a.remove).sort((p, q) => Math.hypot(q.x - player.x, q.y - player.y) - Math.hypot(p.x - player.x, p.y - player.y));
      for (let k = 0; k < live.length - this.target; k++) live[k].remove = true;
    }
    if (this.agents.some((a) => a.remove)) {
      for (const a of this.agents) if (a.remove) { if (a.reserved >= 0 && this.holders.get(a.reserved) === a) this.holders.delete(a.reserved); this.stats.removed++; }
      const keep = this.agents.filter((a) => !a.remove);
      this.agents.length = 0;
      this.agents.push(...keep);
    }
    for (let k = 0; k < 3 && this.agents.length < this.target; k++) if (!this.trySpawn(player)) break;
  }

  /** The player ran into this car: it takes `dv` m/s along its heading (the half of the impact it is given) and then stays where it is for `holdS` seconds. */
  hit(a: TrafficAgent, dv: number, holdS: number) {
    a.v = Math.max(0, a.v + dv);
    a.hold = Math.max(a.hold, holdS);
  }

  /** Pose of the car's centre: on the road's shape, in its lane, blended from the lane of the road it came from. */
  private placePose(a: TrafficAgent) {
    const p = this.graph.poseAt(a.arc, Math.max(0, a.s - a.length / 2), this.pose);
    const t = clamp(a.s / BLEND, 0, 1);
    const sm = t * t * (3 - 2 * t);
    a.h = lerpAngle(a.prevH, p.h, sm);
    a.off = lerp(a.prevOff, this.laneOffset(a.arc, a.lane), sm);
    a.x = p.x + Math.sin(a.h) * a.off;
    a.y = p.y - Math.cos(a.h) * a.off;
  }
}
