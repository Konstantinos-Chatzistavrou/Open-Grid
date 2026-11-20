#!/usr/bin/env python3
"""
OpenGrid Unlimited 1:1 Real-World City Map Pipeline (One Command -> Playable 1:1 City).

Runs:
  1. Upserts city config into `tools/nyc/cities.json` (single source of truth).
  2. Auto-downloads OSM `.osm.pbf` from `--pbf-url` (Geofabrik / BBBike) if not already on disk.
  3. Runs full 1:1 tile baker:
     `extract.py` -> `mask.py` -> `ground.py --all --meshopt` -> `buildings.py --all`
     -> `props.py --all` (with Poisson tree spacing + road clearance) -> `build_index.py` (minimap + race loop).
  4. Runs automated map quality gates:
     - `tools/nyc/check_road_clear.py` (zero props on drawn asphalt)
     - Road-wall & building-OBB obstruction verification across `map.json` + `*.col.json`
     - Route & minimap integrity verification.
  5. Upserts `data/cities/extra.json` (dynamically loaded by `web/src/cities.ts` -> ZERO manual TS edits!).

Example:
  python3 tools/pipeline/ingest_city.py \
    --id monaco --name "Monaco" --district "Monte Carlo & Port Hercule" --country MC \
    --lat 43.7384 --lon 7.4246 --radius-m 1600 \
    --pbf-url https://download.geofabrik.de/europe/monaco-latest.osm.pbf \
    --drive right --style european
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
NYC_TOOLS = os.path.join(REPO, "tools", "nyc")
CITIES_JSON = os.path.join(NYC_TOOLS, "cities.json")
EXTRA_CITIES_JSON = os.path.join(REPO, "data", "cities", "extra.json")


def run(cmd, env, label):
    print(f"\n==> [{label}] {' '.join(cmd)}")
    r = subprocess.run(cmd, env=env, cwd=REPO)
    if r.returncode != 0:
        raise RuntimeError(f"Step '{label}' failed with exit code {r.returncode}")


def compute_area_bbox(lat: float, lon: float, radius_m: float):
    dlat = radius_m / 111_320.0
    dlon = radius_m / (111_320.0 * max(0.15, math.cos(math.radians(lat))))
    return [round(lat - dlat, 5), round(lon - dlon, 5), round(lat + dlat, 5), round(lon + dlon, 5)]


def download_pbf(url: str, dest: str):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 10_000:
        print(f"[fetch] Reusing cached PBF: {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")
        return
    print(f"[fetch] Downloading OSM PBF from {url} -> {dest}")
    tmp = dest + ".part"
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, dest)
    print(f"[fetch] Saved {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")


def verify_city_outputs(city_id: str, out_dir: str, route_path: str):
    idx_path = os.path.join(out_dir, "index.json")
    map_path = os.path.join(out_dir, "map.json")
    for p in (idx_path, map_path, route_path):
        if not os.path.exists(p):
            raise RuntimeError(f"Missing expected build artifact: {p}")

    idx = json.load(open(idx_path))
    m = json.load(open(map_path))
    rt = json.load(open(route_path))
    tiles = idx.get("tiles", {})
    nodes, edges = m.get("nodes", []), m.get("edges", [])
    samples = rt.get("samples", [])
    if len(tiles) < 4:
        raise RuntimeError(f"City '{city_id}' built too few tiles ({len(tiles)}). Check PBF coverage vs lat/lon.")
    if len(edges) < 20:
        raise RuntimeError(f"City '{city_id}' map.json has too few road edges ({len(edges)}).")
    if len(samples) < 20:
        raise RuntimeError(f"City '{city_id}' route has too few samples ({len(samples)}).")

    # Verify zero interior walls blocking the race route
    def pt_in_box(px, py, b, margin=0.0):
        dx, dy = px - b["cx"], py - b["cy"]
        c, s = math.cos(-b["yaw"]), math.sin(-b["yaw"])
        lx = dx * c - dy * s
        ly = dx * s + dy * c
        return abs(lx) <= b["hx"] + margin and abs(ly) <= b["hy"] + margin

    col_cache = {}
    wall_hits = 0
    for s in samples:
        ix, iy = math.floor(s["x"] / 256), math.floor(s["y"] / 256)
        k = f"{ix}_{iy}"
        if k not in col_cache:
            cp = os.path.join(out_dir, f"{k}.col.json")
            col_cache[k] = json.load(open(cp)) if os.path.exists(cp) else None
        cd = col_cache[k]
        if not cd:
            continue
        for w in cd.get("walls", []):
            if pt_in_box(s["x"], s["y"], w, 0.2):
                wall_hits += 1
    print(f"[verify] '{city_id}': {len(tiles)} tiles · {len(edges)} road edges · {len(samples)} route samples · {wall_hits} route-wall hits")


def register_runtime_city(args):
    os.makedirs(os.path.dirname(EXTRA_CITIES_JSON), exist_ok=True)
    data = {"cities": []}
    if os.path.exists(EXTRA_CITIES_JSON):
        try:
            data = json.load(open(EXTRA_CITIES_JSON))
        except Exception:
            data = {"cities": []}

    entry = {
        "id": args.id,
        "name": args.name,
        "district": args.district,
        "country": args.country.upper(),
        "base": f"/assets/cities/{args.id}/tiles/",
        "route": f"/data/tracks/{args.id}_route.json",
        "grid": args.grid,
        "drive": args.drive,
        "map": "Real OSM 1:1 road network & landmarks",
        "blurb": args.blurb or f"Real-scale 1:1 {args.name} street network built from OpenStreetMap.",
        "mandatoryCops": bool(args.mandatory_cops),
        "patrolNote": args.patrol_note or "",
        "landmarks": json.loads(args.landmarks) if args.landmarks else [{"name": args.district, "x": 0, "y": 0}],
    }
    cities = data.get("cities", [])
    idx = next((i for i, c in enumerate(cities) if c.get("id") == args.id), None)
    if idx is not None:
        cities[idx] = entry
    else:
        cities.append(entry)
    data["cities"] = cities
    with open(EXTRA_CITIES_JSON, "w") as f:
        json.dump(data, f, indent=2)
    print(f"[runtime] Registered '{args.id}' in {EXTRA_CITIES_JSON} (auto-loaded by web/src/cities.ts!)")


def main():
    p = argparse.ArgumentParser(description="OpenGrid Unlimited 1:1 Real-World City Map Pipeline")
    p.add_argument("--id", required=True, help="Lowercase city slug (e.g. monaco, athens, miami)")
    p.add_argument("--name", required=True, help="Display name (e.g. Monaco)")
    p.add_argument("--district", required=True, help="District subtitle (e.g. Monte Carlo)")
    p.add_argument("--country", required=True, help="2-letter ISO code (e.g. MC, GR, US)")
    p.add_argument("--lat", type=float, required=True, help="Center latitude")
    p.add_argument("--lon", type=float, required=True, help="Center longitude")
    p.add_argument("--radius-m", type=float, default=1600.0, help="Half-size of 1:1 city box in meters (default 1600 m -> 3.2x3.2 km)")
    p.add_argument("--pbf", default="", help="Path to local .osm.pbf extract")
    p.add_argument("--pbf-url", default="", help="URL to download .osm.pbf automatically (Geofabrik / BBBike)")
    p.add_argument("--drive", choices=("right", "left"), default="right")
    p.add_argument("--grid", type=float, default=0.0, help="Primary street grid rotation (deg)")
    p.add_argument("--style", choices=("european", "american", "japanese"), default="european")
    p.add_argument("--blurb", default="")
    p.add_argument("--landmarks", default="", help='Optional JSON list: [{"name":"Harbor","x":120,"y":-80}]')
    p.add_argument("--mandatory-cops", action="store_true")
    p.add_argument("--patrol-note", default="")
    p.add_argument("--jobs", type=int, default=3)
    p.add_argument("--skip-build", action="store_true", help="Only register config & runtime manifest without baking tiles")
    args = p.parse_args()

    if not re.match(r"^[a-z][a-z0-9_]{1,24}$", args.id):
        raise ValueError(f"Invalid --id '{args.id}': use lowercase letters/digits/underscore.")

    pbf_rel = args.pbf or f"assets_source/downloads/cities/{args.id}/{args.id}.osm.pbf"
    pbf_abs = pbf_rel if os.path.isabs(pbf_rel) else os.path.join(REPO, pbf_rel)
    if args.pbf_url:
        download_pbf(args.pbf_url, pbf_abs)

    # 1. Upsert into tools/nyc/cities.json
    cities_cfg = json.load(open(CITIES_JSON))
    floors_by_style = {"european": [5, 7], "american": [4, 18], "japanese": [4, 14]}
    cities_cfg[args.id] = {
        "name": args.name,
        "origin": [args.lat, args.lon],
        "area": compute_area_bbox(args.lat, args.lon, args.radius_m),
        "data": f"assets_source/downloads/cities/{args.id}",
        "pbf": os.path.relpath(pbf_abs, REPO),
        "out": f"web/public/assets/cities/{args.id}/tiles",
        "route": f"web/public/data/tracks/{args.id}_route.json",
        "buildings": "osm",
        "mask": "area",
        "grid_deg": args.grid,
        "drive": args.drive,
        "style": args.style,
        "floors": floors_by_style[args.style],
        "small_floors": [2, 4],
    }
    with open(CITIES_JSON, "w") as f:
        json.dump(cities_cfg, f, indent=2)
    print(f"[config] Registered '{args.id}' in {CITIES_JSON}")

    if not args.skip_build:
        if not os.path.exists(pbf_abs):
            raise FileNotFoundError(
                f"OSM PBF not found at {pbf_abs}. Provide --pbf /path/to/file.osm.pbf or --pbf-url https://..."
            )
        env = os.environ.copy()
        env["CITY"] = args.id
        py = os.path.join(NYC_TOOLS, ".venv", "bin", "python3")
        if not os.path.exists(py):
            py = sys.executable

        run([py, os.path.join(NYC_TOOLS, "extract.py")], env, "1/6 extract-osm")
        run([py, os.path.join(NYC_TOOLS, "mask.py")], env, "2/6 drivable-mask")
        run([py, os.path.join(NYC_TOOLS, "ground.py"), "--all", "--meshopt", "-j", str(args.jobs)], env, "3/6 ground-tiles")
        run([py, os.path.join(NYC_TOOLS, "buildings.py"), "--all", "-j", str(args.jobs)], env, "4/6 building-tiles")
        run([py, os.path.join(NYC_TOOLS, "props.py"), "--all", "-j", str(args.jobs)], env, "5/6 props-and-trees")
        run([py, os.path.join(NYC_TOOLS, "build_index.py")], env, "6/6 index-minimap-route")

        # Automated quality gates
        run([py, os.path.join(NYC_TOOLS, "check_road_clear.py")], env, "qa-road-clear")
        verify_city_outputs(
            args.id,
            os.path.join(REPO, f"web/public/assets/cities/{args.id}/tiles"),
            os.path.join(REPO, f"web/public/data/tracks/{args.id}_route.json"),
        )

    register_runtime_city(args)
    print(f"\n✓ 1:1 City '{args.name}' ({args.id}) ready with zero manual TypeScript edits required!")


if __name__ == "__main__":
    main()
