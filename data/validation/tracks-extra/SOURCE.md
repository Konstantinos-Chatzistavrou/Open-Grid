# Extra track geometry (validation)

Source: TUMFTM/racetrack-database, commit `e59595d1f3573b30d1ded6a08984935b957688e0`.
URL: https://github.com/TUMFTM/racetrack-database

Licence: **GNU Lesser General Public License v3.0** (full text in `LICENSE`; the upstream repository's licence,
verified via the GitHub API: `license.spdx_id = LGPL-3.0`). These CSVs are third-party data: they are **not**
covered by Open Grid's CC BY-NC 4.0 licence, and redistribution must keep this notice and the LGPL text.
They are used for validation only and are not linked into the engine.

Files are stored unmodified. Format: `x_m,y_m,w_tr_right_m,w_tr_left_m` — a closed centre line in metres with the
track half-widths to each side. Published lengths used as a cross-check: Spa 7004 m, Silverstone 5891 m,
Suzuka 5807 m.

| file | sha256 (first 16) |
|---|---|
| Spa.csv | `27c51454e81780a7` |
| Silverstone.csv | `952673dfa772427b` |
| Suzuka.csv | `b4d3e325edd1e85e` |

Check with `node tools/physics/brake_reference.mjs --tracks data/validation/tracks-extra`.
