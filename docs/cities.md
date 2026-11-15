# Real-scale cities (1:1)

Since 2026-11-15 the game streams one of five real cities, all built at 1:1 from open data by the same pipeline
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

## Notes

- Heights: explicit `height` / `building:levels` first; a building without one takes the tallest `building:part` inside
  it, then the median of the known heights within 70 m (a Paris block is one height), then the typical floors for its
  type, varied +-25 %. Footprints under 60 m2 are one storey.
- Compression: `tools/nyc/meshopt_batch.mjs` compresses a whole batch in one node process (npx per file cost seconds
  each and took an hour for Manhattan).
- Not done yet: ranked online races still time the New York route only; AI traffic is off in every city as before; the
  facade shader is New York's (each city differs by palette, building kinds and era, not by window style).
