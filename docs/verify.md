# Don't trust it, check it

A simulator whose physics you cannot inspect asks for your trust. This one is meant to give you commands instead. Every validation claim in this repository is listed here with a way to reproduce it, how long that takes, and what it does **not** show.
The code is open (Apache-2.0), the references are open (MFeval, BSD-3), and the tests run on every commit in public CI: https://github.com/Konstantinos-Chatzistavrou/Open-Grid/actions

## Claims and how to check them

| # | Claim | Check | You should see | Time |
|---|---|---|---|---|
| 1 | Our Magic Formula evaluator returns MFeval's numbers on 8 tyres, 393 points each, every column | `cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build --target rs_tests -j2 && core/build/rs_tests mf62_golden` | one line per tyre ending in its worst relative deviation (2e-11 or better), then `0 failed check(s)` | a few minutes to build |
| 2 | The same, judged by code that is not ours | `core/build/rs_conformance tyre <tyre.tir> data/validation/mf62/mf62_cases.csv out.csv`, or write your own implementation, then `node conformance/run.mjs tyre --impl <dir>` (`conformance/README.md`) | `all tyres conform` | seconds |
| 3 | The reference really is MFeval, unmodified | `sha256sum tools/validation/mfeval/+mfeval/Solver.m` and compare with the table in `tools/validation/mfeval/README.md` and with the same file in the official `mfeval-4.3.1.mltbx` (MathWorks File Exchange 63618; needs a free account) | `068b1128a2f71b9820c146deea588073ebfa623884f8e285dcaa171583d11faa` | a minute |
| 4 | The golden numbers are really what MFeval returns | install GNU Octave, run `tools/validation/mfeval_reference.m` on a tyre (steps in `docs/mf62.md`, "Run MFeval and compare") and compare with `data/validation/mf62/golden/` | identical to the digits printed | minutes |
| 5 | All 228 coefficients are exercised and match MFeval | the sweep: `docs/mf62.md`, "Per-coefficient sweep" (generator, Octave batch, `mf62_coefficient_sweep`) | 582 of 582 tyres match | about 45 minutes of Octave |
| 6 | Adding the opt-in full-MF tyre did not change the game's own tyre | `tools/validation/default_tyre_fingerprint.cpp`: copy it into a checkout of a commit before (`6c25dfde`) and one after (`31235fa4` or later), build both with the same compiler, run each | the same fingerprint both times (`a850d0caf3473245` with GCC 13.3 on x86-64) | minutes |
| 7 | The tyre fitter recovers a known tyre from synthetic data | `core/build/rs_tests tirfit_roundtrip tirfit_other_tyres` | the error table printed in `docs/own_tyre_data.md` | seconds |
| 8 | The car checker catches broken cars | `ctest --test-dir core/build -R car_pipeline` | wrong tyre load, absurd gearing, weak brakes and a crippled engine are each caught | seconds |
| 9 | The vehicle model obeys its own physics (coast-down against the analytic drag and rolling-resistance answer, weights, symmetry, determinism, step size) | `node conformance/run.mjs selftest --adapter core/build/rs_conformance` | every check with its numbers, and the deliberately broken inputs rejected | seconds |

## What none of this proves

- That MFeval equals the commercial TNO solver. Its author matched it to MF-Tyre 6.1.2.1; we have no TNO output. MFeval was run under GNU Octave here, not MATLAB.
- That any tyre file describes a real tyre. There is **no measured tyre data** in the repository; the fitter has been checked on synthetic data only; open MF 6.x data for race tyres does not exist, so the cars' grip is a per-car calibration.
- That a car matches its real counterpart. The vehicle checks are self-consistency: they catch impossible or broken cars, nothing more.
- How the game feels.

## Mistakes we found in our own work

Listed because a project that only reports passes should not be believed. Each is in the commit history.

- A claim that clamping an out-of-range `acos` gives the same real part as MFeval's complex result was wrong; the golden test caught it (`f75dc16c`, `45cc7820`, `docs/mf62.md`).
- The game's tyre was described as "full MF 6.2"; it is a reduced set of 6.x terms, and `docs/physics.md` now says so.
- The first tyre fitter failed on a truck tyre fitted from a car tyre (16 % error on its own training data) and now starts from the data's own peak grip and slope (`5c1c8ea2`).
- The car generator first geared a 110 kW hatchback for 330 km/h (`18e4e6de`); a template's `LFZO` scaling silently changed a fitted tyre's nominal load, and the catalog entry it printed was in the wrong format (`3dbb3655`).
- We wrote that the Chrono tyre files carry their licence notice; they do not (`bd457305`).

## If something does not hold

Open an issue titled "Verification failure" with the command and its output. A failure that is confirmed gets listed here.
