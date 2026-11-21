# Kit v1: scanned materials, HDRIs and props with a licence record each

Real-world quality comes from scanned sources and our own photos, never from guessing. Every kit asset is stored
once as a **master** with its **licence ledger**, and everything the game uses is **generated** from the masters
(web and Unreal exports are never hand-edited). Masters are **4K** (locked for the final Unreal game,
`data/asset_budgets.json`); the web gets smaller generated copies.

```
assets_source/masters/kit/<id>/
  source.json          the licence ledger (below): in git
  evidence/            the licence page / API record as read on the download day: in git
  <master files>       NOT in git: assets of the GitHub release named in the ledger (masters are read-only once added)
web/public/assets/kit/<kind>/<id>/...     generated for the browser, small, committed as normal files
ue5/SourceArt/Kit/<kind>/<id>/...         generated for Unreal (4K) on the machine that uses them, not committed
assets_source/masters/cars/<id>/source.json   the same ledger for every car (cars list `shipped` files instead of masters)
```

## Where the masters live, and why

On **GitHub Releases** of this repository (tag in each ledger's `master_release`), not in git and not in Git LFS.
Release downloads have no bandwidth limit and do not count against anyone's Git LFS quota, so contributors can get
every master without spending the repository owner's allowance (GitHub Free includes only 10 GiB of LFS downloads a
month, and a public repository's LFS files can be downloaded by anyone). Each release file must be under 2 GiB; the
kit keeps each master at 50 MB or less anyway.

```
node tools/assets/masters.mjs fetch      # download the masters into their folders, check SHA-256, make them read-only
node tools/assets/masters.mjs verify     # check local masters against their ledgers
node tools/assets/masters.mjs upload     # maintainer: put new masters on their release (GitHub CLI; never replaces one)
```

## The ledger: `source.json`

```json
{
  "name": "<the source's title>",               "url": "<the asset's page>",
  "author": "<as the source names them>",       "licence": "CC0-1.0",
  "licence_url": "<the licence page>",          "downloaded": "YYYY-MM-DD",
  "files": ["<master file>"],                   "notes": "how the licence was read, what the file is",
  "sha256": { "<master file>": "<hex>" },       "master_release": "kit-masters-v1"
}
```

Optional: `changes` (what we changed, used in the CC BY credit line), `owner_approval` (a date: required for CC BY-SA).

## Licence rules

- Allowed in the repo: **CC0-1.0**, **CC-BY-3.0 / CC-BY-4.0** (credited by name and link), **CC-BY-NC-4.0** (our own
  work and photos). **CC-BY-SA** only with the owner's approval for that asset (our edited versions would have to stay
  CC BY-SA): record it in `owner_approval`.
- Never in the repo or on its releases: Fab / Megascans, Textures.com, anything "editorial", paid, or without a clear
  licence. Those go only in `ue5/Content/ThirdParty/` (gitignored), on the machine that uses them.
- A licence is never assumed: it is read from the asset's source page or official API on the download day and the
  `notes` say where. Unclear: the asset is skipped and listed in the phase report.
- Downloads use the official routes (website or official API) within their terms. Poly Haven's API terms
  (https://github.com/Poly-Haven/Public-API/blob/master/ToS.md) require a user agent naming our software: `OpenGrid`.

## The check

`node tools/assets/check_licences.mjs` (CI, job `web-and-cloud`) fails when a ledger is missing or incomplete, a licence
is outside the list, a kit ledger lacks `sha256` / `master_release`, a master is tracked by git, a master present
locally differs from its SHA-256 or is over budget, a file in a kit folder is unlisted, a generated kit file is not
under a kit id's folder, a car model has no ledger, or the "Kit assets" section of `CREDITS.md` is stale.
`--write` regenerates that section from the ledgers.

## HDRIs (phase B)

Four Poly Haven CC0 HDRIs at 4K, fetched with `python3 tools/assets/fetch_polyhaven.py hdri <id> ...` (EXR when the
4K file fits 50 MB, else HDR) and exported with
`tools/blender/blender -b --factory-startup --python tools/assets/build_kit_hdri.py`:

| id | role | used for |
|---|---|---|
| `cobblestone_street_night` | night | Paris, Lisbon, Barcelona, Madrid, Amsterdam |
| `hansaplatz` | night | London, Berlin, Melbourne, San Francisco |
| `shanghai_bund` | night | the high-rise cities (default) and the garage capture |
| `urban_street_01` | overcast | any city when it rains |

- Web (`web/public/assets/kit/hdri/`): 1024 x 512 Radiance HDR, prefiltered at load into the renderer's 256-px PMREM
  cube. Driving: the reflection captures (the city environment at load, the car's live probe) draw the HDRI as their
  sky, the main view keeps the game's sky (`web/src/fx/kitHdri.ts`). Garage: the room capture gets the HDRI added on
  top (`Garage.setHdri`). Potato: the HDRI is the environment itself.
- Strength is measured: each HDRI is scaled so its sky's mean luminance equals the game's night sky (`SKY_TARGET` in
  the build script); unscaled, these night photographs are ~40x brighter than the game's sky.
- Unreal (`ue5/SourceArt/Kit/hdri/`, generated locally): the 4K master as half-float EXR for the sky light.
- Test switches: `?hdri=0` (the look before the kit), `?garagehdri=x` (x times the measured garage strength),
  `?weather=dry|rain`. Screenshots: `node tools/assets/screens.mjs <dir>` (playwright-core, system Chrome, headless).

## Materials (phase C)

Twelve Poly Haven CC0 scanned full-PBR sets at 4K (albedo/Diffuse, OpenGL normal `nor_gl`, roughness, AO, displacement,
plus metalness where present), fetched as 4K EXR with `python3 tools/assets/fetch_polyhaven.py textures <id> ...` (each
file well under the 50 MB budget) and exported with
`tools/blender/blender -b --factory-startup --python tools/assets/build_kit_materials.py`:

| id | role | category | web KTX2 | used for |
|---|---|---|---|---|
| `clean_asphalt` | `dry_asphalt` | road | 2048 px | city road base asphalt |
| `asphalt_02` | `worn_asphalt` | road | 2048 px | worn / cracked road zones |
| `brushed_concrete` | `concrete_kerb` | road | 2048 px | concrete kerbs and slab sidewalks |
| `painted_concrete_02` | `painted_kerb` | road | 2048 px | painted kerbs |
| `concrete_pavers_02` | `paving_stones` | road | 2048 px | plazas and paver sidewalks |
| `plastered_wall` | `smooth_plaster` | wall | 1024 px | smooth rendered facades |
| `rough_plaster_03` | `rough_plaster` | wall | 1024 px | weathered rendered facades |
| `rustic_stone_wall` | `stone_wall` | wall | 1024 px | stone facades and monuments |
| `red_brick` | `brick` | wall | 1024 px | brick facades |
| `clay_roof_tiles_02` | `roof_tiles` | wall | 1024 px | pitched clay-tile roofs |
| `rusty_metal_04` | `rusty_metal` | wall | 1024 px | rails, weathered metal roofs / shutters |
| `blue_metal_plate` | `painted_metal` | wall | 1024 px | painted metal roofs / shop shutters |

- Web (`web/public/assets/kit/materials/<id>/`, committed): KTX2 with mipmaps (`diff.ktx2` sRGB ETC1S, `nor.ktx2` linear
  UASTC RDO + zstd, `arm.ktx2` linear AO/Rough/Metal ETC1S, `disp.ktx2` half-res linear height ETC1S) plus `manifest.json`.
  Loaded by `web/src/fx/kitMaterials.ts` and wired into `groundMaterials.ts` and `facade.ts`.
- Wetness comes entirely from the shader (darker porous albedo, lower roughness, puddle mask pooled in scanned height
  cavities and gutters driven by `worldClock.wetness`), never from separate wet textures.
- Unreal (`ue5/SourceArt/Kit/materials/<id>/`, generated locally, gitignored): full 4096 px PNGs (`BaseColor` 8-bit sRGB,
  `Normal` 16-bit DirectX Y-down, `ORM` 8-bit linear, `Height` 16-bit linear).
- Test switch: `?kitmat=0` (procedural look before Phase C). Before/after screenshots:
  `node tools/assets/screens.mjs <dir> before=kitmat=0 after=`.
