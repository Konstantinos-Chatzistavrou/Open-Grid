#!/usr/bin/env python3
"""
Apache-2.0 — Cross-check OpenGrid's Pacejka Magic Formula evaluator against VDSim (PAC2002 / MF 5.2).

Runs OpenGrid's `mf_dump` (linked against `rs_core`, using raw `tools/tir2car.mjs` output with no
car-level mu boost) and compares it against VDSim's `MagicFormulaTire` (`core/src/magic_formula_tire.cpp`)
when `--vdsim-dir` is supplied, or a clean standalone Apache-2.0 Pacejka PAC2002 evaluator fallback
when VDSim is not locally cloned.

Evaluates 6 load/camber cases: Fz in {2000, 4000, 6000} N x camber in {0, -2} deg across:
  - Pure longitudinal slip: kappa in [-0.30, +0.30], step 0.005 (alpha = 0) -> Fx
  - Pure lateral slip:      alpha in [-20.0, +20.0] deg, step 0.5 deg (kappa = 0) -> Fy, Mz

Produces BOTH:
  1. `symmetrized` comparison (VDSim with the 16 left-tyre ply-steer/conicity/mirror-asymmetric
     offsets zeroed to match `tools/tir2car.mjs`), isolating true formula/sign differences.
  2. `raw` comparison (VDSim with unmodified left-tyre `.tir` offsets active), showing the full
     delta including intentional single-fit left/right symmetry zeroing.

Usage:
  python3 tools/tyre/crosscheck_vdsim.py \\
      --tir data/tires/audi_245_40R18_pac2002.tir \\
      --vdsim-dir /tmp/vdsim_ref \\
      --out docs/tyre_crosscheck_vdsim.csv
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]

# Coefficients intentionally zeroed by `tools/tir2car.mjs` so one tyre fit is mirror-symmetric
# across left and right wheels on a car (left-tyre ply-steer, conicity, and alpha/gamma asymmetries).
SYMMETRY_ZERO_KEYS = (
    "PHX1", "PHX2", "PVX1", "PVX2",
    "PHY1", "PHY2", "PVY1", "PVY2", "PEY3",
    "QBZ4", "QDZ3", "QEZ4", "QHZ1", "QHZ2", "QDZ6", "QDZ7", "SSZ1",
)

LOADS_N = (2000.0, 4000.0, 6000.0)
CAMBERS_DEG = (0.0, -2.0)

# Temporary C++ harness compiled ONLY against a user-supplied `--vdsim-dir` checkout (never vendored).
VDSIM_HARNESS_CPP = r"""
#include "vdsim/interfaces.hpp"
#include "vdsim/magic_formula.hpp"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

// Minimal stubs for non-MF factories referenced by create_tire_from_params() in magic_formula_tire.cpp.
namespace vdsim {
std::unique_ptr<ITireModel> create_linear_tire() { return nullptr; }
std::unique_ptr<ITireModel> create_pacejka_mf96() { return nullptr; }
}  // namespace vdsim

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "usage: vdsim_eval <tir_path> <raw|symmetrized> [vx_mps]\n";
        return 2;
    }
    const std::string tir_path = argv[1];
    const std::string variant = argv[2];
    const double vx = (argc >= 4) ? std::atof(argv[3]) : 16.6;

    vdsim::MFCoeffs coeffs = vdsim::parse_tir(tir_path);
    if (variant == "symmetrized") {
        const char* zero_keys[] = {
            "PHX1", "PHX2", "PVX1", "PVX2",
            "PHY1", "PHY2", "PVY1", "PVY2", "PEY3",
            "QBZ4", "QDZ3", "QEZ4", "QHZ1", "QHZ2", "QDZ6", "QDZ7", "SSZ1"
        };
        for (const char* k : zero_keys) coeffs.p[k] = 0.0;
    }

    auto tire = vdsim::create_magic_formula_tire(coeffs);
    constexpr double kLoads[] = {2000.0, 4000.0, 6000.0};
    constexpr double kCambersDeg[] = {0.0, -2.0};
    constexpr double kDegToRad = 3.14159265358979323846 / 180.0;

    std::printf("sweep,fz_n,camber_deg,kappa,alpha_deg,fx_n,fy_n,mz_nm\n");
    for (double fz : kLoads) {
        for (double camber_deg : kCambersDeg) {
            // OpenGrid -> ISO-W sign mapping: alpha_iso = -alpha_og, gamma_iso = -gamma_og.
            // Output forces/moments (Fx, Fy, Mz) share X-forward, Y-left, Z-up axes.
            const double gamma_iso = -camber_deg * kDegToRad;

            for (int i = -60; i <= 60; ++i) {
                const double kappa = i * 0.005;
                vdsim::ITireModel::Input in;
                in.Fz = fz;
                in.kappa = kappa;
                in.alpha = 0.0;
                in.gamma = gamma_iso;
                in.mu_long = 1.0;
                in.mu_lat = 1.0;
                in.Vx_wheel = vx;
                const auto out = tire->compute(in);
                std::printf("pure_long,%.1f,%.2f,%.6f,0.0000,%.8f,%.8f,%.8f\n",
                            fz, camber_deg, kappa, out.Fx, out.Fy, out.Mz);
            }

            for (int i = -40; i <= 40; ++i) {
                const double alpha_og_deg = i * 0.5;
                vdsim::ITireModel::Input in;
                in.Fz = fz;
                in.kappa = 0.0;
                in.alpha = -alpha_og_deg * kDegToRad;
                in.gamma = gamma_iso;
                in.mu_long = 1.0;
                in.mu_lat = 1.0;
                in.Vx_wheel = vx;
                const auto out = tire->compute(in);
                std::printf("pure_lat,%.1f,%.2f,0.000000,%.4f,%.8f,%.8f,%.8f\n",
                            fz, camber_deg, alpha_og_deg, out.Fx, out.Fy, out.Mz);
            }
        }
    }
    return 0;
}
"""


def parse_tir_file(path: Path) -> Dict[str, float]:
    """Parse numeric key = value pairs from a Pacejka .tir property file."""
    coeffs: Dict[str, float] = {}
    num_re = re.compile(r"^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$")
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = re.split(r"[$!]", raw_line, maxsplit=1)[0].strip()
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip().upper()
        val = val.strip().strip("'\"")
        if key and num_re.match(val):
            coeffs[key] = float(val)
    return coeffs


def _sgn(x: float) -> float:
    return 1.0 if x > 0.0 else (-1.0 if x < 0.0 else 0.0)


def eval_pac2002_standalone(
    coeffs: Dict[str, float],
    fz: float,
    kappa: float,
    alpha_iso: float,
    gamma_iso: float,
) -> Tuple[float, float, float]:
    """
    Standalone Apache-2.0 Pacejka PAC2002 / MF 5.2 pure-slip + aligning-moment evaluator
    (Pacejka, 'Tire and Vehicle Dynamics', 2nd/3rd ed., Ch. 4.3.2, ISO-W sign convention).
    Used only as fallback when a local VDSim checkout is not supplied via --vdsim-dir.
    """
    if fz < 1.0:
        return 0.0, 0.0, 0.0
    g = lambda k, d=0.0: coeffs.get(k, d)
    eps = 1e-6

    fz0 = g("FNOMIN", 4000.0)
    r0 = g("UNLOADED_RADIUS", 0.3)
    fz0p = max(1.0, g("LFZO", 1.0) * fz0)
    dfz = (fz - fz0p) / fz0p
    g2 = gamma_iso * gamma_iso

    lmux = g("LMUX", 1.0)
    lmuy = g("LMUY", 1.0)

    # Pure longitudinal Fx0
    shx = (g("PHX1") + g("PHX2") * dfz) * g("LHX", 1.0)
    kx = kappa + shx
    cx = g("PCX1", 1.65) * g("LCX", 1.0)
    mux = (g("PDX1", 1.0) + g("PDX2") * dfz) * (1.0 - g("PDX3") * g2) * lmux
    dx = mux * fz
    ex = min(
        1.0,
        (g("PEX1") + g("PEX2") * dfz + g("PEX3") * dfz * dfz)
        * (1.0 - g("PEX4") * _sgn(kx))
        * g("LEX", 1.0),
    )
    kxk = fz * (g("PKX1", 20.0) + g("PKX2") * dfz) * math.exp(g("PKX3") * dfz) * g("LKX", 1.0)
    bx = kxk / (cx * dx + eps)
    svx = fz * (g("PVX1") + g("PVX2") * dfz) * g("LVX", 1.0) * lmux
    fx0 = dx * math.sin(cx * math.atan(bx * kx - ex * (bx * kx - math.atan(bx * kx)))) + svx

    # Pure lateral Fy0
    shy = (g("PHY1") + g("PHY2") * dfz) * g("LHY", 1.0) + g("PHY3") * gamma_iso * g("LGAY", 1.0)
    ay = alpha_iso + shy
    cy = g("PCY1", 1.3) * g("LCY", 1.0)
    muy = (g("PDY1", 1.0) + g("PDY2") * dfz) * (1.0 - g("PDY3") * g2) * lmuy
    dy = muy * fz
    ey = min(
        1.0,
        (g("PEY1") + g("PEY2") * dfz)
        * (1.0 - (g("PEY3") + g("PEY4") * gamma_iso) * _sgn(ay))
        * g("LEY", 1.0),
    )
    kya = (
        g("PKY1", -15.0)
        * fz0p
        * math.sin(2.0 * math.atan(fz / (g("PKY2", 2.0) * fz0p)))
        * (1.0 - g("PKY3") * abs(gamma_iso))
        * g("LKY", 1.0)
    )
    by = kya / (cy * dy + eps)
    svy = (
        fz
        * (
            (g("PVY1") + g("PVY2") * dfz) * g("LVY", 1.0)
            + (g("PVY3") + g("PVY4") * dfz) * gamma_iso * g("LGAY", 1.0)
        )
        * lmuy
    )
    fy0 = dy * math.sin(cy * math.atan(by * ay - ey * (by * ay - math.atan(by * ay)))) + svy

    # Aligning moment Mz (pure-slip; combined weighting = 1 when kappa == 0 or alpha == 0)
    kr = (kxk / kya) if abs(kya) > eps else 0.0
    sht = g("QHZ1") + g("QHZ2") * dfz + (g("QHZ3") + g("QHZ4") * dfz) * gamma_iso
    at = alpha_iso + sht
    at_eq = _sgn(at) * math.hypot(at, kr * kappa)
    shf = shy + (svy / kya if abs(kya) > eps else 0.0)
    ar = alpha_iso + shf
    ar_eq = _sgn(ar) * math.hypot(ar, kr * kappa)

    bt = (
        (g("QBZ1", 10.0) + g("QBZ2") * dfz + g("QBZ3") * dfz * dfz)
        * (1.0 + g("QBZ4") * gamma_iso + g("QBZ5") * abs(gamma_iso))
        * g("LKY", 1.0)
        / max(eps, g("LMUY", 1.0))
    )
    ct = g("QCZ1", 1.1)
    dt = (
        fz
        * (g("QDZ1", 0.1) + g("QDZ2") * dfz)
        * (1.0 + g("QDZ3") * gamma_iso + g("QDZ4") * g2)
        * (r0 / fz0p)
        * g("LTR", 1.0)
    )
    et = min(
        1.0,
        (g("QEZ1") + g("QEZ2") * dfz + g("QEZ3") * dfz * dfz)
        * (1.0 + (g("QEZ4") + g("QEZ5") * gamma_iso) * (2.0 / math.pi) * math.atan(bt * ct * at)),
    )
    bt_at = bt * at_eq
    trail = dt * math.cos(ct * math.atan(bt_at - et * (bt_at - math.atan(bt_at)))) * math.cos(alpha_iso)

    br = g("QBZ9") * g("LKY", 1.0) / max(eps, g("LMUY", 1.0)) + g("QBZ10") * by * cy
    dr = (
        fz
        * ((g("QDZ6") + g("QDZ7") * dfz) * g("LRES", 1.0) + (g("QDZ8") + g("QDZ9") * dfz) * gamma_iso)
        * r0
        * lmuy
    )
    mzr = dr * math.cos(math.atan(br * ar_eq)) * math.cos(alpha_iso)
    s = r0 * (g("SSZ1") + g("SSZ2") * (fy0 / fz0p) + (g("SSZ3") + g("SSZ4") * dfz) * gamma_iso) * g("LS", 1.0)
    mz = -trail * fy0 + mzr + s * fx0
    return fx0, fy0, mz


def run_standalone_sweep(tir_path: Path, variant: str) -> List[Dict[str, float]]:
    coeffs = parse_tir_file(tir_path)
    if variant == "symmetrized":
        for k in SYMMETRY_ZERO_KEYS:
            coeffs[k] = 0.0
    rows: List[Dict[str, float]] = []
    deg2rad = math.pi / 180.0
    for fz in LOADS_N:
        for camber_deg in CAMBERS_DEG:
            gamma_iso = -camber_deg * deg2rad
            for i in range(-60, 61):
                kappa = i * 0.005
                fx, fy, mz = eval_pac2002_standalone(coeffs, fz, kappa, 0.0, gamma_iso)
                rows.append({
                    "sweep": "pure_long", "fz_n": fz, "camber_deg": camber_deg,
                    "kappa": kappa, "alpha_deg": 0.0, "fx_n": fx, "fy_n": fy, "mz_nm": mz,
                })
            for i in range(-40, 41):
                alpha_og_deg = i * 0.5
                fx, fy, mz = eval_pac2002_standalone(coeffs, fz, 0.0, -alpha_og_deg * deg2rad, gamma_iso)
                rows.append({
                    "sweep": "pure_lat", "fz_n": fz, "camber_deg": camber_deg,
                    "kappa": 0.0, "alpha_deg": alpha_og_deg, "fx_n": fx, "fy_n": fy, "mz_nm": mz,
                })
    return rows


def parse_csv_rows(text: str) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    reader = csv.DictReader(text.splitlines())
    for row in reader:
        parsed: Dict[str, object] = {}
        for k, v in row.items():
            parsed[k] = v if k == "sweep" else float(v)
        out.append(parsed)
    return out


def run_opengrid(
    tir_path: Path,
    mf_dump_bin: Optional[Path],
    mode: str,
    tmpdir: Path,
) -> List[Dict[str, object]]:
    coeffs = parse_tir_file(tir_path)
    radius_m = coeffs.get("UNLOADED_RADIUS", 0.344)
    vx_mps = coeffs.get("LONGVL", 16.6)

    if mf_dump_bin is None:
        mf_dump_bin = tmpdir / "mf_dump"
        rs_core_a = REPO_ROOT / "core" / "build" / "librs_core.a"
        if not rs_core_a.is_file():
            raise RuntimeError(f"missing {rs_core_a}; build rs_core first or pass --mf-dump")
        cmd = [
            "g++", "-std=c++17", "-O2",
            f"-I{REPO_ROOT / 'core' / 'include'}",
            f"-I{REPO_ROOT / 'core' / 'third_party'}",
            str(REPO_ROOT / "core" / "tools" / "mf_dump.cpp"),
            str(rs_core_a),
            "-o", str(mf_dump_bin),
            "-lm",
        ]
        subprocess.run(cmd, check=True)

    tir_json = subprocess.run(
        ["node", str(REPO_ROOT / "tools" / "tir2car.mjs"), str(tir_path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    res = subprocess.run(
        [
            str(mf_dump_bin),
            "--tire-json", "-",
            "--radius", f"{radius_m:.8f}",
            "--vx", f"{vx_mps:.8f}",
            "--mode", mode,
        ],
        input=tir_json,
        check=True,
        capture_output=True,
        text=True,
    )
    return parse_csv_rows(res.stdout)


# Minimal Eigen3 header stubs used ONLY in a temp directory when system eigen3 is not installed,
# since VDSim's magic_formula_tire.cpp uses only scalar doubles and includes Eigen transitively via types.hpp.
EIGEN_CORE_STUB = r"""
#pragma once
#include <cmath>
namespace Eigen {
struct Vector2d {
    double v[2]{0.0, 0.0};
    Vector2d() = default;
    Vector2d(double a, double b) : v{a, b} {}
    double x() const { return v[0]; }
    double y() const { return v[1]; }
    double norm() const { return std::hypot(v[0], v[1]); }
    static Vector2d Zero() { return {0.0, 0.0}; }
};
struct Vector3d {
    double v[3]{0.0, 0.0, 0.0};
    Vector3d() = default;
    Vector3d(double a, double b, double c) : v{a, b, c} {}
    double x() const { return v[0]; }
    double y() const { return v[1]; }
    double z() const { return v[2]; }
    template <int N> Vector2d head() const { return {v[0], v[1]}; }
    static Vector3d Zero() { return {0.0, 0.0, 0.0}; }
    static Vector3d UnitZ() { return {0.0, 0.0, 1.0}; }
};
struct Vector4d { double v[4]{0.0, 0.0, 0.0, 0.0}; };
struct Matrix3d { double m[9]{}; };
struct Matrix4d { double m[16]{}; };
}  // namespace Eigen
"""

EIGEN_GEOMETRY_STUB = r"""
#pragma once
namespace Eigen {
struct Quaterniond {
    double w_{1.0}, x_{0.0}, y_{0.0}, z_{0.0};
    static Quaterniond Identity() { return {}; }
};
}  // namespace Eigen
"""


def run_vdsim_live(
    vdsim_dir: Path,
    tir_path: Path,
    tmpdir: Path,
) -> Tuple[str, str, List[Dict[str, object]], List[Dict[str, object]]]:
    mf_cpp = vdsim_dir / "core" / "src" / "magic_formula_tire.cpp"
    inc_dir = vdsim_dir / "core" / "include"
    if not mf_cpp.is_file() or not (inc_dir / "vdsim" / "magic_formula.hpp").is_file():
        raise RuntimeError(f"--vdsim-dir '{vdsim_dir}' does not contain VDSim core/src/magic_formula_tire.cpp")

    commit = "unknown"
    git_res = subprocess.run(
        ["git", "-C", str(vdsim_dir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
    )
    if git_res.returncode == 0:
        commit = git_res.stdout.strip()

    harness_cpp = tmpdir / "vdsim_eval.cpp"
    harness_bin = tmpdir / "vdsim_eval"
    harness_cpp.write_text(VDSIM_HARNESS_CPP, encoding="utf-8")

    eigen_flags: List[str] = []
    if Path("/usr/include/eigen3/Eigen/Core").is_file():
        eigen_flags.append("-I/usr/include/eigen3")
    else:
        stub_dir = tmpdir / "eigen_stub"
        (stub_dir / "Eigen").mkdir(parents=True, exist_ok=True)
        (stub_dir / "Eigen" / "Core").write_text(EIGEN_CORE_STUB, encoding="utf-8")
        (stub_dir / "Eigen" / "Geometry").write_text(EIGEN_GEOMETRY_STUB, encoding="utf-8")
        eigen_flags.append(f"-I{stub_dir}")

    subprocess.run(
        [
            "g++", "-std=c++17", "-O2",
            f"-I{inc_dir}",
            *eigen_flags,
            str(harness_cpp),
            str(mf_cpp),
            "-o", str(harness_bin),
            "-lm",
        ],
        check=True,
    )

    vx_mps = parse_tir_file(tir_path).get("LONGVL", 16.6)
    raw_out = subprocess.run(
        [str(harness_bin), str(tir_path), "raw", f"{vx_mps:.8f}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    sym_out = subprocess.run(
        [str(harness_bin), str(tir_path), "symmetrized", f"{vx_mps:.8f}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout

    return (
        "VDSim live C++ (core/src/magic_formula_tire.cpp)",
        commit,
        parse_csv_rows(raw_out),
        parse_csv_rows(sym_out),
    )


def compute_metrics(
    og_rows: List[Dict[str, object]],
    ref_rows: List[Dict[str, object]],
    comparison: str,
    evaluator: str,
    vdsim_commit: str,
    tir_label: str,
) -> List[Dict[str, object]]:
    # Index rows by (sweep, fz_n, camber_deg)
    def group(rows: List[Dict[str, object]]) -> Dict[Tuple[str, float, float], List[Dict[str, object]]]:
        g: Dict[Tuple[str, float, float], List[Dict[str, object]]] = {}
        for r in rows:
            key = (str(r["sweep"]), float(r["fz_n"]), float(r["camber_deg"]))
            g.setdefault(key, []).append(r)
        return g

    og_g = group(og_rows)
    ref_g = group(ref_rows)

    channel_specs = (
        ("pure_long", "Fx", "fx_n", "fx_pure_n", "kappa", 1.0, "N", "N/slip"),
        ("pure_lat",  "Fy", "fy_n", "fy_pure_n", "alpha_deg", math.pi / 180.0, "N", "N/rad"),
        ("pure_lat",  "Mz", "mz_nm", "mz_pure_nm", "alpha_deg", math.pi / 180.0, "N*m", "N*m/rad"),
    )

    summary: List[Dict[str, object]] = []
    for sweep, chan, col, pure_col, slip_col, slip_to_si, unit, stiff_unit in channel_specs:
        for fz in LOADS_N:
            for camber_deg in CAMBERS_DEG:
                key = (sweep, fz, camber_deg)
                og_pts = sorted(og_g[key], key=lambda r: float(r[slip_col]))
                ref_pts = sorted(ref_g[key], key=lambda r: float(r[slip_col]))
                assert len(og_pts) == len(ref_pts) and len(og_pts) > 2

                og_vals = [float(r[col]) for r in og_pts]
                ref_vals = [float(r[col]) for r in ref_pts]
                slips = [float(r[slip_col]) for r in og_pts]

                og_peak = max(abs(v) for v in og_vals)
                ref_peak = max(abs(v) for v in ref_vals)
                peak_diff_pct = 100.0 * (og_peak - ref_peak) / ref_peak if ref_peak > 1e-12 else 0.0

                # Central-difference slope at slip = 0
                zero_idx = min(range(len(slips)), key=lambda idx: abs(slips[idx]))
                d_slip_si = (slips[zero_idx + 1] - slips[zero_idx - 1]) * slip_to_si
                og_stiff = (og_vals[zero_idx + 1] - og_vals[zero_idx - 1]) / d_slip_si
                ref_stiff = (ref_vals[zero_idx + 1] - ref_vals[zero_idx - 1]) / d_slip_si
                stiff_diff_pct = (
                    100.0 * (og_stiff - ref_stiff) / abs(ref_stiff) if abs(ref_stiff) > 1e-12 else 0.0
                )

                diffs = [a - b for a, b in zip(og_vals, ref_vals)]
                rmse = math.sqrt(sum(d * d for d in diffs) / len(diffs))
                rmse_pct_peak = 100.0 * rmse / ref_peak if ref_peak > 1e-12 else 0.0

                max_idx = max(range(len(diffs)), key=lambda idx: abs(diffs[idx]))
                max_abs_err = abs(diffs[max_idx])
                max_abs_err_pct = 100.0 * max_abs_err / ref_peak if ref_peak > 1e-12 else 0.0
                max_err_slip = slips[max_idx]

                # Check pure-formula parity inside OpenGrid (magic_formula vs mf_pure_*)
                max_og_internal = max(abs(float(r[col]) - float(r[pure_col])) for r in og_pts)

                summary.append({
                    "comparison": comparison,
                    "channel": chan,
                    "sweep": sweep,
                    "fz_n": fz,
                    "camber_deg": camber_deg,
                    "unit": unit,
                    "stiff_unit": stiff_unit,
                    "og_peak": og_peak,
                    "ref_peak": ref_peak,
                    "peak_diff_pct": peak_diff_pct,
                    "og_stiff_0": og_stiff,
                    "ref_stiff_0": ref_stiff,
                    "stiff_diff_pct": stiff_diff_pct,
                    "rmse": rmse,
                    "rmse_pct_peak": rmse_pct_peak,
                    "max_abs_err": max_abs_err,
                    "max_abs_err_pct_peak": max_abs_err_pct,
                    "max_err_at_slip": max_err_slip,
                    "og_grid_vs_pure_max_diff": max_og_internal,
                    "evaluator": evaluator,
                    "vdsim_commit": vdsim_commit,
                    "tir_file": tir_label,
                })
    return summary


def format_markdown(rows: List[Dict[str, object]], comparison: str) -> str:
    subset = [r for r in rows if r["comparison"] == comparison]
    lines = [
        f"### {comparison.capitalize()} comparison (`OpenGrid` vs `{subset[0]['evaluator']}`)",
        "",
        "| Channel | Fz (N) | Camber (°) | OG Peak | Ref Peak | Peak Δ% | OG Slope@0 | Ref Slope@0 | Slope Δ% | RMSE | RMSE %Peak | Max Abs Err | Max Err @ Slip |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for r in subset:
        u = str(r["unit"])
        su = str(r["stiff_unit"])
        slip_u = "°" if r["sweep"] == "pure_lat" else ""
        lines.append(
            f"| {r['channel']} ({u}) | {r['fz_n']:.0f} | {r['camber_deg']:+.1f} | "
            f"{r['og_peak']:.2f} | {r['ref_peak']:.2f} | {r['peak_diff_pct']:+.3f}% | "
            f"{r['og_stiff_0']:.1f} | {r['ref_stiff_0']:.1f} | {r['stiff_diff_pct']:+.3f}% | "
            f"{r['rmse']:.3f} | {r['rmse_pct_peak']:.3f}% | "
            f"{r['max_abs_err']:.3f} | {r['max_err_at_slip']:+.3f}{slip_u} |"
        )
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Cross-check OpenGrid Magic Formula vs VDSim on a PAC2002 .tir file.")
    ap.add_argument(
        "--tir",
        type=Path,
        default=REPO_ROOT / "data" / "tires" / "audi_245_40R18_pac2002.tir",
        help="Path to PAC2002 .tir file",
    )
    ap.add_argument(
        "--vdsim-dir",
        type=Path,
        default=None,
        help="Optional path to local VDSim checkout (runs live VDSim C++ magic_formula_tire.cpp)",
    )
    ap.add_argument(
        "--mf-dump",
        type=Path,
        default=None,
        help="Optional prebuilt mf_dump binary (auto-built against core/build/librs_core.a if omitted)",
    )
    ap.add_argument(
        "--mode",
        choices=("nominal", "stribeck", "hybrid"),
        default="nominal",
        help="OpenGrid evaluation mode passed to mf_dump (default: nominal)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=REPO_ROOT / "docs" / "tyre_crosscheck_vdsim.csv",
        help="Output CSV path",
    )
    args = ap.parse_args()

    tir_path = args.tir.resolve()
    if not tir_path.is_file():
        print(f"ERROR: .tir file not found: {tir_path}", file=sys.stderr)
        return 2
    try:
        tir_label = str(tir_path.relative_to(REPO_ROOT))
    except ValueError:
        tir_label = tir_path.name

    with tempfile.TemporaryDirectory(prefix="og_vdsim_xcheck_") as td:
        tmpdir = Path(td)
        og_rows = run_opengrid(tir_path, args.mf_dump, args.mode, tmpdir)

        if args.vdsim_dir is not None and args.vdsim_dir.exists():
            evaluator, vdsim_commit, ref_raw, ref_sym = run_vdsim_live(args.vdsim_dir.resolve(), tir_path, tmpdir)
        else:
            evaluator = "Standalone Apache-2.0 PAC2002 reference fallback (VDSim not cloned)"
            vdsim_commit = "fallback-standalone"
            ref_raw = run_standalone_sweep(tir_path, "raw")
            ref_sym = run_standalone_sweep(tir_path, "symmetrized")

    all_summary = (
        compute_metrics(og_rows, ref_sym, "symmetrized", evaluator, vdsim_commit, tir_label)
        + compute_metrics(og_rows, ref_raw, "raw", evaluator, vdsim_commit, tir_label)
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(all_summary[0].keys())
    with args.out.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in all_summary:
            writer.writerow(row)

    print(f"# Tyre Magic Formula Cross-Check (`{tir_label}`)")
    print(f"- **OpenGrid mode**: `{args.mode}` (`rs::magic_formula` via `core/tools/mf_dump.cpp` + `tools/tir2car.mjs`)")
    print(f"- **Reference evaluator**: `{evaluator}`")
    print(f"- **VDSim commit**: `{vdsim_commit}`")
    print(f"- **CSV written**: `{args.out}`")
    print()
    print(format_markdown(all_summary, "symmetrized"))
    print()
    print(format_markdown(all_summary, "raw"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
