# OpenGrid — Master Architecture & Game Design Blueprint

> Living design specification for **OpenGrid** (Unreal Engine 5.8 Native Target + WebGPU Browser Build + Apache-2.0 C++20 Physics Core + Non-Profit Cloudflare Online Network).

---

## 1. Technical Architecture & Platform

- **Engine Strategy**:
  - **Unreal Engine 5.8 (Native Target)**: Rendering, Lumen/Nanite, MetaSounds, World Partition, and CommonUI shell (`ue5/`, `ue5_plugin/OpenGridPhysics/`). No engine-fork modifications.
  - **Engine-Independent C++20 Physics Core (`core/`)**: Runs at `240–1000 Hz` via `rs::ue5::AsyncVehicleBridge` (`core/include/rs/ue5_bridge.hpp`), verified by 128 CTests (Linux GCC Release, GCC ASan+UBSan `-O1` on push & `-O0` nightly, Windows MSVC + Unreal single-unit `RsCoreUnity.cpp`, and weekly 25-car `RS_ALL_CARS=1` + `RS_GAME_MODELS=1`). Outputs live SimHub UDP telemetry (`core/include/rs/telemetry.hpp`) and MoTeC i2 Pro (`.ld` / `.ldx`) logs.
  - **WebGPU / Three.js r187 Build (`web/`)**: Full instant-play browser client running the exact same C++20 core compiled to WebAssembly (`rs_core.wasm`) over Rapier 3D rigid bodies, with automatic WebGL 2 fallback.
  - **Dual A/B Audio Engine**: Live-switchable between **43 ear-verified real recorded CC BY 3.0 supercar audio stems** and our **Thermodynamic Engine-Sim + 192-Tap Exhaust Muffler IR** WASM synthesizer (`core/src/engine_audio.cpp`), plus 48 kHz/24-bit UE 5.8 MetaSounds stems (`docs/ue5_audio_metasounds.md`).
- **License**:
  - **Code**: `Apache-2.0` (compatible with Unreal Engine 5 and open community modding).
  - **Original Models, Data & Docs**: `CC BY-NC 4.0`.
- **Free Hobby-Project, 100% Ad-Free Online Model**:
  - **100% Free Everywhere (Zero Paywalls, Zero Trials, Zero Ads):** All 25 cars, all cities, single-player career, Garage, Auction House, 2P Split-Screen, Friends, Private P2P lobbies (`PeerJS` WebRTC), and Community Ranked Splits (`cloud/` on Cloudflare Workers + D1 + Durable Objects free plan, best-effort) cost nothing. Optional **[GitHub Sponsors](https://github.com/sponsors/Konstantinos-Chatzistavrou)** buys no perks. No human-in-the-loop stewarding is promised — race control, fault scoring, and replay checks are automated.
- **Multiplayer Sync (Zero Head-Start Ready Machine)**:
  - Strict **Ready-State** barrier: the host cannot trigger the `3-2-1` countdown until every connected client signals loaded assets. Nobody gets a head start from faster hardware.
- **Split-Screen**:
  - Local 2-player Split-Screen (horizontal TV or vertical desktop) with 2 controllers or shared keyboard, scaling LOD/shadow budgets automatically.
- **Cross-Platform Accounts & Anti-Save-Scumming**:
  - Real Email + Password authentication (`PBKDF2-HMAC-SHA256`, 100k iterations, in-place guest upgrade) on `https://opengrid.opengrid-racing.workers.dev`.
  - Monotonic `save_version` checks (`409` on rollback) and server-side two-party Pink Slip / Cash wager escrow (`wager_escrows`) prevent local tampering or Alt+F4 loss evasion.

---

## 2. Competitive Online Moat & FIA Race Control

Built to deliver fair, structured competitive racing without paywalls or ads (`cloud/src/ratings.ts`, `core/src/race_control.cpp`):

- **Dual Rating & License Ladder**:
  - **Driver Rating (`DR`):** Glicko-2 skill rating (`800–3500`, Grade `E → S`) with dynamic Rating Deviation (`RD`) and Strength-of-Field (`SOF`) weighting.
  - **Fault-Aware Safety Rating (`SR 0.00–4.99`):** Distinguishes at-fault divebombs/ramming (`4x`) from innocent victims via `evaluate_collision_fault` (**`0x Victim Shield`**).
  - **License Progression (`R → D → C → B → A → PRO`):** MPR race requirements, fast-track promotions, and **Bad-Sport Quarantine** (`splitNo = -1`) isolating habitual rammers until they complete consecutive clean corners.
- **Scheduled Official Series & Balanced SOF Splits**:
  - Recurring cadence (`Rookie GT Sprint` 20m, `GT3 World Championship` 45m, `Hypercar Pro` 60m, `Multiclass Endurance` 120m) with automatic SOF split seeding and seasonal drop-week championships (best 8 of 12 rounds).
- **Automated Fault Scoring & Season Disconnect Jokers**:
  - Automated `0x Victim Shield` collision evaluation and Bad-Sport Quarantine (`splitNo = -1`) run with zero human stewards required.
  - Each driver receives **2 Season Disconnect Jokers** to protect their rating against unfair internet drops.
- **FIA Race Control (`core/src/race_control.cpp`)**:
  - Green, Local Yellow, Blue, Black, Meatball (severe damage), FCY/Safety Car flags, track-limit slowdowns, pit-lane speed limiter/service timers, and `EnduranceStintTracker` for live pit-box driver swaps.
- **Zero-Cost Race Spotter & P2P Voice Chat**:
  - Client-side iRacing-style proximity spotter (`web/src/spotter.ts`: *"Car left / right / three wide / clear"* + flag calls) and WebRTC PeerJS Push-to-Talk (`[Z]`) / proximity Car Meet voice chat.
- **Deterministic Anti-Cheat (`core/tools/opengrid_replay_verifier.cpp`)**:
  - Free GitHub Actions cron replays pending top-3/flagged recordings through `rs::AuthorityServerSim` (400 Hz physics) and `rs::AntiBotAnalyzer` (steering-lock, 240 Hz sawtooth macro, and zero-latency reflex detection).

---

## 3. World, Map & Environment Design

- **Physics-Up Assist Spectrum & Graduation Ladder (`core/src/controls.cpp`, `web/src/assists.ts`)**:
  - Single coherent `rs_core` physics model for every player (zero dumbed-down alternate physics).
  - **Controller Steering Filter (`Off / Sim / Assisted`)**: Caps requested steer angle near the front tyres' peak slip angle around instantaneous front-axle travel (`delta_free`) on gamepads/keyboards (always `Off` / 1:1 on steering wheels) so pad players feel planted and responsive instead of washing out into dead understeer.
  - **Corner Braking Assist (`Off / Low / High`)**: Optional beginner on-ramp driven by the Driving Line corner-speed profile (`RawInput::recommended_speed_ms`), paired with live HUD intervention lamps (`ABS · TC · ESC · STR · BRK`), Assist-Off Skill Bonuses (`0/7..7/7`), and post-race **Assist Graduation Tips** guiding players from `Beginner → Intermediate → Expert`.
- **Dual-World Discipline (Sanctioned Day Circuits + Underground Night Streets)**:
  - **☀ Sanctioned Day Circuit Mode**: Closed circuit racing with zero cops, zero civilian traffic, FIA track rules, Glicko-2 DR, Fault-Aware SR, and Multi-Week Championships.
  - **🌙 Underground Night Street Mode**: 1:1 real-scale OpenStreetMap cities, Heat 0–5, Tactical Police AI, AI traffic, 5-floor Car Meets, and spontaneous `[F]` 1v1 Cash/Pink Slip drags.
- **Map Philosophy**: **100% real-scale road widths** derived from OpenStreetMap + Copernicus DEM GLO-30 across **5 cities** (NYC Midtown, London, Paris, Tokyo, Los Angeles). Narrow streets stay genuinely narrow.
- **Free Roam (Social Sandbox — 16 Players Max + AI Traffic, Zero Police)**:
  - Cruising, 5-floor Car Meets, Speed Traps & Drift Zones with leaderboards, and spontaneous headlight-flash (`[F]`) 1v1 Cash or Pink Slip street drags.
  - Expandable 2D GPS minimap with turn-by-turn street directions and click-to-waypoint routing.
- **Instanced Race Events (Up to 12 Players)**:
  - Dedicated grids with optional **Tactical Cop Mode** (mandatory ON in high-patrol downtown districts) and seamless return to Free Roam.
- **Time, Weather & Realistic Traffic Curve**:
  - **1:4 Time Scale** (30 real minutes = 2 in-game hours), real-world calendar seasonal surface effects, dynamic rain/puddle physics (`WorldClock` + `rs_core` wet grip), and realistic late-night traffic curves (`22:00–01:00` dense → `04:00–05:30` near-empty).
- **5-Floor Car Meet Garages**:
  - Walkable custom driver avatars, open hoods/trunks, RP emotes, live revving, proximity WebRTC voice chat, and direct race launches.

---

## 4. Garage, Maintenance & Anti-Griefing Economy

- **25-Car Modular Fleet + Open Modding Pipeline**: 25 original/de-branded cars with explicit 3D suspension hardpoints, per-car transmissions, and tracked CC-BY/CC0 licence ledgers, plus a validated drop-in modding pipeline (`docs/MODDING.md`).
- **Persistent Damage, Repair Bills & Zero Ghosting**:
  - **100% Solid Physical Contact Always** — no arcade pass-through ghosting. Crash damage carries over per car until repaired in the Garage, discouraging ramming alongside Bad-Sport SR quarantine.
  - **Tow Truck Fee (`$1,200` / `250 XP`)** on totaling; optional pre-race **Insurance (`$350` / `75 XP`)** cuts repair and tow bills by 50%.
- **Garage & Live Auction House**:
  - **Walkable Garage** (default ON) with interactive hood/oil/locker zones, live **Ignition & Momentary Rev**, **Dyno**, engine swaps, turbo/manifold upgrades, 3-stage weight/aero/tyre/engine mods, and physics-matched stance/camber/ride height.
  - **CS2-Style Supply & Demand Auction House**: Rotating salvage/swapped/limited lots with float wear grades, sparkline price charts, and transparent resale appraisal.

---

## 5. Customization, Creator Suite, Telemetry & Accessibility

- **Content Creator Suite**:
  - **4K Photo Mode (`[P]`)**: Unlocked free cam, FOV, exposure, DoF, roll, Hide UI (`[H]`), `3840×2160` PNG export.
  - **5-Minute Cinematic Replay (`[T]`)**: Rolling 300 s buffer, timeline scrubber, TV/Orbit/Keyframe cameras, `.webm` export.
  - **Driver Avatar Gear**: Customizable Helmet, Visor, Suit, Gloves, Shoes with 1-click **Match Car Livery**.
- **Tactical Police AI**: Obeys real `rs_core` physics (zero arcade rubber-banding) using rear-quarter PIT maneuvers, flanking pincers, and 2-cruiser roadblocks with skill escape gaps.
- **Sim Racing Telemetry**:
  - **SimHub UDP (Port 20777)**: 311-byte Forza/SimHub Dash V2 stream (`tools/simhub_udp_bridge.mjs`).
  - **MoTeC i2 Pro Export (`.ld` + `.ldx`)**: Resampled, bounded multi-channel telemetry logs from Pause / Results.
- **Localization & Accessibility**:
  - UE5 StringTable-compatible `data/i18n/` (EN, DE, ES, FR, JA), Protanopia / Deuteranopia / Tritanopia colorblind palettes, `85%–130%` HUD scaling, full keyboard/pad/wheel remapping, and automated in-game race-control penalties.
