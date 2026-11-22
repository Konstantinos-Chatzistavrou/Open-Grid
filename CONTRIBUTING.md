# Contributing to Open Grid

Thanks for looking. Open Grid is a non-profit, open-source racing sim run by one person, so small, focused pull
requests get merged fastest. If you are planning something big, open an issue first so we can agree on it.

## Where help counts most right now

| you are | start here |
|---|---|
| a sim racer with a wheel | drive the [live demo](https://racing-game-brown-six.vercel.app/), follow the [testing program](docs/testing_program.md), file **Handling feedback** |
| a programmer | issues labelled [`good first issue`](https://github.com/Konstantinos-Chatzistavrou/Open-Grid/labels/good%20first%20issue); the [bot API](docs/bots.md) |
| into vehicle dynamics | the to-do tests in the [testing program](docs/testing_program.md), layer 1 and 2 |
| a 3D artist | the [art bible](docs/art_bible.md), then issues labelled `art` |

## Get the code

The history carries the game's city and car assets (about 1.4 GB), so clone without old file versions:

```sh
git clone --filter=blob:none https://github.com/Konstantinos-Chatzistavrou/Open-Grid.git
```

Physics only: add `--sparse`, then `git sparse-checkout set core packages data/cars data/tires web/wasm web/src/physics`.

## Build and test

```sh
# C++ physics core (CMake 3.16+, a C++17 compiler)
cmake -S core -B core/build -DCMAKE_BUILD_TYPE=Release && cmake --build core/build -j && ctest --test-dir core/build

# the browser game (Node 20+)
cd web && npm ci && npm run dev        # http://127.0.0.1:5173

# the physics package and the bot race
cd packages/vehicle-physics && npm test
```

CI runs all of these plus the asset licence check (`node tools/assets/check_licences.mjs`) and the car validator
(`node tools/validate_mod.mjs --dir data/cars`). A pull request must pass them.

Changing `core/` or `web/wasm/bridge.cpp`? Rebuild the WebAssembly with `bash web/wasm/build.sh` (needs
[Emscripten](https://emscripten.org/)) and commit `web/src/physics/rs_core.{js,wasm}` with your change.

## Pull requests

- One topic per pull request. Say what changed and how you checked it (test output, a screenshot, a lap time).
- **Physics changes** must keep `rs_tests reference` and `rs_tests characters` passing. If a change moves a number in
  [docs/validation.md](docs/validation.md), update the page and say why the new number is closer to reality, with a
  source.
- **Visual changes**: a before/after screenshot at the same spot, and the frame rate (`docs/performance.md`).
- Keep the style of the code around you. No new dependencies without asking.
- Sign off your commits (`git commit -s`). It certifies the [Developer Certificate of Origin](https://developercertificate.org/):
  that you wrote the change or have the right to submit it under the project's licences.

## Licences: what you agree to

Your contribution is published under the licence of the folder it goes into (details in [LICENSING.md](LICENSING.md)):

- **Code** (C++, TypeScript, JavaScript, shaders, scripts): **Apache-2.0**.
- **Art, car and track data, docs**: **CC BY-NC 4.0**. Open Grid is non-profit and keeps its art non-commercial.
- The bots and examples in `packages/vehicle-physics/` marked CC0 stay CC0.

Third-party material must allow that: your own work, CC0 or CC BY for art (credited in `CREDITS.md`); MIT, BSD,
Apache-2.0 or similar for code. Never: Fab / Megascans, paid marketplace assets, ripped game assets, Google Maps /
Street View / Earth imagery, real brand logos. See the [art bible](docs/art_bible.md).

## Conduct

Be kind and specific. Criticise the work, not the person. Harassment, discrimination or personal attacks get you
removed from the project. To report a problem privately, contact the maintainer through his GitHub profile
([@Konstantinos-Chatzistavrou](https://github.com/Konstantinos-Chatzistavrou)).
