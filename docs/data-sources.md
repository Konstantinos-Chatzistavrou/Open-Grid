# Car data sources (legal + measured), 2026-11-24

This page records every value imported into `data/cars/*.json` from an external source, with its URL,
licence and confidence. It exists so no number in a car config is anonymous.

## What was added

Measured **aerodynamic drag area** (`aero.drag_area_m2`) for three cars, from the US EPA
coast-down dataset. The EPA measures road load on a test track and publishes
`F(v) = A + B*v + C*v^2` (v in mph, F in lbf); the quadratic C term is aerodynamic, so

```
CdA = 2 * C_SI / rho        C_SI = C converted to N/(m/s)^2, rho = 1.225 kg/m^3
```

EPA publishes several rows per test id (configuration variants); the importer averages C per test id
so one donor contributes one coefficient. The value is a **class proxy** - a measured car of the same
class, not a measurement of the fictional car - and that is stated in each car's `notes`.

| car file | field | before | after | donor (EPA test) | C (lbf/mph^2) | source | licence | confidence |
|---|---|---|---|---|---|---|---|---|
| `data/cars/kaze_kurogane.json` | `aero.drag_area_m2` | 0.66 | **0.611** | 2015 SUBARU BRZ, test DBF-MP52 | 0.01681 | US EPA Test Car List Data | **public domain** (17 USC 105) | medium (class proxy) |
| `data/cars/hayate.json` | `aero.drag_area_m2` | 0.66 | **0.635** | 2015 SUBARU WRX, test FBF-TF74 | 0.01748 | US EPA Test Car List Data | **public domain** (17 USC 105) | medium (class proxy) |
| `data/cars/vela_gt.json` | `aero.drag_area_m2` | 0.66 | **0.643** | 2015 CHEVROLET CAMARO, test 628DEN2313 | 0.01771 | US EPA Test Car List Data | **public domain** (17 USC 105) | medium (class proxy) |

Source URL: https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy
(CSVs `15tstcar.csv` / `16tstcar.csv`), imported once into `data/validation/epa_coastdown.json` by
`tools/physics/import_epa_coastdown.mjs` (see `LICENSE-epa.txt` there).

Reproduce:

```bash
node tools/physics/import_epa_aero.mjs            # print donor rows and derived CdA
node tools/physics/import_epa_aero.mjs --apply    # write drag_area_m2 + notes provenance
```

**Nothing else was changed**: `downforce_area_m2`, `front_balance`, `ground_effect_per_m` and every
powertrain value are untouched, because there is no public measured data that supports changing them.

## Sources verified and usable (for the next fields)

| source | licence | what it gives | status |
|---|---|---|---|
| US EPA coast-down coefficients (MY2015-16, 2,816 vehicles) | public domain (17 USC 105) | measured road-load A/B/C -> CdA and rolling-resistance trend; test weight | **used** above |
| Project Chrono vehicle definitions (Audi A4, G500, HMMWV, ...) - chassis mass/inertia/CG, suspension hardpoints, engine full-load map, transmission, brakes, tyres | **BSD-3-Clause** (commit pinned) | reference car data for validation and future reference cars | verified; already partly copied to `data/reference/chrono/` |
| NHTSA NCAP rollover (Static Stability Factor) | public domain (US Gov) | SSF = track / (2 * CG height) -> **CG height** for real vehicles | usable, not yet imported |
| NACA 4-digit sections / NACA reports | public domain (US Gov) | airfoil geometry, lift slope for wing aero parts | already in `data/physics/airfoils.json` |
| Zenodo CC BY 4.0 measurement sets (tyre on ice, four-post rig) | CC BY 4.0 (attribution) | low-mu tyre validation, ride validation | fetched by `tools/physics/fetch-data.mjs` |

## Gaps: fields we deliberately did not fill

| field | why it is empty / unchanged |
|---|---|
| `engine.torque_curve` for these three cars | no public-domain full-load curve for those engines. Facts like peak power are not a curve; interpolating a curve from two points would be fabrication. Chrono's **BSD-3** engine maps are a legal source for reference cars only. |
| `aero.downforce_area_m2`, `front_balance` | no measured, openly licensed lift data for road cars. Published race-car aero is proprietary or paywalled. |
| `chassis.cg_height_m`, inertias | manufacturer CG/inertia is not published; NHTSA SSF can derive CG for real cars but not for the fictional ones. |
| gear ratios / final drive | facts, but a spec sheet is not a measurement of this fictional car; no change made. |
| tyre thermal/wear parameters | no open measured dataset with a compatible model. |

## Sources rejected and why

- **SAE papers, Elsevier/Springer journal tables** (tyre models, race-car aero): paywalled, redistribution not licensed.
- **FSAE Tire Test Consortium** data: membership-only, redistribution forbidden.
- **Manufacturer brochures / press kits** for torque curves: prose and charts are copyrighted; only individual facts may be cited, not copied curves.
- **OptimumG / Racecar Engineering / commercial sim data** (Assetto Corsa, iRacing, rFactor): proprietary or EULA-restricted.
- **Wikimedia/random GitHub tyre CSVs with no licence**: unclear provenance, rejected even when numerically plausible.

## Licence hygiene

- EPA data is public domain; no attribution is legally required, but the source is credited anyway.
- Any future CC BY import must be credited in `CREDITS.md` and keep the source URL next to the value.
- Every imported value must have a row in this table with its confidence. Measurements > published model parameters > derived from public physics; estimates are labelled as estimates.
