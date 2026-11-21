#!/usr/bin/env python3
"""Terrain: real ground heights for a city (cities.json `terrain`, on unless false). docs/cities.md "Terrain".

Source: AWS Terrain Tiles (Terrarium PNG encoding, https://registry.opendata.aws/terrain-tiles/, tilezen/joerd), a
composite of open elevation data: USGS 3DEP/NED (US, bare earth, 3-10 m), SRTM (30 m, most of the world), GMTED, ETOPO1
and national datasets (attribution: CREDITS.md). Fetched once per city into <data>/terrain/ (not committed).

Build (`CITY=<id> python3 terrain.py`, the stage after extract):
  1. z15 tiles over the city box + fringe + 600 m, decoded: h = R*256 + G + B/256 - 32768 (m)
  2. sampled on a 4 m grid in the game frame (the city's transverse Mercator, extract.TR), bilinear
  3. ground-hugging opening (min then max over ~120 m): SRTM is a surface model and a dense downtown reads as a bump
     over its towers; the opening keeps the ground under them (real hills are far wider than 120 m)
  4. Gaussian smoothing (sigma 12 m): smooth, realistic street gradients instead of 30 m data steps
  5. heights relative to the city origin (0 m there: the spawn square sits where the flat city did)
  6. resampled to the EXPORT grid: 8 m, aligned to the 256 m tiles (one cell edge on every tile edge). Everything uses
     this one grid: the pipeline drapes the ground and seats buildings on it, and the game loads it (terrain.bin) for
     its physics height fields and every "how high is the ground here" (props, markers, spawn). One source of truth.
  7. bridge decks baked in: a bridge whose ground dips under it (a river, a valley) gets a straight deck from bank to bank
     instead of following the ground down into the water (overpasses over flat ground keep following it)
  8. a level per water body: the low end of the ground inside it (rivers, harbours and ponds stay flat)
  -> derived/terrain.npz {x0, y0, step, h, h0}, derived/water_levels.json

Use: H(x, y) (arrays or scalars, game frame metres; 0 everywhere when terrain is off), drape(meshes), export_bin(dir).
"""
import json, math, os, sys, urllib.request

import numpy as np

import tilelib as tl

RES = 4.0          # working grid (m)
STEP = 8.0         # export grid (m): 32 cells per 256 m tile
OPEN_M = float(tl.CITY.get("terrain_open_m", 120.0))   # bare-earth opening window (m); 0 where the data is bare earth already (US: 3DEP)
SIGMA_M = 12.0     # smoothing (m)
ZOOM = 15
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
PATH = os.path.join(tl.DERIVED, "terrain.npz")
WATER_PATH = os.path.join(tl.DERIVED, "water_levels.json")

ENABLED = tl.CITY.get("terrain", True) is not False


# ---------------------------------------------------------------- build
def _frame_box(margin):
    from extract import xy
    s, w, n, e = tl.CITY["area"]
    (ax, ay), (bx, by) = xy([w, e], [s, n])
    return min(ax, bx) - margin, min(ay, by) - margin, max(ax, bx) + margin, max(ay, by) + margin


def _tile_xy(lon, lat, z):
    n = 2 ** z
    return (lon + 180.0) / 360.0 * n, (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n


def _fetch(z, tx, ty, cache):
    p = os.path.join(cache, f"{z}_{tx}_{ty}.png")
    if not os.path.exists(p):
        req = urllib.request.Request(URL.format(z=z, x=tx, y=ty), headers={"User-Agent": "opengrid-terrain/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        with open(p + ".part", "wb") as f:
            f.write(data)
        os.replace(p + ".part", p)
    from PIL import Image
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
    return a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0


def _minmax_filter(h, r, fn):
    """separable square min / max filter, radius r cells"""
    out = h
    for axis in (0, 1):
        pad = np.pad(out, [(r, r) if a == axis else (0, 0) for a in (0, 1)], mode="edge")
        acc = None
        for k in range(2 * r + 1):
            sl = [slice(None), slice(None)]
            sl[axis] = slice(k, k + out.shape[axis])
            v = pad[tuple(sl)]
            acc = v.copy() if acc is None else fn(acc, v)
        out = acc
    return out


def _gauss(h, sigma_cells):
    r = int(math.ceil(3 * sigma_cells))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_cells) ** 2); k /= k.sum()
    out = h
    for axis in (0, 1):
        pad = np.pad(out, [(r, r) if a == axis else (0, 0) for a in (0, 1)], mode="edge")
        acc = np.zeros_like(out)
        for i, w in enumerate(k):
            sl = [slice(None), slice(None)]
            sl[axis] = slice(i, i + out.shape[axis])
            acc += w * pad[tuple(sl)]
        out = acc
    return out


def _bilinear(grid, x0, y0, step, x, y):
    fx = np.clip((np.asarray(x, np.float64) - x0) / step, 0, grid.shape[1] - 1.001)
    fy = np.clip((np.asarray(y, np.float64) - y0) / step, 0, grid.shape[0] - 1.001)
    i = np.floor(fx).astype(int); j = np.floor(fy).astype(int); ax = fx - i; ay = fy - j
    return grid[j, i] * (1 - ax) * (1 - ay) + grid[j, i + 1] * ax * (1 - ay) + grid[j + 1, i] * (1 - ax) * ay + grid[j + 1, i + 1] * ax * ay


def _bake_bridges(h, x0, y0):
    """bridge decks over dips: straight from bank to bank (drivable bridges only; the deck is the bridge's own width)"""
    path = os.path.join(tl.DERIVED, "roads.ndjson")
    if not os.path.exists(path):
        return 0
    from shapely.geometry import LineString, Point
    drive = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service",
             "primary_link", "secondary_link", "tertiary_link", "trunk_link", "motorway_link"}
    H0 = lambda x, y: _bilinear(h, x0, y0, STEP, x, y)
    n = 0
    for line in open(path):
        r = json.loads(line)
        if not r.get("bridge") or r.get("hw") not in drive or len(r["pts"]) < 2:
            continue
        P = np.asarray(r["pts"], np.float64)
        L = LineString(P)
        if L.length < 6:
            continue
        ha, hb = float(H0(*P[0])), float(H0(*P[-1]))
        s = np.linspace(0, L.length, max(3, int(L.length / 4)))
        along = np.array([L.interpolate(v).coords[0] for v in s])
        ground = H0(along[:, 0], along[:, 1])
        deck = ha + (hb - ha) * s / L.length
        if float(np.max(deck - ground)) < 1.0:
            continue        # no dip under it: an overpass over flat ground follows the ground like the rest
        half = float(r.get("width") or 10.0) / 2 + STEP          # the deck plus one cell either side (blend into the banks)
        bx0, by0, bx1, by1 = L.bounds
        i0 = max(0, int((bx0 - half - x0) / STEP)); i1 = min(h.shape[1] - 1, int((bx1 + half - x0) / STEP) + 1)
        j0 = max(0, int((by0 - half - y0) / STEP)); j1 = min(h.shape[0] - 1, int((by1 + half - y0) / STEP) + 1)
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                p = Point(x0 + i * STEP, y0 + j * STEP)
                d = L.distance(p)
                if d > half:
                    continue
                t = L.project(p) / L.length
                dh = ha + (hb - ha) * t
                w = 1.0 if d <= half - STEP else (half - d) / STEP        # full deck, then a one-cell ramp to the ground
                if dh > h[j, i]:
                    h[j, i] = h[j, i] + (dh - h[j, i]) * w
        n += 1
    return n


def _water_levels(h, x0, y0):
    path = os.path.join(tl.DERIVED, "areas.ndjson")
    out = []
    if not os.path.exists(path):
        return out
    from shapely.geometry import Polygon
    for line in open(path):
        a = json.loads(line)
        if a.get("kind") != "water" or not a.get("rings"):
            continue
        try:
            poly = Polygon(a["rings"][0], a["rings"][1:]).buffer(0)
        except Exception:
            continue
        if poly.is_empty or poly.area < 20:
            continue
        bx0, by0, bx1, by1 = poly.bounds
        xs = np.linspace(bx0, bx1, 24); ys = np.linspace(by0, by1, 24)
        X, Y = np.meshgrid(xs, ys)
        import shapely
        inside = shapely.contains_xy(poly, X.ravel(), Y.ravel())
        pts = np.column_stack([X.ravel()[inside], Y.ravel()[inside]])
        if len(pts) < 3:
            c = poly.representative_point(); pts = np.array([[c.x, c.y]])
        lvl = float(np.percentile(_bilinear(h, x0, y0, STEP, pts[:, 0], pts[:, 1]), 15))
        out.append({"id": a.get("id"), "level": round(lvl, 2), "rings": a["rings"]})
    return out


def build():
    from extract import TR
    margin = tl.FRINGE + 600.0
    fx0, fy0, fx1, fy1 = _frame_box(margin)
    lons, lats = TR.transform([fx0, fx0, fx1, fx1], [fy0, fy1, fy0, fy1], direction="INVERSE")
    tx0, ty1 = _tile_xy(min(lons), min(lats), ZOOM); tx1, ty0 = _tile_xy(max(lons), max(lats), ZOOM)
    TX0, TX1, TY0, TY1 = int(math.floor(tx0)), int(math.floor(tx1)), int(math.floor(ty0)), int(math.floor(ty1))
    cache = os.path.join(tl.D, "terrain"); os.makedirs(cache, exist_ok=True)
    print(f"terrain {tl.CITY_ID}: z{ZOOM} tiles x {TX0}..{TX1}, y {TY0}..{TY1} ({(TX1 - TX0 + 1) * (TY1 - TY0 + 1)})", flush=True)
    mosaic = np.zeros(((TY1 - TY0 + 1) * 256, (TX1 - TX0 + 1) * 256))
    for ty in range(TY0, TY1 + 1):
        for tx in range(TX0, TX1 + 1):
            mosaic[(ty - TY0) * 256:(ty - TY0 + 1) * 256, (tx - TX0) * 256:(tx - TX0 + 1) * 256] = _fetch(ZOOM, tx, ty, cache)
    gx = np.arange(fx0, fx1 + RES, RES); gy = np.arange(fy0, fy1 + RES, RES)
    X, Y = np.meshgrid(gx, gy)
    lon, lat = TR.transform(X.ravel(), Y.ravel(), direction="INVERSE")
    n = 2 ** ZOOM
    px = ((np.asarray(lon) + 180.0) / 360.0 * n - TX0) * 256.0 - 0.5
    py = ((1.0 - np.arcsinh(np.tan(np.radians(np.asarray(lat)))) / np.pi) / 2.0 * n - TY0) * 256.0 - 0.5
    px = np.clip(px, 0, mosaic.shape[1] - 1.001); py = np.clip(py, 0, mosaic.shape[0] - 1.001)
    i0 = np.floor(px).astype(int); j0 = np.floor(py).astype(int); ax = px - i0; ay = py - j0
    h4 = (mosaic[j0, i0] * (1 - ax) * (1 - ay) + mosaic[j0, i0 + 1] * ax * (1 - ay)
          + mosaic[j0 + 1, i0] * (1 - ax) * ay + mosaic[j0 + 1, i0 + 1] * ax * ay).reshape(X.shape)
    # no-data (-32768) and sea-floor bathymetry: nothing in a city is drivable more than 1 m below sea level
    h4 = np.maximum(h4, -1.0)
    raw = (float(h4.min()), float(h4.max()))
    if OPEN_M > 0:
        r = max(1, int(round(OPEN_M / RES / 2)))
        h4 = _minmax_filter(_minmax_filter(h4, r, np.minimum), r, np.maximum)     # opening: towers out, ground kept
    h4 = _gauss(h4, SIGMA_M / RES)
    h0 = float(_bilinear(h4, fx0, fy0, RES, 0.0, 0.0))
    h4 -= h0
    # export grid: 8 m, aligned to the 256 m tiles, covering the working box (less the smoothing margin)
    T = tl.TILE
    ex0 = math.floor((fx0 + 200) / T) * T; ey0 = math.floor((fy0 + 200) / T) * T
    ex1 = math.ceil((fx1 - 200) / T) * T; ey1 = math.ceil((fy1 - 200) / T) * T
    xs = np.arange(ex0, ex1 + STEP / 2, STEP); ys = np.arange(ey0, ey1 + STEP / 2, STEP)
    EX, EY = np.meshgrid(xs, ys)
    h = _bilinear(h4, fx0, fy0, RES, EX, EY).astype(np.float64)
    nb = _bake_bridges(h, ex0, ey0)
    h = h.astype(np.float32)
    np.savez_compressed(PATH, x0=ex0, y0=ey0, step=STEP, h=h, h0=h0)
    water = _water_levels(h, ex0, ey0)
    with open(WATER_PATH, "w") as f:
        json.dump(water, f, separators=(",", ":"))
    print(f"terrain {tl.CITY_ID}: export grid {h.shape[1]} x {h.shape[0]} at {STEP} m from ({ex0:.0f}, {ey0:.0f}); raw "
          f"{raw[0]:.1f}..{raw[1]:.1f} m, relative {h.min():.1f}..{h.max():.1f} m (origin {h0:.1f} m above sea level); "
          f"{nb} bridge decks over dips; {len(water)} water levels", flush=True)


# ---------------------------------------------------------------- use
_G = None
_W = None


def _grid():
    global _G
    if _G is None:
        if not ENABLED or not os.path.exists(PATH):
            _G = False
        else:
            d = np.load(PATH)
            _G = (float(d["x0"]), float(d["y0"]), float(d["step"]), d["h"].astype(np.float64), float(d["h0"]))
    return _G


def active():
    return bool(_grid())


def H(x, y):
    """ground height (m, relative to the city origin) at game-frame (x, y): arrays or scalars; 0 when terrain is off"""
    g = _grid()
    if not g:
        b = np.broadcast(np.asarray(x), np.asarray(y))
        return np.zeros(b.shape) if b.shape else 0.0
    v = _bilinear(g[3], g[0], g[1], g[2], x, y)
    return v if np.ndim(v) else float(v)


def grad(x, y, e=1.0):
    x = np.asarray(x, np.float64); y = np.asarray(y, np.float64)
    return (H(x + e, y) - H(x - e, y)) / (2 * e), (H(x, y + e) - H(x, y - e)) / (2 * e)


def _water():
    global _W
    if _W is None:
        _W = []
        if active() and os.path.exists(WATER_PATH):
            from shapely.geometry import Polygon
            import shapely
            items = json.load(open(WATER_PATH))
            polys = []
            for it in items:
                try:
                    polys.append((Polygon(it["rings"][0], it["rings"][1:]).buffer(0), it["level"]))
                except Exception:
                    pass
            _W = polys
    return _W


def water_level_at(x, y):
    """the level of the water body containing (x, y) (the nearest one within 30 m), else the ground there"""
    import shapely
    best, bd = None, 30.0
    for poly, lvl in _water():
        d = poly.distance(shapely.Point(x, y))
        if d < bd:
            best, bd = lvl, d
            if d == 0:
                break
    return best if best is not None else H(x, y)


def _subdivide(pos, idx, attrs, tol=0.025, min_edge=1.0):
    """Adaptive, crack-free: split an edge only where the ground bends away from it (the terrain at 1/4, 1/2, 3/4 of the
    edge more than `tol` m off the straight line), and the longest edge of a triangle whose centre is that far off. Flat
    ground and constant slopes stay as they were (a long triangle on a plane is exact). The decision belongs to the EDGE,
    so the two triangles on either side always split it at the same midpoint: no cracks, no T-junctions."""
    pos = np.asarray(pos, np.float64); idx = np.asarray(idx, np.int64).reshape(-1, 3)
    attrs = {k: np.asarray(v, np.float64) for k, v in attrs.items() if v is not None}
    for _ in range(10):
        if not len(idx):
            break
        edges = np.stack([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]], axis=1)          # (T, 3, 2)
        key = np.sort(edges.reshape(-1, 2), axis=1)
        uniq, inv = np.unique(key, axis=0, return_inverse=True)
        inv = inv.reshape(-1, 3)
        pa, pb = pos[uniq[:, 0], :2], pos[uniq[:, 1], :2]
        elen = np.hypot(*(pb - pa).T)
        ha, hb = H(pa[:, 0], pa[:, 1]), H(pb[:, 0], pb[:, 1])
        dev = np.zeros(len(uniq))
        for t in (0.25, 0.5, 0.75):
            q = pa + (pb - pa) * t
            dev = np.maximum(dev, np.abs(H(q[:, 0], q[:, 1]) - (ha + (hb - ha) * t)))
        split = (dev > tol) & (elen > min_edge)
        # a bump inside a big triangle: its longest edge
        c = (pos[idx[:, 0], :2] + pos[idx[:, 1], :2] + pos[idx[:, 2], :2]) / 3
        hv = (H(pos[idx[:, 0], 0], pos[idx[:, 0], 1]) + H(pos[idx[:, 1], 0], pos[idx[:, 1], 1]) + H(pos[idx[:, 2], 0], pos[idx[:, 2], 1])) / 3
        bump = np.abs(H(c[:, 0], c[:, 1]) - hv) > tol
        if bump.any():
            tl3 = elen[inv[bump]]
            longest = inv[bump][np.arange(bump.sum()), np.argmax(tl3, axis=1)]
            split[longest[elen[longest] > min_edge]] = True
        if not split.any():
            break
        sid = np.nonzero(split)[0]
        mid = np.full(len(uniq), -1, np.int64); mid[sid] = len(pos) + np.arange(len(sid))
        pos = np.concatenate([pos, (pos[uniq[sid, 0]] + pos[uniq[sid, 1]]) / 2])
        for k in attrs:
            attrs[k] = np.concatenate([attrs[k], (attrs[k][uniq[sid, 0]] + attrs[k][uniq[sid, 1]]) / 2])
        m_ab, m_bc, m_ca = mid[inv[:, 0]], mid[inv[:, 1]], mid[inv[:, 2]]
        cnt = (m_ab >= 0).astype(int) + (m_bc >= 0) + (m_ca >= 0)
        out = [idx[cnt == 0]]
        rows = []
        for t in np.nonzero(cnt > 0)[0]:
            A, B, C = idx[t]; ab, bc, ca = m_ab[t], m_bc[t], m_ca[t]
            if cnt[t] == 3:
                rows += [(A, ab, ca), (ab, B, bc), (ca, bc, C), (ab, bc, ca)]
            elif cnt[t] == 1:
                if ab >= 0: rows += [(A, ab, C), (ab, B, C)]
                elif bc >= 0: rows += [(A, B, bc), (A, bc, C)]
                else: rows += [(A, B, ca), (ca, B, C)]
            elif ab < 0: rows += [(A, B, bc), (A, bc, ca), (ca, bc, C)]
            elif bc < 0: rows += [(A, ab, ca), (ab, B, C), (ca, ab, C)]
            else: rows += [(A, ab, bc), (A, bc, C), (ab, B, bc)]
        if rows:
            out.append(np.asarray(rows, np.int64))
        idx = np.concatenate(out).reshape(-1, 3)
    return pos, idx, attrs


def drape(meshes):
    """Ground meshes (tilelib.Mesh, game frame, z up) onto the terrain: split where the ground bends (_subdivide), z += H, up-facing
    normals replaced by the terrain's. Water stays flat at its body's level. No-op when terrain is off."""
    if not active():
        return meshes
    out = []
    for m in meshes:
        if len(m.idx) == 0:
            out.append(m); continue
        attrs = {"uv": m.uv, "color": m.color, "normal": m.normal}
        for k, v in (m.extra or {}).items():
            attrs["x_" + k] = v
        if m.material == "water":
            pos, idx, at = np.asarray(m.pos, np.float64).copy(), np.asarray(m.idx).reshape(-1, 3), {k: np.asarray(v, np.float64) for k, v in attrs.items() if v is not None}
        else:
            pos, idx, at = _subdivide(m.pos, m.idx, attrs)
        if m.material == "water":
            # one level per connected piece: the water body under its centre
            lvl = water_level_at(float(pos[:, 0].mean()), float(pos[:, 1].mean()))
            pos[:, 2] += lvl
        else:
            pos[:, 2] += H(pos[:, 0], pos[:, 1])
            if "normal" in at:
                n = at["normal"]
                gx, gy = grad(pos[:, 0], pos[:, 1])
                tn = np.column_stack([-gx, -gy, np.ones(len(pos))]); tn /= np.linalg.norm(tn, axis=1, keepdims=True)
                up = n[:, 2] > 0.9
                n[up] = tn[up]
                at["normal"] = n
        extra = {k[2:]: at[k].astype(np.float32) for k in at if k.startswith("x_")}
        nrm = at.get("normal")
        out.append(tl.Mesh(m.material, pos, idx, None if nrm is None else nrm.astype(np.float32),
                           None if "uv" not in at else at["uv"].astype(np.float32),
                           None if "color" not in at else at["color"].astype(np.float32), extra))
    return out


def export_bin(outdir):
    """terrain.bin (little-endian int16 heights in cm, row-major, row j = y0 + j * step going north) + the index.json meta"""
    g = _grid()
    if not g:
        return None
    x0, y0, step, h, h0 = g
    cm = np.clip(np.round(h * 100.0), -32767, 32767).astype("<i2")
    with open(os.path.join(outdir, "terrain.bin"), "wb") as f:
        f.write(cm.tobytes())
    return {"file": "terrain.bin", "x0": x0, "y0": y0, "step": step, "nx": int(h.shape[1]), "ny": int(h.shape[0]), "scale": 0.01,
            "seaLevel": round(-h0, 2), "min": round(float(h.min()), 2), "max": round(float(h.max()), 2)}


if __name__ == "__main__":
    if not ENABLED:
        print(f"terrain {tl.CITY_ID}: off (cities.json terrain: false)")
        sys.exit(0)
    build()
