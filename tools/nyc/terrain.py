#!/usr/bin/env python3
"""Terrain: real ground heights for a city (cities.json `terrain`, on unless false). docs/cities.md "Terrain".

Sources (cities.json `dem`, default "terrarium"):
  - "terrarium": AWS Terrain Tiles (Terrarium PNG encoding, https://registry.opendata.aws/terrain-tiles/, tilezen/joerd),
    a composite of open elevation data: USGS 3DEP/NED (US, bare earth, 3-10 m), SRTM (30 m), GMTED, ETOPO1 and national
    datasets. Fetched once per city into <data>/terrain/ (not committed).
  - "copernicus_glo30": Copernicus DEM GLO-30 Public 1x1 deg Cloud Optimized GeoTIFFs from AWS Registry of Open Data
    (https://registry.opendata.aws/copernicus-dem/, https://copernicus-dem-30m.s3.amazonaws.com/readme.html; produced
    using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under
    COPERNICUS by the European Union and ESA; all rights reserved). Fetched into <data>/terrain/glo30/.

Build (`CITY=<id> python3 terrain.py`, the stage after extract):
  1. DEM tiles over the city box + fringe + 600 m, sampled on a 4 m grid in the game frame (extract.TR), bilinear
  2. ground-hugging opening (min then max over `terrain_open_m` m): DSMs include towers/trees; opening keeps bare ground
  3. Gaussian smoothing (`terrain_sigma_m`, default 12 m): realistic gradients instead of 30 m DEM steps
  4. heights relative to the city origin (0 m there)
  5. resampled to the EXPORT grid (`terrain_step`, default 8 m; 4 m for rural mountain passes), aligned to 256 m tiles.
     Everything uses this one grid: the pipeline drapes ground and seats buildings on it, and the game loads terrain.bin
     for Rapier height fields and every height query. One source of truth.
  6. Rural/mountain mode (`rural: true`): roads are CARVED into the export grid (smoothed longitudinal centerline profile,
     curvature-based banking, flat shoulders, cut/fill slopes back into natural mountain terrain); natural terrain `h_nat`
     is also saved so ground.py can place retaining walls and guard rails where cut/fill is steep; ocean cells (raw <= 0.05 m)
     produce a coastline water polygon in derived/sea.json.
  7. bridge decks baked in (non-rural or over dips); water levels per water body
  -> derived/terrain.npz {x0, y0, step, h, h0, scale[, h_nat]}, derived/water_levels.json[, derived/sea.json]

Use: H(x, y), H_nat(x, y), sea_polygon(), drape(meshes), export_bin(dir).
"""
import json, math, os, sys, urllib.error, urllib.request
from collections import defaultdict

import numpy as np

import tilelib as tl

RES = 4.0          # working grid (m)
STEP = float(tl.CITY.get("terrain_step", 8.0))         # export grid (m): divides 256 m tile (8 m cities, 4 m mountain passes)
OPEN_M = float(tl.CITY.get("terrain_open_m", 120.0))   # bare-earth opening window (m); 0 where the data is bare earth already (US: 3DEP)
SIGMA_M = float(tl.CITY.get("terrain_sigma_m", 12.0))  # smoothing (m)
DEM_SRC = tl.CITY.get("dem", "terrarium")
RURAL = bool(tl.CITY.get("rural", False))
ZOOM = 15
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
GLO30_URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{ns}_{ew}_DEM/Copernicus_DSM_COG_10_{ns}_{ew}_DEM.tif"
PATH = os.path.join(tl.DERIVED, "terrain.npz")
WATER_PATH = os.path.join(tl.DERIVED, "water_levels.json")
SEA_PATH = os.path.join(tl.DERIVED, "sea.json")

ENABLED = tl.CITY.get("terrain", True) is not False

DRIVE_HW = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "service",
            "primary_link", "secondary_link", "tertiary_link", "trunk_link", "motorway_link", "road"}
MAIN_HW = {"motorway", "trunk", "primary", "secondary", "tertiary"}


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


def _fetch_glo30(lat_deg, lon_deg, cache):
    """Fetch/locate one 1x1 deg Copernicus DEM GLO-30 COG tile. Ocean tiles (HTTP 404) return None (height = 0 m)."""
    ns = f"{'N' if lat_deg >= 0 else 'S'}{abs(lat_deg):02d}_00"
    ew = f"{'E' if lon_deg >= 0 else 'W'}{abs(lon_deg):03d}_00"
    fn = f"Copernicus_DSM_COG_10_{ns}_{ew}_DEM.tif"
    p = os.path.join(cache, fn)
    if not os.path.exists(p):
        url = GLO30_URL.format(ns=ns, ew=ew)
        req = urllib.request.Request(url, headers={"User-Agent": "opengrid-terrain/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None      # ocean tile: no file in the Copernicus DEM bucket -> 0 m
            raise
        with open(p + ".part", "wb") as f:
            f.write(data)
        os.replace(p + ".part", p)
    return p


def _sample_glo30(lon, lat, shape):
    """Sample Copernicus DEM GLO-30 GeoTIFFs onto (lon, lat) arrays (degrees), bilinear, returning shape."""
    from geotiff import GeoTiff
    cache = os.path.join(tl.D, "terrain", "glo30")
    os.makedirs(cache, exist_ok=True)
    lon_a = np.asarray(lon, np.float64)
    lat_a = np.asarray(lat, np.float64)
    lo0, lo1 = int(math.floor(lon_a.min())), int(math.floor(lon_a.max()))
    la0, la1 = int(math.floor(lat_a.min())), int(math.floor(lat_a.max()))
    out = np.zeros(lon_a.shape, dtype=np.float64)
    loaded = 0
    for dla in range(la0, la1 + 1):
        for dlo in range(lo0, lo1 + 1):
            m = (lon_a >= dlo) & (lon_a < dlo + 1.0) & (lat_a >= dla) & (lat_a < dla + 1.0)
            if not m.any():
                continue
            p = _fetch_glo30(dla, dlo, cache)
            if p is None:
                continue
            ras = GeoTiff(p)
            sub_lo, sub_la = lon_a[m], lat_a[m]
            w = ras.window(float(sub_lo.min()), float(sub_la.min()), float(sub_lo.max()), float(sub_la.max()), pad=3)
            if w is None:
                continue
            arr, w_lon0, w_lat0, dlon, dlat = w
            arr = np.where(np.isnan(arr), 0.0, arr)
            px = np.clip((sub_lo - w_lon0) / dlon, 0.0, arr.shape[1] - 1.001)
            py = np.clip((w_lat0 - sub_la) / dlat, 0.0, arr.shape[0] - 1.001)
            i0 = np.floor(px).astype(int); j0 = np.floor(py).astype(int)
            ax = px - i0; ay = py - j0
            out[m] = (arr[j0, i0] * (1 - ax) * (1 - ay) + arr[j0, i0 + 1] * ax * (1 - ay)
                      + arr[j0 + 1, i0] * (1 - ax) * ay + arr[j0 + 1, i0 + 1] * ax * ay)
            loaded += 1
    print(f"terrain {tl.CITY_ID}: Copernicus DEM GLO-30 ({loaded} 1x1 deg tile(s), lon {lo0}..{lo1}, lat {la0}..{la1})", flush=True)
    return out.reshape(shape)


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


def _gauss_1d(v, ds, sigma_m):
    """1D Gaussian smoothing along a uniformly spaced polyline (step ds), pinning endpoints cleanly."""
    if len(v) < 3 or sigma_m <= 0:
        return v.copy()
    r = max(1, int(math.ceil(3.0 * sigma_m / max(ds, 0.5))))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) * ds / sigma_m) ** 2); k /= k.sum()
    pad = np.pad(v, (r, r), mode="edge")
    out = np.convolve(pad, k, mode="valid")
    return out


def _bilinear(grid, x0, y0, step, x, y):
    fx = np.clip((np.asarray(x, np.float64) - x0) / step, 0, grid.shape[1] - 1.001)
    fy = np.clip((np.asarray(y, np.float64) - y0) / step, 0, grid.shape[0] - 1.001)
    i = np.floor(fx).astype(int); j = np.floor(fy).astype(int); ax = fx - i; ay = fy - j
    return grid[j, i] * (1 - ax) * (1 - ay) + grid[j, i + 1] * ax * (1 - ay) + grid[j + 1, i] * (1 - ax) * ay + grid[j + 1, i + 1] * ax * ay


def _rural_road_width(r):
    """Match ground.road_width so carved benches align with the drawn road asphalt."""
    hw, w, ow = r["hw"], r.get("width") or 0, r.get("oneway")
    cw = tl.CITY.get("widths") or {}
    rule = cw.get(hw, cw.get("unclassified", 6.0))
    if ow and hw in ("primary", "secondary"):
        rule *= 0.8
    return min(max(rule, min(w, rule * 1.6)), 30.0)


def _carve_roads(h, x0, y0, step):
    """Rural/mountain road carving: smooth longitudinal road grade + curvature-based banking + flat shoulders + cut/fill
    embankments blended into natural mountain terrain. Guarantees roads sit flush on the carved bench (never buried,
    never floating, never tilting 35 deg sideways on a steep cliff)."""
    path = os.path.join(tl.DERIVED, "roads.ndjson")
    if not os.path.exists(path):
        return 0
    roads = []
    deg = defaultdict(int)
    for line in open(path):
        r = json.loads(line)
        if r.get("hw") not in DRIVE_HW or len(r.get("pts", [])) < 2:
            continue
        pts = []
        for p in r["pts"]:
            q = (round(float(p[0]), 2), round(float(p[1]), 2))
            if not pts or pts[-1] != q:
                pts.append(q)
        if len(pts) < 2:
            continue
        roads.append((r, pts))
        for i, p in enumerate(pts):
            deg[p] += 1 if i in (0, len(pts) - 1) else 2

    # Chain consecutive ways of the same highway class; for main roads ignore side-road junctions so a mountain pass
    # smooths continuously from top to bottom without kinks at minor turnoffs.
    main_deg = defaultdict(int)
    for r, pts in roads:
        if r["hw"] in MAIN_HW:
            for i, p in enumerate(pts):
                main_deg[p] += 1 if i in (0, len(pts) - 1) else 2

    edges = []
    for r, pts in roads:
        is_main = r["hw"] in MAIN_HW
        dmap = main_deg if is_main else deg
        cut = [0] + [i for i in range(1, len(pts) - 1) if dmap[pts[i]] >= 3] + [len(pts) - 1]
        rw = _rural_road_width(r)
        is_tun = bool(r.get("tunnel"))
        for a, b in zip(cut[:-1], cut[1:]):
            p = pts[a:b + 1]
            if len(p) >= 2:
                edges.append({"pts": p, "hw": r["hw"], "w": rw, "main": is_main, "tun": [is_tun] * (len(p) - 1)})

    # Merge degree-2 nodes between edges of the same class (so secondary road ways become long continuous mountain passes)
    adj = defaultdict(list)
    for ei, e in enumerate(edges):
        adj[e["pts"][0]].append(ei)
        adj[e["pts"][-1]].append(ei)
    used = [False] * len(edges)
    chains = []
    for ei in range(len(edges)):
        if used[ei]:
            continue
        used[ei] = True
        e = edges[ei]
        pts = list(e["pts"])
        tun = list(e["tun"])
        hw, w, is_main = e["hw"], e["w"], e["main"]
        dmap = main_deg if is_main else deg
        for side in (1, 0):
            while True:
                end = pts[-1] if side == 1 else pts[0]
                if dmap[end] != 2:
                    break
                nxt = [k for k in adj[end] if not used[k] and edges[k]["hw"] == hw]
                if not nxt:
                    break
                k = nxt[0]
                used[k] = True
                kp = edges[k]["pts"]
                kt = edges[k]["tun"]
                if side == 1:
                    if kp[0] == end:
                        pts.extend(kp[1:]); tun.extend(kt)
                    else:
                        pts.extend(list(reversed(kp[:-1]))); tun.extend(list(reversed(kt)))
                else:
                    if kp[0] == end:
                        pts = list(reversed(kp[1:])) + pts; tun = list(reversed(kt)) + tun
                    else:
                        pts = kp[:-1] + pts; tun = kt + tun
        chains.append({"pts": pts, "tun": tun, "hw": hw, "w": w, "main": is_main})

    h_nat = h.copy()
    ny, nx = h.shape
    # Rasterize nearest road segment into grid: track (priority_key, dist, z_target, hw_bench)
    # Priority: main roads win slightly over minor side tracks where they meet, and closer always wins inside its bench
    best_dist = np.full((ny, nx), 1e9, dtype=np.float64)
    best_z = np.zeros((ny, nx), dtype=np.float64)
    best_bench = np.zeros((ny, nx), dtype=np.float64)
    best_prio = np.full((ny, nx), -1, dtype=np.int8)

    # First pass: compute junction anchor heights from smoothed main roads, then minor roads
    node_z = {}
    chains.sort(key=lambda c: (0 if c["main"] else 1, -len(c["pts"])))

    ds = 2.0
    carved_chains = 0
    for ch in chains:
        P = np.asarray(ch["pts"], dtype=np.float64)
        # Densify along arc length at ~2 m
        segs = np.hypot(np.diff(P[:, 0]), np.diff(P[:, 1]))
        cum = np.concatenate([[0.0], np.cumsum(segs)])
        L = float(cum[-1])
        if L < 2.0:
            continue
        ns = max(2, int(round(L / ds)) + 1)
        s_grid = np.linspace(0.0, L, ns)
        xs = np.interp(s_grid, cum, P[:, 0])
        ys = np.interp(s_grid, cum, P[:, 1])
        z_raw = _bilinear(h_nat, x0, y0, step, xs, ys)

        # Rock-cut galleries / tunnels: DEM reads the cliff roof above the gallery, so linearly interpolate portal-to-portal
        if any(ch["tun"]):
            seg_idx = np.clip(np.searchsorted(cum, s_grid, side="right") - 1, 0, len(ch["tun"]) - 1)
            in_tun = np.array([ch["tun"][i] for i in seg_idx], dtype=bool)
            # Expand mask slightly (12 m past each portal) so cliff overhang near portals doesn't create a bump
            pad_n = max(1, int(round(12.0 / max(L / max(ns - 1, 1), 0.5))))
            mask = in_tun.copy()
            for sh in range(1, pad_n + 1):
                mask[:-sh] |= in_tun[sh:]
                mask[sh:] |= in_tun[:-sh]
            good = ~mask
            if good.sum() >= 2:
                z_raw = np.interp(s_grid, s_grid[good], z_raw[good])

        # Pin endpoints to already-computed junction elevations (so side roads meet the main pass seamlessly!)
        p_start, p_end = ch["pts"][0], ch["pts"][-1]
        step_actual = L / max(ns - 1, 1)
        z_sm = _gauss_1d(z_raw, step_actual, 34.0 if ch["main"] else 16.0)
        # Grade relaxation on main passes: limit steep 30 m DEM cliff artifacts to <= 13% longitudinal grade
        if ch["main"] and ns >= 4:
            max_dz = 0.13 * step_actual
            for _ in range(4):
                for k in range(1, ns):
                    d = z_sm[k] - z_sm[k - 1]
                    if d > max_dz:
                        z_sm[k] = z_sm[k - 1] + max_dz
                    elif d < -max_dz:
                        z_sm[k] = z_sm[k - 1] - max_dz
                for k in range(ns - 2, -1, -1):
                    d = z_sm[k] - z_sm[k + 1]
                    if d > max_dz:
                        z_sm[k] = z_sm[k + 1] + max_dz
                    elif d < -max_dz:
                        z_sm[k] = z_sm[k + 1] - max_dz
            z_sm = _gauss_1d(z_sm, step_actual, 12.0)
        # Smoothly blend endpoints toward pinned junction heights (within 24 m of junction)
        for is_end, key in ((False, p_start), (True, p_end)):
            if key in node_z:
                dz = node_z[key] - (z_sm[-1] if is_end else z_sm[0])
                dist_end = (L - s_grid) if is_end else s_grid
                t = np.clip(1.0 - dist_end / 24.0, 0.0, 1.0)
                z_sm += dz * (t * t * (3.0 - 2.0 * t))
            else:
                node_z[key] = float(z_sm[-1] if is_end else z_sm[0])
        # Also record interior junction nodes of this chain if any
        if ch["main"]:
            for pt in ch["pts"][1:-1]:
                if deg[pt] >= 3 and pt not in node_z:
                    idx = int(np.argmin((xs - pt[0]) ** 2 + (ys - pt[1]) ** 2))
                    node_z[pt] = float(z_sm[idx])

        # Compute smooth unit tangent and signed curvature -> banking (superelevation)
        tx = np.gradient(xs); ty = np.gradient(ys)
        tl_ = np.hypot(tx, ty); tl_[tl_ < 1e-6] = 1.0
        tx /= tl_; ty /= tl_
        # Signed curvature kappa = (tx * dty - ty * dtx) / ds (positive = turning left -> right side banked up)
        win = max(1, int(round(8.0 / max(step_actual, 0.5))))
        kappa = np.zeros(ns, dtype=np.float64)
        if ns > 2 * win + 1:
            cross = tx[:-2 * win] * ty[2 * win:] - ty[:-2 * win] * tx[2 * win:]
            dot = np.clip(tx[:-2 * win] * tx[2 * win:] + ty[:-2 * win] * ty[2 * win:], -1.0, 1.0)
            ang = np.arctan2(cross, dot)
            kappa[win:-win] = ang / (2.0 * win * step_actual)
        kappa = _gauss_1d(kappa, step_actual, 12.0)
        # Taper banking to 0 near endpoints/junctions so intersections are flat
        taper = np.minimum(np.clip(s_grid / 18.0, 0.0, 1.0), np.clip((L - s_grid) / 18.0, 0.0, 1.0))
        # Banking slope (tan theta): turning left (kappa > 0) -> left edge (-cross) lower, right edge (+right = -left) higher
        # With left normal nl = (-ty, tx), s_left > 0 is inside of a left turn -> z_bank = -s_left * bank_slope
        bank = np.clip(kappa * 1.4, -0.055, 0.055) * taper if ch["main"] else np.zeros(ns)

        hw_road = ch["w"] * 0.5
        hw_bench = hw_road + (1.8 if ch["main"] else 1.2)
        max_infl = hw_bench + 26.0
        prio = 1 if ch["main"] else 0

        # Segment-by-segment rasterization into local grid bbox (fast in numpy!)
        for k in range(ns - 1):
            ax, ay, bx, by = xs[k], ys[k], xs[k + 1], ys[k + 1]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            if L2 < 1e-6:
                continue
            Lseg = math.sqrt(L2)
            i0 = max(0, int(math.floor((min(ax, bx) - max_infl - x0) / step)))
            i1 = min(nx - 1, int(math.ceil((max(ax, bx) + max_infl - x0) / step)))
            j0 = max(0, int(math.floor((min(ay, by) - max_infl - y0) / step)))
            j1 = min(ny - 1, int(math.ceil((max(ay, by) + max_infl - y0) / step)))
            if i1 < i0 or j1 < j0:
                continue
            gx = x0 + np.arange(i0, i1 + 1) * step
            gy = y0 + np.arange(j0, j1 + 1) * step
            PX, PY = np.meshgrid(gx, gy)
            apx, apy = PX - ax, PY - ay
            t = np.clip((apx * dx + apy * dy) / L2, 0.0, 1.0)
            cx, cy = ax + t * dx, ay + t * dy
            dist = np.hypot(PX - cx, PY - cy)
            # Signed left offset: nl = (-dy/Lseg, dx/Lseg)
            s_left = ((PX - cx) * (-dy) + (PY - cy) * dx) / Lseg
            z_cl = z_sm[k] + t * (z_sm[k + 1] - z_sm[k])
            bk = bank[k] + t * (bank[k + 1] - bank[k])
            z_t = z_cl - np.clip(s_left, -hw_road, hw_road) * bk

            sub_d = best_dist[j0:j1 + 1, i0:i1 + 1]
            sub_p = best_prio[j0:j1 + 1, i0:i1 + 1]
            # Main road wins inside its bench over minor roads; otherwise nearest road wins
            better = (dist < max_infl) & (
                ((prio > sub_p) & (dist <= hw_bench + 1.0)) |
                ((prio == sub_p) & (dist < sub_d)) |
                ((prio < sub_p) & (dist < sub_d) & (sub_d > hw_bench + 1.0))
            )
            if better.any():
                sub_d[better] = dist[better]
                best_z[j0:j1 + 1, i0:i1 + 1][better] = z_t[better]
                best_bench[j0:j1 + 1, i0:i1 + 1][better] = hw_bench
                sub_p[better] = prio
        carved_chains += 1

    # Apply cut-and-fill blend onto h
    has_road = best_dist < 1e8
    if has_road.any():
        d = best_dist[has_road]
        zt = best_z[has_road]
        hb = best_bench[has_road]
        hn = h_nat[has_road]
        dh = hn - zt
        # Uphill rock cut is steeper (1.15:1); downhill embankment fill is gentler (0.75:1)
        ramp = np.where(dh >= 0.0, np.clip(dh / 1.15 + 4.0, 6.0, 22.0), np.clip(-dh / 0.75 + 4.0, 6.0, 24.0))
        u = np.clip((d - hb) / ramp, 0.0, 1.0)
        w = 1.0 - (u * u * (3.0 - 2.0 * u))    # 1.0 across entire bench + shoulder, smoothstep down to 0 over ramp
        h[has_road] = hn * (1.0 - w) + zt * w
    return carved_chains


def _sea_polygons(sea_mask, fx0, fy0, res):
    """Vectorize ocean cells (raw DEM <= 0.05 m) on a 16 m coarse grid into simplified shapely polygons -> derived/sea.json."""
    from shapely.geometry import box as sbox
    from shapely.ops import unary_union
    stride = max(1, int(round(16.0 / res)))
    sub = sea_mask[::stride, ::stride]
    step = res * stride
    boxes = []
    ny, nx = sub.shape
    for j in range(ny):
        row = sub[j]
        if not row.any():
            continue
        # Run-length encode contiguous sea cells in each row -> far fewer rectangles for unary_union
        i = 0
        while i < nx:
            if row[i]:
                i0 = i
                while i < nx and row[i]:
                    i += 1
                boxes.append(sbox(fx0 + i0 * step, fy0 + j * step, fx0 + i * step, fy0 + (j + 1) * step))
            else:
                i += 1
    if not boxes:
        return []
    u = unary_union(boxes).buffer(0)
    polys = [u] if u.geom_type == "Polygon" else list(getattr(u, "geoms", []))
    out = []
    for p in polys:
        if p.area < 5000.0:
            continue
        p = p.simplify(6.0, preserve_topology=True)
        if p.is_empty or p.area < 5000.0:
            continue
        rings = [[[round(x, 1), round(y, 1)] for x, y in p.exterior.coords]]
        for r in p.interiors:
            if len(r.coords) >= 4:
                rings.append([[round(x, 1), round(y, 1)] for x, y in r.coords])
        out.append(rings)
    return out


def _bake_bridges(h, x0, y0):
    """bridge decks over dips: straight from bank to bank (drivable bridges only; the deck is the bridge's own width)"""
    path = os.path.join(tl.DERIVED, "roads.ndjson")
    if not os.path.exists(path):
        return 0
    from shapely.geometry import LineString, Point
    H0 = lambda x, y: _bilinear(h, x0, y0, STEP, x, y)
    n = 0
    for line in open(path):
        r = json.loads(line)
        if not r.get("bridge") or r.get("hw") not in DRIVE_HW or len(r["pts"]) < 2:
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


def _water_levels(h, x0, y0, sea_polys=None, sea_level=None):
    path = os.path.join(tl.DERIVED, "areas.ndjson")
    out = []
    if os.path.exists(path):
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
    if sea_polys and sea_level is not None:
        for idx, rings in enumerate(sea_polys):
            out.append({"id": f"sea_{idx}", "level": round(float(sea_level), 2), "rings": rings})
    return out


def build():
    from extract import TR
    margin = tl.FRINGE + 600.0
    fx0, fy0, fx1, fy1 = _frame_box(margin)
    gx = np.arange(fx0, fx1 + RES, RES); gy = np.arange(fy0, fy1 + RES, RES)
    X, Y = np.meshgrid(gx, gy)
    lon, lat = TR.transform(X.ravel(), Y.ravel(), direction="INVERSE")

    if DEM_SRC == "copernicus_glo30":
        h4 = _sample_glo30(lon, lat, X.shape)
    else:
        lons, lats = TR.transform([fx0, fx0, fx1, fx1], [fy0, fy1, fy0, fy1], direction="INVERSE")
        tx0, ty1 = _tile_xy(min(lons), min(lats), ZOOM); tx1, ty0 = _tile_xy(max(lons), max(lats), ZOOM)
        TX0, TX1, TY0, TY1 = int(math.floor(tx0)), int(math.floor(tx1)), int(math.floor(ty0)), int(math.floor(ty1))
        cache = os.path.join(tl.D, "terrain"); os.makedirs(cache, exist_ok=True)
        print(f"terrain {tl.CITY_ID}: z{ZOOM} tiles x {TX0}..{TX1}, y {TY0}..{TY1} ({(TX1 - TX0 + 1) * (TY1 - TY0 + 1)})", flush=True)
        mosaic = np.zeros(((TY1 - TY0 + 1) * 256, (TX1 - TX0 + 1) * 256))
        for ty in range(TY0, TY1 + 1):
            for tx in range(TX0, TX1 + 1):
                mosaic[(ty - TY0) * 256:(ty - TY0 + 1) * 256, (tx - TX0) * 256:(tx - TX0 + 1) * 256] = _fetch(ZOOM, tx, ty, cache)
        n = 2 ** ZOOM
        px = ((np.asarray(lon) + 180.0) / 360.0 * n - TX0) * 256.0 - 0.5
        py = ((1.0 - np.arcsinh(np.tan(np.radians(np.asarray(lat)))) / np.pi) / 2.0 * n - TY0) * 256.0 - 0.5
        px = np.clip(px, 0, mosaic.shape[1] - 1.001); py = np.clip(py, 0, mosaic.shape[0] - 1.001)
        i0 = np.floor(px).astype(int); j0 = np.floor(py).astype(int); ax = px - i0; ay = py - j0
        h4 = (mosaic[j0, i0] * (1 - ax) * (1 - ay) + mosaic[j0, i0 + 1] * ax * (1 - ay)
              + mosaic[j0 + 1, i0] * (1 - ax) * ay + mosaic[j0 + 1, i0 + 1] * ax * ay).reshape(X.shape)

    # Record sea mask from raw DEM (Copernicus GLO-30 ocean pixels are exact 0.0 m)
    sea_mask = (h4 <= 0.05) if (RURAL and DEM_SRC == "copernicus_glo30") else None

    # no-data (-32768) and sea-floor bathymetry: nothing in a city is drivable more than 1 m below sea level
    h4 = np.maximum(h4, -1.0)
    raw = (float(h4.min()), float(h4.max()))
    if OPEN_M > 0:
        r = max(1, int(round(OPEN_M / RES / 2)))
        h4 = _minmax_filter(_minmax_filter(h4, r, np.minimum), r, np.maximum)     # opening: towers/trees out, bare ground kept
    if SIGMA_M > 0:
        h4 = _gauss(h4, SIGMA_M / RES)
    h0 = float(_bilinear(h4, fx0, fy0, RES, 0.0, 0.0))
    h4 -= h0

    # export grid: STEP m, aligned to the 256 m tiles, covering the working box (less the smoothing margin)
    T = tl.TILE
    ex0 = math.floor((fx0 + 200) / T) * T; ey0 = math.floor((fy0 + 200) / T) * T
    ex1 = math.ceil((fx1 - 200) / T) * T; ey1 = math.ceil((fy1 - 200) / T) * T
    xs = np.arange(ex0, ex1 + STEP / 2, STEP); ys = np.arange(ey0, ey1 + STEP / 2, STEP)
    EX, EY = np.meshgrid(xs, ys)
    h = _bilinear(h4, fx0, fy0, RES, EX, EY).astype(np.float64)

    h_nat = None
    nc = 0
    if RURAL:
        h_nat = h.copy()
        nc = _carve_roads(h, ex0, ey0, STEP)
    nb = _bake_bridges(h, ex0, ey0)

    # Dynamic int16 scale: 0.01 m (1 cm) for all normal cities (|h| <= 320 m); coarser scale for >320 m mountain relief
    max_abs = max(abs(float(h.min())), abs(float(h.max())))
    scale = 0.01 if max_abs <= 320.0 else math.ceil((max_abs / 32000.0) * 200.0) / 200.0
    if scale > 0.01 or RURAL:
        # Quantize BEFORE saving terrain.npz so draped ground meshes and Rapier terrain.bin heightfields are identical
        h = np.round(h / scale) * scale

    save_kw = dict(x0=ex0, y0=ey0, step=STEP, h=h.astype(np.float32), h0=h0, scale=scale)
    if h_nat is not None:
        save_kw["h_nat"] = h_nat.astype(np.float32)
    np.savez_compressed(PATH, **save_kw)

    sea_polys = _sea_polygons(sea_mask, fx0, fy0, RES) if sea_mask is not None else []
    if sea_polys:
        with open(SEA_PATH, "w") as f:
            json.dump(sea_polys, f, separators=(",", ":"))
    elif os.path.exists(SEA_PATH):
        os.remove(SEA_PATH)

    water = _water_levels(h, ex0, ey0, sea_polys=sea_polys, sea_level=-h0)
    with open(WATER_PATH, "w") as f:
        json.dump(water, f, separators=(",", ":"))
    print(f"terrain {tl.CITY_ID}: export grid {h.shape[1]} x {h.shape[0]} at {STEP} m (scale {scale} m) from ({ex0:.0f}, {ey0:.0f}); raw "
          f"{raw[0]:.1f}..{raw[1]:.1f} m, relative {h.min():.1f}..{h.max():.1f} m (origin {h0:.1f} m above sea level); "
          f"{nc} carved road chains, {nb} bridge decks over dips; {len(water)} water levels ({len(sea_polys)} sea)", flush=True)


# ---------------------------------------------------------------- use
_G = None
_W = None
_SEA = None


def _grid():
    global _G
    if _G is None:
        if not ENABLED or not os.path.exists(PATH):
            _G = False
        else:
            d = np.load(PATH)
            h_nat = d["h_nat"].astype(np.float64) if "h_nat" in d else None
            scale = float(d["scale"]) if "scale" in d else 0.01
            _G = (float(d["x0"]), float(d["y0"]), float(d["step"]), d["h"].astype(np.float64), float(d["h0"]), scale, h_nat)
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


def H_nat(x, y):
    """pre-carved natural terrain height (m) for rural cut/fill detection; falls back to H when absent"""
    g = _grid()
    if not g:
        return H(x, y)
    arr = g[6] if g[6] is not None else g[3]
    v = _bilinear(arr, g[0], g[1], g[2], x, y)
    return v if np.ndim(v) else float(v)


def sea_level():
    """sea level in game-frame metres (-h0), or 0.0 when terrain is off"""
    g = _grid()
    return -g[4] if g else 0.0


def sea_polygon():
    """Shapely polygon of ocean water extracted from the DEM (derived/sea.json), or empty Polygon."""
    global _SEA
    if _SEA is None:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
        if os.path.exists(SEA_PATH):
            raw = json.load(open(SEA_PATH))
            ps = []
            for rings in raw:
                try:
                    p = Polygon(rings[0], rings[1:]).buffer(0)
                    if not p.is_empty:
                        ps.append(p)
                except Exception:
                    pass
            _SEA = unary_union(ps).buffer(0) if ps else Polygon()
        else:
            _SEA = Polygon()
    return _SEA


def tile_z_range(ix, iy):
    """(zmin, zmax) of terrain inside tile (ix, iy), or (0.0, 0.0) if flat."""
    g = _grid()
    if not g:
        return 0.0, 0.0
    x0, y0, step, h = g[0], g[1], g[2], g[3]
    tx0, ty0, tx1, ty1 = tl.tile_bounds(ix, iy)
    i0 = max(0, int(math.floor((tx0 - x0) / step)))
    i1 = min(h.shape[1] - 1, int(math.ceil((tx1 - x0) / step)))
    j0 = max(0, int(math.floor((ty0 - y0) / step)))
    j1 = min(h.shape[0] - 1, int(math.ceil((ty1 - y0) / step)))
    if i1 < i0 or j1 < j0:
        return 0.0, 0.0
    sub = h[j0:j1 + 1, i0:i1 + 1]
    return float(sub.min()), float(sub.max())


def grad(x, y, e=1.0):
    x = np.asarray(x, np.float64); y = np.asarray(y, np.float64)
    return (H(x + e, y) - H(x - e, y)) / (2 * e), (H(x, y + e) - H(x, y - e)) / (2 * e)


def _water():
    global _W
    if _W is None:
        _W = []
        if active() and os.path.exists(WATER_PATH):
            from shapely.geometry import Polygon
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
        if m.material == "water" or (RURAL and m.material in ("guardrail", "curb")):
            pos, idx, at = np.asarray(m.pos, np.float64).copy(), np.asarray(m.idx).reshape(-1, 3), {k: np.asarray(v, np.float64) for k, v in attrs.items() if v is not None}
        else:
            # Keep road/marking centimetre-accurate on the 4 m grid; coarser subdivision on shoulders and off-road cliffs
            if RURAL and m.material == "terrain":
                tol, min_e = 0.45, 8.0
            elif RURAL and m.material == "shoulder":
                tol, min_e = 0.10, 4.0
            elif RURAL:
                tol, min_e = 0.035, 2.0
            else:
                tol, min_e = 0.025, 1.0
            pos, idx, at = _subdivide(m.pos, m.idx, attrs, tol=tol, min_edge=min_e)
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
    """terrain.bin (little-endian int16 heights in `scale` m units, row-major, row j = y0 + j * step going north) + the index.json meta"""
    g = _grid()
    if not g:
        return None
    x0, y0, step, h, h0, scale, _ = g
    q = np.clip(np.round(h / scale), -32767, 32767).astype("<i2")
    with open(os.path.join(outdir, "terrain.bin"), "wb") as f:
        f.write(q.tobytes())
    return {"file": "terrain.bin", "x0": x0, "y0": y0, "step": step, "nx": int(h.shape[1]), "ny": int(h.shape[0]), "scale": scale,
            "seaLevel": round(-h0, 2), "min": round(float(h.min()), 2), "max": round(float(h.max()), 2)}


if __name__ == "__main__":
    if not ENABLED:
        print(f"terrain {tl.CITY_ID}: off (cities.json terrain: false)")
        sys.exit(0)
    build()
