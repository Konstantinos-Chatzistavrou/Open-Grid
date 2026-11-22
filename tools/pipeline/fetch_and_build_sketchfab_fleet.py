#!/usr/bin/env python3
"""
Apache-2.0 — OpenGrid GTA 6-Style Sketchfab Fleet Fetcher & Builder.

Replaces the 16 parametric cars with distinct, verified CC-BY 4.0 / CC0 Sketchfab car models
processed through `tools/pipeline/sketchfab_gta6_blender.py` (subtle ~2.5% GTA 6 restyle,
OEM badge/plate stripping, 4 spinning axle-centered wheels, unified clearcoat `paint`,
3D OpenGrid crests, meshopt + WebP compression) and updates `visual.json`, `source.json`,
license evidence JSON, and `CREDITS.md`.

Two sanctioned input modes:
  1. Official Sketchfab API token (recommended — downloads all 16 automatically):
       SKETCHFAB_TOKEN=<your_token> python3 tools/pipeline/fetch_and_build_sketchfab_fleet.py
     Get your personal API token while logged into Sketchfab at:
       https://sketchfab.com/settings/password

  2. Manual local downloads folder (no token needed):
       python3 tools/pipeline/fetch_and_build_sketchfab_fleet.py --from-downloads ~/Downloads
     Matches `.glb` / `.zip` files in that folder against `sketchfab_fleet_manifest.json`.
"""
import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "sketchfab_fleet_manifest.json")
BLENDER_SCRIPT = os.path.join(os.path.dirname(__file__), "sketchfab_gta6_blender.py")
RAW_CACHE_DIR = os.path.join(REPO, "assets_source", "downloads", "sketchfab_cars")
LICENSE_DIR = os.path.join(REPO, "assets_source", "licenses", "downloaded_cars_2026-11-22")
OUT_GLB_DIR = os.path.join(REPO, "web", "public", "assets", "cars", "v5")
DATA_CARS_DIR = os.path.join(REPO, "data", "cars")
MASTERS_DIR = os.path.join(REPO, "assets_source", "masters", "cars")
CREDITS_PATH = os.path.join(REPO, "CREDITS.md")

ALLOWED_LICENSES = {
    "CC Attribution": ("CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/"),
    "CC0 Public Domain": ("CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/"),
}


def find_blender(explicit=None):
    for c in (
        explicit,
        shutil.which("blender"),
        os.path.expanduser("~/.local/bin/blender"),
        os.path.join(REPO, "tools", "blender", "blender"),
    ):
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    raise RuntimeError("Blender not found. Install Blender 4.x/5.x or pass --blender.")


def find_gltf_transform():
    found = sorted(glob.glob(os.path.expanduser("~/.npm/_npx/*/node_modules/.bin/gltf-transform")))
    if found:
        return [found[-1]]
    which = shutil.which("gltf-transform")
    if which:
        return [which]
    return ["npx", "--yes", "@gltf-transform/cli"]


def fetch_api_json(url, token=None):
    headers = {"User-Agent": "OpenGrid/1.0"}
    if token:
        headers["Authorization"] = f"Token {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def verify_and_archive_license(car_id, uid):
    """Query the public Sketchfab v3 API, verify CC-BY / CC0, and save license evidence."""
    api_url = f"https://api.sketchfab.com/v3/models/{uid}"
    data = fetch_api_json(api_url)
    lic_obj = data.get("license") or {}
    label = lic_obj.get("label", "")
    if label not in ALLOWED_LICENSES:
        raise RuntimeError(
            f"LICENSE BLOCK for {car_id} ({uid}): Sketchfab API reports '{label}', "
            f"only {list(ALLOWED_LICENSES.keys())} are allowed!"
        )
    spdx, lic_url = ALLOWED_LICENSES[label]
    os.makedirs(LICENSE_DIR, exist_ok=True)
    record = {
        "uid": uid,
        "name": data.get("name", ""),
        "viewerUrl": data.get("viewerUrl", f"https://sketchfab.com/3d-models/{uid}"),
        "author": (data.get("user") or {}).get("displayName", ""),
        "author_username": (data.get("user") or {}).get("username", ""),
        "license_label": label,
        "license_spdx": spdx,
        "license_url": lic_url,
        "isDownloadable": bool(data.get("isDownloadable")),
        "faceCount": data.get("faceCount", 0),
        "checked_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "api_url": api_url,
    }
    out_path = os.path.join(LICENSE_DIR, f"{car_id}.json")
    with open(out_path, "w") as f:
        json.dump(record, f, indent=2)
    return record


def download_via_api(car_id, uid, token):
    """Download GLB via official Sketchfab v3 `/models/<uid>/download` endpoint."""
    os.makedirs(RAW_CACHE_DIR, exist_ok=True)
    dst = os.path.join(RAW_CACHE_DIR, f"{car_id}_{uid[:8]}.glb")
    if os.path.isfile(dst) and os.path.getsize(dst) > 50_000:
        print(f"  [cache] Reusing {os.path.basename(dst)} ({os.path.getsize(dst)/1e6:.1f} MB)")
        return dst

    dl_info = fetch_api_json(f"https://api.sketchfab.com/v3/models/{uid}/download", token=token)
    glb_entry = dl_info.get("glb") or dl_info.get("gltf")
    if not glb_entry or not glb_entry.get("url"):
        raise RuntimeError(f"Sketchfab download endpoint returned no glb/gltf archive for {uid}")
    is_zip = "gltf" in dl_info and not dl_info.get("glb")
    url = glb_entry["url"]
    tmp_path = dst + (".zip.part" if is_zip else ".part")
    print(f"  [fetch] Downloading {car_id} ({uid}) ...")
    req = urllib.request.Request(url, headers={"User-Agent": "OpenGrid/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r, open(tmp_path, "wb") as f:
        shutil.copyfileobj(r, f)
    if is_zip:
        out_zip = os.path.join(RAW_CACHE_DIR, f"{car_id}_{uid[:8]}.zip")
        os.replace(tmp_path, out_zip)
        return out_zip
    os.replace(tmp_path, dst)
    print(f"  [fetch] Saved {os.path.basename(dst)} ({os.path.getsize(dst)/1e6:.1f} MB)")
    return dst


def find_local_source(entry, downloads_dirs):
    """Find a locally downloaded .glb / .zip matching this manifest entry."""
    hints = [h.lower() for h in entry.get("filename_hints", [])] + [entry["id"].lower(), entry["uid"][:8].lower()]
    candidates = []
    for d in downloads_dirs:
        if not d or not os.path.isdir(d):
            continue
        for fname in sorted(os.listdir(d)):
            low = fname.lower()
            if not (low.endswith(".glb") or low.endswith(".gltf") or low.endswith(".zip")):
                continue
            # Skip unverified non-Sketchfab rips like wwwvecarzcom zips unless UID matches
            if "wwwvecarzcom" in low and entry["uid"][:8].lower() not in low:
                continue
            full = os.path.join(d, fname)
            if not os.path.isfile(full):
                continue
            # Prefer exact id / uid match over generic hint
            score = 0
            if entry["id"].lower() in low or entry["uid"][:8].lower() in low:
                score = 100
            else:
                for h in hints:
                    if h and h in low:
                        score = max(score, 10 + len(h))
            if score > 0:
                candidates.append((score, full))
    if not candidates:
        return None
    candidates.sort(key=lambda x: -x[0])
    return candidates[0][1]


def extract_if_zip(src_path, work_dir):
    if not src_path.lower().endswith(".zip"):
        return src_path
    ext_dir = os.path.join(work_dir, "unzipped")
    os.makedirs(ext_dir, exist_ok=True)
    with zipfile.ZipFile(src_path, "r") as zf:
        zf.extractall(ext_dir)
    for ext in (".glb", ".gltf", ".fbx", ".obj"):
        for root, _, files in os.walk(ext_dir):
            for fn in files:
                if fn.lower().endswith(ext):
                    return os.path.join(root, fn)
    raise RuntimeError(f"No .glb/.gltf/.fbx/.obj found inside {src_path}")


def compress_glb(raw_glb, out_glb):
    gt = find_gltf_transform()
    work_dir = os.path.dirname(raw_glb)
    s1 = os.path.join(work_dir, "step1_dedup.glb")
    s2 = os.path.join(work_dir, "step2_prune.glb")
    s3 = os.path.join(work_dir, "step3_webp.glb")
    os.makedirs(os.path.dirname(out_glb), exist_ok=True)
    subprocess.run(gt + ["dedup", raw_glb, s1], check=True)
    subprocess.run(gt + ["prune", s1, s2], check=True)
    subprocess.run(gt + ["webp", s2, s3, "--quality", "82"], check=True)
    subprocess.run(gt + ["meshopt", s3, out_glb, "--level", "high"], check=True)


def update_visual_json(car_id, meta, lic_record):
    vis_path = os.path.join(DATA_CARS_DIR, f"{car_id}.visual.json")
    with open(vis_path) as f:
        vis = json.load(f)

    mn = meta["bounds_gltf"]["min"]
    mx = meta["bounds_gltf"]["max"]
    w = round(mx[0] - mn[0], 3)
    h = round(mx[1] - mn[1], 3)
    l = round(mx[2] - mn[2], 3)

    hubs = meta.get("wheel_hubs_gltf", {})
    fl = hubs.get("wheel_FL")
    rl = hubs.get("wheel_RL")
    axle_note = ""
    if fl and rl:
        wb = round(fl[2] - rl[2], 3)
        axle_note = f" Front axle z {fl[2]:.3f}, rear {rl[2]:.3f} (wheelbase {wb:.3f}), hub y {fl[1]:.3f}."
        # Keep CG longitudinally close to midpoint of axles if existing CG is far off
        cg = vis.get("cg_in_model_m", [0.0, 0.45, 0.0])
        mid_z = round(0.5 * (fl[2] + rl[2]), 3)
        vis["cg_in_model_m"] = [0.0, round(cg[1], 3), round(mid_z - 0.02, 3)]

    vis["model"] = f"res://assets/cars/v5/{car_id}_hero.glb"
    vis["paint_material"] = meta.get("paint_material", "paint")
    vis["wheel_nodes"] = {
        "fl": "wheel_FL",
        "fr": "wheel_FR",
        "rl": "wheel_RL",
        "rr": "wheel_RR",
    }
    vis["wheel_visual_offset_m"] = 0.0
    vis["notes"] = (
        f"GTA 6-style subtly restyled (~2.5%) build derived from '{lic_record['name']}' by {lic_record['author']} "
        f"({lic_record['license_spdx']}, CREDITS.md): OEM badges/plates stripped, 3D OpenGrid crests added, "
        f"unified clearcoat paint & 4 axle-centered spinning wheels.{axle_note}"
    )
    vis["collision_box"] = {
        "size_m": [round(max(1.65, w - 0.10), 3), round(max(0.66, h * 0.62), 3), round(max(3.60, l - 0.08), 3)],
        "centre_in_model_m": [0.0, round(max(0.54, h * 0.48), 3), 0.0],
        "end_lift_m": 0.12,
        "end_lift_start_m": round(l * 0.37, 3),
        "note": f"body {w:.2f} x {h:.2f} x {l:.2f} m; wheels are raycasts",
    }
    vis["headlights"] = [
        [round(-w * 0.33, 3), round(h * 0.46, 3), round(mx[2] - 0.14, 3)],
        [round(w * 0.33, 3), round(h * 0.46, 3), round(mx[2] - 0.14, 3)],
    ]
    vis["exhaust_nozzles"] = meta.get("exhaust_nozzles", vis.get("exhaust_nozzles", []))
    vis["front_lights"] = meta.get("front_lights", [])
    vis["rear_lights"] = meta.get("rear_lights", [])
    # Clear stale parametric panel/detachable node lists that do not exist in the real mesh
    rear_panels = ["wing"] if meta.get("has_stock_wing") else []
    vis["panels"] = {"front": [], "rear": rear_panels, "left": [], "right": []}
    vis["detachable"] = {}

    with open(vis_path, "w") as f:
        json.dump(vis, f, indent=2)
        f.write("\n")


def update_source_ledger(car_id, lic_record):
    today = datetime.date.today().isoformat()
    ledger_dir = os.path.join(MASTERS_DIR, car_id)
    os.makedirs(ledger_dir, exist_ok=True)
    ledger = {
        "name": lic_record["name"],
        "url": lic_record["viewerUrl"],
        "author": lic_record["author"],
        "licence": lic_record["license_spdx"],
        "licence_url": lic_record["license_url"],
        "downloaded": today,
        "files": [],
        "shipped": [
            f"web/public/assets/cars/v5/{car_id}_hero.glb"
        ],
        "notes": (
            f"Licence verified {today} from the official Sketchfab API ({lic_record['api_url']}: "
            f"license '{lic_record['license_label']}'); evidence archived in "
            f"assets_source/licenses/downloaded_cars_2026-11-22/{car_id}.json. "
            f"OEM badges/plates/wordmarks stripped, subtle ~2.5% GTA 6-style proportional restyle applied, "
            f"3D OpenGrid brand crests stamped, 4 axle-centered spinning wheels and unified clearcoat paint built "
            f"via tools/pipeline/sketchfab_gta6_blender.py. Provenance caution: third-party Sketchfab upload; "
            f"independent authorship by the uploader cannot be guaranteed."
        ),
    }
    with open(os.path.join(ledger_dir, "source.json"), "w") as f:
        json.dump(ledger, f, indent=2)
        f.write("\n")


def update_credits_md(car_id, display_name, lic_record):
    with open(CREDITS_PATH, "r") as f:
        text = f.read()

    new_line = (
        f"- **{display_name}** (`web/public/assets/cars/v5/{car_id}_hero.glb`): modified from "
        f"\"{lic_record['name']}\" by {lic_record['author']}, {lic_record['viewerUrl']}, "
        f"licensed {lic_record['license_spdx']} ({lic_record['license_url']}). "
        f"Changes: OEM marks, badges, plates and internal OEM names removed; subtle ~2.5% GTA 6-style "
        f"proportional restyling applied; 3D OpenGrid brand crests added; unified clearcoat paint material, "
        f"4 axle-centered spinning wheels, decimated, WebP textures and meshopt compression "
        f"(`tools/pipeline/sketchfab_gta6_blender.py`). Licence evidence: "
        f"`assets_source/licenses/downloaded_cars_2026-11-22/{car_id}.json`. Real manufacturer trademarks are not used."
    )

    # Replace existing bullet line mentioning `car_id` if present
    pattern = re.compile(rf"^- \*\*[^\n]*`(?:web/public/assets/cars/v5/{re.escape(car_id)}_hero\.glb|{re.escape(car_id)})`[^\n]*$", re.M)
    if pattern.search(text):
        text = pattern.sub(new_line, text, count=1)
    else:
        text = text.rstrip() + "\n\n" + new_line + "\n"

    with open(CREDITS_PATH, "w") as f:
        f.write(text)


def process_one_car(entry, src_path, lic_record, blender_bin, target_tris, max_tex):
    car_id = entry["id"]
    with tempfile.TemporaryDirectory(prefix=f"og_{car_id}_") as work_dir:
        model_path = extract_if_zip(src_path, work_dir)
        cmd = [
            blender_bin, "-b", "--factory-startup",
            "--python", BLENDER_SCRIPT, "--",
            "--src", model_path,
            "--out-dir", work_dir,
            "--id", car_id,
            "--brand", entry["brand"],
            "--length-m", str(entry["length_m"]),
            "--target-tris", str(target_tris),
            "--max-tex", str(max_tex),
        ]
        if entry.get("paint_match"):
            cmd += ["--paint-match", entry["paint_match"]]
        if entry.get("flip_180"):
            cmd += ["--flip-180"]
        if entry.get("rot_z_deg"):
            cmd += ["--rot-z-deg", str(entry["rot_z_deg"])]

        print(f"  [blender] Processing {car_id} from {os.path.basename(model_path)} ...")
        r = subprocess.run(cmd, capture_output=True, text=True)
        for line in r.stdout.splitlines():
            if line.startswith("["):
                print("   ", line)
        if r.returncode != 0:
            print(r.stderr[-2000:], file=sys.stderr)
            raise RuntimeError(f"Blender failed for {car_id} (rc={r.returncode})")

        raw_glb = os.path.join(work_dir, f"{car_id}_raw.glb")
        meta_path = os.path.join(work_dir, f"{car_id}_meta.json")
        with open(meta_path) as f:
            meta = json.load(f)

        out_glb = os.path.join(OUT_GLB_DIR, f"{car_id}_hero.glb")
        print(f"  [compress] Running gltf-transform meshopt -> {os.path.relpath(out_glb, REPO)}")
        compress_glb(raw_glb, out_glb)
        size_mb = os.path.getsize(out_glb) / (1024 * 1024)
        print(f"  [ok] {car_id}_hero.glb: {size_mb:.2f} MB, {meta['tris']} tris, wheels={len(meta['wheel_hubs_gltf'])}/4")

        update_visual_json(car_id, meta, lic_record)
        update_source_ledger(car_id, lic_record)
        update_credits_md(car_id, entry["name"], lic_record)
        return meta, size_mb


def main():
    p = argparse.ArgumentParser(description="Build GTA 6-style Sketchfab car fleet for OpenGrid.")
    p.add_argument("--car", action="append", help="Build only specific car id(s) (repeatable)")
    p.add_argument("--from-downloads", default="", help="Scan local downloads folder for .glb/.zip files")
    p.add_argument("--token", default=os.environ.get("SKETCHFAB_TOKEN", ""), help="Sketchfab personal API token")
    p.add_argument("--blender", default=None)
    p.add_argument("--target-tris", type=int, default=72000)
    p.add_argument("--max-tex", type=int, default=1024)
    p.add_argument("--skip-existing-ccby", action="store_true", help="Skip cars whose source.json is already CC-BY/CC0")
    args = p.parse_args()

    with open(MANIFEST_PATH) as f:
        manifest = json.load(f)

    blender_bin = find_blender(args.blender)
    downloads_dirs = [RAW_CACHE_DIR]
    if args.from_downloads:
        downloads_dirs.insert(0, os.path.expanduser(args.from_downloads))

    entries = manifest["cars"]
    if args.car:
        wanted = set(args.car)
        entries = [e for e in entries if e["id"] in wanted]

    built, skipped, failed = [], [], []
    for entry in entries:
        car_id = entry["id"]
        if args.skip_existing_ccby:
            src_json = os.path.join(MASTERS_DIR, car_id, "source.json")
            if os.path.isfile(src_json):
                with open(src_json) as f:
                    if json.load(f).get("licence") in ("CC-BY-4.0", "CC-BY-3.0", "CC0-1.0"):
                        print(f"[skip] {car_id} already upgraded to verified CC-BY/CC0")
                        skipped.append(car_id)
                        continue

        print(f"\n=== {car_id} ({entry['name']}) ===")
        try:
            uid = entry["uid"]
            src_path = find_local_source(entry, downloads_dirs)
            lic_record = verify_and_archive_license(car_id, uid)

            if not src_path:
                if args.token:
                    try:
                        src_path = download_via_api(car_id, uid, args.token)
                    except Exception as e:
                        fb = entry.get("fallback_uid")
                        if fb:
                            print(f"  [warn] Primary UID {uid} download failed ({e}); trying fallback {fb}")
                            lic_record = verify_and_archive_license(car_id, fb)
                            src_path = download_via_api(car_id, fb, args.token)
                        else:
                            raise
                else:
                    print(f"  [missing] No local file found and no SKETCHFAB_TOKEN set.")
                    print(f"            Download CC-BY GLB from: {entry['viewer_url']}")
                    skipped.append(car_id)
                    continue

            process_one_car(entry, src_path, lic_record, blender_bin, args.target_tris, args.max_tex)
            built.append(car_id)
        except Exception as e:
            print(f"  [ERROR] {car_id}: {e}", file=sys.stderr)
            failed.append((car_id, str(e)))

    print(f"\nDone: built={len(built)} ({', '.join(built)}), skipped={len(skipped)}, failed={len(failed)}")
    if failed:
        for cid, err in failed:
            print(f"  FAIL {cid}: {err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
