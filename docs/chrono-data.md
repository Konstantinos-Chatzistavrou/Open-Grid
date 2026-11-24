# Project Chrono data: what exists, what we hold, what we tested

Source: <https://github.com/projectchrono/chrono>, pinned at commit `e166f3e5a1383741e86cf1e195a46eba4a66473d`, licence
BSD-3-Clause (`data/reference/chrono-vehicles/LICENSE-projectchrono.txt`). Chrono is a multibody simulator, so its data are model
parameters published with its examples, not measurements: several are estimates or placeholders (see "Defects" below).

## Scan of `data/vehicle` (the part of Chrono's data about cars)

1,389 files: 531 JSON, 15 `.tir`, 177 `.obj` + 106 `.mtl` meshes, 139 `.jpg` + 24 `.png` textures, 41 `.crg` road surfaces (25 MB),
58 POV-Ray `.inc`, text. JSON by kind: suspension 54, vehicle assemblies 42, powertrain (engine + transmission) 41, tyre 40, brake 27,
chassis 20, driveline 19, steering 14, wheel 8, terrain 7, and tracked-vehicle parts (sprockets, idlers, track shoes...).

| what | files | status |
|---|---|---|
| **All 531 numeric JSON + 15 `.tir`** | 546, 867 KB | **imported verbatim** (`data/reference/chrono-vehicles/`, `MANIFEST.json` holds each file's git blob sha; `node tools/physics/import_chrono_vehicles.mjs --verify` re-hashes them in CI). Before 2026-11-24 we held only 14 tyres, 4 engine maps + gearboxes and 2 chassis files. |
| Pacejka `.tir` tyres | 15 | 14 were already in `data/tires/` (byte-identical; Sedan and Audi are the same file). The 15th, `HMMWV_pacejka.tir`, is the old Pacejka-89 format, which our parser does not read. |
| Meshes, textures, POV-Ray includes | ~450 | **not imported**: visuals, not physics (some have their own licences, e.g. `Polaris/meshes/README.md`). |
| OpenCRG road surfaces | 41, 25 MB | **not imported**: includes the **Nürburgring Nordschleife** (21.1 km at 0.1 m, with elevation and cross-section), Barber Motorsports Park, Horstwalde, handling circles, ISO-style roughness courses and half-round bumps. Chrono does not state a licence for the surveys (OpenCRG sample data); the licence has to be confirmed first, and a CRG reader written. This is the best next real-track dataset. |
| Rest of Chrono `data/` (robot, sensor, fea, fsi, fmi, urdf, yaml, models...) | - | not vehicle dynamics: not scanned beyond the directory list. |

## What was tested, and how (all in CI)

| data | test |
|---|---|
| every file | `check_chrono_vehicles.mjs`: files are the pinned blobs; 528 of 531 JSON parse (Chrono's parser allows `//` comments and trailing commas, ours strips both); the 3 that do not are listed as upstream-malformed and a new one fails the check |
| 14 `.tir` tyres | `tire_library`, `tire`, `tire_patch`, `tire_symmetry` and the ADAC / ISO suites (core `ctest`) |
| engine maps | `reference_data_chrono_engine_maps` (audi, sedan, uaz, citybus) and `..._all` (M113, Polaris, VW van, Duro, G500, HMMWV): each full-throttle map through engine, clutch, driveline and the chassis dyno on a body scaled to the engine: mean within 2.2-4.8 % of the map. ACV and MAN are copies of the city bus map; the Marder map is written in rad/s and is left out (flagged); `M113_RS` is malformed upstream; 8 `EngineShafts` / `EngineSimple` files have no full-throttle curve to compare |
| chassis mass / inertia | `check_chrono_vehicles.mjs` against the measured NHTSA/VRTC radii of gyration (below) |
| suspensions, brakes, wheels, steering, driveline, gearbox, chassis, tyre, vehicle assembly of the **Audi, HMMWV and Nissan Patrol** (both axles double wishbone) | converted to cars of our schema by `tools/physics/chrono_to_cars.mjs` (wheel rate = spring rate x the motion ratio measured on the hardpoints squared) and run through the sim by `reference_data_chrono_vehicles` (static, heave, braking, tilt, full-lock turning radius, 0-100, yaw, solver motion ratio): see docs/physics-data-gaps.md |
| the other suspensions (solid axle, leaf spring, multi-link, trailing arm), brakes / wheels of those vehicles, tracked vehicles, TMeasy / Fiala / ANCF / Reissner tyres | imported and parsed, field-checked (finite, positive); no counterpart in our model |

## Defects found in Chrono's own data

- **Chassis inertia is mostly not realistic.** Only 8 of 27 chassis fall inside the roll 0.30-0.55 / yaw 1.5-2.2 m^2 radius-of-gyration range
  that NHTSA measured on real vehicles (roll 0.40-0.44, yaw 1.8-2.0 m^2). The Audi and the Sedan carry the same numbers (1550 kg, roll k^2 0.144,
  yaw 0.68 m^2: a third to a half of a measured car), a Polaris variant has k^2 = 0.001 (a placeholder). **None of it is used for any car.**
- **Two chassis are physically impossible**: `Polaris_Chassis.json` (275.7 / 853.4 / 1200 kg m^2) and `CityBus_Chassis.json` (13500 / 13500 / 115100)
  violate the triangle inequality every rigid body obeys.
- Inside Chrono the HMMWV has two different engines (`EngineSimple` 330 Nm / 110 kW, `EngineSimpleMap` 793 Nm / 153 kW); the Marder's map is in rad/s.
- Three files are not valid JSON even for Chrono's tolerant parser.

## What converting the Chrono cars showed
- Our kinematics solver agrees with a hand lever calculation of the motion ratio on Chrono's hardpoints to 1-10 %.
- Chrono's Audi tie-rod hardpoints give **-36 deg/m bump steer** (a road car: under 2); the HMMWV and Patrol -7 deg/m front. They are example geometries, not tuned vehicles.
- Chrono's Audi has COM 0.74 m above the road and a wheelbase of 2.921 m from its axle positions while its own file says 2.776 m.
- Carrying our Vela's steering compliance (0.12 deg/kN) and anti-roll bar into the conversion made the converted cars understeer and overshoot; Chrono specifies neither, so they are zero in the converted cars.

## Honest summary
We now hold every numeric vehicle file Chrono ships for cars and trucks, byte for byte, and the parts our simulator can consume (tyres, engine
maps) are run through it. We do not use the rest, because it either describes a different model (TMeasy tyres, track assemblies), needs a
conversion we have not done (spring rates at the spring), or is demonstrably unrealistic (chassis inertia). The data did not change any car's
numbers; what the validation work found were bugs in our own model (docs/physics-data-gaps.md).
