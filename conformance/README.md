# OpenGrid conformance suite (v0.1)

A way to check a racing or vehicle simulation, **even one that does not use this repository's code**: files in, files out, one Node script judging them.

- **Tyre.** Your Magic Formula implementation must return MFeval's numbers on 393 operating points for each of 8 tyres (MF 5.2, 6.1, 6.2). MFeval is the MATLAB reference implementation of Pacejka's Magic Formula (BSD-3);
  the committed reference output is its unmodified output under GNU Octave. This is a hard, external reference.
- **Vehicle.** Eight logs of standard manoeuvres (static weights, coast-down, braking, launch, steady circles left and right, determinism, step size) must obey the physics the vehicle's own spec implies.
  This is **self-consistency, not accuracy**: it catches broken or impossible vehicles; it does not show a car matches its real counterpart.

## Try it in two minutes

```bash
cmake -S core -B core/build && cmake --build core/build --target rs_conformance     # the reference adapter
node conformance/run.mjs selftest --adapter core/build/rs_conformance                # reference adapter through the judges + broken inputs that must be rejected
```

## Check your own simulation

1. Read `SPEC.md` (the file formats; a tyre is about 30 lines of glue, a vehicle is eight logs).
2. Tyre: for each tyre in `tyre/manifest.json`, evaluate `cases.csv` with your Magic Formula and write `<impl>/<tag>.csv`, then
   `node conformance/run.mjs tyre --impl <impl>` (`--columns fx,fy,mz` if your model has fewer outputs, `--rtol 1e-4` for single precision).
3. Vehicle: write `spec.json` and the logs, then `node conformance/run.mjs vehicle --spec spec.json --logs <dir>`.

## What it is not

Not a certification, and not an accuracy test. MFeval is a faithful implementation of the published Magic Formula, matched by its author to the TNO MF-Tyre 6.1.2.1 solver; we have no TNO output to compare with, and it ran under Octave, not MATLAB.
The vehicle checks use thresholds fixed in advance and loose enough for different but reasonable models. The tyre files in the pack are three families: a real fitted road tyre (Project Chrono), MFeval's own examples and two synthetic variants; none is a measurement of a race tyre.

## Status and licences

v0.1, 2026-11-27. Checked against this repository's own core (all eight tyres equal MFeval; all 25 shipped cars pass the vehicle checks). No other simulation has been run through it yet: the interface has been written down, not field-tested.
The runner and the reference adapter are Apache-2.0. The data keeps its own terms (`LICENSES.md` in the pack, `LICENSING.md` in the repository): MFeval and its example tyres and Project Chrono's tyre file are BSD-3; the case list and the two synthetic tyres are CC BY-NC 4.0 (non-commercial).
