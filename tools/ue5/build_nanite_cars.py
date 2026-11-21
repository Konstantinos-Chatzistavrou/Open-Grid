#!/usr/bin/env python3
"""
Build UE 5.8 Nanite-grade high-poly hero car GLBs using Blender + sculpt_fleet.py --ue5-nanite.

Places outputs in:
  ue5/Import/<car_id>/nanite_hero.glb

Usage:
  python3 tools/ue5/build_nanite_cars.py
  python3 tools/ue5/build_nanite_cars.py --only falcorn_9r_rs,valenza_integrale
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCULPT_SCRIPT = os.path.join(REPO, "tools", "pipeline", "sculpt_fleet.py")
IMPORT_ROOT = os.path.join(REPO, "ue5", "Import")


def find_blender() -> str:
    local_bin = os.path.expanduser("~/.local/bin/blender")
    if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
        return local_bin
    found = shutil.which("blender")
    if found:
        return found
    raise FileNotFoundError(
        "Blender executable not found at ~/.local/bin/blender or on PATH."
    )


def inspect_glb(glb_path: str) -> dict:
    """Parse a GLB header + JSON chunk to verify triangles, meshes, materials, and TEXCOORD_0 UVs."""
    size_bytes = os.path.getsize(glb_path)
    with open(glb_path, "rb") as f:
        header = f.read(12)
        if len(header) < 12:
            raise ValueError(f"Truncated GLB header: {glb_path}")
        magic, version, _length = struct.unpack("<4sII", header)
        if magic != b"glTF" or version != 2:
            raise ValueError(f"Invalid GLB2 header in {glb_path}")
        chunk_len, chunk_type = struct.unpack("<II", f.read(8))
        if chunk_type != 0x4E4F534A:  # JSON
            raise ValueError(f"First GLB chunk is not JSON in {glb_path}")
        gltf = json.loads(f.read(chunk_len).decode("utf-8"))

    accessors = gltf.get("accessors", [])
    meshes = gltf.get("meshes", [])
    materials = gltf.get("materials", [])
    nodes = gltf.get("nodes", [])

    total_tris = 0
    total_prims = 0
    prims_with_uv = 0
    meshes_with_uv = 0
    missing_uv_meshes = []

    for m_idx, mesh in enumerate(meshes):
        m_name = mesh.get("name", f"mesh_{m_idx}")
        prims = mesh.get("primitives", [])
        mesh_all_uv = bool(prims)
        for prim in prims:
            total_prims += 1
            attrs = prim.get("attributes", {})
            has_uv = "TEXCOORD_0" in attrs
            if has_uv:
                prims_with_uv += 1
            else:
                mesh_all_uv = False

            mode = prim.get("mode", 4)  # 4 = TRIANGLES
            if "indices" in prim:
                count = accessors[prim["indices"]]["count"]
            elif "POSITION" in attrs:
                count = accessors[attrs["POSITION"]]["count"]
            else:
                count = 0

            if mode == 4:
                total_tris += count // 3
            elif mode in (5, 6):  # TRIANGLE_STRIP / TRIANGLE_FAN
                total_tris += max(0, count - 2)

        if mesh_all_uv:
            meshes_with_uv += 1
        else:
            missing_uv_meshes.append(m_name)

    mat_names = {m.get("name", "") for m in materials}
    node_names = {n.get("name", "") for n in nodes}

    return {
        "path": glb_path,
        "size_bytes": size_bytes,
        "triangles": total_tris,
        "meshes": len(meshes),
        "meshes_with_uv": meshes_with_uv,
        "primitives": total_prims,
        "primitives_with_uv": prims_with_uv,
        "missing_uv_meshes": missing_uv_meshes,
        "materials": len(materials),
        "has_headlight_glass": "headlight_glass" in mat_names,
        "has_steering_wheel": "steering_wheel" in node_names,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build Nanite-grade UE 5.8 hero cars via headless Blender."
    )
    parser.add_argument(
        "--only",
        default="",
        help="Comma-separated list of car IDs to build (default: all fleet cars)",
    )
    args = parser.parse_args()

    blender = find_blender()
    requested = [x.strip() for x in args.only.split(",") if x.strip()]

    staging_dir = tempfile.mkdtemp(prefix="og_nanite_cars_")
    try:
        cmd = [
            blender,
            "-b",
            "--factory-startup",
            "-P",
            SCULPT_SCRIPT,
            "--",
            "--ue5-nanite",
            "--out-dir",
            staging_dir,
        ]
        if requested:
            cmd.extend(["--only", ",".join(requested)])

        print(f"[nanite] Blender: {blender}")
        print(f"[nanite] Running: {' '.join(cmd)}")
        proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)

        if proc.stdout:
            for line in proc.stdout.splitlines():
                if line.startswith("[sculpt"):
                    print(f"  {line}")

        if proc.returncode != 0:
            sys.stderr.write(proc.stdout)
            sys.stderr.write(proc.stderr)
            print(f"[nanite] ERROR: Blender exited with code {proc.returncode}", file=sys.stderr)
            return proc.returncode

        if "Traceback (most recent call last):" in proc.stderr or "Traceback (most recent call last):" in proc.stdout:
            sys.stderr.write(proc.stderr)
            print("[nanite] ERROR: Python traceback detected in Blender output", file=sys.stderr)
            return 1

        staged_files = sorted(
            f for f in os.listdir(staging_dir) if f.endswith("_sculpt.glb")
        )
        if not staged_files:
            print("[nanite] ERROR: No GLB files were produced.", file=sys.stderr)
            return 1

        reports = []
        produced_ids = set()
        for fname in staged_files:
            car_id = fname[: -len("_sculpt.glb")]
            produced_ids.add(car_id)
            src = os.path.join(staging_dir, fname)
            dst_dir = os.path.join(IMPORT_ROOT, car_id)
            os.makedirs(dst_dir, exist_ok=True)
            dst = os.path.join(dst_dir, "nanite_hero.glb")
            shutil.move(src, dst)
            info = inspect_glb(dst)
            info["id"] = car_id
            reports.append(info)

        missing_req = [cid for cid in requested if cid not in produced_ids]
        if missing_req:
            print(f"[nanite] ERROR: Requested car IDs not found in FLEET: {', '.join(missing_req)}", file=sys.stderr)
            return 1

        print("\n=== UE 5.8 Nanite Hero Car Build Report ===")
        print(f"{'Car ID':<22} {'Triangles':>10} {'Meshes':>8} {'UV Coverage':>14} {'Size':>10}  Output")
        print("-" * 96)
        uv_failures = 0
        for r in reports:
            uv_ok = r["meshes_with_uv"] == r["meshes"] and r["primitives_with_uv"] == r["primitives"]
            uv_str = f"{r['meshes_with_uv']}/{r['meshes']} ({'OK' if uv_ok else 'MISS'})"
            size_mb = r["size_bytes"] / (1024 * 1024)
            rel_out = os.path.relpath(r["path"], REPO)
            print(
                f"{r['id']:<22} {r['triangles']:>10,} {r['meshes']:>8} {uv_str:>14} {size_mb:>8.2f}MB  {rel_out}"
            )
            if not uv_ok:
                uv_failures += 1
                print(f"  WARNING: Missing UVs on meshes: {', '.join(r['missing_uv_meshes'])}")

        print("-" * 96)
        print(
            f"Built {len(reports)} Nanite hero car(s) | "
            f"Total tris: {sum(r['triangles'] for r in reports):,} | "
            f"Total size: {sum(r['size_bytes'] for r in reports) / (1024 * 1024):.2f} MB"
        )
        return 1 if uv_failures else 0
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
