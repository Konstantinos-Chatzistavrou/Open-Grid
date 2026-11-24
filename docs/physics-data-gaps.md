# Physics data: what we have, what is missing, and how to close it

Last updated 2026-11-24. Every entry below is either a committed file with a licence or an explicit gap.
The point of this page is that no number in the physics configs is anonymous, and no missing number is
invented.

## Have (committed, licensed, checked in CI)

| domain | where | source / licence | confidence | checker |
|---|---|---|---|---|
| Tyres, 14 sets | `data/tires/*.tir` | Project Chrono, **BSD-3** (verbatim) | high (published MF datasets) | `ctest -R tire` (14-file sweep) |
| Engines + gearboxes, 4 | `data/powertrain/reference-powertrains.json` | Project Chrono JSON, **BSD-3** | **low-medium** (simplified maps) | `tools/physics/check_powertrain.mjs` |
| Final drives, 1,699 configs | `data/powertrain/final-drives.json` | US EPA certification CSVs, **public domain** | high | same |
| One measured engine curve | `data/physics/torque-reference.json` | Toyota 7A-FE, Zenodo, **CC BY 4.0** | measured, but ~10 % below factory rating; single engine | `tools/physics/torque_reference.mjs` |
| Car drag areas, 3 cars | `data/cars/{vela_gt,hayate,kaze_kurogane}.json` | US EPA coast-down, **public domain** | medium (class proxy) | `validate_mod` |
| Aero references (Cd/CL, axle balance) | `data/physics/aero_reference.json` | DrivAerNet++ **CC BY 4.0**; Energies 2022 **CC BY 4.0** (CFD, not measured); NACA 0012 **public domain** | reference only, not per-car truth | `tools/physics/aero_check.mjs` |
| CG / inertia | `data/physics/inertia-reference.json` | NHTSA/VRTC Federal Register 1997 + 2020 NCAP SSF report, **public domain** | CG measured; inertia only for 1994/96 SUVs | `tools/physics/inertia_reference.mjs` |
| Braking envelope | `data/physics/brakes-reference.json` | 49 CFR 571.135 (FMVSS 135), **public domain** | legal limit, not per-vehicle stops | `tools/physics/brake_reference.mjs` |
| Track geometry, 5 tracks | `data/validation/racetrack-database/`, `tracks-extra/` | TUMFTM, **LGPL-3.0** (third-party, flagged) | high (0.05-0.29 % length error) | `tools/validation/track_sanity.mjs` |
| Airfoils | `data/physics/airfoils.json` | NACA Report 824, **public domain** | geometry exact; `cd0Estimate` is an estimate | `tools/physics/naca.mjs` |

## Missing, and exactly how to close it

| gap | why it is still open | fastest legal route |
|---|---|---|
| **More measured engine torque curves** (only one engine) | No permissively licensed measured dyno tables found beyond the Zenodo paper; SAE/Elsevier, TTC/Calspan, OEM charts and commercial sim maps are excluded. | Commission or run a dyno session and publish the data ourselves; or wait for more CC BY open-data depositions. |
| **Measured production-car downforce and front/rear balance** | The one measured dataset found (IST FST14 on-track, 46.20 % front) is **embargoed until 2027-05-01**; SAE papers paywalled; theses reserve all rights. Our CFD band is a *reference*, not a measurement. | Re-check the IST record after 2027-05-01; otherwise fund a wind-tunnel/on-track test we own. |
| **Modern sports-car yaw inertia** | The standard source (SAE 1999-01-1336) is copyrighted; the public NHTSA reports publish CG and SSF but **not moments of inertia**. | Buy the SAE dataset; or measure with a torsion/compound-pendulum rig we own; until then our values are gameplay-bounded, not measured. |
| **BSFC / fuel maps, torque-converter, thermal derating** | No open data found in the accepted repositories. | OEM/lab data or our own bench session. |
| **Per-vehicle measured braking distances** | Consumer/NHTSA braking tables are copyrighted compilations; FMVSS only sets a legal envelope. | Our own instrumented stops, or a permissive dataset. |
| **Suspension spring/damper rates and hardpoints for production cars** | Not published under permissive licences (OEM data, SAE). | Physical measurement or licensed data. |
| **Modern tyre test datasets (thermal, wear, pressure)** | TTC/Calspan restricted; FSAE TTC membership-only. | Membership, or our own test. |

## Licence status of the whole data set

- Our code: **Apache-2.0**. Our own data/docs: **CC BY-NC 4.0**. Third-party files keep their own licence
  (see `LICENSING.md`, `CREDITS.md`, `data/physics/SOURCES.md`): BSD-3 tyres/powertrain, CC BY 4.0 aero and the
  engine curve, public-domain NHTSA/EPA/FMVSS/NACA, and **LGPL-3.0 track CSVs** (copyleft, validation-only, never
  linked into the engine).
- Nothing here is relicensed as ours. LGPL/ODbL material is aggregated, with notices and source.
- **Validate against** copyleft data is fine; **shipping** it carries the usual notice/source obligations. If the
  project ever needs a clean permissive tree, move the LGPL track CSVs to a fetch-at-test-time cache.

## Run against the simulation, not only the JSON (core `ctest`, since 2026-11-24)

The Node checkers read the car files. `core/tests/test_reference_data.cpp` drives every shipped car (or a body built from the
data) through the real `Vehicle` model and holds the result against the same data:

| test | data | what must hold |
|---|---|---|
| `reference_data_fmvss_braking` | FMVSS 135 (public domain) | ABS stop from 100 km/h inside the 70 m cold envelope for all 25 cars, and never shorter than the tyres' own peak friction + aero allows |
| `reference_data_top_speed_balance` | EPA coast-down CdA, engine curve, gearing | simulated top speed within 3 % of the on-paper balance, and a steady ride there (wheel-load swing < 6 %, heave < 4 mm) |
| `reference_data_measured_engine_curve` | Toyota 7A-FE, CC BY 4.0 | the measured curve fed verbatim through engine, clutch, driveline and the chassis dyno comes back within 4 % per bin (mean 1.009, peak 135.1 vs 135.5 N m at 3000 rpm) |
| `reference_data_chrono_engine_maps` | Project Chrono maps (BSD-3): 110 kW and 185 kW petrol, 80 kW truck, 193 kW bus diesel | the same dyno pull on a body scaled to each engine: mean within ~5 % (the spread is the tyres' warm-up lowering rolling resistance, not the map), and each file's listed peak power equals its own curve |
| `reference_data_epa_final_drives` | 1,699 EPA configurations | every car's axle ratio is inside the 5th-95th percentile of the EPA cars with the same gear count (ours sit at the 56th-82nd percentile of the 845 six-speed cars) |
| `reference_data_nhtsa_tilt_table` | NHTSA/VRTC 1997 SUVs and NCAP 2020 cars, measured CG heights | a tilt table built in the sim, run at every distinct measured CG height (0.52-0.71 m) and for all 25 cars: the high side lifts at 0.89-0.94 x the static stability factor T/2H (a rigid car 1.0; real tilt tables read a little under SSF because the body rolls) |
| `reference_data_aero_forces` | the cars' CdA / ClA / balance (EPA, class references) | at 200 km/h the tyres carry 0.96-1.06 x 1/2 rho ClA v^2 more load, the front share follows the car's balance (nose-down pitch adds up to +0.06), the coasting deceleration is 1/2 rho CdA v^2 / m + rolling within 3 % |

First finding: all of it passed on the JSON and the same cars failed in the sim. See "Damper rate" in `docs/physics.md`
(Aether Borealis R "top speed" 610 km/h vs 376 km/h on paper; Strix GT7, Valenza Icona SP3 and Kronos Taurus V12 3-5 % under
their own balance). After the fix every car is within 1.4 % of paper and rides steadily. The 60-0 mph stops shortened by
0.5-1 m (the false force had been loading the front tyres during pitch); 0-60, 0-200, skidpad and step-steer are unchanged.

**Not run through the simulation (be exact about this):**
- **Moments of inertia** (NHTSA/VRTC roll and yaw of 1990s SUVs): only range-checked in `inertia_reference.mjs`. A rigid body gives
  `tau / I` whatever the number; there is no measured observable of a sports car's inertia to compare with.
- **Track geometry** (Monza, Brands Hatch, Spa, Silverstone, Suzuka): sanity-checked for length (0.05-0.29 % error) and curvature
  in `track_sanity.mjs`; no lap is driven on them, because no lap-time dataset with a usable licence was found.
- **DrivAer / NACA / Energies aero references**: used as bounds on the cars' CdA, ClA and balance (`aero_check.mjs`). The three
  low-wing cars with a 0.50 balance stay flagged: the CFD class band is a proxy, not a measurement of them.
- **Tyres**: the 14 Chrono tyre files have their own sweeps (`tire_library`, `tire`, `tire_patch`) and the ADAC / ISO tests.

## How this is enforced

Every checker listed above runs in `.github/workflows/ci.yml`; `tools/validate_mod.mjs` and
`tools/assets/check_licences.mjs` gate the car data and the licence ledgers.
