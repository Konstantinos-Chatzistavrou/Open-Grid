# General physics reference data (2026-11-24)

Two new reference sets, both with a mechanical checker. New files only:

- `data/physics/brakes-reference.json` — FMVSS 135 braking requirements (public domain) and derived bounds.
- `data/validation/tracks-extra/` — Spa, Silverstone and Suzuka centre lines (LGPL-3.0, flagged below).
- `tools/physics/brake_reference.mjs` — `--check` (braking) and `--tracks DIR` (geometry) modes.

## 1. Braking — FMVSS 135 (public domain)

Source: **FMVSS No. 135, Light Vehicle Brake Systems**, 49 CFR 571.135, published in the eCFR
(<https://www.ecfr.gov/current/title-49/subtitle-B/chapter-V/part-571/subpart-B/section-571.135>).
US Government work — **public domain** (17 USC §105). Clauses used:

- S6.5.3.3 normal (cold): `S <= 0.10*V + 0.0060*V^2`
- S7.14.4 hot: `S <= 0.10*V + 0.0067*V^2`
- S7.8 ABS failure: `0.10*V + 0.0060*V^2`; S7.10 hydraulic failure: `0.10*V + 0.0100*V^2`

(S metres, V km/h.) At 100 km/h the cold maximum is **70 m** (hot 77 m), i.e. a mean deceleration of at least
**0.55 g**. The JSON stores the per-speed table and the formula so the checker can verify the table against the
source formula.

The checker compares each car's **friction-limited** stop at 100 km/h (both axles at the tyre mu in its config,
weighted by `weight_front`) against the legal maximum. This is a *best case*: it ignores load transfer, brake
torque limits, ABS and the ~0.2–0.3 s build-up.

Results (25 cars): stops **25.2–32.2 m** at 100 km/h (1.22–1.56 g), margins **2.17×–2.78×** under the 70 m legal
maximum. All pass; none is close to the regulatory floor. The check reports only — it never edits car data.

Assumptions: lateral mu is used if no longitudinal mu is present; the friction circle is not split; the 0.1 s
pedal delay is excluded.

## 2. Extra track geometry — TUM racetrack-database (LGPL-3.0, flagged)

Source: **TUMFTM/racetrack-database**, commit `e59595d1f3573b30d1ded6a08984935b957688e0`
(<https://github.com/TUMFTM/racetrack-database>). GitHub API reports
`license.spdx_id = LGPL-3.0`; the full licence text is stored in the folder as `LICENSE`.

**Licence flag:** this is **third-party copyleft data**, not Open Grid's CC BY-NC 4.0 and not Apache-2.0. It is
kept as separate, unmodified data files with notice and source; it is validation-only and not linked into the
engine. If the project wants a copyleft-free tree, delete the folder and fetch it at test time instead.

Files are stored unmodified (`x_m,y_m,w_tr_right_m,w_tr_left_m`). Measured centre-line vs published length:

| track | points | centre line | published | error | min radius | width |
|---|---:|---:|---:|---:|---:|---:|
| Spa | 1401 | 7000 m | 7004 m | 0.06 % | 8.0 m | 7.9–16.4 m |
| Silverstone | 1178 | 5887 m | 5891 m | 0.07 % | 12.3 m | 11.3–17.8 m |
| Suzuka | 1161 | 5803 m | 5807 m | 0.07 % | 17.9 m | 7.8–15.3 m |

Checks: plausible length, length within 3 % of published, minimum radius > 5 m, width 4–40 m. The 3 % bound is an
assumption (published lengths are racing-line based) and is not tuned: observed errors are ≤ 0.07 %.

## Verification (exact)

```
$ node tools/physics/brake_reference.mjs
FMVSS 135 braking reference (public domain): ...
  PASS  table matches formula at 50 km/h: 65.00 m
  ...
  PASS  every car stops within the FMVSS 135 cold requirement at its tyre grip

PASSED: 0 checks failed

$ node tools/physics/brake_reference.mjs --tracks data/validation/tracks-extra
Silverstone    1178 pts  length 5887 m (published 5891, 0.07%)  ...
PASSED: 0 checks failed
```

Repo validators remain green: `validate_mod` 25 assets / 0 rejections, `check_licences` OK.

## Rejected sources

- **Measured per-vehicle braking data**: Consumer Reports (copyrighted), Euro NCAP/ADAC tables (copyrighted
  compilations), SAE papers (paywalled). NHTSA's NCAP star programme does not publish braking distances; only the
  FMVSS 135 regulatory envelope is clean public-domain material. No measured fleet table was fabricated.
- **Tracks**: `f1tenth_gym` (MIT) contains no track CSV data; `f1tenth_simulator` has no declared licence (rejected);
  TUM database is the only large, cleanly licensed source (LGPL — used with the flag above); OSM-derived raceways
  would be ODbL and need extraction work not done in this pass.
- **Suspension/tyre datasets**: TTC/Calspan (restricted), MDPI/Elsevier (paywalled), GPL sims (incompatible).

## Gaps (documented, not filled)

- No public-domain **measured** stopping distances per vehicle; the check uses the legal envelope plus tyre grip.
- The car files' tyre mu values are gameplay calibration, not measured data, so the braking check bounds
  plausibility, not real-world accuracy.
- Track CSVs are centre-line geometry only: no elevation, camber, kerbs or surface data.
