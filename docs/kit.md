# Kit v1: scanned materials, HDRIs and props with a licence record each

Real-world quality comes from scanned sources and our own photos, never from guessing. Every kit asset is stored
once as a **master** with its **licence ledger**, and everything the game uses is **generated** from the masters
(web and Unreal exports are never hand-edited).

```
assets_source/masters/kit/<id>/
  source.json          the licence ledger (below)
  <master files>       read-only once added; Git LFS; each <= 50 MB (data/asset_budgets.json `maxFileMB` if present)
  evidence/            optional: the licence page / API record as downloaded
web/public/assets/kit/<kind>/<id>/...     generated for the browser (sizes the renderer needs)
ue5/SourceArt/Kit/<kind>/<id>/...         generated for Unreal (full resolution)
assets_source/masters/cars/<id>/source.json   the same ledger for every car (cars list `shipped` files instead of masters)
```

## The ledger: `source.json`

```json
{
  "name": "<the source's title>",               "url": "<the asset's page>",
  "author": "<as the source names them>",       "licence": "CC0-1.0",
  "licence_url": "<the licence page>",          "downloaded": "YYYY-MM-DD",
  "files": ["<master file>"],                   "notes": "how the licence was read, what the file is"
}
```

Optional: `changes` (what we changed, used in the CC BY credit line), `owner_approval` (a date: required for CC BY-SA).

## Licence rules

- Allowed in the repo: **CC0-1.0**, **CC-BY-3.0 / CC-BY-4.0** (credited by name and link), **CC-BY-NC-4.0** (our own
  work and photos). **CC-BY-SA** only with the owner's approval for that asset (our edited versions would have to stay
  CC BY-SA): record it in `owner_approval`.
- Never in the repo: Fab / Megascans, Textures.com, anything "editorial", paid, or without a clear licence. Those go
  only in `ue5/Content/ThirdParty/` (gitignored), on the machine that uses them.
- A licence is never assumed: it is read from the asset's source page or official API on the download day and the
  `notes` say where. Unclear: the asset is skipped and listed in the phase report.
- Downloads use the official routes (website or official API) within their terms. Poly Haven's API terms
  (https://github.com/Poly-Haven/Public-API/blob/master/ToS.md) require a user agent naming our software: `OpenGrid`.

## The check

`node tools/assets/check_licences.mjs` (CI, job `web-and-cloud`) fails when a ledger is missing or incomplete, a licence
is outside the list, a master is missing / not in LFS / over budget / unlisted, a generated kit file is not under a
kit id's folder, a car model has no ledger, or the "Kit assets" section of `CREDITS.md` is stale.
`--write` regenerates that section from the ledgers.

## HDRIs (phase B)

Four Poly Haven CC0 HDRIs, fetched with `python3 tools/assets/fetch_polyhaven.py hdri <id> ...` (largest file within
the 50 MB budget: 4K; the sources go to 16-24K) and exported with
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
- Unreal (`ue5/SourceArt/Kit/hdri/`): the 4K master as half-float EXR for the sky light.
- Test switches: `?hdri=0` (the look before the kit), `?garagehdri=x` (x times the measured garage strength),
  `?weather=dry|rain`. Screenshots: `node tools/assets/screens.mjs <dir>` (playwright-core, system Chrome, headless).
- Deploys: the web files are in Git LFS. Vercel serves LFS pointer stubs unless Git LFS is enabled in the project's
  Git settings; the game then falls back to the look without the kit (the loader cannot parse the stub).
