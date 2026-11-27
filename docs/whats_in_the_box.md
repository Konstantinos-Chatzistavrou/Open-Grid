# What is in the box (and what you bring)

**One line.** Open Grid is an open-source (Apache-2.0) C++20 vehicle-physics core for racing games, with tools to fit your own tyres and check your own cars, a conformance suite any simulation can run, and a free game that shows it all working.
You build the game around it: **you bring your own art, cars, tracks and interface for commercial use.**

Status on 2026-11-27: pre-1.0, one maintainer, no outside users yet. Everything below says how it was checked, so you can decide for yourself (`docs/verify.md`).

## What the core gives you

| Area | What it does | How it was checked |
|---|---|---|
| **Tyres** | Pacejka Magic Formula 5.2 / 6.1 / 6.2 evaluator (`rs::mf62`) and the game's own tyre model (carcass, thermals, wear, contact patch) | The Magic Formula evaluator equals MFeval on 8 tyres and 582 single-coefficient variants (CI). The game's tyre model is calibrated, not checked against MFeval; its A/B against the evaluator is in `docs/mf62.md`. |
| **Chassis** | Suspension kinematics (double wishbone, MacPherson), springs, dampers, anti-roll, weight transfer, steering | About 150 tests (CI on GCC, MSVC and the sanitizers); self-consistency, not measured against real cars |
| **Drivetrain** | Engine, clutch, synchro gearbox, differentials, brakes with thermals, driver aids (ABS, traction control, stability) | Same |
| **Aero, damage, weather, surfaces** | Ride-height aero maps, panel and wheel damage, rain and surface grip | Same |
| **Race layer** | AI drivers and racing lines, race control and rules, telemetry, deterministic replays and a replay verifier tool (`opengrid_replay_verifier`) | Same |
| **Tools** | Tyre fitter (`rs_tirfit`, and the Tyre Lab in the browser), car generator and checker, tyre registry, conformance suite | `docs/getting_started.md`, `docs/own_tyre_data.md`; the fitter has only seen synthetic data |
| **Hosts** | Browser (the core compiled to WebAssembly, and the package `open-grid-physics` in `packages/vehicle-physics/`), native C++ | The browser build is driven by headless tests; the core compiles as one unit under MSVC in CI |

## What is experimental

- **Unreal Engine 5.8 plugin** (`ue5_plugin/`, `ue5/`): about 6,000 lines of component and pawn code. CI compiles the physics core as one unit; **nothing in the repository shows the plugin has been built inside the Unreal editor**. Treat it as a starting point and expect first-contact work.
- **Force feedback on a real wheel**: the bytes sent and the force signal are checked without hardware; how it feels has never been tested (`docs/ffb_test_plan.md`).
- **Car data**: the shipped cars are calibrations against published figures, not measurements. There is no measured tyre data in the repository.

## What you bring

- **Art**: 3D models, textures, interface artwork. The art and models shipped here are **non-commercial** (CC BY-NC 4.0).
- **Cars' data for commercial use**: the shipped car files are also CC BY-NC 4.0, and the car generator starts from one of them, so cars made with it inherit that. For a commercial game, write your own car files (the schema is Apache-2.0) from your own data.
- **Tracks and environments**: a city exporter and OpenStreetMap-based cities exist (OSM data is ODbL: credit "© OpenStreetMap contributors", and derived map data stays ODbL); circuits and level design are yours.
- **Audio assets**: the engine-sound synthesiser is code; sample libraries have their own licences (`CREDITS.md`).
- **Game design, interface, netcode, content, platforms, certification, tuning for feel.** A game is mostly these.

## What is free to use commercially

| | Licence | Commercial use |
|---|---|---|
| Physics core, tools, cloud code, the interface code (`web/src/`) | Apache-2.0 | Yes; keep the `NOTICE` |
| Conformance suite documents, validation data, registry metadata | CC BY 4.0 | Yes, with credit |
| Tyre files in the registry | each entry states it | Per entry (most are BSD-3 or CC BY: yes, with credit) |
| Models, textures, shipped car files, other docs | CC BY-NC 4.0 | No, not without written permission |
| The name "Open Grid", the logo, the "OpenGrid Conformant" mark | Not licensed | See `TRADEMARKS.md` |

This is how the project describes its own licences; it is not legal advice.

## Is it right for you?

**A good fit** if you want vehicle physics you can read, run and check, tyre tools you can use on your own data, and a licence that lets you ship a commercial game with your own content.
**Not a fit yet** if you want a finished Unreal template, a studio-grade editor workflow, or someone to call when it breaks: that is the work of a team, and this is one person's project that is looking for partners (`PARTNERS.md`).
