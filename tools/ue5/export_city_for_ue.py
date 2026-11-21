#!/usr/bin/env python3
"""OSM + Copernicus DEM -> Unreal Engine 5.8 Landscape & PCG Exporter.

Usage:
    python3 tools/ue5/export_city_for_ue.py <city_id> [--out ue5/Import/Cities/<city_id>]

Works for any built city in `web/public/assets/cities/<id>/` (or `web/public/assets/nyc/` for `nyc`)
using only the committed `tiles/` directory (`index.json`, `terrain.bin`, `map.json`, `*.col.json`,
`*.props.json`) and `web/public/data/tracks/<id>_route.json` (plus `assets_source/downloads/.../derived/`
when present on the build machine).

Outputs in `<out>/`:
  1. `landscape_height_16bit.png` + `landscape_height.r16` + `landscape_meta.json`
     16-bit uint16 heightmap padded to a valid UE 5.8 Landscape overall resolution (multiple of 63 quads + 1)
     with exact `ScaleX_cm`, `ScaleY_cm`, `ScaleZ_cm`, and `Location_cm` import transform.
  2. `weight_asphalt.png`, `weight_shoulder.png`, `weight_rock.png`, `weight_vegetation.png`, `weight_water.png`
     8-bit grayscale layer weightmaps summing to 255 at every pixel for seamless UE 5.8 Landscape blending.
  3. `pcg_roads.json`, `pcg_roads.csv`, `pcg_route.json`, `pcg_landmarks.json`
     Splines, building/wall footprints, landmarks, and spawn transform in Unreal Engine Left-Handed Z-Up
     Centimetres (`X_ue_cm = x_m * 100`, `Y_ue_cm = -y_m * 100`, `Z_ue_cm = z_m * 100`, `Yaw_ue_deg = -deg(heading)`).
"""
import argparse
import csv
import glob
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CITIES_JSON = os.path.join(ROOT, "tools", "nyc", "cities.json")
UE_COMPONENT_QUADS = 63  # Valid UE 5.8 Landscape component size (1x1 section of 63x63 quads -> k*63 + 1 vertices)


def _next_ue_res(n, quad_size=UE_COMPONENT_QUADS):
    """Smallest valid UE 5.8 Landscape overall resolution `k * quad_size + 1 >= n` (with k >= 1)."""
    k = max(1, int(math.ceil(max(1, n - 1) / float(quad_size))))
    return k * quad_size + 1


def _load_city_Meta(city_id):
    cities = {}
    if os.path.exists(CITIES_JSON):
        with open(CITIES_JSON, "r", encoding="utf-8") as f:
            cities = json.load(f)
    cfg = cities.get(city_id, {})

    # Locate tiles directory
    candidates = []
    if cfg.get("out"):
        candidates.append(os.path.join(ROOT, cfg["out"]))
    candidates.append(os.path.join(ROOT, "web", "public", "assets", "cities", city_id, "tiles"))
    candidates.append(os.path.join(ROOT, "web", "public", "assets", city_id, "tiles"))
    tiles_dir = None
    for c in candidates:
        if os.path.exists(os.path.join(c, "index.json")):
            tiles_dir = c
            break
    if not tiles_dir:
        raise FileNotFoundError(f"Could not find tiles/index.json for city '{city_id}' (checked {candidates})")

    # Locate route file
    route_candidates = []
    if cfg.get("route"):
        route_candidates.append(os.path.join(ROOT, cfg["route"]))
    route_candidates.append(os.path.join(ROOT, "web", "public", "data", "tracks", f"{city_id}_route.json"))
    route_candidates.append(os.path.join(ROOT, "data", "tracks", f"{city_id}_route.json"))
    route_path = next((p for p in route_candidates if os.path.exists(p)), None)

    # Locate optional derived directory
    derived_candidates = []
    if cfg.get("data"):
        derived_candidates.append(os.path.join(ROOT, cfg["data"], "derived"))
    derived_candidates.append(os.path.join(ROOT, "assets_source", "downloads", "cities", city_id, "derived"))
    derived_candidates.append(os.path.join(ROOT, "assets_source", "downloads", city_id, "derived"))
    derived_dir = next((p for p in derived_candidates if os.path.isdir(p)), None)

    with open(os.path.join(tiles_dir, "index.json"), "r", encoding="utf-8") as f:
        index_data = json.load(f)

    return cfg, tiles_dir, route_path, derived_dir, index_data


def _load_or_build_height_grid(tiles_dir, index_data):
    """Load `terrain.bin` (`int16` grid * scale) or synthesize a flat grid covering the tile bounding box.

    Returns:
      h_game: float64 array of shape (ny, nx), row j = y0 + j * step_m (north), col i = x0 + i * step_m (east)
      meta: dict with {nx, ny, step_m, x0_m, y0_m, scale_m, sea_level_m, has_terrain_bin}
    """
    ter = index_data.get("terrain")
    terrain_bin = os.path.join(tiles_dir, ter.get("file", "terrain.bin")) if ter else ""
    if ter and os.path.exists(terrain_bin):
        nx = int(ter["nx"])
        ny = int(ter["ny"])
        step_m = float(ter["step"])
        x0_m = float(ter["x0"])
        y0_m = float(ter["y0"])
        scale_m = float(ter.get("scale", 0.01))
        sea_level_m = float(ter.get("seaLevel", 0.0))
        raw = np.fromfile(terrain_bin, dtype="<i2")
        if raw.size != nx * ny:
            raise ValueError(f"{terrain_bin}: expected {nx * ny} int16 samples, got {raw.size}")
        h_game = raw.reshape((ny, nx)).astype(np.float64) * scale_m
        return h_game, {
            "nx": nx,
            "ny": ny,
            "step_m": step_m,
            "x0_m": x0_m,
            "y0_m": y0_m,
            "scale_m": scale_m,
            "sea_level_m": sea_level_m,
            "has_terrain_bin": True,
        }

    # Flat city without terrain.bin: determine bounding box from tiles in index.json
    tile_size = float(index_data.get("tile", 256.0))
    tiles = index_data.get("tiles", {})
    if tiles:
        ixs, iys = [], []
        for k in tiles.keys():
            if "_" in k:
                try:
                    ix, iy = map(int, k.split("_"))
                    ixs.append(ix)
                    iys.append(iy)
                except ValueError:
                    pass
        x0_m = min(ixs) * tile_size
        y0_m = min(iys) * tile_size
        x1_m = (max(ixs) + 1) * tile_size
        y1_m = (max(iys) + 1) * tile_size
    else:
        x0_m, y0_m, x1_m, y1_m = -2048.0, -2048.0, 2048.0, 2048.0

    # Pick step_m so the flat city heightmap fits cleanly around 1009x1009 (16x16 UE components of 63 quads)
    span_m = max(x1_m - x0_m, y1_m - y0_m, 256.0)
    step_m = 16.0 if span_m > 8192.0 else 8.0
    nx = _next_ue_res(int(math.ceil((x1_m - x0_m) / step_m)) + 1)
    ny = _next_ue_res(int(math.ceil((y1_m - y0_m) / step_m)) + 1)
    h_game = np.zeros((ny, nx), dtype=np.float64)
    return h_game, {
        "nx": nx,
        "ny": ny,
        "step_m": step_m,
        "x0_m": x0_m,
        "y0_m": y0_m,
        "scale_m": 0.01,
        "sea_level_m": -2.0,
        "has_terrain_bin": False,
    }


def _sample_height_bilinear(h_game, x0_m, y0_m, step_m, x_m, y_m):
    """Bilinearly sample game-frame height grid `h_game` at scalar or array `(x_m, y_m)`."""
    ny, nx = h_game.shape
    fx = np.clip((np.asarray(x_m, dtype=np.float64) - x0_m) / step_m, 0.0, nx - 1.0001)
    fy = np.clip((np.asarray(y_m, dtype=np.float64) - y0_m) / step_m, 0.0, ny - 1.0001)
    i0 = np.floor(fx).astype(np.int64)
    j0 = np.floor(fy).astype(np.int64)
    ax = fx - i0
    ay = fy - j0
    val = (
        h_game[j0, i0] * (1.0 - ax) * (1.0 - ay)
        + h_game[j0, i0 + 1] * ax * (1.0 - ay)
        + h_game[j0 + 1, i0] * (1.0 - ax) * ay
        + h_game[j0 + 1, i0 + 1] * ax * ay
    )
    return float(val) if np.ndim(val) == 0 else val


def _load_roads(tiles_dir, derived_dir, route_path):
    """Load road polylines and widths from `tiles/map.json` (or `derived/roads.ndjson` / `<id>_route.json`)."""
    roads = []
    map_json = os.path.join(tiles_dir, "map.json")
    if os.path.exists(map_json):
        with open(map_json, "r", encoding="utf-8") as f:
            mg = json.load(f)
        nodes = mg.get("nodes", [])
        for idx, e in enumerate(mg.get("edges", [])):
            a, b = e.get("a", 0), e.get("b", 0)
            if a >= len(nodes) or b >= len(nodes):
                continue
            pts = [nodes[a]] + (e.get("pts") or []) + [nodes[b]]
            w = float(e.get("w", 9.0))
            hw = str(e.get("hw", "unclassified"))
            name = str(e.get("name", ""))
            oneway = bool(e.get("oneway", False))
            length_m = float(e.get("len", 0.0))
            if length_m <= 0.0 and len(pts) >= 2:
                length_m = sum(
                    math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])
                    for k in range(len(pts) - 1)
                )
            roads.append({
                "id": idx,
                "hw": hw,
                "name": name,
                "w": w,
                "oneway": oneway,
                "len": round(length_m, 2),
                "pts": [[float(p[0]), float(p[1])] for p in pts],
            })
    elif derived_dir and os.path.exists(os.path.join(derived_dir, "roads.ndjson")):
        with open(os.path.join(derived_dir, "roads.ndjson"), "r", encoding="utf-8") as f:
            for idx, line in enumerate(f):
                r = json.loads(line)
                pts = r.get("pts", [])
                if len(pts) < 2:
                    continue
                w = float(r.get("width") or 8.0)
                length_m = sum(
                    math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])
                    for k in range(len(pts) - 1)
                )
                roads.append({
                    "id": idx,
                    "hw": str(r.get("hw", "unclassified")),
                    "name": str(r.get("name", "")),
                    "w": w,
                    "oneway": bool(r.get("oneway", False)),
                    "len": round(length_m, 2),
                    "pts": [[float(p[0]), float(p[1])] for p in pts],
                })

    route_data = None
    if route_path and os.path.exists(route_path):
        with open(route_path, "r", encoding="utf-8") as f:
            route_data = json.load(f)

    return roads, route_data


def _build_weightmaps(h_pad_ue, step_m, x0_m, y_top_m, has_terrain_bin, sea_level_m, index_data, roads, route_data):
    """Build 5 8-bit UE 5.8 Landscape layer weightmaps (asphalt, shoulder, rock, vegetation, water)
    that sum to exactly 255 at every pixel.

    Note on orientation:
      `h_pad_ue` has shape `(H, W)` in Unreal Left-Handed Z-Up space (`Y_ue = -y_m`):
      - col `i` (`0..W-1`) is at `x_m = x0_m + i * step_m` (`X_ue_cm = x_m * 100`)
      - row `j_ue` (`0..H-1`) is at `y_m = y_top_m - j_ue * step_m` (`Y_ue_cm = -y_m * 100`)
    """
    H, W = h_pad_ue.shape

    def to_px(x_m, y_m):
        px = (x_m - x0_m) / step_m
        py = (y_top_m - y_m) / step_m
        return (px, py)

    # 1. Rasterize roads (asphalt) and shoulders using Pillow's C polyline drawer
    asphalt_img = Image.new("L", (W, H), 0)
    shoulder_img = Image.new("L", (W, H), 0)
    draw_asphalt = ImageDraw.Draw(asphalt_img)
    draw_shoulder = ImageDraw.Draw(shoulder_img)

    for r in roads:
        pts = r["pts"]
        if len(pts) < 2:
            continue
        coords = [to_px(p[0], p[1]) for p in pts]
        w_m = max(4.0, float(r.get("w", 8.0)))
        asphalt_px = max(1, int(round(w_m / step_m)))
        shoulder_px = max(asphalt_px + 2, int(round((w_m + 6.0) / step_m)))
        draw_shoulder.line(coords, fill=220, width=shoulder_px)
        draw_asphalt.line(coords, fill=255, width=asphalt_px)

    if route_data and route_data.get("samples"):
        samples = route_data["samples"]
        if len(samples) >= 2:
            coords = [to_px(s["x"], s["y"]) for s in samples]
            w_m = float(samples[0].get("width_left", 5.0) + samples[0].get("width_right", 5.0))
            asphalt_px = max(2, int(round(w_m / step_m)))
            shoulder_px = max(asphalt_px + 2, int(round((w_m + 7.0) / step_m)))
            draw_shoulder.line(coords, fill=235, width=shoulder_px)
            draw_asphalt.line(coords, fill=255, width=asphalt_px)

    w_asphalt = np.asarray(asphalt_img, dtype=np.int32)
    raw_shoulder = np.asarray(shoulder_img, dtype=np.int32)
    w_shoulder = np.clip(np.minimum(raw_shoulder, 255 - w_asphalt), 0, 255)
    rem = 255 - w_asphalt - w_shoulder

    # 2. Water mask (< 0.5 m ASL on coastal maps with terrain.bin, or non-tile water basins on flat coastal cities)
    if has_terrain_bin:
        h_asl = h_pad_ue - sea_level_m
        # Smooth 0..1 transition across [-0.2 m, +0.5 m] ASL
        water_frac = np.clip((0.5 - h_asl) / 0.7, 0.0, 1.0)
    else:
        # Mark cells outside active land tiles as river/harbor water
        tile_size = float(index_data.get("tile", 256.0))
        land_mask = np.zeros((H, W), dtype=bool)
        for k in index_data.get("tiles", {}).keys():
            if "_" not in k:
                continue
            try:
                ix, iy = map(int, k.split("_"))
            except ValueError:
                continue
            tx0, ty0 = ix * tile_size, iy * tile_size
            tx1, ty1 = (ix + 1) * tile_size, (iy + 1) * tile_size
            i0 = max(0, int(math.floor((tx0 - x0_m) / step_m)))
            i1 = min(W - 1, int(math.ceil((tx1 - x0_m) / step_m)))
            j0 = max(0, int(math.floor((y_top_m - ty1) / step_m)))
            j1 = min(H - 1, int(math.ceil((y_top_m - ty0) / step_m)))
            if i1 >= i0 and j1 >= j0:
                land_mask[j0:j1 + 1, i0:i1 + 1] = True
        water_frac = (~land_mask).astype(np.float64)

    w_water = np.clip(np.rint(rem * water_frac).astype(np.int32), 0, rem)
    rem = rem - w_water

    # 3. Steep rock slopes from heightmap gradient (> 28 deg; smooth transition across 25..31 deg)
    dz_dy, dz_dx = np.gradient(h_pad_ue, step_m)
    slope_deg = np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))
    rock_frac = np.where(
        slope_deg > 28.0,
        np.clip(0.5 + 0.5 * (slope_deg - 28.0) / 4.0, 0.5, 1.0),
        np.clip(0.5 * (slope_deg - 24.0) / 4.0, 0.0, 0.5),
    )
    w_rock = np.clip(np.rint(rem * rock_frac).astype(np.int32), 0, rem)

    # 4. Vegetation / ground receives the exact remainder so all 5 layers sum to 255 at every pixel
    w_vegetation = 255 - (w_asphalt + w_shoulder + w_water + w_rock)

    return {
        "asphalt": w_asphalt.astype(np.uint8),
        "shoulder": w_shoulder.astype(np.uint8),
        "rock": w_rock.astype(np.uint8),
        "vegetation": w_vegetation.astype(np.uint8),
        "water": w_water.astype(np.uint8),
        "max_slope_deg": float(slope_deg.max()),
        "steep_rock_pixels": int((slope_deg > 28.0).sum()),
    }


def export_city(city_id, out_dir=None):
    cfg, tiles_dir, route_path, derived_dir, index_data = _load_city_Meta(city_id)
    if out_dir is None:
        out_dir = os.path.join(ROOT, "ue5", "Import", "Cities", city_id)
    os.makedirs(out_dir, exist_ok=True)

    # 1. Load height grid and pad to valid UE 5.8 Landscape resolution (k * 63 + 1)
    h_game, grid_meta = _load_or_build_height_grid(tiles_dir, index_data)
    ny, nx = h_game.shape
    step_m = grid_meta["step_m"]
    x0_m = grid_meta["x0_m"]
    y0_m = grid_meta["y0_m"]
    sea_level_m = grid_meta["sea_level_m"]
    has_terrain_bin = grid_meta["has_terrain_bin"]

    W = _next_ue_res(nx)
    H = _next_ue_res(ny)
    pad_x = W - nx
    pad_y = H - ny
    # Pad north (+Y in game frame) and east (+X in game frame) with edge heights so active grid keeps exact step_m
    h_pad_game = np.pad(h_game, ((0, pad_y), (0, pad_x)), mode="edge")
    # Flip Y axis for Unreal Left-Handed coordinate system (+Y_ue = -y_m = South):
    # row 0 in UE heightmap is the northernmost row (y_top_m = y0_m + (H - 1) * step_m -> minimum Y_ue_cm)
    y_top_m = y0_m + (H - 1) * step_m
    h_pad_ue = h_pad_game[::-1, :].copy()

    z_min_m = float(h_game.min())
    z_max_m = float(h_game.max())
    if not has_terrain_bin or abs(z_max_m - z_min_m) < 1e-3:
        z_min_m, z_max_m = -10.0, 10.0
    z_span_m = z_max_m - z_min_m

    # Encode heights to uint16 [0..65535]
    u16_ue = np.clip(
        np.rint(((h_pad_ue - z_min_m) / z_span_m) * 65535.0),
        0,
        65535,
    ).astype(np.uint16)

    # Exact UE 5.8 Landscape Import Transform:
    # Unreal's internal Landscape Z range is 512.0 cm across the full uint16 range [0..65535] at ScaleZ = 1.0,
    # centered at u = 32768 (local Z = 0 cm).
    scale_x_cm = step_m * 100.0
    scale_y_cm = step_m * 100.0
    scale_z_cm = (z_span_m * 100.0) / 512.0
    location_x_cm = x0_m * 100.0
    location_y_cm = -y_top_m * 100.0
    location_z_cm = (z_min_m + (32768.0 / 65535.0) * z_span_m) * 100.0
    lsb_cm = (z_span_m * 100.0) / 65535.0

    # Write 16-bit PNG & .r16
    png16_path = os.path.join(out_dir, "landscape_height_16bit.png")
    r16_path = os.path.join(out_dir, "landscape_height.r16")
    Image.fromarray(u16_ue, mode="I;16").save(png16_path, format="PNG")
    with open(r16_path, "wb") as f:
        f.write(u16_ue.astype("<u2").tobytes())

    # 2. Load roads & route and build 8-bit weightmaps summing to 255
    roads, route_data = _load_roads(tiles_dir, derived_dir, route_path)
    wm = _build_weightmaps(
        h_pad_ue, step_m, x0_m, y_top_m, has_terrain_bin, sea_level_m, index_data, roads, route_data
    )
    weight_files = {}
    for layer in ("asphalt", "shoulder", "rock", "vegetation", "water"):
        fn = f"weight_{layer}.png"
        fp = os.path.join(out_dir, fn)
        Image.fromarray(wm[layer], mode="L").save(fp, format="PNG")
        weight_files[layer] = fn

    # 3. Export PCG Road Splines (pcg_roads.json + pcg_roads.csv)
    pcg_roads = []
    csv_rows = []
    for r in roads:
        pts = r["pts"]
        if len(pts) < 2:
            continue
        xs = np.array([p[0] for p in pts], dtype=np.float64)
        ys = np.array([p[1] for p in pts], dtype=np.float64)
        zs = _sample_height_bilinear(h_game, x0_m, y0_m, step_m, xs, ys) if has_terrain_bin else np.zeros_like(xs)

        pts_ue = []
        width_cm = round(float(r["w"]) * 100.0, 1)
        for k in range(len(pts)):
            x_cm = round(float(xs[k]) * 100.0, 1)
            y_cm = round(float(-ys[k]) * 100.0, 1)
            z_cm = round(float(zs[k]) * 100.0, 1)
            k_prev = max(0, k - 1)
            k_next = min(len(pts) - 1, k + 1)
            dx_m = float(xs[k_next] - xs[k_prev])
            dy_m = float(ys[k_next] - ys[k_prev])
            ds_m = max(1e-3, math.hypot(dx_m, dy_m))
            yaw_ue_deg = round(-math.degrees(math.atan2(dy_m, dx_m)), 3)
            grade_pct = round(float((zs[k_next] - zs[k_prev]) / ds_m) * 100.0, 2)
            pts_ue.append([x_cm, y_cm, z_cm])
            csv_rows.append([
                r["id"],
                k,
                r["hw"],
                r["name"],
                width_cm,
                1 if r["oneway"] else 0,
                x_cm,
                y_cm,
                z_cm,
                yaw_ue_deg,
                grade_pct,
            ])

        pcg_roads.append({
            "id": r["id"],
            "highway": r["hw"],
            "name": r["name"],
            "width_cm": width_cm,
            "oneway": r["oneway"],
            "length_cm": round(float(r["len"]) * 100.0, 1),
            "points_ue_cm": pts_ue,
        })

    with open(os.path.join(out_dir, "pcg_roads.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "city": city_id,
                "coordinate_system": "Unreal Engine 5.8 Left-Handed Z-Up Centimetres (X=x*100, Y=-y*100, Z=z*100)",
                "road_count": len(pcg_roads),
                "roads": pcg_roads,
            },
            f,
            separators=(",", ":"),
        )

    with open(os.path.join(out_dir, "pcg_roads.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "spline_id",
            "point_index",
            "highway",
            "name",
            "width_cm",
            "oneway",
            "x_cm",
            "y_cm",
            "z_cm",
            "yaw_deg",
            "grade_pct",
        ])
        writer.writerows(csv_rows)

    # 4. Export PCG Route Spline (pcg_route.json) + verify heightmap elevation drop reconstruction
    spawn = index_data.get("spawn", {"x": 0.0, "y": 0.0, "heading": 0.0})
    spawn_z_m = _sample_height_bilinear(h_game, x0_m, y0_m, step_m, spawn["x"], spawn["y"]) if has_terrain_bin else 0.0
    spawn_ue = {
        "location_cm": [
            round(float(spawn["x"]) * 100.0, 2),
            round(-float(spawn["y"]) * 100.0, 2),
            round(float(spawn_z_m) * 100.0 + 50.0, 2),
        ],
        "rotation_deg": {
            "roll": 0.0,
            "pitch": 0.0,
            "yaw": round(-math.degrees(float(spawn.get("heading", 0.0))), 3),
        },
    }

    route_samples_ue = []
    route_z_min_m = 0.0
    route_z_max_m = 0.0
    route_drop_m = 0.0
    reconstructed_drop_cm = 0.0
    drop_quant_error_cm = 0.0

    if route_data and route_data.get("samples"):
        samples = route_data["samples"]
        rx = np.array([float(s["x"]) for s in samples], dtype=np.float64)
        ry = np.array([float(s["y"]) for s in samples], dtype=np.float64)
        rz_route = np.array([float(s.get("z", 0.0)) for s in samples], dtype=np.float64)
        rz_ter = _sample_height_bilinear(h_game, x0_m, y0_m, step_m, rx, ry) if has_terrain_bin else rz_route

        route_z_min_m = float(rz_ter.min())
        route_z_max_m = float(rz_ter.max())
        route_drop_m = route_z_max_m - route_z_min_m

        # Verify exact uint16 + ScaleZ_cm reconstruction on route min/max elevations
        u_min = int(np.clip(round(((route_z_min_m - z_min_m) / z_span_m) * 65535.0), 0, 65535))
        u_max = int(np.clip(round(((route_z_max_m - z_min_m) / z_span_m) * 65535.0), 0, 65535))
        z_rec_min_cm = location_z_cm + (u_min - 32768.0) * (512.0 / 65535.0) * scale_z_cm
        z_rec_max_cm = location_z_cm + (u_max - 32768.0) * (512.0 / 65535.0) * scale_z_cm
        reconstructed_drop_cm = z_rec_max_cm - z_rec_min_cm
        drop_quant_error_cm = abs(reconstructed_drop_cm - route_drop_m * 100.0)

        s_acc_cm = 0.0
        for k, s in enumerate(samples):
            if k > 0:
                s_acc_cm += math.hypot(rx[k] - rx[k - 1], ry[k] - ry[k - 1]) * 100.0
            wl_cm = round(float(s.get("width_left", 5.0)) * 100.0, 1)
            wr_cm = round(float(s.get("width_right", 5.0)) * 100.0, 1)
            route_samples_ue.append({
                "index": k,
                "s_cm": round(s_acc_cm, 1),
                "x_cm": round(float(rx[k]) * 100.0, 2),
                "y_cm": round(-float(ry[k]) * 100.0, 2),
                "z_cm": round(float(rz_ter[k]) * 100.0, 2),
                "z_route_cm": round(float(rz_route[k]) * 100.0, 2),
                "yaw_deg": round(-math.degrees(float(s.get("heading", 0.0))), 3),
                "width_left_cm": wl_cm,
                "width_right_cm": wr_cm,
                "total_width_cm": round(wl_cm + wr_cm, 1),
            })

    pcg_route = {
        "city": city_id,
        "name": route_data.get("name", f"{city_id} Route") if route_data else f"{city_id} Route",
        "closed": bool(route_data.get("closed", True)) if route_data else True,
        "coordinate_system": "Unreal Engine 5.8 Left-Handed Z-Up Centimetres",
        "length_m": float(route_data.get("length_m", 0.0)) if route_data else 0.0,
        "length_cm": round(float(route_data.get("length_m", 0.0)) * 100.0, 1) if route_data else 0.0,
        "elevation_min_m": round(route_z_min_m, 3),
        "elevation_max_m": round(route_z_max_m, 3),
        "elevation_drop_m": round(route_drop_m, 3),
        "reconstructed_drop_cm": round(reconstructed_drop_cm, 3),
        "drop_quantization_error_cm": round(drop_quant_error_cm, 4),
        "spawn_ue": spawn_ue,
        "sample_count": len(route_samples_ue),
        "samples": route_samples_ue,
    }
    with open(os.path.join(out_dir, "pcg_route.json"), "w", encoding="utf-8") as f:
        json.dump(pcg_route, f, separators=(",", ":"))

    # 5. Export PCG Landmarks, Building Footprints & Retaining Walls (pcg_landmarks.json)
    buildings_ue = []
    walls_ue = []
    landmarks_ue = []
    for col_path in sorted(glob.glob(os.path.join(tiles_dir, "*.col.json"))):
        try:
            with open(col_path, "r", encoding="utf-8") as f:
                cd = json.load(f)
        except Exception:
            continue
        for b in cd.get("buildings", []):
            cx, cy = float(b.get("cx", 0.0)), float(b.get("cy", 0.0))
            z0, z1 = float(b.get("z0", 0.0)), float(b.get("z1", 10.0))
            hx, hy = float(b.get("hx", 5.0)), float(b.get("hy", 5.0))
            yaw = float(b.get("yaw", 0.0))
            item = {
                "x_cm": round(cx * 100.0, 1),
                "y_cm": round(-cy * 100.0, 1),
                "z_base_cm": round(z0 * 100.0, 1),
                "z_top_cm": round(z1 * 100.0, 1),
                "height_cm": round((z1 - z0) * 100.0, 1),
                "extent_x_cm": round(hx * 100.0, 1),
                "extent_y_cm": round(hy * 100.0, 1),
                "yaw_deg": round(-math.degrees(yaw), 3),
            }
            buildings_ue.append(item)
            if (z1 - z0) >= 85.0 or (not has_terrain_bin and (z1 - z0) >= 60.0) or (has_terrain_bin and len(landmarks_ue) < 64):
                landmarks_ue.append(item)
        for w in cd.get("walls", []):
            cx, cy = float(w.get("cx", 0.0)), float(w.get("cy", 0.0))
            z0, z1 = float(w.get("z0", 0.0)), float(w.get("z1", 3.0))
            hx, hy = float(w.get("hx", 5.0)), float(w.get("hy", 0.4))
            yaw = float(w.get("yaw", 0.0))
            walls_ue.append({
                "x_cm": round(cx * 100.0, 1),
                "y_cm": round(-cy * 100.0, 1),
                "z_base_cm": round(z0 * 100.0, 1),
                "z_top_cm": round(z1 * 100.0, 1),
                "height_cm": round((z1 - z0) * 100.0, 1),
                "extent_x_cm": round(hx * 100.0, 1),
                "extent_y_cm": round(hy * 100.0, 1),
                "yaw_deg": round(-math.degrees(yaw), 3),
            })

    pcg_landmarks = {
        "city": city_id,
        "name": index_data.get("name", city_id),
        "origin_latlon": index_data.get("origin_latlon", cfg.get("origin", [0.0, 0.0])),
        "coordinate_system": "Unreal Engine 5.8 Left-Handed Z-Up Centimetres",
        "spawn_ue": spawn_ue,
        "landmark_count": len(landmarks_ue),
        "building_count": len(buildings_ue),
        "retaining_wall_count": len(walls_ue),
        "landmarks": landmarks_ue[:256],
        "buildings": buildings_ue,
        "retaining_walls": walls_ue,
    }
    with open(os.path.join(out_dir, "pcg_landmarks.json"), "w", encoding="utf-8") as f:
        json.dump(pcg_landmarks, f, separators=(",", ":"))

    # 6. Write landscape_meta.json with documented & verified UE 5.8 Landscape Import Transform
    meta = {
        "city": city_id,
        "name": index_data.get("name", city_id),
        "origin_latlon": index_data.get("origin_latlon", cfg.get("origin", [0.0, 0.0])),
        "has_terrain_bin": has_terrain_bin,
        "files": {
            "heightmap_png": "landscape_height_16bit.png",
            "heightmap_r16": "landscape_height.r16",
            "weightmaps": weight_files,
            "pcg_roads_json": "pcg_roads.json",
            "pcg_roads_csv": "pcg_roads.csv",
            "pcg_route_json": "pcg_route.json",
            "pcg_landmarks_json": "pcg_landmarks.json",
        },
        "source_grid": {
            "nx": nx,
            "ny": ny,
            "step_m": step_m,
            "x0_m": x0_m,
            "y0_m": y0_m,
            "z_min_m": round(z_min_m, 4),
            "z_max_m": round(z_max_m, 4),
            "z_span_m": round(z_span_m, 4),
            "sea_level_m": round(sea_level_m, 4),
            "scale_m": grid_meta["scale_m"],
        },
        "landscape_resolution": {
            "width": W,
            "height": H,
            "component_quads": UE_COMPONENT_QUADS,
            "sections_per_component": 1,
            "components_x": (W - 1) // UE_COMPONENT_QUADS,
            "components_y": (H - 1) // UE_COMPONENT_QUADS,
            "total_components": ((W - 1) // UE_COMPONENT_QUADS) * ((H - 1) // UE_COMPONENT_QUADS),
        },
        "ue5_import_transform": {
            "ScaleX_cm": round(scale_x_cm, 6),
            "ScaleY_cm": round(scale_y_cm, 6),
            "ScaleZ_cm": round(scale_z_cm, 6),
            "LocationX_cm": round(location_x_cm, 3),
            "LocationY_cm": round(location_y_cm, 3),
            "LocationZ_cm": round(location_z_cm, 3),
            "u16_min": 0,
            "u16_mid_zero": 32768,
            "u16_max": 65535,
            "lsb_step_cm": round(lsb_cm, 6),
            "max_quantization_error_cm": round(0.5 * lsb_cm, 6),
            "formula": (
                "ScaleX_cm = step_m * 100.0; ScaleY_cm = step_m * 100.0; "
                "ScaleZ_cm = (z_span_m * 100.0) / 512.0 (Unreal's internal Landscape Z range is "
                "-256..+255.992 cm at ScaleZ = 1.0, i.e. 512 cm per 65535 uint16 steps with u=32768 at local Z=0). "
                "World Z reconstruction: Z_ue_cm(u) = LocationZ_cm + (u - 32768) * (512.0 / 65535.0) * ScaleZ_cm."
            ),
        },
        "route_elevation_verification": {
            "route_elevation_min_m": round(route_z_min_m, 3),
            "route_elevation_max_m": round(route_z_max_m, 3),
            "route_elevation_drop_m": round(route_drop_m, 3),
            "reconstructed_drop_cm": round(reconstructed_drop_cm, 3),
            "drop_quantization_error_cm": round(drop_quant_error_cm, 4),
        },
        "slope_and_layers": {
            "max_slope_deg": round(wm["max_slope_deg"], 2),
            "steep_rock_pixels_over_28deg": wm["steep_rock_pixels"],
        },
        "spawn_ue": spawn_ue,
    }
    meta_path = os.path.join(out_dir, "landscape_meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(
        f"[export_city_for_ue] {city_id} -> {out_dir}\n"
        f"  heightmap: {W}x{H} uint16 ({(W - 1) // UE_COMPONENT_QUADS}x{(H - 1) // UE_COMPONENT_QUADS} UE components of {UE_COMPONENT_QUADS} quads)\n"
        f"  transform: Scale=({scale_x_cm:.1f}, {scale_y_cm:.1f}, {scale_z_cm:.4f}) cm, "
        f"z_span={z_span_m:.2f} m, LSB={lsb_cm:.3f} cm (max err {0.5 * lsb_cm:.3f} cm)\n"
        f"  route drop: {route_drop_m:.2f} m -> reconstructed {reconstructed_drop_cm / 100.0:.4f} m "
        f"(quantization error {drop_quant_error_cm:.4f} cm)\n"
        f"  PCG: {len(pcg_roads)} road splines, {len(route_samples_ue)} route samples, "
        f"{len(buildings_ue)} buildings, {len(walls_ue)} retaining walls"
    )
    return meta


def main():
    parser = argparse.ArgumentParser(description="Export an OpenGrid city to UE 5.8 Landscape & PCG files.")
    parser.add_argument("city_id", help="City identifier (e.g. crete, nyc, london, tokyo)")
    parser.add_argument("--out", default=None, help="Output directory (default: ue5/Import/Cities/<city_id>)")
    args = parser.parse_args()
    export_city(args.city_id, args.out)


if __name__ == "__main__":
    main()
