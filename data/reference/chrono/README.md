# Reference vehicle data (Project Chrono)

Extracted from Project Chrono's vehicle dataset so the physics core can be validated against a published,
permissively licensed source instead of hand-tuned numbers.

- **Source**: https://github.com/projectchrono/chrono/tree/e166f3e5a1383741e86cf1e195a46eba4a66473d/data/vehicle
- **Commit**: `e166f3e5a1383741e86cf1e195a46eba4a66473d` (2026-11-23)
- **Licence**: BSD-3-Clause (see `data/tires/LICENSE-projectchrono.txt`; the same licence covers these JSON files)
- **Retrieved**: 2026-11-24

## Files

| file | contents |
|---|---|
| `audi_a4.json` | sedan: 1550 kg, inertia [222.8, 944.1, 1053.5] kg m², wheelbase 2.776 m, 245/40R18 PAC2002 tyre (already byte-identical to `data/tires/audi_245_40R18_pac2002.tir`), engine full-load torque curve, 900 Nm brakes |
| `g500.json` | SUV: 2354 kg, inertia [785, 2612, 2761] kg m², 2.85 m wheelbase, TMeasy tyre (r 0.372 m, mu 0.8, rr 0.015), solid-axle suspension reference |

Only values that exist in the upstream files are recorded; nothing is estimated. Fields not present upstream
(track width, aero coefficients, gear ratios beyond the driveline JSON) are deliberately absent rather than guessed.

## Axes / units

Chrono uses metres, kilograms, seconds, radians. Chassis frames are ISO 8855: **x forward, y left, z up**, so
the inertia triple is `[Ixx (pitch), Iyy (yaw), Izz (roll)]` for a road vehicle. Our core uses the same ISO axes;
adapters that swap y/z must permute the inertia tensor, not just the vector.

## How to use

1. Load a reference and compare the core's own car config against it (mass, wheelbase, CG height, inertia).
2. Drive the reference through the standard manoeuvres (steady-state cornering, ISO 3888-2, braking) and check
   the core's response falls inside the kinematic envelope (e.g. minimum radius between `L/tan(delta_max)` and the
   upstream published minimum radius).
3. Do not tune our cars to match a reference exactly: the reference exists to catch sign errors, unit errors and
   unphysical inertia, not to clone a specific vehicle's handling.
