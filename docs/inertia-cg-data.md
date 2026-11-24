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

## Modern reference: 2020 NCAP Static Stability Factor measurements (2026-11-24)

The 1997 Federal Register set covers only 1990s SUVs, so modern cars were added from a second legal source:

- **Rollover Stability Measurements for 2020 New Car Assessment Program (NCAP) — Static Stability Factor
  (SSF) Measurements**, NHTSA docket **NHTSA-2001-9663-0497**, prepared for NHTSA by SEA, Ltd. Vehicle
  Dynamics Division. **US Government work submitted to a federal docket → public domain** (caveat: confirm
  contractor copyright status before any commercial redistribution).
  Original: <https://downloads.regulations.gov/NHTSA-2001-9663-0497/attachment_1.pdf> (403 to scripts; use the
  archived copy: <http://web.archive.org/web/20230802123148if_/https://downloads.regulations.gov/NHTSA-2001-9663-0497/attachment_1.pdf>).
- The report contains 53 measured vehicles (2019–2021): **test weight, average track width, CG height and SSF**
  from SEA's Vehicle Inertia Measurement Facility. It does **not** publish moments of inertia.

| vehicle (2020, driver only) | mass kg | CG m | track m | SSF (track/2h) |
|---|---:|---:|---:|---:|
| Subaru WRX (AWD) | 1610 | 0.529 | 1.53 | 1.45 |
| Kia Stinger (AWD) | 1967 | 0.524 | 1.61 | 1.53 |
| Cadillac CT5 (AWD) | 1849 | 0.544 | 1.62 | 1.48 |
| Volvo S60 (FWD) | 1774 | 0.545 | 1.59 | 1.46 |
| Mazda 3 (FWD) | 1464 | 0.541 | 1.57 | 1.45 |
| Hyundai Sonata (FWD) | 1498 | 0.557 | 1.64 | 1.47 |
| Nissan Sentra (FWD) | 1481 | 0.536 | 1.57 | 1.46 |
| Mazda CX-30 (AWD) | 1562 | 0.607 | 1.56 | 1.29 |
| Volvo XC90 (FWD) | 2093 | 0.701 | 1.67 | 1.19 |

All values are **measured**; SSF is carried as printed and the tool re-derives `track/(2·CG)` as a consistency
check (max deviation 0.01, inside rounding). No derived rows were needed.

**Sports-car class result.** The sportiest entries here are the WRX, Stinger and CT5 (sport sedans), at
**CG 0.52–0.54 m**. Our fictional cars sit at **0.41–0.53 m**, i.e. at or below that reference, which is the right
direction for low sports cars; the checker flags any car above the modern measured maximum + 2 cm.
**No modern two-door sports coupe (Camaro/Mustang/Supra/86) appears in this NCAP set**, and no public-domain
measured yaw inertia was found for modern cars, so those remain documented gaps rather than fabricated numbers.

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
