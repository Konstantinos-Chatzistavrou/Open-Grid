# Tyre data sources and licence audit

Scope: the `.tir` property files in `data/tires/`. Every file is stored **verbatim** (header included) and is
covered by `data/tires/LICENSE-projectchrono.txt`.

Repo licensing context: code is Apache-2.0; models, data and docs are **CC BY-NC 4.0** (`README.md`, licence
section). BSD-3-Clause data can be redistributed inside that collection provided the BSD copyright notice and
licence text are retained — which they are. No GPL, no unclear-licence material is included.

## Accepted (all Project Chrono, BSD-3-Clause)

Pinned upstream commit: `e166f3e5a1383741e86cf1e195a46eba4a66473d` (2026-11-23). Base URL:
`https://github.com/projectchrono/chrono/tree/<commit>/data/vehicle/`.

| local file | upstream path | bytes | sha256 (16) | size / class | FITTYP | TYRESIDE |
|---|---|---|---:|---|---|---|
| `citybus_pac2002.tir` | `citybus/tire/CityBus_Pac02Tire.tir` | 18,647 | `5731415e818c` | 315/80 R22.5, heavy bus (FNOMIN 35 kN) | PAC2002 | LEFT |
| `polaris_pac2002.tir` | `Polaris/Polaris_Pac02Tire.tir` | 15,509 | `09125852e6ab` | 29x9-14 61M, UTV (FNOMIN 4 kN) | PAC2002 | LEFT |
| `uazbus_pac2002.tir` | `uaz/tire/UAZBUS_Pac02Tire.tir` | 15,668 | `cca76d9ed407` | 225/75 R16, light van (FNOMIN 4 kN) | PAC2002 | LEFT |
| `feda_335_65R22_5_60psi_pac2002.tir` | `feda/tires/335_65R22_5_G275MSA_60psi.tir` | 15,859 | `67419d36be47` | 335/65 R22.5 @ 60 psi, heavy radial | MF_05 (FITTYP 5) | UNKNOWN |
| `pac2002_235_60R16.tir` | `hmmwv/pactest.tir` | 16,949 | `9d0b75bd109e` | 235/60 R16, passenger/C-segment (FNOMIN 4.85 kN, Kv 210 kN/m) | PAC2002 | LEFT |

The first four were already staged in the worktree by a parallel agent and were re-verified byte-for-byte against
the upstream URLs above (sha256 prefixes match). `pac2002_235_60R16.tir` was added by this task. All five are
verbatim: **no hand edits, no unit conversion, no coefficient fitting**.

Why these five: they add genuinely distinct load/size classes (heavy bus, UTV, van, a second passenger size) and
complete the FEDA inflation series (40/60/70/95 psi) used for the pressure-sensitivity checks. Two further Chrono
`.tir` files were reviewed and deliberately not duplicated:
`hmmwv/tire/HMMWV_pacejka.tir` is the same 235/60 R16 fit as `hmmwv/pactest.tir` (different line endings only), and
the other eleven in the tree are already present in `data/tires/`.

## Rejected sources and why

| source | reason |
|---|---|
| FSAE TTC, Calspan, TIRF tyre databases | membership / confidentiality terms; not redistributable |
| SAE papers with tabulated MF coefficients | paywalled, copyrighted text and tables |
| CarMaker, Adams, MSC, OptimumG example tyre data | proprietary EULA; not open data |
| GPL-licensed sims (MBDyn-MFtire GPL-3.0, TORCS/Speed Dreams data) | GPL is incompatible with this repo's CC BY-NC 4.0 data licensing and distribution model |
| VDSim `configs/parts/tire/*.yaml` (Apache-2.0) | licence is fine but these are car-level parameter sets, not measured tyre property files; converting would fabricate coefficients. VDSim is still used as the numerical cross-check in `docs/tyre_library_crosscheck.csv` |
| GitHub repos without a licence (e.g. quantumllama/tire-modeling, ccleb152/PacejkaModelv2, KeeganGriff/PacejkaTireModel, UmutUsenmez, eachen1010, tsoska) | no explicit licence = all rights reserved |
| NHTSA / DoT public-domain reports | no full PAC2002/PAC89 coefficient tables found in this pass; these remain candidates for *validation* data, not tyres |
| OpenSim/SimTK models | no PAC `.tir` property files found |

## Verification

- Parser/test: `core/tests/test_tire_library.cpp` now sweeps **every** `.tir` in `data/tires/` (14 files at the
  time of writing), loads each, and checks finite `Fx/Fy/Mz` over a 3-load × 5-slip × 5-slip-angle grid, in addition
  to the existing deeper physical checks on the core datasets (unchanged, not weakened).
- `cmake --build core/build -j`: success.
- `ctest --test-dir core/build -R tire --output-on-failure`: **4/4 passed** (`tire`, `tire_symmetry`,
  `tire_patch`, `tire_library`).
- Full suite: **81/81 passed** in 22.7 s.
- Catalogue rows and per-file provenance: `data/tires/CATALOG.md`.
