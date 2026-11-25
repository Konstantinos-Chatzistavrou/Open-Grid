# Ultrareview of the physics core, 2026-11-25

Three cloud reviews of 19 + 16 + 20 files (about 20,800 lines): the chassis / tyre / suspension / street-surface core, the
drivetrain / config / telemetry / dyno / engine-audio core, and the Unreal plugin + game module + car exporters. Every
finding was checked against the code before anything was changed; the ones that held are fixed on this branch, each with a
regression test (`core/tests/test_ultrareview.cpp`, names `ur_*`) that was **checked to fail on the old code** by putting the
original line back and rebuilding.

Result: 120 of 120 CTest tests pass (103 existing + 17 new), the core also compiles clean as the single C++20 unit the Unreal
build uses, and the new tests are clean under ASan + UBSan.

## Physics (chassis, tyres, suspension, road)

| Finding | Fix | Test |
|---|---|---|
| Pedal reverse swapped the pedals after the driver had chosen R by paddle, and flip-flopped R / 1st every 0.4 s with an H-shifter at rest | the pedals never swap in a gear the driver chose; with an H-shifter the lever decides (`controls.cpp`) | `ur_pedal_reverse_explicit_gear`, `ur_pedal_reverse_hshifter` |
| `apply_settings` ignored "road water back to 0" while the street surface was off: the road stayed wet for good | the water follows the latest setting, including 0 (`vehicle_runtime.hpp`) | `ur_runtime_road_water` |
| Right-side tyres counted top-OUTWARD camber as top-inward in the rib heat model (`max(-g, side*g)` = `abs(g)`), so left and right corners heated differently | `side * gamma`, as the grip model already did (`tire.cpp`) | `ur_tire_zone_camber_symmetry` |
| Suspension solver took the sign of its finite-difference slope from "did the ball joint rise" instead of the probe direction; it diverged for a hinge axis pointing the other way | divide by the step actually probed (`kinematics.cpp`) | `ur_kinematics_hinge_direction` |
| The 3-ray and 16-ray contact resolvers dropped the ground's water film, grip multiplier, marbles and per-cell grip, so the same road gripped differently per ray mode | carried over from the hit that set the contact (`vehicle.cpp`) | `ur_contact_resolver_ground_data` |
| `StreetMicroGround` built the 4x4 patch profile on the world axes, so a pothole or manhole landed on the wrong side of the patch unless the car pointed along +X | rays now carry the tyre's heading (`WheelRay::forward`) and the profile follows it | `ur_street_micro_heading` |
| Crown drainage drained the left half first and the right half from what was left: lopsided streets in rain | all lanes shed from one snapshot (`street_surface.hpp`) | `ur_street_drainage_symmetry` |
| `reset_motion` left last step's tyre Fx, suspension travel, ABS and TC state behind | cleared (`vehicle.cpp`) | `ur_reset_clears_carryover` |
| Crash impulses applied on whichever tick drained them (unlike commands), so a replay was not repeatable | `ImpactCommand::apply_tick`, default 0 = next step as before | `ur_runtime_impact_tick` |
| Right-wheel mirroring written out twice (steer, offset, contact point, FVIC) | one `AxleKinematicsTable::mirror_to_right` | (covered by `kinematics`) |
| Dyno binned smoothed power against the live rpm, so during a pull the peak read ~0.5 s of revs too high; the comment said 0.6 s / 0.1 s while the code uses 2.0 s / 0.5 s | rpm is smoothed like the power; named constants, comment fixed (`dyno.cpp`) | `ur_dyno_rpm_alignment` (old code reads a 5500 rpm peak at 6194) |

## Engine audio and telemetry

| Finding | Fix | Test |
|---|---|---|
| The engine solver did not run the step count it was asked for: `startFrame` rescaled it by +-10 % to steer a synthesizer latency nothing consumes, and the drain check compared seconds with 256 so it never ran. Pitch sat off and moved every second | `Simulator::startFrameSteps` runs exactly the requested steps (small addition to the vendored MIT simulator) | `ur_engine_audio_step_count` |
| One NaN / inf in telemetry poisoned the smoothers, solver and filters for good (both clamp helpers let NaN through) | NaN-safe clamps, last-finite-value sanitising where telemetry enters, a finite output guard and limiter guard | `ur_audio_non_finite` |
| Blocks over ~6000 frames reallocated the solver batches on the audio thread | `renderStereo` works in chunks of at most 1024 frames | `ur_engine_audio_step_count` |
| SimHub / Forza packet velocity was written in the world frame (the format wants the car's frame) | new `velocity_body`, packed instead | `ur_telemetry_velocity_frame` |
| SimHub packet power and torque were always 0 | torque from the clutch, power = torque x engine speed | `ur_telemetry_power_torque` |
| MoTeC export stamped one fixed 60 Hz on samples recorded once per game frame (a 144 fps game gave a 2.4x too long trace), and kept every ~1 KB sample forever (~0.5 GB per hour) | `record()` resamples to the declared rate by `time_s` (skip when faster, hold when slower, no back-fill of pauses), stores only the 18 exported channels as float32 (about 15 MB per hour) and stops after one hour; lap beacons are relative to the first row | `ur_motec_time_base` |
| Cylinder count and UE auto-voice were guessed from case-sensitive substrings of the car name: most cars got a V8 / 8 cylinders | every car file now has `engine.cylinders` and `engine.voice` (same ids as `catalog.json` `engineVoice` and `brands.ts`); `select_voice_for_car` uses it | `ur_engine_voice_data` |

## Unreal 5.8 plugin, game module, exporters

These were fixed from reading the code; **nothing here was compiled** (no Unreal install on this machine). Please build once.

| Finding | Fix |
|---|---|
| `UOpenGridAudioComponent`, `EOpenGridEngineVoice` and `EOpenGridExhaustStage` were declared in both the game module and the plugin: UHT cannot build that | the game module's types were renamed: `UOpenGridMetaSoundComponent` (files renamed too), `EOpenGridSynthVoice`, `EOpenGridSynthExhaustStage`; docs updated |
| `FModSlot::SocketName` was a `const TCHAR*` initialised with `NAME_None`: does not compile | `FName` |
| Splitter and diffuser are exported in body space but were snapped to sockets that sit at the nose / tail, so they floated one car half-length away | attach at the body origin, like the widebody |
| `Recover()` reset the damage visuals at once while the vehicle still reported the old damage for a few frames, so parts were reattached, thrown off again and reattached | `BeginRepairAfterVehicleService()`: ignore the stale damage until the vehicle reports it cleared |
| `OnMissedShift` fired on every frame that drained no new physics step | edge-detected, like the other events |
| The plugin audio component picked its voice at auto-activation, before the car is loaded: every car sounded like a V8 | activated from `Tick` once the car is loaded (5 s timeout) |
| The engine-audio libraries were skipped silently when not built, giving unresolved externals | `OpenGridPhysics.Build.cs` stops with the exact CMake command; `ue5/README.md` says so |
| `body.glb` (morph targets, no skin) was imported as a static mesh with static import switched off, i.e. not at all, while the log said "imported" | Interchange is asked for a skeletal mesh; the script reports success only if the asset exists |

## Not changed, and why

- **Neutral shares byte 0 with reverse in the SimHub gear field.** True, but I could not confirm Forza's encoding for neutral
  (the official page returned HTTP 403), so I did not guess. Check SimHub's Forza parser, then change `p[307]`.
- **The WebAssembly build is not rebuilt.** There is no emscripten on this machine. The committed `rs_core.wasm` and the audio
  worklet still contain the old core until you run the usual emsdk build; the C++ here compiles as before.
- **The engine-audio libraries are still not compiled by Unreal itself.** The build now fails early with a clear message instead
  of linking wrongly. Making UBT compile `engine_audio.cpp` + the vendored engine-sim directly is a bigger job.
