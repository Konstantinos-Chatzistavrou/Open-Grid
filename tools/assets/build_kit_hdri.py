"""Generate the HDRI exports from the kit masters (docs/kit.md). Never hand-edit the outputs: run this again.

    tools/blender/blender -b --factory-startup --python tools/assets/build_kit_hdri.py

Runs inside Blender's Python for its bundled OpenImageIO. For every kit HDRI (assets_source/masters/kit/<id>/ with an
.exr or .hdr master):
  web/public/assets/kit/hdri/<id>/<id>_1k.hdr   1024 x 512 Radiance HDR. The renderer prefilters it at load into its
                                               256-px PMREM cube (the garage capture and the city captures): 1K
                                               equirect is the resolution that cube resolves, more is wasted bytes.
  ue5/SourceArt/Kit/hdri/<id>/<id>.exr          the master at full resolution as a half-float, ZIP-compressed EXR for
                                               Unreal's sky light (HDRI backdrop / SkyLight cubemap import).
  web/public/assets/kit/hdri/manifest.json     what the game loads: id, file, role, default strength, licence.
Roles are set here (ROLES); the ledgers stay the only licence record.

Strength is MEASURED, not chosen: Poly Haven's night HDRIs are exposed for viewing (their sky averages ~0.9-1.1 in
luminance), ~40x the game's night sky, and used as-is they lit the whole city like dusk and blew the garage paint out.
Each HDRI is scaled so the mean luminance of its upper half equals the game's own sky measured the same way
(SKY_TARGET: web/src/scene/nyc/atmosphere.ts's horizon / mid / zenith colours, rows averaged by elevation).
The lamps keep their ratio to the sky, so they stay bright highlights.
"""
import json
import os

import OpenImageIO as oiio

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KIT = os.path.join(ROOT, "assets_source", "masters", "kit")
WEB = os.path.join(ROOT, "web", "public", "assets", "kit", "hdri")
UE = os.path.join(ROOT, "ue5", "SourceArt", "Kit", "hdri")
# role: night (dry nights), overcast (rain)
ROLES = {
    "cobblestone_street_night": {"role": "night"},
    "hansaplatz": {"role": "night"},
    "shanghai_bund": {"role": "night"},
    "urban_street_01": {"role": "overcast"},
}
SKY_TARGET = 0.0141   # mean luminance of the game's night sky over the upper half of an equirect (atmosphere.ts)


def write(buf, path, fmt):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        os.chmod(path, 0o644)
    buf.set_write_format(fmt)
    if not buf.write(path):
        raise RuntimeError(f"{path}: {buf.geterror()}")


def main():
    manifest = []
    for aid in sorted(os.listdir(KIT)):
        ledger = os.path.join(KIT, aid, "source.json")
        if not os.path.exists(ledger) or aid not in ROLES:
            continue
        d = json.load(open(ledger))
        src = [f for f in d["files"] if f.endswith((".exr", ".hdr"))]
        if not src:
            continue
        master = oiio.ImageBuf(os.path.join(KIT, aid, src[0]))
        spec = master.spec()
        rgb = oiio.ImageBufAlgo.channels(master, (0, 1, 2))
        # Unreal: full resolution, half float, ZIP
        ue = oiio.ImageBuf(rgb.spec())
        oiio.ImageBufAlgo.copy(ue, rgb)
        ue.specmod().attribute("compression", "zip")
        ue_path = os.path.join(UE, aid, f"{aid}.exr")
        write(ue, ue_path, oiio.HALF)
        # web: 1024 x 512, area-filtered (no ringing around the lamps), negatives clamped
        small = oiio.ImageBufAlgo.resize(rgb, filtername="box", roi=oiio.ROI(0, 1024, 0, 512, 0, 1, 0, 3))
        small = oiio.ImageBufAlgo.clamp(small, (0.0, 0.0, 0.0), (65000.0, 65000.0, 65000.0))
        web_path = os.path.join(WEB, aid, f"{aid}_1k.hdr")
        write(small, web_path, oiio.FLOAT)
        px = small.get_pixels(oiio.FLOAT).reshape(512, 1024, 3)
        lum = px[:256] @ [0.2126, 0.7152, 0.0722]
        upper = float(lum.mean())
        strength = round(SKY_TARGET / upper, 5)
        manifest.append({"id": aid, "name": d["name"], "file": f"{aid}/{aid}_1k.hdr", **ROLES[aid], "strength": strength,
                         "sky_mean_luminance": round(upper, 4), "licence": d["licence"], "source_size": [spec.width, spec.height]})
        print(f"{aid}: sky mean {upper:.3f} -> strength {strength}; {spec.width}x{spec.height} -> web {os.path.getsize(web_path) / 1048576:.1f} MB, "
              f"unreal {os.path.getsize(ue_path) / 1048576:.1f} MB")
    os.makedirs(WEB, exist_ok=True)
    with open(os.path.join(WEB, "manifest.json"), "w") as f:
        json.dump({"generated_by": "tools/assets/build_kit_hdri.py", "hdris": manifest}, f, indent=2)
        f.write("\n")


main()
