// The city's real ground heights (tools/nyc/terrain.py -> <tiles>/terrain.bin + index.json `terrain`; docs/cities.md
// "Terrain"). One grid, the same one the pipeline draped the ground and seated the buildings on: int16 centimetres, 8 m
// spacing, aligned to the 256 m tiles, row j = y0 + j * step going north, column i = x0 + i * step going east (game frame:
// x east, y north; three.js z = -y). A flat city has no terrain block and every height is the tile's `ground` as before.
import RAPIER from '@dimforge/rapier3d-compat';

export interface TerrainMeta {
  file: string;
  x0: number;
  y0: number;
  step: number;
  nx: number;
  ny: number;
  scale: number;
  seaLevel?: number;
  min?: number;
  max?: number;
}

export class Terrain {
  private constructor(readonly meta: TerrainMeta, private h: Int16Array) {}

  static async load(base: string, meta: TerrainMeta, query = ''): Promise<Terrain | null> {
    try {
      const r = await fetch(base + meta.file + query);
      if (!r.ok) throw new Error(`${r.status}`);
      const buf = await r.arrayBuffer();
      if (buf.byteLength < meta.nx * meta.ny * 2) throw new Error(`short (${buf.byteLength} B)`);
      return new Terrain(meta, new Int16Array(buf, 0, meta.nx * meta.ny));
    } catch (e) {
      console.warn('nyc: terrain.bin not loaded, the city is flat this session', e);
      return null;
    }
  }

  /** ground height (m) at game-frame (x east, y north): bilinear, like the pipeline's terrain.H */
  at(x: number, y: number): number {
    const m = this.meta, s = m.scale;
    const fx = Math.min(m.nx - 1.001, Math.max(0, (x - m.x0) / m.step));
    const fy = Math.min(m.ny - 1.001, Math.max(0, (y - m.y0) / m.step));
    const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j, nx = m.nx, h = this.h;
    const a = h[j * nx + i], b = h[j * nx + i + 1], c = h[(j + 1) * nx + i], d = h[(j + 1) * nx + i + 1];
    return s * (a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay);
  }

  /** ground height at a three.js position (x, z) */
  atThree(x: number, z: number): number { return this.at(x, -z); }

  /**
   * The physics ground of tile (ix, iy) (size `tile` m): a Rapier height field over exactly that tile, sampled on the
   * grid's own points (one cell edge per grid line, so neighbouring tiles share their edge heights: no seams).
   * Rapier: rows along z, columns along x, column-major, centred on the collider's translation.
   */
  tileCollider(ix: number, iy: number, tile: number): RAPIER.ColliderDesc {
    const m = this.meta, cells = Math.round(tile / m.step), n = cells + 1;
    const heights = new Float32Array(n * n);
    for (let c = 0; c < n; c++) {            // column: x = ix * tile + c * step
      for (let r = 0; r < n; r++) {          // row: three z from -(iy+1)*tile (north edge) southwards = frame y from (iy+1)*tile down
        heights[r + c * n] = this.at(ix * tile + c * m.step, (iy + 1) * tile - r * m.step);
      }
    }
    return RAPIER.ColliderDesc.heightfield(cells, cells, heights, { x: tile, y: 1, z: tile })
      .setTranslation(ix * tile + tile / 2, 0, -(iy * tile + tile / 2));
  }
}
