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
  junctions merge; street names as upright labels with a halo, one per street, kept clear of the cards.
- **Buildings**: the oriented boxes the tiles already ship for collision (`<ix>_<iy>.col.json`, game frame) extruded to a low
  map-style height (40 % of real, capped at 12 % of the camera height) so they never hide the streets; tiles stream in
  around the car (3 at a time, 30 kept). A city without tiles has none.
- **Guidance**: the next 1.5 km of the route as a blue line with a casing, width following the perspective; the car as a blue
  arrow with a halo; rivals as dots; a GPS waypoint as a red pin with a dashed guide.
- **Cards**: green maneuver card (arrow, distance, "onto <street>") with a "Then" strip for the turn after it when it is
  within 320 m; bottom card with minutes, distance and the arrival time on the **game** clock (which runs 4x real time);
  compass, sound and search buttons; the speed-limit sign (from the road class under the car: 30 / 50 / 60 / 100 km/h) above
  the speed bubble, which turns red over the limit. Off the route it shows the clock, heading and street instead.
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

## Not done
- Map layers the data does not have: water, parks, rail, traffic colouring, lane guidance, POI icons.
- Speed limits are a class default; the tiles carry no `maxspeed`.
