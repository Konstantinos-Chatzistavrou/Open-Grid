#!/usr/bin/env python3
"""
OpenGrid Multi-Archetype Parametric Car Sculptor (Blender 5.x).

Builds 10 radically distinct, 100% original, copyright-free automotive silhouettes
(Italian V12 GT, Mid-V8 Berlinetta, Razor Wedge V12, Compact Track V10, Rear-Engine Flat-6 GT,
British Teardrop Carbon Supercar, Scandinavian Longtail Megacar, Boxy JDM AWD Coupe,
Curvy 90s Rotary Coupe, Widebody Supercharged V8 Muscle) as raw GLBs ready for
`tools/pipeline/ingest_car.py` (which adds 3D OpenGrid crest badges, spoiler verification,
exhaust nozzle detection, meshopt compression, physics/visual JSONs, catalog & validation).

Usage (Blender):
  blender -b --factory-startup -P tools/pipeline/sculpt_fleet.py -- --out-dir /tmp/og_fleet
"""
import argparse
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "assets_source", "scripts"))
import make_car as mc  # noqa: E402

P = mc.pchip


def lerp(a, b, t):
    return a + (b - a) * t


def hex_rgb(hx):
    h = hx.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


def make_mat(name, rgb, metal=0.0, rough=0.4, coat=0.0, emit=None, emit_str=3.0, alpha=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if coat > 0:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.035
    if emit is not None:
        b.inputs["Emission Color"].default_value = (*emit, 1.0)
        b.inputs["Emission Strength"].default_value = emit_str
    if alpha is not None:
        b.inputs["Alpha"].default_value = alpha
        m.surface_render_method = "BLENDED"
    return m


def apply_mods(ob):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def bm_obj(bm, name, mat, parent=None, location=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = location
    if mat is not None:
        ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    if parent is not None:
        ob.parent = parent
    return ob


def add_box(name, mat, center, size, rot_deg=(0, 0, 0), parent=None, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]
        v.co.y *= size[1]
        v.co.z *= size[2]
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=2, affect="EDGES")
    ob = bm_obj(bm, name, mat, parent=parent, location=center)
    ob.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    return ob


def add_cyl(name, mat, center, radius, depth, rot_deg=(0, 0, 0), verts=24, parent=None):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=verts, radius=radius, depth=depth, location=center,
        rotation=tuple(math.radians(a) for a in rot_deg),
    )
    ob = bpy.context.active_object
    ob.name = name
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    if parent is not None:
        ob.parent = parent
    return ob


class Surface:
    def __init__(self, objs):
        bm = bmesh.new()
        for o in objs:
            tmp = o.data.copy()
            tmp.transform(o.matrix_world)
            bm.from_mesh(tmp)
            bpy.data.meshes.remove(tmp)
        self.tree = BVHTree.FromBMesh(bm)
        bm.free()

    def hit(self, origin, direction):
        loc, nor, _, _ = self.tree.ray_cast(Vector(origin), Vector(direction).normalized(), 10.0)
        return loc, nor


def projected_patch(surf, name, material, outline_fn, nu, nv, direction, offset, root, bulge=0.0):
    bm = bmesh.new()
    grid = []
    d = Vector(direction).normalized()
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            p = Vector(outline_fn(u, v))
            loc, nor = surf.hit(p - d * 1.5, d)
            if loc is None:
                row.append(None)
                continue
            lift = offset + bulge * math.sin(math.pi * u) * math.sin(math.pi * v)
            row.append(bm.verts.new(loc + nor * lift))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            q = (grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i])
            if None not in q:
                bm.faces.new(q)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    for f in bm.faces:
        f.normal_update()
        if f.normal.dot(-d) < 0:
            f.normal_flip()
    if len(bm.faces) == 0:
        bm.free()
        return None
    return bm_obj(bm, name, material, parent=root)


# 10 radically distinct automotive design specs
FLEET = [
    {
        "id": "valenza_corsa",
        "name": "Valenza Corsa V12",
        "brand": "valenza",
        "paint": "#c81018",
        "accent": "#15171c",
        "rim_rgb": (0.72, 0.74, 0.78),
        "caliper_rgb": (0.88, 0.68, 0.04),
        "half_len": 2.32,
        "y_fa": -1.36, "y_ra": 1.36,
        "wr_f": 0.340, "wr_r": 0.354,
        "track_f": 0.855, "track_r": 0.880,
        "top_pts": [(-2.32, 0.44), (-2.12, 0.58), (-1.70, 0.72), (-1.20, 0.81), (-0.55, 0.86), (0.35, 0.87), (1.36, 0.90), (2.05, 0.91), (2.26, 0.86), (2.32, 0.76)],
        "sh_pts":  [(-2.32, 0.44), (-2.08, 0.59), (-1.36, 0.78), (-0.50, 0.82), (0.55, 0.85), (1.36, 0.91), (2.10, 0.90), (2.32, 0.76)],
        "zb_pts":  [(-2.32, 0.14), (-2.00, 0.12), (1.70, 0.13), (2.15, 0.20), (2.32, 0.28)],
        "wb_pts":  [(-2.32, 0.58), (-2.10, 0.83), (-1.36, 0.96), (-0.30, 0.91), (0.75, 0.96), (1.36, 1.01), (2.08, 0.90), (2.32, 0.74)],
        "sh_in":   [(-2.32, 0.08), (-1.36, 0.03), (0.0, 0.09), (1.36, 0.03), (2.32, 0.09)],
        "cab_y":   [-0.62, -0.20, 0.28, 0.74, 1.18, 1.62, 2.04],
        "cab_z":   [None, 1.04, 1.24, 1.26, 1.20, 1.04, None],
        "cab_w":   [None, 0.60, 0.58, 0.56, 0.52, 0.46, None],
        "crease":  0.65,
        "head_style": "slim",
        "tail_style": "quad_round",
        "exhaust": "quad_outer",
        "wing": "none",
        "spokes": "star5",
        "hood_vent": True,
        "side_scoop": False,
        "roof_scoop": False,
    },
    {
        "id": "valenza_fiamma",
        "name": "Valenza Fiamma V8",
        "brand": "valenza",
        "paint": "#e6b800",
        "accent": "#111216",
        "rim_rgb": (0.20, 0.21, 0.24),
        "caliper_rgb": (0.82, 0.04, 0.04),
        "half_len": 2.25,
        "y_fa": -1.32, "y_ra": 1.33,
        "wr_f": 0.336, "wr_r": 0.350,
        "track_f": 0.850, "track_r": 0.880,
        "top_pts": [(-2.25, 0.40), (-2.05, 0.53), (-1.65, 0.64), (-1.32, 0.71), (-0.75, 0.76), (0.20, 0.82), (1.33, 0.88), (2.05, 0.88), (2.25, 0.76)],
        "sh_pts":  [(-2.25, 0.40), (-1.95, 0.58), (-1.32, 0.75), (-0.30, 0.75), (0.65, 0.82), (1.33, 0.90), (2.08, 0.89), (2.25, 0.76)],
        "zb_pts":  [(-2.25, 0.13), (-1.90, 0.115), (1.70, 0.125), (2.10, 0.21), (2.25, 0.29)],
        "wb_pts":  [(-2.25, 0.54), (-2.02, 0.82), (-1.32, 0.97), (-0.25, 0.90), (0.65, 0.96), (1.33, 1.02), (2.05, 0.90), (2.25, 0.76)],
        "sh_in":   [(-2.25, 0.08), (-1.32, 0.025), (-0.15, 0.11), (1.33, 0.025), (2.25, 0.08)],
        "cab_y":   [-1.15, -0.68, -0.18, 0.26, 0.70, 1.22, 1.82],
        "cab_z":   [None, 0.95, 1.18, 1.20, 1.14, 0.99, None],
        "cab_w":   [None, 0.57, 0.56, 0.55, 0.52, 0.46, None],
        "crease":  0.72,
        "head_style": "swept",
        "tail_style": "quad_round",
        "exhaust": "dual_mid",
        "wing": "none",
        "spokes": "twin5",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": False,
    },
    {
        "id": "kronos_taurus",
        "name": "Kronos Taurus V12",
        "brand": "kronos",
        "paint": "#ff6a00",
        "accent": "#0e1014",
        "rim_rgb": (0.12, 0.13, 0.15),
        "caliper_rgb": (0.98, 0.42, 0.02),
        "half_len": 2.38,
        "y_fa": -1.35, "y_ra": 1.35,
        "wr_f": 0.340, "wr_r": 0.360,
        "track_f": 0.890, "track_r": 0.925,
        "top_pts": [(-2.38, 0.34), (-2.12, 0.48), (-1.70, 0.60), (-1.35, 0.68), (-0.70, 0.74), (0.35, 0.82), (1.35, 0.87), (2.15, 0.86), (2.38, 0.72)],
        "sh_pts":  [(-2.38, 0.34), (-2.00, 0.52), (-1.35, 0.72), (-0.25, 0.74), (0.65, 0.84), (1.35, 0.89), (2.18, 0.87), (2.38, 0.72)],
        "zb_pts":  [(-2.38, 0.115), (-2.00, 0.105), (1.75, 0.115), (2.20, 0.20), (2.38, 0.28)],
        "wb_pts":  [(-2.38, 0.52), (-2.15, 0.86), (-1.35, 1.02), (-0.20, 0.96), (0.70, 1.03), (1.35, 1.06), (2.15, 0.96), (2.38, 0.80)],
        "sh_in":   [(-2.38, 0.05), (-1.35, 0.02), (0.0, 0.06), (1.35, 0.02), (2.38, 0.06)],
        "cab_y":   [-1.28, -0.76, -0.22, 0.24, 0.72, 1.30, 1.92],
        "cab_z":   [None, 0.91, 1.13, 1.14, 1.09, 0.95, None],
        "cab_w":   [None, 0.56, 0.55, 0.54, 0.50, 0.44, None],
        "crease":  0.96,
        "head_style": "y_blade",
        "tail_style": "y_blade",
        "exhaust": "center_hex",
        "wing": "wedge_low",
        "spokes": "y6",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": False,
    },
    {
        "id": "kronos_fulmine",
        "name": "Kronos Fulmine V10",
        "brand": "kronos",
        "paint": "#76ff03",
        "accent": "#101216",
        "rim_rgb": (0.14, 0.15, 0.17),
        "caliper_rgb": (0.45, 0.95, 0.05),
        "half_len": 2.22,
        "y_fa": -1.30, "y_ra": 1.30,
        "wr_f": 0.334, "wr_r": 0.348,
        "track_f": 0.860, "track_r": 0.885,
        "top_pts": [(-2.22, 0.36), (-1.98, 0.50), (-1.30, 0.69), (-0.65, 0.75), (0.35, 0.82), (1.30, 0.87), (2.02, 0.86), (2.22, 0.74)],
        "sh_pts":  [(-2.22, 0.36), (-1.90, 0.54), (-1.30, 0.73), (-0.25, 0.74), (0.65, 0.82), (1.30, 0.88), (2.05, 0.87), (2.22, 0.74)],
        "zb_pts":  [(-2.22, 0.12), (-1.90, 0.11), (1.65, 0.12), (2.06, 0.20), (2.22, 0.28)],
        "wb_pts":  [(-2.22, 0.54), (-1.98, 0.84), (-1.30, 0.98), (-0.20, 0.92), (0.68, 0.98), (1.30, 1.01), (2.02, 0.92), (2.22, 0.78)],
        "sh_in":   [(-2.22, 0.05), (-1.30, 0.02), (0.0, 0.07), (1.30, 0.02), (2.22, 0.06)],
        "cab_y":   [-1.20, -0.70, -0.20, 0.24, 0.68, 1.20, 1.78],
        "cab_z":   [None, 0.92, 1.15, 1.16, 1.10, 0.96, None],
        "cab_w":   [None, 0.55, 0.54, 0.53, 0.49, 0.44, None],
        "crease":  0.94,
        "head_style": "y_blade",
        "tail_style": "bar_thin",
        "exhaust": "dual_high",
        "wing": "gt_track",
        "spokes": "mesh10",
        "hood_vent": False,
        "side_scoop": True,
        "roof_scoop": False,
    },
    {
        "id": "falcorn_9r",
        "name": "Falcorn 9R GT",
        "brand": "falcorn",
        "paint": "#d9dee6",
        "accent": "#111318",
        "rim_rgb": (0.16, 0.17, 0.19),
        "caliper_rgb": (0.95, 0.78, 0.04),
        "half_len": 2.26,
        "y_fa": -1.24, "y_ra": 1.22,
        "wr_f": 0.340, "wr_r": 0.354,
        "track_f": 0.835, "track_r": 0.885,
        "top_pts": [(-2.26, 0.42), (-2.05, 0.54), (-1.62, 0.64), (-1.24, 0.72), (-0.72, 0.79), (0.30, 0.84), (1.22, 0.89), (1.92, 0.85), (2.20, 0.78), (2.26, 0.68)],
        "sh_pts":  [(-2.26, 0.42), (-1.92, 0.62), (-1.24, 0.78), (-0.30, 0.78), (0.60, 0.84), (1.22, 0.91), (1.96, 0.86), (2.26, 0.68)],
        "zb_pts":  [(-2.26, 0.135), (-1.90, 0.12), (1.65, 0.13), (2.08, 0.21), (2.26, 0.29)],
        "wb_pts":  [(-2.26, 0.58), (-2.02, 0.82), (-1.24, 0.93), (-0.20, 0.88), (0.65, 0.96), (1.22, 1.02), (1.96, 0.92), (2.26, 0.74)],
        "sh_in":   [(-2.26, 0.09), (-1.24, 0.03), (0.0, 0.10), (1.22, 0.025), (2.26, 0.09)],
        "cab_y":   [-0.95, -0.52, -0.05, 0.42, 0.92, 1.48, 1.98],
        "cab_z":   [None, 1.03, 1.26, 1.27, 1.18, 0.98, None],
        "cab_w":   [None, 0.58, 0.57, 0.55, 0.50, 0.42, None],
        "crease":  0.38,
        "head_style": "oval",
        "tail_style": "lightbar",
        "exhaust": "center_dual",
        "wing": "swan_gt",
        "spokes": "mesh10",
        "hood_vent": True,
        "side_scoop": False,
        "roof_scoop": False,
    },
    {
        "id": "aether_solis",
        "name": "Aether Solis 765",
        "brand": "aether",
        "paint": "#ff4500",
        "accent": "#0e1014",
        "rim_rgb": (0.14, 0.15, 0.17),
        "caliper_rgb": (0.98, 0.30, 0.02),
        "half_len": 2.28,
        "y_fa": -1.34, "y_ra": 1.34,
        "wr_f": 0.336, "wr_r": 0.352,
        "track_f": 0.865, "track_r": 0.895,
        "top_pts": [(-2.28, 0.38), (-2.04, 0.50), (-1.60, 0.62), (-1.34, 0.70), (-0.72, 0.75), (0.30, 0.80), (1.34, 0.86), (2.06, 0.85), (2.28, 0.74)],
        "sh_pts":  [(-2.28, 0.38), (-1.94, 0.56), (-1.34, 0.75), (-0.25, 0.73), (0.65, 0.82), (1.34, 0.89), (2.08, 0.86), (2.28, 0.74)],
        "zb_pts":  [(-2.28, 0.12), (-1.95, 0.105), (1.72, 0.12), (2.12, 0.22), (2.28, 0.31)],
        "wb_pts":  [(-2.28, 0.52), (-2.02, 0.82), (-1.34, 0.99), (-0.20, 0.86), (0.65, 0.96), (1.34, 1.02), (2.06, 0.89), (2.28, 0.74)],
        "sh_in":   [(-2.28, 0.07), (-1.34, 0.02), (-0.15, 0.14), (1.34, 0.02), (2.28, 0.08)],
        "cab_y":   [-1.18, -0.70, -0.20, 0.24, 0.68, 1.24, 1.80],
        "cab_z":   [None, 0.94, 1.18, 1.19, 1.13, 0.96, None],
        "cab_w":   [None, 0.54, 0.53, 0.52, 0.48, 0.40, None],
        "crease":  0.52,
        "head_style": "boomerang",
        "tail_style": "bar_thin",
        "exhaust": "top_quad",
        "wing": "active_aero",
        "spokes": "ultra7",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": True,
    },
    {
        "id": "aether_borealis",
        "name": "Aether Borealis R",
        "brand": "aether",
        "paint": "#0ea5e9",
        "accent": "#0b0d12",
        "rim_rgb": (0.09, 0.10, 0.12),
        "caliper_rgb": (0.05, 0.72, 0.98),
        "half_len": 2.36,
        "y_fa": -1.35, "y_ra": 1.35,
        "wr_f": 0.342, "wr_r": 0.362,
        "track_f": 0.885, "track_r": 0.915,
        "top_pts": [(-2.36, 0.35), (-2.10, 0.49), (-1.65, 0.62), (-1.35, 0.70), (-0.65, 0.75), (0.35, 0.82), (1.35, 0.86), (2.14, 0.83), (2.36, 0.70)],
        "sh_pts":  [(-2.36, 0.35), (-1.98, 0.55), (-1.35, 0.74), (-0.20, 0.75), (0.68, 0.83), (1.35, 0.88), (2.16, 0.84), (2.36, 0.70)],
        "zb_pts":  [(-2.36, 0.11), (-2.00, 0.10), (1.76, 0.115), (2.18, 0.22), (2.36, 0.32)],
        "wb_pts":  [(-2.36, 0.50), (-2.10, 0.84), (-1.35, 1.02), (-0.18, 0.92), (0.72, 1.01), (1.35, 1.05), (2.12, 0.92), (2.36, 0.72)],
        "sh_in":   [(-2.36, 0.06), (-1.35, 0.02), (0.0, 0.10), (1.35, 0.02), (2.36, 0.08)],
        "cab_y":   [-1.24, -0.74, -0.22, 0.22, 0.68, 1.32, 1.98],
        "cab_z":   [None, 0.96, 1.19, 1.20, 1.13, 0.95, None],
        "cab_w":   [None, 0.52, 0.52, 0.51, 0.46, 0.38, None],
        "crease":  0.62,
        "head_style": "slim",
        "tail_style": "y_blade",
        "exhaust": "center_oval",
        "wing": "hyper_swan",
        "spokes": "blade5",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": True,
    },
    {
        "id": "kaze_ryujin",
        "name": "Kaze Ryujin Z-Spec",
        "brand": "kaze",
        "paint": "#1d4ed8",
        "accent": "#12141a",
        "rim_rgb": (0.62, 0.46, 0.18),  # iconic JDM bronze
        "caliper_rgb": (0.85, 0.64, 0.08),
        "half_len": 2.30,
        "y_fa": -1.34, "y_ra": 1.32,
        "wr_f": 0.332, "wr_r": 0.336,
        "track_f": 0.835, "track_r": 0.845,
        "top_pts": [(-2.30, 0.54), (-2.12, 0.66), (-1.75, 0.75), (-1.34, 0.80), (-0.75, 0.84), (0.35, 0.86), (1.32, 0.88), (2.06, 0.89), (2.26, 0.86), (2.30, 0.74)],
        "sh_pts":  [(-2.30, 0.52), (-2.05, 0.66), (-1.34, 0.79), (-0.30, 0.82), (0.65, 0.85), (1.32, 0.88), (2.10, 0.88), (2.30, 0.74)],
        "zb_pts":  [(-2.30, 0.14), (-2.00, 0.13), (1.70, 0.14), (2.14, 0.19), (2.30, 0.25)],
        "wb_pts":  [(-2.30, 0.70), (-2.10, 0.88), (-1.34, 0.94), (-0.25, 0.91), (0.65, 0.93), (1.32, 0.96), (2.08, 0.90), (2.30, 0.82)],
        "sh_in":   [(-2.30, 0.04), (-1.34, 0.025), (0.0, 0.045), (1.32, 0.025), (2.30, 0.045)],
        "cab_y":   [-0.86, -0.45, 0.02, 0.52, 1.00, 1.48, 1.86],
        "cab_z":   [None, 1.12, 1.32, 1.33, 1.29, 1.08, None],
        "cab_w":   [None, 0.64, 0.63, 0.62, 0.60, 0.56, None],
        "crease":  0.88,
        "head_style": "rect_jdm",
        "tail_style": "quad_round",
        "exhaust": "single_cannon",
        "wing": "jdm_high",
        "spokes": "te6",
        "hood_vent": True,
        "side_scoop": False,
        "roof_scoop": False,
    },
    {
        "id": "kaze_kurogane",
        "name": "Kaze Kurogane 7R",
        "brand": "kaze",
        "paint": "#facc15",
        "accent": "#111216",
        "rim_rgb": (0.76, 0.78, 0.82),
        "caliper_rgb": (0.82, 0.06, 0.06),
        "half_len": 2.15,
        "y_fa": -1.21, "y_ra": 1.22,
        "wr_f": 0.324, "wr_r": 0.330,
        "track_f": 0.815, "track_r": 0.830,
        "top_pts": [(-2.15, 0.42), (-1.94, 0.56), (-1.55, 0.66), (-1.21, 0.72), (-0.65, 0.77), (0.30, 0.81), (1.22, 0.84), (1.92, 0.83), (2.15, 0.72)],
        "sh_pts":  [(-2.15, 0.42), (-1.88, 0.59), (-1.21, 0.75), (-0.25, 0.75), (0.60, 0.81), (1.22, 0.86), (1.96, 0.84), (2.15, 0.72)],
        "zb_pts":  [(-2.15, 0.135), (-1.85, 0.125), (1.60, 0.135), (1.98, 0.20), (2.15, 0.27)],
        "wb_pts":  [(-2.15, 0.58), (-1.92, 0.82), (-1.21, 0.91), (-0.20, 0.85), (0.62, 0.90), (1.22, 0.94), (1.94, 0.86), (2.15, 0.72)],
        "sh_in":   [(-2.15, 0.08), (-1.21, 0.03), (0.0, 0.09), (1.22, 0.03), (2.15, 0.08)],
        "cab_y":   [-0.78, -0.35, 0.12, 0.58, 1.04, 1.52, 1.92],
        "cab_z":   [None, 1.02, 1.21, 1.22, 1.15, 0.97, None],
        "cab_w":   [None, 0.58, 0.56, 0.54, 0.49, 0.42, None],
        "crease":  0.34,
        "head_style": "swept",
        "tail_style": "lightbar",
        "exhaust": "dual_mid",
        "wing": "hoop_street",
        "spokes": "star5",
        "hood_vent": False,
        "side_scoop": False,
        "roof_scoop": False,
    },
    {
        "id": "falcorn_hellhound",
        "name": "Falcorn Hellhound SC",
        "brand": "falcorn",
        "paint": "#7c3aed",
        "accent": "#0e1014",
        "rim_rgb": (0.14, 0.15, 0.17),
        "caliper_rgb": (0.90, 0.06, 0.06),
        "half_len": 2.44,
        "y_fa": -1.46, "y_ra": 1.48,
        "wr_f": 0.358, "wr_r": 0.366,
        "track_f": 0.880, "track_r": 0.900,
        "top_pts": [(-2.44, 0.62), (-2.26, 0.76), (-1.85, 0.84), (-1.46, 0.88), (-0.75, 0.91), (0.35, 0.92), (1.48, 0.94), (2.18, 0.94), (2.40, 0.90), (2.44, 0.78)],
        "sh_pts":  [(-2.44, 0.60), (-2.20, 0.76), (-1.46, 0.86), (-0.30, 0.88), (0.70, 0.92), (1.48, 0.95), (2.22, 0.93), (2.44, 0.78)],
        "zb_pts":  [(-2.44, 0.155), (-2.12, 0.145), (1.82, 0.155), (2.26, 0.21), (2.44, 0.27)],
        "wb_pts":  [(-2.44, 0.78), (-2.24, 0.95), (-1.46, 1.02), (-0.25, 0.97), (0.72, 1.01), (1.48, 1.05), (2.22, 0.97), (2.44, 0.88)],
        "sh_in":   [(-2.44, 0.03), (-1.46, 0.025), (0.0, 0.04), (1.48, 0.025), (2.44, 0.035)],
        "cab_y":   [-0.74, -0.32, 0.18, 0.68, 1.18, 1.66, 2.04],
        "cab_z":   [None, 1.18, 1.38, 1.39, 1.34, 1.12, None],
        "cab_w":   [None, 0.68, 0.67, 0.66, 0.63, 0.58, None],
        "crease":  0.84,
        "head_style": "quad_halo",
        "tail_style": "racetrack",
        "exhaust": "quad_outer",
        "wing": "lip_muscle",
        "spokes": "twin5",
        "hood_vent": True,
        "side_scoop": False,
        "roof_scoop": False,
    },
    # ---- 6 Modular Street, Group-B & Track Edition Cars ----
    {
        "id": "kaze_kurogane_re",
        "name": "Kaze Kurogane RE-Spec",
        "brand": "kaze",
        "paint": "#0f2419",
        "accent": "#0b0d10",
        "rim_rgb": (0.86, 0.88, 0.92),
        "caliper_rgb": (0.88, 0.70, 0.08),
        "half_len": 2.18,
        "y_fa": -1.22, "y_ra": 1.22,
        "wr_f": 0.326, "wr_r": 0.332,
        "track_f": 0.855, "track_r": 0.875,
        "top_pts": [(-2.18, 0.38), (-1.96, 0.54), (-1.56, 0.65), (-1.22, 0.71), (-0.65, 0.76), (0.30, 0.80), (1.22, 0.84), (1.94, 0.83), (2.18, 0.71)],
        "sh_pts":  [(-2.18, 0.38), (-1.90, 0.58), (-1.22, 0.75), (-0.25, 0.74), (0.60, 0.81), (1.22, 0.86), (1.98, 0.84), (2.18, 0.71)],
        "zb_pts":  [(-2.18, 0.105), (-1.85, 0.100), (1.60, 0.110), (2.00, 0.18), (2.18, 0.25)],
        "wb_pts":  [(-2.18, 0.64), (-1.94, 0.88), (-1.22, 0.97), (-0.20, 0.88), (0.62, 0.95), (1.22, 0.99), (1.96, 0.90), (2.18, 0.76)],
        "sh_in":   [(-2.18, 0.07), (-1.22, 0.025), (0.0, 0.085), (1.22, 0.025), (2.18, 0.07)],
        "cab_y":   [-0.78, -0.35, 0.12, 0.58, 1.04, 1.52, 1.92],
        "cab_z":   [None, 1.01, 1.20, 1.21, 1.14, 0.96, None],
        "cab_w":   [None, 0.58, 0.56, 0.54, 0.49, 0.42, None],
        "crease":  0.38,
        "head_style": "sleek_pod",
        "tail_style": "lightbar",
        "exhaust": "single_cannon",
        "wing": "re_timeattack",
        "spokes": "dish5",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": False,
        "canards": True,
        "splitter_struts": False,
    },
    {
        "id": "valenza_evo37",
        "name": "Valenza 037 Evo",
        "brand": "valenza",
        "paint": "#c8d0d8",
        "accent": "#101216",
        "rim_rgb": (0.78, 0.80, 0.84),
        "caliper_rgb": (0.85, 0.08, 0.08),
        "half_len": 2.19,
        "y_fa": -1.26, "y_ra": 1.24,
        "wr_f": 0.334, "wr_r": 0.348,
        "track_f": 0.865, "track_r": 0.895,
        "top_pts": [(-2.19, 0.42), (-1.98, 0.56), (-1.58, 0.66), (-1.26, 0.72), (-0.70, 0.76), (0.25, 0.80), (1.24, 0.84), (1.96, 0.84), (2.19, 0.74)],
        "sh_pts":  [(-2.19, 0.42), (-1.92, 0.58), (-1.26, 0.75), (-0.25, 0.75), (0.60, 0.82), (1.24, 0.87), (2.00, 0.85), (2.19, 0.74)],
        "zb_pts":  [(-2.19, 0.115), (-1.88, 0.110), (1.65, 0.120), (2.04, 0.20), (2.19, 0.27)],
        "wb_pts":  [(-2.19, 0.64), (-1.96, 0.89), (-1.26, 0.98), (-0.20, 0.90), (0.62, 0.98), (1.24, 1.02), (1.98, 0.95), (2.19, 0.84)],
        "sh_in":   [(-2.19, 0.05), (-1.26, 0.02), (0.0, 0.07), (1.24, 0.02), (2.19, 0.05)],
        "cab_y":   [-0.96, -0.52, -0.06, 0.36, 0.76, 1.22, 1.72],
        "cab_z":   [None, 0.98, 1.19, 1.20, 1.12, 0.94, None],
        "cab_w":   [None, 0.57, 0.56, 0.54, 0.50, 0.45, None],
        "crease":  0.82,
        "head_style": "quad_halo",
        "tail_style": "quad_round",
        "exhaust": "center_dual",
        "wing": "bridge_037",
        "spokes": "tarmac10",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": False,
        "fender_louvres": True,
        "evo_hood_bays": True,
    },
    {
        "id": "kaze_senkou_tr",
        "name": "Kaze Senkou Tribute",
        "brand": "kaze",
        "paint": "#f2f4f7",
        "accent": "#0c0e12",
        "rim_rgb": (0.22, 0.24, 0.28),
        "caliper_rgb": (0.88, 0.06, 0.06),
        "half_len": 2.27,
        "y_fa": -1.32, "y_ra": 1.32,
        "wr_f": 0.336, "wr_r": 0.350,
        "track_f": 0.855, "track_r": 0.885,
        "top_pts": [(-2.27, 0.38), (-2.04, 0.52), (-1.62, 0.64), (-1.32, 0.71), (-0.70, 0.76), (0.30, 0.82), (1.32, 0.87), (2.06, 0.86), (2.27, 0.75)],
        "sh_pts":  [(-2.27, 0.38), (-1.94, 0.56), (-1.32, 0.74), (-0.25, 0.75), (0.65, 0.83), (1.32, 0.89), (2.08, 0.87), (2.27, 0.75)],
        "zb_pts":  [(-2.27, 0.12), (-1.92, 0.11), (1.70, 0.12), (2.10, 0.21), (2.27, 0.29)],
        "wb_pts":  [(-2.27, 0.56), (-2.02, 0.84), (-1.32, 0.97), (-0.22, 0.90), (0.66, 0.97), (1.32, 1.01), (2.06, 0.91), (2.27, 0.78)],
        "sh_in":   [(-2.27, 0.06), (-1.32, 0.02), (-0.10, 0.09), (1.32, 0.02), (2.27, 0.07)],
        "cab_y":   [-1.18, -0.68, -0.18, 0.28, 0.74, 1.28, 1.86],
        "cab_z":   [None, 0.94, 1.17, 1.18, 1.12, 0.96, None],
        "cab_w":   [None, 0.56, 0.55, 0.54, 0.50, 0.44, None],
        "crease":  0.76,
        "head_style": "boomerang",
        "tail_style": "bar_thin",
        "exhaust": "center_hex",
        "wing": "hoop_nsx",
        "spokes": "twin5",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": True,
        "black_roof": True,
        "front_fangs": True,
    },
    {
        "id": "valenza_sp3",
        "name": "Valenza Icona SP3",
        "brand": "valenza",
        "paint": "#e60012",
        "accent": "#0e1014",
        "rim_rgb": (0.74, 0.77, 0.82),
        "caliper_rgb": (0.95, 0.80, 0.04),
        "half_len": 2.34,
        "y_fa": -1.34, "y_ra": 1.34,
        "wr_f": 0.340, "wr_r": 0.358,
        "track_f": 0.875, "track_r": 0.905,
        "top_pts": [(-2.34, 0.35), (-2.08, 0.50), (-1.64, 0.63), (-1.34, 0.71), (-0.70, 0.75), (0.30, 0.81), (1.34, 0.88), (2.10, 0.87), (2.34, 0.75)],
        "sh_pts":  [(-2.34, 0.35), (-1.96, 0.57), (-1.34, 0.77), (-0.25, 0.73), (0.68, 0.84), (1.34, 0.91), (2.12, 0.88), (2.34, 0.75)],
        "zb_pts":  [(-2.34, 0.115), (-1.98, 0.105), (1.74, 0.115), (2.16, 0.21), (2.34, 0.30)],
        "wb_pts":  [(-2.34, 0.54), (-2.08, 0.86), (-1.34, 1.02), (-0.20, 0.88), (0.70, 1.00), (1.34, 1.05), (2.10, 0.93), (2.34, 0.78)],
        "sh_in":   [(-2.34, 0.06), (-1.34, 0.02), (-0.15, 0.13), (1.34, 0.02), (2.34, 0.07)],
        "cab_y":   [-1.22, -0.72, -0.20, 0.24, 0.70, 1.26, 1.84],
        "cab_z":   [None, 0.93, 1.15, 1.16, 1.10, 0.95, None],
        "cab_w":   [None, 0.54, 0.53, 0.52, 0.48, 0.41, None],
        "crease":  0.58,
        "head_style": "slim",
        "tail_style": "bar_thin",
        "exhaust": "dual_high",
        "wing": "none",
        "spokes": "blade5",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": False,
        "black_roof": True,
        "front_strakes": True,
        "rear_strakes": True,
    },
    {
        "id": "falcorn_9r_rs",
        "name": "Falcorn 9R RS Weissach",
        "brand": "falcorn",
        "paint": "#bfc8d2",
        "accent": "#0c0e12",
        "rim_rgb": (0.18, 0.20, 0.23),
        "caliper_rgb": (0.95, 0.78, 0.04),
        "half_len": 2.29,
        "y_fa": -1.25, "y_ra": 1.23,
        "wr_f": 0.342, "wr_r": 0.358,
        "track_f": 0.865, "track_r": 0.915,
        "top_pts": [(-2.29, 0.40), (-2.06, 0.53), (-1.63, 0.64), (-1.25, 0.72), (-0.72, 0.79), (0.30, 0.84), (1.23, 0.89), (1.94, 0.86), (2.22, 0.79), (2.29, 0.69)],
        "sh_pts":  [(-2.29, 0.40), (-1.94, 0.62), (-1.25, 0.79), (-0.30, 0.78), (0.60, 0.85), (1.23, 0.92), (1.98, 0.87), (2.29, 0.69)],
        "zb_pts":  [(-2.29, 0.115), (-1.92, 0.105), (1.66, 0.115), (2.10, 0.20), (2.29, 0.28)],
        "wb_pts":  [(-2.29, 0.62), (-2.04, 0.88), (-1.25, 0.99), (-0.20, 0.91), (0.65, 1.00), (1.23, 1.06), (1.98, 0.96), (2.29, 0.78)],
        "sh_in":   [(-2.29, 0.08), (-1.25, 0.025), (0.0, 0.095), (1.23, 0.02), (2.29, 0.08)],
        "cab_y":   [-0.95, -0.52, -0.05, 0.42, 0.92, 1.48, 1.98],
        "cab_z":   [None, 1.03, 1.26, 1.27, 1.18, 0.98, None],
        "cab_w":   [None, 0.58, 0.57, 0.55, 0.50, 0.42, None],
        "crease":  0.42,
        "head_style": "oval",
        "tail_style": "lightbar",
        "exhaust": "center_dual",
        "wing": "swan_rs",
        "spokes": "mesh10",
        "hood_vent": True,
        "side_scoop": True,
        "roof_scoop": False,
        "carbon_hood_inlay": True,
        "fender_louvres": True,
        "canards": True,
        "splitter_struts": True,
    },
    {
        "id": "valenza_integrale",
        "name": "Valenza Integrale Evo",
        "brand": "valenza",
        "paint": "#7fa8c4",
        "accent": "#0e1116",
        "rim_rgb": (0.94, 0.96, 0.98),
        "caliper_rgb": (0.86, 0.08, 0.08),
        "half_len": 1.98,
        "y_fa": -1.24, "y_ra": 1.22,
        "wr_f": 0.324, "wr_r": 0.324,
        "track_f": 0.840, "track_r": 0.845,
        "top_pts": [(-1.98, 0.56), (-1.84, 0.69), (-1.50, 0.77), (-1.24, 0.81), (-0.75, 0.85), (0.35, 0.87), (1.22, 0.89), (1.78, 0.89), (1.98, 0.78)],
        "sh_pts":  [(-1.98, 0.54), (-1.78, 0.68), (-1.24, 0.80), (-0.30, 0.83), (0.65, 0.86), (1.22, 0.89), (1.82, 0.88), (1.98, 0.78)],
        "zb_pts":  [(-1.98, 0.125), (-1.72, 0.120), (1.52, 0.125), (1.84, 0.18), (1.98, 0.24)],
        "wb_pts":  [(-1.98, 0.72), (-1.80, 0.90), (-1.24, 0.96), (-0.25, 0.87), (0.65, 0.90), (1.22, 0.96), (1.80, 0.91), (1.98, 0.82)],
        "sh_in":   [(-1.98, 0.03), (-1.24, 0.02), (0.0, 0.04), (1.22, 0.02), (1.98, 0.035)],
        "cab_y":   [-0.78, -0.38, 0.10, 0.64, 1.18, 1.54, 1.84],
        "cab_z":   [None, 1.15, 1.38, 1.39, 1.38, 1.35, None],
        "cab_w":   [None, 0.63, 0.62, 0.62, 0.61, 0.58, None],
        "crease":  0.94,
        "head_style": "quad_halo",
        "tail_style": "racetrack",
        "exhaust": "single_cannon",
        "wing": "rally_roof",
        "spokes": "turbofan",
        "hood_vent": True,
        "side_scoop": False,
        "roof_scoop": False,
        "canards": True,
        "evo_hood_bays": True,
    },
]


def build_wheel(name, side, loc, radius, width, spoke_style, mats, root):
    w_root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(w_root)
    w_root.location = loc
    w_root.parent = root

    rim_r = radius * 0.715
    half_w = width * 0.5

    # Tyre torus
    bm_t = bmesh.new()
    prof = [
        (-half_w * 0.84, rim_r), (-half_w * 0.98, rim_r + (radius - rim_r) * 0.42),
        (-half_w * 0.94, radius - 0.012), (-half_w * 0.72, radius),
        (0.0, radius + 0.004), (half_w * 0.72, radius),
        (half_w * 0.94, radius - 0.012), (half_w * 0.98, rim_r + (radius - rim_r) * 0.42),
        (half_w * 0.84, rim_r),
    ]
    n_ring = 36
    rings = []
    for i in range(n_ring):
        a = 2 * math.pi * i / n_ring
        ca, sa = math.cos(a), math.sin(a)
        rings.append([bm_t.verts.new((px, r * ca, r * sa)) for px, r in prof])
    m = len(prof)
    for i in range(n_ring):
        ni = (i + 1) % n_ring
        for j in range(m):
            nj = (j + 1) % m
            bm_t.faces.new((rings[i][j], rings[ni][j], rings[ni][nj], rings[i][nj]))
    bmesh.ops.recalc_face_normals(bm_t, faces=bm_t.faces)
    bm_obj(bm_t, f"{name}_tyre", mats["tyre"], parent=w_root)

    # Rim barrel + bespoke spoke pattern
    bm_r = bmesh.new()
    n_b = 32
    b_prof = [
        (half_w * 0.90 * side, rim_r + 0.008), (half_w * 0.90 * side, rim_r - 0.014),
        (-half_w * 0.82 * side, rim_r - 0.016), (-half_w * 0.82 * side, rim_r + 0.004),
    ]
    brings = []
    for i in range(n_b):
        a = 2 * math.pi * i / n_b
        ca, sa = math.cos(a), math.sin(a)
        brings.append([bm_r.verts.new((px, r * ca, r * sa)) for px, r in b_prof])
    for i in range(n_b):
        ni = (i + 1) % n_b
        for j in range(4):
            nj = (j + 1) % 4
            bm_r.faces.new((brings[i][j], brings[ni][j], brings[ni][nj], brings[i][nj]))

    patterns = {
        "star5":  (5,  [(0.0, 0.0)], 0.020),
        "twin5":  (5,  [(-0.09, -0.20), (0.09, 0.20)], 0.012),
        "y6":     (6,  [(-0.04, -0.22), (0.04, 0.22)], 0.011),
        "mesh10": (10, [(0.0, 0.0)], 0.011),
        "ultra7": (7,  [(0.0, 0.0)], 0.013),
        "blade5": (5,  [(0.0, 0.16)], 0.026),
        "te6":    (6,  [(0.0, 0.0)], 0.022),
        "dish5":  (5,  [(0.0, 0.0)], 0.024),
        "tarmac10": (10, [(-0.04, -0.10), (0.04, 0.10)], 0.009),
        "turbofan": (16, [(0.0, 0.0)], 0.012),
    }
    n_spokes, branches, hw0 = patterns.get(spoke_style, (5, [(0.0, 0.0)], 0.016))
    if spoke_style == "turbofan":
        # Flat/conical rally Turbofan aero-disc face with 16 perimeter radial cooling vane slots
        n_ring_tf = 32
        r_in, r_mid, r_out = 0.052, rim_r * 0.80, rim_r - 0.008
        x_in, x_mid, x_out = 0.068 * side, 0.088 * side, 0.082 * side
        ring_in = [bm_r.verts.new((x_in, r_in * math.cos(2 * math.pi * i / n_ring_tf), r_in * math.sin(2 * math.pi * i / n_ring_tf))) for i in range(n_ring_tf)]
        ring_mid = [bm_r.verts.new((x_mid, r_mid * math.cos(2 * math.pi * i / n_ring_tf), r_mid * math.sin(2 * math.pi * i / n_ring_tf))) for i in range(n_ring_tf)]
        ring_out = [bm_r.verts.new((x_out, r_out * math.cos(2 * math.pi * i / n_ring_tf), r_out * math.sin(2 * math.pi * i / n_ring_tf))) for i in range(n_ring_tf)]
        for i in range(n_ring_tf):
            ni = (i + 1) % n_ring_tf
            bm_r.faces.new((ring_in[i], ring_in[ni], ring_mid[ni], ring_mid[i]))
            if i % 2 == 0:  # alternating perimeter cooling vanes
                bm_r.faces.new((ring_mid[i], ring_mid[ni], ring_out[ni], ring_out[i]))
    else:
        for s_idx in range(n_spokes):
            base_a = 2 * math.pi * s_idx / n_spokes
            for a0_off, a1_off in branches:
                rows = []
                for k in range(5):
                    t = k / 4.0
                    r = 0.056 + (rim_r - 0.012 - 0.056) * t
                    th = base_a + lerp(a0_off, a1_off, t)
                    hw = hw0 * (1.0 - 0.28 * t)
                    dish_recess = 0.024 if spoke_style == "dish5" else 0.0
                    x_face = (0.064 - dish_recess + 0.036 * (t ** 1.35)) * side
                    depth = 0.020 * side
                    c_, s_ = math.cos(th), math.sin(th)
                    tx, ty = -s_, c_
                    pts = [bm_r.verts.new((x_face - depth * dsg, r * c_ + tx * hw * wsg, r * s_ + ty * hw * wsg))
                           for wsg, dsg in ((-1, 0), (1, 0), (1, 1), (-1, 1))]
                    rows.append(pts)
                for k in range(4):
                    for j in range(4):
                        bm_r.faces.new((rows[k][j], rows[k][(j + 1) % 4], rows[k + 1][(j + 1) % 4], rows[k + 1][j]))
    bmesh.ops.recalc_face_normals(bm_r, faces=bm_r.faces)
    bm_obj(bm_r, f"{name}_rim", mats["rim"], parent=w_root)

    add_cyl(f"{name}_hub", mats["rim"], (0.055 * side, 0, 0), 0.058, 0.056, (0, 90, 0), 20, w_root)
    add_cyl(f"{name}_disc", mats["disc"], (-0.012 * side, 0, 0), rim_r * 0.78, 0.026, (0, 90, 0), 28, w_root)

    cal_y = 0.135 if loc[1] < 0 else -0.135
    add_box(f"caliper_{name.split('_')[1]}", mats["caliper"],
            (loc[0] - 0.008 * side, loc[1] + cal_y, loc[2] + 0.028),
            (0.064, 0.080, 0.160), (0, 0, 0), root, bevel=0.014)


def build_wing(style, half_len, tail_z, tail_w, mats, root, spec=None):
    if style == "none":
        return
    # Parent all stock wing parts cleanly under an object named `wing` so Garage spoilers swap it cleanly!
    bm = bmesh.new()

    def add_bar(cx, cy, cz, sx, sy, sz, pitch_deg=0.0):
        b2 = bmesh.new()
        bmesh.ops.create_cube(b2, size=1.0)
        p = math.radians(pitch_deg)
        cp, sp = math.cos(p), math.sin(p)
        for v in b2.verts:
            vx, vy, vz = v.co.x * sx, v.co.y * sy, v.co.z * sz
            ry = vy * cp - vz * sp
            rz = vy * sp + vz * cp
            v.co = Vector((vx + cx, ry + cy, rz + cz))
        bmesh.ops.bevel(b2, geom=list(b2.edges), offset=min(sx, sy, sz) * 0.18, segments=2, affect="EDGES")
        tmp = bpy.data.meshes.new("_wt")
        b2.to_mesh(tmp)
        b2.free()
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)

    y_rear = half_len - 0.14
    w_span = tail_w * 1.88
    if style == "lip_muscle":
        add_bar(0, half_len - 0.07, tail_z + 0.045, tail_w * 1.72, 0.14, 0.055, -18)
    elif style == "wedge_low":
        add_bar(0, y_rear, tail_z + 0.11, w_span * 0.94, 0.24, 0.032, -7)
        for sx in (-0.42, 0.42):
            add_bar(sx, y_rear - 0.02, tail_z + 0.04, 0.034, 0.18, 0.14, 10)
    elif style == "hoop_street":
        add_bar(0, y_rear, tail_z + 0.15, w_span * 0.92, 0.20, 0.034, -4)
        for sx in (-w_span * 0.44, w_span * 0.44):
            add_bar(sx, y_rear, tail_z + 0.06, 0.045, 0.22, 0.18, 8)
    elif style == "hoop_nsx":
        # Floating NSX Tribute hoop wing + low deck gurney lip
        add_bar(0, y_rear + 0.02, tail_z + 0.12, w_span * 0.94, 0.22, 0.028, -6)
        add_bar(0, half_len - 0.06, tail_z + 0.03, w_span * 0.88, 0.09, 0.024, -14)
        for sx in (-w_span * 0.45, w_span * 0.45):
            add_bar(sx, y_rear + 0.01, tail_z + 0.05, 0.038, 0.26, 0.14, 12)
    elif style == "bridge_037":
        # Kimera EVO37 / Group B wide bridge wing spanning fender to fender with tall quarter fins
        add_bar(0, y_rear + 0.02, tail_z + 0.22, w_span * 0.98, 0.24, 0.034, -8)
        for sx in (-w_span * 0.48, w_span * 0.48):
            add_bar(sx, y_rear - 0.04, tail_z + 0.11, 0.036, 0.42, 0.25, 10)
    elif style == "re_timeattack":
        # Tokyo backroads RX-7 FD wide low-drag time-attack carbon GT wing
        add_bar(0, y_rear + 0.05, tail_z + 0.27, w_span * 1.06, 0.26, 0.030, -8)
        for sx in (-0.48, 0.48):
            add_bar(sx, y_rear, tail_z + 0.13, 0.024, 0.20, 0.28, 12)
        for sx in (-w_span * 0.53, w_span * 0.53):
            add_bar(sx, y_rear + 0.05, tail_z + 0.25, 0.016, 0.34, 0.20, 0)
    elif style == "swan_rs":
        # 992 GT3 RS towering roof-height swan-neck DRS dual-element wing + lower ducktail
        h = 0.40
        add_bar(0, y_rear + 0.06, tail_z + h, w_span * 1.04, 0.28, 0.032, -8)
        add_bar(0, y_rear + 0.14, tail_z + h + 0.06, w_span * 1.02, 0.12, 0.022, -16)
        add_bar(0, half_len - 0.08, tail_z + 0.04, w_span * 0.86, 0.11, 0.042, -22)
        for sx in (-0.31, 0.31):
            add_bar(sx, y_rear - 0.02, tail_z + h * 0.52, 0.026, 0.22, h * 1.08, 14)
        for sx in (-w_span * 0.52, w_span * 0.52):
            add_bar(sx, y_rear + 0.08, tail_z + h + 0.01, 0.018, 0.42, 0.26, 0)
    elif style == "rally_roof":
        # Lancia Delta Integrale high-angle tilted rally roof hatch spoiler
        cab_y = spec["cab_y"][-2] if spec else half_len - 0.44
        cab_z = (spec["cab_z"][-2] if (spec and spec["cab_z"][-2] is not None) else 1.35)
        rw = (spec["cab_w"][-2] if (spec and spec["cab_w"][-2] is not None) else 0.58)
        add_bar(0, cab_y + 0.06, cab_z + 0.10, rw * 2.04, 0.24, 0.030, -32)
        for sx in (-rw * 0.98, rw * 0.98):
            add_bar(sx, cab_y + 0.05, cab_z + 0.08, 0.026, 0.26, 0.14, -28)
    elif style == "jdm_high":
        add_bar(0, y_rear + 0.02, tail_z + 0.25, w_span * 0.98, 0.24, 0.032, -6)
        for sx in (-0.52, 0.52):
            add_bar(sx, y_rear, tail_z + 0.11, 0.030, 0.20, 0.26, 8)
        for sx in (-w_span * 0.49, w_span * 0.49):
            add_bar(sx, y_rear + 0.02, tail_z + 0.24, 0.018, 0.28, 0.16, 0)
    elif style in ("gt_track", "swan_gt", "active_aero", "hyper_swan"):
        h = 0.28 if style in ("gt_track", "hyper_swan") else 0.22
        add_bar(0, y_rear + 0.05, tail_z + h, w_span * 1.02, 0.28, 0.034, -9)
        pylon_x = 0.30 if "swan" in style else 0.46
        for sx in (-pylon_x, pylon_x):
            add_bar(sx, y_rear - 0.03, tail_z + h * 0.48, 0.026, 0.22, h * 1.05, 16)
        for sx in (-w_span * 0.51, w_span * 0.51):
            add_bar(sx, y_rear + 0.05, tail_z + h - 0.02, 0.018, 0.34, 0.22, 0)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mat = mats["paint"] if style in ("hoop_street", "lip_muscle", "bridge_037", "rally_roof") else mats["carbon"]
    bm_obj(bm, "wing", mat, parent=root)


def build_exhausts(style, half_len, mats, root):
    y_out = half_len + 0.025
    tips = []
    if style == "quad_outer":
        tips = [(-0.58, 0.22, 0.044), (-0.47, 0.22, 0.044), (0.47, 0.22, 0.044), (0.58, 0.22, 0.044)]
    elif style == "dual_mid":
        tips = [(-0.32, 0.24, 0.050), (0.32, 0.24, 0.050)]
    elif style == "center_hex":
        tips = [(-0.08, 0.25, 0.054), (0.08, 0.25, 0.054)]
    elif style == "dual_high":
        tips = [(-0.24, 0.46, 0.050), (0.24, 0.46, 0.050)]
    elif style == "center_dual":
        tips = [(-0.09, 0.22, 0.048), (0.09, 0.22, 0.048)]
    elif style == "top_quad":
        tips = [(-0.22, 0.64, 0.040), (-0.08, 0.64, 0.040), (0.08, 0.64, 0.040), (0.22, 0.64, 0.040)]
    elif style == "center_oval":
        tips = [(0.0, 0.24, 0.072)]
    elif style == "single_cannon":
        tips = [(-0.48, 0.22, 0.062)]

    for i, (tx, tz, tr) in enumerate(tips):
        add_cyl(f"exhaust_{i}", mats["chrome"], (tx, y_out - 0.07, tz), tr, 0.16, (90, 0, 0), 20, root)
        add_cyl(f"bore_dark_{i}", mats["under"], (tx, y_out - 0.005, tz), tr * 0.78, 0.04, (90, 0, 0), 16, root)


def sculpt_car(spec, out_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cid = spec["id"]
    paint_rgb = hex_rgb(spec["paint"])
    acc_rgb = hex_rgb(spec["accent"])
    mats = {
        "paint": make_mat("paint", paint_rgb, metal=0.42, rough=0.18, coat=1.0),
        "accent": make_mat("accent", acc_rgb, metal=0.25, rough=0.30, coat=0.7),
        "carbon": make_mat("carbon", (0.022, 0.024, 0.028), metal=0.18, rough=0.30, coat=0.65),
        "trim": make_mat("trim_black", (0.016, 0.017, 0.020), metal=0.05, rough=0.52),
        "grille": make_mat("grille_mesh", (0.010, 0.011, 0.013), metal=0.25, rough=0.62),
        "under": make_mat("underbody", (0.010, 0.010, 0.012), metal=0.0, rough=0.88),
        "glass": make_mat("glass", (0.012, 0.015, 0.022), metal=0.05, rough=0.02, coat=1.0, alpha=0.38),
        "drl": make_mat("drl_led", (0.95, 0.98, 1.0), metal=0.0, rough=0.05, emit=(0.94, 0.98, 1.0), emit_str=7.5),
        "beam": make_mat("beam_led", (0.96, 0.98, 1.0), metal=0.0, rough=0.04, emit=(1.0, 0.99, 0.96), emit_str=9.5),
        "tail": make_mat("taillight", (0.58, 0.01, 0.01), metal=0.0, rough=0.08, emit=(1.0, 0.04, 0.02), emit_str=5.2),
        "tyre": make_mat("tyre", (0.013, 0.013, 0.014), metal=0.0, rough=0.84),
        "rim": make_mat("rim", spec["rim_rgb"], metal=0.92, rough=0.24),
        "disc": make_mat("disc", (0.28, 0.29, 0.31), metal=0.92, rough=0.36),
        "caliper": make_mat("caliper", spec["caliper_rgb"], metal=0.45, rough=0.26, coat=0.6),
        "chrome": make_mat("exhaust_chrome", (0.72, 0.74, 0.78), metal=0.98, rough=0.12),
        "interior": make_mat("interior_dark", (0.022, 0.024, 0.028), metal=0.0, rough=0.78),
    }

    root = bpy.data.objects.new(cid, None)
    bpy.context.scene.collection.objects.link(root)

    hl = spec["half_len"]
    TOP = P(spec["top_pts"])
    SH_Z = P(spec["sh_pts"])
    ZB = P(spec["zb_pts"])
    WB = P(spec["wb_pts"])
    SH_IN = P(spec["sh_in"])
    ZMID = P([(-hl, spec["top_pts"][0][1] * 0.72), (spec["y_fa"], 0.44), (0.0, 0.45), (spec["y_ra"], 0.50), (hl, 0.54)])

    STATIONS = sorted(set([
        -hl, -hl + 0.05, -hl + 0.16, -hl + 0.34, spec["y_fa"] - 0.26, spec["y_fa"],
        spec["y_fa"] + 0.28, -0.78, -0.45, -0.10, 0.28, 0.65, spec["y_ra"] - 0.28,
        spec["y_ra"], spec["y_ra"] + 0.28, hl - 0.36, hl - 0.16, hl - 0.05, hl,
    ]))
    PARTS = [
        "body", "fender_L", "fender_R", "quarter_L", "quarter_R", "rocker_L", "rocker_R", "cowl", "deck",
        "underbody", "skirt", "bumper_front", "bumper_rear", "hood", "trunk", "door_L", "door_R",
        "roof", "glass", "trim_window", "pillar",
    ]
    PI = {p: i for i, p in enumerate(PARTS)}

    def half_ring(y):
        zb, top, w, zm, sz = ZB(y), TOP(y), WB(y), ZMID(y), SH_Z(y)
        ws = w - SH_IN(y)
        return [
            (0.0, zb), (w - 0.15, zb), (w - 0.045, zb + 0.065), (w, zm),
            (w - 0.015, sz - 0.08), (ws, sz), (ws - 0.095, sz + 0.014),
            (ws * 0.44, top - 0.005), (0.0, top),
        ]

    def ring(y):
        h = half_ring(y)
        return h + [(-x, z) for x, z in h[-2:0:-1]]

    def band_of(k):
        hk = k if k <= 8 else 16 - k
        hk1 = (k + 1) if (k + 1) <= 8 else 16 - (k + 1)
        return min(hk, hk1), (1 if k < 8 else -1)

    def classify_body(y, b, side):
        if b == 0:
            return "underbody"
        if y < -hl + 0.30 or (y < -hl + 0.48 and b <= 3):
            return "bumper_front"
        if y > hl - 0.28 or (y > hl - 0.46 and b <= 3):
            return "bumper_rear"
        if b >= 6 and -hl + 0.30 < y < -0.65:
            return "hood"
        if b >= 6 and spec["y_ra"] < y < hl - 0.28:
            return "trunk"
        if b == 1 and -1.05 < y < 1.05:
            return "skirt"
        if 2 <= b <= 4 and -0.52 < y < 0.62:
            return "door_L" if side > 0 else "door_R"
        lr = "_L" if side > 0 else "_R"
        if b >= 7:
            return "cowl" if y < 0.0 else "deck"
        if y < -0.52:
            return "fender" + lr
        if y > 0.62:
            return "quarter" + lr
        return "rocker" + lr

    def build_body_cage():
        bm = bmesh.new()
        rings = [[bm.verts.new((x, y, z)) for x, z in ring(y)] for y in STATIONS]
        crease = bm.edges.layers.float.new("crease_edge")
        cr = spec["crease"]
        for i in range(len(rings) - 1):
            ym = 0.5 * (STATIONS[i] + STATIONS[i + 1])
            for k in range(16):
                f = bm.faces.new((rings[i][k], rings[i][(k + 1) % 16], rings[i + 1][(k + 1) % 16], rings[i + 1][k]))
                band, side = band_of(k)
                f.material_index = PI[classify_body(ym, band, side)]
            for k in (5, 11):
                bm.edges.get((rings[i][k], rings[i + 1][k]))[crease] = cr
            for k in (2, 14):
                bm.edges.get((rings[i][k], rings[i + 1][k]))[crease] = cr * 0.7
        for r, part, out in ((rings[0], "bumper_front", -1), (rings[-1], "bumper_rear", 1)):
            mid = {0: r[0], 8: r[8]}
            for i in range(1, 8):
                a = r[i]
                mid[i] = bm.verts.new((0.0, a.co.y + out * 0.042, a.co.z))
            for i in range(8):
                for side_pts in ((r[i], r[i + 1], mid[i + 1], mid[i]),
                                 (mid[i], mid[i + 1], r[(16 - i - 1) % 16], r[(16 - i) % 16])):
                    q = []
                    for v in side_pts:
                        if v not in q:
                            q.append(v)
                    f = bm.faces.new(q)
                    f.material_index = PI[part]
            for k in range(16):
                bm.edges.get((r[k], r[(k + 1) % 16]))[crease] = 0.5
        for f in bm.faces:
            f.normal_update()
            c = f.calc_center_median()
            want = Vector((0, 1 if c.y > 0 else -1, 0)) if abs(c.y) > hl - 0.06 else Vector((c.x, 0, c.z - 0.45))
            if f.normal.dot(want) < 0:
                f.normal_flip()
        return bm

    CAB_Y, CAB_ROOF, CAB_ROOF_W = spec["cab_y"], spec["cab_z"], spec["cab_w"]

    def cabin_half(i):
        y = CAB_Y[i]
        sz = SH_Z(y)
        wb = WB(y) - SH_IN(y) - 0.085
        if CAB_ROOF[i] is None:
            top = TOP(y) + 0.004
            return [(wb + 0.01, sz - 0.04), (wb, sz + 0.015), (wb - 0.03, sz + 0.03),
                    (wb - 0.12, top + 0.004), (wb - 0.22, top + 0.004), (0.34, top + 0.006), (0.0, top + 0.007)]
        roof, rw = CAB_ROOF[i], CAB_ROOF_W[i]
        return [
            (wb + 0.01, sz - 0.04), (wb, sz + 0.025), (wb - 0.025, sz + 0.068),
            (rw + 0.075, roof - 0.072), (rw, roof - 0.028), (rw * 0.5, roof), (0.0, roof + 0.005),
        ]

    def classify_cabin(i, b):
        if b == 0:
            return "body"
        if b == 1:
            return "trim_window" if 0 <= i <= 4 else "body"
        if i <= 1:
            return "glass" if b >= 2 else "pillar"
        if i <= 3:
            return "glass" if b == 2 else "roof"
        if i == 4:
            return "glass" if b != 3 else "pillar"
        return "glass" if b >= 4 else "pillar"

    def build_cabin_cage():
        bm = bmesh.new()
        rings = []
        for i in range(len(CAB_Y)):
            h = cabin_half(i)
            pts = h + [(-x, z) for x, z in h[-2::-1]]
            rings.append([bm.verts.new((x, CAB_Y[i], z)) for x, z in pts])
        crease = bm.edges.layers.float.new("crease_edge")
        n = len(rings[0])
        for i in range(len(rings) - 1):
            for k in range(n - 1):
                f = bm.faces.new((rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]))
                hk, hk1 = (k if k <= 6 else 12 - k), ((k + 1) if k + 1 <= 6 else 12 - (k + 1))
                f.material_index = PI[classify_cabin(i, min(hk, hk1))]
            for k in (4, 8):
                bm.edges.get((rings[i][k], rings[i + 1][k]))[crease] = 0.45
        for f in bm.faces:
            f.normal_update()
            c = f.calc_center_median()
            if f.normal.dot(Vector((c.x, 0.0, c.z - 0.5))) < 0:
                f.normal_flip()
        return bm

    def subdivide(bm, name, levels):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for part in PARTS:
            me.materials.append(bpy.data.materials.get("tag_" + part) or bpy.data.materials.new("tag_" + part))
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        sub = ob.modifiers.new("subd", "SUBSURF")
        sub.levels = sub.render_levels = levels
        sub.boundary_smooth = "PRESERVE_CORNERS"
        apply_mods(ob)
        return ob

    wheel_specs = [
        (spec["track_f"], spec["y_fa"], spec["wr_f"], "FL"),
        (-spec["track_f"], spec["y_fa"], spec["wr_f"], "FR"),
        (spec["track_r"], spec["y_ra"], spec["wr_r"], "RL"),
        (-spec["track_r"], spec["y_ra"], spec["wr_r"], "RR"),
    ]

    def cut_arches(body):
        for wx, wy, wr, name in wheel_specs:
            sgn = 1 if wx > 0 else -1
            bpy.ops.mesh.primitive_cylinder_add(
                vertices=48, radius=wr + 0.044, depth=0.95,
                location=(sgn * (abs(wx) + 0.14), wy, wr + 0.012),
                rotation=(0, math.pi / 2, 0),
            )
            cyl = bpy.context.active_object
            cyl.data.materials.append(bpy.data.materials["tag_underbody"])
            mod = body.modifiers.new("arch_" + name, "BOOLEAN")
            mod.operation = "DIFFERENCE"
            mod.solver = "EXACT"
            mod.object = cyl
            apply_mods(body)
            bpy.data.objects.remove(cyl, do_unlink=True)

    PART_MAT = {
        "underbody": "under", "skirt": "carbon", "glass": "glass", "trim_window": "trim",
        "roof": "accent" if spec.get("black_roof") else "paint",
        "pillar": "accent" if spec.get("black_roof") else "paint",
    }

    def split_parts(ob, rename=None):
        src = bmesh.new()
        src.from_mesh(ob.data)
        groups = {}
        for f in src.faces:
            groups.setdefault(PARTS[f.material_index], []).append(f)
        made = {}
        for part, faces in groups.items():
            name = (rename or {}).get(part, part)
            sub = mc.sub_bmesh(src, faces)
            if part not in ("glass", "underbody"):
                mc.shrink_boundary(sub, 0.0024)
            made[name] = (sub, part)
        src.free()
        bpy.data.objects.remove(ob, do_unlink=True)
        out = {}
        for name, (sub, part) in made.items():
            out[name] = bm_obj(sub, name, mats[PART_MAT.get(part, "paint")], parent=root)
        return out

    body = subdivide(build_body_cage(), "body_src", 2)
    cut_arches(body)
    cabin = subdivide(build_cabin_cage(), "cabin_src", 2)
    surf = Surface([body, cabin])
    body_parts = split_parts(body)
    split_parts(cabin, rename={"body": "cabin_base", "glass": "glass", "roof": "roof", "trim_window": "window_trim", "pillar": "pillars"})
    for name, ratio in (("underbody", 0.25),):
        if name in body_parts:
            dec = body_parts[name].modifiers.new("dec", "DECIMATE")
            dec.ratio = ratio
            apply_mods(body_parts[name])

    # ---- Front Grille, Splitter, Headlights / DRLs ----
    fwd = (0, 1, 0)
    nose_z = spec["top_pts"][0][1]
    nose_w = WB(-hl + 0.16)
    projected_patch(surf, "grille", mats["grille"],
                    lambda u, v: ((u * 2 - 1) * nose_w * 0.56, -hl - 0.8, lerp(0.16, nose_z * 0.88, v)),
                    14, 4, fwd, 0.004, root)
    # Carbon front splitter
    add_box("front_splitter", mats["carbon"], (0, -hl + 0.08, 0.115), (nose_w * 1.92, 0.28, 0.026), (0, 0, 0), root, bevel=0.008)

    hs = spec["head_style"]
    for sgn, tag in ((1, "L"), (-1, "R")):
        if hs == "oval":
            def lamp_fn(u, v, s=sgn):
                ang = u * 2 * math.pi
                return (s * (0.62 + 0.12 * v * math.cos(ang)), -hl - 0.8, nose_z + 0.10 + 0.08 * v * math.sin(ang))
            h1 = projected_patch(surf, f"drl_{tag}", mats["drl"], lamp_fn, 14, 3, (0, 0.90, -0.40), 0.008, root)
            if h1 is None:
                add_box(f"drl_{tag}", mats["drl"], (sgn * 0.62, -hl + 0.22, nose_z + 0.14), (0.20, 0.22, 0.06), (14, 0, sgn * -12), root, bevel=0.015)
            add_box(f"beam_{tag}_0", mats["beam"], (sgn * 0.62, -hl + 0.20, nose_z + 0.13), (0.11, 0.12, 0.05), (14, 0, sgn * -12), root, bevel=0.012)
        elif hs == "sleek_pod":
            # Recessed carbon endurance twin-projector pods + lower fog lamps (RX-7 FD RE-Amemiya style)
            ly = -hl + 0.34
            lz = TOP(ly) + 0.008
            lx = min(WB(ly) - 0.14, 0.62)
            add_box(f"lamp_pod_{tag}", mats["carbon"], (sgn * lx, ly, lz - 0.012), (0.26, 0.24, 0.046), (12, 0, sgn * -8), root, bevel=0.008)
            for k, ox in enumerate((-0.055, 0.055)):
                add_cyl(f"beam_{tag}_{k}", mats["beam"], (sgn * (lx + ox), ly - 0.02, lz + 0.004), 0.036, 0.04, (78, 0, 0), 16, root)
            add_box(f"drl_{tag}", mats["drl"], (sgn * (lx + 0.02), -hl + 0.07, 0.23), (0.14, 0.05, 0.065), (0, 0, 0), root, bevel=0.008)
        elif hs == "quad_halo":
            for k, ox in enumerate((0.50, 0.70)):
                h = projected_patch(surf, f"beam_{tag}_{k}", mats["beam"],
                                    lambda u, v, s=sgn, cx=ox: (s * (cx + (u - 0.5) * 0.12), -hl - 0.8, nose_z * 0.86 + (v - 0.5) * 0.09),
                                    6, 4, fwd, 0.010, root)
                if h is None:
                    add_box(f"beam_{tag}_{k}", mats["beam"], (sgn * ox, -hl + 0.06, nose_z * 0.86), (0.12, 0.06, 0.09), (0, 0, 0), root, bevel=0.01)
            add_box(f"drl_{tag}", mats["drl"], (sgn * 0.60, -hl + 0.05, nose_z * 0.86), (0.34, 0.05, 0.03), (0, 0, 0), root)
        else:
            # Project onto upper front nose + guaranteed flush sculpted LED cluster
            ly = -hl + 0.24
            lz = TOP(ly) + 0.012
            lx = min(WB(ly) - 0.12, 0.66)
            h_drl = projected_patch(surf, f"drl_{tag}", mats["drl"],
                                    lambda u, v, s=sgn: (s * lerp(0.42, lx + 0.08, u), -hl - 0.8, lz - 0.04 + u * 0.05 + (v - 0.5) * 0.042),
                                    10, 2, (0, 0.94, -0.32), 0.010, root)
            if h_drl is None:
                add_box(f"drl_{tag}", mats["drl"], (sgn * lx, ly, lz), (0.30, 0.18, 0.036), (12, 0, sgn * -18), root, bevel=0.008)
            h_beam = projected_patch(surf, f"beam_{tag}_0", mats["beam"],
                                     lambda u, v, s=sgn: (s * lerp(0.48, lx + 0.04, u), -hl - 0.8, lz - 0.02 + u * 0.04 + (v - 0.5) * 0.028),
                                     8, 2, (0, 0.94, -0.32), 0.012, root)
            if h_beam is None:
                add_box(f"beam_{tag}_0", mats["beam"], (sgn * (lx - 0.02), ly - 0.02, lz + 0.006), (0.20, 0.12, 0.030), (12, 0, sgn * -18), root, bevel=0.006)

    # ---- Taillights & Rear Diffuser ----
    back = (0, -1, 0)
    tail_z = spec["top_pts"][-1][1]
    tail_w = WB(hl - 0.14)
    ts = spec["tail_style"]
    if ts == "quad_round":
        for sgn, tag in ((1, "L"), (-1, "R")):
            for k, ox in enumerate((0.46, 0.66)):
                add_cyl(f"taillight_{tag}_{k}", mats["tail"], (sgn * ox, hl + 0.012, tail_z - 0.04), 0.068, 0.04, (90, 0, 0), 18, root)
    elif ts in ("lightbar", "bar_thin", "racetrack"):
        bar_h = 0.058 if ts == "racetrack" else 0.036
        projected_patch(surf, "taillight_bar", mats["tail"],
                        lambda u, v: ((u * 2 - 1) * tail_w * 0.86, hl + 0.8, tail_z - 0.04 + (v - 0.5) * bar_h),
                        20, 2, back, 0.008, root)
    else:  # y_blade
        for sgn, tag in ((1, "L"), (-1, "R")):
            projected_patch(surf, f"taillight_{tag}", mats["tail"],
                            lambda u, v, s=sgn: (s * lerp(0.32, tail_w * 0.86, u), hl + 0.8, tail_z - 0.03 + (v - 0.5) * 0.042),
                            10, 2, back, 0.008, root)

    # Sculpted rear diffuser + vertical strakes
    add_box("diffuser", mats["carbon"], (0, hl - 0.06, 0.19), (tail_w * 1.56, 0.24, 0.15), (-14, 0, 0), root, bevel=0.012)
    for fx in (-0.42, -0.18, 0.18, 0.42):
        add_box(f"diff_fin_{fx:+.2f}", mats["carbon"], (fx, hl - 0.02, 0.18), (0.020, 0.24, 0.15), (-14, 0, 0), root)

    # ---- Hood Vent, Side Scoops, Roof Scoop, Modded Aero Details, Wing Mirrors & Interior Tub ----
    if spec.get("carbon_hood_inlay"):
        add_box("hood_carbon_inlay", mats["carbon"], (0, spec["y_fa"] + 0.02, TOP(spec["y_fa"] + 0.02) + 0.008), (0.76, 0.88, 0.018), (9, 0, 0), root, bevel=0.006)
        for sgn, tag in ((1, "L"), (-1, "R")):
            add_box(f"hood_nostril_{tag}", mats["grille"], (sgn * 0.22, spec["y_fa"] - 0.10, TOP(spec["y_fa"] - 0.10) + 0.018), (0.18, 0.34, 0.026), (11, 0, 0), root, bevel=0.006)
    elif spec.get("evo_hood_bays"):
        for sgn, tag in ((1, "L"), (-1, "R")):
            add_box(f"hood_bay_{tag}", mats["grille"], (sgn * 0.30, spec["y_fa"] + 0.06, TOP(spec["y_fa"] + 0.06) + 0.014), (0.30, 0.44, 0.024), (8, 0, 0), root, bevel=0.006)
    elif spec["hood_vent"]:
        add_box("hood_vent", mats["grille"], (0, spec["y_fa"] + 0.08, TOP(spec["y_fa"] + 0.08) + 0.012), (0.48, 0.36, 0.024), (8, 0, 0), root, bevel=0.006)
    if spec.get("canards"):
        for sgn, tag in ((1, "L"), (-1, "R")):
            cx = WB(-hl + 0.24) + 0.03
            add_box(f"canard_{tag}_0", mats["carbon"], (sgn * cx, -hl + 0.20, 0.22), (0.11, 0.22, 0.014), (10, sgn * -16, sgn * -14), root, bevel=0.003)
            add_box(f"canard_{tag}_1", mats["carbon"], (sgn * cx, -hl + 0.24, 0.31), (0.09, 0.18, 0.014), (12, sgn * -18, sgn * -16), root, bevel=0.003)
    if spec.get("splitter_struts"):
        for sgn, tag in ((1, "L"), (-1, "R")):
            add_cyl(f"splitter_strut_{tag}", mats["chrome"], (sgn * 0.24, -hl + 0.02, 0.19), 0.008, 0.17, (12, 0, 0), 10, root)
    if spec.get("fender_louvres"):
        for sgn, tag in ((1, "L"), (-1, "R")):
            fx = WB(spec["y_fa"]) - 0.14
            fz = SH_Z(spec["y_fa"]) + 0.015
            add_box(f"fender_louvre_F{tag}", mats["carbon"], (sgn * fx, spec["y_fa"] - 0.02, fz), (0.14, 0.36, 0.018), (4, sgn * 10, 0), root, bevel=0.004)
    if spec.get("front_fangs"):
        for sgn, tag in ((1, "L"), (-1, "R")):
            add_box(f"front_fang_{tag}", mats["accent"], (sgn * (nose_w * 0.72), -hl + 0.10, 0.30), (0.14, 0.12, 0.26), (0, 0, sgn * -14), root, bevel=0.010)
    if spec.get("front_strakes"):
        for sgn, tag in ((1, "L"), (-1, "R")):
            for k, sz in enumerate((0.20, 0.26, 0.32)):
                add_box(f"front_strake_{tag}_{k}", mats["paint"], (sgn * (nose_w * 0.68), -hl + 0.08, sz), (0.28, 0.10, 0.018), (0, 0, sgn * -12), root, bevel=0.004)
    if spec.get("rear_strakes"):
        for k, sz in enumerate((0.40, 0.48, 0.56, 0.64)):
            add_box(f"rear_strake_{k}", mats["accent"], (0, hl - 0.02, sz), (tail_w * 1.66, 0.08, 0.018), (0, 0, 0), root, bevel=0.004)
    if spec["side_scoop"]:
        for sgn, tag in ((1, "L"), (-1, "R")):
            sx = WB(0.42) - 0.03
            add_box(f"side_scoop_{tag}", mats["grille"], (sgn * sx, 0.42, 0.56), (0.08, 0.56, 0.24), (0, 0, sgn * 8), root, bevel=0.012)
    if spec["roof_scoop"]:
        rz = max(z for z in CAB_ROOF if z is not None)
        add_box("roof_scoop", mats["carbon"], (0, 0.22, rz + 0.042), (0.28, 0.52, 0.085), (-5, 0, 0), root, bevel=0.016)

    for sgn, tag in ((1, "L"), (-1, "R")):
        my = CAB_Y[1] + 0.10
        mx = WB(my) + 0.05
        mz = SH_Z(my) + 0.08
        add_box(f"mirror_{tag}", mats["paint"], (sgn * mx, my, mz), (0.16, 0.10, 0.075), (0, 0, sgn * -12), root, bevel=0.018)

    # Dark interior cockpit floor + dash + bucket seats (visible through tinted glass)
    add_box("interior_tub", mats["interior"], (0, 0.10, 0.42), (1.28, 1.50, 0.42), (0, 0, 0), root)
    for sx in (-0.34, 0.34):
        add_box(f"seat_{sx:+.2f}", mats["interior"], (sx, 0.22, 0.72), (0.42, 0.44, 0.56), (14, 0, 0), root, bevel=0.04)

    # ---- Exhausts, Separated Stock Wing & Wheels ----
    build_exhausts(spec["exhaust"], hl, mats, root)
    build_wing(spec["wing"], hl, TOP(hl - 0.14), tail_w, mats, root, spec=spec)

    for wx, wy, wr, tag in wheel_specs:
        w_tyre = 0.255 if wy < 0 else 0.315
        build_wheel(f"wheel_{tag}", 1 if wx > 0 else -1, (wx, wy, wr), wr, w_tyre, spec["spokes"], mats, root)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", export_apply=True, export_yup=True)
    tris = sum(sum(max(1, len(p.vertices) - 2) for p in o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print(f"[sculpt] {cid}: tris={tris} -> {out_path} ({os.path.getsize(out_path) // 1024} KB)")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out-dir", required=True)
    p.add_argument("--only", default="", help="Comma-separated car ids (default: all 10)")
    args = p.parse_args(argv)
    want = set(x.strip() for x in args.only.split(",") if x.strip())
    for spec in FLEET:
        if want and spec["id"] not in want:
            continue
        sculpt_car(spec, os.path.join(args.out_dir, f"{spec['id']}_sculpt.glb"))


if __name__ == "__main__":
    main()
