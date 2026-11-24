// Building footprints for the GPS: the oriented boxes the city tiles already ship for collision (`<ix>_<iy>.col.json`,
// game frame: x east, y north, each {cx, cy, hx, hy, yaw, z0, z1}). The GPS extrudes them into the light 3D blocks a
// navigation map shows at street zoom. Tiles are fetched on demand around the car and kept in a small LRU; a city
// without tiles simply has no buildings.

export interface BuildingTile {
  ix: number;
  iy: number;
  /** per building 7 floats: cx, cy, hx, hy, cos(yaw), sin(yaw), height */
  d: Float32Array;
  n: number;
  used: number;
}

const MAX_TILES = 30;

export class NavBuildings {
  private base = '';
  private size = 256;
  private avail: Set<string> | null = null;
  private tiles = new Map<string, BuildingTile | null>();
  private pending = 0;
  private gen = 0;
  private tick = 0;

  /** Point at a city's tile folder (the URL that holds index.json, map.json and the tile files). */
  setBase(base: string) {
    this.clear();
    this.base = base;
    const gen = this.gen;
    fetch(base + 'index.json').then((r) => (r.ok ? r.json() : null)).then((idx) => {
      if (gen !== this.gen || !idx || !idx.tiles) return;
      this.size = idx.tile || 256;
      const s = new Set<string>();
      for (const k of Object.keys(idx.tiles)) {
        const files: string[] = idx.tiles[k].files ?? [];
        if (files.some((f) => f.endsWith('.col.json'))) s.add(k);
      }
      this.avail = s;
    }).catch(() => { /* no index: no buildings */ });
  }

  clear() {
    this.gen++;
    this.tiles.clear();
    this.avail = null;
    this.base = '';
    this.pending = 0;
  }

  /** Make sure the tiles within r metres of (x, y) are loading or loaded. */
  ensure(x: number, y: number, r: number) {
    if (!this.avail || !this.base) return;
    const S = this.size;
    const ix0 = Math.floor((x - r) / S), ix1 = Math.floor((x + r) / S);
    const iy0 = Math.floor((y - r) / S), iy1 = Math.floor((y + r) / S);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const key = `${ix}_${iy}`;
        if (this.tiles.has(key) || !this.avail.has(key) || this.pending >= 3) continue;
        this.load(key, ix, iy);
      }
    }
    if (this.tiles.size > MAX_TILES) this.evict(x, y);
  }

  private load(key: string, ix: number, iy: number) {
    const gen = this.gen;
    this.tiles.set(key, null);   // marks "loading" so it is not requested twice
    this.pending++;
    fetch(`${this.base}${key}.col.json`).then((r) => (r.ok ? r.json() : null)).then((c) => {
      this.pending--;
      if (gen !== this.gen) return;
      const list: { cx: number; cy: number; hx: number; hy: number; yaw: number; z0: number; z1: number }[] = c?.buildings ?? [];
      const d = new Float32Array(list.length * 7);
      let n = 0;
      for (const b of list) {
        const h = b.z1 - (b.z0 || 0);
        if (!(h > 1) || !(b.hx > 0.5) || !(b.hy > 0.5)) continue;
        const o = n * 7;
        d[o] = b.cx; d[o + 1] = b.cy; d[o + 2] = b.hx; d[o + 3] = b.hy;
        d[o + 4] = Math.cos(b.yaw); d[o + 5] = Math.sin(b.yaw); d[o + 6] = h;
        n++;
      }
      this.tiles.set(key, { ix, iy, d, n, used: ++this.tick });
    }).catch(() => { this.pending--; if (gen === this.gen) this.tiles.set(key, { ix, iy, d: new Float32Array(0), n: 0, used: ++this.tick }); });
  }

  private evict(x: number, y: number) {
    const S = this.size;
    let worstKey = '', worst = -1;
    for (const [k, t] of this.tiles) {
      if (!t) continue;
      const d = Math.hypot((t.ix + 0.5) * S - x, (t.iy + 0.5) * S - y);
      if (d > worst) { worst = d; worstKey = k; }
    }
    if (worstKey) this.tiles.delete(worstKey);
  }

  /** Every loaded tile (callers cull per building). */
  forEachTile(cb: (t: BuildingTile) => void) {
    for (const t of this.tiles.values()) if (t && t.n) cb(t);
  }
}
