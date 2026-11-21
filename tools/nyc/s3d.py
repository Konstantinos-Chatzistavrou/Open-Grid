#!/usr/bin/env python3
"""OSM Simple 3D Buildings (https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings) for the city pipeline.

What the mappers modelled is what we build: `building:part` volumes (min_height .. height) instead of the outline
whenever a building has parts (the Sagrada Familia's towers, Big Ben, the Empire State's setbacks ...), roof:shape with
roof:height / roof:levels / roof:orientation / roof:direction, building:colour / roof:colour and building:material /
roof:material. Where a city's buildings carry no roof tags, its typical roof (ROOF_STYLE: Paris zinc mansards, Lisbon
terracotta hips, Amsterdam steep gables ...) is used for the low and mid-rise blocks that would have one.

Roof meshes go to the `roof` material. Its UV is metres in the roof plane (u along the eave, v up the slope, measured
from the roof's own centre, so |u| < U_OFF / 2) and the roof's MATERIAL rides on u as a whole-number offset:
u + code * U_OFF (code: ROOF_CODE). The shader (facade.ts roofGraph) takes code = floor((u + U_OFF / 2) / U_OFF): no
extra vertex attribute, no new pipeline layout, and older tiles' flat roofs (u = world x, |x| < 8 km) decode as 0.
"""
import math

import numpy as np
from shapely.geometry import Polygon, box as sbox
from shapely.geometry.polygon import orient
from shapely import affinity

U_OFF = 16384.0
ROOF_CODE = {"flat": 0, "tiles": 1, "slate": 2, "metal": 3, "glass": 4, "copper": 5}
ROOF_RGB = {   # linear, before the shader's own variation
    "flat": (0.075, 0.075, 0.08), "tiles": (0.42, 0.16, 0.085), "slate": (0.11, 0.115, 0.13),
    "metal": (0.30, 0.33, 0.36), "glass": (0.05, 0.07, 0.09), "copper": (0.14, 0.30, 0.24),
}
PITCHED = {"gabled", "hipped", "half-hipped", "half_hipped", "mansard", "gambrel", "pyramidal", "dome", "onion", "cone",
           "skillion", "round", "saltbox", "side_hipped", "crosspitched", "sawtooth", "spherical"}

# A city's typical roof for untagged buildings: (max height m, shape, material, pitch rise fraction of width, probability)
# Each rule applies to buildings up to that height with no roof:shape and no parts; the first matching rule wins.
ROOF_STYLE = {
    "paris": [(40.0, "mansard", "metal", 0.0, 0.85)],
    "lisbon": [(28.0, "hipped", "tiles", 0.26, 0.9)],
    "barcelona": [(14.0, "hipped", "tiles", 0.24, 0.55)],
    "madrid": [(26.0, "hipped", "tiles", 0.24, 0.6)],
    "amsterdam": [(24.0, "gabled", "slate", 0.55, 0.9)],
    "berlin": [(26.0, "hipped", "tiles", 0.3, 0.7)],
    "london": [(14.0, "gabled", "slate", 0.35, 0.7), (24.0, "hipped", "slate", 0.3, 0.35)],
    "tokyo": [(10.0, "hipped", "slate", 0.3, 0.55)],
    "seoul": [(10.0, "hipped", "slate", 0.3, 0.5)],
    "sanfrancisco": [(13.0, "gabled", "slate", 0.3, 0.45)],
    "toronto": [(11.0, "gabled", "slate", 0.35, 0.6)],
    "melbourne": [(10.0, "hipped", "metal", 0.25, 0.6)],
    "losangeles": [(9.0, "hipped", "tiles", 0.22, 0.5)],
    "miami": [(9.0, "hipped", "tiles", 0.22, 0.45)],
    "chicago": [(10.0, "gabled", "slate", 0.3, 0.45)],
    "singapore": [(12.0, "hipped", "tiles", 0.25, 0.4)],
}

CSS = {   # sRGB 0-255; the common building:colour / roof:colour values
    "white": (245, 245, 240), "black": (25, 25, 25), "grey": (128, 128, 128), "gray": (128, 128, 128),
    "lightgrey": (200, 200, 200), "lightgray": (200, 200, 200), "darkgrey": (80, 80, 80), "darkgray": (80, 80, 80),
    "silver": (192, 192, 192), "red": (165, 50, 40), "darkred": (110, 30, 25), "brown": (120, 72, 45), "maroon": (110, 35, 30),
    "orange": (210, 120, 50), "yellow": (225, 200, 90), "beige": (225, 210, 175), "tan": (205, 180, 140), "wheat": (235, 220, 180),
    "ivory": (240, 235, 215), "cream": (240, 228, 200), "sandybrown": (230, 165, 100), "khaki": (200, 190, 140),
    "green": (60, 120, 70), "darkgreen": (30, 80, 45), "olive": (120, 120, 60), "blue": (70, 100, 160), "lightblue": (160, 190, 215),
    "navy": (40, 50, 90), "teal": (40, 120, 120), "pink": (230, 170, 170), "salmon": (225, 140, 115), "terracotta": (190, 95, 60),
    "brick": (150, 70, 50), "firebrick": (160, 50, 40), "sienna": (150, 85, 50), "chocolate": (150, 85, 40), "peru": (190, 130, 70),
    "gold": (210, 175, 70), "lightyellow": (245, 240, 200), "lavender": (215, 210, 235), "purple": (110, 60, 120),
}


def colour(v):
    """building:colour / roof:colour -> linear RGB (0..0.8), or None."""
    if not v:
        return None
    s = str(v).strip().lower().replace(" ", "").replace("_", "")
    rgb = None
    if s.startswith("#"):
        h = s[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) >= 6:
            try:
                rgb = tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
            except ValueError:
                rgb = None
    else:
        rgb = CSS.get(s)
    if rgb is None:
        return None
    c = np.asarray(rgb, np.float32) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return np.clip(lin * 0.8, 0.015, 0.8).astype(np.float32)


def roof_material(rmat, shape):
    m = (rmat or "").lower()
    if any(k in m for k in ("copper",)):
        return "copper"
    if any(k in m for k in ("tile", "clay", "ceramic", "terracotta")):
        return "tiles"
    if any(k in m for k in ("slate", "eternit", "shingle", "asphalt", "concrete_tiles")):
        return "slate"
    if any(k in m for k in ("metal", "zinc", "tin", "steel", "lead", "aluminium", "aluminum")):
        return "metal"
    if "glass" in m or "plastic" in m:
        return "glass"
    if m in ("concrete", "tar_paper", "gravel", "grass", "plants", "stone"):
        return "flat" if shape in ("flat", "") else "slate"
    return None


def facade_kind(bmat):
    """building:material -> the facade shader's kind (None: keep the classified one). 0/1 brick walk-ups, 2 office
    masonry, 3 glass curtain wall, 4 modern masonry."""
    m = (bmat or "").lower()
    if "glass" in m or "mirror" in m:
        return 3
    if "brick" in m:
        return 1
    if any(k in m for k in ("stone", "sandstone", "limestone", "granite", "marble")):
        return 2
    if any(k in m for k in ("concrete", "plaster", "stucco", "render", "cement_block")):
        return 4
    if any(k in m for k in ("metal", "steel", "aluminium")):
        return 3
    return None


# ----------------------------------------------------------------------------------------------------------------- geometry
def _frame(poly, orientation=None):
    """Minimum rotated rectangle frame: centre c, unit long axis ex, across axis ey, half length hl, half width hw."""
    r = poly.minimum_rotated_rectangle
    pts = np.asarray(r.exterior.coords)[:4]
    e0, e1 = pts[1] - pts[0], pts[2] - pts[1]
    l0, l1 = np.hypot(*e0), np.hypot(*e1)
    if l0 >= l1:
        ex, hl, hw = e0 / max(l0, 1e-9), l0 / 2, l1 / 2
    else:
        ex, hl, hw = e1 / max(l1, 1e-9), l1 / 2, l0 / 2
    if orientation == "across":
        ex, hl, hw = np.array([-ex[1], ex[0]]), hw, hl
    ey = np.array([-ex[1], ex[0]])
    c = pts.mean(axis=0)
    return c, ex, ey, hl, hw


def _emit_tris(acc, P, rgb, code):
    """P: (T, 3, 3) triangles (CCW seen from outside). Flat-shaded, roof-plane UV (u along the eave, v up the slope)."""
    if len(P) == 0:
        return
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    ln = np.linalg.norm(n, axis=1)
    k = ln > 1e-8
    P, n = P[k], n[k] / ln[k][:, None]
    if len(P) == 0:
        return
    flip = n[:, 2] < -1e-6           # roofs face up: a triangle wound the wrong way is turned over
    P[flip] = P[flip][:, [0, 2, 1]]; n[flip] *= -1
    t = np.stack([-n[:, 1], n[:, 0], np.zeros(len(n))], 1)
    tl_ = np.linalg.norm(t, axis=1)
    flat = tl_ < 1e-3
    t[flat] = [1.0, 0.0, 0.0]; tl_[flat] = 1.0
    t /= tl_[:, None]
    b = np.cross(n, t)
    o = P.reshape(-1, 3).mean(axis=0)     # the roof's own centre: |u| stays small, the code decodes exactly
    u = np.einsum("tij,tj->ti", P - o, t) + code * U_OFF
    v = np.einsum("tij,tj->ti", P - o, b)
    T = len(P)
    pos = P.reshape(-1, 3)
    nrm = np.repeat(n, 3, axis=0).astype(np.float32)
    uv = np.stack([u, v], -1).reshape(-1, 2)
    col = np.empty((T * 3, 4), np.float32); col[:, :3] = rgb; col[:, 3] = 1.0
    acc.add(pos, np.arange(T * 3).reshape(-1, 3), nrm, uv, col)


def _tri_poly(poly):
    """earcut a polygon (with holes) -> (verts (V,2), tris (T,3))."""
    import mapbox_earcut
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    verts = np.vstack(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tri = np.asarray(mapbox_earcut.triangulate_float64(verts, ends), np.int64).reshape(-1, 3)
    return verts, tri


def _polys(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for q in getattr(g, "geoms", []) for p in _polys(q)]


def _band_roof(R, poly, zw, profile, c, ex, ey, hw, rgb, code):
    """Roofs whose height depends only on the distance across the ridge (gabled, round, gambrel, skillion, saltbox):
    the footprint is cut into bands parallel to the ridge; z is linear inside each band."""
    ys = [y for y, _ in profile]
    for a, b in zip(ys[:-1], ys[1:]):
        if b - a < 1e-4:
            continue
        # band between across-distances a..b (in metres from the centre line, signed)
        L = 1e5
        corners = [c + ex * (-L) + ey * a, c + ex * L + ey * a, c + ex * L + ey * b, c + ex * (-L) + ey * b]
        band = Polygon(corners)
        for q in _polys(poly.intersection(band)):
            if q.area < 0.01:
                continue
            verts, tri = _tri_poly(orient(q, 1.0))
            if len(tri) == 0:
                continue
            d = (verts - c) @ ey
            z = zw + np.interp(d, ys, [h for _, h in profile])
            P = np.column_stack([verts, z])[tri]
            _emit_tris(R, P, rgb, code)


def _ring_roof(R, poly, zw, rings, c, ex, ey, rgb, code, flat_top=False):
    """Roofs made of scaled copies of the outline (hipped, mansard, pyramidal, dome, onion, cone): rings = [(sx, sy, dz)]
    from the eave (1, 1, 0) inwards/upwards; sx scales along the long axis, sy across. Every ring has the outline's
    vertices, so consecutive rings join with quads; a ring scaled to a segment or a point closes the roof."""
    ring = np.asarray(orient(poly, 1.0).exterior.coords)[:-1]
    rel = ring - c
    lx, ly = rel @ ex, rel @ ey
    pts = []
    for sx, sy, dz in rings:
        q = c + np.outer(lx * sx, ex) + np.outer(ly * sy, ey)
        pts.append(np.column_stack([q, np.full(len(q), zw + dz)]))
    n = len(ring)
    tris = []
    for A, B in zip(pts[:-1], pts[1:]):
        for i in range(n):
            j = (i + 1) % n
            tris.append([A[i], A[j], B[j]])
            tris.append([A[i], B[j], B[i]])
    P = np.asarray(tris)
    if flat_top:
        top = Polygon(pts[-1][:, :2])
        if top.is_valid and top.area > 0.05:
            verts, tri = _tri_poly(orient(top, 1.0))
            if len(tri):
                P = np.concatenate([P, np.column_stack([verts, np.full(len(verts), pts[-1][0, 2])])[tri]])
    _emit_tris(R, P, rgb, code)


def roof_height(shape, poly, rh, rlevels, rise=None):
    if rh:
        return float(rh)
    if rlevels:
        return float(rlevels) * 3.0
    _, _, _, hl, hw = _frame(poly)
    if shape in ("dome", "onion", "spherical"):
        return min(hw, hl) * (1.6 if shape == "onion" else 1.0)
    if shape in ("pyramidal", "cone"):
        return min(hw, hl) * 1.1
    if shape == "mansard":
        return 4.2
    if shape == "skillion":
        return hw * 2 * 0.18
    return max(1.0, hw * 2 * (rise if rise else 0.32))


def build_roof(R, poly, zw, shape, rh, rgb, mat, orientation=None, direction=None):
    """Roof of `shape` on poly, eaves at zw, rising rh. Returns False when the shape does not fit (caller makes it flat)."""
    code = ROOF_CODE.get(mat, 0)
    c, ex, ey, hl, hw = _frame(poly, orientation)
    fill = poly.area / max(4 * hl * hw, 1e-6)
    if shape in ("gabled", "round", "gambrel", "saltbox", "side_hipped", "crosspitched", "sawtooth"):
        if fill < 0.6 or hw < 1.0:
            return False
        if shape == "round":
            prof = [(-hw * math.cos(a), rh * math.sin(a)) for a in np.linspace(0, math.pi / 2, 6)]
            prof = prof + [(-y, z) for y, z in reversed(prof[:-1])]
        elif shape == "gambrel":
            prof = [(-hw, 0.0), (-hw * 0.55, rh * 0.75), (0.0, rh), (hw * 0.55, rh * 0.75), (hw, 0.0)]
        elif shape == "saltbox":
            prof = [(-hw, 0.0), (-hw * 0.3, rh), (hw, rh * 0.25)]
        else:
            prof = [(-hw, 0.0), (0.0, rh), (hw, 0.0)]
        _band_roof(R, poly, zw, [(y, z) for y, z in prof], c, ex, ey, hw, rgb, code)
        return prof
    if shape == "skillion":
        if fill < 0.6:
            return False
        if direction is not None:   # roof:direction: compass degrees the roof slopes DOWN towards
            try:
                a = math.radians(float(direction))
                down = np.array([math.sin(a), math.cos(a)])
                ey = down if abs(down @ ey) >= abs(down @ ex) else ey
                ey = ey * (1 if down @ ey > 0 else -1)
                ex = np.array([ey[1], -ey[0]])
                hw = max(np.abs((np.asarray(poly.exterior.coords) - c) @ ey))
            except ValueError:
                pass
        prof = [(-hw, rh), (hw, 0.0)]
        _band_roof(R, poly, zw, prof, c, ex, ey, hw, rgb, code)
        return prof
    if fill < 0.55 and shape in ("hipped", "half-hipped", "half_hipped", "mansard"):
        return False
    if shape in ("hipped", "half-hipped", "half_hipped"):
        sx = max(0.0, (hl - hw) / max(hl, 1e-6))
        _ring_roof(R, poly, zw, [(1, 1, 0), (sx, 0.0, rh)], c, ex, ey, rgb, code)
        return True
    if shape == "mansard":
        d = min(1.6, hw * 0.35)
        _ring_roof(R, poly, zw, [(1, 1, 0), ((hl - d) / hl, (hw - d) / hw, rh)], c, ex, ey, rgb, code, flat_top=True)
        return True
    if shape in ("pyramidal", "cone"):
        _ring_roof(R, poly, zw, [(1, 1, 0), (0, 0, rh)], c, ex, ey, rgb, code)
        return True
    if shape in ("dome", "spherical"):
        a = np.linspace(0, math.pi / 2, 7)
        _ring_roof(R, poly, zw, [(math.cos(t), math.cos(t), rh * math.sin(t)) for t in a], c, ex, ey, rgb, code)
        return True
    if shape == "onion":
        prof = [(1, 0), (1.18, 0.16), (1.2, 0.32), (1.0, 0.5), (0.62, 0.68), (0.3, 0.84), (0.1, 0.95), (0.0, 1.0)]
        _ring_roof(R, poly, zw, [(s, s, rh * z) for s, z in prof], c, ex, ey, rgb, code)
        return True
    return False


def gable_walls(F, poly, zw, prof, c, ey, rgb, bld):
    """The triangles of wall under a band roof (gable ends): every outline edge gets a vertical strip from the eave zw
    up to the roof surface above it, split where it crosses a band boundary (the roof is linear between them)."""
    ys = np.array([y for y, _ in prof]); zs = np.array([z for _, z in prof])
    ring = np.asarray(orient(poly, 1.0).exterior.coords)
    pts = [ring[0]]
    for a, b in zip(ring[:-1], ring[1:]):
        da, db = (a - c) @ ey, (b - c) @ ey
        lo, hi = min(da, db), max(da, db)
        cuts = sorted(((y - da) / (db - da) for y in ys if lo < y < hi), reverse=(db < da)) if abs(db - da) > 1e-9 else []
        cuts = sorted(cuts)
        for t in cuts:
            pts.append(a + (b - a) * t)
        pts.append(b)
    pts = np.asarray(pts)
    d = (pts - c) @ ey
    ztop = zw + np.interp(d, ys, zs)
    A, B = pts[:-1], pts[1:]
    za, zb = ztop[:-1], ztop[1:]
    L = np.hypot(*(B - A).T)
    keep = (L > 0.03) & ((za - zw > 0.02) | (zb - zw > 0.02))
    if not keep.any():
        return
    u0 = np.concatenate([[0.0], np.cumsum(L)])[:-1]
    A, B, za, zb, L, u0 = A[keep], B[keep], za[keep], zb[keep], L[keep], u0[keep]
    E = len(A)
    dd = B - A
    nrm = np.zeros((E, 3), np.float32); nrm[:, 0] = dd[:, 1] / L; nrm[:, 1] = -dd[:, 0] / L
    pos = np.zeros((E, 4, 3)); uv = np.zeros((E, 4, 2)); col = np.zeros((E, 4, 4), np.float32)
    pos[:, 0, :2] = A; pos[:, 1, :2] = B; pos[:, 2, :2] = B; pos[:, 3, :2] = A
    pos[:, 0, 2] = zw; pos[:, 1, 2] = zw; pos[:, 2, 2] = zb; pos[:, 3, 2] = za
    uv[:, 0, 0] = u0; uv[:, 1, 0] = u0 + L; uv[:, 2, 0] = u0 + L; uv[:, 3, 0] = u0
    uv[:, 0, 1] = zw; uv[:, 1, 1] = zw; uv[:, 2, 1] = zb; uv[:, 3, 1] = za
    col[..., :3] = rgb; col[..., 3] = 1.0
    base = np.arange(E) * 4
    idx = np.stack([base, base + 1, base + 2, base, base + 2, base + 3], axis=1).reshape(-1, 3)
    F.add(pos.reshape(-1, 3), idx, np.repeat(nrm, 4, axis=0), uv.reshape(-1, 2), col.reshape(-1, 4), bld)


def style_roof(city, h, area, seed, has_tag):
    """The city's typical roof for an untagged building of height h: (shape, material, rise) or None (flat)."""
    if has_tag:
        return None
    for hmax, shape, mat, rise, prob in ROOF_STYLE.get(city, []):
        if h <= hmax and area <= 4000:
            return (shape, mat, rise) if seed < prob else None
    return None
