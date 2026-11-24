# CG height and yaw inertia: measured reference data (2026-11-24)

## Why this page exists

Three car configs had placeholder CG height / inertia values. Rather than invent numbers, we imported a
**public-domain measured dataset** as a reference table and used it to check that our gameplay values are
physically plausible. The game's fictional cars are **not** claimed to match these measurements.

## Source

- **Federal Register, Vol. 62, No. 145 (29 July 1997), Notices, pp. 40611-40612, Tables 3 and 4.**
- Publisher: U.S. Government Printing Office / NHTSA. Work of the U.S. Government: **public domain** (17 USC 105).
- PDF used (scanned FR issue): <https://archive.org/download/sim_federal-register-find_1997-07-29_62_145/sim_federal-register-find_1997-07-29_62_145.pdf>
  (Table 3 on PDF page 195; values transcribed from the rendered page and cross-checked against `pdftotext`).
- Measurements by NHTSA/VRTC, Cornell University (CU) and CarT for the 1994/1996 Isuzu Trooper and the
  1996 Acura SLX (a rebadged Trooper).

Stored as `data/physics/inertia-reference.json` (12 configurations, SI conversions included).

## Units and conversions

| quantity | printed unit | SI conversion |
|---|---|---|
| weight | lb | x 0.45359237 -> kg |
| roll/yaw inertia | `ft.lb.s^2` (= slug*ft^2) | x **1.35581795** -> kg*m^2 |
| CG height | in | x 0.0254 -> m |
| SSF | - | track / (2 * CG height) |

## What the data says (SI)

| vehicle / config | mass kg | CG m | roll kg m^2 | yaw kg m^2 | yaw/mass m^2 | SSF |
|---|---:|---:|---:|---:|---:|---:|
| 1996 Acura SLX, 1 occupant | 2026 | 0.699 | 862 | 3890 | 1.92 | 1.09 |
| 1996 Acura SLX, 4 occ + cargo | 2497 | 0.709 | 996 | 4643 | 1.86 | 1.07 |
| 1996 Isuzu Trooper (CU) | 2018 | 0.699 | 887 | 3989 | 1.98 | 1.09 |
| 1994 Isuzu Trooper, 1 occupant | 2025 | 0.686 | 837 | 3956 | 1.95 | 1.07 |
| 1994 Trooper, 4 occ + cargo | 2501 | 0.704 | 975 | 4535 | 1.81 | 1.04 |

Full table incl. outrigger/instrumentation configurations: the JSON. SSF is carried as printed and is a
cross-check on the CG height, not an input.

## Uncertainty and assumptions

- CG height is printed to **0.1 in (2.5 mm)**; the underlying measurement uncertainty is not stated in the
  Federal Register excerpt. Treat ~ ±1 % as plausible but unconfirmed.
- Inertia is printed to 4 significant figures; **no uncertainty is published here**. The measurement system
  (VRTC inertia measurement facility) is the source of the widely cited SAE 1999-01-1336 dataset, but that
  paper is copyrighted and was **not** used.
- SSF is printed to 2 decimals; the report notes track widths differed between vehicles, so equal CG heights
  can still produce different SSF.
- Two CarT rows have **no inertia columns**; they are stored with `null` and excluded from inertia checks.

## How our cars compare (plausibility, not equality)

`node tools/physics/inertia_reference.mjs` checks every car against physical bounds and reports:

- our cars: 1.1-1.7 t, CG **0.41-0.53 m**, yaw **2.0-2.5 k kg*m^2**, yaw/mass **1.39-2.09 m^2**;
- reference SUVs: 2.0-2.5 t, CG **0.69-0.71 m**, yaw **3.9-4.7 k kg*m^2**, yaw/mass **1.81-1.98 m^2**.

All cars pass the bounds (CG 0.35-0.85 m; yaw 1.2-6 k; yaw/mass 0.8-3.2 m^2; yaw > roll). A sports car with a
lower CG and lighter body than a body-on-frame SUV should sit at the low end of those ranges, which it does.
No gameplay value was changed by this work.

SSF sanity: our cars' track / (2 * CG) gives ~1.6-1.9, well above the SUV 1.04-1.12 - the expected direction
for a low sports car, and a useful order-of-magnitude check on the CG heights.

## Gaps (documented, not filled)

- **No public-domain or permissively licensed measured inertia for modern sports cars / coupes** was found.
  SAE papers, OEM data and commercial sim databases are copyrighted or EULA-bound.
- Roll/pitch inertias for our cars therefore remain gameplay values, bounded but not measured.
- If a licensed source appears (e.g. an OEM releasing measured data under CC BY), the table can be extended
  without touching the game configs.

## Reproduce

```bash
node tools/physics/inertia_reference.mjs          # print reference + car comparison
node tools/physics/inertia_reference.mjs --check  # exit 1 on any implausible value
node tools/validate_mod.mjs --dir data/cars
```
