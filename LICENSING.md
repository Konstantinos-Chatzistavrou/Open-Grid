# Licensing

Everything this project made is licensed under the **Apache License, Version 2.0** (SPDX `Apache-2.0`): full text
in [`LICENSE`](LICENSE), attribution notice in [`NOTICE`](NOTICE).

Copyright © 2026 OpenGrid contributors.

## What that covers

Our own work in every folder:
- **Software**: `core/` (C++ physics), `web/src/`, `web/wasm/`, `web/tools/`, `web/index.html`, `web/*.json`, `web/*.ts`,
  `cloud/` (online service), `server/`, `tools/`, `assets_source/scripts/`, `godot_ext/` (our code; `godot-cpp` keeps its
  MIT licence), `game/` scripts and scenes, `archive/` code, `data/schema/`, `vercel.json`
- **Assets, data and documentation**: our models, textures and materials (`web/public/assets/cars/`,
  `web/public/assets/city/`, `assets_source/models/`, `assets_source/textures/`), car and track data (`data/cars/`,
  `data/tracks/city*.json`, `data/rivals.json`, `data/city_props.json`), `docs/`, `README.md`, `CREDITS.md`, `PLAN.md`,
  `PORTING.md`, this file, and the "OpenGrid" logo and title artwork

You may use, copy, change and redistribute it, also commercially, under the Apache-2.0 terms: keep the licence and the
copyright / NOTICE, state the files you changed, no trademark rights are granted.

## Third-party material keeps its own licence

Details and attributions in [`CREDITS.md`](CREDITS.md). Apache-2.0 applies to our changes; the originals stay under
their authors' terms, and their credit lines must be kept.
- **Map data**: `web/public/assets/nyc/`, `web/public/assets/cities/`, `data/tracks/{nyc,london,paris,tokyo,losangeles}_route.json`
  are built from OpenStreetMap, © OpenStreetMap contributors, **Open Database Licence 1.0** (ODbL: the derived database
  stays ODbL, the attribution "© OpenStreetMap contributors" must be shown), plus NYC Open Data (public domain) for New York.
- **Car models adapted from CC BY 4.0 originals** (Vela GT, K-Concept, Kestrel GT, Harrier GT, Hayate, Basilisk V12,
  Strix GT7): the original authors' credit lines in `CREDITS.md` must be kept; the unmodified originals remain available
  from their authors under CC BY 4.0.
- **City and garage models and textures adapted from CC0 originals** (Poly Haven, ambientCG): the originals remain CC0.
- **Fonts** (Barlow): SIL Open Font License 1.1.
- **Fitted tyre file** `data/tires/audi_245_40R18_pac2002.tir`: Project Chrono, **BSD-3-Clause**
  (`data/tires/LICENSE-projectchrono.txt`).
- **Basis Universal transcoder**, `web/public/libs/basis/`: Apache-2.0.
- Libraries loaded at run time (three.js MIT, Rapier Apache-2.0, meshoptimizer MIT, PeerJS MIT) keep their licences.

## Earlier versions

Until 2026-11-16 the code was AGPL-3.0-or-later and the assets, data and docs CC BY-NC 4.0. Copies obtained under those
terms stay under them; from this version on everything we made is Apache-2.0.

## Contributions

New contributions are accepted under Apache-2.0 (section 5 of the licence). Code under GPL-family licences cannot be
added any more; MIT / BSD / Apache-2.0 / ISC / zlib / CC0 code can (keep its notice in `CREDITS.md`).
