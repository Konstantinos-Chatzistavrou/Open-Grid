"""Build a game car from a downloaded CC BY / CC0 model (Sketchfab GLB), driven by one JSON config per car
(assets_source/cars/<id>.json). Blender 5.x, headless:

    blender -b --factory-startup -P assets_source/scripts/sketchfab_build.py -- <config.json> <src.glb> <outdir>

Steps (docs/adding_a_car.md is the game contract):
  1. transforms applied, empties dropped; objects / materials named in `remove` deleted (badges, stickers, shadow planes,
     duplicate clear-coat shells, the source's own plates);
  2. turned to face -Y with +X = the car's LEFT (`rot_z_deg`), scaled so the wheelbase is `wheelbase` m, centred
     (length centre at y 0, tyres on z 0);
  3. wheel parts (rims, tyres, discs, hubs; also meshes that hold both sides) split into four corners around the tyre
     hubs: wheel_FL ... spin, caliper_FL ... (materials in `caliper`) steer only;
  4. materials: `mat_map` (regex on the source material -> one of carlib's flat materials, or "keep");
     `paint_from_texture` splits a one-material textured body into recolourable `paint` faces and the rest by the colour
     the texture has under each face; `texture_fixes` paint over plates / logos in the kept textures (UV rectangles);
  5. lamps: `head` materials -> beam_L / beam_R, `tail` -> taillight_bar; everything else joined by material
     (the paint mesh is `body`); interiors and engines over `max_part_tris` decimated;
  6. textures downscaled to `tex_size`; GLB + <id>.json (hubs, extents) for register_car.py.
"""
import json
import math
import os
import re
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import standard_materials, meshes, remove, select_only, join, bbox, empty, adopt  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1:]
cfg = json.load(open(argv[0]))
SRC, OUT = argv[1], argv[2]
os.makedirs(OUT, exist_ok=True)
NAME = cfg["id"]


def log(*a):
    print("[build]", *a, flush=True)


def mname(o):
    return o.data.materials[0].name if o.data.materials and o.data.materials[0] else ""


def rx(pats, s):
    return any(re.search(p, s, re.I) for p in pats)


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

# ---- 1. bake transforms, drop empties and the removed parts -------------------------------------------------------
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
for o in list(meshes()):
    if o.modifiers:   # skinned (armature) or otherwise modified: keep the evaluated shape, drop the modifiers
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        o.modifiers.clear()
        o.data = me
    elif o.data.users > 1:
        o.data = o.data.copy()
    mw = o.matrix_world.copy()
    o.parent = None
    o.data.transform(mw)
    o.matrix_world = Matrix.Identity(4)
for o in [o for o in bpy.data.objects if o.type != "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)
for o in meshes():
    o["src_name"] = o.name
rm = cfg.get("remove", {})
for o in list(meshes()):
    if rx(rm.get("objects", []), o.name) or rx(rm.get("materials", []), mname(o)) or not o.data.polygons:
        remove(o)
for spec in rm.get("boxes", []):            # source-space boxes [x0,y0,z0,x1,y1,z1]: badges glued into a bigger mesh
    lo, hi = Vector(spec[:3]), Vector(spec[3:])
    for o in meshes():
        bm = bmesh.new(); bm.from_mesh(o.data)
        kill = [f for f in bm.faces if all(lo[i] <= f.calc_center_median()[i] <= hi[i] for i in range(3))]
        if kill:
            bmesh.ops.delete(bm, geom=kill, context="FACES"); bm.to_mesh(o.data)
        bm.free()
for spec in rm.get("uv", []):               # badge / lettering GEOMETRY textured from one atlas patch: faces whose UV centre is in the rect
    u0, v0, u1, v1 = spec["rect"]
    for o in [o for o in meshes() if mname(o) == spec["material"] and o.data.uv_layers]:
        uvl = o.data.uv_layers.active.data
        bm = bmesh.new(); bm.from_mesh(o.data); bm.faces.ensure_lookup_table()
        kill = []
        for f, poly in zip(bm.faces, o.data.polygons):
            uv = np.mean([uvl[li].uv[:] for li in poly.loop_indices], axis=0)
            if u0 <= uv[0] <= u1 and v0 <= uv[1] <= v1:
                kill.append(f)
        if kill:
            bmesh.ops.delete(bm, geom=kill, context="FACES"); bm.to_mesh(o.data)
            log(f"removed {len(kill)} badge faces from {o.name}")
        bm.free()
log("after remove:", len(meshes()), "objects")

# ---- 2. orientation, hubs, scale, centre ----------------------------------------------------------------------------
if cfg.get("rot_z_deg"):
    R = Matrix.Rotation(math.radians(cfg["rot_z_deg"]), 4, "Z")
    for o in meshes():
        o.data.transform(R)


def split_loose(o):
    select_only([o])
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE"); bpy.ops.object.mode_set(mode="OBJECT")
    return list(bpy.context.selected_objects)


tyre_pat = cfg["tyre"]
tyres = [o for o in meshes() if rx(tyre_pat, mname(o)) or rx(tyre_pat, o.name)]
# a tyre object may hold several tyres: separate, then group parts by centre into four wheels
parts = []
for o in tyres:
    parts += split_loose(o) if cfg.get("split_tyres") else [o]


def centre(objs):
    lo, hi = bbox(objs)
    return (Vector(lo) + Vector(hi)) / 2, Vector(hi) - Vector(lo)


groups = {}
c_all, _ = centre(parts)
for p in parts:
    c, _ = centre([p])
    k = ("F" if c.y < c_all.y else "R") + ("L" if c.x > c_all.x else "R")
    groups.setdefault(k, []).append(p)
log("tyre parts", [(p.name, [round(v, 2) for v in centre([p])[0]]) for p in parts], "all-centre", [round(v, 2) for v in c_all])
assert set(groups) == {"FL", "FR", "RL", "RR"}, f"tyres found at {list(groups)}"
hub = {k: centre(v)[0] for k, v in groups.items()}
rad = {k: max(centre(v)[1].y, centre(v)[1].z) / 2 for k, v in groups.items()}
wb = ((hub["RL"].y + hub["RR"].y) - (hub["FL"].y + hub["FR"].y)) / 2
S = cfg["wheelbase"] / wb
log(f"source wheelbase {wb:.4f} -> scale {S:.4f}")
M = Matrix.Scale(S, 4)
for o in meshes():
    o.data.transform(M)
hub = {k: v * S for k, v in hub.items()}
rad = {k: v * S for k, v in rad.items()}
wheelish = set(id(p) for v in groups.values() for p in v)
body_objs = [o for o in meshes() if id(o) not in wheelish]
blo, bhi = bbox(body_objs)
tz = min(hub[k].z - rad[k] for k in hub)
T = Vector((-(hub["FL"].x + hub["FR"].x + hub["RL"].x + hub["RR"].x) / 4, -(blo[1] + bhi[1]) / 2, -tz))
for o in meshes():
    o.data.transform(Matrix.Translation(T))
hub = {k: v + T for k, v in hub.items()}
bpy.context.view_layer.update()
log("hubs", {k: [round(c, 3) for c in v] for k, v in hub.items()}, "radius", {k: round(v, 3) for k, v in rad.items()})

# ---- 3. wheel parts into corners -------------------------------------------------------------------------------------
wheel_pat = cfg.get("wheel_parts", []) + tyre_pat
cal_pat = cfg.get("caliper", [])
cands = [o for o in meshes() if id(o) not in wheelish and (rx(wheel_pat, mname(o)) or rx(cfg.get("wheel_objects", []), o.get("src_name", o.name)))]
for o in cands:
    _, sz = centre([o])
    if sz.x > 0.9:                       # one mesh holding both sides (axle-wide discs, uprights): split it
        split_loose(o)
corner = {k: list(v) for k, v in groups.items()}
for o in list(meshes()):
    if id(o) in wheelish or not (rx(wheel_pat, mname(o)) or rx(cfg.get("wheel_objects", []), o.get("src_name", o.name))):
        continue
    c, sz = centre([o])
    for k, h in hub.items():
        if math.hypot(c.y - h.y, c.z - h.z) < rad[k] * 1.05 and abs(c.x - h.x) < 0.38 and max(sz.y, sz.z) < rad[k] * 2.3:
            corner[k].append(o); wheelish.add(id(o)); break

# ---- 3b. reshape (lookalike donors: the silhouette must not be the donor's; same deformation as dtm_build.py SHAPE) ----
sh = cfg.get("shape")
if sh:
    from carlib import sstep, world_coords, set_world_coords
    YF = (hub["FL"].y + hub["FR"].y) / 2; YR = (hub["RL"].y + hub["RR"].y) / 2

    def SHAPE(p):
        x, y, zz = p[:, 0].copy(), p[:, 1].copy(), p[:, 2].copy()
        n = sstep(YF, YF - 1.0, y)                       # nose: longer, lower, narrower
        y -= sh.get("nose_len", 0) * n
        zz -= sh.get("nose_drop", 0) * n * np.clip((zz - 0.1) / 0.5, 0, 1)
        x *= 1 - sh.get("nose_taper", 0) * n
        t = np.clip((y - YF) / (YR - YF), 0, 1)          # cabin slides back between the axles, roof drops
        mid = np.sin(np.pi * t) ** 2
        y += sh.get("cabin_back", 0) * mid
        roof = sstep(0.75, 1.3, zz) * mid
        zz -= sh.get("roof_drop", 0) * roof * (zz - 0.6)
        x *= 1 - sh.get("roof_narrow", 0) * roof
        r = sstep(YR - 0.5, YR + 0.5, y)                 # rear haunches wider, tail shorter
        x *= 1 + sh.get("haunch", 0) * r * np.clip((1.0 - zz) / 0.9, 0, 1)
        y -= sh.get("tail_cut", 0) * sstep(YR, YR + 1.3, y)
        return np.stack([x, y, zz], 1)

    in_corner = {id(o) for lst in corner.values() for o in lst}
    for k, lst in corner.items():
        h0 = np.array(hub[k])[None, :]
        dv = SHAPE(h0)[0] - h0[0]
        for o in lst:
            set_world_coords(o, world_coords(o) + dv)
        hub[k] = Vector(hub[k]) + Vector(dv)
    for o in meshes():
        if id(o) not in in_corner:
            set_world_coords(o, SHAPE(world_coords(o)))
    blo, bhi = bbox([o for o in meshes() if id(o) not in in_corner])
    dy = -(blo[1] + bhi[1]) / 2
    for o in meshes():
        o.data.transform(Matrix.Translation((0, dy, 0)))
    hub = {k: v + Vector((0, dy, 0)) for k, v in hub.items()}
    log("reshaped; hubs", {k: [round(c, 3) for c in v] for k, v in hub.items()})

# ---- 4. materials ----------------------------------------------------------------------------------------------------
Mstd = standard_materials()
mm = cfg.get("mat_map", {})
for o in meshes():
    src = mname(o)
    for pat, target in mm.items():
        if re.search(pat, src, re.I):
            if target != "keep":
                o.data.materials.clear(); o.data.materials.append(Mstd[target])
            break

pft = cfg.get("paint_from_texture")
if pft:   # one textured body material: faces whose texture colour is the paint colour become `paint`
    img = bpy.data.images[pft["image"]]
    w, h = img.size
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px)
    px = px.reshape(h, w, 4)[:, :, :3]
    step = max(1, w // 512)
    small = px[::step, ::step]
    ref = np.array(pft["rgb"], np.float32)
    for o in [o for o in meshes() if mname(o) == pft["material"] and id(o) not in wheelish]:
        if Mstd["paint"].name not in [m.name for m in o.data.materials]:
            o.data.materials.append(Mstd["paint"])
        pi = [m.name for m in o.data.materials].index(Mstd["paint"].name)
        uvl = o.data.uv_layers.active.data
        n = 0
        for poly in o.data.polygons:
            uv = np.mean([uvl[li].uv[:] for li in poly.loop_indices], axis=0)
            sx = int(np.clip(uv[0] % 1.0, 0, 0.9999) * small.shape[1]); sy = int(np.clip(uv[1] % 1.0, 0, 0.9999) * small.shape[0])
            if np.linalg.norm(small[sy, sx] - ref) < pft.get("tol", 0.12):
                poly.material_index = pi; n += 1
        log(f"paint faces from texture on {o.name}: {n}/{len(o.data.polygons)}")

for fix in cfg.get("texture_fixes", []):   # paint over plates / logos: rect [u0, v0, u1, v1] in UV (v up), colour linear rgb
    img = bpy.data.images[fix["image"]]
    w, h = img.size
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(h, w, 4)
    for u0, v0, u1, v1, *rgb in fix["rects"]:
        px[int(v0 * h):int(v1 * h), int(u0 * w):int(u1 * w), :3] = rgb[:3]
    img.pixels.foreach_set(px.ravel()); img.update()
    img.pack()
    log("texture fixed", fix["image"], len(fix["rects"]), "rects")

# ---- 5. lamps, joins, decimation -------------------------------------------------------------------------------------
named = []
heads = []
for o in [o for o in meshes() if id(o) not in wheelish and rx(cfg.get("head", []), mname(o))]:
    heads += split_loose(o) if centre([o])[1].x > 0.6 else [o]
sides = {"L": [p for p in heads if centre([p])[0].x > 0], "R": [p for p in heads if centre([p])[0].x <= 0]}
for side, objs in sides.items():
    if objs:
        named.append(join(objs, f"beam_{side}"))
tails = [o for o in meshes() if id(o) not in wheelish and rx(cfg.get("tail", []), mname(o))]
if tails:
    named.append(join(tails, "taillight_bar"))

cap = cfg.get("max_part_tris", 9000)
for o in [o for o in meshes() if id(o) not in wheelish and o not in named and rx(cfg.get("decimate", []), mname(o))]:
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if n > cap:
        select_only([o]); mod = o.modifiers.new("dec", "DECIMATE"); mod.ratio = cap / n
        bpy.ops.object.modifier_apply(modifier="dec")

# every other body mesh joined per material: few draw calls; the paint one is `body`
rest = [o for o in meshes() if id(o) not in wheelish and o not in named]
bymat = {}
for o in rest:
    bymat.setdefault(mname(o) if len(o.data.materials) == 1 else "_multi_" + mname(o), []).append(o)
for k, objs in bymat.items():
    has_paint = any(Mstd["paint"].name in [m.name for m in o.data.materials if m] for o in objs)
    j = join(objs, "body" if (k == Mstd["paint"].name or (has_paint and "body" not in bpy.data.objects)) else "part_" + re.sub(r"\W", "_", k)[:24])

for k, lst in corner.items():
    e = empty(f"wheel_{k}", hub[k]); c = empty(f"caliper_{k}", hub[k])
    bpy.context.view_layer.update()
    is_cal = lambda o: rx(cal_pat, mname(o)) or rx(cfg.get("caliper_objects", []), o.get("src_name", o.name))
    spin = [o for o in lst if not is_cal(o)]
    fixed = [o for o in lst if is_cal(o)]
    def merged(objs, prefix):   # one mesh per material per corner (split pieces would each be a draw call)
        out, bym = [], {}
        for o in objs:
            bym.setdefault(mname(o), []).append(o)
        for i, (mk, lst2) in enumerate(bym.items()):
            out.append(join(lst2, f"{prefix}_{k}_{i}") if len(lst2) > 1 else lst2[0])
            out[-1].name = f"{prefix}_{k}_{i}"
        return out
    spin = merged(spin, "wheel")
    fixed = merged(fixed, "caliper") if fixed else []
    adopt(e, spin)
    if fixed:
        adopt(c, fixed)

# ---- 6. textures, export, numbers ------------------------------------------------------------------------------------
ts = cfg.get("tex_size", 2048)
for img in bpy.data.images:
    if img.size[0] > ts or img.size[1] > ts:
        f = ts / max(img.size)
        img.scale(max(1, int(img.size[0] * f)), max(1, int(img.size[1] * f)))
        img.pack()
body = [o for o in meshes() if not o.name.startswith(("wheel_", "caliper_"))]
lo, hi = bbox(body)
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes())
info = {"hubs_blender": {k: [round(float(c), 4) for c in v] for k, v in hub.items()},
        "body_y": [round(lo[1], 3), round(hi[1], 3)], "body_x": [round(lo[0], 3), round(hi[0], 3)], "body_z_max": round(hi[2], 3),
        "scale": round(S, 5), "tyre_radius": round(rad["FL"], 3), "tyre_radius_rear": round(rad["RL"], 3), "length": round(hi[1] - lo[1], 3),
        "tris": tris, "objects": len(meshes()), "materials": len({m.name for o in meshes() for m in o.data.materials if m})}
info = json.loads(json.dumps(info, default=float))
json.dump(info, open(os.path.join(OUT, NAME + ".json"), "w"), indent=1)
log("INFO", json.dumps(info))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, NAME + "_preview.blend"))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, NAME + "_raw.glb"), export_format="GLB", export_apply=True, export_image_format="AUTO")
log("wrote", OUT)
