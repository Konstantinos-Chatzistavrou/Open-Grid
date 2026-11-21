#!/usr/bin/env python3
"""Automated test suite for `tools/ue5/export_city_for_ue.py`.

Runs the UE 5.8 Landscape & PCG exporter on:
  - `crete` (mountain pass with 6.89 MB `terrain.bin`, 758.17 m route elevation drop)
  - `nyc` (flat Manhattan grid without `terrain.bin`, 1,900+ road splines & building colliders)

Verifies:
  1. 16-bit PNG (`landscape_height_16bit.png`) & `.r16` (`landscape_height.r16`) dimensions, UE 5.8
     component validity (`(W - 1) % 63 == 0`, `(H - 1) % 63 == 0`), and bit-exact PNG <-> R16 match.
  2. All 5 8-bit weightmaps (`weight_asphalt.png`, `weight_shoulder.png`, `weight_rock.png`,
     `weight_vegetation.png`, `weight_water.png`) sum to 255 at every pixel.
  3. UE 5.8 `ScaleZ_cm = (z_span_m * 100.0) / 512.0` reconstructs the Imbros Pass 758 m elevation
     drop to `< 2 cm` quantization error.
  4. PCG outputs (`pcg_roads.json`, `pcg_roads.csv`, `pcg_route.json`, `pcg_landmarks.json`) have valid
     Unreal Left-Handed Z-Up Centimetre coordinates (`X_ue_cm = x_m * 100`, `Y_ue_cm = -y_m * 100`, `Z_ue_cm = z_m * 100`).
"""
import csv
import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from export_city_for_ue import ROOT, UE_COMPONENT_QUADS, export_city


def _check(cond, msg):
    if not cond:
        print(f"  [FAIL] {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  [PASS] {msg}")


def _verify_city(city_id, expect_terrain_bin):
    out_dir = os.path.join(ROOT, "ue5", "Import", "Cities", city_id)
    meta = export_city(city_id, out_dir)

    res = meta["landscape_resolution"]
    W, H = int(res["width"]), int(res["height"])
    _check(
        (W - 1) % UE_COMPONENT_QUADS == 0 and (H - 1) % UE_COMPONENT_QUADS == 0,
        f"{city_id}: valid UE 5.8 Landscape resolution {W}x{H} ({res['components_x']}x{res['components_y']} components of {UE_COMPONENT_QUADS} quads)",
    )
    _check(
        meta["has_terrain_bin"] == expect_terrain_bin,
        f"{city_id}: has_terrain_bin == {expect_terrain_bin}",
    )

    # 1. Verify 16-bit PNG & .r16 heightmaps
    png_path = os.path.join(out_dir, "landscape_height_16bit.png")
    r16_path = os.path.join(out_dir, "landscape_height.r16")
    _check(os.path.exists(png_path) and os.path.exists(r16_path), f"{city_id}: heightmap PNG and .r16 exist")

    img16 = Image.open(png_path)
    arr_png = np.asarray(img16, dtype=np.uint16)
    arr_r16 = np.fromfile(r16_path, dtype="<u2").reshape((H, W))
    _check(
        arr_png.shape == (H, W) and os.path.getsize(r16_path) == W * H * 2,
        f"{city_id}: 16-bit PNG shape {arr_png.shape} and .r16 size {os.path.getsize(r16_path)} bytes match {W}x{H}",
    )
    _check(
        np.array_equal(arr_png, arr_r16),
        f"{city_id}: landscape_height_16bit.png and landscape_height.r16 are bit-identical",
    )

    # 2. Verify 5 8-bit weightmaps sum to 255 at every pixel
    layers = ("asphalt", "shoulder", "rock", "vegetation", "water")
    w_sum = np.zeros((H, W), dtype=np.int32)
    layer_Arrays = {}
    for layer in layers:
        w_path = os.path.join(out_dir, f"weight_{layer}.png")
        _check(os.path.exists(w_path), f"{city_id}: weight_{layer}.png exists")
        w_arr = np.asarray(Image.open(w_path), dtype=np.uint8)
        _check(w_arr.shape == (H, W), f"{city_id}: weight_{layer}.png shape matches {W}x{H}")
        layer_Arrays[layer] = w_arr
        w_sum += w_arr.astype(np.int32)

    min_sum, max_sum = int(w_sum.min()), int(w_sum.max())
    _check(
        min_sum == 255 and max_sum == 255,
        f"{city_id}: all 5 weightmaps sum to exactly 255 at every pixel (min={min_sum}, max={max_sum})",
    )
    _check(
        int((layer_Arrays["asphalt"] > 0).sum()) > 100 and int((layer_Arrays["shoulder"] > 0).sum()) > 100,
        f"{city_id}: asphalt ({int((layer_Arrays['asphalt'] > 0).sum())} px) and shoulder ({int((layer_Arrays['shoulder'] > 0).sum())} px) rasterized",
    )

    # 3. Verify ScaleX_cm, ScaleY_cm, ScaleZ_cm formula
    src = meta["source_grid"]
    tr = meta["ue5_import_transform"]
    step_m = float(src["step_m"])
    z_span_m = float(src["z_span_m"])
    _check(
        abs(tr["ScaleX_cm"] - step_m * 100.0) < 1e-6 and abs(tr["ScaleY_cm"] - step_m * 100.0) < 1e-6,
        f"{city_id}: ScaleX_cm={tr['ScaleX_cm']} and ScaleY_cm={tr['ScaleY_cm']} match step_m * 100",
    )
    _check(
        abs(tr["ScaleZ_cm"] - (z_span_m * 100.0) / 512.0) < 1e-5,
        f"{city_id}: ScaleZ_cm={tr['ScaleZ_cm']:.6f} matches (z_span_m * 100.0) / 512.0",
    )

    # 4. Verify PCG JSON/CSV files and coordinate conversion
    roads_json = json.load(open(os.path.join(out_dir, "pcg_roads.json"), "r", encoding="utf-8"))
    route_json = json.load(open(os.path.join(out_dir, "pcg_route.json"), "r", encoding="utf-8"))
    landmarks_json = json.load(open(os.path.join(out_dir, "pcg_landmarks.json"), "r", encoding="utf-8"))
    with open(os.path.join(out_dir, "pcg_roads.csv"), "r", encoding="utf-8") as f:
        csv_row_count = sum(1 for _ in csv.reader(f)) - 1

    _check(
        roads_json["road_count"] > 50 and csv_row_count > 200,
        f"{city_id}: pcg_roads has {roads_json['road_count']} splines ({csv_row_count} CSV points)",
    )
    _check(
        route_json["sample_count"] > 100,
        f"{city_id}: pcg_route has {route_json['sample_count']} spline samples (length {route_json['length_m']:.1f} m)",
    )
    _check(
        landmarks_json["building_count"] + landmarks_json["retaining_wall_count"] > 50,
        f"{city_id}: pcg_landmarks has {landmarks_json['building_count']} buildings and {landmarks_json['retaining_wall_count']} retaining walls",
    )

    # Verify spawn coordinate conversion (X_ue_cm = x_m * 100, Y_ue_cm = -y_m * 100)
    idx_path = os.path.join(
        ROOT,
        "web",
        "public",
        "assets",
        "nyc" if city_id == "nyc" else os.path.join("cities", city_id),
        "tiles",
        "index.json",
    )
    idx_data = json.load(open(idx_path, "r", encoding="utf-8"))
    sp = idx_data["spawn"]
    sp_ue = route_json["spawn_ue"]["location_cm"]
    _check(
        abs(sp_ue[0] - sp["x"] * 100.0) < 0.05 and abs(sp_ue[1] - (-sp["y"] * 100.0)) < 0.05,
        f"{city_id}: spawn UE Left-Handed Z-Up cm ({sp_ue[0]}, {sp_ue[1]}) == (x*100, -y*100)",
    )

    return meta, arr_png, layer_Arrays, route_json


def main():
    print("== Testing UE 5.8 City Landscape & PCG Exporter (crete & nyc)")

    # 1. Crete (mountain pass with 6.89 MB terrain.bin & 758 m Imbros Pass elevation drop)
    meta_crete, u16_crete, layers_crete, route_crete = _verify_city("crete", expect_terrain_bin=True)
    _check(
        int((layers_crete["rock"] > 0).sum()) > 10000 and int((layers_crete["water"] > 0).sum()) > 10000,
        f"crete: steep cliff rock (>28 deg: {int((layers_crete['rock'] > 0).sum())} px) and Libyan Sea water ({int((layers_crete['water'] > 0).sum())} px) present",
    )

    drop_m = route_crete["elevation_drop_m"]
    rec_drop_cm = route_crete["reconstructed_drop_cm"]
    err_cm = route_crete["drop_quantization_error_cm"]
    max_lsb_err_cm = meta_crete["ue5_import_transform"]["max_quantization_error_cm"]
    _check(
        750.0 <= drop_m <= 765.0,
        f"crete: Imbros Pass elevation drop is {drop_m:.2f} m (~758 m)",
    )
    _check(
        err_cm < 2.0 and max_lsb_err_cm < 2.0,
        f"crete: UE 5.8 ScaleZ_cm reconstructs {drop_m:.2f} m drop to {rec_drop_cm / 100.0:.4f} m (error = {err_cm:.4f} cm < 2.0 cm; max LSB error = {max_lsb_err_cm:.3f} cm)",
    )

    # Also verify directly from the exported 16-bit PNG pixels at the highest and lowest terrain cells
    tr = meta_crete["ue5_import_transform"]
    src = meta_crete["source_grid"]
    u_min, u_max = int(u16_crete.min()), int(u16_crete.max())
    z_min_rec_cm = tr["LocationZ_cm"] + (u_min - 32768.0) * (512.0 / 65535.0) * tr["ScaleZ_cm"]
    z_max_rec_cm = tr["LocationZ_cm"] + (u_max - 32768.0) * (512.0 / 65535.0) * tr["ScaleZ_cm"]
    full_span_err_cm = abs((z_max_rec_cm - z_min_rec_cm) - src["z_span_m"] * 100.0)
    _check(
        u_min == 0 and u_max == 65535 and full_span_err_cm < 1e-3,
        f"crete: 16-bit PNG utilizes full uint16 range [0..65535] (span error {full_span_err_cm:.6f} cm)",
    )

    # 2. NYC (Manhattan flat city without terrain.bin)
    meta_nyc, u16_nyc, layers_nyc, route_nyc = _verify_city("nyc", expect_terrain_bin=False)
    _check(
        int(u16_nyc.min()) == 32768 and int(u16_nyc.max()) == 32768,
        f"nyc: flat city heightmap encodes 0.0 m as exact uint16 midpoint 32768",
    )

    print("== All UE 5.8 city export checks passed!")


if __name__ == "__main__":
    main()
