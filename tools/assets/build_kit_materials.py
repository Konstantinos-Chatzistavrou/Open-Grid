"""Generate web (KTX2) and Unreal (4K PNG) exports from the 12 Phase C kit material masters (docs/kit.md).
Never hand-edit the outputs: run this script again.

    tools/blender/blender -b --factory-startup --python tools/assets/build_kit_materials.py
    tools/blender/blender -b --factory-startup --python tools/assets/build_kit_materials.py -- --web-only
    tools/blender/blender -b --factory-startup --python tools/assets/build_kit_materials.py -- --ue-only

Runs inside Blender's Python for its bundled OpenImageIO + NumPy, and encodes KTX2 with tools/ktx/ (KTX-Software 4.4.2).
For every Phase C kit material (assets_source/masters/kit/<id>/):
  web/public/assets/kit/materials/<id>/
    diff.ktx2    sRGB albedo (2048 px road surfaces, 1024 px walls/roofs/metals), ETC1S + mipmaps
    nor.ktx2     linear OpenGL normal (Y-up, re-normalized after resize, <=1024 px), UASTC RDO + zstd + mipmaps
    arm.ktx2     linear packed AO (R), Roughness (G), Metalness (B), ETC1S + mipmaps
    disp.ktx2    linear height/displacement (half web size: 1024 px roads, 512 px walls), ETC1S + mipmaps
  web/public/assets/kit/materials/manifest.json
    index loaded by the browser: id, role, category, tile_m, web_size, files, has_metal, licence.
  ue5/SourceArt/Kit/materials/<id>/  (generated locally, gitignored)
    <id>_BaseColor.png   4096x4096 8-bit sRGB PNG
    <id>_Normal.png      4096x4096 16-bit linear DirectX normal PNG (Y-down for UE5)
    <id>_ORM.png         4096x4096 8-bit linear Occlusion / Roughness / Metallic PNG
    <id>_Height.png      4096x4096 16-bit linear grayscale displacement PNG

Note on Poly Haven EXR colour spaces (verified by measurement against Poly Haven JPG Diffuse):
  Poly Haven's Diffuse EXR files store sRGB-encoded values in [0..1] (DWAA compressed, slight overshoot > 1.0),
  NOT linear RGB. All channels are clamped to [0, 1] before quantization; no extra gamma curve is applied to Diffuse.
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import OpenImageIO as oiio

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KIT = os.path.join(ROOT, "assets_source", "masters", "kit")
WEB = os.path.join(ROOT, "web", "public", "assets", "kit", "materials")
UE = os.path.join(ROOT, "ue5", "SourceArt", "Kit", "materials")
KTX = os.path.join(ROOT, "tools", "ktx", "KTX-Software-4.4.2-Linux-x86_64")

# 12 Phase C materials: kit id -> (role, category, web_size)
# Road/ground surfaces: 2048 px web; walls/roofs/metals: 1024 px web. Unreal: full 4096 px.
MATERIALS = {
    "clean_asphalt":       ("dry_asphalt",    "road", 2048),
    "asphalt_02":          ("worn_asphalt",   "road", 2048),
    "brushed_concrete":    ("concrete_kerb",  "road", 2048),
    "painted_concrete_02": ("painted_kerb",   "road", 2048),
    "concrete_pavers_02":  ("paving_stones",  "road", 2048),
    "plastered_wall":      ("smooth_plaster", "wall", 1024),
    "rough_plaster_03":    ("rough_plaster",  "wall", 1024),
    "rustic_stone_wall":   ("stone_wall",     "wall", 1024),
    "red_brick":           ("brick",          "wall", 1024),
    "clay_roof_tiles_02":  ("roof_tiles",     "wall", 1024),
    "rusty_metal_04":      ("rusty_metal",    "wall", 1024),
    "blue_metal_plate":    ("painted_metal",  "wall", 1024),
}


def find_map(folder, files, tag):
    """Find the master file matching a Poly Haven map tag (Diffuse, nor_gl, Rough, AO, Displacement, Metal)."""
    needle = f"_{tag}_"
    for f in files:
        if needle in f:
            p = os.path.join(folder, f)
            if os.path.exists(p):
                return p
    return None


def read_float(path, channels):
    """Load an image via OpenImageIO as float32 HxWxC clamped to [0, 1]."""
    buf = oiio.ImageBuf(path)
    if buf.has_error:
        raise RuntimeError(f"{path}: {buf.geterror()}")
    sp = buf.spec()
    px = buf.get_pixels(oiio.FLOAT)
    if px.ndim == 2:
        px = px[:, :, None]
    if channels == 1:
        px = px[:, :, :1]
    elif px.shape[2] == 1 and channels == 3:
        px = np.repeat(px, 3, axis=2)
    else:
        px = px[:, :, :channels]
    return np.clip(px.astype(np.float32, copy=False), 0.0, 1.0), (sp.width, sp.height)


def resize_arr(arr, size):
    """Resize HxWxC float32 array to size x size with OIIO box/area filter (no ringing)."""
    h, w, c = arr.shape
    if h == size and w == size:
        return arr
    spec = oiio.ImageSpec(w, h, c, oiio.FLOAT)
    src = oiio.ImageBuf(spec)
    src.set_pixels(oiio.ROI(0, w, 0, h, 0, 1, 0, c), np.ascontiguousarray(arr, dtype=np.float32))
    dst = oiio.ImageBufAlgo.resize(src, filtername="box", roi=oiio.ROI(0, size, 0, size, 0, 1, 0, c))
    out = dst.get_pixels(oiio.FLOAT)
    if out.ndim == 2:
        out = out[:, :, None]
    return np.clip(out, 0.0, 1.0)


def renormalize_normals(n01):
    """Re-normalize [0,1]-encoded tangent-space normal map after resizing."""
    v = n01 * 2.0 - 1.0
    v[:, :, 2] = np.maximum(v[:, :, 2], 1e-4)
    lens = np.sqrt(np.sum(v * v, axis=2, keepdims=True))
    v /= np.maximum(lens, 1e-6)
    return np.clip(v * 0.5 + 0.5, 0.0, 1.0)


def write_png(arr, path, bits=8):
    """Write HxWxC float32 [0,1] array to 8-bit or 16-bit PNG via OpenImageIO."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.chmod(path, 0o644)
    h, w, c = arr.shape
    fmt = oiio.UINT16 if bits == 16 else oiio.UINT8
    spec = oiio.ImageSpec(w, h, c, fmt)
    buf = oiio.ImageBuf(spec)
    buf.set_pixels(oiio.ROI(0, w, 0, h, 0, 1, 0, c), np.ascontiguousarray(arr, dtype=np.float32))
    buf.set_write_format(fmt)
    if not buf.write(path):
        raise RuntimeError(f"{path}: {buf.geterror()}")


def encode_ktx2(png_path, out_path, kind, env, toktx):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if kind == "nor":
        enc = ["--assign_oetf", "linear", "--encode", "uastc", "--uastc_quality", "2", "--uastc_rdo_l", "2", "--zcmp", "19"]
    elif kind == "diff":
        enc = ["--assign_oetf", "srgb", "--encode", "etc1s", "--qlevel", "220", "--clevel", "4"]
    elif kind == "disp":
        enc = ["--assign_oetf", "linear", "--encode", "etc1s", "--qlevel", "190", "--clevel", "4"]
    else:  # arm
        enc = ["--assign_oetf", "linear", "--encode", "etc1s", "--qlevel", "200", "--clevel", "4"]
    subprocess.run([toktx, "--t2", "--genmipmap", *enc, out_path, png_path], check=True, env=env)


def tile_metres(folder):
    """Real-world tile size [w, h] in metres from Poly Haven API evidence (dimensions are in mm)."""
    ev = os.path.join(folder, "evidence", "polyhaven_info.json")
    if os.path.exists(ev):
        dims = json.load(open(ev)).get("dimensions")
        if isinstance(dims, list) and len(dims) == 2 and dims[0] > 0 and dims[1] > 0:
            return [round(dims[0] / 1000.0, 3), round(dims[1] / 1000.0, 3)]
    return [2.0, 2.0]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    do_web = "--ue-only" not in argv
    do_ue = "--web-only" not in argv
    only = {a for a in argv if not a.startswith("-")}

    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(KTX, "lib") + ":" + os.environ.get("LD_LIBRARY_PATH", ""))
    toktx = os.path.join(KTX, "bin", "toktx")
    if do_web and not os.path.exists(toktx):
        raise RuntimeError(f"missing {toktx}")

    manifest = []
    web_total = 0
    ue_total = 0

    with tempfile.TemporaryDirectory(prefix="kit_mat_") as tmp:
        for aid, (role, cat, web_sz) in MATERIALS.items():
            if only and aid not in only:
                continue
            folder = os.path.join(KIT, aid)
            ledger_path = os.path.join(folder, "source.json")
            if not os.path.exists(ledger_path):
                print(f"SKIP {aid}: no source.json")
                continue
            d = json.load(open(ledger_path))
            files = d.get("files", [])
            p_diff = find_map(folder, files, "Diffuse")
            p_nor = find_map(folder, files, "nor_gl")
            p_rough = find_map(folder, files, "Rough")
            p_ao = find_map(folder, files, "AO")
            p_disp = find_map(folder, files, "Displacement")
            p_metal = find_map(folder, files, "Metal")
            if not (p_diff and p_nor and p_rough and p_ao and p_disp):
                raise RuntimeError(f"{aid}: missing required map(s) in {folder}")

            diff, src_sz = read_float(p_diff, 3)
            nor, _ = read_float(p_nor, 3)
            rough, _ = read_float(p_rough, 1)
            ao, _ = read_float(p_ao, 1)
            disp, _ = read_float(p_disp, 1)
            if p_metal:
                metal, _ = read_float(p_metal, 1)
            else:
                metal = np.zeros_like(rough)
            arm = np.concatenate([ao, rough, metal], axis=2)

            # ---- Unreal 4K PNG exports (local, gitignored)
            ue_kb = 0
            if do_ue:
                ue_dir = os.path.join(UE, aid)
                nor_dx = nor.copy()
                nor_dx[:, :, 1] = 1.0 - nor_dx[:, :, 1]  # DirectX Y-down for UE5
                nor_dx = renormalize_normals(nor_dx)
                ue_files = [
                    (diff, os.path.join(ue_dir, f"{aid}_BaseColor.png"), 8),
                    (nor_dx, os.path.join(ue_dir, f"{aid}_Normal.png"), 16),
                    (arm, os.path.join(ue_dir, f"{aid}_ORM.png"), 8),
                    (disp, os.path.join(ue_dir, f"{aid}_Height.png"), 16),
                ]
                for arr, out_p, bits in ue_files:
                    write_png(arr, out_p, bits=bits)
                    ue_kb += os.path.getsize(out_p) // 1024
                ue_total += ue_kb

            # ---- Web KTX2 exports (committed)
            web_kb = 0
            nor_sz = min(web_sz, 1024)
            disp_sz = web_sz // 2
            if do_web:
                web_dir = os.path.join(WEB, aid)
                w_diff = resize_arr(diff, web_sz)
                w_nor = renormalize_normals(resize_arr(nor, nor_sz))
                w_arm = resize_arr(arm, web_sz)
                w_disp = np.repeat(resize_arr(disp, disp_sz), 3, axis=2)  # RGB grayscale for universal ETC1S->BC7
                jobs = [
                    ("diff", w_diff, os.path.join(web_dir, "diff.ktx2")),
                    ("nor",  w_nor,  os.path.join(web_dir, "nor.ktx2")),
                    ("arm",  w_arm,  os.path.join(web_dir, "arm.ktx2")),
                    ("disp", w_disp, os.path.join(web_dir, "disp.ktx2")),
                ]
                for kind, arr, out_p in jobs:
                    tmp_png = os.path.join(tmp, f"{aid}_{kind}.png")
                    write_png(arr, tmp_png, bits=8)
                    encode_ktx2(tmp_png, out_p, kind, env, toktx)
                    os.remove(tmp_png)
                    web_kb += os.path.getsize(out_p) // 1024
                web_total += web_kb

            tm = tile_metres(folder)
            manifest.append({
                "id": aid,
                "role": role,
                "category": cat,
                "name": d["name"],
                "tile_m": tm,
                "web_size": web_sz,
                "nor_size": nor_sz,
                "disp_size": disp_sz,
                "has_metal": bool(p_metal),
                "files": {
                    "diff": f"{aid}/diff.ktx2",
                    "nor":  f"{aid}/nor.ktx2",
                    "arm":  f"{aid}/arm.ktx2",
                    "disp": f"{aid}/disp.ktx2",
                },
                "licence": d["licence"],
                "source_size": [src_sz[0], src_sz[1]],
            })
            print(f"{aid:22s} ({role:14s}) {src_sz[0]}x{src_sz[1]} tile={tm[0]}x{tm[1]}m -> "
                  f"web({web_sz}px) {web_kb / 1024:.2f} MB, ue5(4K PNG) {ue_kb / 1024:.1f} MB")

    if do_web and not only:
        os.makedirs(WEB, exist_ok=True)
        with open(os.path.join(WEB, "manifest.json"), "w") as f:
            json.dump({"generated_by": "tools/assets/build_kit_materials.py", "materials": manifest}, f, indent=2)
            f.write("\n")
    print(f"TOTAL: web {web_total / 1024:.2f} MB, ue5 {ue_total / 1024:.1f} MB ({len(manifest)} materials)")


if __name__ == "__main__":
    main()
