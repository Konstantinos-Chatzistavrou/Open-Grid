"""Shared tile library for the city builds (New York first; CITY=<id> picks another, see cities.json) (see docs/nyc_tiles.md). Used by ground.py, buildings.py, props.py and build_tiles.py.

Frame: metres, x east, y north, z up, origin Times Square (extract.py). Tile grid 256 m: tile (ix, iy) covers [ix*256, (ix+1)*256) x [iy*256, ...).
glTF is Y-up: a game-frame point (x, y, z) is written as (x, z, -y) (the same mapping the game uses: three.js position = (x, z, -y)), relative to the
tile origin (ix*256, iy*256) so float32/quantised positions stay precise anywhere on the island.
"""
import json, math, os, struct
from dataclasses import dataclass, field

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
# Which city: CITY=<id> (tools/nyc/cities.json); New York is the default so every older command works unchanged.
CITIES = json.load(open(os.path.join(os.path.dirname(__file__), "cities.json")))
CITY_ID = os.environ.get("CITY", "nyc")
if CITY_ID not in CITIES:
    raise SystemExit(f"unknown CITY={CITY_ID}: one of {', '.join(k for k in CITIES if not k.startswith('_'))}")
CITY = CITIES[CITY_ID]
D = os.environ.get("NYC_DATA") or os.path.join(ROOT, CITY["data"])
if not os.path.isdir(os.path.join(D, "derived")):   # git worktrees do not have the (gitignored) data: use the main checkout's
    import subprocess   # the main checkout is the parent of git's common directory
    try:
        common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=ROOT,
                                capture_output=True, text=True, check=True).stdout.strip()
        alt = os.path.join(os.path.dirname(common), CITY["data"])
        if os.path.isdir(os.path.join(alt, "derived")):
            D = alt
    except (OSError, subprocess.CalledProcessError):
        pass
DERIVED = os.path.join(D, "derived")
OUT_TILES = os.path.join(ROOT, CITY["out"])
# per-tile road graphs: build-time only (routes, map.json, spawn), so they are not published with the tiles
GRAPH_DIR = os.path.join(DERIVED, "graphs")
MASK_FILE = "manhattan_mask.json" if CITY.get("mask") == "manhattan" else "mask.json"
TILE = 256.0


def tile_of(x, y):
    return int(math.floor(x / TILE)), int(math.floor(y / TILE))


def tile_bounds(ix, iy):
    return ix * TILE, iy * TILE, (ix + 1) * TILE, (iy + 1) * TILE


def tile_name(ix, iy):
    return f"{ix}_{iy}"


def read_ndjson(name):
    with open(os.path.join(DERIVED, name)) as f:
        for line in f:
            yield json.loads(line)


def manhattan_polygon(buffer_m=60.0):
    """Shapely polygon of the built area (+ buffer) in the game frame: Manhattan's outline for New York, the city's `area` box elsewhere
    (derived/manhattan_mask.json or derived/mask.json, from mask.py)."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    mask = json.load(open(os.path.join(DERIVED, MASK_FILE)))
    return unary_union([Polygon(p[0], p[1:]) for p in mask]).buffer(buffer_m)


def mask_polygon(buffer_m=60.0):
    return manhattan_polygon(buffer_m)


FRINGE = float(CITY.get("fringe_m", 200.0))   # area cities: real buildings/ground this far beyond the drivable box (a city, not a cliff, behind the barrier)


def drive_box():
    """Area cities: the drivable box (game frame) = derived/drive.json (mask.py). None for Manhattan (the island is the limit)."""
    p = os.path.join(DERIVED, "drive.json")
    if CITY.get("mask") == "manhattan" or not os.path.exists(p):
        return None
    from shapely.geometry import Polygon
    return Polygon(json.load(open(p)))


def land_polygon():
    """Land before OSM water is cut out: Manhattan's outline, or (area cities) the content box with a wide margin so no tile
    ever shows 'sea' beyond the built area."""
    if CITY.get("mask") == "manhattan":
        return manhattan_polygon(0).buffer(0)
    return manhattan_polygon(0).buffer(FRINGE + 400.0)


def drivable(land, asphalt, bounds):
    """Where a car may be, inside `bounds` (shapely box): land (water and piers already applied by the caller), plus bridge
    decks (asphalt over water) inside the drive box for area cities; clipped to the drive box. Manhattan: land only (its
    bridges and tunnels lead off the built area: blocked at the shore)."""
    db = drive_box()
    if db is None:   # Manhattan: asphalt hanging over the river within 40 m of the shore (FDR Drive, bridge approaches) still counts
        D = land
        if asphalt is not None and not asphalt.is_empty:
            D = D.union(asphalt.difference(land).intersection(land.buffer(40.0)))
        return D.intersection(bounds).buffer(0)
    D = land.intersection(db)
    if asphalt is not None and not asphalt.is_empty:
        D = D.union(asphalt.intersection(db).difference(land))
    return D.intersection(bounds).buffer(0)


def edge_walls(D, T, height=2.6, thick=0.5, step=24.0):
    """Invisible wall boxes along the boundary of the drivable area D that lies inside tile box T: [{cx,cy,z0,z1,hx,hy,yaw}]
    (the col.json box format), each just outside D. Long runs are cut into <= step m pieces."""
    from shapely.geometry import LineString, MultiLineString, GeometryCollection
    out = []
    if D.is_empty:
        return out
    b = D.boundary.intersection(T)
    lines = []
    def walk(g):
        if isinstance(g, LineString):
            lines.append(g)
        elif isinstance(g, (MultiLineString, GeometryCollection)):
            for q in g.geoms:
                walk(q)
    walk(b)
    for ln in lines:
        ln = ln.simplify(0.4)
        c = list(ln.coords)
        for (ax, ay), (bx, by) in zip(c, c[1:]):
            L = math.hypot(bx - ax, by - ay)
            if L < 0.3:
                continue
            n = max(1, int(math.ceil(L / step)))
            ux, uy = (bx - ax) / L, (by - ay) / L
            for k in range(n):
                s0, s1 = L * k / n, L * (k + 1) / n
                mx, my = ax + ux * (s0 + s1) / 2, ay + uy * (s0 + s1) / 2
                # outside = the side of the segment that is not in D
                nx, ny = -uy, ux
                if D.contains(_pt(mx + nx * 0.6, my + ny * 0.6)):
                    nx, ny = -nx, -ny
                out.append({"cx": round(mx + nx * thick, 2), "cy": round(my + ny * thick, 2), "z0": -1.0, "z1": height,
                            "hx": round((s1 - s0) / 2 + thick, 2), "hy": thick, "yaw": round(math.atan2(uy, ux), 4)})
    return out


def _pt(x, y):
    from shapely.geometry import Point
    return Point(x, y)


class World:
    """All derived data inside the Manhattan mask, with a spatial index per layer. Query by tile: world.buildings_in(bounds, margin)."""

    def __init__(self, layers=("buildings", "roads", "areas", "nodes", "rails")):
        from shapely.geometry import LineString, Point, Polygon
        from shapely.prepared import prep
        from shapely.strtree import STRtree
        self.mask = manhattan_polygon()
        pm = prep(self.mask)
        self.items = {}
        self.geoms = {}
        self.trees = {}

        def polygon(rings):
            p = Polygon(rings[0], rings[1:])
            return p if p.is_valid else p.buffer(0)

        for layer in layers:
            items, geoms = [], []
            for d in read_ndjson(layer + ".ndjson"):
                if layer == "buildings" or layer == "areas":
                    g = polygon(d["rings"])
                    if g.is_empty:
                        continue
                    c = g.representative_point()
                elif layer == "nodes":
                    g = Point(d["x"], d["y"]); c = g
                else:
                    g = LineString(d["pts"]); c = g.interpolate(0.5, normalized=True)
                if not pm.contains(c):
                    continue
                items.append(d); geoms.append(g)
            self.items[layer], self.geoms[layer] = items, geoms
            self.trees[layer] = STRtree(geoms)

    def query(self, layer, bounds, margin=0.0):
        """[(item, shapely_geom)] whose bbox touches the tile bounds expanded by margin metres."""
        from shapely.geometry import box
        x0, y0, x1, y1 = bounds
        idx = self.trees[layer].query(box(x0 - margin, y0 - margin, x1 + margin, y1 + margin))
        return [(self.items[layer][i], self.geoms[layer][i]) for i in idx]

    def tiles_with_content(self):
        """Set of (ix, iy) that contain any building centroid, road or area (what build_tiles generates)."""
        t = set()
        for layer in ("buildings", "areas"):
            for g in self.geoms[layer]:
                x0, y0, x1, y1 = g.bounds
                for ix in range(int(math.floor(x0 / TILE)), int(math.floor(x1 / TILE)) + 1):
                    for iy in range(int(math.floor(y0 / TILE)), int(math.floor(y1 / TILE)) + 1):
                        t.add((ix, iy))
        for g in self.geoms["roads"]:
            if g is None:
                continue
            x0, y0, x1, y1 = g.bounds
            for ix in range(int(math.floor(x0 / TILE)), int(math.floor(x1 / TILE)) + 1):
                for iy in range(int(math.floor(y0 / TILE)), int(math.floor(y1 / TILE)) + 1):
                    t.add((ix, iy))
        return t


@dataclass
class Mesh:
    """One draw primitive. Arrays are in the GAME frame (z up), world metres; write_glb converts and makes them tile-local."""
    material: str
    pos: np.ndarray                      # (N,3) float
    idx: np.ndarray                      # (M,3) int triangles (CCW seen from outside)
    normal: np.ndarray | None = None     # (N,3) float; computed from triangles when None
    uv: np.ndarray | None = None         # (N,2) float
    color: np.ndarray | None = None      # (N,4) float 0..1 (vertex colour: baked AO, tint, ...)
    extra: dict = field(default_factory=dict)   # custom attributes, name -> (N,k) float32, written as _NAME (e.g. "BLD")


def compute_normals(pos, idx):
    n = np.zeros_like(pos, dtype=np.float64)
    a, b, c = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, idx[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln == 0] = 1
    return (n / ln).astype(np.float32)


def _pad4(b):
    return b + b"\x00" * (-len(b) % 4)


def write_glb(path, meshes, tile, name="tile"):
    """Minimal GLB: one node at the tile origin, one mesh, one primitive per Mesh (material by NAME: the game maps names to its materials)."""
    ox, oy = tile[0] * TILE, tile[1] * TILE
    bin_chunks, views, accs, prims, mats, matidx = [], [], [], [], [], {}
    off = 0

    def add(arr, target, ctype, ncomp, norm=False, minmax=False):
        nonlocal off
        raw = _pad4(np.ascontiguousarray(arr).tobytes())
        views.append({"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes, **({"target": target} if target else {})})
        bin_chunks.append(raw); off += len(raw)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": int(arr.shape[0]), "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[ncomp]}
        if norm:
            acc["normalized"] = True
        if minmax:
            acc["min"] = [float(v) for v in arr.min(axis=0)]; acc["max"] = [float(v) for v in arr.max(axis=0)]
        accs.append(acc)
        return len(accs) - 1

    for m in meshes:
        if len(m.idx) == 0:
            continue
        p = np.asarray(m.pos, dtype=np.float64)
        g = np.stack([p[:, 0] - ox, p[:, 2], -(p[:, 1] - oy)], axis=1).astype(np.float32)   # game (x,y,z) -> glTF (x, z, -y), tile-local
        nrm = m.normal if m.normal is not None else compute_normals(np.asarray(m.pos, dtype=np.float64), m.idx)
        nrm = np.stack([nrm[:, 0], nrm[:, 2], -nrm[:, 1]], axis=1).astype(np.float32)
        idx = np.asarray(m.idx, dtype=np.uint32).reshape(-1)
        # the (x,y,z)->(x,z,-y) mapping is a proper rotation (det +1): triangle winding is preserved
        attrs = {"POSITION": add(g, 34962, 5126, 3, minmax=True), "NORMAL": add(nrm, 34962, 5126, 3)}
        if m.uv is not None:
            attrs["TEXCOORD_0"] = add(np.asarray(m.uv, dtype=np.float32), 34962, 5126, 2)
        if m.color is not None:
            attrs["COLOR_0"] = add((np.clip(m.color, 0, 1) * 255 + 0.5).astype(np.uint8), 34962, 5121, 4, norm=True)
        for k, v in m.extra.items():
            v = np.asarray(v, dtype=np.float32)
            attrs["_" + k.upper()] = add(v, 34962, 5126, v.shape[1])
        # indices accessor (SCALAR): built by hand because add() assumes 2-D arrays
        raw = _pad4(idx.tobytes())
        views.append({"buffer": 0, "byteOffset": off, "byteLength": idx.nbytes, "target": 34963}); bin_chunks.append(raw); off += len(raw)
        accs.append({"bufferView": len(views) - 1, "componentType": 5125, "count": int(idx.size), "type": "SCALAR"})
        if m.material not in matidx:
            matidx[m.material] = len(mats); mats.append({"name": m.material})
        prims.append({"attributes": attrs, "indices": len(accs) - 1, "material": matidx[m.material]})
    gltf = {"asset": {"version": "2.0", "generator": "NightRun tools/nyc/tilelib.py", "extras": {"tile": list(tile), "origin_m": [ox, oy]}},
            "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"name": name, "mesh": 0, "translation": [ox, 0.0, -oy]}],
            "meshes": [{"name": name, "primitives": prims}], "materials": mats, "accessors": accs, "bufferViews": views, "buffers": [{"byteLength": off}]}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bn = b"".join(bin_chunks)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(bn)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(bn), 0x004E4942)); f.write(bn)
    return os.path.getsize(path)
