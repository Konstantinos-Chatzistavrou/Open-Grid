# UE 5.8 Roadmap: What to Stop in WebGPU vs. What to Build Now

OpenGrid's target release engine is **Unreal Engine 5.8** (`ue5/OpenGrid.uproject`, `ue5_plugin/OpenGridPhysics/`).
The browser build (`web/`, Three.js WebGPU + Rapier + WASM `rs_core`) exists so we can develop, test, and verify the
C++17 physics core, car models, and asset pipelines on a lightweight laptop (i3-1315U, 7.4 GiB RAM) before moving to a
dedicated UE 5.8 machine.

This document defines the strict boundary between **throwaway WebGPU work (STOP)** and **100% UE 5.8-transferable work
(DO NOW)**.

---

## 1. STOP Improving in the WebGPU Version (Throwaway Work)

Do **not** spend further engineering or GPU-tuning time on browser-only systems that UE 5.8 replaces natively:

| Area to Freeze | Why It Is Throwaway for UE 5.8 |
|---|---|
| **Three.js post-processing & lighting passes** (`web/src/fx/`, `web/src/gpu/`) | Custom WebGPU SSR, GTAO, TRAA, clustered forward light culling, TSL bloom/tonemapping, and cube reflection probes are replaced out-of-the-box by UE 5.8 **Lumen** (GI + reflections), **Virtual Shadow Maps (VSM)**, **TSR**, and **PostProcessVolume**. |
| **Web `.glb` city tile meshes & procedural TSL building/ground shaders** (`web/public/assets/cities/*/*.glb`, `web/src/scene/nyc/facade.ts`, `groundMaterials.ts`) | Web city tiles are low-poly extruded boxes tuned for a browser draw-call budget. UE 5.8 will use **Nanite** modular building meshes spawned via **PCG** from OSM footprints, **Landscape** heightmaps from `terrain.py`, and **Substrate** materials using the 4K Kit masters (`ue5/SourceArt/Kit/`). |
| **Web tile streaming & Rapier / Web Worker workarounds** (`web/src/scene/nyc/streamer.ts`, `web/src/physics/physWorker.ts`) | UE 5.8 streams open worlds natively via **World Partition** + **Nanite** and runs native C++17 `rs_core` on **Chaos Async Physics** at 1000 Hz (`6.2%` of one core for 16 cars) via `rs::ue5::AsyncVehicleBridge`. |
| **HTML/CSS UI & WebAudio synth polish** (`web/src/menu.ts`, `web/src/hud.ts`, `web/src/audio.ts`) | Keep the web HUD/menu solely as a minimal debug harness for new `core/` telemetry and settings. UE 5.8 uses **CommonUI / UMG** and **MetaSounds**. |

> **Rule of thumb:** Only touch `web/` when exposing or verifying a new C++ `core/` physics/gameplay feature or
> previewing a newly ingested car / kit asset.

---

## 2. IMPROVE NOW for UE 5.8 (100% Transferable From This Laptop)

Everything below can be built and verified **right now** on Linux using C++17 (`ctest`), Blender headless Python, and
Node.js, and plugs straight into UE 5.8 with zero rework.

### A. Cars & Visual Customization Pipeline (Highest Priority)

1. **Port Procedural Mods from TypeScript to Blender / UE 5.8 glTF Exports (`tools/ue5/export_cars_for_ue.mjs`)**:
   - **Current gap**: Widebody fender flares (`web/src/scene/parts/widebody.ts`), aftermarket wings (`wings.ts`),
     splitters/diffusers/side skirts (`fit.ts`), and custom rims (`rims.ts`) are currently generated at runtime in
     Three.js TypeScript. If left in TypeScript, **none of those mods exist in UE 5.8**.
   - **Fix**: Generate and export every car's modular parts offline in Blender / `export_cars_for_ue.mjs` into
     `ue5/Import/<car>/parts/` (`widebody_street.glb`, `widebody_gt.glb`, `wing_*.glb`, `splitter_*.glb`,
     `diffuser_*.glb`, `skirt_*.glb`, `rim_*.glb`) with standardized named sockets (`SOCKET_Wheel_FL..RR`,
     `SOCKET_Caliper_FL..RR`, `SOCKET_Wing`, `SOCKET_Exhaust_L/R`, `SOCKET_Plate_Rear`) so `AOpenGridCarPawn` attaches
     Nanite static meshes directly.
2. **Split Wheels & Calipers Across All Catalog Cars (`export_cars_for_ue.mjs`)**:
   - **Status**: `tornado_gt` and `tornado_gt3` are already split into independent `wheel_FL..RR` and `caliper_FL..RR`
     nodes (and duplicate `k_concept` was removed in favour of `strix_gt7`, which is also split).
   - **Remaining gap**: Most Nov-22 Sketchfab restyled `v5/*_hero.glb` cars have split `wheel_FL..RR` but still need
     `caliper_FL..RR` grouping in `tools/pipeline/sketchfab_gta6_blender.py`.
3. **Bake 6-Zone Crash Morph Targets & Detachable Panels into Car glTFs**:
   - **Current gap**: Vertex denting (`web/src/scene/dents.ts`) currently runs in JavaScript on the CPU.
   - **Fix**: Author/generate 6 directional crush **Morph Targets** (`crush_front`, `crush_rear`, `crush_left`,
     `crush_right`, `crush_top`, `crush_hood`) in Blender during car export so UE 5.8 drives real GPU morph-target
     deformation + hood/bumper latch detachment directly from `rs::DamageState`.
4. **4K Car PBR Master Maps (Substrate-Ready)**:
   - Bake 4K AO, curvature/edge wear, panel-gap normal, and emissive light-zone masks per car (stored on GitHub
     Releases, generated locally into `ue5/Import/<car>/` at 4K PNG for UE 5.8 **Substrate** dual-specular metallic
     flake clearcoat + glass + light shaders).

### B. C++17 Physics & Gameplay Core (`core/` + `data/cars/*.json`)

1. **Author Explicit 3D Suspension Hardpoints & Gear Tooth Counts for All 18 Cars**:
   - `vela_gt.json` and `hayate.json` now have explicit 3D hardpoints (`double_wishbone` / `macpherson`), and
     `vela_gt.json` has explicit helical `gear_teeth`. Author realistic per-car hardpoint geometries and tooth counts
     for the remaining 16 cars in `data/cars/*.json`.
2. **Wheel Pose Interpolation in `rs::ue5::AsyncVehicleBridge` (`core/include/rs/ue5_bridge.hpp`)**:
   - **Current gap** (`docs/ue5_first_session.md`): Wheel visuals in UE 5.8 read the latest physics step while the
     chassis is interpolated, causing a 1-step wheel lag at high speed.
   - **Fix**: Interpolate wheel world/local centres, steering angles, camber, toe, and spin angles inside
     `rs::rt::blend(const StepRecord&, const StepRecord&, double alpha)` so `UOpenGridVehicleComponent` renders
     sub-millimetre-aligned wheels at any frame rate.
3. **Dynamic Fuel-Load Inertia Tensor Scaling (`core/src/vehicle.cpp`)**:
   - Scale chassis pitch/yaw/roll inertia with remaining fuel mass around the rear tank offset instead of keeping
     full-tank inertia as fuel burns.
4. **Engine-Independent Audio Synthesis Parameters & Surface-Contact Events in `core/`**:
   - Compute physical exhaust pulse frequency, cylinder firing order harmonics, turbo compressor mass-flow/surge,
     transmission straight-cut gear whine frequency, and per-wheel kerb/gravel/puddle contact excitation inside
     `core/` (`TelemetrySample` / `VehicleOutput`) so UE 5.8 **MetaSounds** and **Niagara** particle systems are driven
     100% by physical numbers from C++.

### C. UE 5.8 C++ Plugin & Pawn (`ue5_plugin/` + `ue5/Source/`)

1. **Expose New Physics Core Outputs on `UOpenGridVehicleComponent`**:
   - Wire the new kinematic suspension outputs (`wheel_toe_rad`, `roll_centre_front_m`, `roll_centre_rear_m`),
     drivetrain state (`clutch_temp_c`, `clutch_health`, `gearbox_health`, `missed_shifts`, `gear_grind`), and 3-node
     tyre state (`inner_air_c`, `pressure_kpa`, 4×4 patch kerb load) into `FOpenGridWheelState` /
     `UOpenGridVehicleComponent` `UPROPERTY(BlueprintReadOnly)` structs and dynamic multicast delegates
     (`OnMissedShift`, `OnGearGrind`, `OnBackfire`, `OnScrape`).
   - Verified automatically on every push via the existing Windows MSVC job in `.github/workflows/ci.yml`.
2. **OSM + Copernicus DEM → UE 5.8 Landscape & PCG Exporter (`tools/ue5/export_city_for_ue.py`)**:
   - Keep using `tools/nyc/extract.py` and `tools/nyc/terrain.py` (which already fetch Copernicus DEM GLO-30 + OSM and
     carve banked mountain/urban road corridors), and add an exporter that writes:
     - **16-bit PNG Landscape Heightmap + Weightmaps** (`asphalt`, `shoulder`, `cliff_rock`, `grass_maquis`, `water`)
       for 1-click UE 5.8 Landscape import.
     - **Road Spline & Building Footprint JSON/CSV** (positions, widths, superelevation roll, OSM material tags, roof
       shapes, landmark IDs) for UE 5.8 **PCG (Procedural Content Generation)** graphs to populate Nanite roads,
       W-beam guardrails, retaining walls, Kit v1 props, and buildings automatically.

### D. Remaining Kit v1 Asset Phases (`docs/kit.md`)

- **Phase D (`tools/assets/photo_to_material.py`)**: Convert your own straight-on phone photos into perspective-corrected,
  delit, tileable 4K PBR master sets (`CC BY-NC 4.0`, stored on GitHub Releases, exported at 4K PNG for UE 5.8).
- **Phase E (15 Street Props)**: Ingest your downloaded Sketchfab CC0/CC-BY props into `assets_source/masters/kit/` with
  ledgers, real-world metric scale verification, and UE 5.8 glTF exports (`ue5/SourceArt/Kit/props/`).
- **24-Car Modular Fleet & 14 UE 5.8 Modular Aftermarket Parts per Car**:
  - Expanded the fleet to 24 original de-branded cars (`kaze_kurogane_re`, `valenza_evo37`, `kaze_senkou_tr`, `valenza_sp3`, `falcorn_9r_rs`, `valenza_integrale` + the 18 existing cars), all with explicit 3D suspension hardpoints, exact gear tooth counts, licence ledgers (`assets_source/masters/cars/<id>/source.json`), and `tools/ue5/export_cars_for_ue.mjs` export support.
  - Added 21 new modular aftermarket parts across wings (`swan-rs`, `bridge-037`, `rally-roof`, `hoop-nsx`, `re-timeattack`), rims (`turbofan-rally`, `bbs-rs-mesh`, `re-five-dish`, `evo37-tarmac`, `sp3-directional`), splitters/diffusers/skirts, bumpers, hoods, and widebody flares (`fender-integrale-box`, `fender-rs-louvre`), plus 4 new offline UE 5.8 modular `.glb` part exports (`wing_swan_rs.glb`, `wing_bridge_037.glb`, `wing_rally_roof.glb`, `rim_turbofan.glb` — 14 parts per car in `ue5/Import/<car>/parts/`).
  - Applied the **Tokyo Night (`tokyo_night`)** color grade (`web/src/fx/grade.ts` + `docs/art_direction.md` UE 5.8 `APostProcessVolume` spec) across both street driving and showroom pipelines.

### E. Completed Day-One UE 5.8 Turnkey Systems
- **Nanite High-Poly Car Geometry (`tools/pipeline/sculpt_fleet.py --ue5-nanite`, `tools/ue5/build_nanite_cars.py`)**: Level-3 Catmull-Clark curvature (~136k tris per car), beveled panel shutlines, recessed transparent glass lenses over dark metallic reflector buckets, 6-piston monoblock calipers + ventilated rotors, full cockpit interiors (dash, gauges, D-shaped 3-spoke steering wheel, pedals, console, bucket seats, roll bar), and 100% world-scale box `UVMap` coverage (`ue5/Import/<id>/nanite_hero.glb`).
- **UE 5.8 C++ Gameplay & Systems (`ue5/Source/OpenGrid/`)**: `UOpenGridCustomizationComponent` (modular socket parts, widebody morphs & track offset, paint/wear MIDs, JSON sync), `UOpenGridDamageComponent` (6 `crush_*` morph targets + Chaos detachable panels), `UOpenGridMetaSoundComponent` (MetaSounds parameter/trigger bridge), `UOpenGridRaceSubsystem` (6-car grids, lap timing, Heat 0–5 tactical pursuits), and `UOpenGridOnlineSubsystem` (`FHttpModule`/`FWebSocketsModule` client for the Cloudflare Worker backend), all wired onto `AOpenGridCarPawn`.
- **One-Click UE 5.8 Editor Auto-Importer & DataTables (`tools/ue5/generate_ue5_datatables.mjs`, `tools/ue5/ue5_import_all.py`)**: Generates UE 5.8 `UDataTable` CSVs for all 24 cars (`data/ue5/car_catalog_dt.csv`) and 135 modular parts (`data/ue5/parts_catalog_dt.csv`) plus `data/ue5/tokyo_night_postprocess.json`, and imports all cars, 16 4K kit materials/HDRIs, LUT, `PPV_TokyoNight` PostProcessVolume, DataTables, and city landscapes/PCG manifests in one Unreal Editor Python command (`docs/ue5_first_session.md`).
- **Tokyo Night 3D LUTs & 48 kHz / 24-bit MetaSound Audio Stems (`tools/ue5/generate_tokyo_night_lut.py`, `tools/ue5/generate_audio_stems.py`, `docs/ue5_audio_metasounds.md`)**: Exact 33³ `.cube` (`data/ue5/TokyoNight_33.cube`) and native UE 5.8 `256x16` strip PNG (`data/ue5/TokyoNight_UE5_256x16.png`) LUTs, plus 11 verified seamless 48 kHz / 24-bit procedural WAV MetaSound stems (`ue5/Import/Audio/`, tracked ledger `assets_source/audio/manifest.json`).


