# Validation datasets — licences, sources, tolerances

Only data that we may legally redistribute is stored in `data/validation/`. Everything else is either
fetched at runtime by a tool or rejected with a reason.

## Accepted

| dataset | stored | licence | source | used for |
|---|---|---|---|---|
| **racetrack-database** (Monza, Brands Hatch) | `data/validation/racetrack-database/{Monza,BrandsHatch}.csv` (unmodified, 67 KB) + `LICENSE` (LGPL-3.0) + `SOURCE.md` | **LGPL-3.0** | https://github.com/TUMFTM/racetrack-database | track geometry: closure, width, curvature, length vs published lap distance, friction-circle corner-speed sanity |
| **US EPA Test Car List — coast-down** | `data/validation/epa_coastdown.json` (2,816 vehicles) + `LICENSE-epa.txt` | **public domain** (US Gov, 17 U.S.C. §105) | https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy | SAE J2263 road-load; engine aero slope vs real vehicles (`packages/vehicle-physics/test/epa-coastdown.test.mjs`) |

### LGPL note

The two CSVs are **unmodified** LGPL-3.0 data and remain under that licence (full text in the folder).
They are read-only inputs to a validation tool; our Apache-2.0 code is not derived from them. If you
prefer not to ship LGPL data, delete the folder and run the tool with `--fetch` semantics — it is the
only place these files are used.

## Tool and exact output

`tools/validation/track_sanity.mjs` (Node, no dependencies):

```
Monza: 1159 pts, 5790.2 m centre line vs published 5793 m (0.05%); min radius 16.14 m => corner limit 51.6 km/h at mu=1.3
  PASS  closed-loop gap < 50 m: 5
  PASS  min radius > 5 m: 16.1
  PASS  corner speed < 400 km/h: 51.6
  PASS  width 1-30 m: [7.5,12.4]
  PASS  length within 2% of published: {"length_m":5790.2,"published_m":5793,"error_pct":0.05}

BrandsHatch: 781 pts, 3904.5 m centre line vs published 3916 m (0.29%); min radius 25.66 m => corner limit 65.1 km/h at mu=1.3
  PASS  closed-loop gap < 50 m: 5
  PASS  min radius > 5 m: 25.7
  PASS  corner speed < 400 km/h: 65.1
  PASS  width 1-30 m: [7.5,12.1]
  PASS  length within 2% of published: {"length_m":3904.5,"published_m":3916,"error_pct":0.29}

PASSED: 0 check(s) failed. Report: docs/validation/racetrack-database-report.json
```

Report (JSON) is written to `docs/validation/racetrack-database-report.json` with per-file SHA-256,
the assumptions used, and every check result.

### Tolerances — derived or explicitly assumed

| check | value | basis |
|---|---|---|
| centre-line length vs published lap distance | **2 %** | **assumption**: published circuit lengths are rounded and refer to the racing line/centre line; both tracks land at 0.05 % and 0.29 %, so the bound is generous, not tuned |
| closed-loop gap | 50 m | data must describe one lap; observed 5 m on both |
| min radius | > 5 m | physical sanity of a car circuit |
| width | 1–30 m | physical sanity (observed 7.5–12.4 m) |
| corner speed | < 400 km/h | plausibility bound at `v = sqrt(mu g R)` with **mu = 1.30 assumed** (dry racing peak); this is a sanity bound, **not** a measured validation |

## Rejected sources (and why)

| source | licence found | reason |
|---|---|---|
| **OpenF1** | CC BY-NC-SA 4.0 | non-commercial + share-alike: incompatible with an Apache-2.0, monetisable game; **no data stored** |
| **FastF1 / F1 live timing** | F1/FOM rights; FastF1 states data must not be redistributed | cannot commit telemetry |
| **eVED (extended Vehicle Energy Dataset)** | CC BY-NC-ND 4.0 | non-commercial + no derivatives |
| **VED (original)** | not verified in the time available; redistribution of the full dataset is impractical (~tens of GB) | not committed; candidate for a summary-only licence review |
| **highD** | repo BSD-3-Clause, but it is code; the dataset itself is a separate multi-GB download with its own terms | dataset not committed; would need its data terms verified before any use |
| **TORCS / Speed Dreams car data** | GPL | copyleft data would impose GPL on the repository; rejected |
| **FSAE TTC tyre data** | restricted distribution | cannot be committed |
| **Euro NCAP / ADAC / IIHS test tables** | copyrighted compilations | facts may be cited (as the existing ADAC test does) but not bulk-copied |

## Reproduce

```bash
node tools/validation/track_sanity.mjs
cd packages/vehicle-physics && npm test     # EPA coast-down validation (existing)
```
