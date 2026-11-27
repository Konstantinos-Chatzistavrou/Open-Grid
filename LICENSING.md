# Licensing

This repository holds two kinds of work, under two licences.

| What | Licence | Full text |
|---|---|---|
| **Software**: all source code, shaders, build and processing scripts, HTML / CSS, configuration, JSON schemas | **Apache License 2.0** (SPDX `Apache-2.0`) | [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) |
| **The conformance suite and tyre-validation material**: `conformance/README.md`, `conformance/SPEC.md`, `docs/verify.md`, `docs/paper/conformance_method.md`, `registry/README.md` and the registry's `entry.json` metadata (every tyre file keeps the licence its entry states), `data/validation/mf62/` (the case list and the two synthetic tyres; the recorded MFeval output in `golden/` keeps MFeval's BSD notice and we add no restriction) | **Creative Commons Attribution 4.0 International** (SPDX `CC-BY-4.0`): commercial use allowed, credit required | [`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt), https://creativecommons.org/licenses/by/4.0/ |
| **Everything else we made**: 3D models, textures, materials, car and track data, rival / prop data, documentation, images, text | **Creative Commons Attribution-NonCommercial 4.0 International** (SPDX `CC-BY-NC-4.0`) | [`LICENSES/CC-BY-NC-4.0.txt`](LICENSES/CC-BY-NC-4.0.txt), https://creativecommons.org/licenses/by-nc/4.0/ |

Copyright © 2026 Konstantinos Chatzistavrou and the Open Grid contributors. The names "Open Grid" / "OpenGrid", the logo and the "OpenGrid Conformant" mark are not licensed by any of the above: [`TRADEMARKS.md`](TRADEMARKS.md).

## What the CC BY 4.0 part means

You may copy, share and adapt the conformance suite's documents and the validation data, **including commercially**, if you **give credit** as
"OpenGrid conformance suite by Konstantinos Chatzistavrou, https://github.com/Konstantinos-Chatzistavrou/Open-Grid, CC BY 4.0", link the licence, and say whether you changed anything. The conformance runner and the reference adapter are code and stay Apache-2.0.
`LICENSES/CC-BY-4.0.txt` is the official plain-text licence from https://creativecommons.org/licenses/by/4.0/legalcode.txt, copied unmodified on 2026-11-27 (sha256 `9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411`).
Material that was published under CC BY-NC 4.0 before this change (the case list and synthetic tyres, 2026-11-27) stays available to whoever already has it under those terms; new copies are CC BY 4.0.

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
- **Physics reference data**: `data/powertrain/` (Project Chrono BSD-3; EPA final drives public domain) and
  `data/physics/{airfoils,aero_reference,inertia-reference,brakes-reference,torque-reference}.json` (NACA, NHTSA,
  FMVSS public domain; DrivAer, Energies and the Zenodo engine curve CC BY 4.0) keep their own licences. They are
  reference/validation data, not part of our CC BY-NC 4.0 set.
- **Validation track geometry**: `data/validation/racetrack-database/` and `data/validation/tracks-extra/` are TUMFTM/racetrack-database under
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
- **Fonts** (Barlow, Roboto): SIL Open Font License 1.1 (`web/public/fonts/LICENSE-Roboto-OFL.txt`).
- **Project Chrono vehicle data** (`data/reference/chrono-vehicles/`, 546 verbatim files: the numeric JSON and `.tir` of its `data/vehicle`):
  **BSD-3-Clause** (`LICENSE-projectchrono.txt`). Meshes, textures and the OpenCRG roads are not imported (docs/chrono-data.md).
- **Fitted tyre file** `data/tires/audi_245_40R18_pac2002.tir`: Project Chrono, **BSD-3-Clause**
  (`data/tires/LICENSE-projectchrono.txt`).
- **MFeval 4.3.1** (Magic Formula 5.2 / 6.1 / 6.2 evaluator, MATLAB), `tools/validation/mfeval/`, the six source files vendored unmodified: **BSD-3-Clause**, Copyright (c) 2020, Marco Furlan Tassara
  (`tools/validation/mfeval/LICENSE.txt`; text reproduced below). Also the six example tyre files that ship in the same package (`tools/validation/mfeval/doc/examples/*.tir`), under that same licence;
  the package does not say where their data comes from. Only the reference for validating the tyre evaluator; not part of the game, and not covered by the licences above.
- **`data/validation/mf62/`**: the case list and the two synthetic MF 6.1 / 6.2 tyre files are ours (CC BY 4.0, from 2026-11-27; before that CC BY-NC 4.0) except that the synthetic tyres contain the coefficients of the Project Chrono Audi 245/40 R18
  PAC2002 tyre (BSD-3-Clause, Copyright (c) 2016 Project Chrono Development Team, notice in each file header and `data/tires/LICENSE-projectchrono.txt`); `golden/*.csv` are MFeval's numeric output for those tyres
  (generated with `tools/validation/mfeval_reference.m`), and are measurements of nothing: they only record what MFeval returns.
- **`core/src/mf62.cpp` / `core/include/rs/mf62.hpp`** (our MF 5.2 / 6.1 / 6.2 evaluator) are Apache-2.0 code **written against MFeval's source**, so MFeval's BSD notice applies to them as well (below). Its
  first cross-reference, MFeval.jl (**MIT**, Copyright (c) 2026 MFeval.jl contributors, https://github.com/matheusft/MFeval_julia), asks to be cited as "MFeval.jl - High-Performance Pacejka Magic Formula Tyre
  Model Implementation": done here and in `CREDITS.md`.
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

## Third-party notices for the tyre evaluator

MFeval, `tools/validation/mfeval/LICENSE.txt` (BSD 3-Clause), which also governs `core/src/mf62.cpp` and `core/include/rs/mf62.hpp` as works written against it:

```
Copyright (c) 2020, Marco Furlan Tassara
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution

* Neither the name of  nor the names of its
  contributors may be used to endorse or promote products derived from this
  software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

MFeval.jl, https://github.com/matheusft/MFeval_julia (MIT), used as a first cross-reference while writing `mf62.cpp`:

```
MIT License

Copyright (c) 2026 MFeval.jl contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

ATTRIBUTION REQUIREMENT:
When using this software in research, publications, or derivative works, please
provide appropriate credit by citing:
"MFeval.jl - High-Performance Pacejka Magic Formula Tyre Model Implementation"
and include a reference to this repository.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
