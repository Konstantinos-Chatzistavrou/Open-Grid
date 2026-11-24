# Measured engine torque reference

`data/physics/torque-reference.json` holds **measured** full-load torque curves under a
redistributable licence, stored verbatim: no smoothing, no extrapolation, no synthesised points.
`tools/physics/torque_reference.mjs --check` validates the file (structure, monotonic rpm, finite
values, and reported brake power against `P = T·ω`).

## Accepted source

| curve | engine | licence | where |
|---|---|---|---|
| `toyota-7a-fe-1.8-full-load` | Toyota 7A-FE, 1.8 L inline-4 petrol, naturally aspirated | **CC BY 4.0** | Dolor & Temabor, *Design, Fabrication, and Performance Evaluation of a Locally Developed Automotive Engine Test Bed Using a Hydraulic Water-Brake Dynamometer*, Int. J. Mechanical and Civil Engineering, 2026-11-01. DOI `10.5281/zenodo.23856320`, <https://zenodo.org/records/23856320> |

Licence evidence: the Zenodo record metadata declares `"license": {"id": "cc-by-4.0"}`; the article is
published under CC BY 4.0. Attribution: the table is reproduced with attribution to the authors; the
values were not altered.

### The data (Table 4, "Measured torque, calculated brake power and exhaust temperature at full load")

| rpm | torque (N·m) | reported power (kW) |
|---:|---:|---:|
| 1000 | 80.5 | 8.4 |
| 1500 | 99.5 | 15.6 |
| 2000 | 114.0 | 23.9 |
| 2500 | 126.5 | 33.1 |
| 3000 | 135.5 | 42.6 |
| 3500 | 132.5 | 48.6 |
| 4000 | 127.5 | 53.4 |
| 4500 | 118.5 | 55.9 |
| 5000 | 107.0 | 56.0 |
| 5500 | 90.0 | 51.8 |

Conditions: full load (wide-open throttle), engine warm with coolant at 82–88 °C, hydraulic
water-brake dynamometer, torque from a load cell on a 0.5 m arm, speed and thermal conditions
stabilised before each reading.

### Caveats (in the JSON as well)

- **One curve, one engine.** It is a measured reference for a 1.8 L NA petrol four, not a universal
  map and not a measurement of any Open Grid car.
- The article reports **10.3 % below** the workshop-manual peak for this engine (135.5 vs 151 N·m),
  which it attributes to the locally built dynamometer and engine condition. Treat it as a realistic
  *shape* and order of magnitude, not the factory rating.
- The reported power column is the article's own calculation; the checker verifies it agrees with
  `T·ω` within 3 %, which it does (rounding only).

## Rejected sources (and why)

- **SAE / Elsevier / Springer tables** — paywalled and copyrighted.
- **FSAE TTC / Calspan / TIRF** — membership-only, redistribution forbidden.
- **OEM service manuals and brochures** — proprietary charts; peak facts only, no tabulated curves.
- **Commercial simulator maps** (CarMaker, Adams, Simulink examples) — EULA.
- **Unlicensed GitHub dyno dumps** — no licence = all rights reserved.
- **Papers with curves only as plots** (e.g. the DOE/NREL small-engine reports reviewed) — digitising
  is an approximation; not stored as measured. The one paper examined in detail (US DOE/EERE
  30535aa) is public domain but its curves are tiny scooter/range-extender engines and figure-only.
- **Other CC BY engine papers found** (biodiesel single-cylinder, kerosene blends): their torque data
  is plotted, not tabulated, so they were not used.

## Gaps

- Only **one** measured, tabulated, redistributable curve was found. A second independent automotive
  engine (ideally a diesel with a torque plateau) would improve coverage; none was found under a
  compatible licence in this pass.
- No measured BSFC/fuel-consumption map, torque-converter data or thermal-derating data was found
  under a compatible licence.
- The Chrono simplified maps in `data/powertrain/reference-powertrains.json` remain the only complete
  multi-engine set; they are low-confidence references, not measurements.

## Reproduce

```bash
# inspect the record metadata and licence
curl -s https://zenodo.org/api/records/23856320 | jq '.metadata.license, .metadata.doi'

# validate the stored file
node tools/physics/torque_reference.mjs --check
```
