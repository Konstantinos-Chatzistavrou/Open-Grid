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

### Second reference car: front-drive hot hatch

To test whether the physics core generalises beyond one RWD coupe without retuning `core/`, the **Mistra 200T**
(`data/cars/mistra_200t.json`, `core/tests/test_reference_fwd.cpp`) is built to the published recipe of a
**2015–2017 Volkswagen Golf GTI Mk7 Performance Pack (6-speed manual)**: transverse 2.0L turbo I4 (169 kW / 350 Nm
flat 1,500–4,500 rpm), 1,385 kg, 61/39 front-heavy weight distribution, FWD with helical/VAQ front LSD, MacPherson
strut front suspension, and square 225/40 R18 summer tyres.

| test | VW Golf GTI Mk7 PP (published) | Mistra 200T (Open Grid) | pass range | result |
|---|---|---|---|---|
| 0-60 mph, 1 ft rollout | 5.6-5.9 s (C&D), 5.9 s (Edmunds), 5.8-6.1 s (MT) | **5.84 s** | 5.40-6.40 s | pass |
| 0-100 km/h, 1 ft rollout | 6.4 s (VW factory), ~6.2-6.5 s (magazines) | **6.14 s** | 5.70-6.80 s | pass |
| 60-0 mph, full brake, ABS | 32.9 m / 108 ft (Edmunds), 34.1 m / 112 ft (MT) | **34.8 m** | 31.5-36.0 m | pass |
| skidpad, 300 ft circle | 0.92-0.96 g (C&D), 0.94 g (Edmunds, MT) | **0.930 g** | 0.90-0.98 g | pass |
| top speed | ~250 km/h (155 mph) | **246 km/h** | 240-260 km/h | pass |
| steady-state balance @ 0.74 g | positive FWD understeer | **K_us = +2.83 deg/g** (α_f 3.19° > α_r 2.18°) | K_us > 0.5, α_f > α_r | pass |

Sources for the real car: [VW US Press Release](https://media.vw.com/releases/346),
[2015 VW Golf GTI Brochure](https://www.auto-brochures.com/makes/Volkswagen/Golf/VW_US%20Golf_GTI_2015.pdf),
[Edmunds Long-Term Track Test](https://www.edmunds.com/volkswagen/golf-gti/2015/long-term-road-test/),
[UltimateSpecs 230 PS PP](https://www.ultimatespecs.com/car-specs/Volkswagen/65179/Volkswagen-Golf-7-GTI-Performance-20-TSI-230HP-.html),
[ZePerfs](https://zeperfs.com/en/fiche4572-vw-golf-vii-gti-performance.htm).

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
- **Magic Formula cross-check vs VDSim** (`tools/tyre/crosscheck_vdsim.py`, `core/tools/mf_dump.cpp`,
  `docs/tyre_crosscheck_vdsim.csv`): Open Grid's raw `rs::magic_formula` evaluated directly on
  `data/tires/audi_245_40R18_pac2002.tir` (no per-car mu boost) against live compiled
  [VDSim](https://github.com/Onlyti/VDSim) (`core/src/magic_formula_tire.cpp`, commit `0534695d`, Apache-2.0) at
  2, 4 and 6 kN and 0° / -2° camber:
  - **Symmetrized** (17 left-tyre-only ply-steer/conicity/asymmetry offsets zeroed in both sides to match
    `tools/tir2car.mjs`): **`Fx`** matches to **0.000% RMSE** at 0° camber (≤ 0.011 N) and **0.001–0.004% RMSE** at
    -2° camber (friction-ellipse trim from camber thrust); **`Fy`** matches to **0.000% RMSE** (≤ 0.010 N) across all
    6 cases; **`Mz`** matches to **0.000% RMSE** (≤ 0.001 N·m) across all 6 cases.
  - **Real converter bug caught & fixed by the cross-check**: `tools/tir2car.mjs` previously kept `+QEZ4` (breaking
    L/R steering-torque symmetry at 0° camber by 7.58 N·m at 4 kN) and negated `QEZ5` even though `gamma * atan(...)`
    is even under `(alpha, gamma) -> (-alpha, -gamma)`. Zeroing `qEz4` and keeping `+QEZ5` collapsed symmetrized
    `Mz` RMSE from 7.63% to 0.000%.
  - **Fixed in every car (2026-11-23)**: all 24 shipped cars were generated before the fix and carried the old
    `qEz4`/`qEz5`; they now use the corrected values (handling numbers did not move, only the self-aligning moment, so
    steering torque is now the same left and right). `core/tests/test_tire_config.cpp` (`tire_symmetry`) checks every
    car in `data/cars/` for left/right symmetry of `Fy` and `Mz`, and fails (up to 20 N·m on the old files) if a car
    is generated with the old converter again.
  - **Raw left-tyre `.tir` deltas** (intentional mirror-symmetry zeroing so left and right turns match with a single
    tyre block): `Fx` 0.61–1.04% RMSE (`PHX1/2`, `PVX1/2`), `Fy` 2.74–3.20% RMSE (`PVY1/2`, `PHY1/2`, `PEY3`),
    `Mz` 9.10–18.29% RMSE (`QHZ1/2`, `QDZ6/7`, `QBZ4`, `QDZ3`, `QEZ4`).
- **ADAC & EU EPREL (UNECE R117) dry/wet braking & aquaplaning** (`core/tests/test_adac_braking.cpp`, Vela GT ABS):
  - **Dry 100-0 km/h**: premium summer **36.63 m** vs budget (0.88× mu) **41.83 m** (+5.20 m / 1.142×), matching
    [ADAC 2025 225/40 R18](https://www.adac.de/rund-ums-fahrzeug/ausstattung-technik-zubehoer/reifen/reifentest/sommerreifen/225-40-r18)
    (35.2 m best vs 39.5 m worst, +4.3 m / 1.122×) and
    [ADAC 2024 215/55 R17](https://www.adac.de/rund-ums-fahrzeug/ausstattung-technik-zubehoer/reifen/reifentest/sommerreifen/215-55-r17) (35.4 m best).
  - **Wet 80-0 km/h (1.0 mm UNECE R117 water film)** across
    [Regulation (EU) 2020/740](https://eur-lex.europa.eu/eli/reg/2020/740/oj) wet-grip classes: Class A **27.65 m**
    (MFDD 80-20: 9.39 m/s²), Class C **31.64 m** (8.15 m/s²), Class E **39.81 m** (6.40 m/s²) — Class E vs A spread
    **+12.16 m (1.440×)** vs EU 2020/740 (~1.42× / up to ~18 m) and ADAC 2025 (28.4 m vs 45.1 m).
  - **Wet vs dry 100-0 km/h ratio (1.0 mm film)**: **43.19 m / 36.63 m = 1.179×** (new 7.5 mm tread), rising to
    **53.20 m (1.452×)** at 3.0 mm tread and **66.92 m (1.827×)** at 1.6 mm legal minimum.
  - **7 mm deep-water aquaplaning**: straight-line float speed (`wet_grip_factor <= 0.33`) **79.7 km/h** new
    (ADAC 2024: 78.5 km/h; ADAC 2025: 83.7 km/h), dropping to **47.9 km/h** at 3.0 mm and **37.7 km/h** at 1.6 mm.

## 4. Not validated yet

Honest list. These need data we do not have yet, or human drivers:

- **Feel**: steering weight and force feedback, how the rear lets go on throttle, how catchable a slide is, kerbs.
  Numbers cannot test this; drivers on wheels can. See the [testing program](testing_program.md).
- **Transient handling against real data**: step steer (ISO 7401) is only compared between our own cars, the sine
  with dwell only against the regulation's pass marks, and there is no lane change (ISO 3888-2) yet. None of them is
  compared with a measured real car.
- **Full-vehicle comparison against an independent simulator (Layer 2)**: tyres are now cross-checked against VDSim,
  but full-car manoeuvres have not yet been run side-by-side in Project Chrono.
- **Tyre wear rates, fuel consumption rates, crash damage**: modelled and tested for direction (worn tyres grip less,
  heavy hits deform parts), not yet against measured long-stint wear or fuel numbers.

## Reproduce it

```sh
cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build -j
core/build/rs_tests reference      # section 1 (RWD Corvette-class Vela GT)
core/build/rs_tests reference_fwd  # section 1 (FWD Golf GTI-class Mistra 200T)
core/build/rs_tests characters     # section 2
core/build/rs_tests adac_braking   # section 3 (ADAC / UNECE R117 dry/wet braking)
ctest --test-dir core/build        # everything
python3 tools/tyre/crosscheck_vdsim.py --tir data/tires/audi_245_40R18_pac2002.tir --mf-dump core/build/mf_dump
```

Found something that does not match a real car you know? Open a
[handling feedback issue](https://github.com/Konstantinos-Chatzistavrou/Open-Grid/issues/new?template=handling_feedback.yml).
