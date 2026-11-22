# Open Grid

Realistic-handling street racing sim: an illegal night race through a city, with crash damage and
AI rivals. It runs in the browser, and its vehicle physics is an engine-independent C++ core compiled to WebAssembly.
Open source and non-profit.

**[Play the live demo](https://racing-game-brown-six.vercel.app/)** (desktop Chrome or Edge recommended; keyboard,
controller or wheel)

<!-- Media: drop the files into docs/media/ (shot list: docs/media/SHOTLIST.md), then delete this comment's markers.
[![30-second gameplay video](docs/media/trailer_poster.jpg)](docs/media/trailer.mp4)

| | |
|---|---|
| ![Night race through the city](docs/media/shot_city_night.jpg) | ![Cockpit view at speed](docs/media/shot_cockpit.jpg) |
| ![Crash damage](docs/media/shot_damage.jpg) | ![Telemetry and tyre temperatures](docs/media/shot_telemetry.jpg) |
-->

What is in here:

- **The game**: three.js r186 renderer (WebGPU, with an automatic WebGL 2 fallback), Rapier rigid bodies, parties of
  up to 6 over WebRTC, wheels with force feedback, phones with tilt steering.
- **The physics core** (`core/`): Pacejka tyres fitted to real tyre data, suspension kinematics, a full drivetrain,
  assists, aero, fuel, wet roads, damage. Checked against a real car on every push: see
  **[the validation page](docs/validation.md)**.
- **[open-grid-physics](packages/vehicle-physics/)**: the same core as a drop-in package for any web game (Rapier,
  cannon-es, your own engine), with a three.js + Rapier example.
- **[A bot API](docs/bots.md)**: write a driver in plain JS, race it headless at 100x real time, get on the
  leaderboard.
- **UE5 plugin** (`ue5_plugin/`): the same core inside Unreal Engine 5.

Help wanted: drivers on wheels to judge the handling ([testing program](docs/testing_program.md)), 3D artists,
and bot writers. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## System Requirements

- **Browser**: WebGPU where the browser has it on by default: Chrome and Edge 113+ on Windows, macOS and ChromeOS,
  Chrome 121+ on Android 12+ (Qualcomm and ARM GPUs), Safari 26 (macOS, iOS, iPadOS), Firefox 141+ on Windows
  ([support table](https://web.dev/blog/webgpu-supported-major-browsers)). Everywhere else, including Chrome on Linux,
  the game falls back to WebGL 2 by itself; on Linux you can turn WebGPU on with `chrome://flags` → **Unsafe WebGPU
  Support** (check `chrome://gpu`). `?webgl=1` forces WebGL 2.
- **Development**: Node 20+.
- **Native (`core/` C++17 & UE5 plugin target)**: 64-bit x86_64/ARM64 CPU, 8 GB+ RAM, Vulkan 1.2 / DirectX 12 GPU, CMake 3.16+ & C++17 compiler (GCC/Clang/MSVC).
- **SimHub Telemetry (optional)**: Run `node tools/simhub_udp_bridge.mjs` to stream 60 Hz 311-byte Forza/SimHub Dash V2 UDP packets on `127.0.0.1:20777`, or export MoTeC i2 Pro `.ld` / `.ldx` logs directly from the Pause / Results menu.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full Master Design & Architecture Blueprint and [`docs/MODDING.md`](docs/MODDING.md) for the open-source Car Modding Pipeline.

## Get the code

The repository's history carries the city and car assets (about 1.4 GB). For code work you do not need all of it:

```bash
# everything at the latest commit, older file versions fetched only if you ask for them (fast, recommended)
git clone --filter=blob:none https://github.com/Konstantinos-Chatzistavrou/Open-Grid.git

# just the latest snapshot, no history
git clone --depth 1 https://github.com/Konstantinos-Chatzistavrou/Open-Grid.git

# only the physics: core, the package and the car data
git clone --filter=blob:none --sparse https://github.com/Konstantinos-Chatzistavrou/Open-Grid.git
cd Open-Grid && git sparse-checkout set core packages data/cars data/tires web/wasm web/src/physics
```

## Run the web build

```bash
cd web
npm install
npm run dev          # http://127.0.0.1:5173
```

URL options: `?scale=0.75` (render resolution), `?bloom=0`, `?aa=0`, `?shadows=0`.

Controls: W/S throttle and brake · A/D steer · Q/E shift · Space handbrake · Shift clutch ·
R recover · G menu · C camera · M map · 1 ABS · 2 TC · 3 ESC · 5 auto gearbox · H hide HUD. Controllers, steering wheels and
phones work too (next section).

## Controllers, wheels, phones

The device you last touched drives; mix freely. **Controls** (title screen or pause menu) shows every device and its
settings.

- **Controllers**: Xbox, PlayStation (DualShock 4, DualSense), Switch Pro and any pad with the browser's standard
  mapping. Left stick steer, right / left trigger throttle / brake, bumpers shift, A / ✕ handbrake, B / ○ recover,
  Y / △ camera, X / □ lights, Start / Options pause. Button names in the HUD and menus follow the pad. The D-pad / stick
  and A / B drive the menus. Vibration from the physics (front tyres scrubbing, rear sliding or spinning, ABS, crashes)
  in Chrome / Edge.
- **Steering wheels**: any HID wheel (Logitech, Thrustmaster, Fanatec, Moza, Simucube, Simagic, Asetek, Cammus, PXN,
  OpenFFBoard...). Calibrate once in Controls (centre, full left, each pedal, paddles, buttons, optional H-shifter
  gates); every step finishes by itself, so no mouse is needed. Wheel rotation and the car's lock-to-lock are set there;
  the wheel drives the steering 1:1 with no filtering.
- **Force feedback** (Chrome / Edge on a computer, WebHID): **Connect wheel for force feedback** in Controls, pick the
  wheel once; afterwards it reconnects by itself. The force comes from the physics: steering-rack torque from the front
  tyres' aligning moments (goes light when the fronts let go), speed-dependent damping, a soft lock at the car's steering
  lock, and crash jolts; strength, a safety cap and the direction are adjustable and there is a test pulse. Protocols:
  the USB HID PID force-feedback standard (most direct-drive bases: Moza, Simucube, Simagic, Asetek, Cammus, VRS,
  OpenFFBoard) and Logitech's classic protocol (Driving Force GT, G25, G27, G29, G923 PlayStation version). Thrustmaster
  and Fanatec belt wheels and the Xbox G920 / G923 use closed protocols: steering and pedals work, force feedback
  doesn't. **Untested on real hardware so far** (the byte formats are unit-tested: `node web/tools/test_ffb.mjs`); if
  you try a wheel, please report what happens.
  Linux: the browser needs read / write access to the wheel's `hidraw` device, for example
  `/etc/udev/rules.d/70-opengrid-wheels.rules`:
  ```
  # Logitech, Thrustmaster, Fanatec, Moza, Simagic, Cammus wheels: let the logged-in user open them (WebHID)
  KERNEL=="hidraw*", ATTRS{idVendor}=="046d|044f|0eb7|346e|3670|3416", TAG+="uaccess"
  ```
  then `sudo udevadm control --reload && sudo udevadm trigger` and re-plug the wheel.
- **Phones and tablets**: on-screen steering pad and pedals, or **tilt steering** (Controls → Phone: Tilt; "Set
  straight" / the STRAIGHT button recentres; 35° tilt is full lock). Vibration on crashes and slides on Android.

The compiled physics (`web/src/physics/rs_core.wasm`) is checked in. To rebuild it after changing
`core/`, install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) to `~/emsdk`
and run `npm run wasm`.

## Multiplayer (parties)

Parties are peer to peer (WebRTC through [PeerJS](https://peerjs.com/)): no game server to run. In the game:
**Play → Multiplayer → Create Party**, then send friends the invite link (`…/?party=CODE`, opening it shows a
**Join Party** banner on the title) or the 5-letter code. Up to 6 drivers. The leader picks **Race** (1/3/5/10 laps,
synchronised 3-2-1 once everyone has loaded, live running order, results with everyone's times) or **Free Roam**
together, and can send everyone back to the lobby. The leader's browser forwards each player's car pose and race
progress to the others; other cars carry name tags and are solid: each player's car is a physics body in everyone
else's game, placed where it is now (predicted from its last position and velocity), so cars bump, push and dent each
other. The leader's **Full Realism / Respawns** rule applies to the whole party.

The public PeerJS broker (`0.peerjs.com`) introduces the players and PeerJS's STUN/TURN servers get them through home
routers. To use your own broker instead:

```bash
cd server
npm i
npm start            # PeerJS on http://localhost:9000/peerjs, health at /health (PORT env to change)
npm test             # starts it and checks /health + id issue
```

and open the game with `?peer=your-host:9000/peerjs` (`wss://` prefix when served over HTTPS). Protocol checks over a
real broker: `node web/tools/party_test.mjs` (two headless peers) and `node web/tools/party_game_test.mjs` (two full game
windows), both with the Vite dev server running.

## Playing

**Street furniture is solid**: trees never break; lamp posts, signals, hydrants, bins, shelters and kiosks stop you when
you're slow and shear when you're fast enough, taking real speed off the car and denting it; a sheared pole topples
slowly under its own weight and can land on your car.

**Buildings are solid**: a storefront only gives way to a straight hit at ~45 km/h or more, a brick wall at ~80; anything
less is a hard crash. Breaking through costs most of your speed, wrecks the car, opens a hole into a furnished shop, deli,
apartment or lobby, and brings the ceiling down on top of you.

The title screen has four buttons: **Play**, **Garage**, **Shop** and **Settings**.

**Settings → Driving assists**: presets (Beginner, Intermediate, Expert, Custom) or each aid on its own: ABS (Off / Weak /
Default), traction control (Off, 1-5), stability control, countersteer assist (Off / Weak / Strong), gearbox (Automatic /
Manual) and a **driving line** on the road (Off / Braking zones / Full; blue = keep going, yellow = ease off, red = brake,
from your current speed). The assists are levels of the physics core's own driver aids: the car, tyres and physics are
the same for everyone. They can be changed from the pause menu too; keys 1 / 2 / 3 / 5 switch ABS / TC / stability /
gearbox while driving. Settings also holds the race rules, graphics, controls and the performance tests.

**Garage** (build your car, part by part): Paint (colour, finish, liveries: twin / wide / side stripes, two-tone),
Aero (stock wing, none, ducktail or GT wing; splitter / diffuser / wing in carbon, gloss or matte black, body colour),
Wheels (rim colour and finish, brake calipers), Lights (headlight tint, smoked tail lights, underglow), Glass (tint,
exhaust tips), Driver (the helmet and suit you own) and Tune (performance upgrades). Each tab turns the camera to that
part; every change applies at once (uniforms only, no shader compiles). The driver is drawn in the seat; their gear is
your avatar in a party lobby and in your car on the other players' screens.

**The Shop**: single player shows what each level unlocks; online sells cars, upgrade stages and driver gear (helmets
and suits) for credits once your online level allows them. A DNF earns nothing.

**GPS minimap** (bottom left, M to hide): the real streets heading-up around the car, zooming out with speed, the
race route as the GPS line with the next stretch lit, rivals and players as dots, and turn-by-turn directions with the
street name ("↰ 7th Avenue · 250 m"). Spectating, the map and the city's detail follow the watched car.

**Two careers.** *Single player*: XP from races and free roam; levels unlock cars, upgrade stages and driver gear
for free. *Online*: XP and credits come only from **ranked party races** (6+ players who actually race, at most 2 per
network), kept and checked by the online service (`cloud/`, Cloudflare free plan; see `cloud/README.md`), which times
every ranked race itself. Each career has its own car, upgrades and gear; paint and visual parts are shared, and the online account keeps them so another device shows the same car. The Garage
and Shop switch between them.

**Race rules** (Settings): **Full Realism** (default) or **Respawns**. In Full Realism there is no reset in a race
(AI or party): a wrecked car, 5 s on its roof, or 30 s stuck is a DNF, and you spectate the remaining cars (◀ ▶ or
A / D to switch, Results to end). Respawns: R puts you back on the road, repaired. Free roam always allows R.

The game opens on a title screen that tunes the graphics once for the device (resolution and effects
level, behind a cover; the result is remembered; Auto / Max / Ultra / High / Medium / Low can be set there). Quality never
changes while a car is on screen. **Play** opens the game modes:

- **Race**: a 6-car grid, you (P4) against 5 AI rivals, 1/3/5/10 laps, 3-2-1 start, live position and running order,
  results with everyone's finishing order and gaps.
- **Free Roam**: just you in the open city, lap timer running.
- **Multiplayer**: the party lobby (above).

**Garage** (from the title) is for the car only: pick a car, paint and finish, upgrades (engine, tyres, weight, aero;
applied to the physics data). From there go back to the **Main Menu** or **Continue** to the game modes. Esc pauses:
resume, restart or quit to the main menu. R (when allowed) puts you back on the road where you are (race, party) or at
the start (free roam). The results screen has **Spectate** while others are still racing. Details in `docs/web_port.md`.

## Layout

| Path | What |
|---|---|
| `core/` | C++17 physics + game logic (tyres, drivetrain, assists, damage, AI, race rules), no engine deps, with tests |
| `server/` | Optional self-hosted PeerJS matchmaking for parties (the game defaults to the public broker) |
| `web/` | Browser game: three.js WebGPU renderer, Rapier rigid bodies, WASM bridge (`web/wasm/bridge.cpp`) |
| `packages/vehicle-physics/` | `open-grid-physics`: the core as a standalone WebAssembly package, bot API, examples |
| `data/` | Car and track data (JSON, engine-neutral) |
| `assets_source/` | Blender sources and full-resolution textures |
| `docs/` | Master design blueprint (`DESIGN.md`), car modding pipeline (`MODDING.md`), physics & porting notes |
| `cloud/` | Self-hostable Cloudflare Workers + D1 API (cloud saves, Pink Slip escrow, ranked rooms, moderation reports) |
| `archive/` | Earlier circuit prototype |

## Native core tests

```bash
cmake -S core -B core/build && cmake --build core/build -j && ./core/build/rs_tests
```

## Validation

Handling is matched to a Corvette C7 Z51 and checked on every push: 0-60 mph 3.95 s (real 3.8-3.9 s), 60-0 mph
32.5 m (real 31.7-32.6 m), skidpad 1.00 g (real 1.03-1.11 g), top speed 291 km/h (real ~290). The WebAssembly build
reproduces the native results. Method, all results and what is not validated yet: [docs/validation.md](docs/validation.md);
history in `docs/handling_reference.md` and `docs/web_port.md`.

## Licence

Two licences (details per folder in `LICENSING.md`):

- **Code** (C++ core, TypeScript, shaders, scripts, server): **Apache License 2.0** (`LICENSE`, `NOTICE`, SPDX
  `Apache-2.0`).
- **Everything else we made** (3D models, textures, car and track data, docs): **Creative Commons
  Attribution-NonCommercial 4.0** (`LICENSES/CC-BY-NC-4.0.txt`, SPDX `CC-BY-NC-4.0`): free to share and adapt with
  credit, no commercial use.
- **Third-party material** keeps its own licence, listed in `CREDITS.md`: map data ODbL (OpenStreetMap), the fitted tyre
  data BSD-3-Clause (Project Chrono), original car models CC BY 4.0, city models and textures CC0.
