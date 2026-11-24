# racetrack-database (Monza, Brands Hatch) — source

- Dataset: **racetrack-database** (centre lines, track widths, race lines for 20+ circuits)
- Upstream: https://github.com/TUMFTM/racetrack-database (branch `master`)
- Files stored here: `Monza.csv`, `BrandsHatch.csv` — **byte-identical** to upstream `tracks/` at retrieval.
- Format: header `# x_m,y_m,w_tr_right_m,w_tr_left_m`; one row per centre-line sample (metres).
- Licence: **GNU LGPL-3.0** (full text in `LICENSE`, verified byte-identical to gnu.org/licenses/lgpl-3.0.txt).
  These two CSV files remain LGPL-3.0; they are unmodified.
- Retrieved: 2026-11-24 (see report for hashes).
- Used by: `tools/validation/track_sanity.mjs` (geometry checks + friction-circle corner-speed sanity).
- No modifications were made; do not edit these CSVs in place.
