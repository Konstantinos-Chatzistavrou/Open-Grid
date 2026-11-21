// Strict runtime pavement filter for streamed city tiles:
// Rasterizes each tile's actual drawn ground.glb meshes ('road', 'curb', 'water', 'rail', 'sidewalk', 'plaza', 'grass')
// and ground-floor bld.glb footprints into a reusable 256 x 256 (1 m) bitmask (< 0.35 ms/tile, zero retained RAM).
// Every street prop (trees, lamps, signals, hydrants, benches, bus stops, kiosks, waste bins, subway entrances,
// scaffolds, cones, steam vents) is guaranteed to sit STRICTLY on pavement/park surface — NEVER on road asphalt,
// curbs, water, or inside buildings. Displaced props snap cleanly onto the nearest clear pavement cell (<= 5 m)
// or are dropped if stranded in an intersection/roadway.
import * as THREE from 'three/webgpu';
import type { PropsData } from './props';

const N = 256;
const FLAG_ROAD = 1;
const FLAG_PAVE = 2;
const FLAG_NEAR_1 = 4;   // within 1 m of road/curb/water
const FLAG_NEAR_2 = 8;   // within 2 m of road/curb/water (also clears narrow < 4 m center-road medians/islands!)
const FLAG_BLD = 16;
const FLAG_GRASS = 32;   // park / lawn surface (allows slightly tighter 9 m natural grove spacing vs 12.5 m street trees)

const ROAD_MATS = new Set(['road', 'marking', 'crosswalk', 'curb', 'water', 'rail', 'guardrail']);
const PAVE_MATS = new Set(['sidewalk', 'plaza', 'grass', 'terrain', 'shoulder']);

const STREET_TREE_MIN_DIST = 12.5;
const PARK_TREE_MIN_DIST = 9.0;
const WIDE_PROP_MIN_DIST = 3.2;

function coordHash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// Wide props + street clutter stay >= 2.0 m behind the kerb (keeps all narrow center-road medians & kerb lanes clear!)
const WIDE_KINDS: (keyof PropsData)[] = ['tree', 'bus_stop', 'kiosk', 'bench', 'subway_entrance', 'scaffold', 'cone', 'steam'];
// Slim kerbside poles/fixtures stay >= 1.0 m strictly on pavement (never on asphalt road, curb face, or water).
const SLIM_KINDS: (keyof PropsData)[] = ['lamp', 'signal', 'hydrant', 'waste'];

// Reusable scratch buffers (zero GC churn across thousands of streamed tiles).
const grid = new Uint8Array(N * N);
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();
const vC = new THREE.Vector3();

// Precomputed spiral search offsets out to 5 m (ordered nearest-first) for clean pavement snapping.
const SNAP_OFFSETS: [number, number][] = [];
{
  const list: [number, number, number][] = [];
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > 0 && d2 <= 25) list.push([dx, dy, d2]);
    }
  }
  list.sort((a, b) => a[2] - b[2]);
  for (const [dx, dy] of list) SNAP_OFFSETS.push([dx, dy]);
}

function edgeFn(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function markCell(gx: number, gy: number, flag: number) {
  if (gx >= 0 && gx < N && gy >= 0 && gy < N) grid[gy * N + gx] |= flag;
}

/** Rasterize one triangle in tile-local (0..256) game coordinates into `grid`. */
function rasterTri(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, flag: number) {
  // Always mark vertices & edge midpoints so thin curbs / narrow lanes never slip between 1 m cell centers.
  markCell(Math.floor(ax), Math.floor(ay), flag);
  markCell(Math.floor(bx), Math.floor(by), flag);
  markCell(Math.floor(cx), Math.floor(cy), flag);
  markCell(Math.floor((ax + bx) * 0.5), Math.floor((ay + by) * 0.5), flag);
  markCell(Math.floor((bx + cx) * 0.5), Math.floor((by + cy) * 0.5), flag);
  markCell(Math.floor((cx + ax) * 0.5), Math.floor((cy + ay) * 0.5), flag);

  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(N - 1, Math.floor(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(N - 1, Math.floor(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) return;

  const area = edgeFn(ax, ay, bx, by, cx, cy);
  if (Math.abs(area) < 1e-5) return;
  const invSign = area > 0 ? 1 : -1;

  for (let gy = minY; gy <= maxY; gy++) {
    const py = gy + 0.5;
    const rowOff = gy * N;
    for (let gx = minX; gx <= maxX; gx++) {
      const px = gx + 0.5;
      const e0 = edgeFn(ax, ay, bx, by, px, py) * invSign;
      if (e0 < -0.02) continue;
      const e1 = edgeFn(bx, by, cx, cy, px, py) * invSign;
      if (e1 < -0.02) continue;
      const e2 = edgeFn(cx, cy, ax, ay, px, py) * invSign;
      if (e2 < -0.02) continue;
      grid[rowOff + gx] |= flag;
    }
  }
}

function rasterMesh(mesh: THREE.Mesh, x0: number, y0: number, flag: number, maxHeightY?: number) {
  const geom = mesh.geometry;
  const pos = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const idx = geom.getIndex();
  const mat = mesh.matrixWorld;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    vA.fromBufferAttribute(pos, i0).applyMatrix4(mat);
    vB.fromBufferAttribute(pos, i1).applyMatrix4(mat);
    vC.fromBufferAttribute(pos, i2).applyMatrix4(mat);
    if (maxHeightY !== undefined && vA.y > maxHeightY && vB.y > maxHeightY && vC.y > maxHeightY) continue;
    // Three.js (wx, wy, wz) -> game (x = wx, y = -wz)
    rasterTri(vA.x - x0, -vA.z - y0, vB.x - x0, -vB.z - y0, vC.x - x0, -vC.z - y0, flag);
  }
}

/**
 * Filter & snap a tile's props against the actual drawn `ground` & `bld` meshes BEFORE `prepare()` swaps material names.
 * Returns a sanitized shallow copy of `props` with zero props on asphalt, curbs, water, or inside buildings.
 */
export function filterPropsToPavement(
  groundRoot: THREE.Object3D | null | undefined,
  bldRoot: THREE.Object3D | null | undefined,
  props: unknown,
  ix: number,
  iy: number,
): unknown {
  if (!props || !groundRoot) return props;
  const d = props as PropsData;
  const x0 = ix * N;
  const y0 = iy * N;

  grid.fill(0);
  groundRoot.updateMatrixWorld(true);
  let sawAnyGround = false;
  groundRoot.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const matName = Array.isArray(m.material) ? (m.material[0]?.name ?? '') : (m.material?.name ?? '');
    if (ROAD_MATS.has(matName)) {
      rasterMesh(m, x0, y0, FLAG_ROAD);
      sawAnyGround = true;
    } else if (PAVE_MATS.has(matName)) {
      rasterMesh(m, x0, y0, (matName === 'grass' || matName === 'terrain') ? (FLAG_PAVE | FLAG_GRASS) : FLAG_PAVE);
      sawAnyGround = true;
    }
  });
  if (!sawAnyGround) return props;

  // Rasterize ground-floor building walls/footprints so snapped props are never pushed inside a building.
  if (bldRoot) {
    bldRoot.updateMatrixWorld(true);
    bldRoot.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      rasterMesh(m, x0, y0, FLAG_BLD, 4.5);
    });
  }

  // Dilate FLAG_ROAD by 1 m (FLAG_NEAR_1) and 2 m (FLAG_NEAR_2) so:
  // - slim kerb poles stay >= 1 m strictly on pavement,
  // - trees, benches, shelters, kiosks, scaffolds, cones & steam stay >= 2 m behind the kerb and NEVER spawn on narrow center-road medians!
  for (let gy = 0; gy < N; gy++) {
    const row = gy * N;
    for (let gx = 0; gx < N; gx++) {
      if ((grid[row + gx] & FLAG_ROAD) === 0) continue;
      const yMin = gy > 0 ? gy - 1 : 0;
      const yMax = gy < N - 1 ? gy + 1 : N - 1;
      const xMin = gx > 0 ? gx - 1 : 0;
      const xMax = gx < N - 1 ? gx + 1 : N - 1;
      for (let ny = yMin; ny <= yMax; ny++) {
        const nRow = ny * N;
        for (let nx = xMin; nx <= xMax; nx++) grid[nRow + nx] |= FLAG_NEAR_1;
      }
    }
  }
  for (let gy = 0; gy < N; gy++) {
    const row = gy * N;
    for (let gx = 0; gx < N; gx++) {
      if ((grid[row + gx] & FLAG_NEAR_1) === 0) continue;
      const yMin = gy > 0 ? gy - 1 : 0;
      const yMax = gy < N - 1 ? gy + 1 : N - 1;
      const xMin = gx > 0 ? gx - 1 : 0;
      const xMax = gx < N - 1 ? gx + 1 : N - 1;
      for (let ny = yMin; ny <= yMax; ny++) {
        const nRow = ny * N;
        for (let nx = xMin; nx <= xMax; nx++) grid[nRow + nx] |= FLAG_NEAR_2;
      }
    }
  }

  const out: PropsData = { ...d };

  const filterList = (rows: number[][] | undefined, wide: boolean, isTree = false): number[][] | undefined => {
    if (!rows || !rows.length) return rows;
    const forbid = wide ? (FLAG_ROAD | FLAG_NEAR_1 | FLAG_NEAR_2 | FLAG_BLD) : (FLAG_ROAD | FLAG_NEAR_1 | FLAG_BLD);
    // For trees, sort deterministically by coordinate hash so Poisson thinning is completely stable across reloads.
    const ordered = isTree
      ? rows.slice().sort((a, b) => coordHash(a[0], a[1]) - coordHash(b[0], b[1]))
      : rows;

    // Fast tile-local spatial hash so trees never bunch 0-5 m apart (and snapped kerbside props never pile up on 1 m cells!)
    const cellSize = isTree ? STREET_TREE_MIN_DIST : WIDE_PROP_MIN_DIST;
    const buckets = new Map<number, [number, number, number][]>(); // bucketKey -> [lx, ly, minDist]
    const tooClose = (lx: number, ly: number, minD: number): boolean => {
      const bx = Math.floor(lx / cellSize);
      const by = Math.floor(ly / cellSize);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = buckets.get((by + dy) * 64 + (bx + dx));
          if (!list) continue;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const req = Math.max(minD, p[2]);
            const rx = lx - p[0], ry = ly - p[1];
            if (rx * rx + ry * ry < req * req) return true;
          }
        }
      }
      return false;
    };
    const recordPos = (lx: number, ly: number, minD: number) => {
      const key = Math.floor(ly / cellSize) * 64 + Math.floor(lx / cellSize);
      let list = buckets.get(key);
      if (!list) { list = []; buckets.set(key, list); }
      list.push([lx, ly, minD]);
    };

    const keep: number[][] = [];
    for (const r of ordered) {
      const lx = r[0] - x0;
      const ly = r[1] - y0;
      const gx = Math.floor(lx);
      const gy = Math.floor(ly);
      if (gx < 0 || gx >= N || gy < 0 || gy >= N) continue;

      let finalLx = lx, finalLy = ly, cellFlag = grid[gy * N + gx];
      let valid = (cellFlag & forbid) === 0 && (cellFlag & FLAG_PAVE) !== 0;

      if (!valid) {
        // Try snapping cleanly to the nearest strictly valid clear pavement cell within 5 m (never into a building, road, or existing tree!)
        for (let i = 0; i < SNAP_OFFSETS.length; i++) {
          const nx = gx + SNAP_OFFSETS[i][0];
          const ny = gy + SNAP_OFFSETS[i][1];
          if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
          const nc = grid[ny * N + nx];
          if ((nc & forbid) !== 0 || (nc & FLAG_PAVE) === 0) continue;
          const candLx = nx + 0.5, candLy = ny + 0.5;
          const candMin = isTree ? ((nc & FLAG_GRASS) ? PARK_TREE_MIN_DIST : STREET_TREE_MIN_DIST) : (wide ? WIDE_PROP_MIN_DIST : 0);
          if (candMin > 0 && tooClose(candLx, candLy, candMin)) continue;
          finalLx = candLx; finalLy = candLy; cellFlag = nc; valid = true;
          break;
        }
        if (!valid) continue;
      }

      const minD = isTree ? ((cellFlag & FLAG_GRASS) ? PARK_TREE_MIN_DIST : STREET_TREE_MIN_DIST) : (wide ? WIDE_PROP_MIN_DIST : 0);
      if (minD > 0) {
        if (tooClose(finalLx, finalLy, minD)) continue;
        recordPos(finalLx, finalLy, minD);
      }

      if (finalLx !== lx || finalLy !== ly) {
        const copy = r.slice();
        copy[0] = x0 + finalLx;
        copy[1] = y0 + finalLy;
        keep.push(copy);
      } else {
        keep.push(r);
      }
    }
    return keep;
  };

  for (const k of WIDE_KINDS) {
    if (d[k]) (out as Record<string, unknown>)[k] = filterList(d[k] as number[][] | undefined, true, k === 'tree');
  }
  for (const k of SLIM_KINDS) {
    if (d[k]) (out as Record<string, unknown>)[k] = filterList(d[k] as number[][] | undefined, false, false);
  }
  return out;
}
