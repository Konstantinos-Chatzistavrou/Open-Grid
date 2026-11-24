// GPS minimap: the real streets (the tiles' road graphs) heading-up around the car, zooming out with speed; the race
// route as the GPS line with the next stretch highlighted; rivals as dots; and a turn-by-turn banner ("↰ 7th Avenue ·
// 250 m") from the route's corners and the street names in the graph. A 2D canvas redrawn ~15 times a second from a
// spatial grid of road segments (a few hundred lines per frame).
// Frames: road graph and route = game frame (x east, y north); three.js = (x, y up, z = -y_game).

interface Seg { x0: number; y0: number; x1: number; y1: number; w: number; major: boolean; stamp: number }
interface Turn { s: number; dir: -1 | 1; sharp: boolean; name: string }
interface Landmark { x: number; y: number; name: string }
export interface Blip { x: number; z: number; color: string }

const CELL = 100;

export class Minimap {
  readonly el = document.createElement('div');
  readonly cv = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private banner = document.createElement('div');
  private footScale: HTMLElement | null = null;
  private footEta: HTMLElement | null = null;
  private speedEl: HTMLElement | null = null;
  private etaChip: HTMLElement | null = null;
  private pillEl: HTMLElement | null = null;
  private grid = new Map<string, Seg[]>();
  private drawStamp = 0;
  private named: { x: number; y: number; name: string }[] = [];
  private landmarks: Landmark[] = [];
  private route: { x: number; y: number }[] = [];
  private routeClosed = true;
  private routeS: number[] = [];
  private routeLen = 0;
  private turns: Turn[] = [];
  private last = 0;
  private zoom = 1.6;   // m per css px
  private lastCar = { x: 0, z: 0 };
  /** css size of the map, cached (reading clientWidth at 15 Hz forced a synchronous layout); 0 = read it again */
  private sizeCache = 0;
  /** the banner html last written (reading innerHTML back re-serialized the DOM every draw) */
  private bannerHtml = '';
  /** road segments of one tier by stroke width: one path + one stroke per width instead of one per segment */
  private byWidth = new Map<number, Seg[]>();
  private segPool: Seg[][] = [];
  private rp = { x: 0, y: 0 };
  visible = true;
  /** set when the canvas was redrawn: the in-car screen uploads its texture only then, not every frame */
  dirty = false;
  /** Full-screen interactive map mode (toggled by clicking minimap or pressing Tab). */
  expanded = false;
  /** Click-to-set GPS Waypoint in three.js world coordinates (x, z). */
  waypoint: { x: number; z: number } | null = null;
  onWaypoint?: (wp: { x: number; z: number } | null) => void;

  constructor(parent: HTMLElement) {
    this.el.id = 'minimap';
    this.banner.className = 'gps-turn';
    const foot = document.createElement('div');
    foot.className = 'gps-foot';
    foot.innerHTML = '<span class="gps-eta"></span><span class="gps-scale"><i class="gps-bar"></i><b>—</b></span>';
    this.footScale = foot.querySelector('b');
    this.footEta = foot.querySelector('.gps-eta');
    const speed = document.createElement('div');
    speed.className = 'gps-speed';
    speed.innerHTML = '<span>0</span><small>KM/H</small>';
    this.speedEl = speed.querySelector('span');
    const eta = document.createElement('div');
    eta.className = 'gps-eta-chip';
    eta.hidden = true;
    this.etaChip = eta;
    const pill = document.createElement('div');
    pill.className = 'gps-pill';
    pill.textContent = 'Centre vehicle';
    this.pillEl = pill;
    this.el.append(this.banner, this.cv, foot, speed, eta, pill);
    parent.appendChild(this.el);
    this.ctx = this.cv.getContext('2d')!;
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { this.sizeCache = 0; }).observe(this.el);
    this.cv.style.cursor = 'pointer';
    this.cv.addEventListener('click', (e) => {
      if (!this.expanded) { this.toggleExpand(true); return; }
      const rect = this.cv.getBoundingClientRect();
      const sx = e.clientX - rect.left - rect.width / 2;
      const sy = e.clientY - rect.top - rect.height / 2;
      const fullZoom = 3.8;
      // Expanded map is north-up centred on the player car:
      // canvas +X = east (+x), canvas +Y = south (-y_game = +z_three)
      const wx = this.lastCar.x + sx * fullZoom;
      const wz = this.lastCar.z + sy * fullZoom;
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
    this.sizeCache = 0;   // the size changes with the class: read it on the redraw below, do not wait for the observer
    this.last = 0; // force immediate redraw
  }

  /** Road edges of one tile's graph (game frame). Note: `e.pts` in map.json are INTERIOR shape points between nodes[a] and nodes[b]! */
  addGraph(g: { nodes: number[][]; edges: { a: number; b: number; w: number; hw: string; name?: string; pts?: number[][] }[] }) {
    for (const e of g.edges) {
      const na = g.nodes[e.a], nb = g.nodes[e.b];
      if (!na || !nb) continue;
      // Fix: always include both endpoint nodes[a] & nodes[b] around interior shape points `e.pts` so zero streets or intersections drop out!
      const pts = e.pts && e.pts.length > 0 ? [na, ...e.pts, nb] : [na, nb];
      const major = ['primary', 'secondary', 'trunk', 'motorway', 'primary_link', 'trunk_link', 'motorway_link'].includes(e.hw);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        if (!a || !b || !Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) continue;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.25) continue;
        const s: Seg = { x0: a[0], y0: a[1], x1: b[0], y1: b[1], w: e.w || 6, major, stamp: 0 };
        // Insert into EVERY grid cell overlapped by the segment's bounding box so long highways/bridges never vanish!
        const gx0 = Math.floor(Math.min(s.x0, s.x1) / CELL), gx1 = Math.floor(Math.max(s.x0, s.x1) / CELL);
        const gy0 = Math.floor(Math.min(s.y0, s.y1) / CELL), gy1 = Math.floor(Math.max(s.y0, s.y1) / CELL);
        for (let gx = gx0; gx <= gx1; gx++) {
          for (let gy = gy0; gy <= gy1; gy++) {
            const k = `${gx}_${gy}`;
            (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(s);
          }
        }
        if (e.name && i === Math.floor((pts.length - 1) / 2)) {
          this.named.push({ x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2, name: e.name });
        }
      }
    }
    this.turns = [];   // street names may now be known: recompute
  }

  /** Clear all loaded roads, route, waypoint and landmarks (used during seamless city switches). */
  clear() {
    this.grid.clear();
    this.named = [];
    this.landmarks = [];
    this.route = [];
    this.routeS = [];
    this.routeLen = 0;
    this.turns = [];
    this.waypoint = null;
    this.banner.textContent = '';
    this.bannerHtml = '';
    this.last = 0;
  }

  /** Set real-life city landmark labels (game frame x east, y north) shown on the expanded interactive map. */
  setLandmarks(list: Landmark[]) {
    this.landmarks = list;
  }

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

  private streetAt(x: number, y: number) {
    let best = '', bd = 30 * 30;
    for (const n of this.named) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; best = n.name; } }
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
        this.turns.push({ s: this.routeS[(i + 1) % n], dir: d > 0 ? -1 : 1, sharp: Math.abs(d) > 2.6, name: this.streetAt(after.x, after.y) });   // sharp: hairpins only (> 150 deg)
        i += 8;
      } else i++;
    }
  }

  /** Route point at arc length s, written into `out` (reused: 75 calls per draw). */
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
    if (!this.sizeCache) this.sizeCache = this.el.clientWidth;
    const dpr = Math.min(2, devicePixelRatio || 1), size = this.sizeCache || (this.expanded ? 540 : 180);
    if (this.cv.width !== Math.round(size * dpr)) { this.cv.width = this.cv.height = Math.round(size * dpr); }
    const c = this.ctx, r = size / 2;
    const cx = car.x, cy = -car.z, hx = fwd.x, hy = -fwd.z;           // game frame
    const theta = Math.atan2(hy, hx);
    if (this.expanded) {
      this.zoom = 3.8;
    } else {
      this.zoom += (Math.min(3.2, 1.3 + speed * 0.035) - this.zoom) * 0.15;   // zoom out at speed
    }
    const k = 1 / this.zoom;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);
    c.save();
    if (this.expanded) {
      c.beginPath(); c.rect(0, 0, size, size); c.clip();
      c.fillStyle = 'rgba(6, 9, 16, 0.94)'; c.fillRect(0, 0, size, size);
      // North-up full map centred on the player
      c.translate(r, r);
      c.scale(k, -k);
    } else {
      // round watch face
      c.beginPath(); c.arc(r, r, r - 1, 0, Math.PI * 2); c.clip();
      const glass = c.createRadialGradient(r * 0.9, r * 0.6, 0, r, r, size * 0.72);
      glass.addColorStop(0, '#121b2a'); glass.addColorStop(0.55, '#0a111c'); glass.addColorStop(1, '#04070c');
      c.fillStyle = glass; c.fillRect(0, 0, size, size);
      // world -> canvas: translate to the car, rotate so the car points up, scale, flip y
      c.translate(r, r * 1.18);
      c.scale(k, -k);
      c.rotate(Math.PI / 2 - theta);
    }
    c.translate(-cx, -cy);
    const reach = (r * 1.7) * this.zoom, c0x = Math.floor((cx - reach) / CELL), c1x = Math.floor((cx + reach) / CELL);
    const c0y = Math.floor((cy - reach) / CELL), c1y = Math.floor((cy + reach) / CELL);
    c.lineCap = 'round'; c.lineJoin = 'round';
    // minor streets first, then the major ones over them; within a tier one path per stroke width (same colour and
    // width as one stroke per segment, without hundreds of separate stroke calls per draw)
    const byWidth = this.byWidth, pool = this.segPool;
    for (let tier = 0; tier < 2; tier++) {
      const major = tier === 1;
      const stamp = ++this.drawStamp, minW = (major ? 3.2 : 2.2) * this.zoom;
      for (let gx = c0x; gx <= c1x; gx++) for (let gy = c0y; gy <= c1y; gy++) {
        const list = this.grid.get(`${gx}_${gy}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (s.major !== major || s.stamp === stamp) continue;
          s.stamp = stamp;
          const lw = Math.max(s.w * 0.85, minW);
          let bucket = byWidth.get(lw);
          if (!bucket) byWidth.set(lw, (bucket = pool.pop() ?? []));
          bucket.push(s);
        }
      }
      const casing = major ? 'rgba(2, 5, 10, 0.9)' : 'rgba(2, 5, 10, 0.55)';
      const fill = major ? 'rgba(232, 240, 252, 0.95)' : 'rgba(158, 172, 196, 0.66)';
      for (const [lw, bucket] of byWidth) {
        c.beginPath();
        for (let i = 0; i < bucket.length; i++) { const s = bucket[i]; c.moveTo(s.x0, s.y0); c.lineTo(s.x1, s.y1); }
        c.strokeStyle = casing; c.lineWidth = lw + Math.max(1.2, 1.6 * this.zoom); c.stroke();
        c.strokeStyle = fill; c.lineWidth = lw; c.stroke();
        bucket.length = 0;
        pool.push(bucket);
      }
      byWidth.clear();
    }
    // the GPS line: the whole route faint, the next 600 m bright
    if (this.route.length > 1) {
      c.strokeStyle = 'rgba(0, 0, 0, 0.55)'; c.lineWidth = Math.max(8, 9 * this.zoom);
      c.beginPath();
      for (let i = 0; i < this.route.length; i++) { const p = this.route[i]; if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }
      if (this.routeClosed) c.closePath();
      c.stroke();
      if (routeS !== null) {
        c.beginPath();
        for (let d = 0; d <= 600; d += 8) { const p = this.routeAt(routeS + d, this.rp); if (d) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y); }
        // the glow: two wider translucent strokes under the line (was shadowBlur 8, a Gaussian blur of the canvas on
        // every draw); widths in css px times zoom, ~7 px and ~3.5 px of halo each side like the 8 px blur
        const lw = Math.max(5, 7 * this.zoom);
        c.strokeStyle = 'rgba(255, 255, 255, 0.18)'; c.lineWidth = lw + 14 * this.zoom; c.stroke();
        c.strokeStyle = 'rgba(255, 255, 255, 0.35)'; c.lineWidth = lw + 7 * this.zoom; c.stroke();
        c.strokeStyle = '#f2f7ff'; c.lineWidth = lw; c.stroke();
      }
      // direction chevrons on the next stretch, like a real nav
      if (routeS !== null && this.routeLen > 0) {
        c.fillStyle = '#ffffff'; c.strokeStyle = 'rgba(2, 5, 10, 0.85)'; c.lineWidth = 1.1 * this.zoom;
        const sz = 6.5 * this.zoom;
        for (let d = 28; d <= 600; d += 58) {
          const p = this.routeAt(routeS + d, { x: 0, y: 0 });
          const q = this.routeAt(routeS + d + 7, { x: 0, y: 0 });
          const a = Math.atan2(q.y - p.y, q.x - p.x);
          c.save(); c.translate(p.x, p.y); c.rotate(a);
          c.beginPath(); c.moveTo(sz, 0); c.lineTo(-sz * 0.65, sz * 0.72); c.lineTo(-sz * 0.2, 0); c.lineTo(-sz * 0.65, -sz * 0.72); c.closePath();
          c.fill(); c.stroke(); c.restore();
        }
      }
      // start / finish
      const s0 = this.route[0];
      c.fillStyle = '#fff'; c.fillRect(s0.x - 4 * this.zoom, s0.y - 4 * this.zoom, 8 * this.zoom, 8 * this.zoom);
      c.fillStyle = '#000'; c.fillRect(s0.x - 4 * this.zoom, s0.y - 4 * this.zoom, 4 * this.zoom, 4 * this.zoom); c.fillRect(s0.x, s0.y, 4 * this.zoom, 4 * this.zoom);
    }
    // landmarks near the car as small points of interest
    if (this.landmarks.length) {
      c.save();
      c.fillStyle = 'rgba(236, 244, 255, 0.85)'; c.strokeStyle = 'rgba(2, 5, 10, 0.8)'; c.lineWidth = 0.8 * this.zoom;
      for (const lm of this.landmarks) {
        if (Math.abs(lm.x - cx) > (r * 1.7) * this.zoom || Math.abs(lm.y - cy) > (r * 1.7) * this.zoom) continue;
        c.beginPath(); c.arc(lm.x, lm.y, 2.1 * this.zoom, 0, Math.PI * 2); c.fill(); c.stroke();
      }
      c.restore();
    }
    // rivals / players
    for (const o of others) {
      c.fillStyle = o.color; c.beginPath(); c.arc(o.x, -o.z, 4.2 * this.zoom, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 1.2 * this.zoom; c.stroke();
    }
    // GPS Waypoint pin + straight-line guide
    if (this.waypoint) {
      const wx = this.waypoint.x, wy = -this.waypoint.z;
      c.strokeStyle = 'rgba(255, 196, 0, 0.78)';
      c.lineWidth = 2.6 * this.zoom;
      c.setLineDash([8 * this.zoom, 6 * this.zoom]);
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(wx, wy); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#ffc400';
      c.beginPath(); c.arc(wx, wy, 6.2 * this.zoom, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#000'; c.lineWidth = 1.8 * this.zoom; c.stroke();
    }
    c.restore();
    // the car: a soft heading cone, then the arrow (screen space)
    c.save();
    c.translate(r, this.expanded ? r : r * 1.18);
    if (this.expanded) c.rotate(Math.PI / 2 - theta);
    const cone = c.createRadialGradient(0, 0, 0, 0, 0, 54);
    cone.addColorStop(0, 'rgba(96, 200, 255, 0.40)');
    cone.addColorStop(0.5, 'rgba(96, 200, 255, 0.11)');
    cone.addColorStop(1, 'rgba(96, 200, 255, 0)');
    c.fillStyle = cone;
    c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 54, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); c.closePath(); c.fill();
    c.restore();
    c.save();
    c.translate(r, this.expanded ? r : r * 1.18);
    if (this.expanded) c.rotate(Math.PI / 2 - theta);
    c.fillStyle = '#fff'; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, -9); c.lineTo(6.5, 7); c.lineTo(0, 3.5); c.lineTo(-6.5, 7); c.closePath(); c.fill(); c.stroke();
    c.restore();
    // north tick + real-life landmark labels on expanded map
    if (this.expanded) {
      if (this.landmarks.length) {
        c.font = '700 10px Inter, system-ui, sans-serif';
        c.textAlign = 'center';
        for (const lm of this.landmarks) {
          const sx = r + (lm.x - cx) * k;
          const sy = r - (lm.y - cy) * k;
          if (sx < 24 || sx > size - 24 || sy < 28 || sy > size - 16) continue;
          c.fillStyle = 'rgba(0, 229, 255, 0.9)';
          c.beginPath(); c.arc(sx, sy, 3.2, 0, Math.PI * 2); c.fill();
          c.fillStyle = 'rgba(6, 9, 16, 0.75)';
          const tw = c.measureText(lm.name).width + 8;
          c.fillRect(sx - tw / 2, sy - 18, tw, 13);
          c.fillStyle = '#e0f7ff';
          c.fillText(lm.name, sx, sy - 8);
        }
      }
      c.save(); c.translate(size - 22, 22); c.fillStyle = '#e8f4ff'; c.font = '800 12px Inter, system-ui, sans-serif';
      c.textAlign = 'center'; c.fillText('N', 0, 4);
      c.strokeStyle = 'rgba(232, 244, 255, 0.5)'; c.lineWidth = 1.2; c.beginPath(); c.arc(0, 0, 11, 0, Math.PI * 2); c.stroke(); c.restore();
    } else {
      c.save(); c.translate(r, r); c.rotate(-(Math.PI / 2 - theta)); c.fillStyle = 'rgba(255,255,255,0.7)'; c.font = '700 10px Inter, system-ui, sans-serif';
      c.textAlign = 'center'; c.fillText('N', 0, -r + 13); c.restore();
    }
    // turn-by-turn, active GPS Waypoint, or live current street name banner
    const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    let txt = '';
    if (this.waypoint) {
      const wd = Math.round(Math.hypot(this.waypoint.x - car.x, this.waypoint.z - car.z));
      txt = `<b>📍</b> <span>GPS WAYPOINT</span> <i>${wd} m</i>`;
    } else if (routeS !== null && this.turns.length) {
      const s = ((routeS % this.routeLen) + this.routeLen) % this.routeLen;
      let next: Turn | null = null, dist = Infinity;
      for (const t of this.turns) { let d = t.s - s; if (d < -5) d += this.routeLen; if (d >= -5 && d < dist) { dist = d; next = t; } }
      if (next && dist < 900) {
        const arrow = next.sharp ? (next.dir < 0 ? '↶' : '↷') : (next.dir < 0 ? '↰' : '↱');
        // compact: arrow + distance; the street name lives in the pill below
        txt = `<b>${arrow}</b> <i>${dist < 30 ? 'now' : `${Math.round(dist / 10) * 10} m`}</i>`;
      }
    }
    if (!txt) {
      const curStreet = this.streetAt(cx, cy);
      if (curStreet) txt = `<span>${esc(curStreet)}</span>`;
    }
    if (this.bannerHtml !== txt) { this.banner.innerHTML = this.bannerHtml = txt; this.banner.hidden = !txt; }
    this.dirty = true;
    // watch face: speed, ETA chip, current street pill
    if (this.speedEl) this.speedEl.textContent = String(Math.round(Math.abs(speed) * 3.6));
    const remain = routeS !== null && this.routeLen > 0 ? Math.max(0, this.routeLen - routeS) : null;
    const mins = remain !== null ? Math.max(1, Math.round(remain / Math.max(4, speed) / 60)) : null;
    if (this.etaChip) {
      const etaTxt = remain === null ? '' : remain < 120 ? 'Arriving' : `${mins}m · ${(remain / 1000).toFixed(1)}km`;
      this.etaChip.hidden = !etaTxt;
      if (etaTxt && this.etaChip.textContent !== etaTxt) this.etaChip.textContent = etaTxt;
    }
    if (this.pillEl) {
      const street = this.streetAt(cx, cy);
      const pillTxt = street || 'Centre vehicle';
      if (this.pillEl.textContent !== pillTxt) this.pillEl.textContent = pillTxt;
    }
    // OEM nav: remaining route distance and ETA, live from the route and the current speed
    if (this.footEta) {
      let eta = '';
      if (this.waypoint) eta = 'WAYPOINT';
      else if (routeS !== null && this.routeLen > 0) {
        const remain = Math.max(0, this.routeLen - routeS);
        const min = remain / Math.max(4, speed) / 60;
        eta = remain > 950 ? `${(remain / 1000).toFixed(1)} km · ${Math.max(1, Math.round(min))} min` : `${Math.round(remain / 10) * 10} m`;
      }
      if (this.footEta.textContent !== eta) this.footEta.textContent = eta;
    }
    // scale bar: 34 css px of the bar at the current zoom, rounded to a readable distance
    if (this.footScale) {
      const m = 34 * this.zoom;
      const nice = m >= 500 ? Math.round(m / 100) * 100 : m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10;
      const label = nice >= 1000 ? `${(nice / 1000).toFixed(1)} km` : `${nice} m`;
      if (this.footScale.textContent !== label) this.footScale.textContent = label;
    }
  }

  show(on: boolean) { this.visible = on; this.el.hidden = !on; }
}
