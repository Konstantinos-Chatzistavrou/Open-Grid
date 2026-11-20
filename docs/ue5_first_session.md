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
3. Install **Git**, **Git LFS** (`git lfs install`) and **Node.js 20+**.
4. `git clone https://github.com/Konstantinos-Chatzistavrou/Racing-Game` and check out `ue5-prep` (or `main` once
   merged).
5. Export the cars for Unreal:
   ```
   cd tools/ue5 && npm install
   cd ../../web && npm i --no-save basis_universal      (only needed for the Vela GT's KTX2 textures)
   cd ../tools/ue5 && node export_cars_for_ue.mjs        (writes ue5/Import/<car>/, about 170 MB, gitignored)
   ```
6. Right-click `ue5/OpenGrid.uproject` → **Generate Visual Studio project files**, open the solution, build
   **Development Editor | Win64**. Or open the .uproject directly and let the editor build it.
7. Press **Play** in any level. With no floor under the start point the game mode spawns a 2 km test floor and a
   sun. The top-left HUD line must say **fixed-step physics**; "FRAME-TICK FALLBACK" means the async physics
   setting did not apply (Project Settings → Physics → Tick Physics Async).
8. Drive: W/S or the triggers, A/D or the left stick, Q/E or the bumpers to shift (automatic gearbox is on), Space
   or A for the handbrake, R or B to recover.
9. Import the car: drag `ue5/Import/kestrel_gt/body.glb`, the four `wheel_*.glb` and the four `caliper_*.glb` into
   the Content Browser (folder `Content/Cars/KestrelGT`). Create a Blueprint child of `OpenGridCarPawn`, set
   **Body Mesh Asset**, **Wheel Meshes** (FL, FR, RL, RR) and **Caliper Meshes**, and set it as the game mode's pawn
   (Blueprint child of `OpenGridGameMode`, or World Settings). If the body faces the wrong way, set
   **Body Mesh Rotation** (yaw 90 / -90 / 180).
10. Save a level with a floor (File → New Level → Basic) so later sessions don't rely on the test floor.

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
- Ground under each wheel is traced once per rendered frame and intersected as a plane on the physics thread: exact
  on flat or smoothly sloped ground, approximate across sharp edges (kerb lips) between frames.
- Cars whose wheels are not separate parts (K-Concept, Tornado GT/GT3) export as one body: no spinning wheels yet.
- Packaging a standalone game needs `data/` copied into `ue5/Content/OpenGridData` first (`DefaultGame.ini` stages
  that folder as loose files).
