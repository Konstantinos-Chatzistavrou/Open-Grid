# Physics data sources that are legal to use

Goal: make the racing physics the most defensible in the project by grounding it in **published, licensed** data,
never in copied proprietary tables. This page tracks what is imported, what is available, and what must be avoided.

## Imported (verified licence + verified values)

| data | source | licence | where |
|---|---|---|---|
| 9 PAC2002 tyre sets (HMMWV, FEDA 40/70/95 psi, sedan, SUV, Audi 245/40R18, classic 185, generic) | Project Chrono `data/vehicle/*/tire`, commit `e166f3e` | **BSD-3-Clause** | `data/tires/*.tir` + `LICENSE-projectchrono.txt` |
| Audi + G500 vehicle reference (mass, inertia, wheelbase, wheels, engine torque curve, brakes) | Project Chrono `data/vehicle/audi/json`, `data/vehicle/gclass` | **BSD-3-Clause** | `data/reference/chrono/*.json` |
| EPA coast-down / road-load, 2,816 vehicles MY2015–16 | US EPA *Test Car List Data* | **public domain** (17 U.S.C. §105) | `data/validation/epa_coastdown.json` + `LICENSE-epa.txt`; importer `tools/physics/import_epa_coastdown.mjs`; test `packages/vehicle-physics/test/epa-coastdown.test.mjs` |
| Road network + track geometry (Manhattan, and the 1:1 city ports) | OpenStreetMap | **ODbL-1.0** (attribution + share-alike on derived DB) | `data/…` map pipeline; credit in-game |

The Audi tyre in `data/tires/` is byte-identical to Chrono's `audi_Pac02Tire.tir` (sha256 prefix `ef4c08a3`),
so there is no silent re-authoring.

Dataset-by-dataset import log (what was downloaded, fields kept, and the tests that read them):
[`docs/physics-data.md`](physics-data.md). This page is the licence/sources playbook; that page is the record.

## Verified licence patterns — usable, not yet imported

These are safe to import **with attribution**, but each import needs the exact file fetched and recorded:

- **US federal datasets** (NHTSA crash/NCAP results, FHWA/LTPP pavement data, NASA/NACA reports): US Government
  works are not subject to copyright in the US (17 U.S.C. §105). Attribute the agency and report number.
  Use for: braking-distance validation, inertia reference ranges, pavement friction vs wetness.
- **UK Open Government Licence v3** (DfT/National Highways skid-resistance guidance, TRL reports published under
  OGL): reusable including commercially, with attribution and a link to the licence.
  Use for: surface friction classes, wet-road mu ranges.
- **CC-BY 4.0 academic datasets** (vehicle dynamics, tyre test datasets published by universities): attribution
  required; check whether the paper's *data* is CC-BY or only the article.

## Must not be imported

- **FSAE TTC / Calspan tyre data** — consortium membership terms, not redistributable.
- **GPL sim content** (TORCS, Speed Dreams, etc.) — incompatible with this repository's licensing.
- **Commercial sims** (Assetto Corsa, rFactor, iRacing, BeamNG) — proprietary data and EULAs.
- **OEM calibration files / Bosch handbooks / SAE & ISO standard text** — copyright; standards are paywalled.
  A standard's *geometry* (e.g. ISO 3888-2 cone spacing) may be described in our own words and cited, but not
  reproduced as a table from the standard.
- **Scraped telemetry** (F1 team data, leaked setups) — no licence, provenance unverifiable.

## Validation plan (numbers, not vibes)

1. **Inertia sanity** — `tools/validate_physics_reference.mjs` enforces positive inertia and the triangle
   inequality for every imported vehicle, plus consistent wheelbase/axle spacing and monotonic engine RPM.
2. **Kinematic cornering envelope** — for the Audi reference: `R_kin = L / tan(delta_max) = 2.776 / tan(25 deg)
   = 5.96 m`; the upstream file publishes a 7.6 m minimum turning radius. Our core must land between them; a value
   outside means a steering or tyre-slip bug, not a tuning preference.
3. **Braking** — compare 100–0 km/h distance against public NCAP figures for a similar mass class once an NCAP
   dataset is imported; record the exact report and test conditions (surface, temperature, tyres).
4. **Tyre model** — every `.tir` is loaded verbatim and evaluated by the Magic Formula path; adding a new tyre is a
   data-only change, no code edit.

## Adding a dataset (checklist)

- [ ] Licence permits redistribution **and** modification in this repo's licence terms.
- [ ] Original file fetched and hashed; provenance (URL, commit/report id, date) recorded next to it.
- [ ] Units and axes documented (ISO 8855 for vehicle frames).
- [ ] `node tools/validate_physics_reference.mjs` passes.
- [ ] Credit added to `CREDITS.md`.
