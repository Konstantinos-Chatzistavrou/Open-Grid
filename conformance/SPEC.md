# Conformance interface (v0.1)

Two interfaces, both plain files, so a simulation in any language can implement them. `run.mjs` (Node 18+, no dependencies) judges the files and knows nothing else about your code.

## 1. Tyre: your Magic Formula equals MFeval's

**You are given** `tyre/manifest.json`: a list of tyre property files (`.tir`, Pacejka MF 5.2 / 6.1 / 6.2: FITTYP 21, 6, 61, 62; a file with `PROPERTY_FILE_FORMAT = 'PAC2002'` and no FITTYP is the 5.2 family, FITTYP 21), one case list and, per tyre, the reference output.
**You write** one CSV per tyre, named `<tag>.csv`, with one row per case in the same order.

### Case list (`cases.csv`)

`fz_rel,kappa,alpha,gamma,phit,vx_rel,p_rel,usemode`, 393 rows. The operating point of a row is

| column | meaning |
|---|---|
| `fz_rel` | vertical load = `fz_rel` x the file's `FNOMIN` (N) |
| `kappa` | longitudinal slip ratio (-1 = locked) |
| `alpha` | slip angle, rad |
| `gamma` | inclination (camber) angle, rad |
| `phit` | turn slip, 1/m |
| `vx_rel` | forward speed = `vx_rel` x the file's `LONGVL` (m/s); negative = reverse |
| `p_rel` | inflation pressure = `p_rel` x the file's `NOMPRES` (Pa); `0` = the file's `INFLPRES` |
| `usemode` | three digits as in MFeval: hundreds 1 = apply the file's limits (`ALPMIN`, `FZMAX`, ...), 2 = skip them; tens 1 = slip angle alpha, 2 = alpha* (`tan alpha`, `sin gamma`); units 1 = no turn slip, 2 = turn slip |

The cases cover pure and combined slip, load, camber, pressure, low speed and reverse, alpha*, turn slip, limits off, no load, loads below `FZMIN` / above `FZMAX`, and slips beyond the file's limits.
**Evaluate every row independently, one operating point per call.** (MFeval's own rolling-radius loop depends on which other rows share a call; the reference was produced one row at a time.)

### Your output

A header row of column names (case-insensitive) and 393 data rows. The 30 columns, in MFeval's order:

`Fx Fy Fz Mx My Mz kappa alpha gamma phit Vx P Re rho two_a t mux muy omega Rl two_b Mzr Cx Cy Cz Kya sigmax sigmay instKya Kxk`

N, N, N, N m, N m, N m, -, rad, rad, 1/m, m/s, Pa, m, m, m, m, -, -, rad/s, m, m, N m, N/m, N/m, N/m, N/rad, m, m, (not compared), N/-.

You may write **only the columns your model has** (a model without Mx, My or relaxation lengths leaves them out): the runner compares the columns present in both files and says how many it compared (`--columns fx,fy,mz` restricts it further). `instKya` is never compared.

### Judging

A value passes when `|yours - reference| <= atol + rtol * |reference|` with `rtol = 1e-6` (`--rtol` to change it, for example for single precision), `atol = 1e-9`, except `1e-7` for `Re`, `rho`, `Rl` (MFeval iterates them) and `1` for `Cz`.
Skipped: any cell where the reference itself is NaN or Inf (MFeval returns NaN for turn slip at `Vx = 0`, for example), and `rho`, `Rl`, `Cz` on rows where the reference `Cz` is not finite (tyres with `Q_FZ2 = 0`).

### The reference

`golden` files are the output of MFeval 4.3.1 (Marco Furlan, BSD-3), unmodified, run under GNU Octave 8.4. The reference solver of this repository (`rs::mf62`) equals it on every column. What a pass means: **your tyre model returns MFeval's numbers**.
It does not mean MFeval equals the commercial TNO solver (it was matched to MF-Tyre 6.1.2.1 by its author; we have no TNO output), nor that a tyre file describes a real tyre. MFeval ran under Octave, not MATLAB.

## 2. Vehicle: your car obeys the physics its own numbers imply

**You are given** nothing to read. **You write** `spec.json` and eight logs for one vehicle, then run `run.mjs vehicle --spec spec.json --logs <dir>`.

### `spec.json`

```json
{ "name": "...", "mass_kg": 1450, "weight_front": 0.48, "wheelbase_m": 2.65, "tyre_mu_long_peak": 1.30, "tyre_mu_lat_peak": 1.31, "peak_power_kw": 341,
  "drag_area_m2": 0.643, "rolling_resistance_c0": 0.012, "rolling_resistance_c2": 0.001, "air_density_kg_m3": 1.225, "rotating_mass_factor": 1.03,
  "circle_radius_m": 50, "circle_speed_mps": 11.11, "brake_speed_mps": 27.78 }
```

`tyre_mu_*_peak` are the peak grip coefficients of YOUR tyres at the static load (the largest `F / Fz` on a slip sweep); the rolling-resistance coefficient is `c0 + c2 (v / 30 m/s)^2`, so `Crr` at speed `v`; `rotating_mass_factor` is how much the wheels' spin inertia adds to the mass when coasting (1.03 is typical).

### Logs

CSV, one header row, then rows in time order. Columns: `t` s, `x` `y` m (a ground frame, x forward at the start, y to the left), `speed` m/s, `ax` `ay` m/s^2 (body frame, gravity excluded), `yaw_rate` rad/s (+ = left), `steer_deg` (road-wheel angle, + = left), `fz_fl fz_fr fz_rl fz_rr` N. A check needs only the columns it uses (below); extra columns are ignored.

| file | manoeuvre | columns used |
|---|---|---|
| `static.csv` | at rest on flat ground, neutral, brakes lightly held, 3 s, 100 rows / s | `t fz_*` (rows with `t >= 1`) |
| `coast.csv` | straight from 100 km/h, neutral / clutch out, no throttle, no brake, until the speed is below 8 m/s | `t speed` |
| `brake.csv` | straight from 100 km/h, full brake pedal (ABS on if you have it), clutch out, until stopped (30 s at most), 100 rows / s | `t x y speed` |
| `brake_repeat.csv` | the same run again, same time step | identical bytes expected |
| `brake_half_dt.csv` | the same run with HALF your time step | `t x y speed` |
| `launch.csv` | from rest, full throttle, any launch strategy, until 140 km/h (40 s at most) | `t x y speed` |
| `circle_left.csv`, `circle_right.csv` | steady circle, radius `circle_radius_m`, speed `circle_speed_mps`, 30 s, any steering and speed controller | `t x y speed ay yaw_rate steer_deg` (last 8 s) |

### Checks (tolerances fixed in `run.mjs`)

| check | passes when |
|---|---|
| static: total load, front share, left = right | `sum Fz = m g` within 0.5 %; front share within 1 point of `weight_front`; left-right within 1 % |
| coast-down 97 -> 60 km/h | the time equals the integral of `dv / a(v)` with `a = (1/2 rho CdA v^2 + Crr(v) m g) / (m k)` within 15 % |
| braking | speed never rises; peak 0.25 s deceleration <= `1.15 mu g + 0.05 g`; stopping distance >= the same limit (WARN above 3 x `v^2 / 2 mu g`) |
| launch | 0-100 km/h takes at least `(1/2 m v^2) / peak power`; peak acceleration <= `1.15 mu g + 0.05 g` |
| circles | `|ay| = v^2 / R` and `|yaw rate| = v / R` of the fitted path within 3 %; left turns left and right turns right; the steering needed (as a fraction of the Ackermann angle) equal left and right within 5 %; `ay` within 3 % |
| determinism, step size | `brake.csv` = `brake_repeat.csv` byte for byte; halving the time step changes the stopping distance and time by less than 3 % |

### What a vehicle pass means, and does not

These are **self-consistency** checks of the vehicle model against its own spec. They catch impossible or broken vehicles (a wrong weight, 3 g of braking, a launch faster than the engine's energy, a car that steers differently to the left than to the right,
a result that depends on the step size). Only the coast-down and the static weights compare with an independent analytic answer. A pass does **not** show that the vehicle matches its real counterpart: that needs measured data.
The thresholds are deliberately loose enough for different but reasonable models (the coast-down matches the reference core to 0.2 %, the others have margin); they were fixed before the reference was run, not tuned to it.

## 3. Reference adapter

`core/tools/conformance.cpp` (`rs_conformance`) implements both interfaces for this repository's core: `rs_conformance tyre <tyre.tir> <cases.csv> <out.csv>` and `rs_conformance vehicle <car.json> <outdir>`.
`node conformance/run.mjs selftest --adapter core/build/rs_conformance` runs it through the judges, plus deliberately broken inputs (a tyre 0.1 % off, a wheel load 5 % high, 3 g braking, ...) that must be rejected.
