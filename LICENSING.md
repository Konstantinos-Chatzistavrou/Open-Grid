# Licensing

This repository holds two kinds of work, under two licences.

| What | Licence | Full text |
|---|---|---|
| **Software**: all source code, shaders, build and processing scripts, HTML / CSS, configuration, JSON schemas | **Apache License 2.0** (SPDX `Apache-2.0`) | [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) |
| **Everything else we made**: 3D models, textures, materials, car and track data, rival / prop data, documentation, images, text | **Creative Commons Attribution-NonCommercial 4.0 International** (SPDX `CC-BY-NC-4.0`) | [`LICENSES/CC-BY-NC-4.0.txt`](LICENSES/CC-BY-NC-4.0.txt), https://creativecommons.org/licenses/by-nc/4.0/ |

Copyright © 2026 Open Grid contributors.

## What the CC BY-NC 4.0 part means

You may copy, share and adapt the models, data and docs, **for non-commercial purposes only**, and you must **give
credit**: name "Open Grid contributors", link to this repository
(https://github.com/Konstantinos-Chatzistavrou/Open-Grid) and to the licence, and say whether you changed anything.
Selling them, putting them in a paid or ad-funded product, or any other use primarily intended for commercial
advantage needs written permission from the copyright holder. The Apache-2.0 licence of the code does not extend to
these files.

## Which files are which

**Apache-2.0 (software)**
- `core/` (C++ physics), `web/src/`, `web/wasm/`, `web/tools/`, `web/index.html`, `web/*.json`, `web/*.ts`
- `cloud/` (online service), `server/`, `tools/`, `assets_source/scripts/`, `godot_ext/` (our code; `godot-cpp` keeps its MIT licence),
  `game/` scripts and scenes, `archive/` code
- `data/schema/`, `vercel.json`, `.gitignore`

**CC BY-NC 4.0 (assets, data, documentation)**
- `web/public/assets/cars/`, `web/public/assets/city/`, `web/public/assets/garage/`, `assets_source/models/`,
  `assets_source/textures/`, `assets_source/cars/` (the car build settings)
- `data/cars/`, `data/tracks/city.json`, `data/tracks/city_route.json`, `data/rivals.json`, `data/city_props.json`,
  `web/public/data/`
- `docs/`, `README.md`, `CREDITS.md`, `PLAN.md`, `PORTING.md`, this file
- the "Open Grid" logo and title artwork (as artwork only: see **Name and logo** below)

**Third-party material keeps its own licence** (details and attributions in [`CREDITS.md`](CREDITS.md)):
- **Validation track geometry**: `data/validation/racetrack-database/` is TUMFTM/racetrack-database under
  **LGPL-3.0** (licence text in that folder). It is third-party data, not covered by either licence above; keep its
  notice with it and do not present it as CC BY-NC 4.0 or as Apache-2.0.
- **Map data**: `web/public/assets/nyc/`, `web/public/assets/cities/`, `data/tracks/{nyc,london,paris,tokyo,losangeles}_route.json`
  are built from OpenStreetMap, © OpenStreetMap contributors, **Open Database Licence 1.0** (ODbL: the derived database
  stays ODbL, the attribution "© OpenStreetMap contributors" must be shown), plus NYC Open Data (public domain) for New York.
- **Car models adapted from CC BY 4.0 originals** (Vela GT, K-Concept, Kestrel GT, Harrier GT, Hayate, Basilisk V12,
  Strix GT7): our changes are CC BY-NC 4.0; the original authors' credit lines in `CREDITS.md` must be kept, and the
  unmodified originals remain available from their authors under CC BY 4.0.
- **City and garage models and textures adapted from CC0 originals** (Poly Haven, ambientCG): our processed versions are
  CC BY-NC 4.0; the originals remain CC0 at their sources.
- **Fonts** (Barlow): SIL Open Font License 1.1.
- **Fitted tyre file** `data/tires/audi_245_40R18_pac2002.tir`: Project Chrono, **BSD-3-Clause**
  (`data/tires/LICENSE-projectchrono.txt`).
- **Basis Universal transcoder**, `web/public/libs/basis/`: Apache-2.0.
- Libraries loaded at run time (three.js MIT, Rapier Apache-2.0, meshoptimizer MIT, PeerJS MIT) keep their licences.

## Name and logo

"Open Grid" (two words; handles and package names write it "Open-Grid" or "OpenGrid"), the logo, the "OG" app icon
and the title artwork identify this project and its maintainer. **Neither licence above grants any right to use them**: Apache-2.0 says so in section 6,
and CC BY-NC 4.0 in section 2(b)(2) ("patent and trademark rights are not licensed"). Even though the logo artwork
is CC BY-NC like the other art, that covers copying the picture, not using it as the name or mark of another
product.

You can:
- use, fork and modify the code under Apache-2.0, and the assets under CC BY-NC 4.0, and keep the credit lines
  those licences ask for;
- say where something came from, for example "based on Open Grid", "a fork of Open Grid", or link to
  https://github.com/Konstantinos-Chatzistavrou/Open-Grid;
- keep an unmodified mirror or GitHub fork under its original name.

You cannot, without written permission:
- call a modified version, a fork that is distributed as a product, or a game or tool built from this code or art
  "Open Grid", "OpenGrid" or "Open-Grid", or use a name that could be confused with it ("Open Grid 2", "Open Grid
  Pro", "Open Grid Online", "Open Grid Official", a look-alike domain or store page);
- use the logo or the "OG" icon as your own logo or icon, or in a way that suggests the project made, approved or
  endorses your version.

Pick your own name and your own logo; the code is yours to build on.

## History

Until 2026-11-16 the code was AGPL-3.0-or-later; from this version on it is Apache-2.0. The assets, data and docs have
been CC BY-NC 4.0 throughout.

## Contributions

New contributions are accepted under the same split: code under Apache-2.0, everything else under CC BY-NC 4.0.
GPL-family code (GPL / LGPL / AGPL) cannot be added to the code; MIT / BSD / Apache-2.0 / ISC / zlib / CC0 code can
(keep its notice in `CREDITS.md`).
