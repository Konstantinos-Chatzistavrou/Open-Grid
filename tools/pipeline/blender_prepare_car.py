#!/usr/bin/env python3
"""
OpenGrid Unlimited Car Asset Pipeline — Headless Blender Processor (Blender 4.x / 5.x).

Supports two modes:
  1. --mode ingest   : Raw CC0/CC-BY car (.glb/.fbx/.obj/.blend) -> de-branded, restyled,
                       OpenGrid-badged, spoiler-separated, exhaust-anchored hero + traffic LOD GLB + metadata JSON.
  2. --mode retrofit : Existing hero GLB -> separates merged stock spoilers into a clean `wing` node
                       (using connected-component island extraction so zero faces are torn) and stamps
                       a sculpted 3D OpenGrid brand crest badge flush onto nose & tail normals.

Usage:
  blender -b --factory-startup -P tools/pipeline/blender_prepare_car.py -- \
    --mode retrofit --src input.glb --out output_raw.glb --brand valenza --spoiler-spec <json>

  blender -b --factory-startup -P tools/pipeline/blender_prepare_car.py -- \
    --mode ingest --config car_spec.json --src donor.glb --out-dir out/
"""
import argparse
import json
import math
import os
import re
import sys

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

# Source OEM / trademark tokens stripped automatically during copyright-safe ingestion
OEM_STRIP_RE = re.compile(
    r"(logo|emblem|badge|decal|brand|script|wordmark|letter|text|plate|license|licence|"
    r"ferrari|lamborghini|porsche|bmw|mercedes|audi|nissan|toyota|honda|mazda|subaru|"
    r"mitsubishi|ford|chevrolet|dodge|mclaren|bugatti|aston|pagani|koenigsegg|lotus|"
    r"maserati|alfa|corvette|mustang|camaro|gt-?r|skyline|supra|nsx|rx-?7|impreza|evo)",
    re.IGNORECASE,
)

SPOILER_NAME_RE = re.compile(
    r"(^|[_\s.-])(wing|spoiler|rear_wing|ducktail|gt_wing|tail_wing|aileron)($|[_\s.-])",
    re.IGNORECASE,
)

EXHAUST_NAME_RE = re.compile(r"(exhaust|tailpipe|muffler|tip_exhaust)", re.IGNORECASE)


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--mode", choices=("ingest", "retrofit"), required=True)
    p.add_argument("--src", required=True, help="Source .glb/.gltf/.fbx/.obj/.blend file")
    p.add_argument("--out", help="Output .glb path (retrofit mode)")
    p.add_argument("--out-dir", help="Output directory (ingest mode)")
    p.add_argument("--config", help="Car ingestion config JSON (ingest mode)")
    p.add_argument("--brand", default="valenza", help="OpenGrid marque (valenza|falcorn|kaze|kronos|aether)")
    p.add_argument("--spoiler-boxes", default="", help="JSON list of glTF-space boxes for merged spoiler island extraction")
    p.add_argument("--no-badges", action="store_true", help="Skip 3D OpenGrid badge placement")
    return p.parse_args(argv)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_source(path: str):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path, link=False) as (data_from, data_to):
            data_to.objects = data_from.objects
        for obj in data_to.objects:
            if obj is not None:
                bpy.context.scene.collection.objects.link(obj)
    else:
        raise ValueError(f"Unsupported input format: {ext}")


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.polygons) > 0]


def gltf_to_blender(gx, gy, gz):
    """glTF (X right/left, Y up, Z forward) -> Blender (X, -Z, Y)."""
    return Vector((gx, -gz, gy))


def blender_to_gltf(v: Vector):
    """Blender (X, Y, Z) -> glTF (X, Z, -Y)."""
    return Vector((v.x, v.z, -v.y))


def world_verts_gltf(obj):
    mw = obj.matrix_world
    return [blender_to_gltf(mw @ v.co) for v in obj.data.vertices]


def scene_body_bounds_gltf():
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in mesh_objects():
        if re.match(r"^(beam|shadow|blur)", o.name, re.I):
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            g = blender_to_gltf(mw @ v.co)
            mn.x = min(mn.x, g.x); mn.y = min(mn.y, g.y); mn.z = min(mn.z, g.z)
            mx.x = max(mx.x, g.x); mx.y = max(mx.y, g.y); mx.z = max(mx.z, g.z)
    return mn, mx


def extract_spoiler_islands(boxes_spec):
    """
    Separate merged stock spoiler geometry cleanly into a dedicated `wing` object using
    connected-component (bmesh island) analysis so zero faces are torn or jagged.
    Each spec entry:
      { "mesh": "<name or regex>", "min": [gx,gy,gz], "max": [gx,gy,gz], "min_ratio": 0.65 }
    """
    extracted_objs = []
    for spec in boxes_spec:
        pat = re.compile(spec.get("mesh", ".*"), re.IGNORECASE)
        gmin = spec["min"]
        gmax = spec["max"]
        min_ratio = float(spec.get("min_ratio", 0.65))
        max_verts = int(spec.get("max_verts", 200000))

        for obj in list(mesh_objects()):
            if not pat.search(obj.name):
                continue
            if obj.name == "wing" or obj.name.startswith("wing_"):
                continue

            bm = bmesh.new()
            bm.from_mesh(obj.data)
            bm.verts.ensure_lookup_table()
            bm.faces.ensure_lookup_table()
            mw = obj.matrix_world

            # Partition faces into connected islands via shared vertices
            visited = set()
            islands = []
            for f in bm.faces:
                if f.index in visited:
                    continue
                stack = [f]
                island = []
                visited.add(f.index)
                while stack:
                    cur = stack.pop()
                    island.append(cur)
                    for v in cur.verts:
                        for nf in v.link_faces:
                            if nf.index not in visited:
                                visited.add(nf.index)
                                stack.append(nf)
                islands.append(island)

            target_faces = set()
            for isl in islands:
                verts_set = {v for f in isl for v in f.verts}
                if len(verts_set) > max_verts:
                    continue
                inside = 0
                for v in verts_set:
                    g = blender_to_gltf(mw @ v.co)
                    if (
                        gmin[0] <= g.x <= gmax[0]
                        and gmin[1] <= g.y <= gmax[1]
                        and gmin[2] <= g.z <= gmax[2]
                    ):
                        inside += 1
                if verts_set and (inside / len(verts_set)) >= min_ratio:
                    for f in isl:
                        target_faces.add(f)

            if not target_faces:
                bm.free()
                continue

            # If ALL faces of this mesh belong to the spoiler, just rename/reparent it!
            if len(target_faces) == len(bm.faces):
                bm.free()
                obj.name = f"wing_part_{len(extracted_objs)}"
                extracted_objs.append(obj)
                continue

            # Create new mesh containing ONLY target_faces (preserving exact materials & UVs)
            bm_wing = bm.copy()
            bm_wing.faces.ensure_lookup_table()
            keep_ids = {f.index for f in target_faces}

            # Delete non-spoiler faces from bm_wing
            del_wing = [f for f in bm_wing.faces if f.index not in keep_ids]
            bmesh.ops.delete(bm_wing, geom=del_wing, context="FACES")
            # Remove orphan verts/edges
            orphan_v = [v for v in bm_wing.verts if not v.link_faces]
            if orphan_v:
                bmesh.ops.delete(bm_wing, geom=orphan_v, context="VERTS")

            # Delete spoiler faces from original mesh
            del_orig = [f for f in bm.faces if f.index in keep_ids]
            bmesh.ops.delete(bm, geom=del_orig, context="FACES")
            orphan_orig = [v for v in bm.verts if not v.link_faces]
            if orphan_orig:
                bmesh.ops.delete(bm, geom=orphan_orig, context="VERTS")

            bm.to_mesh(obj.data)
            obj.data.update()
            bm.free()

            w_mesh = bpy.data.meshes.new(f"wing_part_{len(extracted_objs)}_mesh")
            for mat in obj.data.materials:
                w_mesh.materials.append(mat)
            bm_wing.to_mesh(w_mesh)
            w_mesh.update()
            bm_wing.free()

            w_obj = bpy.data.objects.new(f"wing_part_{len(extracted_objs)}", w_mesh)
            w_obj.matrix_world = obj.matrix_world.copy()
            bpy.context.scene.collection.objects.link(w_obj)
            if obj.parent:
                w_obj.parent = obj.parent
                w_obj.matrix_parent_inverse = obj.matrix_parent_inverse.copy()
            extracted_objs.append(w_obj)
            print(f"[spoiler] Separated {len(keep_ids)} faces from '{obj.name}' into '{w_obj.name}'")

    if extracted_objs:
        # Group cleanly under a single `wing` parent empty so custom.ts hides ALL stock spoiler pieces cleanly
        parent_empty = bpy.data.objects.get("wing")
        if parent_empty is None or parent_empty.type != "EMPTY":
            parent_empty = bpy.data.objects.new("wing", None)
            bpy.context.scene.collection.objects.link(parent_empty)
        for o in extracted_objs:
            mw = o.matrix_world.copy()
            o.parent = parent_empty
            o.matrix_world = mw
    return extracted_objs


def create_brand_badge_material(brand: str):
    palette = {
        "valenza": ((0.88, 0.08, 0.14, 1.0), (0.95, 0.78, 0.25, 1.0)),
        "falcorn": ((0.12, 0.36, 0.88, 1.0), (0.85, 0.90, 0.96, 1.0)),
        "kaze":    ((0.92, 0.14, 0.32, 1.0), (0.94, 0.96, 0.98, 1.0)),
        "kronos":  ((0.12, 0.15, 0.22, 1.0), (0.05, 0.86, 0.96, 1.0)),
        "aether":  ((0.10, 0.12, 0.18, 1.0), (0.96, 0.20, 0.44, 1.0)),
    }
    base_col, trim_col = palette.get(brand, palette["valenza"])

    def make_mat(name, color, metal, rough):
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            bsdf.inputs["Metallic"].default_value = metal
            bsdf.inputs["Roughness"].default_value = rough
            if "Coat Weight" in bsdf.inputs:
                bsdf.inputs["Coat Weight"].default_value = 0.85
        return m

    return (
        make_mat(f"og_badge_{brand}_enamel", base_col, 0.25, 0.18),
        make_mat(f"og_badge_{brand}_chrome", trim_col, 0.96, 0.10),
    )


def build_brand_crest_mesh(name: str, brand: str, scale: float = 0.042):
    """Build a crisp original 3D sculpted OpenGrid brand crest (shield/hex/wings — zero OEM resemblance)."""
    enamel_mat, chrome_mat = create_brand_badge_material(brand)
    bm = bmesh.new()

    # Outer beveled crest outline (distinct silhouette per brand)
    if brand == "valenza":
        # Sculpted shield
        pts = [(0, 0.56), (0.44, 0.44), (0.42, -0.05), (0.24, -0.44), (0, -0.62), (-0.24, -0.44), (-0.42, -0.05), (-0.44, 0.44)]
    elif brand == "falcorn":
        # Swept twin-wing diamond crest
        pts = [(0, 0.44), (0.58, 0.18), (0.36, -0.22), (0, -0.48), (-0.36, -0.22), (-0.58, 0.18)]
    elif brand == "kaze":
        # Precision hexagonal rotor-blade crest
        pts = [(math.cos(a) * 0.52, math.sin(a) * 0.42) for a in [i * math.pi / 3 for i in range(6)]]
    elif brand == "kronos":
        # Geometric octagon
        pts = [(math.cos(a) * 0.48, math.sin(a) * 0.48) for a in [(i + 0.5) * math.pi / 4 for i in range(8)]]
    else:  # aether
        # Sleek delta aero-crest
        pts = [(0, 0.54), (0.52, -0.34), (0.18, -0.46), (0, -0.24), (-0.18, -0.46), (-0.52, -0.34)]

    # Back bezel (chrome) + slightly raised enamel inlay + raised metallic center chevron
    depth_base = 0.0045
    depth_inlay = 0.0068
    depth_emblem = 0.0092

    def add_prism(poly_2d, z0, z1, mat_idx):
        bverts = [bm.verts.new((px * scale, py * scale, z0)) for px, py in poly_2d]
        tverts = [bm.verts.new((px * scale, py * scale, z1)) for px, py in poly_2d]
        f_top = bm.faces.new(tverts)
        f_top.material_index = mat_idx
        f_bot = bm.faces.new(list(reversed(bverts)))
        f_bot.material_index = mat_idx
        n = len(poly_2d)
        for i in range(n):
            j = (i + 1) % n
            fs = bm.faces.new([bverts[i], bverts[j], tverts[j], tverts[i]])
            fs.material_index = mat_idx

    add_prism(pts, 0.0, depth_base, 1)  # chrome bezel
    inlay = [(px * 0.82, py * 0.82) for px, py in pts]
    add_prism(inlay, depth_base * 0.9, depth_inlay, 0)  # colored enamel field
    # Raised inner chevron / bar monogram
    bar = [(-0.28, 0.14), (0.0, -0.18), (0.28, 0.14), (0.18, 0.22), (0.0, 0.0), (-0.18, 0.22)]
    add_prism(bar, depth_inlay * 0.9, depth_emblem, 1)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.materials.append(enamel_mat)
    mesh.materials.append(chrome_mat)
    bm.to_mesh(mesh)
    mesh.update()
    bm.free()

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_body_bvh():
    """Build combined world-space BVHTree of the car's body meshes for flush badge snapping."""
    verts = []
    polys = []
    offset = 0
    for o in mesh_objects():
        if re.match(r"^(wheel|caliper|wing|beam|shadow|blur|badge_)", o.name, re.I):
            continue
        mw = o.matrix_world
        for v in o.data.vertices:
            verts.append(mw @ v.co)
        for p in o.data.polygons:
            if len(p.vertices) == 3:
                polys.append((p.vertices[0] + offset, p.vertices[1] + offset, p.vertices[2] + offset))
            elif len(p.vertices) == 4:
                v0, v1, v2, v3 = p.vertices
                polys.append((v0 + offset, v1 + offset, v2 + offset))
                polys.append((v0 + offset, v2 + offset, v3 + offset))
        offset += len(o.data.vertices)
    if not polys:
        return None
    return BVHTree.FromPolygons(verts, polys)


def place_3d_brand_badges(brand: str):
    """Raycast-snap sculpted 3D OpenGrid brand crests flush onto front nose & rear deck surface normals."""
    # Remove any old OpenGrid badges if re-running
    for old_name in ("badge_nose", "badge_rear"):
        old = bpy.data.objects.get(old_name)
        if old:
            bpy.data.objects.remove(old, do_unlink=True)

    bvh = build_body_bvh()
    if bvh is None:
        return
    mn, mx = scene_body_bounds_gltf()
    h = mx.y - mn.y

    # Front nose probe: cast from slightly ahead & above nose downward/backward onto the painted nose fascia
    nose_targets = [
        (gltf_to_blender(0.0, mn.y + h * 0.56, mx.z + 0.6), gltf_to_blender(0.0, -0.25, -1.0).normalized()),
        (gltf_to_blender(0.0, mn.y + h * 0.44, mx.z + 0.6), gltf_to_blender(0.0, -0.10, -1.0).normalized()),
        (gltf_to_blender(0.0, mn.y + h * 0.62, mx.z - 0.15), gltf_to_blender(0.0, -1.0, 0.0)),
    ]
    for origin, direction in nose_targets:
        loc, norm, _, dist = bvh.ray_cast(origin, direction, 2.0)
        if loc is not None and norm is not None and norm.length > 0.1:
            n = norm.normalized()
            if n.dot(direction) > 0:
                n = -n
            badge = build_brand_crest_mesh("badge_nose", brand, scale=0.044)
            rot = n.to_track_quat("Z", "Y").to_matrix().to_4x4()
            badge.matrix_world = Matrix.Translation(loc + n * 0.0025) @ rot
            print(f"[badge] Placed 3D {brand} crest 'badge_nose' flush at {tuple(round(x, 3) for x in loc)}")
            break

    # Rear tail probe: cast from behind rear fascia forward onto trunk / rear panel
    rear_targets = [
        (gltf_to_blender(0.0, mn.y + h * 0.62, mn.z - 0.6), gltf_to_blender(0.0, -0.05, 1.0).normalized()),
        (gltf_to_blender(0.0, mn.y + h * 0.52, mn.z - 0.6), gltf_to_blender(0.0, 0.0, 1.0)),
        (gltf_to_blender(0.0, mn.y + h * 0.72, mn.z + 0.18), gltf_to_blender(0.0, -1.0, 0.0)),
    ]
    for origin, direction in rear_targets:
        loc, norm, _, dist = bvh.ray_cast(origin, direction, 2.0)
        if loc is not None and norm is not None and norm.length > 0.1:
            n = norm.normalized()
            if n.dot(direction) > 0:
                n = -n
            badge = build_brand_crest_mesh("badge_rear", brand, scale=0.040)
            rot = n.to_track_quat("Z", "Y").to_matrix().to_4x4()
            badge.matrix_world = Matrix.Translation(loc + n * 0.0025) @ rot
            print(f"[badge] Placed 3D {brand} crest 'badge_rear' flush at {tuple(round(x, 3) for x in loc)}")
            break


def strip_oem_branding(extra_patterns=None):
    """Delete all OEM emblem/logo/wordmark/plate meshes and trademark materials so zero copyrighted marks survive."""
    pats = [OEM_STRIP_RE] + [re.compile(p, re.I) for p in (extra_patterns or [])]
    removed = 0
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith("badge_"):
            continue
        hit = any(p.search(obj.name) for p in pats)
        if not hit and obj.type == "MESH" and obj.data.materials:
            hit = all(m is not None and any(p.search(m.name) for p in pats) for m in obj.data.materials)
        if hit:
            bpy.data.objects.remove(obj, do_unlink=True)
            removed += 1
    print(f"[debrand] Stripped {removed} OEM emblem/logo/plate objects")
    return removed


def apply_ffd_restyle(shape_cfg):
    """Apply smooth proportional silhouette restyling (nose taper/length, roof drop, rear haunches) so zero OEM trade dress remains."""
    if not shape_cfg:
        return
    mn, mx = scene_body_bounds_gltf()
    span_x = max(0.5, mx.x - mn.x)
    span_y = max(0.5, mx.y - mn.y)
    span_z = max(1.0, mx.z - mn.z)
    nose_len = float(shape_cfg.get("nose_len", 0.04))
    nose_taper = float(shape_cfg.get("nose_taper", -0.03))
    roof_drop = float(shape_cfg.get("roof_drop", -0.025))
    haunch = float(shape_cfg.get("haunch", 0.035))

    def sstep(a, b, x):
        t = max(0.0, min(1.0, (x - a) / (b - a)))
        return t * t * (3.0 - 2.0 * t)

    for obj in mesh_objects():
        if re.match(r"^(wheel|caliper|disc|hub|badge_)", obj.name, re.I):
            continue
        mw = obj.matrix_world
        inv = mw.inverted()
        for v in obj.data.vertices:
            g = blender_to_gltf(mw @ v.co)
            u = (g.z - mn.z) / span_z  # 0 = rear, 1 = front
            vh = (g.y - mn.y) / span_y
            front_k = sstep(0.62, 1.0, u)
            rear_k = sstep(0.38, 0.0, u)
            roof_k = sstep(0.58, 0.96, vh) * sstep(0.18, 0.45, u) * sstep(0.82, 0.55, u)
            g.z += nose_len * front_k
            g.x *= 1.0 + nose_taper * front_k + haunch * rear_k * sstep(0.2, 0.65, vh)
            g.y += roof_drop * roof_k
            v.co = inv @ gltf_to_blender(g)
        obj.data.update()
    print("[restyle] Applied smooth proportional FFD restyling")


def detect_exhaust_nozzles_metadata():
    """Find exhaust meshes (or rear diffuser fallback) and return glTF-space nozzle coordinates for visual.json."""
    nozzles = []
    for o in mesh_objects():
        mats = " ".join(m.name for m in o.data.materials if m)
        if not (EXHAUST_NAME_RE.search(o.name) or EXHAUST_NAME_RE.search(mats)):
            continue
        mw = o.matrix_world
        pts = [blender_to_gltf(mw @ v.co) for v in o.data.vertices]
        if not pts:
            continue
        min_z = min(p.z for p in pts)
        rear = [p for p in pts if p.z <= min_z + 0.08]
        # Cluster left vs right (or center)
        left = [p for p in rear if p.x > 0.08]
        right = [p for p in rear if p.x < -0.08]
        center = [p for p in rear if abs(p.x) <= 0.08]
        for grp in (left, right, center):
            if len(grp) < 3:
                continue
            cx = sum(p.x for p in grp) / len(grp)
            cy = sum(p.y for p in grp) / len(grp)
            cz = min(p.z for p in grp)
            nozzles.append({"x": round(cx, 3), "y": round(cy, 3), "z": round(cz, 3), "r": 0.055})
    return nozzles


def export_glb(path: str):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    print(f"[export] Wrote {path} ({os.path.getsize(path) / 1024:.1f} KB)")


def main():
    args = parse_args()
    clear_scene()
    import_source(args.src)

    if args.mode == "retrofit":
        if args.spoiler_boxes:
            boxes = json.loads(args.spoiler_boxes)
            extract_spoiler_islands(boxes)
        if not args.no_badges:
            place_3d_brand_badges(args.brand)
        export_glb(args.out)
        return

    # Full copyright-safe ingest mode
    cfg = json.load(open(args.config)) if args.config else {}
    car_id = cfg.get("id", os.path.splitext(os.path.basename(args.src))[0])
    brand = cfg.get("brand", args.brand)
    out_dir = args.out_dir or os.path.dirname(os.path.abspath(args.src))
    os.makedirs(out_dir, exist_ok=True)

    # 1. Strip all OEM logos, emblems, badges, wordmarks & plates
    strip_oem_branding(cfg.get("strip_patterns"))

    # 2. Orient & scale to target wheelbase (if specified)
    mn, mx = scene_body_bounds_gltf()
    rot_z_deg = float(cfg.get("rotate_y_deg", 0.0))
    if abs(rot_z_deg) > 0.01:
        for o in bpy.context.scene.objects:
            if o.parent is None:
                o.rotation_euler.z += math.radians(rot_z_deg)
        bpy.context.view_layer.update()
        mn, mx = scene_body_bounds_gltf()

    target_len = float(cfg.get("length_m", 0.0))
    cur_len = max(0.5, mx.z - mn.z)
    scale_f = (target_len / cur_len) if target_len > 0 else 1.0
    cx = (mn.x + mx.x) * 0.5
    cz = (mn.z + mx.z) * 0.5
    for o in bpy.context.scene.objects:
        if o.parent is None:
            o.location = (o.location - gltf_to_blender(cx, mn.y, cz)) * scale_f
            o.scale *= scale_f
    bpy.context.view_layer.update()

    # 3. Apply proportional FFD restyling (copyright/trade-dress differentiation)
    apply_ffd_restyle(cfg.get("restyle", {"nose_len": 0.035, "nose_taper": -0.025, "roof_drop": -0.02, "haunch": 0.03}))

    # 4. Separate any stock spoiler into a clean `wing` node (by name or bbox spec)
    spoiler_boxes = cfg.get("spoiler_boxes", [])
    if spoiler_boxes:
        extract_spoiler_islands(spoiler_boxes)
    else:
        for o in mesh_objects():
            if SPOILER_NAME_RE.search(o.name) and not o.name.startswith("wing"):
                o.name = f"wing_{o.name}"

    # 5. Stamp sculpted 3D OpenGrid Brand Crest badges flush onto nose & tail normals
    if not args.no_badges:
        place_3d_brand_badges(brand)

    # 6. Export hero GLB + metadata JSON (bounds, exhaust nozzles, polycount, wheel hubs)
    hero_raw = os.path.join(out_dir, f"{car_id}_raw.glb")
    export_glb(hero_raw)

    mn2, mx2 = scene_body_bounds_gltf()
    total_tris = sum(sum(max(1, len(p.vertices) - 2) for p in o.data.polygons) for o in mesh_objects())
    nozzles = detect_exhaust_nozzles_metadata()
    meta = {
        "id": car_id,
        "brand": brand,
        "bounds_gltf": {"min": [round(mn2.x, 3), round(mn2.y, 3), round(mn2.z, 3)], "max": [round(mx2.x, 3), round(mx2.y, 3), round(mx2.z, 3)]},
        "tris": total_tris,
        "has_stock_wing": any(o.name == "wing" or o.name.startswith("wing_") for o in bpy.context.scene.objects),
        "has_badges": bool(bpy.data.objects.get("badge_nose")),
        "exhaust_nozzles": nozzles,
    }
    meta_path = os.path.join(out_dir, f"{car_id}_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[meta] Wrote {meta_path} (tris={total_tris}, wing={meta['has_stock_wing']}, badges={meta['has_badges']})")


if __name__ == "__main__":
    main()
