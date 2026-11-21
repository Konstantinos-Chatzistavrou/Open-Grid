# Own Photos -> Kit v1 4K PBR Masters (`tools/assets/photo_to_material.py`)

Drop your straight-on phone photos (`*.jpg` / `*.png`) into this folder alongside a `corners.json` (see
`corners.example.json`), then run:

```bash
python3 tools/assets/photo_to_material.py assets_source/photos/samples
```

For each photo listed in `corners.json`, the tool:
1. Warps the 4 corner coordinates `[TL, TR, BR, BL]` to a 4096x4096 square (perspective correction),
2. Removes broad lighting gradients (high-pass delighting),
3. Makes the texture seamlessly tileable (half-period offset + raised-cosine seam blend),
4. Estimates approximate height (`Displacement`), OpenGL normal (`nor_gl`), `Rough`, and `AO` (note: single-photo
   normals and height are approximations, weaker than multi-angle scans),
5. Writes 4K EXR masters + `source.json` (`CC-BY-NC-4.0`, `Konstantinos Chatzistavrou`) into
   `assets_source/masters/kit/<id>/`.
