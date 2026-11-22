# Art bible

One page for anyone making cars, city pieces or textures for Open Grid. The look and grading are in
[art_direction.md](art_direction.md); car integration details in [adding_a_car.md](adding_a_car.md); the asset kit
and its sources in [kit.md](kit.md).

## The look in one paragraph

Night street racing, the way you remember it rather than the way a camera records it. Near-black wet streets, every
light doubled in a reflection, saturated cyan / magenta / amber neon, petrol-teal shadows. The car is the hero: paint
deeper than real life, visible clearcoat and flake, chrome that catches the neon. The city is real-world scale and
believable up close (cracked asphalt, kerbs, drains, signs), but it is a stage, not a documentary.

References that capture it: night street photography of Tokyo (Akihabara, Shibuya), Hong Kong and Athens; the
Need for Speed Underground era for mood. Use them for mood and lighting only, never to copy a building, logo or car.

## Rules that are not negotiable

1. **Licence.** Everything you contribute is published under **CC BY-NC 4.0** (the project's licence for assets).
   Only use sources you can relicense that way: your own work, **CC0**, or **CC BY** (credited in `CREDITS.md`).
   Not allowed: CC BY-NC / ND / SA sources, Fab / Megascans / Quixel, Textures.com, TurboSquid / CGTrader "royalty
   free", Sketchfab models without a CC0 / CC BY licence, ripped game assets, AI generators whose terms you cannot show.
   Keep a capture of the licence page in `assets_source/licenses/`.
2. **No real brands.** No manufacturer badges, names, grilles that are trademarks, sponsor decals, tyre brand
   lettering, licence plates of real places, shop or company logos on buildings. Invent them. Real cars may only be
   used as donors if their silhouette is changed and they are fully debadged ([adding_a_car.md](adding_a_car.md)).
3. **No tracing protected sources.** Google Maps, Street View and Google Earth imagery or 3D tiles may not be traced,
   captured or used as textures (their terms forbid it). Your own photos are fine; for buildings, photograph from public
   streets. OpenStreetMap is fine for layout (ODbL, credited).
4. **Scale is real.** 1 unit = 1 metre. Lanes 3.5 m, kerbs 15 cm, doors 2.1 m, storeys ~3 m.

## Technical specs

| | cars | city props / modules | textures |
|---|---|---|---|
| Axes | +X left, +Y up, +Z forward, origin on the ground under the car's middle | +Y up, origin at the base | |
| Triangles | 120k max for the player car (checked by `tools/validate_mod.mjs`), merge meshes per material | as low as reads at 20 m; a street prop is usually under 5k | |
| Materials | ~35 max; one material named `paint` for everything that takes the body colour | reuse kit materials (`docs/kit.md`) before making new ones | |
| Texture size | 2048 (web, KTX2) | 1024-2048 (web) | masters up to 4096, 50 MB per file |
| Format | GLB (glTF 2.0), PBR metal/rough | GLB | PNG or EXR masters; the build makes KTX2 |
| Normal maps | OpenGL convention (+Y up), tangent space | same | |
| Names | wheel nodes, lamps, bumpers, mirrors as in [adding_a_car.md](adding_a_car.md) | `<area>_<thing>_<variant>` lower case | `<material>_<map>.png` (`asphalt_worn_nor_gl.png`) |

Blender sources go in `assets_source/` (`.blend`, full-resolution textures); exported GLBs in `web/public/assets/`.

## Before you open a pull request

- The contact sheet (`web/tools/car_sheet.sh <id>`) for cars, or two screenshots at night for city pieces: one wide,
  one close.
- The licence of every source, in `CREDITS.md` and the asset ledger (`node tools/assets/check_licences.mjs` passes).
- Frame rate: the scene still holds its target on the reference laptop (`docs/performance.md`).
