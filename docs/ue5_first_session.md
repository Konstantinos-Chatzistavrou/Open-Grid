# UE5: the first paid session

Goal of session one: the C++ compiles, the editor opens, a car you can see drives on a floor with the same physics core
as the web build. Not a city, not good lighting yet. Everything that could be done for free is already in the repo
(branch `ue5-prep`); this page is the script for the paid hours.

## The machine

- **Shadow is not sold in Greece.** Its FAQ lists the US, Canada, France, the UK, Germany, the Netherlands,
  Switzerland, Belgium, Luxembourg, Italy, Sweden, Denmark, Austria and Spain
  ([Shadow FAQ](https://support.shadow.tech/articles/requirements-and-faqs/frequently-asked-questions-faq/64e310046593fd01eb5e825f)).
  Check again before relying on it, but plan around an hourly cloud machine instead.
- **AWS EC2 `g6.2xlarge`** (8 vCPU, 32 GB, NVIDIA L4 with ~22 GB) in Frankfurt: about $1.22/h on demand, about $0.81/h
  spot ([DoiT price page](https://www.doit.com/compute/spot/eu-central-1/g6.2xlarge), Nov 2026; the listed price is
  most likely the Linux rate, Windows adds a licence fee per hour). Use a Windows Server image with NVIDIA drivers and
  a remote desktop client that streams well (Amazon DCV or Parsec).
- Keep the instance's disk between sessions (stop, don't terminate): reinstalling Unreal every time costs more than a
  month of disk.
- Unreal 5.8 is the current release (5.9 is a preview): `ue5/OpenGrid.uproject` is pinned to 5.8.

## Order of work (start the long downloads first)

1. Start the **Epic Games Launcher → Unreal Engine 5.8** install. It is the longest step; do everything else meanwhile.
2. Install **Visual Studio** with the "Game development with C++" workload (check Epic's page for the version 5.8
   wants), or **JetBrains Rider** (free for non-commercial use).
3. Install **Git** and **Node.js 20+** (no Git LFS: large 4K masters live on GitHub Releases and Unreal assets are generated locally).
4. `git clone https://github.com/Konstantinos-Chatzistavrou/Open-Grid` (the `main` branch has everything), then fetch the 4K kit masters from the GitHub Release:
   ```
   node tools/assets/masters.mjs fetch
   ```
5. Export the 24 cars, Nanite hero meshes (optional), Tokyo Night LUT, and UE 5.8 DataTables (all offline, before opening Unreal):
   ```bash
   cd tools/ue5 && npm install
   cd ../../web && npm i --no-save basis_universal      # only needed for the Vela GT's KTX2 textures
   cd ..
   node tools/ue5/export_cars_for_ue.mjs                # writes ue5/Import/<car>/ (24 cars + sockets + morph targets + 14 modular parts each)
   python3 tools/ue5/build_nanite_cars.py               # optional: Blender high-poly Nanite hero meshes -> ue5/Import/<car>/nanite_hero.glb
   python3 tools/ue5/generate_tokyo_night_lut.py        # writes data/ue5/TokyoNight_UE5_256x16.png (256x16 UE5 Color Grading LUT)
   node tools/ue5/generate_ue5_datatables.mjs           # writes data/ue5/{car_catalog_dt.csv,parts_catalog_dt.csv,tokyo_night_postprocess.json}
   python3 tools/ue5/export_city_for_ue.py nyc          # optional: exports ue5/Import/Cities/nyc/ (Landscape + PCG splines)
   ```
6. Right-click `ue5/OpenGrid.uproject` → **Generate Visual Studio project files**, open the solution, build
   **Development Editor | Win64**. Or open the .uproject directly and let the editor build it.
7. Press **Play** in any level. With no floor under the start point the game mode spawns a 2 km test floor and a
   sun. The top-left HUD line must say **fixed-step physics**; "FRAME-TICK FALLBACK" means the async physics
   setting did not apply (Project Settings → Physics → Tick Physics Async).
8. Drive: W/S or the triggers, A/D or the left stick, Q/E or the bumpers to shift (automatic gearbox is on), Space
   or A for the handbrake, R or B to recover.
9. Run the **1-click UE 5.8 auto-importer** (`tools/ue5/ue5_import_all.py`) instead of dragging files by hand — it
   imports all 24 cars (with morph targets or Nanite heroes), modular parts, 16 4K Kit PBR packs/HDRIs, the Tokyo Night
   LUT + unbound `PPV_TokyoNight` PostProcessVolume, DataTables, and city PCG manifests in one shot (see section below).
   Then create a Blueprint child of `OpenGridCarPawn`, assign **Body Mesh Asset** (`/Game/OpenGrid/Cars/<id>/body`),
   **Wheel Meshes** (FL..RR) and **Caliper Meshes**, and set it as the game mode's pawn. If a body faces the wrong way,
   set **Body Mesh Rotation** (yaw 90 / -90 / 180).
10. Save a level with a floor (File → New Level → Basic) so later sessions don't rely on the test floor.

## One-Click UE 5.8 Asset Import (`ue5_import_all.py`)

Make sure the **Python Editor Script Plugin** is enabled in Unreal Engine 5.8 (Edit → Plugins → search `Python`).
`tools/ue5/ue5_import_all.py` is idempotent: re-running it skips already-imported assets unless `OG_FORCE_REIMPORT=1` is set.

- **Headless CLI (fastest for the full 24-car + 4K Kit import):**
  ```powershell
  "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" ^
    "%CD%\ue5\OpenGrid.uproject" ^
    -ExecutePythonScript="%CD%\tools\ue5\ue5_import_all.py"
  ```
- **Inside the UE 5.8 Editor (also spawns/updates `PPV_TokyoNight` in the currently open level):**
  Open **Window → Output Log**, switch the bottom-left prompt from `Cmd` to `Python`, and run:
  ```python
  py "tools/ue5/ue5_import_all.py"
  ```
- **Optional environment variables** (filter or customize a run):
  | Variable | Example | Effect |
  |---|---|---|
  | `OG_ONLY_CAR` | `OG_ONLY_CAR=falcorn_9r_rs` | Import only the listed car ID(s) (comma-separated). Great for a fast smoke test before importing all 24. |
  | `OG_USE_NANITE` | `OG_USE_NANITE=1` | Imports `nanite_hero.glb` (built by `build_nanite_cars.py`) with Nanite enabled whenever present, falling back to `body.glb` (`bImportMorphTargets=True`). |
  | `OG_SKIP_KIT` | `OG_SKIP_KIT=1` | Skip importing the 16 4K PBR texture packs & HDRIs from `ue5/SourceArt/Kit/`. |
  | `OG_CITY` | `OG_CITY=nyc` or `OG_CITY=skip` | Filter which exported city directories under `ue5/Import/Cities/` to register (or `skip` all). |
  | `OG_FORCE_REIMPORT` | `OG_FORCE_REIMPORT=1` | Re-import assets even if they already exist under `/Game/OpenGrid/`. |

**What `ue5_import_all.py` imports & configures:**
1. `/Game/OpenGrid/Cars/<car_id>/` — `body` (or `nanite_hero` with Nanite), `wheel_FL..RR`, `caliper_FL..RR`, `stock_wing`, and `Parts/*` (14 modular parts per car), plus standardized `SOCKET_*` sockets from `manifest.json`.
2. `/Game/OpenGrid/Kit/` — all 4K PBR material maps (`_Normal` → `TC_Normalmap` linear; `_ORM` → `TC_Masks` linear; `_Height`/roughness/metallic/AO → `sRGB=False`) and `.exr` HDRIs.
3. `/Game/OpenGrid/PostProcess/TokyoNight_UE5_256x16` — configured with `TC_HDR`, `TEXTUREGROUP_ColorLookupTable`, `TMGS_NoMipmaps`, `sRGB=True`.
4. `/Game/OpenGrid/Data/` — imports `car_catalog_dt.csv` (`DT_CarCatalog`, 24 cars) and `parts_catalog_dt.csv` (`DT_PartsCatalog`, 135 modular parts).
5. `PPV_TokyoNight` — unbound `APostProcessVolume` in the active level calibrated from `data/ue5/tokyo_night_postprocess.json` (ACES Filmic, Tokyo Night shadows/midtones/highlights, Convolution Bloom, Hardware Lumen Reflections, wired to `TokyoNight_UE5_256x16`).
6. `/Game/OpenGrid/Cities/<city>/` — imports Landscape weightmaps, logs exact Landscape heightmap `.r16`/`.png` & `Scale/Location` transform, and writes `ue5/Content/OpenGridData/Cities/<city>_pcg_manifest.json`.
7. Saves all newly imported packages via `EditorAssetLibrary.save_directory("/Game/OpenGrid")`.

## Where the first compile can fail, and the fix

The Unreal code was written and checked without Unreal: the core compiles with GCC and (in CI) MSVC, and the Unreal
files compile against a minimal stand-in for Unreal's headers. Unreal's exact API for these points could not be
confirmed and is the most likely source of first-compile errors:

| Where | What | Fix |
|---|---|---|
| `OpenGridVehicleComponent.cpp`, top (`OG_PT_X` etc.) | Chaos physics-thread getters: `GetX()/GetR()/GetV()/GetW()` vs `X()/R()/V()/W()` | swap the two `#if` branches |
| same file, `AsyncPhysicsTickComponent` | `GetBodyInstanceAsyncPhysicsTickHandle(...)` and `Handle.operator->()` | Epic documents the handle struct (`Proxy`, `IsValid()`, `operator->`) in `PhysicsEngine/BodyInstance.h`; adjust the include if needed |
| same file, `RB->AddForce / AddTorque` | physics-thread force calls on `Chaos::FRigidBodyHandle_Internal` | check the signature in `PhysicsProxy/SingleParticlePhysicsProxy.h` |
| `core/src/telemetry.cpp` | Windows socket headers inside Unreal (wrapped with `AllowWindowsPlatformTypes.h`) | if it still clashes, set `bEnableSimHubUdp` aside and compile telemetry without sockets |
| `OpenGridCarPawn.cpp` | `UEnhancedInputComponent::GetBoundActionValue`, `UInputMappingContext::MapKey` | both are standard Enhanced Input calls; check the names in 5.8 |
| `Config/DefaultEngine.ini` | `bTickPhysicsAsync`, `AsyncFixedTimeStepSize` key names | set the same in Project Settings → Physics and copy what the editor writes |

## What to measure (write the numbers into this file)

| Measure | Result |
|---|---|
| Unreal 5.8 install time | |
| First open of the project (shader compile) | |
| C++ build time, clean | |
| C++ build time after editing one .cpp | |
| Shader recompile after changing one material | |
| Editor fps with Lumen on, car in view, 1440p | |
| Ground traces per frame at 50 / 100 / 200 km/h (HUD) and their cost in Unreal Insights | |
| Streaming feel (input lag while driving in Play) | |

## Keep-or-cancel rule (decide before the first hour)

Suggested, change the numbers before you start, not after:

- **Keep** renting if the editor holds **30+ fps** with Lumen on and a one-file C++ change rebuilds in **under 2
  minutes**.
- **Stop and rethink** if a clean build takes **over 15 minutes** or the editor stays **under 30 fps**: you then know
  whether the missing part is CPU (builds, shader compiles) or GPU (editor fps), which is what decides any hardware
  you buy.

## Known gaps (not bugs, not done yet)

- The physics body is a box centred on the CG; its size comes from the car's `.visual.json`, its depth is limited so
  it clears the road. Crash contacts go to the core's damage model, but dents and detaching parts are not drawn yet.
- Wheel visuals use the latest physics step; with async physics they can lag the interpolated body by one step.
- Ground for the physics thread is traced on the game thread once per frame: a plane per ray plus a strip of samples
  5 cm apart along each wheel's path until the next frame (`bUseGroundStrip`). Kerbs resolve as finely as tracing
  every step (core test `ground_strip_drive`). Cost grows with speed: watch "ground traces/frame" on the HUD and the
  frame time in Unreal Insights, and raise `GroundStripSpacingCm` if it is too expensive.
- Cars whose wheels are not separate parts (K-Concept, Tornado GT/GT3) export as one body: no spinning wheels yet.
- Fuel burns (about 1 L a minute flat out), its weight comes off the car (0.745 kg/L; the spec mass is with a full
  tank) and an empty tank cuts the throttle; R repairs and refuels. Inertia stays the spec's as fuel burns.
- Packaging a standalone game needs `data/` copied into `ue5/Content/OpenGridData` first (`DefaultGame.ini` stages
  that folder as loose files).
