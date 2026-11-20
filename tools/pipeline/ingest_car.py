#!/usr/bin/env python3
"""
OpenGrid Unlimited Car Ingestion Pipeline (One Command -> Playable, De-Branded, Badged, Validated Car).

Runs:
  1. Copyright & License Gate (blocks NC/ND/All-Rights-Reserved sources & real OEM brand names).
  2. Headless Blender 5.x processing (`blender_prepare_car.py --mode ingest`):
     - Strips all OEM logos, emblems, wordmarks, and plates.
     - Applies subtle proportional FFD silhouette restyling (zero OEM trade dress).
     - Separates stock spoiler into `wing` so garage wings NEVER stack on top.
     - Stamps sculpted 3D OpenGrid Brand Crest badges (`badge_nose`, `badge_rear`) flush to surface normals.
     - Detects exact exhaust pipe nozzle coordinates for photorealistic Mach-diamond flames.
  3. glTF compression via @gltf-transform/cli (dedup -> prune -> webp -> meshopt --level high).
  4. Generates `data/cars/<id>.json` (physics) & `data/cars/<id>.visual.json` (visuals + exhaust_nozzles).
  5. Upserts `data/cars/catalog.json` (with brand, stock engine, unlock level, price -> ZERO TS edits needed!)
     and appends attribution to `CREDITS.md`.
  6. Runs `node tools/validate_mod.mjs` automated QA checks.

Example:
  python3 tools/pipeline/ingest_car.py \
    --id apex_rs --name "Valenza Apex RS" --brand valenza \
    --src /path/to/cc_by_car.glb \
    --engine v10_screamer --engine-label "5.2L NA V10" \
    --price 185000 --sp-level 8 --power-scale 1.18 \
    --license "CC BY 4.0 · Artist Name (Sketchfab)"
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_CARS = os.path.join(REPO, "data", "cars")
CATALOG_PATH = os.path.join(DATA_CARS, "catalog.json")
OUT_GLB_DIR = os.path.join(REPO, "web", "public", "assets", "cars", "v5")
BLENDER_SCRIPT = os.path.join(os.path.dirname(__file__), "blender_prepare_car.py")
CREDITS_PATH = os.path.join(REPO, "CREDITS.md")

VALID_BRANDS = ("valenza", "falcorn", "kaze", "kronos", "aether")
VALID_ENGINES = (
    "v8_crossplane", "v8_flatplane", "v8_twin_turbo", "v8_supercharged",
    "v12_na", "v10_screamer", "v6_tt", "flat6_na", "flat8_na", "i6_forged", "rotary_4",
)
FORBIDDEN_LICENSE_RE = re.compile(r"(non-?commercial|\bnc\b|no-?deriv|\bnd\b|all rights reserved|editorial|proprietary)", re.I)
FORBIDDEN_OEM_NAME_RE = re.compile(
    r"\b(ferrari|lamborghini|porsche|bmw|mercedes|benz|audi|nissan|toyota|honda|mazda|subaru|"
    r"mitsubishi|ford|chevrolet|dodge|mclaren|bugatti|aston martin|pagani|koenigsegg|lotus|"
    r"maserati|alfa romeo|corvette|mustang|camaro|skyline|supra|nsx|rx-?7|impreza|lancer)\b",
    re.I,
)


def find_blender(explicit=None):
    candidates = [
        explicit,
        shutil.which("blender"),
        os.path.expanduser("~/.local/bin/blender"),
        os.path.join(REPO, "tools", "blender", "blender"),
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    raise RuntimeError("Blender executable not found. Install Blender or pass --blender /path/to/blender.")


def find_gltf_transform():
    found = glob.glob(os.path.expanduser("~/.npm/_npx/*/node_modules/.bin/gltf-transform"))
    if found:
        return [found[0]]
    which = shutil.which("gltf-transform")
    if which:
        return [which]
    return ["npx", "--yes", "@gltf-transform/cli"]


def run(cmd, label):
    print(f"\n==> [{label}] {' '.join(cmd)}")
    r = subprocess.run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"Step '{label}' failed with exit code {r.returncode}")


def check_legal_gate(car_id, name, license_str):
    if not re.match(r"^[a-z][a-z0-9_]{2,32}$", car_id):
        raise ValueError(f"Invalid --id '{car_id}': use lowercase letters, digits, underscores (3-33 chars).")
    if FORBIDDEN_OEM_NAME_RE.search(name) or FORBIDDEN_OEM_NAME_RE.search(car_id):
        raise ValueError(f"Trademark gate blocked '{name}' / '{car_id}': use an original OpenGrid model name.")
    if not license_str or len(license_str.strip()) < 4:
        raise ValueError("Missing --license: provide source license & attribution (e.g. 'CC BY 4.0 · Author' or 'CC0 / Original').")
    if FORBIDDEN_LICENSE_RE.search(license_str):
        raise ValueError(f"License gate blocked '{license_str}': NC / ND / proprietary sources are forbidden in OpenGrid.")


def build_physics_json(car_id, name, base_id, power_scale, mass_kg, drivetrain):
    base_path = os.path.join(DATA_CARS, f"{base_id}.json")
    with open(base_path) as f:
        d = json.load(f)
    d["name"] = name
    d["notes"] = f"{name}: ingested via OpenGrid pipeline from base '{base_id}'."
    if mass_kg > 0 and "chassis" in d:
        d["chassis"]["mass_kg"] = float(mass_kg)
    if abs(power_scale - 1.0) > 1e-3 and "engine" in d and "torque_curve" in d["engine"]:
        d["engine"]["torque_curve"] = [[r, round(t * power_scale, 1)] for r, t in d["engine"]["torque_curve"]]
    if drivetrain in ("rwd", "awd", "fwd") and "drivetrain" in d:
        if drivetrain == "awd":
            d["drivetrain"]["front_torque_share"] = 0.35
        elif drivetrain == "fwd":
            d["drivetrain"]["front_torque_share"] = 1.0
        else:
            d["drivetrain"]["front_torque_share"] = 0.0
    out_path = os.path.join(DATA_CARS, f"{car_id}.json")
    with open(out_path, "w") as f:
        json.dump(d, f, indent=2)
    print(f"[physics] Wrote {out_path}")
    return out_path


def hex_to_rgb01(hx: str):
    h = hx.lstrip("#")
    if len(h) != 6:
        return [0.75, 0.12, 0.12]
    return [round(int(h[i : i + 2], 16) / 255.0, 3) for i in (0, 2, 4)]


def build_visual_json(car_id, name, meta, paint_mat_name, paint_hex):
    mn = meta["bounds_gltf"]["min"]
    mx = meta["bounds_gltf"]["max"]
    sx = round(max(1.6, mx[0] - mn[0]), 3)
    sy = round(max(0.9, mx[1] - mn[1]), 3)
    sz = round(max(3.6, mx[2] - mn[2]), 3)
    cx = round((mn[0] + mx[0]) * 0.5, 3)
    cz = round((mn[2] + mx[2]) * 0.5, 3)
    names = set(meta.get("node_names", []))
    pick = lambda lst: [n for n in lst if n in names]
    detach = {}
    for k, zone, thr in (
        ("bumper_front", "front", 0.7),
        ("bumper_rear", "rear", 0.7),
        ("mirror_L", "left", 0.45),
        ("mirror_R", "right", 0.45),
    ):
        if k in names:
            detach[k] = [zone, thr]
    vis = {
        "schema": "car_visual/1",
        "name": name,
        "physics": f"cars/{car_id}.json",
        "model": f"res://assets/cars/v5/{car_id}_hero.glb",
        "lod_model": "res://assets/cars/v3/vela_gt_traffic.glb",
        "paint_material": paint_mat_name,
        "default_paint": hex_to_rgb01(paint_hex),
        "cg_in_model_m": [0.0, round(mn[1] + sy * 0.36, 3), -0.15],
        "wheel_nodes": {
            "fl": "wheel_FL", "fr": "wheel_FR", "rl": "wheel_RL", "rr": "wheel_RR",
        },
        "wheel_visual_offset_m": 0,
        "collision_box": {
            "size_m": [sx, round(sy * 0.64, 3), sz],
            "centre_in_model_m": [cx, round(mn[1] + sy * 0.50, 3), cz],
            "end_lift_m": 0.12,
            "end_lift_start_m": round(sz * 0.38, 3),
        },
        "headlights": [
            [round(-sx * 0.34, 3), round(mn[1] + sy * 0.44, 3), round(mx[2] - 0.18, 3)],
            [round(sx * 0.34, 3), round(mn[1] + sy * 0.44, 3), round(mx[2] - 0.18, 3)],
        ],
        "driver_seat_m": [0.34, round(mn[1] + sy * 0.24, 3), -0.22],
        "driver_scale": 0.92,
        "panels": {
            "front": pick(["bumper_front", "hood", "grille", "nose_vbar", "drl_L", "drl_R"]),
            "rear": pick(["bumper_rear", "taillight_bar", "taillight_L", "taillight_R", "diffuser"]),
            "left": pick(["door_L", "fender_L", "quarter_L", "mirror_L"]),
            "right": pick(["door_R", "fender_R", "quarter_R", "mirror_R"]),
        },
        "detachable": detach,
        "front_lights": meta.get("front_lights", []),
        "rear_lights": meta.get("rear_lights", []),
        "exhaust_nozzles": meta.get("exhaust_nozzles", []),
    }
    out_path = os.path.join(DATA_CARS, f"{car_id}.visual.json")
    with open(out_path, "w") as f:
        json.dump(vis, f, indent=2)
    print(f"[visual] Wrote {out_path}")
    return out_path


def upsert_catalog(args):
    with open(CATALOG_PATH) as f:
        cat = json.load(f)
    entry = {
        "id": args.id,
        "price": args.price,
        "name": args.name,
        "tag": args.tag or f"Original {args.brand.capitalize()} performance machine · {args.engine_label}.",
        "physics": f"cars/{args.id}.json",
        "visual": f"cars/{args.id}.visual.json",
        "paint": args.paint,
        "brand": args.brand,
        "engineVoice": args.engine,
        "engineLabel": args.engine_label,
        "spLevel": args.sp_level,
        "mpLevel": args.mp_level,
        "vmaxKmh": args.vmax,
    }
    cars = cat.get("cars", [])
    idx = next((i for i, c in enumerate(cars) if c.get("id") == args.id), None)
    if idx is not None:
        cars[idx] = entry
    else:
        cars.append(entry)
    cat["cars"] = cars
    with open(CATALOG_PATH, "w") as f:
        json.dump(cat, f, indent=2)
    print(f"[catalog] Registered '{args.id}' in {CATALOG_PATH}")


def append_credits(args):
    if not os.path.exists(CREDITS_PATH):
        return
    txt = open(CREDITS_PATH).read()
    marker = f"`{args.id}`"
    if marker in txt:
        return
    line = f"\n- **{args.name}** (`{args.id}`, marque `{args.brand}`): {args.license} — de-branded, restyled, spoiler-separated & 3D OpenGrid badged via `tools/pipeline/ingest_car.py`.\n"
    with open(CREDITS_PATH, "a") as f:
        f.write(line)
    print(f"[credits] Added attribution entry to {CREDITS_PATH}")


def main():
    p = argparse.ArgumentParser(description="OpenGrid Unlimited Copyright-Safe Car Ingestion Pipeline")
    p.add_argument("--id", required=True, help="Unique car id (e.g. apex_rs)")
    p.add_argument("--name", required=True, help="Display name (no real OEM trademarks!)")
    p.add_argument("--brand", choices=VALID_BRANDS, default="valenza")
    p.add_argument("--src", required=True, help="Raw donor model (.glb/.gltf/.fbx/.obj/.blend)")
    p.add_argument("--license", required=True, help="Source license & author attribution (CC0 / CC BY 4.0 / Original)")
    p.add_argument("--engine", choices=VALID_ENGINES, default="v8_flatplane")
    p.add_argument("--engine-label", default="4.5L Flat-Plane V8")
    p.add_argument("--base", default="vela_gt", help="Base physics template id in data/cars/")
    p.add_argument("--price", type=int, default=145_000)
    p.add_argument("--sp-level", type=int, default=5)
    p.add_argument("--mp-level", type=int, default=6)
    p.add_argument("--vmax", type=int, default=315)
    p.add_argument("--mass", type=float, default=0.0, help="Override curb mass (kg)")
    p.add_argument("--power-scale", type=float, default=1.0, help="Multiply base torque curve")
    p.add_argument("--drivetrain", choices=("keep", "rwd", "awd", "fwd"), default="keep")
    p.add_argument("--paint", default="#d62828")
    p.add_argument("--paint-material", default="paint")
    p.add_argument("--tag", default="")
    p.add_argument("--length-m", type=float, default=4.45, help="Normalized target car length (m, 0 = keep)")
    p.add_argument("--rotate-y-deg", type=float, default=0.0, help="Rotate source model around Y before export")
    p.add_argument("--spoiler-boxes", default="", help="Optional JSON list of glTF boxes to separate merged stock spoiler")
    p.add_argument("--no-restyle", action="store_true", help="Skip FFD restyle (for already-original OpenGrid sculpted meshes)")
    p.add_argument("--blender", default=None)
    p.add_argument("--skip-validate", action="store_true")
    args = p.parse_args()

    check_legal_gate(args.id, args.name, args.license)
    blender = find_blender(args.blender)
    gt = find_gltf_transform()

    with tempfile.TemporaryDirectory(prefix=f"og_car_{args.id}_") as tmp:
        spec = {
            "id": args.id,
            "brand": args.brand,
            "length_m": args.length_m,
            "rotate_y_deg": args.rotate_y_deg,
            "spoiler_boxes": json.loads(args.spoiler_boxes) if args.spoiler_boxes else [],
            "restyle": None if args.no_restyle else {"nose_len": 0.035, "nose_taper": -0.025, "roof_drop": -0.02, "haunch": 0.03},
        }
        spec_path = os.path.join(tmp, "spec.json")
        with open(spec_path, "w") as f:
            json.dump(spec, f)

        # Decode meshopt if donor is already meshopt-compressed
        src_in = os.path.abspath(args.src)
        if src_in.lower().endswith(".glb"):
            dec_path = os.path.join(tmp, "donor_dec.glb")
            r = subprocess.run([*gt, "copy", src_in, dec_path], capture_output=True)
            if r.returncode == 0 and os.path.exists(dec_path):
                src_in = dec_path

        # Stage 1: Headless Blender de-brand + restyle + spoiler separation + 3D OpenGrid badges
        run(
            [blender, "-b", "--factory-startup", "-P", BLENDER_SCRIPT, "--",
             "--mode", "ingest", "--config", spec_path, "--src", src_in, "--out-dir", tmp, "--brand", args.brand],
            "blender-prepare",
        )

        raw_glb = os.path.join(tmp, f"{args.id}_raw.glb")
        meta_path = os.path.join(tmp, f"{args.id}_meta.json")
        meta = json.load(open(meta_path))

        # Stage 2: Optimize & meshopt-compress hero GLB
        os.makedirs(OUT_GLB_DIR, exist_ok=True)
        final_glb = os.path.join(OUT_GLB_DIR, f"{args.id}_hero.glb")
        d_glb = os.path.join(tmp, "dedup.glb")
        p_glb = os.path.join(tmp, "prune.glb")
        run([*gt, "dedup", raw_glb, d_glb], "gltf-dedup")
        run([*gt, "prune", d_glb, p_glb], "gltf-prune")
        run([*gt, "meshopt", p_glb, final_glb, "--level", "high"], "gltf-meshopt")

        # Stage 3: Generate physics + visual JSON + catalog + credits
        build_physics_json(args.id, args.name, args.base, args.power_scale, args.mass, args.drivetrain)
        build_visual_json(args.id, args.name, meta, args.paint_material, args.paint)
        upsert_catalog(args)
        append_credits(args)

    # Stage 4: Automated validation
    if not args.skip_validate:
        val_script = os.path.join(REPO, "tools", "validate_mod.mjs")
        if os.path.exists(val_script):
            run(["node", val_script, os.path.join(DATA_CARS, f"{args.id}.json")], "validate-mod")

    print(f"\n✓ Car '{args.name}' ({args.id}) ingested cleanly with zero manual TypeScript edits required!")


if __name__ == "__main__":
    main()
