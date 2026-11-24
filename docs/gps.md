# In-car GPS

A rectangular navigation screen in the style of a modern phone / head-unit navigation app: our own drawing code, colours and
glyphs, no third-party logos, icons or map imagery.

Code: `web/src/minimap.ts` (state + renderer), `web/src/navUi.ts` (themes, turn arrows, buttons, speed sign),
`web/src/navBuildings.ts` (building footprints), `web/src/scene/navScreen.ts` (the unit on the dash), CSS in
`web/src/style.css` ("GPS: a rectangular car navigation screen").

## What it shows
- **Tilted 3D map, heading-up**, perspective-projected in a 2D canvas (560 x 350 logical px, buffer scaled to the screen,
  at least 560 wide). The camera climbs with speed (60 m at standstill, 160 m flat out) and drops in when a turn is within
  260 m. Roads from the tiles' `map.json` in four tiers (local / collector / arterial / highway), casings first so
  junctions merge; street names as upright labels with a halo, one per street, kept clear of the cards. Under the roads:
  **water and green areas** (parks, grass, cemeteries, pitches, woods) from `tiles/areas.json`, clipped at the camera's near
  plane so a lake under the car does not break the projection.
- **Buildings**: the oriented boxes the tiles already ship for collision (`<ix>_<iy>.col.json`, game frame) extruded to a low
  map-style height (40 % of real, capped at 12 % of the camera height) so they never hide the streets; tiles stream in
  around the car (3 at a time, 30 kept). A city without tiles has none.
- **Guidance**: the next 1.5 km of the route as a blue line with a casing, width following the perspective; the car as a blue
  arrow with a halo; rivals as dots; a GPS waypoint as a red pin with a dashed guide.
- **Cards**: green maneuver card (arrow, distance, "onto <street>") with a "Then" strip for the turn after it when it is
  within 320 m; bottom card with minutes, distance and the arrival time on the **game** clock (which runs 4x real time);
  compass, sound and search buttons; the speed-limit sign (from the road class under the car: 30 / 50 / 60 / 100 km/h) above
  the speed bubble, which turns red over the limit. Off the route it shows the clock, heading and street instead.
- **Speed limits are real where OSM has them**: every edge of `tiles/map.json` carries `ms` (km/h), the `maxspeed` tag of the
  nearest way of the same street (matched within 8 m, name and class preferred), else the typical limit of that road class in
  the city's country (NYC: the 25 mph citywide default). Tagged share per city (after the matcher fix below): Amsterdam 100 %, Paris 99 %, Berlin 98 %, London 97 %, Singapore 97 %, Barcelona 94 %, Melbourne 82 %, Toronto 78 %, NYC 68 %, Madrid 62 %, Miami 53 %, San Francisco 52 %, Los Angeles 35 %, Tokyo 33 %, Lisbon 11 %, Chicago 9 %, Seoul 5 %, Crete 0 % (its sources are not in the repo).
  The matcher once let a candidate of another road class win (a freeway viaduct took the limit of the surface street under it); it now takes
  a way of the same class or the same named street only.
- **Traffic** is the game's own, not a feed: the hour's traffic density (`WorldClock.trafficDensity`, heaviest 22:00-01:00,
  empty before dawn) spread over the arterials and highways in smooth patches of ~260 m that are the same every time you look,
  plus a jam around every AI car that is crawling or stopped on the road (under 3.5 m/s, not parked, not waiting on the grid;
  25 s memory). Slow roads get an orange (> 0.45) or red (> 0.75) stripe, and so does the guidance line ahead.
- **Day / night**: night colours 19:20 - 06:10 on the game clock, day colours otherwise (`?gps=day|night` fixes it).
- **Overview** (click the screen or Tab): flat north-up map, the whole route faint with the part ahead bright, a scale bar;
  a click sets a waypoint, right-click clears it.

## Devices
- **HUD**: a piano-black bezel with a metal edge, glass sheen and a chin with three keys and a standby light (CSS).
- **Cabin**: `navScreen.ts` is a physical unit on the dash (rounded housing with a bevel and a window, metal trim, glass
  reflection added over the picture, keys, LED, mounting arm) textured from the same canvas. It is in every car; the texture
  is re-uploaded at 10 Hz only while the cockpit, hood or orbit camera is active. `?navscreen=0` leaves it out.
- The cockpit camera's eye height was 1.49 m above the road, higher than the roof of the cars (the offset is added to the body
  centre, ~0.45 m up); it is now 1.1 m so the dash and the unit are in frame.

## Cost
JS time per redraw (15 Hz): 0.3 ms median (city, highway), 1.5 ms with the CPU throttled 4x; the overview 1.5 ms / 7 ms. One
~1 MB texture upload at 10 Hz in the cockpit views only.

## Testing it without the game
`web/tools/gps-preview.html` draws the GPS alone and drives it along a route:
`http://127.0.0.1:5173/tools/gps-preview.html?city=nyc&s=300&v=18&gps=night&hour=22.5`, then `window.drive(s0, speed, frames,
expanded)`; the canvas is `window.mm.cv` (`mm.cv.toDataURL()` for a full-resolution grab). Use with `web/tools/cdp.mjs`.

## Data pipeline
`python3 tools/nyc/gps_layers.py [city ...]` (needs `osmium`, `pyproj`, `shapely` and the city's OSM extract in
`assets_source/downloads/`, the same inputs as the tile build) rewrites each city's `map.json` (adds `ms`) and writes
`areas.json` (2 m simplification, areas under 400 m2 dropped, 2.3 MB for the 17 cities). Both are derived databases of
OpenStreetMap and stay under the ODbL (CREDITS.md, LICENSING.md).

## Checked against the world (`tools/validation/gps_layers_check.mjs`, in CI)
All 17 cities: every area ring valid, every area >= 400 m2 and inside the built area, every edge limit an integer 5-140 km/h, and the median limit rising from local to collector to arterial to motorway; well-known parks and rivers (Central Park, the Hudson and East River, the Serpentine, Green Park, Tuileries, the Seine at the Pont des Arts, Yoyogi, Tiergarten, Vondelpark, the IJ, Ciutadella, Retiro, Eduardo VII, the Royal Botanic Gardens) fall inside a green or water area. 102,407 checks. The check found **the Thames missing**: the London extract is clipped, so the river's multipolygon cannot be assembled; it is a listed known gap (the 109 London water areas are docks, basins and lakes). The check also caught two of its own wrong coordinates (a point on Roosevelt Island, a point on the Serpentine) before they were taken for data errors.

## Not done
- Rail, lane guidance, POI icons; real traffic (there is no feed: the traffic above is the game's own simulation).
- London has no Thames (see above), and Crete has no area layers and class-default limits (its OSM extract is not in `assets_source`).
- Tokyo, Lisbon, Chicago and Seoul have few `maxspeed` tags in OSM; their limits are mostly the country default.
