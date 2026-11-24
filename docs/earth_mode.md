# Earth mode: free roam on the whole planet (design notes, 2026-11-24)

Status: **design only, nothing built yet.** Goal: an option in Game Modes ("Earth") that drops you anywhere on the planet
at 1:1 scale and lets you drive in any direction, in the browser, with no install and no paid server.

## 1. What BeamNG.Earth does (the reference)

Source: https://github.com/tecnagamer/beamng.earth (beta, BeamNG 0.40.x). It does **not** load the planet. It keeps a
circle of world around the car and builds that circle on demand.

| part | what it does |
|---|---|
| Companion server (Python + Rust) | BeamNG's Lua cannot reach the internet, so a local program downloads elevation, imagery and map data, turns them into meshes in a local flat frame and streams them to the game over a local socket |
| Mod (Lua) | loads the tiles as meshes, keeps an invisible physics ground under the car, moves the world origin with the car, blends level-of-detail changes |
| Data | elevation: national lidar where open, otherwise Copernicus 30 m; imagery: national orthophotos, USDA NAIP, otherwise Sentinel-2 cloudless; roads, buildings, water: Overture + OpenStreetMap; trees: canopy height model |
| LOD | finer terrain near, coarse far; building tiers (simple past ~1 mi, skyline beyond, tallest towers to ~12 mi); distant forests reuse stock tree clumps |
| Floating origin | the origin follows the car so physics stays precise far from where it started |
| Cache | map cache up to 20 GB by default; works offline only where already cached |
| Teleport | prefetches before you confirm; a rough first version of the ground lets you spawn before detail is built |

Why it runs on a normal PC: at any moment it holds a few km of world, not the planet. The planet is a *recipe* plus public
data, not a file.

## 2. Why we cannot pre-bake the Earth like our cities

Our city pipeline (`tools/nyc/`, docs/cities.md) bakes tiles offline. Budget from docs/nyc_tiles.md: all of Manhattan
(~59 km2, 1,168 tiles) is about 300 MB. Land is ~149 million km2, about 2.5 million Manhattans, i.e. roughly 750 TB at
Manhattan density. Even if the average land tile is 100x lighter than Manhattan, that is ~7 TB, which we cannot host at
0 EUR (and could not keep current when OpenStreetMap changes). So Earth mode **must build tiles at the moment they are
needed**, either on the player's machine or on a server. We have 0 EUR, so: on the player's machine, in Web Workers.

## 3. Architecture for the web ("better" where it is realistic)

### 3.1 Build in the browser, not on a companion server
- A browser can fetch static files and read **byte ranges** from a single large file (PMTiles). No server code needed.
- Port the tile builder from Python to TypeScript/WASM and run it in a pool of Web Workers (ground, buildings, props,
  collision). Output = the same tile contract the game already loads (docs/nyc_tiles.md: `ground.glb`, `bld.glb`,
  `far.glb`, `col.json`, `props.json`, terrain height grid), but produced in memory, not shipped.
- Same code path for every tile, so a tile is a pure function of (tile id, data version, builder version). That makes
  caching and multiplayer consistency simple (section 3.7).
- The Python stages are ~6,600 lines (ground.py 1,064; buildings.py 1,106; props.py 872; terrain.py 890). The port is the
  biggest job in this plan. Do it stage by stage and compare against the Python output tile by tile (golden tests).

### 3.2 Data sources (all free, all static files; licences to re-check before shipping)
| layer | candidate | notes |
|---|---|---|
| Elevation | AWS Terrain Tiles (Terrarium PNG, already used by `terrain.py`), Mapterhorn (global PMTiles in Terrarium encoding, from the Protomaps team; planet file `download.mapterhorn.com/planet.pmtiles`; licence not stated on the page I read, check GitHub) , Copernicus DEM GLO-30 (already used for Crete) | Copernicus is a surface model: keep the bare-earth filter from `terrain.py` |
| Roads, buildings, water | **OpenFreeMap** public vector tiles (OpenMapTiles schema, OSM data, ODbL, MIT-licensed software, no key, no stated request limit on the public instance; offline bulk download capped at 3,000 tiles / 50 MB per download, 4 parallel requests, unique User-Agent). Later: Overture (themes under ODbL or CDLA-Permissive; check per theme) or our own PMTiles cut with Planetiler | OpenMapTiles has no lane counts and simplified building attributes. Our city builds use OSM tags (lanes, width, height); expect lower fidelity at first |
| Imagery (rural ground colour, coastlines) | EOX Sentinel-2 cloudless. **2016 layer: CC BY 4.0. 2018-2025 layers: CC BY-NC-SA 4.0 (non-commercial, share-alike)**; WMTS can be used directly, attribution required, requests capped at 4096 px | Open Grid is non-profit, but the share-alike and non-commercial terms must be read before we ship; the 2016 layer is the safe default |
| Place search | GeoNames (CC BY 4.0) city list baked into the repo, searched offline | Nominatim's usage policy forbids heavy use: do not call it from the game |
| Routing / GPS | none at first | OSRM's public demo server is not for production traffic. Later: a WASM router on the tiles we already have |
| Trees | none at first, then a land-cover/canopy layer | ESA WorldCover is a candidate (verify licence) |

### 3.3 Frames, precision and the curved Earth
- Tiles are built in their own local east-north-up frame, but **vertex positions are computed from true 3D (ECEF)
  coordinates** and only then expressed in the tile frame. Result: the curvature of the Earth is already in the mesh
  (about 0.1 m of drop 1.2 km from a tile centre), shared tile edges match exactly, and a tile is placed in the world
  with one rigid transform.
- The **active frame** is a local tangent plane near the car. When the car is more than ~5 km from the active origin,
  rebase: shift the origin, update every tile's transform, shift Rapier bodies/colliders and the car state. float32 is
  millimetre-accurate within a few km, so rendering and the physics core stay precise. The C++ core already works in
  doubles.
- Gravity stays -Z of the active frame; distant tiles are tilted by the real curvature, so the horizon drops away
  correctly. (BeamNG.Earth handles curvature on the server side for the horizon; ours falls out of the maths.)
- Slippy-map tiles (Web Mercator) are only a **lookup key**. Their metric size shrinks with latitude (a z14 tile is
  ~2.4 km at the equator, ~1.2 km at 60 deg), so use them to ask the data sources, never as the game's metric grid.

### 3.4 Streaming and LOD
- Reuse the streamer (`web/src/scene/nyc/streamer.ts`: separate near / far / collider rings with hysteresis, forward bias,
  a 2.5 ms per-frame commit budget, nothing compiled while driving).
- Add a **quadtree terrain LOD** (coarse far, 8 m grid near; the existing export grid) so the horizon is real terrain, not fog.
- Buildings: full near, prisms mid, skyline silhouettes far (same tiers as our `bld/far/hlod`).
- Teleport: fetch the coarse level first and spawn on it (a heightfield from the DEM), then refine under the car. The
  collider ring must exist before the car is released (never drop the player on empty ground).

### 3.5 Physics
- Ground = Rapier height field per tile, from the same grid as the visuals (already how `terrain.ts` works for cities).
- Colliders only within ~1 tile of the car; building boxes as today.
- Rebase hook (section 3.3) must move the whole Rapier world in one step, between physics ticks, never mid-step.

### 3.6 Caching and hosting at 0 EUR
- Player side: Origin Private File System / IndexedDB cache of built tiles keyed by (tile id, data version, builder version),
  with a size cap and LRU eviction.
- Our side: nothing but the static site. Data comes from the public hosts above. Do **not** copy the planet into our own
  storage: one full vector or terrain planet file is tens to hundreds of GB.
- Be a good citizen on public services: unique User-Agent, cache aggressively, cap parallel requests, and have a
  documented fallback if a source disappears. If the game grows, ask OpenFreeMap/Protomaps/Mapterhorn before relying on
  them at scale, and consider donating.
- Optional later: a shared "popular places" tile cache on a free static host (city centres, famous roads) so first loads
  are instant. Tiles are deterministic, so it is only a cache.

### 3.7 Multiplayer and determinism
- Because a tile is a pure function of its inputs, every player builds the **same** world from the same data version.
  Pin the data versions (e.g. a given Overture release, a dated OpenFreeMap build or our own PMTiles) in the party lobby.
- Never use floating-point-order-dependent randomness in builders: seed per tile from its id.

## 4. Where we can honestly beat BeamNG.Earth, and where we cannot

| | BeamNG.Earth | Open Grid Earth mode (plan) |
|---|---|---|
| Install | Python server + Rust module + launcher | none, open a link |
| Data work | years of per-country sources (lidar, LoD2 in DE/CH/EE/Vienna, IGN, NVDB, NYC 3D model, NAIP) | start with global OSM + Copernicus; add national sources later |
| Visual fidelity | mature | will start far behind. Do not claim "better" until we measure |
| Cost for the player | disk cache (20 GB default), RAM 16 GB | browser memory budget (see section 6) |
| Multiplayer | beta via BeamMP | deterministic builds (section 3.7) |
| Physics | stock BeamNG | Open Grid core, which is validated (docs/validation.md) |

Our edge is deployment (a link), a validated physics core and deterministic shared worlds. The data pipeline is where
they are ahead, and that gap closes only by adding more open national sources over time.

## 5. Phases (each ends with a test we can run)

0. **Spike (terrain only).** Pick a coordinate (start with Imbros Pass, Crete, because it already exists as a baked city to compare against).
   Fetch Terrarium tiles, build a height grid and mesh in a worker, drive on a Rapier height field. *Exit:* 60 s drive, no
   hitch over 40 ms, heights within 1 m of the baked tile.
1. **Roads.** Vector-tile roads draped on the terrain (width by road class, bridges/tunnels flagged). *Exit:* a coastal
   road matches the baked version of a city we have, side by side.
2. **Buildings.** Footprints extruded with height tags, then the facade shader as today. *Exit:* a Manhattan block built from OpenFreeMap vs our baked tile: footprint overlap and height error reported.
3. **Rebasing and teleport.** Floating origin, ECEF-correct tiles, search by place name (GeoNames). *Exit:* drive 100 km at 200 km/h: no seam steps above 2 cm, no physics glitches at each rebase.
4. **Imagery and land cover** for rural ground colour; water and coastlines. *Exit:* colour matches satellite within an agreed tolerance on 5 test areas.
5. **Trees, airports, rail, level crossings, weather** (all optional layers).
6. **GPS routing, traffic from the road graph, multiplayer lobby pinning data versions.**
7. **Fidelity upgrades:** national lidar/LoD2 sources (one per phase), OSM lanes/width from our own PMTiles cut.

## 6. Budgets and risks

- Same budgets as cities (docs/nyc_tiles.md): <= 400 draw calls, <= 500k triangles, 30 fps on the i3 laptop. Add: worker
  build time per tile (target < 150 ms), network per player (bytes per km driven: measure in phase 0).
- Network at speed: at 90 m/s a ~1.2-2.4 km tile is crossed every 13-27 s, so fetch/build must run ahead (forward bias already exists).
- Data gaps: deserts, oceans and polar areas have few features; define what "empty" looks like (terrain only) and
  how the edge of data is shown (no walls: the world is open).
- Water: driving into the sea needs a rule (shore walls like our cities, or swimming = wreck).
- Accuracy: Copernicus 30 m is a surface model and smooths hairpins; docs/cities.md "rural mode" (carving roads into the grid) shows the fix.
- Legal (see LICENSING.md): OpenStreetMap-derived data is ODbL. If we **publish** tiles built from it, they are a derived
  database and must be offered under ODbL with attribution; tiles built and cached on the player's machine are not
  redistributed by us. Satellite imagery licences differ by year (section 3.2). Credit every source in CREDITS.md and the in-game credits.
- Public services can change terms or vanish: keep the source list in one config file and cover each with a fallback.

## 7. Not verified yet (check before building)
- Mapterhorn data licence and usage limits (the page I read states neither).
- OpenFreeMap's actual layer content at high zoom (building heights, road classes) in the schema they serve.
- Overture licence per theme (their FAQ says some themes are ODbL, some CDLA-Permissive, and points to an attribution page).
- Whether EOX WMTS has rate limits for a browser game.
- Browser memory and OPFS quotas on phones.

## Sources
- BeamNG.Earth: https://github.com/tecnagamer/beamng.earth , https://vgtimes.com/games/beamng.drive/files/99349-.html
- OpenFreeMap: https://openfreemap.org/
- PMTiles: https://docs.protomaps.com/pmtiles/
- Mapterhorn: https://protomaps.com/blog/mapterhorn-terrain/
- Overture FAQ: https://overturemaps.org/about/faq/ (attribution page: https://docs.overturemaps.org/attribution/)
- EOX Sentinel-2 cloudless licence: https://cloudless.eox.at/license-non-commercial
