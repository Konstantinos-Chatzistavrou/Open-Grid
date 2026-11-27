# Your own tyre data -> a Magic Formula tyre file

`rs_tirfit` fits the coefficients of a Magic Formula tyre property file (`.tir`, MF 5.2 / 6.1 / 6.2) to measured tyre curves. The model it fits is `rs::mf62`, the evaluator that is checked against MFeval in CI
(`docs/mf62.md`), so a fitted tyre is exactly the tyre the tests and the game evaluate.

**Status, read first.** The fitter has been checked on SYNTHETIC data only: curves generated from known tyres, fitted from a different tyre, judged on loads and slips it never saw (`tirfit_roundtrip`,
`tirfit_other_tyres`). No measured tyre data is in the repository, so it has not been shown to work on real measurements. A fit is only as good as the data, and the report below tells you where it is not.

## 1. The data

A table (comma, semicolon or tab separated; `#` comments), one row per measured point. Forces in N, moments in N m, **signs as in the tyre file** (the convention MFeval and `rs::mf62` use: a positive slip angle
on a left tyre gives a negative Fy). If your angles are SAE-signed (positive slip angle, positive Fy) pass `--angle-sign -1`.

| column | meaning |
|---|---|
| `fz` | vertical load, N, positive |
| `kappa` | longitudinal slip ratio |
| `alpha` (rad) or `alpha_deg` / `alpha [deg]` | slip angle |
| `gamma` (rad) or `gamma_deg` | camber (inclination) |
| `vx`, `pressure` (Pa, or `pressure_kpa`, `p [bar]`, `p [psi]`) | optional |
| `fx`, `fy`, `mz` | the measured channels; leave a cell empty if a row has no value for it |

Header names are case-insensitive and a unit in brackets is honoured (`SA [deg]`, `P [kPa]`, `Vx [km/h]`); a unit it does not know is an error, not a guess. Aliases: `sl`, `sa`, `ia`, `camber`, `load`.

What the data must contain for each part of the fit (the report says which parts it could not fit):

| stage | rows needed | fits |
|---|---|---|
| `fx0` | `fx` with `alpha` ~ 0 (sweep `kappa` through and past the peak, at 3 or more loads) | PCX1, PDX*, PEX*, PKX*, PHX*, PVX* |
| `fy0` | `fy` with `kappa` ~ 0 (sweep `alpha` through and past the peak, 3 or more loads; 2 or more cambers for the camber terms) | PCY1, PDY*, PEY*, PKY*, PHY*, PVY* |
| `mz0` | `mz` with `kappa` ~ 0 | QBZ*, QCZ1, QDZ*, QEZ*, QHZ* |
| `fx`, `fy` | rows with both `kappa` and `alpha` non-zero | the combined-slip weighting RBX*, RCX1, REX*, RHX1 / RBY*, RCY1, REY*, RHY*, RVY* |

## 2. Run it

```bash
cmake --build core/build --target rs_tirfit_cli              # builds core/build/rs_tirfit
core/build/rs_tirfit my_tyre.csv --template data/tires/audi_245_40R18_pac2002.tir --out my_tyre.tir \
    --set UNLOADED_RADIUS=0.31 --set WIDTH=0.225 --set ASPECT_RATIO=0.45 --set RIM_RADIUS=0.2286 \
    --set NOMPRES=220000 --set INFLPRES=220000 --set FNOMIN=4000 --report my_tyre_fit.json --name "my tyre, test rig X" \
    --notice data/tires/LICENSE-projectchrono.txt
```

`--template` supplies the geometry, the nominal load and every coefficient the data cannot determine: give the real size with `--set` (anything `rs::mf62` reads: `UNLOADED_RADIUS`, `WIDTH`, `ASPECT_RATIO`, `RIM_RADIUS`,
`NOMPRES`, `INFLPRES`, `VERTICAL_STIFFNESS`, `FNOMIN`, ...). `FNOMIN` defaults to the median measured load. Try the pipeline without data of your own:

```bash
core/build/rs_tirfit --make-demo data/tires/audi_245_40R18_pac2002.tir demo.csv 0.01     # SYNTHETIC rows, 1 % noise
```

## 3. Reading the report

```
stage  channel   rows  coeffs  rms error            max error     iterations
fx0    Fx         255     15       49.77 ( 0.66 % of peak)      156.4      7
         barely determined by this data: PDX3
fy0    Fy         765     18       60.86 ( 0.85 % of peak)        193    150  (iteration limit)
```

- **rms error / % of peak**: how far the fitted curve is from your points, per stage. On the noisy synthetic demo it is 0.6 to 1.5 % of the peak (the noise itself is 1 %).
- **barely determined by this data**: the data hardly changes the fit when that coefficient moves (for example a camber term when camber barely varies): its value is the starting guess, not a result.
- **on a bound**: the optimiser pushed a coefficient to the edge of its physical range: the data is odd, the signs are wrong, or the template is far from the tyre.
- **iteration limit**: not converged; the fit is usable but run it again with cleaner data or a closer template.
- **notes**: what the data does not cover. Camber, pressure and aligning-moment coefficients that the data cannot determine are NOT fitted and keep the template's values; the output file says so in its header.

The file's limits (slip, camber, load) are widened to span your data, because the fit runs with the limits on exactly as the tyre is used. The template's scaling factors (`LFZO`, `LMUX`, `LKY`, ... : the Chrono
files use them, `LFZO` between 0.37 and 1.76) are reset to 1, so `FNOMIN` is the nominal load you gave and the report lists what was reset.

## 4. From the tyre file to a car

```bash
node tools/new_car.mjs --name "My Car" --layout rwd --mass 1300 --wheelbase 2.6 --track 1.55 --cg-height 0.5 --weight-front 0.52 \
    --power-kw 250 --redline 7500 --tyre my_tyre.tir --out data/cars
```

This writes `data/cars/my_car.json` (schema `car/1`) and `my_car.visual.json`, prints the catalog entry, and runs `rs_carcheck` on the car. Optional: `--tyre-rear`, `--id`, `--template <car id>`,
`--visual-from`, `--compound road|semi_slick|slick`, `--cda`, `--cla`, `--top-speed-kmh`, `--no-check`.

**What is yours, what is scaled.** Mass, wheelbase, track, CG height, front weight share, peak power, redline and the tyres (the file's own grip, stiffness, load and camber sensitivity, aligning torque, size) are taken as given.
Everything else is the numbers of a shipped car of the same layout (default `vela_gt` rwd, `mistra_200t` fwd, `kaze_ryujin` awd), SCALED: inertias with mass and length, spring / damper / anti-roll rates with the corner mass
(same ride frequency as the template), suspension hardpoints with track and wheel radius, the torque-curve shape (power and rpm), gear ratios (final drive chosen so top gear reaches the redline just above the speed the power and drag allow), brakes,
aero, clutch. They make a plausible car of that size, not data about yours: replace them where you have real numbers. The visual reuses the template's 3D model, so its wheels line up only if wheelbase and track are close
(`docs/adding_a_car.md` for a real model).

**The check.** `rs_carcheck my_car.json` (built with `cmake --build core/build --target rs_carcheck`) measures 0-100 km/h, 60-0 mph and a 300 ft skidpad and compares them with limits the car's own data implies:

| check | FAIL when | WARN when |
|---|---|---|
| finite results, deterministic | the car cannot launch / stop / hold a circle, or two identical runs differ | |
| 0-100 against the engine | faster than kinetic energy / peak power allows | more than 6 x slower than that |
| braking against the tyres | more than 1.15 x the tyres' peak grip | less than 40 % of it |
| cornering against the tyres | more than 1.15 x the tyres' peak grip | less than 40 % of it |
| tyre load | | static load per tyre below 0.4 x or above 2.5 x the file's nominal load |

These are **self-consistency checks**. They catch impossible or broken cars (a typo that makes 3 g, a tyre file for a truck, a gearbox that cannot launch); the test `car_pipeline` feeds them deliberately broken cars and
checks that each is caught. They do NOT show that the car matches its real counterpart: that needs measured data. `node tools/validate_mod.mjs --dir <folder>` is the separate, existing limit check for mods.

## 5. How good is the fit, on the evidence we have

Synthetic only. Truth = a Chrono tyre, fit started from another tyre of a different size class with only its geometry copied, errors on held-out loads (0.6 to 1.4 x nominal) and cambers, in rms % of the peak force:

| | Fx | Fy | Mz | combined Fx / Fy | peak force | initial cornering stiffness |
|---|---|---|---|---|---|---|
| template alone, no fit | 46 | 31 | 27 | 41 / 41 | 33 to 47 | 69 |
| fit, noise-free (Audi, started from the truck tyre) | 0.0 | 0.6 | 1.0 | 0.1 / 0.7 | 0.5 | 0.1 |
| fit, 1 % noise | 0.1 | 0.6 | 1.0 | 0.2 / 0.8 | 0.4 | 0.4 |
| worst of four tyre pairs, noise-free | 0.9 | 0.6 | 1.0 | 0.7 / 1.0 | 1.7 | 3.5 |

What these numbers do not say:

- **The coefficients are not unique.** Many coefficient sets give nearly the same curves; the fit matches the curves (0.6 to 1 % of the peak on exact synthetic data), not necessarily the coefficients that generated them. Never read a
  fitted coefficient as a physical property.
- **Real data is harder** than a model's own output: it has errors that no Magic Formula reproduces, and rig-to-rig differences. Expect larger errors and check the plots of your own data against the fitted curve.
- **Not fitted:** overturning moment Mx, rolling resistance My, turn slip, the aligning moment of combined slip, and anything a stage had no data for.
- A first version started the optimiser from the template only and failed on a truck tyre fitted from a car tyre (16 % of peak error on its own training data); the data-driven first guess for peak grip and slope per load fixed it. That pair is
  now part of the test.

## 6. Licences

`rs_tirfit` is Apache-2.0. A fitted file starts from a template: coefficients the data did not determine are the template's numbers, so the template's licence still applies to them. The Chrono tyres in `data/tires/` are BSD-3 and
their `.tir` files carry no notice themselves (it is in `data/tires/LICENSE-projectchrono.txt`), so for a fit started from one of them pass `--notice data/tires/LICENSE-projectchrono.txt`: the text is written into the file as comments
(the Tyre Lab page does this for its built-in templates). Your measurements are yours; check the licence of any dataset you did not measure yourself before you publish a tyre fitted from it.
