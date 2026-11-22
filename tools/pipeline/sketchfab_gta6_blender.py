#!/usr/bin/env python3
"""
Apache-2.0 — OpenGrid GTA 6-Style Headless Blender Car Processor (Blender 4.x / 5.x).

Converts any CC-BY / CC0 Sketchfab car (.glb / .gltf) into a clean, de-branded, GTA 6-style
subtly restyled, spinning-wheel, Garage-recolourable, OpenGrid-badged hero GLB ready for both
WebGPU (meshopt + WebP, ~55k-85k tris) and UE 5.8 import.

Key guarantees:
  - Preserves the car's iconic silhouette with subtle GTA 6-style proportional restyling (~2.5%).
  - Strips OEM logos/emblems/plates/text safely WITHOUT deleting car body meshes whose names
    happen to contain a manufacturer word (e.g. `Lambo_Door`, `Ferrari_Body`).
  - Auto-orients to OpenGrid convention (Blender -Y forward = glTF +Z forward, +X left, Z >= 0).
  - Groups wheel/tyre/rim meshes cleanly into 4 corner objects (`wheel_FL`, `wheel_FR`, `wheel_RL`,
    `wheel_RR`) with each object's pivot centered on its true axle hub -> zero frozen/wobbling wheels.
  - Renames the primary exterior body paint material to `paint` (clearcoat metallic) for Garage color swaps.
  - Decimates ultra-dense meshes (e.g. 330k-face rims) cleanly to WebGPU budget while keeping bodywork crisp.
  - Separates stock spoilers into `wing`, stamps sculpted 3D OpenGrid brand crests (`badge_nose`,
    `badge_rear`), and detects exact exhaust nozzle coordinates for tailpipe flames.
"""
import argparse
import json
import math
import os
import re
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from blender_prepare_car import (  # noqa: E402
    blender_to_gltf,
    gltf_to_blender,
    place_3d_brand_badges,
    detect_exhaust_nozzles_metadata,
)

# Safe de-brand patterns: ONLY strip badges/logos/plates/text/stickers/decals (NEVER full body panels!)
BADGE_STRIP_RE = re.compile(
    r"(^|[_\s.-])(logo|emblem|badge|badges|decal|decals|sticker|stickers|wordmark|script|lettering|"
    r"letters|text|plate|plates|license|licence|numberplate|regplate|brand_logo|crest|shield|"
    r"scuderia|cavallino|trident|bull_logo|star_logo|rings_logo)($|[_\s.-])",
    re.IGNORECASE,
)

# Studio / floor / shadow backdrop meshes to discard
DROP_ENV_RE = re.compile(
    r"(^|[_\s.-])(shadow|shadowplane|shadow_plane|ground|floor|stage|backdrop|studio|turntable|pedestal|plane_shadow|light_plane)($|[_\s.-])",
    re.IGNORECASE,
)

WHEEL_RE = re.compile(
    r"(wheel|tire|tyre|rim|alloy|spoke|hubcap|wheel_lip|tire_mat|tyre_mat|pneu|roue|ruota|cerchio|gomma|felge|reifen|jante|ssrformula|bbs|enkei|te37)",
    re.IGNORECASE,
)
CALIPER_RE = re.compile(r"(caliper|calipper|pinza|brembo|brake_cal|bremssattel)", re.IGNORECASE)
SPOILER_RE = re.compile(r"(^|[_\s.-])(wing|spoiler|rear_wing|ducktail|gt_wing|tail_wing|aileron|alettone)($|[_\s.-])", re.IGNORECASE)
HEADLIGHT_RE = re.compile(r"(headlight|head_light|headlamp|front_light|drl|faro|farol)", re.IGNORECASE)
TAILLIGHT_RE = re.compile(r"(taillight|tail_light|taillamp|rear_light|brake_light|stop_light|fanale)", re.IGNORECASE)
EXHAUST_RE = re.compile(r"(exhaust|tailpipe|muffler|exh_|scarico|auspuff)", re.IGNORECASE)
GLASS_RE = re.compile(r"(glass|window|windshield|windscreen|vetro|vitre|transparent|lens|cristal)", re.IGNORECASE)
DARK_TRIM_RE = re.compile(
    r"(black|dark|carbon|carbonio|plastic|plastica|rubber|tire|tyre|chrome|metal|alu|steel|iron|"
    r"interior|interno|interni|seat|leather|alcantara|cloth|fabric|carpet|dash|steering|engine|"
    r"motor|radiator|cool|intercooler|grille|grid|mesh|vent|disc|rotor|brake|caliper|exhaust|"
    r"pipe|wheel|rim|emis|light|lamp|led|glass|window|mirror|undercarriage|chassis|frame|floor|"
    r"screw|bolt|nut|wire|hose|misc|detail|trim|gloss_black|matte|satin)",
    re.IGNORECASE,
)


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--src", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--brand", default="kronos")
    p.add_argument("--length-m", type=float, default=4.50)
    p.add_argument("--flip-180", action="store_true")
    p.add_argument("--rot-z-deg", type=float, default=0.0)
    p.add_argument("--paint-match", default="", help="Optional regex for primary exterior paint material")
    p.add_argument("--target-tris", type=int, default=72000)
    p.add_argument("--max-tex", type=int, default=1024)
    p.add_argument("--restyle-scale", type=float, default=1.0, help="Multiplier on subtle GTA 6 FFD (1.0 = ~2.5%)")
    return p.parse_args(argv)


def mesh_objs():
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and o.data and len(o.data.polygons) > 0]


def world_bbox(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        mw = o.matrix_world
        for v in o.data.vertices:
            p = mw @ v.co
            if p.x < mn.x: mn.x = p.x
            if p.y < mn.y: mn.y = p.y
            if p.z < mn.z: mn.z = p.z
            if p.x > mx.x: mx.x = p.x
            if p.y > mx.y: mx.y = p.y
            if p.z > mx.z: mx.z = p.z
    return mn, mx


def obj_bbox(o):
    return world_bbox([o])


def bake_all_transforms():
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    for o in list(bpy.context.scene.objects):
        if o.type != "MESH":
            continue
        if o.modifiers:
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            o.modifiers.clear()
            o.data = me
        elif o.data and o.data.users > 1:
            o.data = o.data.copy()
        mw = o.matrix_world.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in [o for o in bpy.data.objects if o.type != "MESH"]:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in [o for o in bpy.data.objects if o.type == "MESH" and (not o.data or len(o.data.polygons) == 0)]:
        bpy.data.objects.remove(o, do_unlink=True)


def strip_env_and_badges():
    removed_env = 0
    removed_badge = 0
    objs = mesh_objs()
    if not objs:
        return
    all_mn, all_mx = world_bbox(objs)
    car_diag = max(1.0, (all_mx - all_mn).length)

    for o in list(objs):
        mn, mx = obj_bbox(o)
        sz = mx - mn
        mats = " ".join(m.name for m in o.data.materials if m)
        # Drop huge flat ground / shadow planes
        is_flat_big = (sz.z < car_diag * 0.015) and (max(sz.x, sz.y) > car_diag * 0.55) and (mn.z <= all_mn.z + car_diag * 0.04)
        if DROP_ENV_RE.search(o.name) or DROP_ENV_RE.search(mats) or is_flat_big:
            bpy.data.objects.remove(o, do_unlink=True)
            removed_env += 1
            continue
        # Safely strip logos/badges/plates/wordmarks (guard: never delete giant body panels > 45% of car length!)
        if (BADGE_STRIP_RE.search(o.name) or BADGE_STRIP_RE.search(mats)) and max(sz.x, sz.y, sz.z) < car_diag * 0.45:
            bpy.data.objects.remove(o, do_unlink=True)
            removed_badge += 1
            continue
        # Strip tiny garbled/non-ASCII sticker/decal overlays (e.g. fender skull/text packs)
        has_garbled = any(ord(ch) > 126 or ch == "\ufffd" for ch in o.name)
        if has_garbled and sz.length < car_diag * 0.10:
            bpy.data.objects.remove(o, do_unlink=True)
            removed_badge += 1
            continue
        # Strip flat emissive text/wordmark strips (e.g. hood/bumper lettering)
        if "white emis" in (o.name + " " + mats).lower() and max(sz.x, sz.y, sz.z) < car_diag * 0.14 and len(o.data.polygons) < 120:
            bpy.data.objects.remove(o, do_unlink=True)
            removed_badge += 1
    print(f"[clean] Dropped {removed_env} env/shadow planes, stripped {removed_badge} OEM badge/plate/decal objects")


def strip_centerline_emblems():
    """Remove tiny OEM nose/tail shields on the centerline right where our 3D crests sit."""
    objs = [o for o in mesh_objs() if not o.name.startswith(("wheel_", "badge_"))]
    if not objs:
        return
    mn, mx = world_bbox(objs)
    removed = 0
    for o in list(objs):
        om, ox = obj_bbox(o)
        sz = ox - om
        ctr = (om + ox) * 0.5
        if max(sz.x, sz.y, sz.z) > 0.14:
            continue
        near_nose = abs(ctr.x) < 0.05 and ctr.y < mn.y + 0.25 and ctr.z > mn.z + 0.25
        near_tail = abs(ctr.x) < 0.05 and ctr.y > mx.y - 0.25 and ctr.z > mn.z + 0.35
        if near_nose or near_tail:
            bpy.data.objects.remove(o, do_unlink=True)
            removed += 1
    if removed:
        print(f"[clean] Stripped {removed} centerline OEM nose/tail emblem mesh(es)")


def auto_orient_and_scale(target_len_m: float, extra_rot_z: float, flip_180: bool):
    objs = mesh_objs()
    mn, mx = world_bbox(objs)
    sz = mx - mn

    # 1. Align longest horizontal axis to Blender Y (glTF Z)
    rot_deg = extra_rot_z
    if sz.x > sz.y * 1.15 and abs(extra_rot_z) < 0.1:
        rot_deg += 90.0

    if abs(rot_deg) > 0.1:
        R = Matrix.Rotation(math.radians(rot_deg), 4, "Z")
        for o in objs:
            o.data.transform(R)

    # 2. Detect front vs rear (OpenGrid convention: front = Blender -Y, rear = Blender +Y)
    mn, mx = world_bbox(objs)
    mid_y = 0.5 * (mn.y + mx.y)
    # Score hints: exhaust & spoiler & taillight should be at +Y (rear); headlights at -Y (front)
    rear_score = 0.0
    for o in objs:
        om, ox = obj_bbox(o)
        cy = 0.5 * (om.y + ox.y)
        side = 1.0 if cy > mid_y else -1.0  # +1 if at +Y, -1 if at -Y
        tag = o.name + " " + " ".join(m.name for m in o.data.materials if m)
        if EXHAUST_RE.search(tag):
            rear_score += 2.5 * side
        if SPOILER_RE.search(tag):
            rear_score += 2.0 * side
        if TAILLIGHT_RE.search(tag):
            rear_score += 1.5 * side
        if HEADLIGHT_RE.search(tag):
            rear_score -= 1.5 * side

    need_flip = bool(flip_180) ^ (rear_score < -0.5)
    if need_flip:
        R180 = Matrix.Rotation(math.pi, 4, "Z")
        for o in objs:
            o.data.transform(R180)
        print(f"[orient] Rotated 180 deg so front faces -Y/glTF+Z (rear_score={rear_score:.1f})")

    # 3. Scale to target_len_m, center X & Y, place tyres cleanly on Z = 0
    mn, mx = world_bbox(objs)
    cur_len = max(1e-4, mx.y - mn.y)
    scale_f = target_len_m / cur_len if target_len_m > 0 else 1.0
    cx = 0.5 * (mn.x + mx.x)
    cy = 0.5 * (mn.y + mx.y)
    min_z = mn.z
    T = Matrix.Scale(scale_f, 4) @ Matrix.Translation(Vector((-cx, -cy, -min_z)))
    for o in objs:
        o.data.transform(T)
        o.data.update()
    mn2, mx2 = world_bbox(objs)
    print(f"[scale] Normalized size: X={mx2.x-mn2.x:.3f}m Y(len)={mx2.y-mn2.y:.3f}m Z(h)={mx2.z-mn2.z:.3f}m (scale={scale_f:.4f})")


def split_loose_objects(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    return list(bpy.context.selected_objects)


def join_objects(objs, name):
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active
    out.name = name
    return out


def decimate_object(o, target_faces: int):
    cur = len(o.data.polygons)
    if cur <= target_faces or target_faces < 200:
        return
    ratio = max(0.04, min(0.95, target_faces / float(cur)))
    mod = o.modifiers.new(name="Decim", type="DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=mod.name)


def group_four_spinning_wheels():
    """
    Find all wheel/tyre/rim meshes, group by 4 corners (`wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR`),
    decimate overly-dense rims cleanly, and set each wheel object's origin pivot to its exact axle center!
    """
    objs = mesh_objs()
    mn, mx = world_bbox(objs)
    half_x = 0.5 * (mx.x - mn.x)
    half_y = 0.5 * (mx.y - mn.y)

    # First identify explicit wheel candidates (excluding brake calipers & huge non-wheel parts)
    wheel_parts = []
    for o in list(objs):
        tag = o.name + " " + " ".join(m.name for m in o.data.materials if m)
        if CALIPER_RE.search(tag) or EXHAUST_RE.search(tag) or SPOILER_RE.search(tag):
            continue
        if not WHEEL_RE.search(tag):
            continue
        om, ox = obj_bbox(o)
        sz = ox - om
        # Guard against exhaust tubes/body trim sharing a wheel_lip material
        if sz.x > half_x * 1.4 or sz.y > half_y * 1.3:
            # Might be a combined 4-wheel mesh! Split loose if it spans both left & right sides
            if om.x < -0.35 and ox.x > 0.35 and om.z < 0.25 and ox.z < 0.92:
                parts = split_loose_objects(o)
                for p in parts:
                    pm, px = obj_bbox(p)
                    pc = 0.5 * (pm + px)
                    if abs(pc.x) > half_x * 0.42 and abs(pc.y) > half_y * 0.25 and pc.z < 0.55:
                        wheel_parts.append(p)
            continue
        c = 0.5 * (om + ox)
        # True wheel parts sit near the outer corners (|x| > 42% half-width, |y| > 24% half-length, z < 0.56 m)
        if abs(c.x) > half_x * 0.42 and abs(c.y) > half_y * 0.24 and c.z < 0.58 and sz.z < 0.90:
            wheel_parts.append(o)

    # Assign each wheel part to its corner:
    # OpenGrid glTF: +X = left, +Z = front -> Blender: +X = left, -Y = front!
    corners = {"wheel_FL": [], "wheel_FR": [], "wheel_RL": [], "wheel_RR": []}
    for o in wheel_parts:
        om, ox = obj_bbox(o)
        c = 0.5 * (om + ox)
        is_front = c.y < 0.0
        is_left = c.x > 0.0
        key = ("wheel_F" if is_front else "wheel_R") + ("L" if is_left else "R")
        corners[key].append(o)

    wheel_hubs = {}
    for key, grp in corners.items():
        if not grp:
            print(f"[wheels] WARN: no wheel meshes found for {key}")
            continue
        w = join_objects(grp, key)
        # Decimate overly dense 100k-face rims down to crisp ~5,500 faces per wheel!
        if len(w.data.polygons) > 6500:
            before = len(w.data.polygons)
            decimate_object(w, 5500)
            print(f"[wheels] Decimated {key}: {before} -> {len(w.data.polygons)} faces")
        # Pivot wheel cleanly at its exact geometric axle center so Three.js & UE 5.8 spin smoothly!
        wm, wx = obj_bbox(w)
        hub = 0.5 * (wm + wx)
        w.data.transform(Matrix.Translation(-hub))
        w.location = hub
        w.data.update()
        wheel_hubs[key] = [round(v, 3) for v in blender_to_gltf(hub)]
        print(f"[wheels] {key}: {len(w.data.polygons)} faces, pivot(glTF)={wheel_hubs[key]}, r={0.5*(wx.z-wm.z):.3f}m")
    return wheel_hubs


def apply_subtle_gta6_restyle(restyle_scale: float):
    """Subtle GTA 6-style (~2.5%) proportional silhouette tweak: unmistakable dream car, zero raw copy."""
    if restyle_scale <= 0.0:
        return
    body_objs = [o for o in mesh_objs() if not o.name.startswith(("wheel_", "badge_"))]
    mn, mx = world_bbox(body_objs)
    span_y = max(1.0, mx.y - mn.y)
    span_z = max(0.5, mx.z - mn.z)

    nose_len = 0.032 * restyle_scale
    nose_taper = -0.022 * restyle_scale
    roof_drop = -0.018 * restyle_scale
    haunch = 0.026 * restyle_scale

    def sstep(a, b, x):
        t = max(0.0, min(1.0, (x - a) / (b - a)))
        return t * t * (3.0 - 2.0 * t)

    for o in body_objs:
        mw = o.matrix_world
        inv = mw.inverted()
        for v in o.data.vertices:
            p = mw @ v.co
            # u: 0 = rear (+Y), 1 = front (-Y)
            u = (mx.y - p.y) / span_y
            vh = (p.z - mn.z) / span_z
            front_k = sstep(0.64, 1.0, u)
            rear_k = sstep(0.36, 0.0, u)
            roof_k = sstep(0.58, 0.96, vh) * sstep(0.18, 0.45, u) * sstep(0.82, 0.55, u)
            p.y -= nose_len * front_k
            p.x *= 1.0 + nose_taper * front_k + haunch * rear_k * sstep(0.22, 0.65, vh)
            p.z += roof_drop * roof_k
            v.co = inv @ p
        o.data.update()
    print(f"[restyle] Applied subtle GTA 6 proportional FFD (scale={restyle_scale:.2f})")


def setup_paint_material(paint_match: str):
    """Detect the primary exterior body paint material and rename it cleanly to `paint` for Garage color swaps."""
    mat_faces = {}
    body_objs = [o for o in mesh_objs() if not o.name.startswith(("wheel_", "badge_"))]
    for o in body_objs:
        for p in o.data.polygons:
            if p.material_index < len(o.data.materials):
                m = o.data.materials[p.material_index]
                if m:
                    mat_faces[m.name] = mat_faces.get(m.name, 0) + 1

    chosen = None
    if paint_match:
        rx = re.compile(paint_match, re.I)
        matches = [(m, f) for m, f in mat_faces.items() if rx.search(m)]
        if matches:
            chosen = max(matches, key=lambda x: x[1])[0]

    if not chosen:
        # Prefer explicit paint/carpaint/body material name
        for pat in [r"(car_?paint|body_?paint|ext_?paint|paint)", r"(carrozzeria|body_?color|red|blue|yellow|orange|green|white|silver|grey|metallic)"]:
            rx = re.compile(pat, re.I)
            matches = [(m, f) for m, f in mat_faces.items() if rx.search(m) and not DARK_TRIM_RE.search(m)]
            if matches:
                chosen = max(matches, key=lambda x: x[1])[0]
                break

    if not chosen:
        # Largest non-dark/non-glass/non-interior material
        cands = [(m, f) for m, f in mat_faces.items() if not DARK_TRIM_RE.search(m) and not GLASS_RE.search(m)]
        if cands:
            chosen = max(cands, key=lambda x: x[1])[0]

    if not chosen and mat_faces:
        chosen = max(mat_faces.items(), key=lambda x: x[1])[0]

    if chosen:
        # Merge any `.001` duplicate of the chosen paint material into `paint`
        base_prefix = re.sub(r"\.\d+$", "", chosen)
        target_mat = bpy.data.materials.get(chosen)
        if target_mat:
            # Ensure no name clash
            if "paint" in bpy.data.materials and bpy.data.materials["paint"] != target_mat:
                bpy.data.materials["paint"].name = "paint_orig"
            target_mat.name = "paint"
            target_mat.use_nodes = True
            bsdf = target_mat.node_tree.nodes.get("Principled BSDF")
            if bsdf:
                # Disconnect base color texture if it's a solid-color paint map so Garage tinting works 100% cleanly!
                bc = bsdf.inputs.get("Base Color")
                if bc and bc.is_linked and not re.search(r"livery|stripe", chosen, re.I):
                    for link in list(bc.links):
                        target_mat.node_tree.links.remove(link)
                bsdf.inputs["Metallic"].default_value = 0.72
                bsdf.inputs["Roughness"].default_value = 0.16
                if "Coat Weight" in bsdf.inputs:
                    bsdf.inputs["Coat Weight"].default_value = 1.0
                if "Coat Roughness" in bsdf.inputs:
                    bsdf.inputs["Coat Roughness"].default_value = 0.04
            # Also remap `<base_prefix>.001` etc. to the single unified `paint` material!
            for o in body_objs:
                for i, m in enumerate(o.data.materials):
                    if m and m != target_mat and re.sub(r"\.\d+$", "", m.name) == base_prefix:
                        o.data.materials[i] = target_mat
            print(f"[paint] Unified primary body material '{chosen}' -> 'paint' ({mat_faces.get(chosen, 0)} faces)")
            return "paint"
    return "paint"


def decimate_body_to_budget(target_total_tris: int):
    objs = mesh_objs()
    wheel_tris = sum(len(o.data.polygons) for o in objs if o.name.startswith("wheel_"))
    body_objs = [o for o in objs if not o.name.startswith(("wheel_", "badge_"))]
    body_tris = sum(len(o.data.polygons) for o in body_objs)
    budget = max(25000, target_total_tris - wheel_tris)
    if body_tris <= budget:
        print(f"[budget] Body already within budget ({body_tris} + {wheel_tris} wheel = {body_tris + wheel_tris} faces)")
        return

    # 1. Aggressively decimate interior/engine/undercarriage parts — NEVER touch `paint` exterior panels here!
    for o in body_objs:
        mats = " ".join(m.name for m in o.data.materials if m)
        is_paint = any(m and m.name == "paint" for m in o.data.materials)
        cur = len(o.data.polygons)
        if not is_paint and cur > 2500 and re.search(
            r"interior|interno|interni|alcantara|engine|motor|cool|chassis|cloth|seat|plastica|1blue|emiss|white_emis|turbo|bolt|pipe|intercool|airfilter|gear|tube|mesh",
            o.name + " " + mats,
            re.I,
        ):
            decimate_object(o, max(700, int(cur * 0.18)))

    # 2. If still over budget, decimate non-paint trim/carbon panels first while preserving `paint` shells 100% crisp!
    paint_objs = [o for o in body_objs if any(m and m.name == "paint" for m in o.data.materials)]
    non_paint_objs = [o for o in body_objs if o not in paint_objs]
    paint_tris = sum(len(o.data.polygons) for o in paint_objs)
    non_paint_tris = sum(len(o.data.polygons) for o in non_paint_objs)

    if paint_tris + non_paint_tris > budget and non_paint_tris > 0:
        non_paint_budget = max(12000, budget - paint_tris)
        scale = min(0.92, max(0.14, non_paint_budget / float(non_paint_tris)))
        for o in sorted(non_paint_objs, key=lambda x: -len(x.data.polygons)):
            cur = len(o.data.polygons)
            if cur < 500:
                continue
            decimate_object(o, max(350, int(cur * scale)))

    # 3. Only touch `paint` shells if paint alone exceeds 55,000 faces (never causes under-layer poke-through on normal cars)
    if paint_tris > 55000:
        pscale = 55000.0 / float(paint_tris)
        for o in sorted(paint_objs, key=lambda x: -len(x.data.polygons)):
            cur = len(o.data.polygons)
            if cur < 1200:
                continue
            decimate_object(o, max(800, int(cur * pscale)))

    final_body = sum(len(o.data.polygons) for o in body_objs)
    print(f"[budget] Decimated body {body_tris} -> {final_body} faces (paint preserved={sum(len(o.data.polygons) for o in paint_objs)}, total with wheels={final_body + wheel_tris})")


def downscale_packed_images(max_dim: int):
    scaled = 0
    for img in bpy.data.images:
        w, h = img.size[0], img.size[1]
        if max(w, h) > max_dim and w > 0 and h > 0:
            s = max_dim / float(max(w, h))
            img.scale(max(16, int(round(w * s))), max(16, int(round(h * s))))
            try:
                img.pack()
            except Exception:
                pass
            scaled += 1
    if scaled:
        print(f"[tex] Downscaled {scaled} textures to <= {max_dim}px")


def separate_stock_spoilers():
    idx = 0
    for o in mesh_objs():
        if o.name.startswith(("wheel_", "badge_", "wing")):
            continue
        if SPOILER_RE.search(o.name):
            o.name = "wing" if idx == 0 else f"wing_{idx}"
            idx += 1


OEM_NAME_RE = re.compile(
    r"(lambo|lamborghini|gallardo|huracan|aventador|centenario|sesto|sto|trofeo|"
    r"ferrari|scuderia|laferrari|pista|daytona|sf90|f12|812|"
    r"porsche|carrera|weissach|mclaren|koenigsegg|jesko|agera|"
    r"nissan|skyline|mazda|toyota|supra|honda|acura|nsx|lancia|delta|dodge|challenger|srt|hellcat|demon|chevrolet|brembo)",
    re.IGNORECASE,
)


def sanitize_names_and_collect_lights():
    front_lights = []
    rear_lights = []
    p_idx = 0
    for o in mesh_objs():
        if o.name in ("wheel_FL", "wheel_FR", "wheel_RL", "wheel_RR", "badge_nose", "badge_rear", "wing") or o.name.startswith("wing_"):
            continue
        if HEADLIGHT_RE.search(o.name):
            new_n = f"light_front_{len(front_lights)}"
            o.name = new_n
            front_lights.append(new_n)
            continue
        if TAILLIGHT_RE.search(o.name):
            new_n = f"light_rear_{len(rear_lights)}"
            o.name = new_n
            rear_lights.append(new_n)
            continue
        # Sanitize any OEM-branded or non-ASCII / garbled names
        if OEM_NAME_RE.search(o.name) or any(ord(ch) > 126 or ord(ch) < 32 for ch in o.name):
            p_idx += 1
            o.name = f"body_part_{p_idx:03d}"
        if o.data:
            o.data.name = o.name

    m_idx = 0
    for m in bpy.data.materials:
        if m.name == "paint" or m.name.startswith("badge_"):
            continue
        if OEM_NAME_RE.search(m.name) or any(ord(ch) > 126 or ord(ch) < 32 for ch in m.name):
            m_idx += 1
            m.name = f"trim_mat_{m_idx:03d}"
    return front_lights, rear_lights


def normalize_exhaust_nozzles(raw_nozzles, mn_g, mx_g):
    """Keep rear-facing exhaust tips and enforce left/right symmetry when pipes are paired."""
    rear_z = mn_g.z
    near_rear = [n for n in raw_nozzles if n["z"] <= rear_z + 0.65 and 0.12 <= n["y"] <= 0.95]
    if not near_rear:
        return [
            {"x": -0.28, "y": round(0.28 + 0.14 * (mx_g.y - mn_g.y), 3), "z": round(rear_z + 0.06, 3), "r": 0.055},
            {"x": 0.28, "y": round(0.28 + 0.14 * (mx_g.y - mn_g.y), 3), "z": round(rear_z + 0.06, 3), "r": 0.055},
        ]
    # Sort rearmost first
    near_rear.sort(key=lambda n: n["z"])
    picked = []
    for n in near_rear:
        if any(abs(n["x"] - p["x"]) < 0.08 and abs(n["y"] - p["y"]) < 0.08 for p in picked):
            continue
        picked.append(n)
        if len(picked) >= 4:
            break
    # If all picked nozzles are on one side (asymmetric multi-pipe mesh naming), mirror the primary pair!
    xs = [p["x"] for p in picked]
    if all(x < -0.08 for x in xs) or all(x > 0.08 for x in xs):
        base = picked[:2]
        sym = []
        for p in base:
            sym.append(p)
            sym.append({"x": round(-p["x"], 3), "y": p["y"], "z": p["z"], "r": p["r"]})
        picked = sym[:4]
    return picked


def join_static_body_meshes():
    """Collapse hundreds/thousands of static sub-meshes into a single multi-material `body` mesh for WebGPU FPS."""
    keep_prefix = ("wheel_", "badge_", "wing", "light_front_", "light_rear_")
    static_objs = [o for o in mesh_objs() if not o.name.startswith(keep_prefix)]
    if len(static_objs) > 1:
        n_before = len(static_objs)
        merged = join_objects(static_objs, "body")
        if merged and merged.data:
            merged.data.name = "body"
        print(f"[opt] Collapsed {n_before} static sub-meshes into 1 draw-call-optimized 'body' mesh")


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(args.src)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=args.src)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=args.src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=args.src)
    else:
        raise ValueError(f"Unsupported format: {ext}")

    bake_all_transforms()
    strip_env_and_badges()
    auto_orient_and_scale(args.length_m, args.rot_z_deg, args.flip_180)
    strip_centerline_emblems()
    wheel_hubs = group_four_spinning_wheels()
    apply_subtle_gta6_restyle(args.restyle_scale)
    paint_mat = setup_paint_material(args.paint_match)
    decimate_body_to_budget(args.target_tris)
    downscale_packed_images(args.max_tex)
    separate_stock_spoilers()
    # Detect exhausts before sanitizing OEM mesh names
    raw_nozzles = detect_exhaust_nozzles_metadata()
    front_lights, rear_lights = sanitize_names_and_collect_lights()
    join_static_body_meshes()
    place_3d_brand_badges(args.brand)

    os.makedirs(args.out_dir, exist_ok=True)
    raw_glb = os.path.join(args.out_dir, f"{args.id}_raw.glb")
    bpy.ops.export_scene.gltf(
        filepath=raw_glb,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    print(f"[export] Wrote {raw_glb} ({os.path.getsize(raw_glb) / 1024:.1f} KB)")

    objs = mesh_objs()
    mn_b, mx_b = world_bbox(objs)
    mn_g = Vector((mn_b.x, mn_b.z, -mx_b.y))
    mx_g = Vector((mx_b.x, mx_b.z, -mn_b.y))
    total_tris = sum(sum(max(1, len(p.vertices) - 2) for p in o.data.polygons) for o in objs)
    nozzles = normalize_exhaust_nozzles(raw_nozzles, mn_g, mx_g)
    all_names = [o.name for o in bpy.context.scene.objects]

    meta = {
        "id": args.id,
        "brand": args.brand,
        "paint_material": paint_mat,
        "bounds_gltf": {
            "min": [round(mn_g.x, 3), round(mn_g.y, 3), round(mn_g.z, 3)],
            "max": [round(mx_g.x, 3), round(mx_g.y, 3), round(mx_g.z, 3)],
        },
        "wheel_hubs_gltf": wheel_hubs,
        "tris": total_tris,
        "has_stock_wing": any(o.name == "wing" or o.name.startswith("wing_") for o in bpy.context.scene.objects),
        "has_badges": bool(bpy.data.objects.get("badge_nose")),
        "exhaust_nozzles": nozzles,
        "front_lights": front_lights,
        "rear_lights": rear_lights,
        "node_names": all_names,
    }
    meta_path = os.path.join(args.out_dir, f"{args.id}_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[meta] Wrote {meta_path} (tris={total_tris}, wheels={len(wheel_hubs)}, nozzles={len(meta['exhaust_nozzles'])})")


if __name__ == "__main__":
    main()
