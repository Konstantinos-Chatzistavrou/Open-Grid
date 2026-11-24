# Handling testing program

Goal: the cars should drive like real cars, and we should be able to show it. Three layers, cheapest first. Results
go into [validation.md](validation.md); anything that fails becomes an issue with the `handling` label.

## Layer 1: automated tests against published numbers (runs on every push)

Already running: magazine tests against a Corvette C7 Z51, car-against-car character checks, the FMVSS 126 sine
with dwell, and ~70 component tests. Next, in order:

| # | test | standard / source | what it tells us | status |
|---|---|---|---|---|
| 1 | Second reference car: a front-drive hot hatch (VW Golf GTI Mk7 PP → Mistra 200T: 0-60, 0-100, 60-0, skidpad, top speed, understeer balance) | magazine data (`test_reference_fwd.cpp`) | whether the model generalises or was tuned to one car | **done** (pass) |
| 2 | Steady-state circular test: understeer gradient (deg/g) and sideslip vs lateral acceleration | ISO 4138 | the car's balance as a curve, not one number | **done** (`test_iso_handling.cpp`, 4 cars; ranges from textbooks, not measured on real cars) |
| 3 | Step steer: yaw-rate response time, overshoot | ISO 7401 | turn-in feel, damping | **done** (`iso7401_step_steer`, 3 cars; target ranges from literature) |
| 4 | Double lane change at increasing speed | ISO 3888-2 | transient stability, how assists help | written (`iso3888_moose_test`) but **not enabled**: our test driver clips the cones at 70 km/h in both cars, which says more about the driver than the cars. Fix the driver first |
| 5 | Braking in a turn: yaw response when you brake mid-corner | ISO 7975 | lift-off and trail-brake behaviour | **done** (`iso7975_braking_in_turn`, one car, ABS+ESC and ABS only) |
| 6 | Tyre curves: our Magic Formula vs an independent implementation with the same `.tir` file, Fx/Fy/Mz over slip, load and camber (`tools/tyre/crosscheck_vdsim.py`, `core/tools/mf_dump.cpp`) | [VDSim](https://github.com/Onlyti/VDSim) (Apache-2.0), Project Chrono PAC2002 `.tir` (BSD-3) | that the tyre maths is implemented right, independent of tuning | **done** (0.000% symmetrized RMSE on Fx/Fy/Mz; caught & fixed `qEz4`/`qEz5` sign bug in `tir2car.mjs`) |
| 7 | Dry & wet braking + aquaplaning: dry 100-0 km/h spread, wet 80-0 km/h EU Class A–E spread, wet/dry 100-0 km/h ratio, 7 mm float speed (`test_adac_braking.cpp`) | ADAC 2024/2025 summer tests, EU 2020/740 / UNECE R117 | the dry/wet tyre grip & aquaplaning model | **done** (19/19 checks pass) |

Each new test follows the pattern in `core/tests/test_reference.cpp`: the procedure as the standard describes it,
the published value in the test's label, a pass range, and the source in a comment.

**Tyre data sources.** Our coefficients come from Project Chrono's PAC2002 files (BSD-3, may be redistributed). The
best real tyre data, the Formula SAE Tire Test Consortium (TTC, Calspan), is paid membership data for FSAE teams;
copies on GitHub are re-uploads by members, not a licence for us. Open Grid is public, and fitted coefficients are
derived from the data, so we only use TTC data with written permission from the TTC (ask them first).

Public test procedures worth reusing: NHTSA's crash-avoidance test procedures
([Volume IV reference guide](https://www.nhtsa.gov/document/volume-iv-crash-avoidance-test-reference-guide),
[TP-126](https://www.nhtsa.gov/sites/nhtsa.gov/files/documents/tp-126-03_tag.pdf)). ISO standards are paywalled,
but their procedures are described in many open papers and theses.

## Layer 2: an independent simulator

Run the same car in **Project Chrono** (open source, BSD-3, has a PAC2002 tyre and full vehicle models) and compare
the manoeuvres above. If two independent simulators with the same inputs agree, bugs in either one show up as
differences. Commercial tools (CarSim, IPG CarMaker, VI-grade) are the industry reference but cost money; ask
universities with Formula Student teams, they often have licences and students looking for a project.

## Layer 3: people on wheels

Numbers cannot tell us how the car feels. We need sim racers with wheels and pedals, and, best of all, people who
drive similar real cars on track.

**Setup.** The game runs in a browser (Chrome or Edge on Windows/macOS; live demo:
https://racing-game-brown-six.vercel.app/). Wheels connect through the Gamepad API; force feedback where the browser
supports it.

**Protocol for a session (20-30 min):**

1. Note your setup: wheel and pedals, rotation (degrees), force feedback on/off, browser, assists.
2. Warm-up: 3 laps, no notes.
3. Tasks, one at a time, then rate each 1-5 and write one sentence:
   - Turn-in at 60-80 km/h: does the car respond when you expect, as much as you expect?
   - Limit in a long corner: can you feel the front or the rear going before it goes?
   - Lift-off mid-corner: does the rear step out the way a real car of this type would?
   - Power oversteer out of a slow corner, assists off: is the slide catchable? How much countersteer?
   - Hard braking from 200 km/h, ABS on and off: does the car stay straight, does locking feel right?
   - Kerbs: does the car react to them the way you expect?
   - Force feedback: does the wheel get light when the front tyres slide?
4. Compare with a sim you know (iRacing, ACC, rFactor 2, Assetto Corsa, BeamNG): closer to which, and where it
   differs.
5. Send it through the **Handling feedback** issue form. Add a telemetry export or a short video if you can.

**Where to find drivers:** r/simracing, the OverTake forum (overtake.gg), sim racing Discords, Formula Student
teams, local track-day clubs. Post once with the demo link, the protocol above and the feedback form; reply to every
report; post a short "you said X, we changed Y" update when a fix lands. Pin one issue ("Handling feedback: start
here") that links this page, so reports land in one place.

**What we do with reports.** A report that two or more drivers agree on becomes a `handling` issue with a
reproducible test (layer 1) where possible, so the fix stays fixed.
