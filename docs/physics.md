# Physics core: model, equations, decisions

Code: `core/` (C++17, zero engine dependencies). Units SI. World and body frames are right-handed,
Z up. Body frame (ISO 8855): +X forward, +Y left, +Z up, origin at the centre of gravity (CG).

## 0. What is validated, what is calibrated, what is not (read this first; written 2026-11-25)

**In one line:** the model has most of the ingredients that are publicly described for commercial sims, and it is checked against every
open dataset we could find; its calibration against real cars and real tyre tests is **not yet proven**.
Do not call it "the most advanced" or "better than" any other engine: that has not been measured.

| part | state |
|---|---|
| Tyre curve shapes (Magic Formula, aligning torque, camber, load sensitivity) | fitted PAC2002 files from Project Chrono (BSD-3), 14 sets; each car's **peak grip is a per-car calibration** |
| Tyre thermals (3 nodes, 3 ribs, WLF flash), inflation pressure, wear, flat spots, blistering, graining, belt dynamics | present and tested for plausibility and energy balance. **Their constants (heat capacities, conductances, hysteresis, wear rates, belt stiffness) are typical values set by hand from the literature, not fitted to a measured tyre**: no open thermal / wear / pressure test data exists for us (`docs/physics-data-gaps.md`). Earlier comments and commit titles said "Simcenter Tire 2606"; no such software or data was used |
| Suspension kinematics (double wishbone / MacPherson from hardpoints), dampers, ARBs, load transfer | present; per-car hardpoints and spring/damper rates are mostly design values, not production-car data |
| Engine, clutch, gearbox, diffs, ABS / TC / ESC | present; only one measured engine curve (Toyota 7A-FE) and EPA axle ratios exist as references |
| Crash damage, brake thermals, wet grip | present; wet braking fitted to Continental's published stops, the rest plausibility-checked |
| Real car pace | **only the Tornado GT3 is calibrated** (2026-11-25), to GT3-class public figures and two real qualifying laps: its quasi-steady lap at 100 % of its limits is +4.3 % (Spa) and +1.1 % (Brands Hatch GP) of those laps. The aero and grip numbers are low-confidence. The other 24 cars are de-branded originals with no named real counterpart, so nothing to calibrate them against (`data/physics/gt3-lap-references.json`) |
| Force feedback | the signal is checked (`web/tools/ffb_signal_check.mjs`); **never run on a wheel** (`docs/ffb_test_plan.md`) |

### Which models are on: the tests and the game differ

The browser game (`web/wasm/bridge.cpp`) and the Unreal plugin (`OpenGridVehicleComponent.cpp`) switch optional models on; the core's
defaults, and therefore **every reference test, run with default settings, leave most of them off**:

| model | core default (tests) | game / Unreal |
|---|---|---|
| 2-DOF unsprung wheel hop + radial carcass (15 Hz, 42 kg unsprung) | off (wheels massless) | on |
| Chassis torsional flex (22,000 N m/deg default stiffness, no citation in the code) | off | on |
| Sideslip-dependent drag and rear-wing lift | off | on |
| Active torque-vectoring yaw moment (up to 1,450 N m) | off | on |
| Active aero: DRS and braking airbrake | off | on, **only for cars whose spec declares it** (`aero.drs`, `aero.airbrake`; 5 cars, see below) |
| DOT 4 brake-fluid boil | off | on |
| Driveline torsional compliance, dog-box shift cut, H-pattern synchromesh | off | on |
| Tyre zones, 4x4 contact patch, thermals, pressure, wear, damage | on | on |

`RS_GAME_MODELS=1 ctest --test-dir core/build` runs the whole suite with the game's settings (the same list, `test::enable_game_models`;
`RS_GAME_MODELS_OFF=name,name` leaves some out to find where a difference comes from: unsprung, zones, yaw_aero, flex, ayc, active_aero, brake_boil,
torsional, dogbox). Measured 2026-11-25: the headline numbers do not move (the calibrated GT3: skidpad 1.53 g either way, braking 1.68 vs
1.69 g, quasi-steady laps within 0.1 s), and 95 of 98 tests pass. The three that differ, each traced to one model by switching it off:
- `dyno`: 0-100 km/h is 12 % slower than the dyno predicts. Only the **driveline torsional compliance** model causes it. Whether 12 % is realistic
  is unproven; a driveline's wind-up should not cost that much, so it is probably too much.
- `reference_data_chrono_vehicles`: the HMMWV's yaw response is 0.34 x the bicycle model (limit 0.4). Also only **driveline torsional compliance**.
- `characters`: the Kestrel's two aero-grip checks fail (its fast-corner grip no longer exceeds its skidpad). Only the **dog-box flat-shift cut**
  setting causes it: the torque cut during the test's gear changes in the corner, not the aero.

**Active aero (fixed 2026-11-25).** Until then every car, road cars included, got DRS (above 180 km/h at full throttle: drag x0.86, rear downforce x0.82)
and an airbrake (braking above 22 m/s past 55 % pedal: drag x1.24, rear downforce x1.22) in the game, which put top speed 2.7-4.1 % above the paper
balance for four cars. Now a car has them only if its spec says so: `"aero": {"drs": true, "airbrake": true}` (default false; core `AeroParams::drs`,
`airbrake`). Declared: Strix GT7, Aether Borealis R, Kestrel GT, Falcorn 9R GT and 9R RS Weissach, the five cars with a real downforce wing (lift area
0.85-1.15 m^2; every other car has 0.7 or less). Not declared: all road cars, and the Tornado GT3 (GT3 cars have a fixed wing, and it is calibrated
against real GT3 laps without one). Checked in the WASM the game runs: Vela GT, Tornado GT3 and Mistra 200T never deploy it in 40 s at full throttle
plus hard braking; the five declared cars do. The HUD indicators and the wing animation follow the physics flags, so they follow automatically.
The multipliers are `kDrsDragMult` etc. in `core/include/rs/config.hpp`. One other effect hangs off the same host switch and is unchanged: the
front-splitter stall (front downforce x0.74 when the splitter bottoms out above 35 m/s) applies to every car, which is a ride-height effect and
not active aero.

### What a 40-lap stint does (updated 2026-11-25, `RS_STINT=40 core/build/rs_tests reference_data_stint`)

The Tornado GT3 (slicks) driven by the race AI round Brands Hatch GP for 40 laps, game models on; one lap printed per row, so the run is
repeatable (`RS_SKILL`, `RS_AIR_C`, `RS_TRACK_C`, `RS_GAME_MODELS` change the driver and the weather; not in the ctest list, a stint takes
20 s to 2 min). After adding the 24-node deformable flexible-ring carcass (`CarcassRing`), compound viscoelastic hysteresis scaling, brake-rotor
rim soak, thermal wear acceleration, late-stint slick wear cliff, flat-spot grip/load coupling, and sidewall rollover / kerb rim-strike physics:

| conditions | lap 2 -> lap 40 | carcass / surface (lap 2 -> peak -> lap 40) | pressure kPa | mean wear at lap 40 | grip factor mean / worst (lap 1 -> 40) |
|---|---|---|---|---|---|
| 20 C air / 25 C track, AI default pace (`RS_SKILL=0.95`, ~86 % of limit) | 98.31 -> 98.35 s (+0.04 %) | 76.7/68.4 -> 75.2/67.3 C | 220 -> 219 | 0.658 | 0.999/0.998 -> 0.917/0.891 |
| 20 C air / 25 C track, AI pushing harder (`RS_SKILL=1.10`) | 94.45 -> 99.17 s (+4.99 %, +4.72 s) | 82.6/73.2 -> 82.8/73.3 -> 79.7/70.9 C | 223 -> 222 | 0.842 (cliff ~lap 32) | 1.000/1.000 -> 0.816/0.689 |
| 40 C air / 60 C track (sun-baked), pushing harder (`RS_SKILL=1.10`) | 94.71 -> 100.92 s (+6.55 %, +6.21 s) | 89.8/81.3 -> 91.6/82.6 -> 86.9/78.5 C | 231 -> 232 | 0.873 (cliff ~lap 31) | 1.000/1.000 -> 0.792/0.680 |

- Slicks now sit inside their 75-105 C working window at race pace (75-83 C carcass on a 20/25 C day, 90-92 C on a 40/60 C day,
  219-232 kPa hot pressure) and lose 4.7-6.2 s/lap by lap 40 when pushed (`RS_SKILL=1.10`) as tread wear crosses the 70 % cliff (worst-tyre
  grip 0.68-0.69). The conservative default AI (`RS_SKILL=0.95`) leaves margin below peak grip so its lap time barely moves despite losing
  8-11 % grip. Blistering stays 0 on clean AI Brands Hatch stints (carcass stays below the 105 C ceiling) and activates under sustained
  overheating above 108 C carcass / 113 C surface (tested in `tire_patch`).
- **24-node deformable flexible-ring carcass (`CarcassRing`, `core/src/tire.cpp`)**: each tyre runs a 24-node circumferential belt ring on a
  pressurized viscoelastic sidewall foundation (radial, lateral, and tangential DOFs per node, pneumatic membrane tension, steel-belt bending,
  hoop-restored centrifugal radial growth of ~3.3 mm at 300 km/h, and direct viscoelastic flexing hysteresis into the carcass thermal node).
  Measured CPU cost (`rs_bench`, 8 cars at 400 Hz on i3-1315U): `BASELINE` physics 21.94 us/car/tick (1.994 ms/frame total for 8 cars),
  `MAXED AAA` physics 29.17 us/car/tick (3.114 ms/frame total for 8 cars); `rs_bench_runtime` 16 cars 3-ray AAA at 400 Hz: 18.67 us/step/car (1.99 ms @60fps, 11.9 % of 1 core).
- **Flat spots**: ground directly into the 24 rotating belt nodes; reduce both steady and instantaneous contact-patch grip, modulate vertical
  wheel load and chassis vertical acceleration once per revolution on all four wheels, and excite steering torque (fronts) and cavity acoustics.
- **Sidewall rollover, bead & rim kerb strike**: under-inflation, punctures, or lateral kerb strikes roll the belt over onto the un-treaded
  shoulder (adverse camber + lateral grip washout); violent sharp kerb impacts bottom through the folded sidewall onto the rim flange, spiking
  vertical load, accumulating sidewall damage, and opening an ideal-gas puncture leak that deflates the tyre smoothly toward 0 kPa gauge.
- **Still unproven against measured rig data**: the carcass stiffnesses, loss tangents, wear rates, and rim-strike thresholds are clean-room
  literature/plausibility calibrations (`docs/physics-data-gaps.md`), not fitted to proprietary tyre-rig (Calspan / TTC) datasets; do not claim
  proven parity with or superiority over commercial sims without measured validation data.

## 1. Integration architecture
- The engine integrates the chassis rigid body (so collisions work) at a fixed physics tick
  (target 400 Hz, 2.5 ms). Each tick: `wheel_rays()` -> engine raycasts -> `update(chassis, contacts, dt)`
  -> engine applies `force`/`torque` at the CG plus gravity.
- Inside `update()`, the stiff rotating parts (4 wheel spins, engine, clutch, diffs, tyre slip
  states) are sub-stepped at h <= 1 ms (3 sub-steps = 1,200 Hz at 400 Hz) with the chassis velocity frozen,
  and the 24-node deformable carcass ring sub-steps at h <= 0.5 ms (2,400 Hz).
  Tyre forces are averaged over the sub-steps.
- Headless `Simulation` (tests) integrates the chassis with semi-implicit Euler:
  `v += F/m dt`, Euler's equations in body axes `I dw/dt = tau - w x (I w)`,
  `dq/dt = 1/2 (0, w) q`, then `x += v dt`.
- Verified (`timestep` test): braking distance is 39.403 m @240 Hz, 39.405 m @400 Hz, 39.406 m @1000 Hz (0.0025 % between 400 Hz and 1000 Hz).

## 2. Suspension (per wheel, raycast)
- Ray from the top mount along body -Z, length = spring free length + tyre radius.
- Compression `c = L0 + r - d_hit`. Spring `F = k c`; bump stop `k_bs (c - c_static - travel)`.
- Damper `F = c_bump * dc/dt` (compressing) or `c_rebound * dc/dt` (extending). dc/dt is the
  mount velocity along the suspension axis (no finite differences, so no noise).
- Damper rate `dc/dt` is the exact rate at which the ray's hit distance shrinks over static ground: the velocity of
  the hit point (a point fixed to the body at the end of the ray) along the ground normal, over the cosine between
  ray and normal. It is NOT the mount velocity dotted with the ray direction: that also counts forward speed x
  sin(pitch) (0.45 m/s of false "compression" on every damper at 86 m/s and 0.3 deg of pitch), a speed-proportional
  force that fed pitch into heave and drove a growing limit cycle above ~300 km/h (wheel loads swinging 8-25 kN on a
  13 kN car; the Aether Borealis R took off and "reached" 610 km/h on an engine that allows 376). Fixed 2026-11-24;
  regression: `reference_data_top_speed_balance` (steady ride at top speed for every car).
- Anti-roll bar `F = k_arb (c_this - c_other)` per axle.
- Tyre load `Fz = F_susp * (up . n)` + geometric transfer (below). Springs only push.
- Static geometry is derived from the data: mounts are placed so the car rests exactly at
  `cg_height` with the static compression `x_s = m g w / (2k)`.
- Wheels/unsprung mass are massless **by default** (the tests). The game and the Unreal plugin switch on a 2-DOF 15 Hz wheel-hop and radial
  carcass model (`Vehicle::unsprung_dynamics_enabled`, 42 kg unsprung per corner): see section 0.

Rigid body (`RigidBody::integrate`): Euler's equations in body axes with RK4 for the gyroscopic coupling and a second-order
orientation update (the orientation turns by the mean body rate of the step). Explicit Euler had put 1.5 % kinetic energy into a 3 s
tumble at 2.7 rad/s and drifted the angular momentum 0.9 % (`reference_data_inertia_rigid_body`); a driven car's yaw / roll
coupling is so small that no handling number changed to the third digit.

## 3. Load transfer (emerges, nothing is scripted)
- Longitudinal: tyre forces act at the contact patch -> pitch moment -> springs.
  Theory `dFz_front = m a h / L`. Test: measured/theory = 0.98.
- Lateral: total `sum(Fz y) = -m a_y h`. Split into:
  - elastic part through springs/ARBs: body roll moment `F_y (h - h_rc)` (lateral tyre forces
    are applied to the body at the roll-centre height `h_rc`);
  - geometric part through the links: `dFz = F_y_axle h_rc / track` added to tyre loads (uses
    the previous tick's axle force).
  Test: measured/theory = 1.02.

## 4. Tyres: Pacejka Magic Formula
`y(x) = D sin(C atan(B x - E (B x - atan(B x))))`, slope at origin `BCD`.
- Longitudinal: `D = mu_x (1 + pdx2 dfz) Fz`, `K = kx Fz`, `B = K / (C D)`, `dfz = (Fz - Fz0)/Fz0`.
- Lateral: `D = mu_y (1 + pdy2 dfz) Fz`, cornering stiffness `K = pKy1 Fz0 sin(2 atan(Fz / (pKy2 Fz0)))`.
- Load sensitivity (pdx2, pdy2 < 0): mu falls as load rises -> load transfer costs total grip.
- Combined slip (MF 5.2 weighting): `Fx = Fx0 cos(rCx1 atan(Bxa alpha))`,
  `Bxa = rBx1 cos(atan(rBx2 kappa))`; `Fy = Fy0 cos(rCy1 atan(Byk kappa))`,
  `Byk = rBy1 cos(atan(rBy2 alpha))`.
- Slip with relaxation lengths (first-order transient):
  `d kappa/dt = (w r - v_x - |v_x| kappa) / sigma_x`, `d tanA/dt = (-v_y - |v_x| tanA) / sigma_y`,
  integrated implicitly: `k1 = (k0 + h v_s/sigma) / (1 + h |v_x|/sigma)`. Steady state equals the
  textbook definitions, but it is finite at standstill (no divide by zero).
- Low-speed damping (< 2 m/s, blended out): `F += 2 Fz * v_slip`, capped at mu Fz. Stops the
  relaxation "spring" oscillating when parked. Test: 0.000 m drift in 10 s, holds a 10 % slope.
- Rolling resistance torque `c_rr Fz r`. Surface grip multiplies mu (asphalt 1.0, kerb 0.92, ...).
- Everything that used to be listed here as missing is modelled now: tyre temperature, wear and flat spots (`TireCondition`), aligning moment
  Mz and pneumatic trail (the force-feedback signal), camber and inflation pressure (MF 6.1 / 6.2 terms), turn slip. Their sections are at the end
  of this page; their calibration is described in section 0.

## 5. Drivetrain
- Engine: `T = thr T_full(rpm) - (1 - thr)(c0 + c1 w)` (engine braking = pumping/friction losses).
  Idle controller below idle rpm, fuel-cut rev limiter, stall below ~300 rpm (restart when
  declutched / in neutral).
- Clutch and LSDs are "Coulomb couplings" solved exactly per sub-step. Torque that makes both
  sides equal speed at the end of the step:
  `T_req = (w1 - w2 + h (a1 - a2)) / (h (1/I1 + 1/I2))`. If `|T_req| <= capacity`, apply it
  (locked); else apply `+-capacity` (slipping). Unconditionally stable, no stiff springs.
- Gearbox: total ratio `G = gear * final_drive`; wheel torque `T_clutch G eta`.
- Differential tree (RWD, FWD, AWD = centre diff over front and rear diffs). Open diff with split s:
  `T_a = s T`, `T_b = (1 - s) T`, `w_c = s w_a + (1 - s) w_b`, effective inertia
  `1/I = s^2/I_a + (1-s)^2/I_b`. LSD locking capacity `preload + ramp |T_in|` (power/coast ramps).
- Brakes: total torque x pedal, split by front bias; applied as friction that can stop a wheel
  but never reverse it (clamped impulse) -> clean lock-ups.
- Steering: `delta = input * max_lock`, Ackermann blend `tan(d_in) = L/(R - t/2)`,
  `tan(d_out) = L/(R + t/2)`; compliance steer `d -= c * Fy_axle` (rack/bushing flex).

## 6. Aerodynamics
Drag `F = -1/2 rho CdA |v| v` at the CG. Downforce `1/2 rho ClA v_x^2` split front/rear by
balance, applied at the axles (so it pitches the car).

## 7. Validation (Vela GT data, `core/tests`, all headless)
| check | result | reference / theory |
|---|---|---|
| static axle split | 0.480 | spec 0.48 |
| longitudinal transfer | 0.98 x theory | m a h / L |
| lateral transfer | 1.02 x theory | m a_y h |
| 100-0 km/h, threshold, 0.2 s pressure rise | 37.1 m | ~34 m from full pressure; magazines 33-37 m (ABS) |
| 100-0 km/h, locked (no ABS) | 50.1 m | longer than threshold, as expected |
| lock order | front 0.70 pedal, rear 0.90 | fronts first = stable |
| skidpad max (60 m) | 0.98 g | 0.95-1.1 g for summer-tyre performance cars |
| understeer gradient | 1.57 deg/g (commanded) | road cars understeer, ~1-3 deg/g |
| 0-100 km/h RWD / AWD / FWD | 4.74 / 4.25 / 7.24 s | ~228 W/kg RWD coupes: 4.2-4.8 s |
| 240 Hz vs 1000 Hz | 0.1 % difference | timestep independent |

## 8. Tuning decisions made from tests
- Brake bias 0.67: ideal = F_front,max / (F_front,max + F_rear,max) at full deceleration.
  0.64 locked the rears first (unstable); 0.70 under-used the rears.
- Wider rear tyres (285 vs 245) + 0.12 deg/kN front compliance: with identical tyres the car
  was almost neutral (0.13 deg/g) because cornering stiffness scales with load.

## 9. Assists and controls (Phase 3). All toggleable, all in the core
Order each physics tick: raw device input -> `rs::Controls` -> `rs::Vehicle` (ABS/TC/ESC inside).

**Controls (input side)**
- Keyboard: digital keys become ramps (steer 2.2/s in, 4.0/s back to centre; throttle 3/s up,
  6/s down; brake 5/s up, 8/s down).
- Gamepad: deadzone 0.08, response curve `y = (1-c) x + c x^3` (c = 0.5), 40 ms low-pass.
- Wheel: 1:1, no filtering, no speed scaling.
- Speed-sensitive steering (keyboard/gamepad): full input commands at most
  `delta_max(v) = L mu g / v^2 + 0.10 rad` (Ackermann angle at the grip-limited radius plus
  room for front slip angle), never below 15 % of lock. At 150 km/h: 21 % of lock.
- Countersteer assist: `delta += 0.8 * beta` (sideslip) when sliding.
- Auto gearbox: up at 95 % of redline (on throttle), down below 3200 rpm if the lower gear
  stays under 85 % of redline; 0.6 s / 0.4 s anti-hunting cool-downs; first gear when stopped.
- Auto-clutch: engagement rises with rpm above idle (centrifugal-clutch behaviour).

**Vehicle side**
- ABS: per wheel, integral control on slip, `p += h * 30 * (kappa + 0.10)`, p in [0, 1] scales
  the driver's brake pressure. Runs at the ~1 kHz sub-step rate.
- TC: engine torque cut `clamp((kappa_driven - 0.10) * 14, 0, 1)`, 30 ms filter.
  (Gain 6 left a steady-state slip of 0.19; raised to 14 -> 0.15.)
- ESC: reference yaw rate `r_ref = v delta / (L + K v^2)`, K = 0.0028 s^2/m (matches the car's
  measured 1.57 deg/g), capped at `mu g / v`. Oversteer (|r| > |r_ref| + band, or |beta| > 0.12 rad)
  -> brake the outer front wheel and cut 30 % throttle. Understeer -> brake the inner rear, cut 50 %.

**Validation (headless, `core/tests/test_assists.cpp`)**
| check | result | criterion |
|---|---|---|
| ABS 100-0 km/h full pedal (0.2 s rise) | 37.7 m, no lock > 0 s | <= threshold (37.1) + 2 m; no-ABS 50.1 m |
| ABS steer while braking from 80 km/h | 50.8 deg vs 15.6 deg without | >= 2.5x |
| TC floored launch, mean rear slip | 0.15 (no TC 2.57) | 0.05-0.18 |
| TC 0-60 km/h | 2.90 s (no TC 3.80 s) | faster than wheelspin |
| ESC, FMVSS 126 sine with dwell @80 km/h | yaw 1 s after 0 %, 1.75 s 0 %, lateral 3.92 m | <= 35 %, <= 20 %, >= 1.83 m |
| same manoeuvre, ESC off | 56 % at 1 s | fails the regulation (why ESC matters) |
| ESC in a normal 0.5 g corner | 0 s intervention | <= 0.2 s |
| keyboard floored, auto box + TC | 0-100 4.57 s, 3 upshifts, 0 downshifts | no hunting, no stall |
In Godot (`--autotest`): ABS full pedal from 100 km/h = 33.6 m (fixed 0.78 pedal: 34.4 m).

## 10. Crash damage (Phase 4). `core/src/damage.cpp`
- Energy from impulse: a body of mass m receiving impulse J loses kinetic energy `E = J^2 / (2 m)`
  (exact for a full stop against a rigid wall). Godot reports per-tick contact impulses; they are
  accumulated per crash event (same object, < 0.15 s apart) and damage is charged on the energy
  increment `dE = E(J_acc + j) - E(J_acc)`, minus a 600 N s threshold (~1.5 km/h).
- Pushing is not crashing: per-tick contact force `F = j / dt` below 3 g (`3 m g`) is ignored.
  A car pushing a wall at full throttle is < 1 g; real impacts are tens of g. Test: 10 s of 0.8 g
  pushing -> 0 kJ.
- Zones: front/rear if `|x| > 1.2 |y|` at the impact point (body frame), else left/right.
- **Two layers (2026-11-11).** Panels: crush depth `x = sqrt(2 E / k)` from ALL the energy a zone took (k = 1.0 MN/m
  front/rear, 0.35 sides); this drives dents, bumpers, lights and drag only. Structure: only the part of one crash
  event above what the crumple zone takes. With `dv = J / m` the event's speed change so far, each energy increment is
  weighted `w = clamp((dv - lo) / (hi - lo), 0, 1)`: structural band 9 -> 18 m/s, wheel band 5 -> 11 m/s. Energies
  per kg of car (kJ/t), so the thresholds are speeds. One full stop against a wall gives `v^2 / 2 - 94.5` kJ/t
  (60 km/h: 46, 80: 152, 100: 291, 130: 557).
- Engine: 0 at 150, wrecked at 600 kJ/t in the engine bay (front hits in full, other zones 25 %). Cabin: 300 kJ/t into
  one side. Wheels: 75 kJ/t (wheel band) of direct hits within 0.7 m, plus 15 % of the structural energy of the zone
  the crash lands in; from 0.95 the wheel is gone (grip x0.35 at that corner, the game throws the wheel as debris and
  the hub sparks). Totaled (report flag: race DNF, HUD; the car still limps): engine >= 0.9, cabin, three wheels gone,
  or 1200 kJ/t in total.
- Overheating and fire: severity `s = max(engine, structural / 1200)`. From 0.5 the engine steams (builds over 20 s,
  HUD "ENGINE OVERHEATING") and stays that way; only from 0.9 does it go on to burn (flames grow over 45 s). Brakes
  lose effect from damage only above s = 0.9 (240 s to failure at s = 1) and in a fire (40 s at full fire).
- Effects: engine power x(1 - 0.7 engine) with a 0.25 limp floor, drag x(1 + 0.3 mean zone), spring rate
  x(1 - 0.4 wheel), toe-out up to 1.5 deg per wheel (car pulls), tyre grip x(1 - 0.1 wheel).
- Validation (`rs_tests`, damage): wall at 30 km/h crush 0.30 m, engine 0; 65 and 80 km/h engine 0; 100 km/h engine
  0.29, front wheels 0.56; 135 km/h engine 0.98, both front wheels off, totaled. Forty 30 km/h bumps: no structural
  damage. 50 km/h T-bone: dented, drivable; 110 km/h sideways into a wall: totaled (cabin). 115 km/h wall: steam, no
  fire, brakes intact after 90 s. 50 km/h hit on the front-left wheel: 8.9 deg heading drift in 4 s hands-off.

## 11. AI street racer (Phase 4). `core/src/ai.cpp`
- Path: pure pursuit to a point `Ld = clamp(3.5 + 0.4 v, 5, 30)` m ahead on the route + lane
  offset; steer `delta = atan(2 L sin(eta) / Ld)`.
- Speed profile: `v = sqrt(a_lat / |k|)`, `a_lat = skill * 0.82 * mu g * width_factor`
  (width_factor 0.7 in a 4.6 m alley .. 1.0 on >= 8 m roads), braking pass `a = 0.85 skill mu g`,
  power-limited acceleration pass `a = min(0.8 g, P / (m v))`.
- Traffic, judged in ROUTE space (works through 90-degree junctions): a car is "ahead" if it is
  further along the route, on the road near that point, and either in our lane or where the road
  is too narrow for two cars (lanes merge: the rear car yields).
- Reaction time: perceptions are queued and used `reaction_time` later.
- Emergency braking compares stopping distances: room = `gap + v_lead^2 / (2 a_lead) - 2 m`
  (a_lead estimated from the delayed perceived speeds), needed `a = v^2 / (2 room)`; above
  `2 + 4 aggression` m/s^2 -> full brake; swerve if the road has room.
- Validation: careful follower (0.4 s, 0.6 s headway) stops 3.5 m behind a car braking from
  90 km/h; aggressive follower (0.8 s, 0.15 s headway) on a single lane hits it at 41 km/h.
- Race mode (`racing_line`, 2026-11-25): the line is followed with curvature feed-forward plus heading and cross-track feedback (Stanley-style) instead of pure
  pursuit; a slide (sideslip over 3 deg, full at 8 deg) is steered into with the throttle lifted; the corner speeds are scaled by a grip estimate
  that drops 5 % (floor 70 %) when the car slides or runs 2.5 m off the line and recovers at 0.4 % per second. Pure pursuit stays for streets and
  whenever racecraft or a neighbour moved the line. All 125 laps of 25 cars on 5 real circuits stay on the track (`reference_data_real_tracks_ai`,
  `RS_ALL_CARS=1`); before it, 4-5 of 10 did. The browser game's AI is separate (`web/src/ai.ts`) and was not changed.
- Recovery: stuck 2 s with throttle -> 1.6 s reverse. Race rule (core RaceTracker): upside down
  3 s or < 1 km/h for 10 s -> respawn 15 m back on the route, damage kept.

## MF 6.1 completion, tyre thermals, brake thermals (2026-11-07)

- **Friction vs. sliding speed** (MF 6.1 LMUV): lambda_mu* = lambda_mu (1 + LMUV V_ref/V0) / (1 + LMUV Vs/V0), Vs = |contact
  patch slip velocity|, V0 = 16.7 m/s, LMUV = 0.12, V_ref = 1.5 m/s (the sliding speed the coefficients were fitted at, so
  ordinary cornering is unchanged). Fy at 25 m/s sliding = 0.85 of the 1.5 m/s value. Locked-wheel 100-0: 51.9 m vs 35.4 m
  threshold braking.
- **Inflation pressure** (MF 6.1, Pacejka 3rd ed. Table 4.2 passenger tyre): Kx * (1 + PPX1 dpi + PPX2 dpi^2),
  mu_x * (1 + PPX3 dpi + PPX4 dpi^2), Ky: pKy1 (1 + PPY1 dpi), load scale pKy2 (1 + PPY2 dpi), mu_y * (1 + PPY3 dpi + PPY4
  dpi^2). Hot pressure from the gas law: gas temperature = 20 + 0.55 (T_core - 20); 188 kPa cold -> ~223 kPa at 85 C core
  (nominal 220).
- **Two-layer tread temperature**: surface C_s = 1.5 kJ/K (takes all sliding power), core C_c = 16 kJ/K, conduction 400 W/K,
  surface air cooling 20 + 2.5 v W/K, core relaxes to the rolling equilibrium (78 C). 10 s at 25 kW sliding from 30 C:
  surface 94 C, core 53 C. Grip window on 0.65 core + 0.35 surface around 90 C +- 25; surface over 140 C greases.
- **Brake discs**: per wheel, heated by T_brake |w| (a locked wheel heats the tyre, not the disc), cooled by hA = 5 + 2.5 v
  W/K (ducted, vented; was 5 + 1.0 v until 2026-11-11) + radiation eps sigma A (T^4 - Ta^4); cast iron 8.5 / 6 kg front /
  rear. Pad friction vs. disc temperature (sport pad): 0.86 cold, 1.0 at 300-650 C, 0.95 at 750, 0.85 at 850, 0.72 at
  950, 0.60 at 1050. Eight back-to-back ABS stops from 200 km/h with no air between: 134.6, 135.1, 135.1, 135.1, 134.9,
  134.1, 138.0, 151.0 m; front discs 300 -> 998 C. A 650 C disc coasting from 216 km/h is at 456 C after 10 s. HUD shows
  BRAKES HOT / FADING over 720 C.
- Output buffer: [184+i] disc C, [188+i] tread surface C, [192+i] pressure kPa, [196+i] pad mu.

## Fitted tyre data, suspension kinematics, aero ride height, turn slip, steering feel (2026-11-08)

- **Tyre curves from a real fit**: every car's tyres take their curve shapes (C, E, slip/cornering stiffness, load and
  camber sensitivity, aligning torque, vertical stiffness) from a fitted 245/40 R18 PAC2002 tyre (Project Chrono,
  BSD-3, `data/tires/`), converted by `tools/tir2car.mjs` (ISO -> our sign conventions; left-tyre and mirror-asymmetric
  terms zeroed; grip and stiffness scaled together per car so the peaks stay at the fitted ~10.9 deg / slip ratio
  0.15; rear stiffness x1.16 for the 285 section). Peak grip stays the per-car calibration (C7 Z51 skidpad 1.03 g).
  Open data searched (2026-11-08): no openly licensed MF 6.1/6.2 car fit exists (TNO files are copyrighted, MathWorks'
  are MathWorks-only, FSAE TTC data may not be published); turn-slip and pressure terms use Pacejka's defaults.
- **Suspension kinematics** (per axle, JSON overridable): quadratic camber curve, static toe + bump steer (rear toes in
  under bump), roll centre migrating with heave (x -1.8 front, -1.5 rear), anti-dive 25 % / anti-squat 40 % / rear
  anti-lift 15 % as link forces F = anti Fx h/L (test: braking dive -0.97 -> -0.86 deg, launch squat 0.54 -> 0.49 deg),
  digressive dampers (knee 0.13 m/s, x0.45 above).
- **Aero**: downforce x (1 + 2.0 * mean compression m), balance + 1.2 * (front - rear compression).
- **MF 6.1 turn slip**: zeta_2 (peak) and zeta_3 (stiffness) from phi = -r / V_cx; matters only at parking speeds.
- **Steering**: rack torque = sum front (Mz - Fy R tan caster) at buf[116] (force feedback; builds with load, goes light
  past the front peak). Keyboard / gamepad with no input: the wheels caster toward zero front slip angle (the
  countersteer in a slide), like a loosely held wheel. Gamepad rumble from front scrub, rear slide / wheelspin, ABS and
  impacts (dual-rumble).
- Chassis torsional flex was left out on purpose on 2026-11-08 (a road car's ~20-40 kNm/deg is >10x its suspension roll stiffness:
  < ~5 % effect, and only with one wheel on a kerb); it was added later as an optional model (`chassis_flex_enabled`, off by default, on in the game). The limited-slip differential already existed (clutch pack:
  preload + power / coast ramps).


## Tyre compounds, cooling to the air, wear from friction work (2026-11-22)

Found by the handling tests (`core/tests/test_handling.cpp`, docs/october_drafts.md): cold tyres gripped as well as warm
ones and grip-limited cornering never wore the tread. Three causes, three fixes.

- **No set running temperature.** The carcass used to relax toward a fixed rolling equilibrium of 78 C at
  (0.012 + 0.0012 v) 1/s, about 2 C/s from a cold start, whatever the energy said. It now cools through the sidewall
  toward the ambient air: ~0.32 m^2 of sidewall, ~2.5 mm of rubber (tread and sidewall compounds conduct 0.30-0.54 W/(m K)
  in patent measurements; 0.35 * 0.32 / 0.0025 ~ 45 W/K) in series with an air film of the tread's coefficient per m^2
  (area ratio 0.52). The carcass settles where rolling hysteresis (C_rr F_z v), slip work and cooling balance.
  Measured (vela_gt, air 30 C): 5 min at 90 km/h takes a 90 C tyre to 48 C and a 20 C tyre to 38 C; the cavity air
  settles ~6 C above the air after 15-20 min (~+1 psi) and then holds. Tire Rack's street test saw ~+1 psi per 5 min
  for 20 min, then stable (about 4 psi, with town braking heating the rims): the timing matches, the rise is lower
  than that test (open point). Hard cornering (0.8 g) warms a 20 C tyre to ~60 C carcass / 64 C surface in 3 min.
  The surface <-> carcass conduction stays 400 W/K (a two-node model cannot have both the real ~1.4 mm heat
  penetration in 10 s and the real seconds-fast surface cool-down; the fast surface is kept).
- **Compounds per car** (`"compound"` in `tire_front` / `tire_rear`; explicit `temp_optimal_c`, `temp_window_c`,
  `start_temp_c`, `wear_per_mj` override it; `rs::apply_compound`):

  | compound | full grip (core/surface blend) | reset temp | wear | cars |
  |---|---|---|---|---|
  | `road` | 10-90 C (50 +- 40) | 45 C | 1 / 150 MJ | 18 road cars |
  | `semi_slick` | 50-100 C (75 +- 25) | 70 C | 1 / 90 MJ | Kestrel GT, Falcorn 9R, Falcorn 9R RS, Kronos Fulmine |
  | `slick` | 75-105 C (90 +- 15) | 85 C | 1 / 52.5 MJ | Tornado GT3, Strix GT7 |

  Road: tyre makers (Continental, Uniroyal, Pirelli) put the point where summer compounds start to harden at ~7 C.
  Slick: Pirelli describes race compounds as covering "a working range of about 30 degrees each". Semi-slick sits
  between; no manufacturer window was found (Michelin's Cup 2 track guides were not readable), so its numbers are the
  least certain. Below the window grip falls to 0.85 (grip factor) plus the rib WLF term with zones on; measured on a
  fast skidpad: a 20 C slick 0.754 g vs 0.989 g warm, a 15 C road tyre 1.016 g vs 1.011 g at 50 C.
- **Wear from all friction work** (Reye 1860; Schallamach & Turner): wear += P_slip dt * wear_per_mj / 1e6, no
  threshold. Before, only slides above 18 kW per tyre wore the tread. Calibration: the most-loaded tyre does ~0.15 MJ/km
  of friction work on AI laps (12 and 40 m corners, ~110 km/h average), so the rates give ~1000 / 600 / 350 km of
  race-pace driving to a worn tread (road / semi-slick / slick). The slick figure follows GT3 practice (sets built for
  double stints; Spa 24 h allows 30 dry sets for a weekend of several thousand km); the road and semi-slick track lives
  are enthusiast-reported, not manufacturer data. Street driving does far less friction work, so road tyres last
  tens of thousands of km there.
- **Tyre zones on by default.** `Vehicle::tire_zones_enabled` (3-rib temperatures, WLF rib grip, thermal stiffness)
  was off in the core and on in the web bridge, so the tests and any other host (the Unreal 5.8 plugin) ran a simpler
  tyre than the game. It is now on by default: the same model everywhere. Effects on the reference car (vela_gt):
  skidpad 1.002 g (C7 Z51: 1.03-1.11 g), 60-0 32.4 m in the web core (31.7-32.6 m). The Kestrel's aero gain in the
  200 m corner is +0.038 g with the full model (13 % of its weight in downforce at 49 m/s, less load sensitivity and
  the drag its rear tyres carry); the character test now asks for +0.03 g.
- Brakes per car (disc material and size) are not done: no verified specific heat or fade curve for carbon-ceramic
  (C/SiC) discs was found; only their mass (about half of cast iron, SGL Carbon).

## Wet roads, racing line, incandescence (2026-11-22)

- **Wet grip** (`wet_grip_factor`, core/src/pinnacle.cpp). Before this, rain reached no physics at all (the weather
  grip multipliers were unused and the bridge passed no water). Now `Vehicle::road_water_mm` (set by the host from the
  weather: rain 1 mm, a damp winter road ~0.1 mm; puddles per contact add on top) scales friction by
  (1) a damp-film term: no loss until a critical depth that falls with speed (Beautru, IFSTTAR: 0.34 / 0.31 / 0.15 mm
  at 20 / 40 / 60 km/h), then ~5 % for a treaded tyre; (2) drainage: 1 / (1 + (v / v_d)^2), v_d from the Horne onset
  speed (pressure, tread, film) x (tread / 7.5 mm)^0.2 / (1 + 0.5 ln(h / 1 mm)) (depth matters at >= 96 km/h, not below
  50: Veith). Fitted to Continental's wet ABS stops from 80 km/h: the Vela GT stops in 27.6 / 31.9 / 37.3 m with new /
  3 mm / 1.6 mm tread (Continental 25.8 / 31.0 / 36.2 m). Test `wet_braking`.
  Open point: in the DRY, 1.6 mm tread stops 17 % longer (the flat wear grip penalty, 1 - 0.15 wear^2); real worn road
  tyres brake as well or better in the dry.
- **Racing line** (`rs::RacingLine`, core/src/racing_line.cpp): minimum-curvature line within the road minus 1.3 m,
  projected Gauss-Seidel / SOR on the lateral offsets; AI racers follow it and take corner speeds from its curvature
  (12.5 % quicker flying lap on a 10 m wide block). Overtaking: a pass needs room for a whole car, the passer only
  outruns the following limit once a car width clear, a started pass is carried through, and every AI leaves a car
  width to a car alongside. Rivals use it unless rivals.json says otherwise. Test `racing_line`. Not done: outbraking
  moves into a corner.
- **Incandescence** (`rs::incandescence`): Planck x emissivity (oxidised iron 0.8) over the CIE 1931 functions
  (Wyman-Sloan-Shirley fit), 683 lm/W, linear sRGB nits: 0.006 nit at 525 C (Draper point), 1.1 nit at 700 C, 71 nit at
  900 C. For brake discs in the web and Unreal; the web visual is on branch review/brake-glow-physical, waiting for a
  look review.
