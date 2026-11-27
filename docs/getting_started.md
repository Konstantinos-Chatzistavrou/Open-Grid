# From tyre data to a driving, checked car

What you get: a tyre file fitted to your data, a car built around it, sanity checks on that car, and the car driving in the browser game. What you do not get: a car that matches a real one. Three of the numbers below come from
measured data you supply; the rest of the car is scaled from a shipped car and says so in its own `notes`.

Everything here is a command-line tool in this repository (Apache-2.0). Needs: a C++20 compiler, CMake, Node 18+; step 5 also needs the web dependencies (`cd web && npm ci`).

## 1. Build the tools (about 25 s)

```bash
cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release
cmake --build core/build --target rs_tirfit_cli rs_carcheck rs_conformance -j2
```

## 2. Tyre data -> `.tir` (`rs_tirfit`, about 4 s)

Put your measured points in a table (`fz, kappa, alpha, gamma, fx, fy, mz`, units in the header: `docs/own_tyre_data.md` section 1). To try the pipeline first, make SYNTHETIC rows from a known tyre:

```bash
core/build/rs_tirfit --make-demo data/tires/audi_245_40R18_pac2002.tir tyre_data.csv 0.01
core/build/rs_tirfit tyre_data.csv --template data/tires/hmmwv_pac2002.tir --out my_tyre.tir --report fit.json \
    --set UNLOADED_RADIUS=0.344 --set WIDTH=0.245 --set ASPECT_RATIO=0.4 --set RIM_RADIUS=0.2286 \
    --set NOMPRES=220000 --set INFLPRES=220000 --set FNOMIN=4850 --name "my tyre" --notice data/tires/LICENSE-projectchrono.txt
```

`--notice` writes the template's licence text into the file: the Chrono tyres are BSD-3 and their `.tir` files carry no notice themselves. **No install at all:** the same fit runs in the browser at `/lab/` of the game's web build
(`web/public/lab/`, the solver compiled to WebAssembly; `?demo=1&autofit=1` opens it with synthetic data already fitted).

Read the report: rms error per stage, coefficients on a bound, coefficients the data barely determines, and what the data did not cover (those coefficients keep the template's values). Details and limits: `docs/own_tyre_data.md`.

## 3. Car (`tools/new_car.mjs`, 0.1 s)

```bash
node tools/new_car.mjs --name "My Hatch" --id my_hatch --layout fwd --mass 1200 --wheelbase 2.6 --track 1.52 --cg-height 0.5 \
    --weight-front 0.6 --power-kw 120 --redline 6500 --tyre my_tyre.tir
```

Writes `data/cars/my_hatch.json` and `.visual.json`, prints the catalog entry, and runs `rs_carcheck`. The numbers you give, and the tyre, are the car's; everything else is a shipped car of the same layout scaled to your size
(`docs/own_tyre_data.md` section 4 lists what). A front-drive template has no 3D model, so the Vela GT's is the placeholder.

## 4. Check it (1 s)

`rs_carcheck` ran in step 3: 0-100 km/h, 60-0 mph and a skidpad, held against limits the car's own data implies (engine energy, tyre grip, tyre load rating, determinism). A tyre file for the wrong class of car, brakes or a
gearbox that cannot work, and a typo that gives 3 g are caught; these are self-consistency checks, not accuracy. For the fuller set (static weights, coast-down against drag and rolling resistance, circles left and right, step-size
convergence): `mkdir -p logs && core/build/rs_conformance vehicle data/cars/my_hatch.json logs && node conformance/run.mjs vehicle --spec logs/spec.json --logs logs`.

## 5. Drive it in the browser game (about 30 s headless)

Add the printed entry to the `"cars"` array of `data/cars/catalog.json`, then:

```bash
cd web && npm run dev            # http://127.0.0.1:5173/
# open  http://127.0.0.1:5173/?menu=0&car=my_hatch   (a dev-server URL owns every car, so no level entry is needed)
# or headless:  HEADLESS=1 node tools/drive.mjs "http://127.0.0.1:5173/?car=my_hatch" /tmp/drive straight
```

The car in the browser is the same core compiled to WebAssembly. A real model instead of the placeholder: `docs/adding_a_car.md`. Delete your catalog entry again if you do not want the car in the shipped game.

## 6. Check your own simulation (not just ours)

`conformance/` judges FILES, so a simulation in any language can be checked against MFeval (tyre) and against the physics its own spec implies (vehicle): `conformance/README.md`, `conformance/SPEC.md`.

## What was measured (2026-11-27, the 8 GB laptop, `-j2`)

| step | time |
|---|---|
| 1. clean build of `rs_core` + the three tools | 24 s |
| 2. fit 1,128 synthetic rows (5 stages) | 4.1 s |
| 3. car from numbers + tyre | 0.1 s |
| 4. `rs_carcheck` (0-100, braking, skidpad) | 1.0 s |
| 5. dev server start + headless drive of the new car: 0 to 95 km/h in 7 s, then braked to a stop | 28 s in total |

About 1 minute of machine time from a clean build to the generated car driving in the game. This is **not** a measure of how long it takes a person. Not included: installing the compiler, Node and `npm ci`; getting real tyre data into the table
(the real cost); knowing your car's numbers. Nobody but the author has followed this guide yet, so the claim "an afternoon" is a hope about a first-time reader, not a result.
The walkthrough used synthetic data (the pipeline cannot be shown on measured tyre data: none is in the repository).

## What you can rely on

- **Formats.** The car file is schema `car/1` (`data/schema/car.schema.json`), the tyre file is the standard `.tir` (MF 5.2 / 6.1 / 6.2), the fit table, the conformance interface (v0.1) and the command-line flags above are documented here and in `SPEC.md`.
  There is no published promise yet that they will not change; the proposal is: a breaking change to the car file gets a new schema id (`car/2`) and the old one keeps loading.
- **Not stable.** The C++ headers in `core/include/rs/` (pre-1.0, they change with the game), the WebAssembly bridge, and the thresholds of `rs_carcheck` (they may be tuned; the documented limits are the contract).
- **Known weak points.** The fitter has only seen synthetic data. The car generator's scaled numbers are plausible, not measured. The conformance suite has only been run on this repository's own core. The vehicle checks are self-consistency.
