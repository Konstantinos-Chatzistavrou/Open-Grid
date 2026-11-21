# Real-scale cities (1:1)

Since 2026-11-15 the game streams one of its real cities (17 since 2026-11-21), all built at 1:1 from open data by the same pipeline
(`tools/nyc/`, which started as the New York build: docs/nyc_tiles.md, nyc_ground.md, nyc_buildings.md, nyc_props.md).

| id | city | area built | buildings | heights from |
|---|---|---|---|---|
| `nyc` | New York | all of Manhattan, shore to shore (1,168 tiles) | 45k | NYC Open Data official roof heights |
| `london` | London | Hyde Park Corner to the Tower, Waterloo to Holborn | 31k | OSM tags (47 %), neighbours, typical floors |
| `paris` | Paris | Arc de Triomphe / Trocadéro to Notre-Dame | 40k | OSM tags (64 %), neighbours |
| `tokyo` | Tokyo | Shibuya to Shinjuku (Harajuku, Yoyogi, Omotesando) | 48k | OSM tags (21 %), neighbours, typical floors (small lots 2-3 storeys) |
| `losangeles` | Los Angeles | Downtown (Bunker Hill, Financial District, Broadway, Little Tokyo) | 9k | OSM tags (97 %, LA County import) |

The player picks the city on the Game Modes screen (`web/src/cities.ts`; the choice is kept on the device, `?city=<id>`
overrides it for tests). Changing city reloads the game: tiles, colliders, routes and materials belong to one city.

## Edges: no fake city

Before this, New York's real tiles covered 2 x 2.8 km of Midtown and everything beyond was the procedural grid of
`infiniteNyc.ts`, whose streets did not meet the real ones ("the map"). Now:

- every city's `index.json` says `"fill": false` and the streamer adds no procedural tiles;
- Manhattan is built whole: its edge is the shore. `tilelib.drivable()` = land (+ asphalt hanging over the river within
  40 m: FDR Drive, bridge approaches); bridges and tunnels off the island are closed at the shore;
- the other cities are built over their `area` box plus a 200 m fringe of real buildings and streets (`fringe_m`); the
  drivable area is the box, plus bridge decks over rivers inside it (the Thames and Seine bridges are drivable, the river
  is not);
- `buildings.py` writes invisible wall boxes along the edge of the drivable area into `col.json` (`walls`, separate from
  `buildings` so a crash into them never opens a wall breach), and `ground.py` draws a concrete barrier wherever that
  edge crosses a road.

## Adding a city

1. An entry in `tools/nyc/cities.json`: `origin` [lat, lon] (the game frame's 0,0), `area` [S, W, N, E], the OSM extract
   (`data`, `pbf`: download.bbbike.org/osm/bbbike/<City>/<City>.osm.pbf, or any .osm.pbf that covers the area),
   `widths` by street class, `floors` by building type, `small_floors` [m2, floors], `style` (palette in
   `buildings.py CITY_PALETTES`), `grid_deg` (street grid angle for the paving), `spawn` and `route_via` (lat, lon
   points the race loop passes, in order), `skip_elevated` for cities whose expressways are on viaducts.
2. `CITY=<id> tools/nyc/build_city.sh 3` (extract, mask, ground, buildings, props, index + route; jobs = 3 fits the
   8 GB laptop). One city at a time: each stage loads the whole city.
3. A line in `web/src/cities.ts` (base folder, route, grid, driving side, attribution) and the credits in CREDITS.md.
4. Look at it: `?city=<id>` (the minimap's map.json shows the whole street net), drive the route, check the edge.

## Terrain (real ground heights, 2026-11-21)

Cities are no longer flat: `tools/nyc/terrain.py` (the stage after extract) builds each city's real ground and every other
stage uses it. Source: AWS Terrain Tiles (Terrarium PNG, open elevation composite: USGS 3DEP in the US, Copernicus EU-DEM in
Europe, SRTM / GMTED elsewhere; attribution in CREDITS.md), fetched once per city into `<data>/terrain/`.

1. z15 tiles over the area + fringe + 600 m, sampled on a 4 m grid in the city's own transverse Mercator frame.
2. Raw heights clamped at 1 m below sea level (no-data values and sea-floor bathymetry).
3. Bare-earth filter: outside the US the data is a surface model, and a dense downtown reads as a hill over its towers.
   A morphological opening of `terrain_open_m` metres (cities.json; default 120, 150 for dense mid-rise cities, 250 for
   high-rise ones, 0 in the US where 3DEP is bare earth already) keeps the ground under them. Real hills are wider.
4. Gaussian smoothing (12 m): realistic street gradients instead of 30 m data steps. Heights are relative to the city
   origin (0 m at the spawn square).
5. The EXPORT grid: 8 m, aligned to the 256 m tiles. The pipeline drapes and seats everything on it and the game loads it
   (`<tiles>/terrain.bin`, int16 cm; `index.json` `terrain`), so visuals and physics share one surface.
6. Bridges over dips (rivers, valleys) get a straight deck from bank to bank baked into the grid; overpasses over flat
   ground follow the ground. Each water body gets one level (the low end of the ground inside it).

How the stages use it:
- ground.py: every tile's meshes are DRAPED (`terrain.drape`): an edge is split only where the ground bends away from it
  by more than 2.5 cm (flat ground and constant slopes keep their big triangles; the decision belongs to the edge, so
  neighbours split it alike: no cracks), z += H, up-facing normals become the terrain's; water stays flat at its level.
- buildings.py: each building (LOD0, far LOD and collider box) stands on the LOWEST ground under its footprint, its ground
  ring 0.5 m below that (planted on a slope, never floating; the facade UVs keep the shop floor where it was). Edge walls
  span the ground along their length.
- build_index.py: `terrain.bin` + metadata; the race route's samples carry the road height (`z`), which the checkpoints,
  speed / drift gates, AI lanes and cop roadblocks already read.
- The game (`web/src/scene/nyc/terrain.ts`): each tile's physics ground is a Rapier height field from the same grid
  (one cell edge per grid line: neighbouring tiles share their edges), props sit at the ground under each of them,
  the spawn and the recover (R) cast from the ground there, and the wet-road mirror tilts to the slope under the car.

`terrain: false` keeps a city flat. Flat on purpose: Chicago, Miami, Amsterdam, Berlin and Singapore (a few metres of real
relief; their surface-model data mostly measured the towers), and New York until Manhattan is rebuilt. Hilly by design:
San Francisco (Nob Hill and Russian Hill, grades over 20 %) and Lisbon (Baixa between Chiado, the Bairro Alto and the castle).

Route fix (same day): the tile road graphs store an edge's interior points only; build_index read them as the whole edge,
so every route skipped its corner nodes and, where an interior point lay far from a corner, cut straight across a block
(AI rivals drove through buildings). Each edge is now its two nodes around its interior points, and waypoints snap to the
main connected street network.

## City identity (2026-11-21): each city its own, not New York with new outlines

Until this date every city was built by New York's generator with only the outlines, heights and colour palette changed:
the same six facade kinds, Times Square billboards around every spawn, New York sign texts, New York's street trees,
American double-yellow centre lines and Manhattan sidewalks. Now:

- **Real 3D shapes (Simple 3D Buildings, tools/nyc/s3d.py).** extract.py keeps `building:part` volumes (parts.ndjson)
  and the roof / colour / material tags. A building whose parts cover >= 40 % of its outline is built from them, each
  part from its min_height to its height with its own roof, colour and material (Barcelona: 53,740 parts, the Sagrada
  Familia's 15 towers; London 8,850). Roof shapes: gabled, hipped, half-hipped, mansard, gambrel, pyramidal, cone,
  dome, onion, skillion, round, saltbox. Untagged low and mid-rise blocks get their city's typical roof
  (s3d.ROOF_STYLE: Paris zinc mansards, Lisbon / Madrid terracotta hips, Amsterdam steep gables, London slate ...).
  building:colour / roof:colour / building:material / roof:material set the tint, the facade kind and the roof material.
- **Roof materials** (facade.ts roofGraph): flat, clay tiles, slate, standing-seam zinc, glass, copper, floodlit metal.
  The code rides on the roof UV (u + code * 16384, u measured from the roof's centre): no new vertex attribute.
- **Landmarks a footprint cannot describe** (tools/nyc/landmarks3d.py), built from real dimensions on their OSM
  footprint: Eiffel Tower (lattice legs, floors at 57.6 / 115.7 / 276 m, floodlit), CN Tower, Berliner Fernsehturm,
  London Eye, Singapore Flyer, Columbus Monument, Transamerica Pyramid, Arc de Triomphe (piers, arches, cornices),
  Brandenburg Gate (columns, attic, quadriga). Their colliders are what stands on the ground (you can drive between the
  Eiffel Tower's legs and through the Arc). Churches, cathedrals, mosques, temples, castles and towers use facade kind 6
  (stone, no window grid, no shopfronts, floodlit at night).
- **Per-city architecture** (facade.ts setCityStyle): window bay / size / floor height, wrought-iron balconies (Paris:
  continuous bands on the 2nd and 5th floors), wooden shutters, smooth render instead of stone joints.
- **Per-city signs** (signAtlas.ts): every city has its own invented shop names and screen texts, in the local language.
  Big screens only where the city has them (cities.json `billboards`: New York / Tokyo 1, Seoul / Toronto 0.8,
  London 0.45 ... Paris 0).
- **Centre lines** by country (ground.py CENTRE_LINE): double yellow in the US, Canada, Korea; white solid in Japan;
  white dashes elsewhere. **Sidewalks** (groundMaterials.ts setGroundCity): Lisbon calcada with black waves, Barcelona
  panot tiles, Amsterdam brick, Melbourne bluestone, Paris asphalt, London / Berlin flags, Tokyo / Seoul pavers.
- **Street trees** (props.ts CITY_TREES): a palm species and each city's mix (Los Angeles / Miami palms, London planes,
  Berlin lindens, Barcelona planes ...).

What is not 1:1: individual facades (window positions, ornament). No open dataset records them; the photo-based 3D
city models that do (Google's) do not allow this use. Massing, roofs, colours and landmarks follow the data.

## Notes

- Heights: explicit `height` / `building:levels` first; a building without one takes the tallest `building:part` inside
  it, then the median of the known heights within 70 m (a Paris block is one height), then the typical floors for its
  type, varied +-25 %. Footprints under 60 m2 are one storey.
- Compression: `tools/nyc/meshopt_batch.mjs` compresses a whole batch in one node process (npx per file cost seconds
  each and took an hour for Manhattan).
- Not done yet: ranked online races still time the New York route only; AI traffic is off in every city as before; the
  facade shader is New York's (each city differs by palette, building kinds and era, not by window style).
