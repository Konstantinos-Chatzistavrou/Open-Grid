# Open Grid tyre registry

A collection of Pacejka Magic Formula tyre files (`.tir`, MF 5.2 / 6.1 / 6.2) that says **where each one came from**, **what licence it is under** and **what the solver finds in it**. Browse it at `/registry/` of the web build
(`web/public/registry/index.html`, generated), or read `web/public/registry/index.json`.

**Status, read first.** On 2026-11-27 it has 20 entries and **none is a measurement we can vouch for**: they are model parameters published by Project Chrono, example files from MFeval whose data origin is not stated, and two synthetic test tyres.
Measured open tyre data is scarce. The registry exists to collect it, with credit and with the measurement described, so that someone who needs a tyre for a simulation can see what they are getting.

## What an entry is

A folder `registry/tyres/<id>/` with an `entry.json` and, for a new tyre, the `.tir` file next to it (the seeded entries point at files already in `data/`). `<id>`: lower-case letters, digits and single hyphens.

| field | meaning |
|---|---|
| `id`, `name`, `size`, `class` | `id` equals the folder name; `class` e.g. "road car", "formula student", "heavy truck" |
| `file` | path of the `.tir`, relative to the folder |
| `provenance` | one of `measured`, `fitted-from-measurements`, `published-model`, `synthetic`, `unknown` (below) |
| `source` | where the data came from, in words you could be held to |
| `measurement` | **required** for `measured` and `fitted-from-measurements`, at least 40 characters: the rig or data source, the conditions (loads, speeds, pressures, camber range), who measured it; for a fit, also the fit report (`rs_tirfit --report`) |
| `contributor` | `{ "name": ..., "url": ... }`: who is credited |
| `licence` | SPDX identifiers joined by `AND`: `CC0-1.0`, `CC-BY-4.0`, `BSD-3-Clause`, `BSD-2-Clause`, `MIT`, `Apache-2.0`, `ISC` (commercial use allowed) or `CC-BY-NC-4.0` (non-commercial, shown as such) |
| `copyright` | required unless `CC0-1.0`: who must be credited |
| `notice_file` | required for BSD, MIT, Apache and ISC: the licence text that must travel with the file |
| `notes`, `added` | free text; the date `YYYY-MM-DD` |

**Provenance is a claim by the contributor.** The maintainer checks that it is stated, that it is plausible and that the measurement is described. The maintainer does not re-measure anything, so a `measured` entry is as good as the contributor's description;
a claim shown to be false gets the entry corrected or removed. **Facts are not claims:** the page's geometry, peak grip, cornering stiffness and "finite cases" come from the reference solver (`rs_conformance tyre-summary`, the same code the conformance suite checks against MFeval).

## Add a tyre

1. Make the file. From your own measurements: the [Tyre Lab](../web/public/lab/index.html) or `rs_tirfit` (`docs/own_tyre_data.md`). If the fit started from a template, keep the template's licence notice in the file (`rs_tirfit --notice`).
2. Add `registry/tyres/<id>/entry.json` and the `.tir`. Open licences only; no data you do not have the right to share.
3. `node tools/registry/build.mjs --check` (needs `cmake --build core/build --target rs_conformance`). It refuses a missing provenance or measurement description, an unknown licence, a missing notice, an unloadable file, a file with fewer than half of the conformance cases finite, and a tyre with no usable grip.
4. `node tools/registry/build.mjs` regenerates the page, `index.json` and the downloadable files; commit them with the entry.
5. Open a pull request. Sign off your commit (`git commit -s`, see `CONTRIBUTING.md`).

To correct or remove an entry you contributed, open an issue or a pull request. The registry holds no personal data beyond the name and link you choose to be credited under.

## What it does not claim

That any tyre here matches a real tyre: that is what `provenance` is for. That the solver is the commercial TNO solver: it is checked against MFeval (`docs/verify.md`). That a tyre is fit for a purpose: a file fitted to a narrow range of load, slip and camber is only valid inside it, and the file's own limits say so.

## Licence of this folder

This README and the `entry.json` metadata are CC BY 4.0 (`LICENSES/CC-BY-4.0.txt`; credit "Open Grid tyre registry, https://github.com/Konstantinos-Chatzistavrou/Open-Grid"). Every tyre file keeps the licence its entry states; the checker and generator in `tools/registry/` are Apache-2.0.
