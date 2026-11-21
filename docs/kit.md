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
