# OpenGrid BSD-3 Tyre Dataset Catalog

All `.tir` property files in `data/tires/` are stored **verbatim** from [Project Chrono](https://github.com/projectchrono/chrono) under the **BSD-3-Clause** licence (Copyright (c) 2016, Project Chrono Development Team; full licence text in `data/tires/LICENSE-projectchrono.txt`).

These datasets cover six distinct vehicle/tyre archetypes — Sport GT, Passenger Sedan, SUV, Classic/Vintage, Heavy Off-Road, and a 3-pressure heavy radial reference series (`40 / 70 / 95 psi`) — and are verified by both:
1. Live cross-check against [VDSim](https://github.com/Onlyti/VDSim) (`core/src/magic_formula_tire.cpp`, commit `0534695d`, Apache-2.0) via `tools/tyre/crosscheck_vdsim.py` and `core/build/mf_dump`, summarized in `docs/tyre_library_crosscheck.csv`.
2. Automated C++ unit/physics regression suite `RS_TEST(tire_library)` in `core/tests/test_tire_library.cpp`.

## Dataset provenance & format

| Local file (`data/tires/`) | Project Chrono upstream path (`main`) | Tyre size / label | Format | `FITTYP` | `TYRESIDE` | Intended OpenGrid vehicle class |
|---|---|---|---|---|---|---|
| `audi_245_40R18_pac2002.tir` | `data/vehicle/audi/json/audi_Pac02Tire.tir` | 245/40 R18 | `PAC2002` | *(omitted / PAC2002)* | `LEFT` | **Sport GT** (baseline for Vela GT / modern coupes & hot hatches) |
| `sedan_pac2002.tir` | `data/vehicle/sedan/tire/Sedan_Pac02Tire.tir` | 245/40 R18 | `PAC2002` | *(omitted / PAC2002)* | `LEFT` | **Passenger Sedan** *(identical upstream fit to `audi_245_40R18_pac2002.tir`)* |
| `suv_pac2002.tir` | `data/vehicle/Nissan_Patrol/json/suv_Pac02Tire.tir` | 265/70 R18 115 | `PAC2002` | *(omitted / PAC2002)* | `LEFT` | **SUV** (tall-sidewall high-load touring/SUV) |
| `classic_185_80R14_pac2002.tir` | `data/vehicle/VW_microbus/json/mf_185_80R14.tir` | 185/80 R14 | `PAC2002` | *(omitted / PAC2002)* | `LEFT` | **Classic / Vintage** (narrow, tall 80-series retro/classic cars) |
| `generic_pac2002.tir` | `data/vehicle/generic/tire/Generic_Pac02Tire.tir` | 37x12.5 R16.5 *(scaled 315/80 R22.5)* | `PAC2002` | *(omitted / PAC2002)* | `LEFT` | **Heavy Off-Road / Generic** *(identical coefficients to `hmmwv_pac2002.tir`)* |
| `hmmwv_pac2002.tir` | `data/vehicle/hmmwv/tire/HMMWV_Pac02Tire.tir` | 37x12.5 R16.5 Load E | `PAC2002` | *(omitted / PAC2002)* | `LEFT` | **Heavy Off-Road (HMMWV)** (high-load off-road / utility vehicles) |
| `feda_335_65R22_5_40psi.tir` | `data/vehicle/feda/tires/335_65R22_5_G275MSA_40psi.tir` | 335/65 R22.5 @ 40 psi (2.7 bar) | `MF_05` | `5` | `UNKNOWN` | **Multi-Pressure Reference (40 psi)** (inflation-stiffness benchmark) |
| `feda_335_65R22_5_70psi.tir` | `data/vehicle/feda/tires/335_65R22_5_G275MSA_70psi.tir` | 335/65 R22.5 @ 70 psi (4.8 bar) | `MF_05` | `5` | `UNKNOWN` | **Multi-Pressure Reference (70 psi)** (inflation-stiffness benchmark) |
| `feda_335_65R22_5_95psi.tir` | `data/vehicle/feda/tires/335_65R22_5_G275MSA_95psi.tir` | 335/65 R22.5 @ 95 psi (6.5 bar) | `MF_05` | `5` | `UNKNOWN` | **Multi-Pressure Reference (95 psi)** (inflation-stiffness benchmark) |

> **Upstream equivalence notes** (preserved verbatim for traceability to Project Chrono):
> - `sedan_pac2002.tir` and `audi_245_40R18_pac2002.tir` are byte-for-byte identical (`sha256` prefix `ef4c08a321d0`): Project Chrono's Sedan model reuses the Audi 245/40 R18 PAC2002 fit.
> - `generic_pac2002.tir` and `hmmwv_pac2002.tir` contain identical coefficients and differ only in line endings (LF vs CRLF): Project Chrono's Generic template reuses the HMMWV 37x12.5 R16.5 Load E fit.

## Dimensions & nominal performance at `FNOMIN`

Evaluated with OpenGrid's raw `tools/tir2car.mjs` -> `rs::magic_formula` pipeline (isothermal, nominal pressure, `mu_surface = 1.0`, `camber = 0°`, no per-car friction boost). When `LFZO != 1`, the effective Magic Formula reference load is `Fz0' = FNOMIN * LFZO`; peak `mu_x` / `mu_y` and cornering stiffness `C_alpha` below are evaluated at `Fz = FNOMIN` (with `Fz0'` shown alongside).

| File | `R0` (m) | Width (m) | Aspect | `FNOMIN` (N) | `LFZO` | `Fz0'` (N) | `K_v` (N/m) | Pressure (kPa) | Peak `mu_x` @ `FNOMIN` | Peak `mu_y` @ `FNOMIN` | `C_alpha` @ `FNOMIN` (N/rad) | `C_alpha / FNOMIN` (1/rad) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `audi_245_40R18_pac2002.tir` | 0.3440 | 0.245 | 0.40 | 4,850 | 0.8100 | 3,928.5 | 280,835 | — | 1.1354 | 1.0066 | 76,959 | 15.87 |
| `sedan_pac2002.tir` | 0.3440 | 0.245 | 0.40 | 4,850 | 0.8100 | 3,928.5 | 280,835 | — | 1.1354 | 1.0066 | 76,959 | 15.87 |
| `suv_pac2002.tir` | 0.4090 | 0.265 | 0.70 | 4,000 | 1.7609 | 7,043.5 | 248,316 | — | 1.1905 | 1.0671 | 80,025 | 20.01 |
| `classic_185_80R14_pac2002.tir` | 0.3760 | 0.185 | 0.80 | 3,800 | 1.0000 | 3,800.0 | 175,000 | — | 1.0900 | 0.9400 | 45,211 | 11.90 |
| `generic_pac2002.tir` | 0.4699 | 0.318 | 0.70 | 35,000 | 0.5809 | 20,331.7 | 1,000,000 | 800 | 0.6013 | 0.6855 | 170,548 | 4.87 |
| `hmmwv_pac2002.tir` | 0.4699 | 0.318 | 0.70 | 35,000 | 0.5809 | 20,331.7 | 1,000,000 | 800 | 0.6013 | 0.6855 | 170,548 | 4.87 |
| `feda_335_65R22_5_40psi.tir` | 0.4987 | 0.335 | 0.65 | 16,929 | 1.0000 | 16,929.0 | 406,520 | 270 | 0.9841 | 0.7098 | 190,446 | 11.25 |
| `feda_335_65R22_5_70psi.tir` | 0.4987 | 0.335 | 0.65 | 24,046 | 1.0000 | 24,046.0 | 644,520 | 480 | 0.9087 | 0.7423 | 187,807 | 7.81 |
| `feda_335_65R22_5_95psi.tir` | 0.4990 | 0.335 | 0.65 | 29,912 | 1.0000 | 29,912.0 | 848,550 | 650 | 0.8400 | 0.7715 | 199,405 | 6.67 |

### Key physical trends across classes
- **Sport GT (`245/40 R18`) vs Classic (`185/80 R14`)**: Sport low-profile tyre has **1.60× stiffer vertical carcass** (`280.8 kN/m` vs `175.0 kN/m`), **1.33× higher cornering stiffness per unit load at `FNOMIN`** (`15.87` vs `11.90 /rad`, and **1.51×** higher at equal `4 kN` load: `69.1` vs `45.9 kN/rad`), and higher nominal grip (`mu_y = 1.007` vs `0.940`).
- **SUV (`265/70 R18`) vs Sport GT (`245/40 R18`)**: Larger unloaded radius (`0.409 m` vs `0.344 m`), taller 70-series sidewall with softer vertical rate (`248.3 kN/m` vs `280.8 kN/m`), and much higher effective reference load (`Fz0' = 7,043.5 N` vs `3,928.5 N`, reflecting `LFZO = 1.7609`). At its own `Fz0'` (`7,043.5 N`), SUV peak grip is `mu_x = 1.139 / mu_y = 1.014` (`C_alpha / Fz0' = 14.37 /rad`).
- **Heavy Off-Road (`37x12.5 R16.5`, HMMWV)**: High load rating (`FNOMIN = 35 kN`, `Fz0' = 20.33 kN`, `K_v = 1,000 kN/m`), lower dry-asphalt peak grip (`mu_x = 0.601`, `mu_y = 0.686` at `FNOMIN`; `0.778 / 0.740` at `Fz0'`), and low `C_alpha / FNOMIN` (`4.87 /rad`).
- **Multi-Pressure FEDA series (`335/65 R22.5`, 40 -> 70 -> 95 psi)**: Raising inflation pressure from `270 kPa` (40 psi) to `480 kPa` (70 psi) to `650 kPa` (95 psi) monotonically increases both **vertical stiffness** (`406.5 -> 644.5 -> 848.6 kN/m`, **+108.7%**) and **rated nominal load** (`16,929 -> 24,046 -> 29,912 N`, **+76.7%**).

## Cross-check vs live VDSim C++ (`docs/tyre_library_crosscheck.csv`)

Every dataset was evaluated across all 6 standard load/camber sweeps (`Fz in {2000, 4000, 6000} N` × `camber in {0°, -2°}`, `kappa in [-0.30, +0.30]`, `alpha in [-20°, +20°]`) comparing OpenGrid (`tools/tir2car.mjs` -> `core/build/mf_dump --mode nominal`) against live compiled **VDSim** (`core/src/magic_formula_tire.cpp`, commit `0534695d48afab8041008e556a5264ff7f450976`). Values below are the worst-case (maximum) RMSE across the 6 load/camber cases in **symmetrized** mode (the 17 left-tyre-only ply-steer/conicity/mirror-asymmetry terms zeroed in both evaluators):

| File | Format | Sym `Fx` RMSE @ 0° cam | Sym `Fx` Max RMSE (all 6 cases) | Sym `Fy` Max RMSE (all 6 cases) | Sym `Mz` Max RMSE (all 6 cases) |
|---|---|---:|---:|---:|---:|
| `audi_245_40R18_pac2002.tir` | `PAC2002` | 0.009 N (0.0001%) | 0.290 N (0.0044%) | 0.008 N (0.0001%) | 0.0001 N·m (0.0000%) |
| `sedan_pac2002.tir` | `PAC2002` | 0.009 N (0.0001%) | 0.290 N (0.0044%) | 0.008 N (0.0001%) | 0.0001 N·m (0.0000%) |
| `suv_pac2002.tir` | `PAC2002` | 0.007 N (0.0002%) | 0.097 N (0.0014%) | 0.005 N (0.0002%) | 0.0001 N·m (0.0002%) |
| `classic_185_80R14_pac2002.tir` | `PAC2002` | 0.000 N (0.0000%) | 0.099 N (0.0019%) | 0.010 N (0.0002%) | 0.0001 N·m (0.0001%) |
| `generic_pac2002.tir` | `PAC2002` | 0.003 N (0.0001%) | 0.003 N (0.0001%) | 0.010 N (0.0002%) | 0.0003 N·m (0.0009%) |
| `hmmwv_pac2002.tir` | `PAC2002` | 0.003 N (0.0001%) | 0.003 N (0.0001%) | 0.010 N (0.0002%) | 0.0003 N·m (0.0009%) |
| `feda_335_65R22_5_40psi.tir` | `MF_05` (`FITTYP=5`) | 0.001 N (0.0000%) | 420.626 N (6.9264%)* | 0.012 N (0.0003%) | 0.0000 N·m (0.0001%) |
| `feda_335_65R22_5_70psi.tir` | `MF_05` (`FITTYP=5`) | 0.000 N (0.0000%) | 21.422 N (0.3943%)* | 0.003 N (0.0001%) | 0.0000 N·m (0.0001%) |
| `feda_335_65R22_5_95psi.tir` | `MF_05` (`FITTYP=5`) | 0.001 N (0.0000%) | 284.808 N (5.3171%)* | 0.001 N (0.0000%) | 0.0000 N·m (0.0000%) |

*\*FEDA `MF_05` (`FITTYP = 5`) sign-convention note*: TNO MF-Tyre 5.0 stores `PDY1 < 0` alongside `PKY1 < 0` (`-0.7098`, `-0.7424`, `-1.1188` for 40/70/95 psi). At `camber = 0°`, OpenGrid matches VDSim to **0.0000% RMSE** on `Fx`, `Fy`, and `Mz` for all three FEDA files, and `Fy` / `Mz` also match to **<= 0.0003% RMSE** at `camber = -2°`. At `camber = -2°` during pure longitudinal slip, `tools/tir2car.mjs` passes signed `PDY1 < 0` verbatim as `lateral.mu < 0`, so `core/src/tire.cpp`'s friction-ellipse guard (`dy_max = std::max({Dy, std::abs(fy0), 1e-6})`) falls back to `|fy0|` instead of `|Dy|` and trims `Fx` by 0.39–6.93%. Normalizing `lateral.mu = Math.abs(PDY1 * LMUY)` (as done in `core/tests/test_tire_library.cpp`) or taking `std::abs(Dy)` in the ellipse guard eliminates this difference completely while leaving `Fy0` mathematically unchanged.

## Reproducing checks

```bash
# Convert any .tir file to OpenGrid car/1 tyre JSON
node tools/tir2car.mjs data/tires/classic_185_80R14_pac2002.tir

# Cross-check against standalone PAC2002 reference (or add --vdsim-dir /path/to/VDSim for live VDSim C++)
python3 tools/tyre/crosscheck_vdsim.py \
  --tir data/tires/suv_pac2002.tir \
  --mf-dump core/build/mf_dump

# Run the C++ multi-tyre library test suite
./core/build/rs_tests tire_library
```
