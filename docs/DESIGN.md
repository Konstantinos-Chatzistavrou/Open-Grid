# OpenGrid — Master Architecture & Game Design Blueprint

> Living design specification for **OpenGrid** (WebGPU Lite/Demo + Unreal Engine 5 Native + Apache-2.0 C++ Physics Core).

---

## 1. Technical Architecture & Platform

- **Engine Strategy**:
  - **Unreal Engine 5 (Native Target)**: Used strictly as a rendering, UI, and audio shell. No core engine modifications.
  - **Engine-Independent C++17 Physics Core (`core/`)**: Runs as a high-frequency (`240–1000 Hz`) plugin via `rs::ue5` (`core/include/rs/ue5_bridge.hpp`), outputting live SimHub UDP telemetry (`core/include/rs/telemetry.hpp`) and MoTeC i2 Pro (`.ld` / `.ldx`) logs.
  - **WebGPU / Three.js Build (`web/`)**: Maintained as the instant-play **Lite / Demo** web build running the exact same C++ core compiled to WebAssembly (`rs_core.wasm`).
- **License**:
  - **Code**: `Apache-2.0` (legally compatible with Unreal Engine 5 and open for community modding).
  - **Original Models, Data & Docs**: `CC BY-NC 4.0`.
- **Multiplayer Sync (Zero Head-Start Ready Machine)**:
  - Strict **Ready-State** barrier: the host/server cannot trigger the `3-2-1` countdown until every connected client returns an `"Assets & Level Loaded"` RPC. Nobody gets a head start based on hardware speed or host status.
- **Split-Screen**:
  - Supported on desktop/console displays **27 inches or larger** with two controllers/wheels. Automatically drops LOD bias and shadow resolution while split-screen is active to preserve frame rate.
- **Cross-Platform Server-Authoritative Accounts & Anti-Save-Scumming**:
  - Central backend (`cloud/` Cloudflare Workers + D1, or self-hosted Community Server) ties identity, cash/XP, garage inventory, liveries, and Pink Slip escrow to the account—not a mutable local file.
  - Pink Slip and Cash wagers lock server-side in `wager_escrows` before launch so Alt+F4 / disconnects cannot roll back a loss.

---

## 2. World, Map & Environment Design

- **Map Philosophy**: **100% real-scale road widths** derived from OpenStreetMap data. Narrow alleys and downtown streets stay brutally narrow—no artificial Forza-wide safety lanes.
- **Free Roam (Social Sandbox — 16 Players Max + AI Traffic, Zero Police)**:
  - Hub-based open world (GT7 / NFS Heat style), capped at **8–16 real players** to keep custom-livery VRAM budgets sane.
  - Focus on cruising, car meets, Speed Traps & Drift Zones with Global/Party Leaderboards, and spontaneous headlight-flash (`[F]`) 1v1 Cash or Pink Slip drags from traffic lights.
  - 2D minimap overlay expanding to a full city map for GPS waypoint setting.
- **Instanced Race Events (8–12 Players — GTA Online Matchmaking Flow)**:
  - Driving into a city **Race Node** (or selecting Matchmaking) pulls the player out of Free Roam into a dedicated instanced Race Event with optional **Tactical Cop Mode** (forced ON in high-patrol downtown districts like Midtown NYC and Central London). Finishing seamlessly returns the player to Free Roam.
- **Time, Weather & Realistic Traffic Curve**:
  - **1:4 Time Scale**: 30 real minutes = 2 in-game hours.
  - **Real-Life Seasons**: Synced to real-world calendar month (December = snow/ice grip patches; July = hot high-grip tarmac).
  - **Weather**: 1-in-5 chance of rain per race with shader-driven puddles and wet tire grip physics (no heavy volumetric rain cost).
  - **Time-of-Day Traffic Density**:
    - `22:00 – 01:00`: Medium/Dense (taxis, delivery trucks — high-speed weaving).
    - `01:00 – 03:00`: Sparse (open avenues — ideal for drags).
    - `04:00 – 05:30`: Near-zero (pure hotlap & limit testing).
- **5-Floor Car Meet Garages**:
  - Instanced, ultra-optimized 5-floor parking hubs (8–10 cars per floor). Walkable custom driver avatars, open hoods/trunks, RP emotes (sit on hood, lean on door, wave, inspect engine), revving, proximity voice chat, custom Spotify/YouTube Music playlist radio, and direct race launches.

---

## 3. The Garage, Maintenance & Anti-Griefing Economy

- **Car Modding Pipeline First**: Start with 20–30 meticulously modeled cars and empower the community with an open drop-in modding pipeline (`docs/MODDING.md`) to reach 500+ vehicles organically.
- **Persistent Multiplayer Damage & Repair Bills**:
  - Structural crash damage sustained in multiplayer/race events is **saved per car** and carries over until repaired in the Garage—directly discouraging ramming and griefing.
  - **Zero Ghosting (100% Solid Physical Contact Always)**: Never ghost players, AI rivals, traffic, wrecked cars, or police cruisers (no arcade/GT-style pass-through ghosting). Rammers are deterred by real physical damage, repair/tow bills, and Bad-Sport SR quarantine—not intangible cars.
- **The "Totaling" Conundrum — Tow Truck Fee**:
  - If your car is totaled and undrivable during an event, a **Tow Truck Fee** (`$1,200` / `250 XP`) is deducted from race winnings (or billed to recover the car to the Garage).
- **In-Game Race Insurance**:
  - Optional pre-race **Insurance Premium** (`$350` / `75 XP`). If you wreck or total your car during that race, **repair and tow truck fees are reduced by 50%**.
- **Night Runners-Inspired Garage Mechanics**:
  - **Auction House**: Buy used cars with opaque condition tags (*Missing Keys*, *Airbags Deployed*, *Oil Leak*) and high-mileage engine wear.
  - **Walkable Garage (Default ON)**: Walk to the hood, oil cap, or storage locker to interact.
  - **Maintenance Loop**: Overheating/redlining/nitrous overuse degrades engine health; engine swaps unlock when worn out, and extreme upgrades trade reliability for power.
  - **Stance & Suspension**: Camber, ride height, and spring stiffness matching physics hitboxes 1:1.
  - **Weight Reduction**: 3 stages (stripped interior → carbon panels).
  - **Ignition & Rev Button**: Dedicated garage button to crank the starter and rev exhaust notes live.

---

## 4. Customization, Debranding & Content Creator Suite

- **Debranding & IP Safety**: Never rip assets from BeamNG or copyrighted games. Use original fictional silhouettes inspired by iconic eras and generic OEM+ part names (e.g., *Aftermarket V8 Twin-Turbo*) to avoid trademark/design-patent disputes.
- **Content Creator Tools**:
  - **4K Photo Mode (`[P]`)**: Free unlocked camera, FOV, exposure, DoF focus/aperture, shutter speed, roll, Hide UI (`[H]`), and `3840×2160` PNG export.
  - **5-Minute Cinematic Replay (`[T]`)**: Rolling 300 s buffer, timeline scrubber, TV Pan / Chase / Bumper / Orbit / Custom Catmull-Rom Keyframe Track, and `.webm` video export.
  - **Driver Avatar Gear**: Customizable Helmet, Accent, Racing Suit, Gloves, and Shoes with 1-click **Match Car Livery**.

---

## 5. Physics, Damage, Sim Telemetry & Tactical Police AI

- **Core Physics (`core/`)**: High-frequency Pacejka MF 5.2/6.1 tires, suspension kinematics, digressive dampers, brake/tire thermodynamics, per-panel deformation, destructible street poles and storefront breaches.
- **Tactical Police AI**: Zero rubber-band 200 km/h arcade ramming. Police obey real vehicle physics and execute rear-quarter **PIT maneuvers**, **flanking pincers**, and **physical 2-cruiser roadblocks** with skill escape gaps.
- **Crash Cinematics**: Slow-motion wreckage focus on totaling before transitioning to spectate.
- **Nitrous**: Purchased per liter; overusing spikes engine heat and wear.
- **Sim Racing Telemetry**:
  - **UDP Output (Port 20777)**: 311-byte Forza/SimHub Dash V2 packets driving SimHub dashboards, bass shakers, and wind simulators.
  - **MoTeC i2 Pro Export (`.ld` + `.ldx`)**: 18-channel telemetry export for post-race braking, slip, tire temp, and suspension analysis.

---

## 6. Localization, Accessibility, Moderation & Community Servers

- **Localization (L10n)**: UE5 StringTable-compatible JSON tables (`data/i18n/`) with English, German (text-expansion safe), Spanish, French, and Japanese from day one.
- **Accessibility**: Protanopia / Deuteranopia / Tritanopia colorblind palettes (Driving Line & Minimap), `85%–130%` HUD UI Scaling, and 100% keyboard + controller remapping.
- **Moderation**: Automated hate-speech filtering on custom usernames/plates combined with an in-game **Player Report System** (`Hate Speech Livery/Plate`, `Ramming / Griefing`, `Cheating`) backed by `POST /v1/report`.
- **Community Hosted Servers**: Because OpenGrid is open-source with zero pay-to-win monetization, players and leagues can self-host both the PeerJS party broker (`server/`) and the Cloudflare/D1 API (`cloud/`) at zero cost to the project.
- **Retention**: Daily challenges, party XP/CR bonuses, separate Heat/Reputation track, and Annual Ranked Season Prestige resets (ranks reset, **never** wiping owned cars or garage builds).
