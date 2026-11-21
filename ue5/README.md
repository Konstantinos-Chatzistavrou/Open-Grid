# OpenGrid for Unreal Engine 5

The Unreal front end for the same physics core as the web build (`../core`). Unreal draws, plays sound and handles
input; handling, damage, AI and race logic stay in the core so both builds feel the same.

| Path | What |
|---|---|
| `OpenGrid.uproject` | the project, pinned to UE 5.8; loads the physics plugin from `../ue5_plugin` |
| `Source/OpenGrid/` | the car pawn (`OpenGridCarPawn`) and game mode (`OpenGridGameMode`) |
| `Config/` | fixed-step async physics at 240 Hz, Lumen, Enhanced Input |
| `../ue5_plugin/OpenGridPhysics/` | `UOpenGridVehicleComponent`: the core inside Unreal |
| `../tools/ue5/export_cars_for_ue.mjs` | turns the web car models into Unreal-importable glTF (`Import/`, gitignored) |
| `THIRD_PARTY_ASSETS.md` | list of assets that may not be committed (they live in `Content/ThirdParty/`) |

First session, step by step: [`docs/ue5_first_session.md`](../docs/ue5_first_session.md).
What to build now vs. what to stop in WebGPU: [`docs/ue5_roadmap.md`](../docs/ue5_roadmap.md).

## Rules

- **The repo is public.** Nothing that may not be redistributed goes in it: Fab and Marketplace assets, paid content,
  private notes. Put them in `Content/ThirdParty/` (gitignored) and list them in `THIRD_PARTY_ASSETS.md`.
- **No Git LFS in the public repo** (`.gitattributes`): strangers cloning would consume the owner's monthly LFS bandwidth
  quota. Large 4K masters live on GitHub Releases (`node tools/assets/masters.mjs fetch`), and Unreal exports are
  generated locally (`tools/assets/build_kit_*.py`, `node tools/ue5/export_cars_for_ue.mjs`).
- **Car data is not copied.** The vehicle component reads `data/cars/*.json` from the repo (`../data`). Only a
  packaged game needs a copy in `Content/OpenGridData`.
- **No physics in Blueprints or Unreal-side C++.** If handling needs a change, it goes in `core/` with a test, and
  both builds get it.
