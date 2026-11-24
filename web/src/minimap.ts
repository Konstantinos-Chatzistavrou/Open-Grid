// In-car GPS: a rectangular navigation screen drawn like a modern phone/head-unit navigation app. A tilted 3D map, heading-up,
// of the real streets (the tiles' road graphs) and the buildings (the tiles' footprints, extruded); the race route as the blue
// guidance line; turn-by-turn on a green maneuver card with the next-but-one turn under it; remaining time / distance /
// arrival clock on a bottom card; the current speed against the speed limit of the road under the car; day or night colours
// from the in-game clock. Click (or Tab) expands it to a north-up overview where a click sets a GPS waypoint.
// Everything is one 2D canvas (560 x 350 logical px, buffer scaled to the screen) redrawn ~15 times a second: the HUD device
// shows it and so does the screen on the dash.
// Frames: road graph and route = game frame (x east, y north); three.js = (x, y up, z = -y_game).
import { NavBuildings } from './navBuildings';
import {
  DAY, NIGHT, type NavTheme, card, classifyTurn, compassButton, drawManeuver, roundButton, roundRect, speedBubbles, type ManeuverKind,
} from './navUi';

/** cls: 0 local, 1 collector (secondary / tertiary), 2 arterial (primary), 3 highway (trunk / motorway) */
interface Seg { x0: number; y0: number; x1: number; y1: number; w: number; cls: number; lim: number; stamp: number }
/** a water / green area: bounding box and rings (flat x,y lists, outer first then holes) */
interface Area { b: number[]; r: number[][] }
interface Turn { s: number; dir: -1 | 1; ang: number; kind: ManeuverKind; name: string }
interface Landmark { x: number; y: number; name: string }
interface Named { x: number; y: number; name: string; cls: number }
/** v: speed (m/s) of a car driving on the road (traffic); leave it out for markers */
export interface Blip { x: number; z: number; color: string; v?: number }

const CELL = 100;
export const NAV_W = 560, NAV_H = 350;
const FONT = '"Roboto", "Barlow", system-ui, "Segoe UI", sans-serif';
const CLS: Record<string, number> = {
  living_street: 0, residential: 0, unclassified: 0, service: 0, road: 0,
  tertiary: 1, tertiary_link: 1, secondary: 1, secondary_link: 1,
  primary: 2, primary_link: 2,
  trunk: 3, trunk_link: 3, motorway: 3, motorway_link: 3,
};
/** typical posted limit (km/h) by road class when the data has no maxspeed */
const LIMIT = [30, 50, 60, 100];
const MIN_PX = [1.5, 1.9, 2.6, 3.4];

// the camera of the tilted view (logical px): focal length, where the optical axis meets the screen, and how steeply it looks down
const FOCAL = 440, AXIS_X = NAV_W * 0.60, AXIS_Y = NAV_H * 0.42, DEPRESSION = 0.5, NEAR = 2;
const COS_A = Math.cos(DEPRESSION), SIN_A = Math.sin(DEPRESSION);
/** camera is this many camera-heights behind the car, so the car sits at ~70 % of the screen height */
const BACK = 1.12;
const CARD_W = 192;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class Minimap {
  readonly el = document.createElement('div');
  readonly cv = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private grid = new Map<string, Seg[]>();
  private namedGrid = new Map<string, Named[]>();
  private drawStamp = 0;
  private landmarks: Landmark[] = [];
  private route: { x: number; y: number }[] = [];
  private routeClosed = true;
  private routeS: number[] = [];
  private routeLen = 0;
  private turns: Turn[] = [];
  private last = 0;
  readonly buildings = new NavBuildings();
  /** camera height above the road (m), eased with speed and with the next turn */
  private camH = 64;
  private lastCar = { x: 0, z: 0 };
  private sizeCache = 0;
  /** road segments of one tier by stroke width: one path + one stroke per width */
  private byWidth = new Map<number, number[]>();
  private pool: number[][] = [];
  /** water and green areas (areas.json) */
  private water: Area[] = [];
  private green: Area[] = [];
  private pts: number[] = [];   // scratch: one ring in camera space (r, y, z)
  private clip: number[] = [];
  /** traffic: where cars are crawling (from the cars on the road), and how heavy the traffic is at this hour (0..1) */
  private jams: { x: number; y: number; t: number }[] = [];
  private slow: { x: number; y: number; t: number; since: number }[] = [];
  private jamAt = 0;
  trafficLevel = 0;
  private trafficB: [Map<number, number[]>, Map<number, number[]>] = [new Map(), new Map()];
  private itD: number[] = [];
  private itT: Float32Array[] = [];
  private itO: number[] = [];
  private itI: number[] = [];
  private rp = { x: 0, y: 0 };
  private avgSpeed = 12;
  private limit = 0;
  private limitAt = 0;
  private street = '';
  private streetAt_ = 0;
  // the view of the frame being drawn
  private vx = 0; private vy = 0; private vhx = 1; private vhy = 0; private vH = 50; private vD = 57;
  private flat = false; private flatK = 1 / 3.8;
  private sx = 0; private sy = 0; private sz = 0; private pr = 0; private py = 0;
  /** colours: 'auto' follows the in-game clock (night 19:20 - 06:10) */
  themeMode: 'auto' | 'day' | 'night' = 'auto';
  /** in-game seconds since midnight, set by the game each frame (arrival clock, day / night) */
  clockSec = 22.5 * 3600;
  /** the game clock runs this many times faster than real time (the arrival time must agree with it) */
  clockScale = 4;
  visible = true;
  /** set when the canvas was redrawn: the in-car screen uploads its texture only then */
  dirty = false;
  /** Full-screen interactive overview (toggled by clicking the screen or pressing Tab). */
  expanded = false;
  /** Click-to-set GPS Waypoint in three.js world coordinates (x, z). */
  waypoint: { x: number; z: number } | null = null;
  onWaypoint?: (wp: { x: number; z: number } | null) => void;

  constructor(parent: HTMLElement) {
    this.el.id = 'minimap';
    const chin = document.createElement('div');
    chin.className = 'gps-chin';
    chin.innerHTML = '<i></i><i></i><i></i><b></b>';
    this.el.append(this.cv, chin);
    parent.appendChild(this.el);
    this.ctx = this.cv.getContext('2d')!;
    this.cv.width = NAV_W; this.cv.height = NAV_H;
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this.sizeCache = 0; }).observe(this.cv);
    if (typeof document !== 'undefined' && document.fonts) for (const w of [400, 500, 700]) void document.fonts.load(`${w} 20px Roboto`).catch(() => {});
    this.cv.style.cursor = 'pointer';
    this.cv.addEventListener('click', (e) => {
      if (!this.expanded) { this.toggleExpand(true); return; }
      const rect = this.cv.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * NAV_W;
      const sy = ((e.clientY - rect.top) / rect.height) * NAV_H;
      // the overview is north-up and centred on the car: canvas +x = east, canvas +y = south (+z in three.js)
      const wx = this.lastCar.x + (sx - NAV_W / 2) / this.flatK;
      const wz = this.lastCar.z + (sy - NAV_H / 2) / this.flatK;
      if (Number.isFinite(wx) && Number.isFinite(wz)) {
        this.waypoint = { x: wx, z: wz };
        this.onWaypoint?.(this.waypoint);
      }
    });
    this.cv.addEventListener('contextmenu', (e) => {
      if (!this.expanded) return;
      e.preventDefault();
      this.waypoint = null;
      this.onWaypoint?.(null);
    });
  }

  toggleExpand(force?: boolean) {
    this.expanded = force ?? !this.expanded;
    this.el.classList.toggle('expanded', this.expanded);
    this.sizeCache = 0;
    this.last = 0;   // redraw at once
  }

  /** The city's tile folder (the URL holding index.json and the tile files): the buildings stream from there. */
  setTileBase(base: string) { this.buildings.setBase(base); }

  /** Road edges of one tile's graph (game frame). Note: `e.pts` in map.json are INTERIOR shape points between nodes[a] and nodes[b]! */
  addGraph(g: { nodes: number[][]; edges: { a: number; b: number; w: number; hw: string; ms?: number; name?: string; pts?: number[][] }[] }) {
    for (const e of g.edges) {
      const na = g.nodes[e.a], nb = g.nodes[e.b];
      if (!na || !nb) continue;
      const pts = e.pts && e.pts.length > 0 ? [na, ...e.pts, nb] : [na, nb];
      const cls = CLS[e.hw] ?? 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) continue;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.25) continue;
        const s: Seg = { x0: a[0], y0: a[1], x1: b[0], y1: b[1], w: e.w || 6, cls, lim: e.ms && e.ms > 0 ? e.ms : LIMIT[cls], stamp: 0 };
        // into EVERY grid cell the segment's bounding box overlaps, so long highways / bridges never vanish
        const gx0 = Math.floor(Math.min(s.x0, s.x1) / CELL), gx1 = Math.floor(Math.max(s.x0, s.x1) / CELL);
        const gy0 = Math.floor(Math.min(s.y0, s.y1) / CELL), gy1 = Math.floor(Math.max(s.y0, s.y1) / CELL);
        for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
          const k = `${gx}_${gy}`;
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(s);
        }
        if (e.name && i === Math.floor((pts.length - 1) / 2)) {
          const n: Named = { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2, name: e.name, cls };
          const k = `${Math.floor(n.x / CELL)}_${Math.floor(n.y / CELL)}`;
          (this.namedGrid.get(k) ?? this.namedGrid.set(k, []).get(k)!).push(n);
        }
      }
    }
    this.turns = [];   // street names may now be known: recompute
  }

  /** Clear all loaded roads, route, waypoint and landmarks (used during seamless city switches). */
  clear() {
    this.grid.clear();
    this.namedGrid.clear();
    this.landmarks = [];
    this.route = [];
    this.routeS = [];
    this.routeLen = 0;
    this.turns = [];
    this.waypoint = null;
    this.water = []; this.green = []; this.jams = []; this.slow = [];
    this.buildings.clear();
    this.street = '';
    this.limit = 0;
    this.last = 0;
  }

  /** Water and green areas of the city (tiles/areas.json: {water: Area[], green: Area[]}). */
  setAreas(a: { water?: Area[]; green?: Area[] } | null) {
    this.water = a?.water ?? [];
    this.green = a?.green ?? [];
  }

  /** Real-life city landmark labels (game frame x east, y north). */
  setLandmarks(list: Landmark[]) { this.landmarks = list; }

  /** The race route (game frame samples; closed loop by default, or point-to-point when closed=false). */
  setRoute(samples: { x: number; y: number }[], closed = true) {
    this.route = samples.map((p) => ({ x: p.x, y: p.y }));
    this.routeClosed = closed;
    this.routeS = []; let acc = 0;
    for (let i = 0; i < this.route.length; i++) {
      this.routeS.push(acc);
      if (!closed && i === this.route.length - 1) break;
      const a = this.route[i], b = this.route[(i + 1) % this.route.length];
      acc += Math.hypot(b.x - a.x, b.y - a.y);
    }
    this.routeLen = acc;
    this.turns = [];
  }

  /** The nearest named street within 30 m of a point. */
  private streetNear(x: number, y: number) {
    let best = '', bd = 30 * 30;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = this.namedGrid.get(`${gx + i}_${gy + j}`);
      if (!list) continue;
      for (const n of list) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; best = n.name; } }
    }
    return best;
  }

  /** Corners of the route: heading change of more than 40 deg over ~30 m; the street the route turns into. */
  private findTurns() {
    const R = this.route, n = R.length;
    if (n < 4) return;
    const head = (i: number) => { const a = R[(i + n) % n], b = R[(i + 1 + n) % n]; return Math.atan2(b.y - a.y, b.x - a.x); };
    let i = 0;
    while (i < n) {
      let d = head(i + 4) - head(i - 1);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 0.7) {
        const after = R[(i + 8) % n];
        this.turns.push({ s: this.routeS[(i + 1) % n], dir: d > 0 ? -1 : 1, ang: Math.abs(d), kind: classifyTurn(d), name: this.streetNear(after.x, after.y) });
        i += 8;
      } else i++;
    }
  }

  /** Route point at arc length s, written into `out` (reused). */
  private routeAt(s: number, out: { x: number; y: number }) {
    s = this.routeClosed ? ((s % this.routeLen) + this.routeLen) % this.routeLen : Math.max(0, Math.min(this.routeLen, s));
    let lo = 0, hi = this.routeS.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.routeS[m] <= s) lo = m; else hi = m; }
    const a = this.route[lo];
    const bIdx = this.routeClosed ? (lo + 1) % this.route.length : Math.min(this.route.length - 1, lo + 1);
    const b = this.route[bIdx], l = (this.routeS[lo + 1] ?? this.routeLen) - this.routeS[lo];
    const t = l > 0 ? (s - this.routeS[lo]) / l : 0;
    out.x = a.x + (b.x - a.x) * t; out.y = a.y + (b.y - a.y) * t;
    return out;
  }

  /** World (game frame) + height -> logical screen px in this.sx / this.sy; this.sz = camera depth (> 0 in front). */
  private proj(wx: number, wy: number, h: number) {
    const dx = wx - this.vx, dy = wy - this.vy;
    if (this.flat) {
      this.sx = NAV_W / 2 + dx * this.flatK;
      this.sy = NAV_H / 2 - dy * this.flatK;
      this.sz = 1;
      return;
    }
    const f = dx * this.vhx + dy * this.vhy, r = dx * this.vhy - dy * this.vhx;
    const g = f + this.vD;
    const z = g * COS_A + (this.vH - h) * SIN_A;
    const y = g * SIN_A + (h - this.vH) * COS_A;
    this.sz = z; this.pr = r; this.py = y;
    if (z < NEAR) { this.sx = this.sy = NaN; return; }
    const k = FOCAL / z;
    this.sx = AXIS_X + r * k;
    this.sy = AXIS_Y - y * k;
  }

  private theme(): NavTheme {
    if (this.themeMode === 'day') return DAY;
    if (this.themeMode === 'night') return NIGHT;
    const h = (this.clockSec / 3600) % 24;
    return h < 6.2 || h >= 19.3 ? NIGHT : DAY;
  }

  /** smooth value noise in 0..1 over ~260 m cells (the same everywhere for the same place: the same road is jammed every time you look) */
  private noise(x: number, y: number) {
    const gx = x / 260, gy = y / 260, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const h = (a: number, b: number) => {
      let v = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
      v = Math.imul(v ^ (v >>> 13), 1274126177); v ^= v >>> 16;
      return (v >>> 0) / 4294967296;
    };
    const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  }

  /**
   * How congested the road is at a point, 0..1: the game's own traffic for the hour (WorldClock.trafficDensity, heaviest
   * 22:00-01:00, empty before dawn) spread over the arterials and highways in patches, plus a jam around every car that is
   * crawling or stopped on the road. Colours: > 0.45 orange, > 0.75 red.
   */
  private congestion(x: number, y: number, tier: number) {
    let c = 0;
    if (this.trafficLevel > 0.3 && tier > 0) c = this.trafficLevel * (tier === 1 ? 0.55 : 1) * Math.pow(this.noise(x, y), 2.4);
    for (const j of this.jams) {
      const d = Math.hypot(j.x - x, j.y - y);
      if (d < 100) c = Math.max(c, 1 - d / 100 + 0.1);
    }
    return c;
  }

  /** Posted limit of the road under the car (km/h), from the nearest segment's class; refreshed twice a second. */
  private limitUnder(x: number, y: number, now: number) {
    if (now - this.limitAt < 500) return this.limit;
    this.limitAt = now;
    let best = 22 * 22, lim = 0;
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = this.grid.get(`${gx + i}_${gy + j}`);
      if (!list) continue;
      for (const s of list) {
        const ex = s.x1 - s.x0, ey = s.y1 - s.y0, l2 = ex * ex + ey * ey || 1;
        const t = clamp(((x - s.x0) * ex + (y - s.y0) * ey) / l2, 0, 1);
        const d = (s.x0 + ex * t - x) ** 2 + (s.y0 + ey * t - y) ** 2;
        if (d < best) { best = d; lim = s.lim; }
      }
    }
    this.limit = lim;
    return this.limit;
  }

  /**
   * Every frame (drawn at ~15 Hz). car: three.js position; fwd: the car's forward unit vector (three.js x, z);
   * speed m/s; routeS: distance along the route (null: not on the route); others: rivals / players.
   */
  update(now: number, car: { x: number; z: number }, fwd: { x: number; z: number }, speed: number, routeS: number | null, others: Blip[]) {
    if (!this.visible || now - this.last < 66) return;
    if (!Number.isFinite(car.x) || !Number.isFinite(car.z)) return;
    this.last = now;
    this.lastCar.x = car.x;
    this.lastCar.z = car.z;
    if (this.waypoint && Math.hypot(this.waypoint.x - car.x, this.waypoint.z - car.z) < 25) {
      this.waypoint = null;
      this.onWaypoint?.(null);
    }
    if (!this.turns.length && this.route.length) this.findTurns();
    // buffer size: the screen's pixels, at least the logical size so the cabin screen stays sharp
    if (!this.sizeCache) this.sizeCache = this.cv.clientWidth || (this.expanded ? 900 : 372);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const bw = clamp(Math.round(this.sizeCache * dpr), NAV_W, 1280), bh = Math.round(bw * NAV_H / NAV_W);
    if (this.cv.width !== bw) { this.cv.width = bw; this.cv.height = bh; }
    const c = this.ctx, bs = bw / NAV_W;
    const T = this.theme();

    const cx = car.x, cy = -car.z;
    let hx = fwd.x, hy = -fwd.z;
    const hl = Math.hypot(hx, hy);
    if (hl < 1e-6) { hx = this.vhx; hy = this.vhy; } else { hx /= hl; hy /= hl; }
    const kmh = Math.abs(speed) * 3.6;
    this.avgSpeed += (Math.max(speed, 5) - this.avgSpeed) * 0.012;

    // ---- traffic: a jam wherever a car on the road is crawling or stopped; they fade after 25 s
    if (now - this.jamAt > 250) {
      this.jamAt = now;
      this.jams = this.jams.filter((j) => now - j.t < 25000);
      // a car is only "stuck" once it has been crawling (< 2.5 m/s) in the same place for 6 s: a car pulling away from the kerb or
      // a whole grid starting from rest is not a jam
      this.slow = this.slow.filter((q) => now - q.t < 700);
      for (const o of others) {
        if (o.v === undefined || o.v > 2.5) continue;
        const ox = o.x, oy = -o.z;
        if (Math.hypot(ox - cx, oy - cy) > 1500) continue;
        const q = this.slow.find((k) => Math.hypot(k.x - ox, k.y - oy) < 25);
        if (q) q.t = now;
        else if (this.slow.length < 40) { this.slow.push({ x: ox, y: oy, t: now, since: now }); continue; }
        if (q && now - q.since >= 6000) {
          const near = this.jams.find((j) => Math.hypot(j.x - ox, j.y - oy) < 40);
          if (near) near.t = now; else if (this.jams.length < 16) this.jams.push({ x: ox, y: oy, t: now });
        }
      }
    }

    // ---- the next turns of the route (distance along it)
    let next: Turn | null = null, dist = Infinity, then: Turn | null = null, thenGap = Infinity;
    const remain = routeS !== null && this.routeLen > 0 ? (this.routeClosed ? this.routeLen - routeS : Math.max(0, this.routeLen - routeS)) : null;
    if (routeS !== null && this.turns.length && !this.waypoint) {
      const s = ((routeS % this.routeLen) + this.routeLen) % this.routeLen;
      for (const t of this.turns) { let d = t.s - s; if (d < -5) d += this.routeLen; if (d >= -5 && d < dist) { dist = d; next = t; } }
      if (next) {
        for (const t of this.turns) {
          if (t === next) continue;
          let g = t.s - next.s; if (g < 1) g += this.routeLen;
          if (g < thenGap) { thenGap = g; then = t; }
        }
      }
    }

    // ---- camera: higher (looking further) with speed; a little closer when a turn is coming up
    this.flat = this.expanded;
    let target = clamp(60 + speed * 1.35, 60, 160);
    if (next && dist < 260) target *= 0.78 + 0.22 * clamp((dist - 40) / 220, 0, 1);
    this.camH += (target - this.camH) * 0.12;
    this.vx = cx; this.vy = cy; this.vhx = hx; this.vhy = hy;
    this.vH = this.camH; this.vD = this.camH * BACK;
    this.flatK = 1 / 3.8;

    c.setTransform(bs, 0, 0, bs, 0, 0);
    c.clearRect(0, 0, NAV_W, NAV_H);
    c.save();
    c.beginPath(); c.rect(0, 0, NAV_W, NAV_H); c.clip();
    c.fillStyle = T.land; c.fillRect(0, 0, NAV_W, NAV_H);
    this.drawAreas(c, T, cx, cy, hx, hy);
    this.drawRoads(c, T, cx, cy, hx, hy);
    if (!this.flat && this.camH < 135) this.drawBuildings(c, T, cx, cy, hx, hy);
    this.drawLabels(c, T, cx, cy, hx, hy);
    this.drawRoute(c, T, routeS);
    this.drawMarkers(c, T, cx, cy, others);
    // haze into the distance
    if (!this.flat) {
      const g = c.createLinearGradient(0, 0, 0, NAV_H * 0.46);
      g.addColorStop(0, T.haze); g.addColorStop(0.35, T.haze + 'cc'); g.addColorStop(1, T.haze + '00');
      c.fillStyle = g; c.fillRect(0, 0, NAV_W, NAV_H * 0.46);
    }
    this.drawPuck(c, T, cx, cy, hx, hy);
    c.restore();
    this.drawUi(c, T, now, cx, cy, hx, hy, kmh, routeS, remain, next, dist, then, thenGap);
    this.dirty = true;
  }

  // ------------------------------------------------------------------ the map layers
  private drawRoads(c: CanvasRenderingContext2D, T: NavTheme, cx: number, cy: number, hx: number, hy: number) {
    // which grid cells can be on screen: a circle around the middle of the visible ground
    let ccx = cx, ccy = cy, reach: number;
    if (this.flat) { reach = (NAV_W / this.flatK) * 0.75; }
    else {
      const ahead = this.vH / Math.tan(Math.max(0.12, DEPRESSION - Math.atan(AXIS_Y / FOCAL))) - this.vD;
      reach = ahead * 0.78;
      ccx = cx + hx * ahead * 0.45; ccy = cy + hy * ahead * 0.45;
    }
    const c0x = Math.floor((ccx - reach) / CELL), c1x = Math.floor((ccx + reach) / CELL);
    const c0y = Math.floor((ccy - reach) / CELL), c1y = Math.floor((ccy + reach) / CELL);
    const byWidth = this.byWidth, pool = this.pool;
    c.lineCap = 'round'; c.lineJoin = 'round';
    const rr = (reach + CELL * 0.75) ** 2;
    for (let tier = 0; tier < 4; tier++) {
      const stamp = ++this.drawStamp;
      for (let gx = c0x; gx <= c1x; gx++) for (let gy = c0y; gy <= c1y; gy++) {
        if (((gx + 0.5) * CELL - ccx) ** 2 + ((gy + 0.5) * CELL - ccy) ** 2 > rr) continue;
        const list = this.grid.get(`${gx}_${gy}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (s.cls !== tier || s.stamp === stamp) continue;
          s.stamp = stamp;
          this.proj(s.x0, s.y0, 0); const ax = this.sx, ay = this.sy, az = this.sz;
          this.proj(s.x1, s.y1, 0); let bx = this.sx, by = this.sy; const bz = this.sz;
          let ux = ax, uy = ay;
          if (!this.flat) {
            if (!(az >= NEAR) && !(bz >= NEAR)) continue;
            // clip the part behind the near plane
            if (!(az >= NEAR) || !(bz >= NEAR)) {
              const t = (NEAR - az) / (bz - az);
              const nx = s.x0 + (s.x1 - s.x0) * t, ny = s.y0 + (s.y1 - s.y0) * t;
              if (!(az >= NEAR)) { this.proj(nx, ny, 0); ux = this.sx; uy = this.sy; }
              else { this.proj(nx, ny, 0); bx = this.sx; by = this.sy; }
              if (Number.isNaN(ux + uy + bx + by)) continue;
            }
            if ((ux < -80 && bx < -80) || (ux > NAV_W + 80 && bx > NAV_W + 80) || (uy > NAV_H + 80 && by > NAV_H + 80) || (uy < -40 && by < -40)) continue;
          }
          const z = this.flat ? 1 : Math.max(NEAR, (az + bz) * 0.5);
          const px = this.flat ? s.w * this.flatK : (s.w * 0.72 * FOCAL) / z;
          const lw = Math.round(Math.max(px * 0.9, MIN_PX[tier]) * 2) / 2;
          let bucket = byWidth.get(lw);
          if (!bucket) byWidth.set(lw, (bucket = pool.pop() ?? []));
          bucket.push(ux, uy, bx, by);
          if (this.trafficLevel > 0.3 || this.jams.length) {
            const cg = this.congestion((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, tier);
            if (cg > 0.45) {
              const tb = this.trafficB[cg > 0.75 ? 1 : 0];
              let tbk = tb.get(lw);
              if (!tbk) tb.set(lw, (tbk = pool.pop() ?? []));
              tbk.push(ux, uy, bx, by);
            }
          }
        }
      }
      // casings of the whole tier first, then the fills, so the junctions of one tier merge cleanly
      for (let pass = 0; pass < 2; pass++) {
        for (const [lw, b] of byWidth) {
          c.beginPath();
          for (let i = 0; i < b.length; i += 4) { c.moveTo(b[i], b[i + 1]); c.lineTo(b[i + 2], b[i + 3]); }
          if (pass === 0) { c.strokeStyle = T.casing[tier]; c.lineWidth = lw + (tier === 3 ? 3.2 : 2.4); }
          else { c.strokeStyle = T.road[tier]; c.lineWidth = lw; }
          c.stroke();
        }
      }
      // traffic: a coloured stripe down the middle of the slow roads of this tier
      for (let k = 0; k < 2; k++) {
        const tb = this.trafficB[k];
        if (!tb.size) continue;
        c.strokeStyle = k ? T.trafficRed : T.trafficOrange;
        for (const [lw, b] of tb) {
          c.beginPath();
          for (let i = 0; i < b.length; i += 4) { c.moveTo(b[i], b[i + 1]); c.lineTo(b[i + 2], b[i + 3]); }
          c.lineWidth = Math.max(2, lw * 0.55);
          c.stroke();
          b.length = 0; pool.push(b);
        }
        tb.clear();
      }
      for (const b of byWidth.values()) { b.length = 0; pool.push(b); }
      byWidth.clear();
    }
  }

  /** water and green areas under the roads; each ring is clipped at the camera's near plane before it is projected */
  private drawAreas(c: CanvasRenderingContext2D, T: NavTheme, cx: number, cy: number, hx: number, hy: number) {
    if (!this.water.length && !this.green.length) return;
    let ccx = cx, ccy = cy, reach: number;
    if (this.flat) reach = (NAV_W / this.flatK) * 0.75;
    else {
      const ahead = this.vH / Math.tan(Math.max(0.12, DEPRESSION - Math.atan(AXIS_Y / FOCAL))) - this.vD;
      reach = ahead * 0.85; ccx = cx + hx * ahead * 0.45; ccy = cy + hy * ahead * 0.45;
    }
    for (let layer = 0; layer < 2; layer++) {
      const list = layer ? this.green : this.water, fill = layer ? T.green : T.water;
      c.fillStyle = fill;
      for (const a of list) {
        const b = a.b;
        // the box against the view circle
        const dx = Math.max(b[0] - ccx, 0, ccx - b[2]), dy = Math.max(b[1] - ccy, 0, ccy - b[3]);
        if (dx * dx + dy * dy > reach * reach) continue;
        c.beginPath();
        for (const r of a.r) this.ringPath(c, r);
        c.fill('evenodd');
      }
    }
  }

  /** Add one ring (flat x,y list) to the current path, in screen space. */
  private ringPath(c: CanvasRenderingContext2D, ring: number[]) {
    const n = ring.length >> 1;
    if (n < 3) return;
    if (this.flat) {
      for (let i = 0; i < n; i++) { this.proj(ring[2 * i], ring[2 * i + 1], 0); if (i) c.lineTo(this.sx, this.sy); else c.moveTo(this.sx, this.sy); }
      c.closePath();
      return;
    }
    // camera space (right, up, depth), then Sutherland-Hodgman against depth >= NEAR
    const P = this.pts; P.length = 0;
    for (let i = 0; i < n; i++) { this.proj(ring[2 * i], ring[2 * i + 1], 0); P.push(this.pr, this.py, this.sz); }
    const O = this.clip; O.length = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = i * 3, b = j * 3;
      const ai = P[a + 2] >= NEAR, bi = P[b + 2] >= NEAR;
      if (ai) O.push(P[a], P[a + 1], P[a + 2]);
      if (ai !== bi) {
        const t = (NEAR - P[a + 2]) / (P[b + 2] - P[a + 2]);
        O.push(P[a] + (P[b] - P[a]) * t, P[a + 1] + (P[b + 1] - P[a + 1]) * t, NEAR);
      }
    }
    if (O.length < 9) return;
    for (let i = 0; i < O.length; i += 3) {
      const k = FOCAL / O[i + 2], x = AXIS_X + O[i] * k, y = AXIS_Y - O[i + 1] * k;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.closePath();
  }

  private drawBuildings(c: CanvasRenderingContext2D, T: NavTheme, cx: number, cy: number, hx: number, hy: number) {
    this.buildings.ensure(cx + hx * 150, cy + hy * 150, 330);
    const camX = cx - hx * this.vD, camY = cy - hy * this.vD;
    const maxD = 340 * 340;
    // collect (parallel arrays, reused between frames), then far to near (painter's order)
    const itD = this.itD, itT = this.itT, itO = this.itO;
    let cnt = 0;
    this.buildings.forEachTile((t) => {
      for (let i = 0; i < t.n; i++) {
        const o = i * 7;
        const dx = t.d[o] - camX, dy = t.d[o + 1] - camY;
        const d = dx * dx + dy * dy;
        if (d > maxD) continue;
        if (dx * hx + dy * hy < -30) continue;   // behind the camera
        itD[cnt] = d; itT[cnt] = t.d; itO[cnt] = o; cnt++;
      }
    });
    if (!cnt) return;
    const order = this.itI;
    order.length = cnt;
    for (let i = 0; i < cnt; i++) order[i] = i;
    order.sort((a, b) => itD[b] - itD[a]);
    const n = Math.min(cnt, 420);
    const hCap = this.vH * 0.12;
    const sxs = [0, 0, 0, 0], sys = [0, 0, 0, 0], txs = [0, 0, 0, 0], tys = [0, 0, 0, 0];
    const wx = [0, 0, 0, 0], wy = [0, 0, 0, 0];
    for (let k = cnt - n; k < cnt; k++) {
      const t = itT[order[k]], o = itO[order[k]];
      const bx = t[o], by = t[o + 1], ex = t[o + 2], ey = t[o + 3], co = t[o + 4], si = t[o + 5];
      const h = Math.min(t[o + 6] * 0.4, hCap, 22);
      // corners (local +x,+y ; -x,+y ; -x,-y ; +x,-y), rotated by yaw
      let ok = true;
      for (let i = 0; i < 4; i++) {
        const lx = i === 0 || i === 3 ? ex : -ex, ly = i < 2 ? ey : -ey;
        wx[i] = bx + lx * co - ly * si; wy[i] = by + lx * si + ly * co;
        this.proj(wx[i], wy[i], 0); sxs[i] = this.sx; sys[i] = this.sy;
        this.proj(wx[i], wy[i], h); txs[i] = this.sx; tys[i] = this.sy;
        if (Number.isNaN(sxs[i] + sys[i] + txs[i] + tys[i])) ok = false;
      }
      if (!ok) continue;
      if (Math.max(sxs[0], sxs[1], sxs[2], sxs[3], txs[0], txs[1], txs[2], txs[3]) < -20 || Math.min(sxs[0], sxs[1], sxs[2], sxs[3], txs[0], txs[1], txs[2], txs[3]) > NAV_W + 20) continue;
      // walls that face the camera
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) & 3;
        const mx = (wx[i] + wx[j]) / 2, my = (wy[i] + wy[j]) / 2;
        let nx = wy[j] - wy[i], ny = wx[i] - wx[j];   // outward normal of a counter-clockwise polygon
        const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
        if (nx * (camX - mx) + ny * (camY - my) <= 0) continue;
        c.fillStyle = nx * 0.6 + ny * 0.8 > 0 ? T.wallLit : T.wallDark;
        c.beginPath(); c.moveTo(sxs[i], sys[i]); c.lineTo(sxs[j], sys[j]); c.lineTo(txs[j], tys[j]); c.lineTo(txs[i], tys[i]); c.closePath(); c.fill();
      }
      c.fillStyle = T.roof;
      c.beginPath(); c.moveTo(txs[0], tys[0]); c.lineTo(txs[1], tys[1]); c.lineTo(txs[2], tys[2]); c.lineTo(txs[3], tys[3]); c.closePath(); c.fill();
      c.strokeStyle = T.roofEdge; c.lineWidth = 0.8; c.stroke();
    }
  }

  private drawLabels(c: CanvasRenderingContext2D, T: NavTheme, cx: number, cy: number, hx: number, hy: number) {
    const range = this.flat ? 900 : Math.min(420, this.vH * 4.5);
    const gx0 = Math.floor((cx - range) / CELL), gx1 = Math.floor((cx + range) / CELL);
    const gy0 = Math.floor((cy - range) / CELL), gy1 = Math.floor((cy + range) / CELL);
    const cand: { n: Named; d: number }[] = [];
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const list = this.namedGrid.get(`${gx}_${gy}`);
      if (!list) continue;
      for (const n of list) {
        const dx = n.x - cx, dy = n.y - cy;
        const d = Math.hypot(dx, dy);
        if (d > range) continue;
        if (!this.flat && dx * hx + dy * hy < -20) continue;
        // tilted view: the nearest first (major roads a bit earlier); overview: major roads first, spread over the whole map
        cand.push({ n, d: this.flat ? -n.cls * 1000 + ((Math.imul(Math.round(n.x), 73856093) ^ Math.imul(Math.round(n.y), 19349663)) >>> 0) % 900 : d - n.cls * 70 });
      }
    }
    if (!cand.length) return;
    cand.sort((a, b) => a.d - b.d);
    const boxes: number[] = [];
    const seen = new Set<string>();
    let drawn = 0;
    c.font = `500 11px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = 3.4;
    for (const { n } of cand) {
      if (drawn >= (this.flat ? 14 : 8)) break;
      this.proj(n.x, n.y, 0);
      const x = this.sx, y = this.sy;
      if (seen.has(n.name)) continue;                                                       // one label per street
      const w = c.measureText(n.name).width + 6, h = 13;
      if (!(x - w / 2 > CARD_W + 22 && x + w / 2 < NAV_W - 56 && y > (this.flat ? 20 : 120) && y < NAV_H - 14)) continue;   // clear of the cards, buttons and the haze
      if (!this.flat && Math.abs(x - AXIS_X) < 34) continue;                              // not under the guidance line
      if (this.flat && Math.abs(x - NAV_W / 2) < w / 2 + 22 && Math.abs(y - NAV_H / 2) < 24) continue;   // not under the car
      let clash = false;
      for (let i = 0; i < boxes.length; i += 4) if (Math.abs(x - boxes[i]) < (w + boxes[i + 2]) / 2 && Math.abs(y - boxes[i + 1]) < (h + boxes[i + 3]) / 2) { clash = true; break; }
      if (clash) continue;
      boxes.push(x, y, w, h);
      seen.add(n.name);
      c.strokeStyle = T.labelHalo; c.strokeText(n.name, x, y);
      c.fillStyle = T.label; c.fillText(n.name, x, y);
      drawn++;
    }
  }

  private drawRoute(c: CanvasRenderingContext2D, T: NavTheme, routeS: number | null) {
    if (this.route.length < 2) return;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (this.flat) {
      // the whole loop faint, the part ahead bright
      c.beginPath();
      for (let i = 0; i < this.route.length; i++) { const p = this.route[i]; this.proj(p.x, p.y, 0); if (i) c.lineTo(this.sx, this.sy); else c.moveTo(this.sx, this.sy); }
      if (this.routeClosed) c.closePath();
      c.strokeStyle = T.route + '55'; c.lineWidth = 5; c.stroke();
    }
    if (routeS === null) return;
    // upcoming 1.5 km, in runs so the width follows the perspective
    const step = 9, n = 170;
    const px: number[] = [], py: number[] = [], pz: number[] = [], wxs: number[] = [], wys: number[] = [];
    for (let i = 0; i <= n; i++) {
      const p = this.routeAt(routeS - 20 + i * step, this.rp);
      wxs.push(p.x); wys.push(p.y);
      this.proj(p.x, p.y, 0);
      px.push(this.sx); py.push(this.sy); pz.push(this.sz);
    }
    const run = 6;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i += run) {
        const mid = pz[Math.min(n, i + (run >> 1))];
        if (!this.flat && !(mid >= NEAR)) continue;
        const w = this.flat ? 6.5 : clamp((7.5 * FOCAL) / Math.max(mid, NEAR), 3.4, 14);
        c.beginPath();
        let started = false;
        for (let j = i; j <= Math.min(n, i + run); j++) {
          if (Number.isNaN(px[j])) { started = false; continue; }
          if (started) c.lineTo(px[j], py[j]); else { c.moveTo(px[j], py[j]); started = true; }
        }
        // the guidance line turns orange / red where the road ahead is slow
        const m = Math.min(n, i + (run >> 1)), cg = this.trafficLevel > 0.3 || this.jams.length ? this.congestion(wxs[m], wys[m], 2) : 0;
        if (pass === 0) { c.strokeStyle = cg > 0.75 ? T.trafficRedCasing : cg > 0.45 ? T.trafficOrangeCasing : T.routeCasing; c.lineWidth = w + 3.6; }
        else { c.strokeStyle = cg > 0.75 ? T.trafficRed : cg > 0.45 ? T.trafficOrange : T.route; c.lineWidth = w; }
        c.stroke();
      }
    }
    // start / finish
    const s0 = this.route[0];
    this.proj(s0.x, s0.y, 0);
    if (!Number.isNaN(this.sx) && this.sx > 0 && this.sx < NAV_W && this.sy > 0 && this.sy < NAV_H) {
      const u = this.flat ? 6 : clamp((3.2 * FOCAL) / Math.max(this.sz, NEAR), 4, 14);
      c.fillStyle = '#fff'; c.fillRect(this.sx - u, this.sy - u, 2 * u, 2 * u);
      c.fillStyle = '#202124'; c.fillRect(this.sx - u, this.sy - u, u, u); c.fillRect(this.sx, this.sy, u, u);
    }
  }

  private drawMarkers(c: CanvasRenderingContext2D, T: NavTheme, cx: number, cy: number, others: Blip[]) {
    // landmarks as points of interest
    if (this.landmarks.length) {
      c.font = `500 10.5px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'middle'; c.lineWidth = 3; c.lineJoin = 'round';
      let n = 0;
      for (const lm of this.landmarks) {
        if (Math.abs(lm.x - cx) > 700 || Math.abs(lm.y - cy) > 700) continue;
        this.proj(lm.x, lm.y, 0);
        if (!(this.sx > CARD_W + 30 && this.sx < NAV_W - 80 && this.sy > 120 && this.sy < NAV_H - 20)) continue;
        c.fillStyle = T.poi; c.beginPath(); c.arc(this.sx, this.sy, 4.4, 0, Math.PI * 2); c.fill();
        c.strokeStyle = T.labelHalo; c.strokeText(lm.name, this.sx + 8, this.sy); c.fillStyle = T.label; c.fillText(lm.name, this.sx + 8, this.sy);
        if (++n >= 4) break;
      }
    }
    // rivals / players
    for (const o of others) {
      this.proj(o.x, -o.z, 0);
      if (Number.isNaN(this.sx) || this.sx < -10 || this.sx > NAV_W + 10 || this.sy < -10 || this.sy > NAV_H + 10) continue;
      const r = this.flat ? 4.5 : clamp((2.2 * FOCAL) / Math.max(this.sz, NEAR), 3, 8);
      c.fillStyle = o.color; c.beginPath(); c.arc(this.sx, this.sy, r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = T.night ? '#0b0f15' : '#ffffff'; c.lineWidth = 1.6; c.stroke();
    }
    // destination pin of a GPS waypoint, with the straight guide to it
    if (this.waypoint) {
      const wx = this.waypoint.x, wy = -this.waypoint.z;
      this.proj(cx, cy, 0); const x0 = this.sx, y0 = this.sy;
      this.proj(wx, wy, 0);
      if (!Number.isNaN(this.sx)) {
        c.strokeStyle = T.route; c.lineWidth = 3; c.setLineDash([7, 7]); c.lineCap = 'butt';
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(this.sx, this.sy); c.stroke(); c.setLineDash([]);
        const x = clamp(this.sx, CARD_W + 36, NAV_W - 60), y = clamp(this.sy, 110, NAV_H - 40);
        c.fillStyle = '#ea4335'; c.strokeStyle = '#ffffff'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(x, y); c.bezierCurveTo(x - 15, y - 14, x - 11, y - 34, x, y - 34); c.bezierCurveTo(x + 11, y - 34, x + 15, y - 14, x, y); c.fill(); c.stroke();
        c.fillStyle = '#ffffff'; c.beginPath(); c.arc(x, y - 23, 4.2, 0, Math.PI * 2); c.fill();
      }
    }
  }

  private drawPuck(c: CanvasRenderingContext2D, T: NavTheme, cx: number, cy: number, hx: number, hy: number) {
    this.proj(cx, cy, 0);
    const x = this.sx, y = this.sy;
    if (Number.isNaN(x)) return;
    c.save();
    c.translate(x, y);
    // the way the screen's "up" lines up with the car: flat map rotates the arrow, the tilted view keeps it upright
    if (this.flat) c.rotate(Math.PI / 2 - Math.atan2(hy, hx));
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 34);
    g.addColorStop(0, T.puck + '55'); g.addColorStop(1, T.puck + '00');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 34, 0, Math.PI * 2); c.fill();
    c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 7; c.shadowOffsetY = 2;
    c.fillStyle = T.puck; c.strokeStyle = '#ffffff'; c.lineWidth = 3; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(0, -17); c.lineTo(12.5, 13); c.lineTo(0, 6.5); c.lineTo(-12.5, 13); c.closePath(); c.stroke(); c.fill();
    c.restore();
  }

  // ------------------------------------------------------------------ the cards and buttons on top
  private fit(c: CanvasRenderingContext2D, text: string, maxW: number) {
    if (c.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 3 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t.trimEnd() + '…';
  }

  private fmtDist(m: number) {
    if (m < 1000) return `${m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  }

  private clockText(sec: number) {
    const s = ((sec % 86400) + 86400) % 86400;
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  }

  private drawUi(c: CanvasRenderingContext2D, T: NavTheme, now: number, cx: number, cy: number, hx: number, hy: number, kmh: number,
                 routeS: number | null, remain: number | null, next: Turn | null, dist: number, then: Turn | null, thenGap: number) {
    const CW = CARD_W, X = 10;
    // street under the car (refreshed twice a second)
    if (now - this.streetAt_ > 500) { this.streetAt_ = now; this.street = this.streetNear(cx, cy); }
    // ---- maneuver card
    let title = '', sub = '', kind: ManeuverKind = 'straight', dir: -1 | 1 = 1, rot = 0;
    if (this.waypoint) {
      const dx = this.waypoint.x - this.lastCar.x, dz = this.waypoint.z - this.lastCar.z;
      const wd = Math.hypot(dx, dz);
      title = this.fmtDist(wd); sub = 'GPS waypoint';
      // bearing of the waypoint relative to the car's heading (counter-clockwise positive; the canvas rotates clockwise)
      rot = -(Math.atan2(-dz, dx) - Math.atan2(hy, hx));
    } else if (next && routeS !== null && dist < 1200) {
      kind = next.kind; dir = next.dir;
      title = dist < 30 ? 'Now' : this.fmtDist(dist);
      sub = next.name ? `onto ${next.name}` : (next.dir < 0 ? 'Turn left' : 'Turn right');
    } else if (this.street) {
      title = 'Continue'; sub = `on ${this.street}`;
    }
    if (title) {
      const h = 104;
      card(c, X, 10, CW, h, 14, T.maneuver, T.night);
      c.save();
      c.translate(X + 36, 10 + 46);
      if (this.waypoint) { c.rotate(rot); drawManeuver(c, 'straight', 1, 52); }
      else drawManeuver(c, kind, dir, 56);
      c.restore();
      c.fillStyle = '#ffffff'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.font = `500 32px ${FONT}`;
      c.fillText(this.fit(c, title, CW - 80), X + 72, 10 + 52);
      c.font = `400 15px ${FONT}`;
      c.fillStyle = '#ffffffdd';
      c.fillText(this.fit(c, sub, CW - 24), X + 14, 10 + 90);
      // "Then" strip with the turn after that
      if (then && next && thenGap < 320 && !this.waypoint && dist < 1200) {
        const ty = 10 + h - 2;
        c.fillStyle = T.maneuverDark;
        roundRect(c, X, ty - 8, CW, 44, 14); c.fill();
        c.fillStyle = T.maneuver; c.fillRect(X, ty - 8, CW, 12);
        c.fillStyle = '#ffffffcc'; c.font = `500 15px ${FONT}`; c.textBaseline = 'middle';
        c.fillText('Then', X + 14, ty + 18);
        c.save(); c.translate(X + 72, ty + 17); drawManeuver(c, then.kind, then.dir, 26); c.restore();
      }
    }
    // ---- bottom card: time, distance, arrival
    {
      const h = 70, y = NAV_H - h - 10;
      card(c, X, y, CW, h, 14, T.card, T.night);
      c.textBaseline = 'alphabetic'; c.textAlign = 'left';
      // standing on the line of a loop before the first lap: not "arriving", just show the clock
      const atStart = this.routeClosed && remain !== null && remain < 100 && kmh < 6;
      if (remain !== null && !this.waypoint && !atStart) {
        if (remain < 100) {
          c.fillStyle = T.eta; c.font = `500 28px ${FONT}`; c.fillText('Arriving', X + 16, y + 42);
        } else {
          const sec = remain / Math.max(this.avgSpeed, 10);
          const mins = Math.max(1, Math.round(sec / 60));
          c.fillStyle = T.eta; c.font = `500 30px ${FONT}`;
          c.fillText(mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`, X + 16, y + 37);
          c.fillStyle = T.cardSub; c.font = `400 15px ${FONT}`;
          c.fillText(`${this.fmtDist(remain)} · ${this.clockText(this.clockSec + sec * this.clockScale)}`, X + 16, y + 58);
        }
        roundButton(c, X + CW - 30, y + h / 2, 17, T, 'close');
      } else if (this.waypoint) {
        const wd = Math.hypot(this.waypoint.x - this.lastCar.x, this.waypoint.z - this.lastCar.z);
        const sec = wd / Math.max(this.avgSpeed, 10);
        c.fillStyle = T.eta; c.font = `500 30px ${FONT}`; c.fillText(`${Math.max(1, Math.round(sec / 60))} min`, X + 16, y + 38);
        c.fillStyle = T.cardSub; c.font = `400 15px ${FONT}`;
        c.fillText(`${this.fmtDist(wd)} · ${this.clockText(this.clockSec + sec * this.clockScale)}`, X + 16, y + 60);
        roundButton(c, X + CW - 30, y + h / 2, 17, T, 'close');
      } else {
        c.fillStyle = T.cardText; c.font = `500 30px ${FONT}`; c.fillText(this.clockText(this.clockSec), X + 16, y + 38);
        c.fillStyle = T.cardSub; c.font = `400 15px ${FONT}`;
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const brg = (Math.PI / 2 - Math.atan2(hy, hx) + Math.PI * 2) % (Math.PI * 2);
        c.fillText(`Heading ${dirs[Math.round(brg / (Math.PI / 4)) % 8]}${this.street ? ' · ' + this.fit(c, this.street, 100) : ''}`, X + 16, y + 60);
      }
    }
    // ---- right: compass, sound, search
    const bx = NAV_W - 30;
    compassButton(c, bx, 34, 18, T, this.flat ? 0 : (Math.atan2(hy, hx) - Math.PI / 2));
    roundButton(c, bx, 78, 18, T, 'speaker');
    roundButton(c, bx, 122, 18, T, 'search');
    // ---- bottom right: speed limit and speed
    speedBubbles(c, NAV_W - 42, NAV_H - 42, kmh, this.limitUnder(cx, cy, now), T, FONT);
    if (this.flat) {
      // scale bar of the overview
      const m = 80 / this.flatK, nice = m >= 500 ? Math.round(m / 100) * 100 : m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
      const wpx = nice * this.flatK, sx = NAV_W / 2 - wpx / 2, sy = NAV_H - 22;
      c.fillStyle = T.card; c.globalAlpha = 0.85; roundRect(c, sx - 8, sy - 14, wpx + 16, 24, 8); c.fill(); c.globalAlpha = 1;
      c.strokeStyle = T.cardText; c.lineWidth = 2; c.beginPath(); c.moveTo(sx, sy + 2); c.lineTo(sx, sy - 5); c.lineTo(sx + wpx, sy - 5); c.lineTo(sx + wpx, sy + 2); c.stroke();
      c.fillStyle = T.cardText; c.font = `500 10px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
      c.fillText(nice >= 1000 ? `${(nice / 1000).toFixed(1)} km` : `${nice} m`, NAV_W / 2, sy + 6);
    }
  }

  show(on: boolean) { this.visible = on; this.el.hidden = !on; }
}
