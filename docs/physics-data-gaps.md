# Physics data: what we have, what is missing, and how to close it

Last updated 2026-11-24. Every entry below is either a committed file with a licence or an explicit gap.
The point of this page is that no number in the physics configs is anonymous, and no missing number is
invented.

## Have (committed, licensed, checked in CI)

| domain | where | source / licence | confidence | checker |
|---|---|---|---|---|
| Tyres, 14 sets | `data/tires/*.tir` | Project Chrono, **BSD-3** (verbatim) | high (published MF datasets) | `ctest -R tire` (14-file sweep) |
| Engines + gearboxes, 4 (and every other Chrono file: 546, see `docs/chrono-data.md`) | `data/powertrain/reference-powertrains.json`, `data/reference/chrono-vehicles/` | Project Chrono JSON, **BSD-3** | **low-medium** (simplified maps; chassis inertias mostly unrealistic) | `check_powertrain.mjs`, `check_chrono_vehicles.mjs`, `reference_data_chrono_engine_maps[_all]` |
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
| `reference_data_aero_reference_bands` | DrivAer Cd (CC BY), NACA 0012 cl_max, Energies 2022 CFD front share | the envelopes of `aero_check.mjs` applied to what the sim DOES: effective CdA from the coasting deceleration, effective ClA and front share from the tyre loads at speed. All 25 cars inside; the three road-class cars the JSON check flags (balance 0.50 vs the 0.55-0.90 CFD band) show 0.56-0.62 in the sim (nose-down pitch), inside the band |
| `reference_data_real_tracks` | TUMFTM geometry of Monza, Brands Hatch GP, Spa, Silverstone, Suzuka (LGPL, validation only) | racing line on the real centreline and widths; a test driver follows a speed profile built from the car's own measured limits with a friction ellipse. 10 of 10 laps (Vela GT, Tornado GT3) complete on the track, 1.03-1.05 x the 92 % profile and 1.08-1.13 x the quasi-steady lap at 100 % of the limits (a lap cannot be shorter than that) |
| `reference_data_real_tracks_ai` | the same | the game's AI on the same laps: see "Known gap" below |
| `reference_data_chrono_vehicles` | Project Chrono Audi, HMMWV and Nissan Patrol, **complete** (chassis, suspension hardpoints, springs, dampers, brakes, wheels, steering, driveline, engine, gearbox, tyre), converted by `tools/physics/chrono_to_cars.mjs` | static ride, weight distribution; heave period from the spring and damper rates (sim within 1-2 % of theory); braking from the brake torque (the Audi's brakes, not its tyres, limit it: 0.98 x); tilt table 0.87-0.90 x SSF; full-lock turning radius 1.05 x the radius Chrono states; our kinematics solver's motion ratio against a lever calculation on the same hardpoints (0.90-0.99); 0-100 km/h not faster than the power allows; yaw response vs the bicycle model |
| `reference_data_nhtsa_modern_cars` | the 9 NHTSA NCAP 2020 cars with ALL their measured geometry (mass, track, wheelbase, CG) | each built as a car and put on the tilt table: lifts at 0.92-0.94 x the SSF NHTSA PUBLISHED for that car |
| `reference_data_clutch_margin` | found by the all-car laps | 4 cars had clutch capacity of 1.10-1.25 x peak torque and slipped on a hot lap (Fulmine: a third slower than its own limits); capacities raised, none below 1.25 x |
| `reference_data_pitch_inertia_sensitivity` | pitch inertia is unpublished | what the unknown costs: +-25 % moves stops and launch by < 1.1 %; 0.5x / 2x by < 2.3 % (the slick-and-wing GT3 most) |
| `tools/physics/check_epa_rows.mjs` | all 1,699 EPA rows, one by one | year, gears 3-10, axle ratio 1.5-7, 0.5-8.4 L, 40-1500 hp, 20-250 hp/L, licence and source present |
| `tools/validation/gps_layers_check.mjs` | the GPS water / green layers and speed limits of 17 cities against real places | 102,399 checks; found the missing Thames and a matcher bug (below) |
| `reference_data_inertia_rigid_body` | NHTSA/VRTC measured roll and yaw inertia, 12 SUV configurations | torque about the roll and yaw axes accelerates the body at tau / I to 0.5 %; a torque-free tumble keeps angular momentum and energy to 1e-4 (explicit Euler had drifted them 0.9 % and 1.5 % in 3 s: integrator fixed, see `docs/physics.md`) |
| `reference_data_inertia_yaw_response` | the same measured radii of gyration (1.8-2.0 m^2) in the Vela body | the sim's step-steer yaw response against a linear bicycle model with the same inertia, tyres, loads and geometry: the SLOW-DOWN the measured inertia causes agrees to 3-4 % (sim x1.10-1.23, model x1.13-1.26); the absolute response of the sim is ~30 % faster than the bicycle model for every car (it has roll, camber thrust and steering geometry the model lacks) |

First finding: all of it passed on the JSON and the same cars failed in the sim. See "Damper rate" in `docs/physics.md`
(Aether Borealis R "top speed" 610 km/h vs 376 km/h on paper; Strix GT7, Valenza Icona SP3 and Kronos Taurus V12 3-5 % under
their own balance). After the fix every car is within 1.4 % of paper and rides steadily. The 60-0 mph stops shortened by
0.5-1 m (the false force had been loading the front tyres during pitch); 0-60, 0-200, skidpad and step-steer are unchanged.

**What the all-car, all-circuit run found (2026-11-24):** with `RS_ALL_CARS=1` every car drives every circuit: 124 of 125 laps complete at 1.02-1.06 x the profile they are driven on; the one that does not is the Aether Borealis R (1.1 kNm, rear drive, slicks) at Spa, which snaps at 172 km/h at the Blanchimont-type fast left and is left in the slide by the test driver (a driver limit, listed). The same run found the Kronos Fulmine V10 a third slower than its limits on a lap, traced to its clutch (capacity 1.10 x peak torque): fixed, and three more cars raised.

**Still not possible, and why:**
- **Pitch inertia** is not published in any open source we found (NHTSA lists roll and yaw only). Its cost is measured instead (above): small.
- **Roll and pitch ringing** has no clean analytic reference: the sim's roll mode is strongly damped by the tyres' low-speed lateral damping and the asymmetric dampers (a first attempt with the textbook roll-axis model was 1.2-1.6 x off and was dropped rather than tuned). The heave mode, which is clean, is tested.
- **Absolute pace of real cars**: two published GT3 qualifying laps were found (Spa 2:16.984, Brands Hatch GP 1:23.617; `data/physics/gt3-lap-references.json`, low-medium confidence: a news report and a fan-run page) and none for Monza, Silverstone or Suzuka. **Calibrated 2026-11-25:** the Tornado GT3 was 10 % (Spa) and 7 % (Brands Hatch) slower than those laps at 100 % of its own limits (the older "17-20 % slower" compared the test driver's 92 % lap, which mixes the car with the driver's margin). With published-class power (415 kW), downforce (2.9 m^2 lift area from a 870 kg at 250 km/h figure), brakes that no longer cap the stop and one fitted tyre-grip factor (x1.26), it is now 4.3 % and 1.1 % off, and a test (`reference_data_real_tracks`) holds it between -3 % and +6 %. Only the GT3 has real laps: the other 24 cars are de-branded originals with no named real counterpart, so no published figure exists to calibrate them against. The grip factor is a fit, not a measurement, and the aero figures are one manufacturer claim for a related car.
- **Measured production-car downforce**: the one dataset (IST FST14) is embargoed to 2027-05-01.
- **OpenCRG roads in Chrono's data (Nuerburgring Nordschleife with elevation, Barber)**: checked. OpenCRG's own repository (Apache-2.0) ships only small samples, not these; the Chrono files were written with `crg_write` in 2020 and name no survey source, so their provenance and licence cannot be confirmed: not imported. No elevation is used anywhere (the TUM tracks have none).
- **Chrono parts with no counterpart in our model**: solid axles, leaf springs, multi-link and trailing-arm suspensions (the other vehicles), tracked vehicles, the TMeasy / Fiala / ANCF / Reissner tyre models, the old Pacejka-89 `.tir`; the Chrono Sedan and Patrol rear axles sit at chassis heights that differ by 0.125 / 0.04 m (the Sedan is skipped). Chrono has no aero data.
- **EPA rows** cannot be simulated one by one (no engine, mass or tyres in them): each is checked for plausibility, and the axle ratios form the band our cars are held to.
- **The game's AI driver** is built for city streets: on the five circuits 4 of 10 laps stay within 2 m of the edge (9 of 10 left the track before its speed profile got a friction ellipse); `reference_data_real_tracks_ai` guards that level. It is driver work (slide recovery, braking anticipation), not model work.
- **London's Thames** is missing from the GPS water layer (the London extract is clipped, the river's multipolygon cannot be assembled): a listed known gap.
- **DrivAer / Energies / NACA**: CFD or wind-tunnel data of other shapes: bounds on our CdA, ClA and balance, not calibration.
- **Tyres**: the 14 Chrono tyre files have their own sweeps (`tire_library`, `tire`, `tire_patch`) and the ADAC / ISO tests.

## How this is enforced

Every checker listed above runs in `.github/workflows/ci.yml`; `tools/validate_mod.mjs` and
`tools/assets/check_licences.mjs` gate the car data and the licence ledgers.
