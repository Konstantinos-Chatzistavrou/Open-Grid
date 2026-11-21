#!/usr/bin/env python3
"""
Apache-2.0 — Generate the exact OpenGrid "Tokyo Night" 3D Color Grading LUTs for UE 5.8.

Implements the exact display-space color transform from `web/src/fx/grade.ts`
(`LOOKS.tokyo_night` in `toneGrade()`):
  1. Smoothstep S-curve contrast blend (`contrast = 0.28`)
  2. Black-point lift (`lift = 0.004`)
  3. Display gamma (`gamma = 0.96`, exponent `1.0 / gamma`)
  4. Rec.709 luma saturation (`sat = 1.18`)
  5. Smoothstep shadow/highlight split-toning (`split = 0.44`,
     `shadowTint = [-0.024, 0.075, 0.195]`, `highlightTint = [0.18, 0.09, 0.04]`)
  6. Clamp to `[0.0, 1.0]`

Outputs:
  - `data/ue5/TokyoNight_33.cube`         (standard 33x33x33 Adobe .cube 3D LUT)
  - `data/ue5/TokyoNight_UE5_256x16.png`  (UE 5.8 native 256x16 RGB8 strip LUT:
                                           16 tiles of 16x16; tile = B, x = R, y = G)

Usage:
  python3 tools/ue5/generate_tokyo_night_lut.py
  python3 tools/ue5/generate_tokyo_night_lut.py --verify
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Exact parameters from web/src/fx/grade.ts -> LOOKS.tokyo_night
TOKYO_NIGHT = {
    "contrast": 0.28,
    "lift": 0.004,
    "gamma": 0.96,
    "sat": 1.18,
    "split": 0.44,
    "shadow_tint": np.array([-0.024, 0.075, 0.195], dtype=np.float64),
    "highlight_tint": np.array([0.18, 0.09, 0.04], dtype=np.float64),
}

LUMA_WEIGHTS = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)
CUBE_SIZE = 33
UE5_LUT_TILE = 16  # 16x16x16 -> 256x16 horizontal slice strip


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    """GLSL/TSL smoothstep(edge0, edge1, x)."""
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def apply_tokyo_night_grade(rgb: np.ndarray) -> np.ndarray:
    """
    Exact display-space color transform from `web/src/fx/grade.ts` (`toneGrade`, lines 110-129).

    Args:
        rgb: Array of shape (..., 3) with display-referred sRGB values in [0, 1].
    Returns:
        Graded sRGB array of shape (..., 3) clamped to [0, 1].
    """
    c = np.clip(np.asarray(rgb, dtype=np.float64), 0.0, 1.0)

    # 1. Contrast: blend with smoothstep S-curve c*c*(3 - 2*c)
    contrast = TOKYO_NIGHT["contrast"]
    s_curve = c * c * (3.0 - 2.0 * c)
    c = c * (1.0 - contrast) + s_curve * contrast

    # 2. Lift (black point) & gamma
    lift = TOKYO_NIGHT["lift"]
    gamma = TOKYO_NIGHT["gamma"]
    c = c * (1.0 - lift) + lift
    c = np.power(np.maximum(c, 0.0), 1.0 / gamma)

    # 3. Saturation about Rec.709 luma
    l = np.sum(c * LUMA_WEIGHTS, axis=-1, keepdims=True)
    sat = TOKYO_NIGHT["sat"]
    c = l * (1.0 - sat) + c * sat

    # 4. Split toning using pre-saturation luma `l` (matches grade.ts lines 118-123)
    ws = 1.0 - smoothstep(0.0, 0.45, l)
    wh = smoothstep(0.5, 1.0, l)
    split = TOKYO_NIGHT["split"]
    shadow_tint = TOKYO_NIGHT["shadow_tint"]
    highlight_tint = TOKYO_NIGHT["highlight_tint"]
    c = c + (shadow_tint * ws + highlight_tint * wh) * split

    return np.clip(c, 0.0, 1.0)


def write_cube_lut(path: Path, size: int = CUBE_SIZE) -> np.ndarray:
    """
    Generate standard Adobe .cube 3D LUT (R fastest, then G, then B).
    Returns the (size, size, size, 3) table indexed as [b, g, r, c].
    """
    axis = np.linspace(0.0, 1.0, size, dtype=np.float64)
    # Build grid in [b, g, r] order so flattening iterates R fastest, then G, then B
    b_grid, g_grid, r_grid = np.meshgrid(axis, axis, axis, indexing="ij")
    in_rgb = np.stack([r_grid, g_grid, b_grid], axis=-1)
    out_rgb = apply_tokyo_night_grade(in_rgb)

    flat = out_rgb.reshape(-1, 3)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# OpenGrid Tokyo Night 3D Color Grading LUT",
        "# Exact display-space transform from web/src/fx/grade.ts (LOOKS.tokyo_night)",
        'TITLE "OpenGrid Tokyo Night"',
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
        f"LUT_3D_SIZE {size}",
        "",
    ]
    lines.extend(f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in flat)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out_rgb


def write_ue5_strip_png(path: Path, tile: int = UE5_LUT_TILE) -> np.ndarray:
    """
    Generate UE 5.8 native 256x16 RGB8 horizontal slice strip PNG.
    Layout: 16 tiles of 16x16 where tile index = B [0..15], x within tile = R [0..15], y = G [0..15].
    Returns uint8 image array of shape (16, 256, 3).
    """
    axis = np.linspace(0.0, 1.0, tile, dtype=np.float64)
    # Build [g, b, r] so reshaping to (tile, tile * tile, 3) places:
    #   row y = g [0..15]
    #   col x = b * 16 + r [0..255]
    g_grid, b_grid, r_grid = np.meshgrid(axis, axis, axis, indexing="ij")
    in_rgb = np.stack([r_grid, g_grid, b_grid], axis=-1)  # (G, B, R, 3)
    out_rgb = apply_tokyo_night_grade(in_rgb)

    strip_f = out_rgb.reshape(tile, tile * tile, 3)
    strip_u8 = np.rint(strip_f * 255.0).astype(np.uint8)

    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(strip_u8, mode="RGB")
    img.save(path, format="PNG", compress_level=6)
    return strip_u8


def parse_cube_lut(path: Path) -> tuple[dict[str, str], np.ndarray]:
    """Read and parse an Adobe .cube 3D LUT into metadata + (N, N, N, 3) array [b, g, r, c]."""
    meta: dict[str, str] = {}
    rows: list[tuple[float, float, float]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("TITLE "):
            meta["TITLE"] = line[len("TITLE "):].strip()
        elif line.startswith(("LUT_3D_SIZE ", "DOMAIN_MIN ", "DOMAIN_MAX ")):
            key, val = line.split(None, 1)
            meta[key] = val.strip()
        else:
            parts = line.split()
            if len(parts) != 3:
                raise ValueError(f"Malformed .cube data line: {line!r}")
            rows.append((float(parts[0]), float(parts[1]), float(parts[2])))

    size = int(meta["LUT_3D_SIZE"])
    expected = size ** 3
    if len(rows) != expected:
        raise ValueError(f"Expected {expected} LUT entries, got {len(rows)}")
    arr = np.array(rows, dtype=np.float64).reshape(size, size, size, 3)
    return meta, arr


def trilinear_sample_cube(table_bgr: np.ndarray, rgb: np.ndarray) -> np.ndarray:
    """Trilinear interpolation on a [b, g, r, 3] 3D LUT table for a single RGB point in [0, 1]."""
    n = table_bgr.shape[0]
    coords = np.clip(rgb, 0.0, 1.0) * (n - 1)
    r_f, g_f, b_f = coords
    r0, g0, b0 = int(np.floor(r_f)), int(np.floor(g_f)), int(np.floor(b_f))
    r1, g1, b1 = min(r0 + 1, n - 1), min(g0 + 1, n - 1), min(b0 + 1, n - 1)
    dr, dg, db = r_f - r0, g_f - g0, b_f - b0

    c000 = table_bgr[b0, g0, r0]
    c100 = table_bgr[b0, g0, r1]
    c010 = table_bgr[b0, g1, r0]
    c110 = table_bgr[b0, g1, r1]
    c001 = table_bgr[b1, g0, r0]
    c101 = table_bgr[b1, g0, r1]
    c011 = table_bgr[b1, g1, r0]
    c111 = table_bgr[b1, g1, r1]

    c00 = c000 * (1 - dr) + c100 * dr
    c10 = c010 * (1 - dr) + c110 * dr
    c01 = c001 * (1 - dr) + c101 * dr
    c11 = c011 * (1 - dr) + c111 * dr
    c0 = c00 * (1 - dg) + c10 * dg
    c1 = c01 * (1 - dg) + c11 * dg
    return c0 * (1 - db) + c1 * db


def verify_outputs(cube_path: Path, png_path: Path) -> None:
    """Run comprehensive self-tests on both generated LUT files."""
    errors: list[str] = []

    # 1. Verify .cube header, dimensions, and range
    if not cube_path.is_file():
        raise AssertionError(f"Missing .cube file: {cube_path}")
    meta, cube = parse_cube_lut(cube_path)
    if meta.get("TITLE") != '"OpenGrid Tokyo Night"':
        errors.append(f"Unexpected TITLE: {meta.get('TITLE')!r}")
    if meta.get("LUT_3D_SIZE") != "33":
        errors.append(f"Unexpected LUT_3D_SIZE: {meta.get('LUT_3D_SIZE')!r}")
    if meta.get("DOMAIN_MIN") != "0.0 0.0 0.0" or meta.get("DOMAIN_MAX") != "1.0 1.0 1.0":
        errors.append(f"Unexpected domain: {meta.get('DOMAIN_MIN')} .. {meta.get('DOMAIN_MAX')}")
    if cube.min() < 0.0 or cube.max() > 1.0:
        errors.append(f".cube values out of [0, 1]: min={cube.min()}, max={cube.max()}")

    # 2. Verify UE 5.8 256x16 strip PNG
    if not png_path.is_file():
        raise AssertionError(f"Missing PNG LUT file: {png_path}")
    with Image.open(png_path) as img:
        if img.size != (256, 16):
            errors.append(f"Unexpected PNG size: {img.size}, expected (256, 16)")
        if img.mode != "RGB":
            errors.append(f"Unexpected PNG mode: {img.mode}, expected 'RGB'")
        png_u8 = np.asarray(img, dtype=np.uint8)

    # Convert PNG strip back to [b, g, r, 3] float in [0, 1]
    png_bgr = np.zeros((16, 16, 16, 3), dtype=np.float64)
    for b_idx in range(16):
        for g_idx in range(16):
            for r_idx in range(16):
                png_bgr[b_idx, g_idx, r_idx] = png_u8[g_idx, b_idx * 16 + r_idx] / 255.0

    # 3. Exact math match on both grids
    axis_33 = np.linspace(0.0, 1.0, 33, dtype=np.float64)
    b33, g33, r33 = np.meshgrid(axis_33, axis_33, axis_33, indexing="ij")
    ref_33 = apply_tokyo_night_grade(np.stack([r33, g33, b33], axis=-1))
    max_cube_err = float(np.max(np.abs(cube - ref_33)))
    if max_cube_err > 1e-6:
        errors.append(f".cube max numeric error {max_cube_err:.2e} > 1e-6")

    axis_16 = np.linspace(0.0, 1.0, 16, dtype=np.float64)
    b16, g16, r16 = np.meshgrid(axis_16, axis_16, axis_16, indexing="ij")
    ref_16 = apply_tokyo_night_grade(np.stack([r16, g16, b16], axis=-1))
    max_png_lsb_err = float(np.max(np.abs(png_bgr * 255.0 - np.rint(ref_16 * 255.0))))
    if max_png_lsb_err > 0.0:
        errors.append(f"PNG strip max LSB error {max_png_lsb_err} > 0")

    # 4. Monotonicity along neutral diagonal (0..1) and per-axis channel dominance
    diag_33 = np.array([cube[i, i, i] for i in range(33)])
    luma_33 = diag_33 @ LUMA_WEIGHTS
    if not np.all(np.diff(luma_33) >= -1e-9):
        errors.append("Neutral ramp luma is not monotonically non-decreasing in .cube")

    diag_16 = np.array([png_bgr[i, i, i] for i in range(16)])
    luma_16 = diag_16 @ LUMA_WEIGHTS
    if not np.all(np.diff(luma_16) >= -1e-9):
        errors.append("Neutral ramp luma is not monotonically non-decreasing in PNG strip")

    # Pure channel identity/ordering sanity check (R-axis stays R-dominant, G stays G, B stays B)
    if not (cube[0, 0, -1, 0] > cube[0, 0, -1, 1] and cube[0, 0, -1, 0] > cube[0, 0, -1, 2]):
        errors.append(f"Pure red corner lost red dominance: {cube[0, 0, -1]}")
    if not (cube[0, -1, 0, 1] > cube[0, -1, 0, 0] and cube[0, -1, 0, 1] > cube[0, -1, 0, 2]):
        errors.append(f"Pure green corner lost green dominance: {cube[0, -1, 0]}")
    if not (cube[-1, 0, 0, 2] > cube[-1, 0, 0, 0] and cube[-1, 0, 0, 2] > cube[-1, 0, 0, 1]):
        errors.append(f"Pure blue corner lost blue dominance: {cube[-1, 0, 0]}")
    if not np.allclose(cube[-1, -1, -1], [1.0, 1.0, 1.0], atol=1e-6):
        errors.append(f"White corner expected [1,1,1], got {cube[-1, -1, -1]}")
    if float(cube[0, 0, 0] @ LUMA_WEIGHTS) >= 0.08:
        errors.append(f"Black toe too bright (milky fog): {cube[0, 0, 0]}")

    # 5. Shadow petrol-teal shift at dark neutral grey 0.15: B > G > R
    grey_15 = np.array([0.15, 0.15, 0.15], dtype=np.float64)
    exact_15 = apply_tokyo_night_grade(grey_15)
    cube_15 = trilinear_sample_cube(cube, grey_15)
    png_15 = trilinear_sample_cube(png_bgr, grey_15)

    for label, val in [("exact", exact_15), (".cube", cube_15), ("PNG", png_15)]:
        r_v, g_v, b_v = val
        if not (b_v > g_v > r_v):
            errors.append(
                f"Shadow petrol-teal check failed for {label} at grey 0.15: "
                f"RGB=({r_v:.4f}, {g_v:.4f}, {b_v:.4f}) does not satisfy B > G > R"
            )

    # Highlight warm split check at bright neutral grey 0.80: R > G > B
    grey_80 = np.array([0.80, 0.80, 0.80], dtype=np.float64)
    cube_80 = trilinear_sample_cube(cube, grey_80)
    if not (cube_80[0] > cube_80[1] > cube_80[2]):
        errors.append(
            f"Highlight warm split check failed at grey 0.80: "
            f"RGB=({cube_80[0]:.4f}, {cube_80[1]:.4f}, {cube_80[2]:.4f}) does not satisfy R > G > B"
        )

    # Cross-format consistency (.cube vs 16^3 PNG trilinear at grey 0.15 and 0.80)
    if float(np.max(np.abs(cube_15 - png_15))) > 0.01:
        errors.append(f".cube vs PNG mismatch at 0.15: {cube_15} vs {png_15}")

    if errors:
        print("FAILED Tokyo Night LUT verification:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    cube_kb = cube_path.stat().st_size / 1024.0
    png_kb = png_path.stat().st_size / 1024.0
    print("PASS Tokyo Night LUT verification")
    print(f"  .cube : {cube_path} ({cube_kb:.1f} KiB, 33x33x33, max_err={max_cube_err:.2e})")
    print(f"  PNG   : {png_path} ({png_kb:.1f} KiB, 256x16 RGB8, max_lsb_err={max_png_lsb_err:.0f})")
    print(
        f"  Grey 0.15 petrol-teal : exact=({exact_15[0]:.4f}, {exact_15[1]:.4f}, {exact_15[2]:.4f}) "
        f"| cube=({cube_15[0]:.4f}, {cube_15[1]:.4f}, {cube_15[2]:.4f}) "
        f"| png=({png_15[0]:.4f}, {png_15[1]:.4f}, {png_15[2]:.4f}) [B > G > R]"
    )
    print(
        f"  Grey 0.80 warm split  : cube=({cube_80[0]:.4f}, {cube_80[1]:.4f}, {cube_80[2]:.4f}) [R > G > B]"
    )
    print(
        f"  Neutral ramp luma     : black={luma_33[0]:.4f} -> mid={luma_33[16]:.4f} -> white={luma_33[-1]:.4f} (monotonic)"
    )


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Generate OpenGrid Tokyo Night 3D LUTs for UE 5.8.")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=repo_root / "data" / "ue5",
        help="Output directory (default: data/ue5)",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run self-tests after generating LUT files",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Verify existing LUT files without regenerating",
    )
    args = parser.parse_args()

    cube_path = args.out_dir / "TokyoNight_33.cube"
    png_path = args.out_dir / "TokyoNight_UE5_256x16.png"

    if not args.verify_only:
        write_cube_lut(cube_path)
        write_ue5_strip_png(png_path)
        print(f"Wrote {cube_path}")
        print(f"Wrote {png_path}")

    if args.verify or args.verify_only:
        verify_outputs(cube_path, png_path)


if __name__ == "__main__":
    main()
