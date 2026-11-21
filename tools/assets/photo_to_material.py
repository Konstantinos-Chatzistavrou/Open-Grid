#!/usr/bin/env python3
"""Kit v1 Phase D: Turn straight-on phone photos + corners.json into tileable 4K PBR master materials (docs/kit.md).

    python3 tools/assets/photo_to_material.py <photos_folder> [--out <masters_root>] [--res 4096]

If system Python does not have OpenImageIO installed, this script automatically re-invokes itself through the repo's
bundled Blender Python (`tools/blender/blender -b --factory-startup --python ...`).

Input folder layout:
  <photos_folder>/
    corners.json       { "<filename>.jpg": { "id": "<kit_id>", "name": "<Title>",
                         "corners": [[x_tl, y_tl], [x_tr, y_tr], [x_br, y_br], [x_bl, y_bl]],
                         "dimensions_m": [2.0, 2.0], "base_roughness": 0.72 } }
                       (also accepts the shorthand `{ "<filename>.jpg": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] }`)
    <filename>.jpg     straight-on phone photo(s)

Pipeline per photo:
  1. Perspective correction: exact 8-DOF homography warps the 4 quadrilateral corners to a square master grid (default
     4096x4096 from `data/asset_budgets.json` `masterResolution`).
  2. High-pass delighting: removes large-scale lighting gradients while preserving mean reflectance and local contrast.
  3. Seamless tileability: blends the delit image with its half-period toroidal shift `(W/2, H/2)` using a smooth
     raised-cosine border mask `sin^2(pi*x/W) * sin^2(pi*y/H)` so all edges tile periodically with zero visible seams.
  4. Approximate PBR maps: estimates height (`Displacement`), OpenGL normal (`nor_gl`), `Rough`, and `AO` from multi-scale
     luminance relief and local micro-variance.
     IMPORTANT LIMITATION: Normals, height, roughness and AO estimated from a single photograph are approximations
     (albedo-relief heuristics) and are weaker than real multi-angle photometric scans or laser scans.
  5. Writes read-only 4K EXR master files (`<id>_Diffuse_4k.exr`, `<id>_nor_gl_4k.exr`, `<id>_Rough_4k.exr`,
     `<id>_AO_4k.exr`, `<id>_Displacement_4k.exr`) + `source.json` ("own photo, CC BY-NC 4.0, Konstantinos Chatzistavrou")
     and `evidence/photo_to_material.json`.
"""
import datetime
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    import numpy as np
    import OpenImageIO as oiio
except ImportError:
    blender = os.path.join(ROOT, "tools", "blender", "blender")
    if os.path.exists(blender) and "--in-blender" not in sys.argv:
        cmd = [blender, "-b", "--factory-startup", "--python", os.path.abspath(__file__), "--", "--in-blender", *sys.argv[1:]]
        sys.exit(subprocess.call(cmd))
    raise


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    argv = [a for a in argv if a != "--in-blender"]
    if not argv:
        sys.exit(__doc__)
    folder = os.path.abspath(argv[0])
    out_root = os.path.join(ROOT, "assets_source", "masters", "kit")
    budget_p = os.path.join(ROOT, "data", "asset_budgets.json")
    res = int(json.load(open(budget_p)).get("masterResolution", 4096)) if os.path.exists(budget_p) else 4096
    i = 1
    while i < len(argv):
        if argv[i] == "--out" and i + 1 < len(argv):
            out_root = os.path.abspath(argv[i + 1])
            i += 2
        elif argv[i] == "--res" and i + 1 < len(argv):
            res = int(argv[i + 1])
            i += 2
        else:
            i += 1
    return folder, out_root, res


def solve_homography(dst_pts, src_pts):
    """Solve 3x3 homography H mapping dst (u, v) -> src (x, y) from 4 corner correspondences."""
    A = []
    b = []
    for (u, v), (x, y) in zip(dst_pts, src_pts):
        A.append([u, v, 1, 0, 0, 0, -u * x, -v * x])
        A.append([0, 0, 0, u, v, 1, -u * y, -v * y])
        b.append(x)
        b.append(y)
    h = np.linalg.solve(np.asarray(A, dtype=np.float64), np.asarray(b, dtype=np.float64))
    return np.array([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]], dtype=np.float64)


def warp_perspective(img, corners, out_size):
    """Homography perspective warp of quadrilateral `corners` [TL, TR, BR, BL] into an `out_size x out_size` square."""
    h_in, w_in, c = img.shape
    dst_corners = [(0.0, 0.0), (float(out_size - 1), 0.0), (float(out_size - 1), float(out_size - 1)), (0.0, float(out_size - 1))]
    H = solve_homography(dst_corners, corners)
    out = np.empty((out_size, out_size, c), dtype=np.float32)
    u = np.arange(out_size, dtype=np.float32)
    chunk = 256
    for y0 in range(0, out_size, chunk):
        y1 = min(out_size, y0 + chunk)
        v = np.arange(y0, y1, dtype=np.float32)[:, None]
        u_grid = u[None, :]
        denom = np.maximum(1e-6, H[2, 0] * u_grid + H[2, 1] * v + H[2, 2])
        sx = np.clip((H[0, 0] * u_grid + H[0, 1] * v + H[0, 2]) / denom, 0.0, w_in - 1.001)
        sy = np.clip((H[1, 0] * u_grid + H[1, 1] * v + H[1, 2]) / denom, 0.0, h_in - 1.001)
        ix0 = sx.astype(np.int32)
        iy0 = sy.astype(np.int32)
        ix1 = np.minimum(w_in - 1, ix0 + 1)
        iy1 = np.minimum(h_in - 1, iy0 + 1)
        fx = (sx - ix0)[:, :, None]
        fy = (sy - iy0)[:, :, None]
        p00 = img[iy0, ix0]
        p10 = img[iy0, ix1]
        p01 = img[iy1, ix0]
        p11 = img[iy1, ix1]
        out[y0:y1] = (p00 * (1.0 - fx) + p10 * fx) * (1.0 - fy) + (p01 * (1.0 - fx) + p11 * fx) * fy
    return np.clip(out, 0.0, 1.0)


def periodic_box_blur(arr, radius):
    """Fast periodic (toroidal wrap-around) 2D box blur using cumulative sums."""
    if radius <= 0:
        return arr
    out = arr.astype(np.float32, copy=True)
    r = int(radius)
    w = 2 * r + 1
    is3d = out.ndim == 3
    for _ in range(2):
        # Horizontal pass
        pad_x = np.pad(out, ((0, 0), (r, r), (0, 0)) if is3d else ((0, 0), (r, r)), mode="wrap")
        zero_x = np.zeros((pad_x.shape[0], 1, pad_x.shape[2]) if is3d else (pad_x.shape[0], 1), dtype=np.float64)
        cs_x = np.concatenate([zero_x, np.cumsum(pad_x, axis=1, dtype=np.float64)], axis=1)
        out = ((cs_x[:, w:] - cs_x[:, :-w]) / w).astype(np.float32)
        # Vertical pass
        pad_y = np.pad(out, ((r, r), (0, 0), (0, 0)) if is3d else ((r, r), (0, 0)), mode="wrap")
        zero_y = np.zeros((1, pad_y.shape[1], pad_y.shape[2]) if is3d else (1, pad_y.shape[1]), dtype=np.float64)
        cs_y = np.concatenate([zero_y, np.cumsum(pad_y, axis=0, dtype=np.float64)], axis=0)
        out = ((cs_y[w:, :] - cs_y[:-w, :]) / w).astype(np.float32)
    return out


def delight_highpass(img):
    """Remove large low-frequency lighting gradients while keeping average colour and mid/fine surface detail."""
    n = img.shape[0]
    radius = max(16, n // 12)
    # Compute low-frequency illumination on a 4x downsampled grid for speed & low RAM on 4K images
    small = img[::4, ::4]
    low_small = periodic_box_blur(small, max(4, radius // 4))
    # Upsample low-frequency illumination back to full resolution via OIIO resize
    sh, sw, sc = low_small.shape
    buf_s = oiio.ImageBuf(oiio.ImageSpec(sw, sh, sc, oiio.FLOAT))
    buf_s.set_pixels(oiio.ROI(0, sw, 0, sh, 0, 1, 0, sc), np.ascontiguousarray(low_small, dtype=np.float32))
    buf_l = oiio.ImageBufAlgo.resize(buf_s, filtername="box", roi=oiio.ROI(0, n, 0, n, 0, 1, 0, sc))
    low = buf_l.get_pixels(oiio.FLOAT)
    mean_col = img.mean(axis=(0, 1), keepdims=True)
    delit = img * (mean_col / np.maximum(low, 0.04))
    return np.clip(delit, 0.0, 1.0)


def make_tileable(img):
    """Make an image seamlessly tileable by blending it with its (W/2, H/2) offset via a smooth sin^2 border weight."""
    n = img.shape[0]
    shifted = np.roll(np.roll(img, n // 2, axis=0), n // 2, axis=1)
    t = np.linspace(0.0, np.pi, n, endpoint=False, dtype=np.float32)
    w1d = np.sin(t) ** 2
    # Sharp transition band around the seam so the interior stays sharp and un-ghosted
    w2d = np.clip((w1d[:, None] * w1d[None, :] - 0.15) / 0.70, 0.0, 1.0)
    w2d = w2d * w2d * (3.0 - 2.0 * w2d)
    if img.ndim == 3:
        w2d = w2d[:, :, None]
    return np.clip(img * w2d + shifted * (1.0 - w2d), 0.0, 1.0)


def estimate_pbr_maps(albedo, base_rough=0.72, bump_strength=2.4):
    """Estimate approximate Height, OpenGL Normal, Roughness, and AO from a tileable delit albedo image."""
    lum = (0.2126 * albedo[:, :, 0] + 0.7152 * albedo[:, :, 1] + 0.0722 * albedo[:, :, 2]).astype(np.float32)
    n = lum.shape[0]
    scale = max(1, n // 1024)
    # Multi-scale height approximation (bright aggregate peaks vs dark crevice valleys)
    fine = lum - periodic_box_blur(lum, 2 * scale)
    mid = lum - periodic_box_blur(lum, 10 * scale)
    broad = lum - periodic_box_blur(lum, 36 * scale)
    raw_h = 0.50 * fine + 0.35 * mid + 0.15 * broad
    std_h = max(float(raw_h.std()), 1e-4)
    disp = np.clip(0.5 + (raw_h / (4.0 * std_h)), 0.0, 1.0).astype(np.float32)

    # Periodic central differences -> OpenGL tangent-space normal (+X right, +Y up, +Z out)
    dh_dx = (np.roll(disp, -1, axis=1) - np.roll(disp, 1, axis=1)) * (0.5 * bump_strength * scale)
    dh_dy = (np.roll(disp, 1, axis=0) - np.roll(disp, -1, axis=0)) * (0.5 * bump_strength * scale)
    nx = -dh_dx
    ny = -dh_dy
    nz = np.ones_like(disp)
    inv_len = 1.0 / np.maximum(np.sqrt(nx * nx + ny * ny + nz * nz), 1e-6)
    nor_gl = np.stack([nx * inv_len * 0.5 + 0.5, ny * inv_len * 0.5 + 0.5, nz * inv_len * 0.5 + 0.5], axis=2).astype(np.float32)

    # Roughness: base roughness modulated by local micro-variance + deeper crevices rougher
    micro_var = np.abs(fine) / max(float(np.abs(fine).mean()), 1e-4)
    rough = np.clip(base_rough + (0.5 - disp) * 0.22 + (micro_var - 1.0) * 0.06, 0.12, 0.98).astype(np.float32)

    # Ambient occlusion: dark micro/mid cavities occlude ambient light
    cavity = np.minimum(0.0, 0.6 * fine + 0.4 * mid) / std_h
    ao = np.clip(1.0 + cavity * 0.18, 0.35, 1.0).astype(np.float32)
    return disp[:, :, None], np.clip(nor_gl, 0.0, 1.0), rough[:, :, None], ao[:, :, None]


def write_exr(arr, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.chmod(path, 0o644)
    h, w, c = arr.shape
    spec = oiio.ImageSpec(w, h, c, oiio.HALF)
    spec.attribute("compression", "zip")
    buf = oiio.ImageBuf(spec)
    buf.set_pixels(oiio.ROI(0, w, 0, h, 0, 1, 0, c), np.ascontiguousarray(arr, dtype=np.float32))
    buf.set_write_format(oiio.HALF)
    if not buf.write(path):
        raise RuntimeError(f"{path}: {buf.geterror()}")
    os.chmod(path, 0o444)


def main():
    folder, out_root, res = parse_args()
    corners_path = os.path.join(folder, "corners.json")
    if not os.path.exists(corners_path):
        sys.exit(f"missing {corners_path}")
    cfg = json.load(open(corners_path))
    release = os.environ.get("MASTER_RELEASE", "kit-masters-v1")
    today = datetime.date.today().isoformat()
    res_tag = f"{res // 1024}k"

    entries = []
    if isinstance(cfg, dict):
        for fname, val in cfg.items():
            if isinstance(val, list):
                aid = os.path.splitext(fname)[0].lower()
                entries.append({"file": fname, "id": aid, "name": aid.replace("_", " ").title(), "corners": val})
            elif isinstance(val, dict):
                aid = val.get("id") or os.path.splitext(fname)[0].lower()
                entries.append({"file": fname, "id": aid, "name": val.get("name", aid.replace("_", " ").title()), **val})
    elif isinstance(cfg, list):
        entries = cfg

    for e in entries:
        src_path = os.path.join(folder, e["file"])
        if not os.path.exists(src_path):
            sys.exit(f"missing photo {src_path}")
        buf = oiio.ImageBuf(src_path)
        if buf.has_error:
            sys.exit(f"{src_path}: {buf.geterror()}")
        sp = buf.spec()
        px = buf.get_pixels(oiio.FLOAT)
        if px.ndim == 2:
            px = np.repeat(px[:, :, None], 3, axis=2)
        else:
            px = px[:, :, :3]
        px = np.clip(px, 0.0, 1.0)
        corners = e.get("corners") or [[0, 0], [sp.width - 1, 0], [sp.width - 1, sp.height - 1], [0, sp.height - 1]]
        if len(corners) != 4:
            sys.exit(f"{e['file']}: corners must be 4 [x, y] points [TL, TR, BR, BL]")

        aid = e["id"]
        warped = warp_perspective(px, corners, res)
        delit = delight_highpass(warped)
        albedo = make_tileable(delit)
        disp, nor_gl, rough, ao = estimate_pbr_maps(
            albedo,
            base_rough=float(e.get("base_roughness", 0.72)),
            bump_strength=float(e.get("bump_strength", 2.4)),
        )

        kit_dir = os.path.join(out_root, aid)
        os.makedirs(os.path.join(kit_dir, "evidence"), exist_ok=True)
        maps = [
            ("Diffuse", albedo),
            ("nor_gl", nor_gl),
            ("Rough", rough),
            ("AO", ao),
            ("Displacement", disp),
        ]
        written = []
        for tag, arr in maps:
            fn = f"{aid}_{tag}_{res_tag}.exr"
            out_p = os.path.join(kit_dir, fn)
            write_exr(arr, out_p)
            written.append((tag, fn, os.path.getsize(out_p)))

        dims_m = e.get("dimensions_m", [2.0, 2.0])
        evidence = {
            "tool": "tools/assets/photo_to_material.py",
            "source_photo": e["file"],
            "source_resolution": [sp.width, sp.height],
            "corners_px": corners,
            "master_resolution": [res, res],
            "dimensions_m": dims_m,
            "approximation_notice": (
                "Height, normal, roughness and AO are estimated from a single straight-on photograph via multi-scale "
                "high-pass relief and local variance heuristics. Single-photo normals are approximations, weaker than "
                "real multi-angle photometric stereo or laser scans."
            ),
        }
        json.dump(evidence, open(os.path.join(kit_dir, "evidence", "photo_to_material.json"), "w"), indent=2)
        open(os.path.join(kit_dir, "evidence", "photo_to_material.json"), "a").write("\n")

        ledger = {
            "name": e.get("name", aid),
            "url": "https://github.com/Konstantinos-Chatzistavrou/Open-Grid",
            "author": "Konstantinos Chatzistavrou",
            "licence": "CC-BY-NC-4.0",
            "licence_url": "https://creativecommons.org/licenses/by-nc/4.0/",
            "downloaded": today,
            "files": [fn for _, fn, _ in written],
            "notes": (
                f"own photo, CC BY-NC 4.0, Konstantinos Chatzistavrou ({e['file']}, {sp.width}x{sp.height} -> "
                f"{res_tag.upper()} EXR: " + ", ".join(f"{t} {sz / 1048576:.1f} MB" for t, _, sz in written)
                + f"). Perspective-corrected from 4 corners, high-pass delit, and offset+seam-blended by "
                f"tools/assets/photo_to_material.py. Real-world size {dims_m[0]:g} x {dims_m[1]:g} m. "
                f"Note: normals, height, roughness and AO estimated from single photos are approximations, weaker than "
                f"real multi-angle scans."
            ),
            "sha256": {fn: hashlib.sha256(open(os.path.join(kit_dir, fn), "rb").read()).hexdigest() for _, fn, _ in written},
            "master_release": release,
        }
        json.dump(ledger, open(os.path.join(kit_dir, "source.json"), "w"), indent=2, ensure_ascii=False)
        open(os.path.join(kit_dir, "source.json"), "a").write("\n")
        total_mb = sum(sz for _, _, sz in written) / 1048576
        print(f"{aid}: {', '.join(fn for _, fn, _ in written)} ({total_mb:.1f} MB), CC-BY-NC-4.0 Konstantinos Chatzistavrou")


if __name__ == "__main__":
    main()
