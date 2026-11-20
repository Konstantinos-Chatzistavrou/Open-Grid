"""Original mid-engine hybrid supercar "Tornado GT" (Stock) & "Tornado GT3 #44" (Carbon Widebody Track Spec).

Designed from the two de-branded concept references in the workspace:
  - Stock ("tornado_gt"): pearl-white body, crimson roof & lower V-bar/skirt accents, low mid-engine wedge nose,
    wide hexagonal grille, dual hood vents, 6-LED jewel headlights, sculpted side intercooler scoops with
    floating C-pillar flying buttresses, and gunmetal 5-twin-spoke Y-forged wheels.
  - Modded ("tornado_gt3"): widened carbon-aero GT3 widebody, deep front splitter + red tow hook + dual stacked
    dive-plane canards, vented carbon front fender louvers, deep vented GT3 hood, carbon roof intake snorkel,
    center race wiper, interior roll cage, stepped carbon side skirts & bargeboards, swan-neck GT3 rear wing,
    and 6-spoke center-lock race wheels with crimson center nuts & red calipers.

100% original & de-branded (zero third-party manufacturer marks or logos).
Blender axes: +X = left, -Y = forward, +Z = up -> glTF export converts to game model space (+X left, +Y up, +Z fwd).

Run:
  tools/blender/blender -b --factory-startup --python assets_source/scripts/make_tornado.py
"""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_car as mc  # noqa: E402

ROOT = mc.ROOT
OUT_V5 = os.path.join(ROOT, "web", "public", "assets", "cars", "v5")
PREVIEW_DIR = os.path.join(ROOT, "docs", "parts-audit")
os.makedirs(OUT_V5, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)

P = mc.pchip
WHEEL_R_F = 0.334   # 245/35 R19 front
WHEEL_R_R = 0.348   # 305/30 R20 rear
Y_FA = -1.320       # front axle (-Y = forward)
Y_RA = 1.310        # rear axle (wheelbase = 2.630 m)


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


def build_materials(gt3=False):
    return {
        "paint": make_mat("paint", (0.86, 0.88, 0.90), metal=0.32, rough=0.22, coat=1.0),
        "accent_red": make_mat("accent_crimson", (0.58, 0.025, 0.03), metal=0.55, rough=0.20, coat=1.0),
        "carbon": make_mat("carbon", (0.022, 0.024, 0.028), metal=0.18, rough=0.30, coat=0.65),
        "trim": make_mat("trim_black", (0.015, 0.016, 0.018), metal=0.05, rough=0.52),
        "grille": make_mat("grille_mesh", (0.010, 0.011, 0.013), metal=0.25, rough=0.62),
        "under": make_mat("underbody", (0.010, 0.010, 0.012), metal=0.0, rough=0.88),
        "glass": make_mat("glass", (0.012, 0.015, 0.020), metal=0.05, rough=0.02, coat=1.0, alpha=0.38),
        "lens": make_mat("headlight_lens", (0.012, 0.014, 0.018), metal=0.25, rough=0.05, coat=0.9),
        "drl": make_mat("drl_led", (0.95, 0.98, 1.0), metal=0.0, rough=0.06, emit=(0.94, 0.98, 1.0), emit_str=7.5),
        "beam": make_mat("beam_led", (0.96, 0.98, 1.0), metal=0.0, rough=0.04, emit=(1.0, 0.99, 0.96), emit_str=9.5),
        "tail": make_mat("taillight", (0.55, 0.01, 0.01), metal=0.0, rough=0.08, emit=(1.0, 0.04, 0.02), emit_str=5.0),
        "tyre": make_mat("tyre", (0.013, 0.013, 0.014), metal=0.0, rough=0.84),
        "tyre_letter": make_mat("tyre_letter", (0.85, 0.86, 0.88), metal=0.0, rough=0.72),
        "rim": make_mat("rim", (0.14, 0.15, 0.17) if not gt3 else (0.10, 0.11, 0.13), metal=0.92, rough=0.26),
        "disc": make_mat("disc", (0.28, 0.29, 0.31), metal=0.92, rough=0.38),
        "caliper": make_mat("caliper", (0.72, 0.03, 0.03) if gt3 else (0.12, 0.13, 0.15), metal=0.45, rough=0.28, coat=0.6),
        "chrome": make_mat("exhaust_chrome", (0.68, 0.70, 0.74), metal=0.98, rough=0.14),
        "interior": make_mat("interior_dark", (0.025, 0.026, 0.03), metal=0.0, rough=0.75),
        "cage": make_mat("roll_cage", (0.16, 0.17, 0.19), metal=0.75, rough=0.35),
    }


def apply_mods(ob):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def bm_obj(bm, name, mat, smooth_angle=50, parent=None, location=(0, 0, 0)):
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


def lerp(a, b, t):
    return a + (b - a) * t


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
    return bm_obj(bm, name, material, parent=root)


def build_tornado_variant(gt3=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = build_materials(gt3=gt3)
    cid = "tornado_gt3" if gt3 else "tornado_gt"
    root = bpy.data.objects.new(cid, None)
    bpy.context.scene.collection.objects.link(root)

    # ---- Mid-Engine Supercar PCHIP Design Curves (nose y=-2.235, tail y=+2.235)
    # Cab-forward low wedge nose, sculpted waist, muscular rear mid-engine haunches
    wide = 0.055 if gt3 else 0.0
    TOP = P([(-2.235, 0.43), (-2.12, 0.54), (-1.85, 0.62), (-1.32, 0.70), (-0.82, 0.76),
             (0.0, 0.80), (0.85, 0.855), (1.31, 0.885), (1.88, 0.90), (2.14, 0.89), (2.235, 0.76)])
    SH_Z = P([(-2.235, 0.43), (-2.10, 0.56), (-1.70, 0.69), (-1.32, 0.765), (-0.78, 0.76),
              (-0.15, 0.765), (0.55, 0.81), (1.31, 0.895), (1.88, 0.915), (2.14, 0.90), (2.235, 0.76)])
    ZB = P([(-2.235, 0.125 if gt3 else 0.145), (-2.08, 0.105 if gt3 else 0.125),
            (-1.60, 0.105 if gt3 else 0.122), (1.65, 0.115 if gt3 else 0.132),
            (2.08, 0.19), (2.235, 0.28)])
    WB = P([(-2.235, 0.56 + wide * 0.4), (-2.12, 0.79 + wide * 0.7), (-1.92, 0.90 + wide * 0.85),
            (-1.32, 0.97 + wide), (-0.82, 0.935 + wide * 0.65), (-0.10, 0.905 + wide * 0.45),
            (0.58, 0.95 + wide * 0.7), (1.31, 1.005 + wide * 1.1), (1.88, 0.97 + wide * 0.85),
            (2.14, 0.88 + wide * 0.5), (2.235, 0.74 + wide * 0.3)])
    ZMID = P([(-2.235, 0.30), (-1.32, 0.44), (0.0, 0.43), (1.31, 0.50), (2.235, 0.54)])
    SH_IN = P([(-2.235, 0.08), (-1.32, 0.025), (-0.30, 0.095), (0.45, 0.105), (1.31, 0.025), (2.235, 0.09)])

    STATIONS = [-2.235, -2.19, -2.10, -1.96, -1.78, -1.55, -1.32, -1.06, -0.78, -0.52,
                -0.15, 0.25, 0.62, 0.86, 1.09, 1.31, 1.56, 1.84, 2.04, 2.16, 2.205, 2.235]

    PARTS = ["body", "fender_L", "fender_R", "quarter_L", "quarter_R", "rocker_L", "rocker_R", "cowl", "deck",
             "underbody", "skirt", "bumper_front", "bumper_rear", "hood", "trunk", "door_L", "door_R",
             "roof", "glass", "trim_window", "pillar"]
    PI = {p: i for i, p in enumerate(PARTS)}

    def half_ring(y):
        zb, top, w, zm, sz = ZB(y), TOP(y), WB(y), ZMID(y), SH_Z(y)
        ws = w - SH_IN(y)
        return [
            (0.0, zb),
            (w - 0.15, zb),
            (w - 0.045, zb + 0.065),
            (w, zm),
            (w - 0.015, sz - 0.08),
            (ws, sz),
            (ws - 0.095, sz + 0.014),
            (ws * 0.44, top - 0.005),
            (0.0, top),
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
        if y < -1.96 or (y < -1.78 and b <= 3):
            return "bumper_front"
        if y > 2.04 or (y > 1.84 and b <= 3):
            return "bumper_rear"
        if b >= 6 and -1.96 < y < -0.78:
            return "hood"
        if b >= 6 and 1.31 < y < 2.04:
            return "trunk"
        if b == 1 and -1.06 < y < 1.09:
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
        for i in range(len(rings) - 1):
            ym = 0.5 * (STATIONS[i] + STATIONS[i + 1])
            for k in range(16):
                f = bm.faces.new((rings[i][k], rings[i][(k + 1) % 16], rings[i + 1][(k + 1) % 16], rings[i + 1][k]))
                band, side = band_of(k)
                f.material_index = PI[classify_body(ym, band, side)]
            for k in (5, 11):
                bm.edges.get((rings[i][k], rings[i + 1][k]))[crease] = 0.80
            for k in (2, 14):
                bm.edges.get((rings[i][k], rings[i + 1][k]))[crease] = 0.55
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
            want = Vector((0, 1 if c.y > 0 else -1, 0)) if abs(c.y) > 2.19 else Vector((c.x, 0, c.z - 0.45))
            if f.normal.dot(want) < 0:
                f.normal_flip()
        return bm

    # ---- Cab-forward Mid-Engine Teardrop Greenhouse (matches Tornado sleek windshield & sloped engine cover)
    CAB_Y = [-1.18, -0.72, -0.22, 0.22, 0.64, 1.15, 1.72]
    CAB_ROOF = [None, 0.96, 1.185, 1.205, 1.15, 0.99, None]
    CAB_ROOF_W = [None, 0.58, 0.57, 0.56, 0.54, 0.48, None]

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
            (wb + 0.01, sz - 0.04),
            (wb, sz + 0.025),
            (wb - 0.025, sz + 0.068),
            (rw + 0.075, roof - 0.072),
            (rw, roof - 0.028),
            (rw * 0.5, roof),
            (0.0, roof + 0.005),
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
                bm.edges.get((rings[i][k], rings[i + 1][k]))[crease] = 0.40
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

    track_half_f = 0.845 + (0.042 if gt3 else 0.0)
    track_half_r = 0.865 + (0.052 if gt3 else 0.0)
    wheel_specs = [
        (track_half_f, Y_FA, WHEEL_R_F, "FL"),
        (-track_half_f, Y_FA, WHEEL_R_F, "FR"),
        (track_half_r, Y_RA, WHEEL_R_R, "RL"),
        (-track_half_r, Y_RA, WHEEL_R_R, "RR"),
    ]

    def cut_arches(body):
        for wx, wy, wr, name in wheel_specs:
            sgn = 1 if wx > 0 else -1
            arch_r = wr + (0.040 if gt3 else 0.044)
            bpy.ops.mesh.primitive_cylinder_add(vertices=56, radius=arch_r, depth=0.95,
                                                location=(sgn * (abs(wx) + 0.14), wy, wr + 0.012),
                                                rotation=(0, math.pi / 2, 0))
            cyl = bpy.context.active_object
            cyl.data.materials.append(bpy.data.materials["tag_underbody"])
            mod = body.modifiers.new("arch_" + name, "BOOLEAN")
            mod.operation = "DIFFERENCE"
            mod.solver = "EXACT"
            mod.object = cyl
            apply_mods(body)
            bpy.data.objects.remove(cyl, do_unlink=True)

    # Roof uses signature crimson red accent (matching BOTH reference images!)
    PART_MAT = {
        "underbody": "under",
        "skirt": "carbon" if gt3 else "accent_red",
        "glass": "glass",
        "trim_window": "trim",
        "roof": "accent_red",
    }
    NO_GAP = ("glass", "underbody")

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
            if part not in NO_GAP:
                mc.shrink_boundary(sub, 0.0026)
            made[name] = (sub, part)
        src.free()
        bpy.data.objects.remove(ob, do_unlink=True)
        out = {}
        for name, (sub, part) in made.items():
            out[name] = bm_obj(sub, name, mats[PART_MAT.get(part, "paint")], parent=root)
        return out

    body = subdivide(build_body_cage(), "body_src", 3)
    cut_arches(body)
    cabin = subdivide(build_cabin_cage(), "cabin_src", 3)
    surf = Surface([body, cabin])
    body_parts = split_parts(body)
    cab_parts = split_parts(cabin, rename={"body": "cabin_base", "glass": "glass", "roof": "roof",
                                           "trim_window": "window_trim", "pillar": "pillars"})
    for name, ratio in (("underbody", 0.14), ("bumper_front", 0.55), ("bumper_rear", 0.55)):
        if name in body_parts:
            dec = body_parts[name].modifiers.new("dec", "DECIMATE")
            dec.ratio = ratio
            apply_mods(body_parts[name])

    # ---- Front Fascia: wide hexagonal mesh grille, crimson V-trim surround, lower corner intakes, 6-LED jewel lights
    fwd = (0, 1, 0)
    def grille(u, v):
        half = lerp(0.30, 0.46, v ** 0.65)
        return ((u * 2 - 1) * half, -3.0, lerp(0.18, 0.38, v))
    projected_patch(surf, "grille", mats["grille"], grille, 18, 5, fwd, 0.003, root)

    # Signature crimson front V-bar surround framing the grille & sweeping sharply under headlights
    def vbar(u, v):
        x = (u * 2 - 1) * 0.78
        ax = abs(x)
        z_base = lerp(0.375, 0.455, min(1.0, (ax / 0.78) ** 1.25))
        return (x, -3.0, z_base + (v - 0.5) * 0.052)
    projected_patch(surf, "nose_vbar", mats["carbon"] if gt3 else mats["accent_red"], vbar, 24, 2, fwd, 0.005, root)

    # Diagonal crimson lower V-fangs framing the hexagonal grille (iconic Tornado front face)
    for sgn, tag in ((1, "L"), (-1, "R")):
        def fang(u, v, s=sgn):
            z = lerp(0.16, 0.39, v)
            x_center = lerp(0.34, 0.47, v)
            return (s * (x_center + (u - 0.5) * 0.055), -3.0, z)
        projected_patch(surf, f"nose_fang_{tag}", mats["accent_red"], fang, 4, 8, fwd, 0.0055, root)

    # Crimson lower chin trim strip (stock) or carbon surround (gt3)
    def chin(u, v):
        return ((u * 2 - 1) * (0.86 + wide * 0.6), -3.0, lerp(0.130, 0.165, v))
    projected_patch(surf, "chin_trim", mats["carbon"] if gt3 else mats["accent_red"], chin, 22, 1, fwd, 0.004, root)

    for sgn, tag in ((1, "L"), (-1, "R")):
        def head(u, v, s=sgn):
            x = lerp(0.45, 0.87, u)
            z_lo = lerp(0.455, 0.545, u ** 1.3)
            z_hi = lerp(0.520, 0.612, u ** 1.15)
            return (s * x, -3.0, lerp(z_lo, z_hi, v))
        projected_patch(surf, f"headlight_{tag}", mats["lens"], head, 16, 5, fwd, 0.005, root, bulge=0.003)

        # Swept LED DRL blade along bottom/outer edge of smoked headlight housing
        def drl(u, v, s=sgn):
            x = lerp(0.46, 0.86, u)
            z = lerp(0.463, 0.553, u ** 1.3) + v * 0.011
            return (s * x, -3.0, z)
        projected_patch(surf, f"drl_{tag}", mats["drl"], drl, 16, 1, fwd, 0.009, root)

        # 6 discrete jewel LED projector cubes glowing inside the dark headlight housing
        for ji in range(6):
            u0 = 0.10 + ji * 0.135
            u1 = u0 + 0.085
            def jewel(u, v, s=sgn, a=u0, b=u1):
                uu = lerp(a, b, u)
                x = lerp(0.45, 0.87, uu)
                z_mid = lerp(0.495, 0.580, uu ** 1.2)
                return (s * x, -3.0, z_mid + (v - 0.5) * 0.022)
            projected_patch(surf, f"beam_{tag}_{ji}", mats["beam"], jewel, 2, 1, fwd, 0.0095, root)

        # Large trapezoidal corner brake-cooling air intakes
        def intake(u, v, s=sgn):
            x = lerp(0.47, 0.84 + wide * 0.4, u)
            z_top = lerp(0.40, 0.30, u)
            return (s * x, -3.0, lerp(0.165, z_top, v))
        projected_patch(surf, f"intake_{tag}", mats["grille"], intake, 10, 4, fwd, 0.003, root)

        # Dual hood extractor vents (sleek angled vents, flush with hood)
        def hvent(u, v, s=sgn):
            y = lerp(-1.58, -1.18, v)
            x_base = lerp(0.50, 0.56, v) if not gt3 else lerp(0.24, 0.34, v)
            w_vent = 0.075 if not gt3 else 0.22
            return (s * (x_base + (u - 0.5) * w_vent), y, 2.0)
        projected_patch(surf, f"hood_vent_{tag}", mats["carbon"] if gt3 else mats["trim"], hvent, 6, 6, (0, 0, -1), 0.0035, root)

        # Sculpted black side intercooler intake behind the door (shaped wedge matching reference)
        def side_scoop(u, v, s=sgn):
            y = lerp(0.62 - 0.08 * v, 0.86 - 0.04 * v, u)
            z = lerp(0.44, 0.80, v)
            return (s * 1.6, y, z)
        projected_patch(surf, f"side_intake_{tag}", mats["grille"], side_scoop, 8, 8, (-sgn, 0, 0), 0.004, root)

        # Crimson lower side-skirt accent stripe on stock (matches viber_image_2026-11-19_23-22-02-880.jpg!)
        if not gt3:
            def side_accent(u, v, s=sgn):
                y = lerp(-0.88, 0.86, u)
                z = lerp(0.145, 0.195, v)
                return (s * 1.6, y, z)
            projected_patch(surf, f"skirt_accent_{tag}", mats["accent_red"], side_accent, 16, 1, (-sgn, 0, 0), 0.004, root)

        # Sleek structural A-pillars connecting cowl corners to the front roof rail
        bm_a = bmesh.new()
        bmesh.ops.create_cube(bm_a, size=1.0)
        for v in bm_a.verts:
            v.co.x *= 0.044
            v.co.y *= 0.74
            v.co.z *= 0.036
        ap = bm_obj(bm_a, f"a_pillar_{tag}", mats["paint"], parent=root,
                    location=(sgn * 0.61, -0.50, 0.985))
        ap.rotation_euler = (math.radians(31), math.radians(-sgn * 14), math.radians(-sgn * 11))

        # Sleek flush C-pillar flying buttress smoothly bridging roof rail to rear haunch
        bm_b = bmesh.new()
        bmesh.ops.create_cube(bm_b, size=1.0)
        for v in bm_b.verts:
            v.co.x *= 0.048
            v.co.y *= 0.62
            v.co.z *= 0.042
        butt = bm_obj(bm_b, f"flying_buttress_{tag}", mats["paint"], parent=root,
                      location=(sgn * (0.68 + wide * 0.2), 0.92, 0.975))
        butt.rotation_euler = (math.radians(-21), math.radians(sgn * 14), math.radians(-sgn * 11))

        # Aerodynamic side mirrors (tucked neatly at A-pillar base)
        y0 = -0.54
        x0 = sgn * (0.94 + wide * 0.25)
        z0 = 0.845
        add_box(f"mirror_{tag}", mats["accent_red"] if gt3 else mats["paint"], (x0, y0, z0), (0.19, 0.12, 0.068), (0, 0, sgn * 8), root, bevel=0.022)
        add_box(f"mirror_stalk_{tag}", mats["trim"], (x0 - sgn * 0.09, y0 + 0.01, z0 - 0.025), (0.12, 0.036, 0.018), (0, -sgn * 14, 0), root)

    # ---- Rear Details: full-width LED tail blade, carbon diffuser, quad/dual titanium-chrome exhaust tips
    back = (0, -1, 0)
    def tail(u, v):
        x = (u * 2 - 1) * 0.84
        return (x, 3.0, lerp(0.735, 0.772, v) - 0.025 * abs(u * 2 - 1) ** 2.4)
    projected_patch(surf, "taillight_bar", mats["tail"], tail, 36, 2, back, 0.005, root)

    def diffuser(u, v):
        return ((u * 2 - 1) * 0.78, 3.0, lerp(0.24, 0.42, v))
    projected_patch(surf, "diffuser", mats["carbon"] if gt3 else mats["trim"], diffuser, 18, 3, back, 0.004, root)
    for fx in (-0.42, -0.18, 0.18, 0.42):
        add_box(f"diffuser_fin_{fx:.2f}", mats["carbon"] if gt3 else mats["trim"], (fx, 2.21, 0.26), (0.016, 0.24, 0.14), (0, 0, 0), root)
    for sgn, tag in ((1, "L"), (-1, "R")):
        for dx in (-0.06, 0.06):
            bpy.ops.mesh.primitive_cylinder_add(vertices=18, radius=0.042, depth=0.16,
                                                location=(sgn * 0.36 + dx, 2.18, 0.30), rotation=(math.pi / 2, 0, 0))
            ob = bpy.context.active_object
            ob.name = f"exhaust_{tag}_{dx:+.2f}"
            ob.data.materials.append(mats["chrome"])
            ob.parent = root
            bpy.ops.object.shade_smooth()

    # ---- GT3 / TIME-ATTACK MODDED AERO PACKAGE (matches viber_image_2026-11-19_23-22-04-907.jpg, 100% de-branded!)
    if gt3:
        # 1. Massive protruding carbon front splitter blade + red racing tow hook
        add_box("gt3_splitter_blade", mats["carbon"], (0.0, -2.28, 0.108), (2.06, 0.56, 0.022), (0, 0, 0), root, bevel=0.006)
        add_box("gt3_tow_hook", mats["accent_red"], (0.0, -2.42, 0.135), (0.065, 0.09, 0.016), (0, 0, 0), root, bevel=0.004)
        for sgn, tag in ((1, "L"), (-1, "R")):
            # Splitter endplates
            add_box(f"gt3_split_end_{tag}", mats["carbon"], (sgn * 1.03, -2.18, 0.165), (0.022, 0.42, 0.13), (0, 0, 0), root, bevel=0.004)
            # Dual stacked carbon dive-plane canards on bumper corners
            add_box(f"gt3_canard_lo_{tag}", mats["carbon"], (sgn * 0.99, -2.02, 0.25), (0.17, 0.32, 0.016), (-18, sgn * 8, -sgn * 22), root, bevel=0.003)
            add_box(f"gt3_canard_hi_{tag}", mats["carbon"], (sgn * 1.01, -1.94, 0.37), (0.15, 0.28, 0.016), (-20, sgn * 10, -sgn * 20), root, bevel=0.003)
            # Vented carbon front fender louvers above the front wheels
            for k in range(5):
                add_box(f"gt3_louver_{tag}_{k}", mats["carbon"], (sgn * 0.87, -1.46 + k * 0.068, 0.768 - k * 0.004),
                        (0.18, 0.044, 0.016), (18, sgn * 6, 0), root, bevel=0.002)
            # Stepped carbon side skirts + vertical rear bargeboard
            add_box(f"gt3_skirt_{tag}", mats["carbon"], (sgn * 1.03, 0.0, 0.112), (0.20, 2.02, 0.026), (0, 0, 0), root, bevel=0.004)
            add_box(f"gt3_barge_{tag}", mats["carbon"], (sgn * 1.04, 0.82, 0.24), (0.022, 0.32, 0.24), (0, 0, 0), root, bevel=0.004)
            # Crimson side racing accent stripe & rear quarter flash
            add_box(f"gt3_stripe_{tag}", mats["accent_red"], (sgn * 0.97, 1.48, 0.68), (0.03, 0.78, 0.26), (0, 0, -sgn * 5), root, bevel=0.008)

        # 2. Flush carbon roof air-intake snorkel scoop
        add_box("gt3_roof_scoop_body", mats["carbon"], (0.0, 0.08, 1.215), (0.30, 0.56, 0.082), (-5, 0, 0), root, bevel=0.026)
        add_box("gt3_roof_scoop_mouth", mats["grille"], (0.0, -0.20, 1.225), (0.24, 0.035, 0.048), (0, 0, 0), root)

        # 3. Single center race windshield wiper resting flush on the glass slope
        add_box("gt3_center_wiper", mats["trim"], (0.02, -0.68, 0.98), (0.018, 0.56, 0.014), (24, 0, -4), root)

        # 4. Towering swan-neck carbon GT3 rear wing + sculpted endplates
        wing_y, wing_z = 2.08, 1.15
        add_box("wing", mats["carbon"], (0.0, wing_y, wing_z), (1.96, 0.33, 0.034), (6, 0, 0), root, bevel=0.008)
        for sgn, tag in ((1, "L"), (-1, "R")):
            add_box(f"wing_end_{tag}", mats["carbon"], (sgn * 0.985, wing_y + 0.02, wing_z - 0.02), (0.020, 0.42, 0.25), (0, 0, 0), root, bevel=0.004)
            add_box(f"wing_pylon_{tag}", mats["carbon"], (sgn * 0.36, wing_y - 0.05, wing_z - 0.15), (0.022, 0.15, 0.30), (-14, 0, 0), root, bevel=0.003)

        # 5. Visible steel roll-cage tubes tucked cleanly INSIDE the cabin glass behind A-pillars
        for sgn, tag in ((1, "L"), (-1, "R")):
            add_box(f"cage_apillar_{tag}", mats["cage"], (sgn * 0.48, -0.34, 0.94), (0.026, 0.50, 0.026), (26, 0, -sgn * 8), root, bevel=0.006)
            add_box(f"cage_hoop_{tag}", mats["cage"], (sgn * 0.44, 0.34, 0.88), (0.028, 0.028, 0.42), (-10, 0, 0), root, bevel=0.008)
        add_box("cage_cross", mats["cage"], (0.0, 0.34, 1.06), (0.88, 0.028, 0.028), (0, 0, 0), root, bevel=0.008)

        # 6. Bold crimson GT3 side & rear quarter racing graphics panels (projected flush on body!)
        for sgn, tag in ((1, "L"), (-1, "R")):
            def side_red(u, v, s=sgn):
                y = lerp(0.74, 1.98, u)
                z = lerp(0.54, 0.87, v)
                return (s * 1.6, y, z)
            projected_patch(surf, f"gt3_livery_rear_{tag}", mats["accent_red"], side_red, 12, 6, (-sgn, 0, 0), 0.003, root)
            def door_red(u, v, s=sgn):
                y = lerp(-0.34, 0.44, u)
                z = lerp(0.62 - 0.10 * u, 0.76 - 0.05 * u, v)
                return (s * 1.6, y, z)
            projected_patch(surf, f"gt3_livery_door_{tag}", mats["accent_red"], door_red, 8, 3, (-sgn, 0, 0), 0.003, root)

    # ---- Wheel Wells + Interior Shell
    for wx, wy, wr, name in wheel_specs:
        sgn = 1 if wx > 0 else -1
        bm = bmesh.new()
        x_in, x_out = 0.50 * sgn, (WB(wy) + 0.004) * sgn
        n = 24
        r = wr + 0.048
        a0 = -0.40
        angs = [a0 + (math.pi - 2 * a0) * i / (n - 1) for i in range(n)]
        outer = [bm.verts.new((x_out, wy + r * math.cos(a), wr + 0.012 + r * math.sin(a))) for a in angs]
        inner = [bm.verts.new((x_in, wy + r * math.cos(a), wr + 0.012 + r * math.sin(a))) for a in angs]
        centre = bm.verts.new((x_in, wy, 0.16))
        for i in range(n - 1):
            bm.faces.new((outer[i], outer[i + 1], inner[i + 1], inner[i]))
            bm.faces.new((inner[i], inner[i + 1], centre))
        for f in bm.faces:
            f.normal_update()
            c = f.calc_center_median()
            want = Vector((wx - c.x, wy - c.y, wr - c.z)) if len(f.verts) == 4 else Vector((sgn, 0, 0))
            if f.normal.dot(want) < 0:
                f.normal_flip()
        bm_obj(bm, f"wheel_well_{name}", mats["under"], parent=root)

    # Dark interior cockpit tub + low dashboard + twin bucket seats tucked safely below cowl & glass
    add_box("interior_tub", mats["interior"], (0.0, 0.02, 0.48), (1.24, 1.48, 0.36), (0, 0, 0), root, bevel=0.04)
    add_box("interior_dash", mats["interior"], (0.0, -0.46, 0.72), (1.16, 0.44, 0.16), (-10, 0, 0), root, bevel=0.03)
    for sx in (-0.31, 0.31):
        add_box(f"seat_{sx:+.2f}", mats["interior"], (sx, 0.24, 0.76), (0.42, 0.16, 0.46), (-16, 0, 0), root, bevel=0.04)

    # ---- Custom Concave Forged Wheels (5-Twin-Spoke Y-Forged Stock / 6-Spoke Center-Lock GT3) + Rotors + Calipers
    def build_tornado_wheel(name, side, loc, tyre_r, width):
        w_root = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(w_root)
        w_root.location = loc
        w_root.parent = root

        rim_r = tyre_r * 0.72
        half_w = width * 0.5
        # 1. Tyre torus-like profile lathe
        bm_t = bmesh.new()
        n_ring, n_prof = 40, 12
        prof = [
            (half_w * 0.88, rim_r),
            (half_w * 1.00, rim_r + (tyre_r - rim_r) * 0.35),
            (half_w * 0.96, tyre_r - 0.012),
            (half_w * 0.82, tyre_r),
            (0.0, tyre_r + 0.003),
            (-half_w * 0.82, tyre_r),
            (-half_w * 0.96, tyre_r - 0.012),
            (-half_w * 1.00, rim_r + (tyre_r - rim_r) * 0.35),
            (-half_w * 0.88, rim_r),
            (-half_w * 0.78, rim_r - 0.015),
            (half_w * 0.78, rim_r - 0.015),
        ]
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

        # 2. Outer rim barrel + concave forged spokes
        bm_r = bmesh.new()
        n_b = 36
        b_prof = [(half_w * 0.92 * side, rim_r + 0.008), (half_w * 0.92 * side, rim_r - 0.014),
                  (-half_w * 0.84 * side, rim_r - 0.016), (-half_w * 0.84 * side, rim_r + 0.004)]
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

        # Spokes: 6 stout race spokes on GT3, 5 twin Y-spokes (10 split branches) on Stock
        n_spokes = 6 if gt3 else 5
        for s_idx in range(n_spokes):
            base_a = 2 * math.pi * s_idx / n_spokes
            branches = [(0.0, 0.0)] if gt3 else [(-0.08, -0.22), (0.08, 0.22)]
            for a0_off, a1_off in branches:
                rows = []
                for k in range(5):
                    t = k / 4.0
                    r = 0.058 + (rim_r - 0.012 - 0.058) * t
                    th = base_a + lerp(a0_off, a1_off, t)
                    hw = (0.019 - 0.005 * t) if gt3 else (0.012 - 0.003 * t)
                    x_face = (0.068 + 0.036 * (t ** 1.4)) * side
                    depth = 0.022 * side
                    c_, s_ = math.cos(th), math.sin(th)
                    tx, ty = -s_, c_
                    pts = []
                    for wsg, dsg in ((-1, 0), (1, 0), (1, 1), (-1, 1)):
                        pts.append(bm_r.verts.new((x_face - depth * dsg, r * c_ + tx * hw * wsg, r * s_ + ty * hw * wsg)))
                    rows.append(pts)
                for k in range(4):
                    for j in range(4):
                        bm_r.faces.new((rows[k][j], rows[k][(j + 1) % 4], rows[k + 1][(j + 1) % 4], rows[k + 1][j]))

        bmesh.ops.recalc_face_normals(bm_r, faces=bm_r.faces)
        bm_obj(bm_r, f"{name}_rim", mats["rim"], parent=w_root)

        # Center hub + crimson center-lock nut (GT3) or gunmetal cap (Stock)
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.062, depth=0.06,
                                            location=(0.055 * side, 0, 0), rotation=(0, math.pi / 2, 0))
        hub = bpy.context.active_object
        hub.name = f"{name}_rim_hub"
        hub.data.materials.append(mats["rim"])
        hub.parent = w_root
        if gt3:
            bpy.ops.mesh.primitive_cylinder_add(vertices=18, radius=0.030, depth=0.032,
                                                location=(0.088 * side, 0, 0), rotation=(0, math.pi / 2, 0))
            nut = bpy.context.active_object
            nut.name = f"{name}_centerlock"
            nut.data.materials.append(mats["accent_red"])
            nut.parent = w_root

        # Brake rotor disc
        bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=rim_r * 0.78, depth=0.028,
                                            location=(-0.012 * side, 0, 0), rotation=(0, math.pi / 2, 0))
        disc = bpy.context.active_object
        disc.name = f"{name}_disc"
        disc.data.materials.append(mats["disc"])
        disc.parent = w_root

        # Non-spinning caliper positioned toward rear of front disc / front of rear disc
        cal_y = 0.14 if loc[1] < 0 else -0.14
        add_box(f"caliper_{name.split('_')[1]}", mats["caliper"],
                (loc[0] - 0.008 * side, loc[1] + cal_y, loc[2] + 0.03),
                (0.068, 0.082, 0.165), (0, 0, 0), root, bevel=0.015)

    for wx, wy, wr, tag in wheel_specs:
        w_tyre = (0.295 if wy < 0 else 0.335) if gt3 else (0.245 if wy < 0 else 0.305)
        build_tornado_wheel(f"wheel_{tag}", 1 if wx > 0 else -1, (wx, wy, wr), wr, w_tyre)

    # ---- Stats & Export GLB
    all_meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in all_meshes)
    glb_path = os.path.join(OUT_V5, f"{cid}_hero.glb")
    bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", export_apply=True, export_yup=True)
    print(f"[{cid}] objects={len(all_meshes)} triangles={tris} -> {glb_path} ({os.path.getsize(glb_path)//1024} KB)")
    if "--no-preview" in sys.argv:
        return

    # ---- Render quick studio preview (EEVEE) so we can visually verify both models!
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = Vector((4.35, -4.95, 1.42))
    direction = Vector((0.0, -0.05, 0.52)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam

    for lpos, energy, col in [((4.5, -5.0, 4.2), 1800, (1.0, 0.98, 0.95)),
                              ((-4.0, -2.0, 3.0), 900, (0.75, 0.86, 1.0)),
                              ((0.0, 4.0, 3.5), 1100, (1.0, 0.85, 0.80))]:
        ld = bpy.data.lights.new("L", type="AREA")
        ld.energy = energy
        ld.size = 3.5
        ld.color = col
        lo = bpy.data.objects.new("L", ld)
        bpy.context.scene.collection.objects.link(lo)
        lo.location = lpos
        lo.rotation_euler = (Vector((0, 0, 0.5)) - Vector(lpos)).to_track_quat("-Z", "Y").to_euler()

    # Dark studio floor
    add_box("studio_floor", make_mat("floor", (0.04, 0.045, 0.055), rough=0.35), (0, 0, -0.02), (24, 24, 0.04))

    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = 960
    sc.render.resolution_y = 540
    sc.render.filepath = os.path.join(PREVIEW_DIR, f"{cid}_preview.png")
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.025, 0.03, 0.04, 1.0)
    try:
        bpy.ops.render.render(write_still=True)
        print(f"[{cid}] preview -> {sc.render.filepath}")
    except Exception as exc:
        print(f"[{cid}] preview render skipped: {exc}")


if __name__ == "__main__":
    build_tornado_variant(gt3=False)
    build_tornado_variant(gt3=True)
