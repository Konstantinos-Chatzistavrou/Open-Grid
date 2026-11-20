# OpenGrid Content Pipeline (Unlimited Cars & 1:1 Cities · Zero Copyright / Trademark Issues)

This pipeline lets you ingest **unlimited custom cars** and **unlimited 1:1 real-world cities** in a single command — with **zero manual TypeScript edits** and built-in copyright, trademark, spoiler-separation, widebody-fitting, road-clearance, and tree-spacing hygiene.

---

## 1. Adding Unlimited Cars (`tools/pipeline/ingest_car.py`)

### Legal & Zero-Trademark Rules (Enforced Automatically)
- **Allowed sources ONLY**: Original models, **CC0**, or **CC BY 4.0** (attribution recorded automatically in `CREDITS.md`).
- **Blocked automatically**: `CC BY-NC`, `CC BY-ND`, `Editorial`, `All Rights Reserved`, or any real OEM manufacturer/model name in `--name` or `--id`.
- **Automatic Blender De-Branding & Restyling**:
  1. Deletes every source emblem, logo, badge, wordmark, script, and license plate mesh/material.
  2. Applies subtle proportional FFD silhouette restyling (nose taper/length, roof drop, rear haunches) so zero OEM trade dress carries over.
  3. Stamps a **sculpted 3D OpenGrid Brand Crest** (`badge_nose` & `badge_rear`) flush to the actual nose and rear deck surface normals via `BVHTree.ray_cast`, matching your chosen original marque (`valenza`, `falcorn`, `kaze`, `kronos`, `aether`).
  4. Separates any stock spoiler cleanly into a dedicated `wing` node (using bmesh connected-component island extraction so garage spoilers **never** stack on top of a stock spoiler).
  5. Detects exact rear exhaust pipe coordinates (`exhaust_nozzles`) for photorealistic Mach-diamond exhaust-only flames.
  6. Compresses with `@gltf-transform/cli` (`dedup -> prune -> meshopt --level high`), generates physics + visual JSON, registers in `data/cars/catalog.json` (auto-loaded at runtime for Garage, Auction House, Engine Audio & Progression), and runs `tools/validate_mod.mjs`.

### Command
```bash
python3 tools/pipeline/ingest_car.py \
  --id apex_rs \
  --name "Valenza Apex RS" \
  --brand valenza \
  --src /path/to/cc_by_car.glb \
  --engine v10_screamer \
  --engine-label "5.2L NA V10" \
  --price 185000 \
  --sp-level 8 \
  --power-scale 1.15 \
  --paint "#d62828" \
  --license "CC BY 4.0 · Artist Name (Sketchfab URL)"
```

### Separating a Merged Stock Spoiler (if the donor GLB baked the spoiler into the body mesh)
Pass `--spoiler-boxes` with glTF-space bounding boxes (`X` left/right, `Y` up, `Z` forward) — `blender_prepare_car.py` extracts whole connected mesh islands cleanly with zero torn faces:
```bash
--spoiler-boxes '[{"mesh":"body","min":[-0.95,0.86,-2.30],"max":[0.95,1.15,-1.90],"min_ratio":0.75}]'
```

### Retrofitting Existing Hero GLBs (Standalone Blender Pass)
```bash
blender -b --factory-startup -P tools/pipeline/blender_prepare_car.py -- \
  --mode retrofit \
  --src input_uncompressed.glb \
  --out output_raw.glb \
  --brand kaze \
  --spoiler-boxes '[...]'
```

---

## 2. Adding Unlimited 1:1 Real-World Cities (`tools/pipeline/ingest_city.py`)

### Automated Cleanups & Quality Gates
- Registers city config in `tools/nyc/cities.json` (single source of truth).
- Auto-downloads OSM `.osm.pbf` from `--pbf-url` (Geofabrik / BBBike) if not already cached.
- Runs the full 1:1 tile pipeline:
  1. `extract.py` (metric Transverse Mercator OSM extraction)
  2. `mask.py` (drivable city footprint + real-city fringe)
  3. `ground.py --all --meshopt` (planar 1:1 roads, curbs, sidewalks, parks, water)
  4. `buildings.py --all` (LOD0 + LOD1 buildings + road-clipped colliders)
  5. `props.py --all` (street furniture pushed off asphalt + **Poisson spatial-hash tree spacing** + out-of-tile cleanup)
  6. `build_index.py` (`index.json`, 1:1 minimap `map.json`, closed race loop `<id>_route.json`)
- Runs automated quality gates:
  - `check_road_clear.py` (zero street props encroaching on road asphalt)
  - Route/wall obstruction verification + tile/edge/sample count checks
  - Plus runtime safeguards in `pavementFilter.ts` (`12.5 m` street trees / `9.0 m` park groves) and `streamer.ts` (skips any concave building OBB or interior wall crossing a `map.json` road centerline).
- Writes `data/cities/extra.json` — automatically merged into `CITIES[]` by `web/src/cities.ts` at startup (**zero manual TypeScript edits**).

### Command
```bash
python3 tools/pipeline/ingest_city.py \
  --id monaco \
  --name "Monaco" \
  --district "Monte Carlo & Port Hercule" \
  --country MC \
  --lat 43.7384 --lon 7.4246 \
  --radius-m 1600 \
  --pbf-url https://download.geofabrik.de/europe/monaco-latest.osm.pbf \
  --drive right \
  --style european \
  --landmarks '[{"name":"Casino Square","x":180,"y":120},{"name":"Port Hercule","x":-40,"y":-110}]'
```

---

## 3. Garage Parts & Widebody Compatibility
Every ingested car automatically inherits:
- **Sculpted body-conforming widebody kits** (`sculptedWidebodyFlares` in `web/src/scene/custom.ts`) sampled against the car's exact height-stratified `BodyFit.bodySideAt(y, z, side)` surface with matching dual-layer metallic clearcoat paint, recessed inner arch liners, optional rivets, and **automatic flush wheel-track widening**.
- **Deck-anchored aftermarket spoilers** (`BodyFit.wingBase()`) that hide the car's separated `wing` node cleanly whenever any garage wing or `"No wing"` is chosen.
- **Fitted splitters, diffusers, side skirts, custom rims, brake calipers, engine swaps, and exhaust-only flames**.
