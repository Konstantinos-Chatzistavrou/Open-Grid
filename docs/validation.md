# Handling validation

How we check that Open Grid's cars behave like real cars, what passes today, and what nobody has checked yet. Every
number below is produced by a test that runs on every push (`ctest` in CI); if a change to the physics moves a car out
of its range, the build fails.

Last run: 2026-11-23, core at `main`.

## 1. Against a real car

The Vela GT is a made-up front-engine rear-drive coupe built to the same recipe as a **Chevrolet Corvette C7 Stingray
Z51** (2014): 341 kW vs 343 kW, 1450 kg vs ~1496 kg, the same tyre sizes at the front. We drive it through the tests
the car magazines use and compare with their published figures.

| test | Corvette C7 Z51 (published) | Vela GT (Open Grid) | pass range | result |
|---|---|---|---|---|
| 0-60 mph, 1 ft rollout | 3.8 s (GM), 3.9 s (MotorTrend) | **3.95 s** | 3.6-4.1 s | pass |
| 60-0 mph, full brake, ABS | 31.7 m (MotorTrend), 32.6 m (GM) | **32.5 m** | 30.5-33.5 m | pass |
| skidpad, 300 ft circle | 1.03 g (GM), 1.11 g (MotorTrend) | **1.00 g** | 1.00-1.10 g | pass, at the low end |
| top speed | ~290 km/h | **291 km/h** | 275-305 km/h | pass |

Sources for the real car: [Motor Authority](https://www.motorauthority.com/news/1084923_2014-chevy-corvette-stingray-z51-0-60-in-3-8-seconds),
[Carscoops](https://carscoops.com/?p=141544), [GTspirit](https://gtspirit.com/?p=72172),
[AutoGuide track test](https://www.autoguide.com/manufacturer/chevrolet/2014-chevrolet-corvette-stingray-z51-track-test-3943.html).

**Method** (`core/tests/test_reference.cpp`): flat dry asphalt, 15 °C, sea level, a scripted driver. 0-60 mph is
timed the US-magazine way, from 1 ft of rollout, with a manual gearbox and a human-speed shift (0.35 s) and a launch
that feeds the clutch against tyre slip. 60-0 mph is a full brake pedal with ABS from a settled car. The skidpad is
steady-state cornering on a 300 ft (91.4 m) diameter circle, raising speed until the car can no longer hold the line.
Top speed is the terminal speed in top gear.

## 2. Cars against each other

Different cars on the same physics must keep their real-world character. The order is asserted, not just printed
(`core/tests/test_characters.cpp`):

| car | 0-100 km/h | 0-200 km/h | 60-0 mph | skidpad | fast corner (R 200 m) | top speed | step steer (90 % yaw) |
|---|---|---|---|---|---|---|---|
| Vela GT (road GT) | 4.10 s | 13.00 s | 32.5 m | 1.00 g | 1.00 g | 291 km/h | 0.129 s |
| Kestrel GT (light, high downforce, semi-slicks) | 4.03 s | 12.30 s | 28.8 m | 1.16 g | 1.20 g | 273 km/h | 0.121 s |
| Harrier GT (twin-turbo, long gears) | 3.75 s | 10.63 s | 29.5 m | 1.03 g | 1.02 g | 305 km/h | 0.125 s |

Asserted: the Harrier is quickest to 200 km/h and fastest flat out; the Kestrel stops shortest, has the most grip,
turns in quickest, gains grip with speed (aero) and has the lowest top speed (wing drag).

## 3. Lower-level checks

About 70 more test cases in `core/tests/` check the parts on their own, for example:

- **Tyres**: Magic Formula signs and symmetry, lateral force peaking at 6-12° slip angle, combined slip (braking
  while cornering takes lateral grip away), load sensitivity (less friction per newton at higher load), camber
  thrust, pneumatic trail collapsing at large slip, rolling radius under load, relaxation length growing with load,
  tyre heating and its effect on grip, over-inflation losing grip. The coefficients come from Project Chrono's
  PAC2002 data for a real 245/40 R18 tyre (`data/tires/`), with the peak friction raised 5-6 % to match summer
  tyres (see `docs/handling_reference.md`).
- **Suspension**: double-wishbone kinematics (camber gain, bump steer, roll centre migration) against hardpoints.
- **Drivetrain**: synchroniser timing (rush a shift and you miss the gear; worn synchros are slower), stalling when
  you stop in gear, a limited-slip diff out-accelerating an open one on split grip.
- **Assists**: ABS stops shorter than locked wheels, traction control launches quicker than wheelspin and prevents a
  burnout, and stability control passes the US regulation's **sine with dwell** test (FMVSS 126 / NHTSA TP-126: yaw
  rate ratios 1.0 s and 1.75 s after the steer, lateral displacement) while staying quiet in a normal 0.5 g corner.
- **The web build**: `web/tools/check_core.mjs` runs the same 60-0 mph test through the WebAssembly build the
  browser uses, and `packages/vehicle-physics` runs its own checks plus a full bot race on every push.

## 4. Not validated yet

Honest list. These need data we do not have yet, or human drivers:

- **Feel**: steering weight and force feedback, how the rear lets go on throttle, how catchable a slide is, kerbs.
  Numbers cannot test this; drivers on wheels can. See the [testing program](testing_program.md).
- **Transient handling against real data**: step steer (ISO 7401) is only compared between our own cars, the sine
  with dwell only against the regulation's pass marks, and there is no lane change (ISO 3888-2) yet. None of them is
  compared with a measured real car.
- **Tyres at the tyre level**: our Magic Formula has not yet been plotted against an independent PAC2002
  implementation (Project Chrono's) with the same `.tir` file.
- **Wet roads, aquaplaning, tyre wear rates, fuel use, damage**: modelled and tested for direction (wet grips less,
  worn tyres grip less), not yet against measured numbers.
- **Only one real reference car.** A second, different car (front-drive hatchback or a heavy SUV) would show whether
  the model generalises or was tuned to one car.

## Reproduce it

```sh
cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build -j
core/build/rs_tests reference      # section 1
core/build/rs_tests characters     # section 2
ctest --test-dir core/build        # everything
```

Found something that does not match a real car you know? Open a
[handling feedback issue](https://github.com/Konstantinos-Chatzistavrou/Open-Grid/issues/new?template=handling_feedback.yml).
