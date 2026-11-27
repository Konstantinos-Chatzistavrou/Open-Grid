# Platforms: one game, two builds, shared world

Decision (2026-11-27): Open Grid is **one game with several clients**, not separate games.

| client | who gets it | what it is |
|---|---|---|
| Web, **lite** | phones, tablets, anything with a touch screen as its main input (`pointer: coarse`) | the same game and physics, lighter rendering: medium preset, 30 fps cap, shorter streaming distance, touch / tilt controls, slim HUD |
| Web, **full** | laptops and PCs (mouse and keyboard, controller, steering wheel) | WebGPU full build, all graphics presets, wheel and force feedback |
| UE 5.8, **native** | PC (later) | the same physics core and data, with Unreal rendering. Plan: `docs/ue5_roadmap.md`, `docs/ue5_first_session.md` |

Override the choice with `?touch=1` (lite) or `?touch=0` (full). `/?companion=1` opens the small leaderboard / profile page.

## Cross-play: what is shared and what must stay consistent

Shared by every client: the physics core (`core/`, C++ compiled to WebAssembly for the browser and used natively in
UE5), the data in `data/` (cars, tyres, tracks, surfaces), and the online backend (`cloud/`: accounts, ratings, rooms,
leaderboards). Each player's client simulates its own car and sends its state; ranked results are checked by the
server-side replay verifier, so clients do not need bit-identical floating-point output.

Rules that keep cross-play possible:
1. Anything that changes how a car drives (track shape, kerbs, surface grip, collision shapes) comes from shared data,
   never from a visual mesh that only one client has.
2. New gameplay rules go into `core/` or `data/` first, not into TypeScript or Blueprints, so every client gets them.
3. All clients in a lobby use the same data version.
4. The lite build changes visuals only (resolution, effects, draw distance, UI). It never changes physics, tyres,
   grip or damage.

If keeping the web build working ever blocks UE5 work, or nobody plays it, retire it then; do not decide it now.
