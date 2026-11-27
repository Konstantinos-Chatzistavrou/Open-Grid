# A file-based conformance method for Magic Formula tyre models and vehicle models

**Konstantinos Chatzistavrou**, Open Grid (independent) · https://github.com/Konstantinos-Chatzistavrou/Open-Grid

**Status: DRAFT of 2026-11-27, not peer reviewed, no venue chosen.** Licence: CC BY 4.0. Every number below is reproducible with the commands in section 7 (`docs/verify.md`).

## Abstract

Tyre and vehicle models are the least inspectable part of most racing and engineering simulations. The Magic Formula family of tyre models is published and has an open implementation (MFeval), yet there is no shared public procedure
that lets an independent implementation show that it computes the same numbers. We describe a small, file-based conformance method: a list of 393 operating points evaluated on a set of tyre property files, compared column by column with the output of
an unmodified reference implementation; a sweep that perturbs one coefficient at a time to show that every coefficient is exercised; and a set of vehicle-level checks against bounds that a vehicle's own specification implies. We apply it to
a C++20 implementation of Magic Formula 5.2, 6.1 and 6.2: it agrees with the reference to a relative deviation of 2e-11 or better on eight tyres, and on 582 single-coefficient variants that exercise all 228 coefficients. The method caught a mistake in our own first version.
It does not show that any tyre file describes a real tyre, nor that a simulated car matches a real one, and we say where its reach ends. Reference data, runner and reference adapter are open.

## 1 Introduction

A simulator's tyre model decides how a car behaves at the limit, and it is also the part a user is least able to check. Closed solvers cannot be inspected; open ones are rarely accompanied by a way to show that a second implementation is equivalent.
Where a game or a research tool says "Magic Formula 6.2", the reader has no way to tell which equations, which corrections to the published formulation and which edge-case behaviour are meant.

We propose to make the claim testable in the way that file-format and graphics-API conformance suites do: by fixing a small interface of plain files, publishing the reference output, and judging any implementation with a program that knows nothing about how the files were made.
Contributions: (a) a file interface and a case list for Magic Formula tyres; (b) a per-coefficient sweep that detects coefficients a test set never reaches; (c) vehicle-level checks that need no ground truth, with negative controls showing that each check can fail;
(d) an open reference implementation, runner and continuous-integration set-up; (e) an account of what the method found in its own author's code.

## 2 Background and related work

The Magic Formula is documented by Pacejka [1] and extended to include inflation pressure and, in version 6.2, a camber-dependent loaded radius [2]. The commercial TNO MF-Tyre / MF-Swift solvers are the industry reference.
MFeval [3] is a MATLAB implementation of versions 5.2, 6.1 and 6.2, released under a BSD licence; its author matched it to MF-Tyre 6.1.2.1 where that solver differs from the book. A Julia port exists [5]. Project Chrono [4] publishes tyre files with its vehicle models.
Standardised vehicle manoeuvres (steady circular driving, step steer, braking in a turn, double lane change: ISO 4138, 7401, 7975, 3888) are used in our simulator's own tests, separately from the checks described here.

## 3 Method

### 3.1 The interface

A tyre property file (`.tir`, FITTYP 5, 6, 21, 61 or 62) and a case list `cases.csv`: `fz_rel, kappa, alpha, gamma, phit, vx_rel, p_rel, usemode`, 393 rows. A row's load is `fz_rel` times the file's nominal load, its speed `vx_rel` times the file's measurement speed,
its pressure `p_rel` times the nominal pressure, and `usemode` is MFeval's three-digit switch (limits on or off, slip angle or its tangent, with or without turn slip). The cases span pure and combined slip, load, camber, pressure, low speed and reverse, turn slip,
limits off, zero and out-of-range loads, and slips beyond the file's limits. An implementation writes one row of MFeval's 30 output columns per case; it may write a subset. Rows are evaluated independently.

### 3.2 The reference

The reference output is that of the unmodified MFeval 4.3.1 run under GNU Octave 8.4, through two small shims (`coder.extrinsic`, `contains`) and by calling the solver of the `+mfeval` package directly (Octave resolves one function name differently).
MFeval's rolling-radius loop is vectorised and stops as soon as any row has converged, so the result for a row depends on the other rows in the call: in a batched run the angular speed differed by up to 3e-5 relative. The reference is therefore produced **one operating point per call**.

### 3.3 Judging

A value passes when `|yours - reference| <= atol + rtol |reference|` with `rtol = 1e-6` and `atol = 1e-9` (1e-7 for the three iteratively solved lengths, 1 N/m for the vertical stiffness). A cell where the reference itself is NaN or infinite is skipped, and counted, as are the
radius outputs on rows where the reference's own radius solve fails (a tyre with `Q_FZ2 = 0` makes MFeval divide 0 by 0). The instantaneous cornering stiffness is never compared (it depends on how rows are grouped into a call).

### 3.4 The per-coefficient sweep

Agreement on a set of tyres says nothing about a coefficient that is zero or unused in all of them. For each of the 228 coefficients we write a tyre that differs from a base in that coefficient only, run MFeval on it, and compare as above; we also record whether the reference output changes at all.
Three passes: all coefficients on three base tyres (472 tyres); a second pass in which every Pacejka-type coefficient that is zero in the base is first set to 0.03, because a coefficient multiplying a zero (`RVY4` when `RVY1..3 = 0`) cannot show an effect (104 tyres); and a third that moves the slip,
pressure and camber limits inside the range the cases cover (6 tyres). A coefficient is *exercised* when at least one tyre in which only it changed gives a different reference output.

### 3.5 Vehicle checks

The vehicle interface is a specification (mass, weight distribution, peak tyre grip, peak power, drag area, rolling resistance) and eight logs of fixed manoeuvres: static weights, a coast-down from 100 km/h, a straight-line stop, a launch, steady circles to the left and to the right, a repeated stop, and a stop at half the time step.
The checks are: wheel loads sum to the weight and split as specified; the coast-down time from 97 to 60 km/h equals the integral of the analytic deceleration from drag and rolling resistance within 15 %; braking and acceleration stay within 1.15 times the tyres' peak grip plus 0.05 g and a launch to 100 km/h takes at least
the kinetic energy divided by peak power; both circles obey `a_y = v^2/R` and `yaw rate = v/R` of the fitted path within 3 %, turn in opposite directions, and need the same steering (5 %) and lateral acceleration (3 %); two identical runs are byte-identical; halving the time step changes the stop by less than 3 %.
**The thresholds were fixed before the reference ran.** Only the static weights and the coast-down compare with an independent analytic answer: the rest is self-consistency.

### 3.6 Negative controls

A judge that cannot fail proves nothing. The self-test feeds it deliberately wrong inputs and requires each to be rejected: a tyre whose lateral force is 0.1 % high, one whose aligning moment is 0.01 N m off, a wheel load 5 % high, a car losing speed 1.7 times too fast,
braking in half the time, a launch five times too quick, 20 % less steering on one side, a stop 8 % longer at half the step.

## 4 Results

**Tyre.** The C++ implementation agrees with the reference on all compared columns of eight tyres (a real fitted road tyre, MFeval's five example tyres, and two synthetic MF 6.1 and 6.2 tyres), 393 points each (11,397 values per tyre where the reference is finite), with a worst relative deviation of 2e-11
for MF 6.2 (the tolerance of the secant iteration for the loaded radius) and 1e-14 or better elsewhere. **Sweep.** All 582 single-coefficient tyres agree; all 228 coefficients are exercised in at least one tyre (203 under the MF 5.2 family, 217 under 6.1 and 6.2; the others do not apply to that version).
The first pass left 52 coefficients inert, for the reasons in section 3.4, which motivated the second and third passes.

**What the method found in our own code.** (i) On the committed tyres the comparison failed on exactly the turn-slip points of the aligning moment and the residual torque. MFeval computes `Cr = (2/pi) acos(Mzp90/|Drp|)`, which is complex when the ratio exceeds one in magnitude, and evaluates `cos(Cr x)` with the complex value; the real part is taken only at the end.
Our first version clamped the ratio and a code comment claimed that gives the same result, which is false. MFeval's own example tyres never reached that branch, so a second, differently built tyre set was needed to expose it. (ii) MFeval returns NaN or infinity for turn slip at exactly zero turn slip, at zero speed and at zero load, and for
`Q_FZ2 = 0` in the radius outputs; we reproduce MFeval where it returns a number and document five deliberate deviations where it does not. (iii) The batch dependence of section 3.2 was found because a first batched reference disagreed with our solver by 3e-5.

**Vehicle.** The reference simulator's coast-down from 97 to 60 km/h takes 42.55 s against 42.65 s predicted (-0.2 %) for one car; all 25 shipped cars pass every check; all negative controls are rejected. The checks never failed on a shipped car: their value is that a broken car fails them (a tyre rated for about seven times the car's load, an absurd final drive,
brakes at 5 % of what the tyres can use, an engine with a tenth of the torque).

**Companion tool.** A least-squares fitter for tyre property files uses the same evaluator as its model. On synthetic data (curves generated from a known tyre, fitted from a different tyre, judged on loads and cambers it never saw) the rms error is at most 1 % of the peak force on Fx, Fy and Mz and 1.7 % on peak force over four tyre pairs,
and 3.5 % on initial cornering stiffness, the least well determined quantity. Many coefficient sets give nearly the same curves; the fit recovers curves, not coefficients.

## 5 Limitations

- **The reference is MFeval, under Octave.** We have no output from the commercial TNO solver, and no run under MATLAB. Equality with MFeval is equality with one faithful, open implementation.
- **No measured tyre data** is used anywhere: the real tyre files are published model parameters, MFeval's examples have no stated origin, the others are synthetic. The method says nothing about whether a file describes a real tyre, and the fitter has not been tried on measurements.
- **The vehicle checks are self-consistency**, with two analytic exceptions. They cannot show that a car resembles its real counterpart.
- **One implementation.** The method has been run only on its author's code. Whether the interface is easy to implement for someone else is untested.
- **Coverage** is that of the 393 cases: a coefficient is shown to matter somewhere, not in every combination of load, slip, camber and pressure.
- The case list and the thresholds are the author's choices.

## 6 Conclusion and future work

A shared, file-based procedure can turn "our tyre model is Magic Formula 6.2" into a statement a reader can check. The next steps are an independent implementation run through the suite, a run of the reference under MATLAB, a comparison with a TNO solver if one becomes available, the standardised manoeuvres inside the suite,
and measured tyre data, collected with its provenance in a public registry (`registry/`).

## 7 Reproducing this

```bash
cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build --target rs_tests rs_conformance -j2
core/build/rs_tests mf62_golden                                        # tyre: 8 tyres against the committed MFeval output
node conformance/run.mjs selftest --adapter core/build/rs_conformance  # the judges, the reference adapter and the negative controls
# the sweep (about 45 minutes of Octave) and a fresh MFeval run: docs/mf62.md
```

## Declarations

[To be completed by the author before submission: funding, competing interests, and a statement on the use of AI coding assistance in developing the software, tests and this text.]

## References

1. H. B. Pacejka, *Tire and Vehicle Dynamics*, 3rd ed. revised, Elsevier, 2012.
2. I. J. M. Besselink, A. J. C. Schmeitz, H. B. Pacejka, "An improved Magic Formula/Swift tyre model that can handle inflation pressure changes", *Vehicle System Dynamics* 48 (2010) 337-352.
3. M. Furlan Tassara, *MFeval*, version 4.3.1, MATLAB File Exchange 63618, 2021 (BSD-3-Clause). https://www.mathworks.com/matlabcentral/fileexchange/63618-mfeval
4. Project Chrono. https://github.com/projectchrono/chrono (BSD-3-Clause).
5. *MFeval.jl*, a Julia port of MFeval. https://github.com/matheusft/MFeval_julia (MIT).
6. GNU Octave, version 8.4. https://octave.org
7. ISO 4138, ISO 7401, ISO 7975, ISO 3888: vehicle dynamics test methods (steady-state circular driving, lateral transient response, braking in a turn, obstacle avoidance).
