#!/usr/bin/env python3
"""Landmarks that a footprint and a height cannot describe, built from their real dimensions (public figures: heights,
platform levels, diameters). OSM maps the Eiffel Tower as a 125 m square 330 m tall; extruded, that was a solid block.

Each model stands on its OSM footprint (centre and orientation from the footprint's minimum rotated rectangle) and
writes into the tile's two materials: `facade` (masonry, concrete, glass: the facade shader with its _BLD kind) and
`roof` (metal and lattice: s3d roof codes; 6 = floodlit metal, lit at night). colliders() gives what stands on the
ground (the Eiffel Tower's four legs, not the square between them; the Arc de Triomphe's piers, not its arch).

    MODELS = {OSM name: builder}; buildings.py calls build() instead of extruding the footprint.
"""
import math

import numpy as np

import s3d

U_OFF = s3d.U_OFF
LIT = 6   # roof code: floodlit metal (facade.ts roofGraph)


# ----------------------------------------------------------------------------------------------------------------- primitives
class Frame:
    """Footprint frame: centre c (x, y), unit axes ex (long) / ey, half sizes hl / hw, yaw."""
    def __init__(self, poly):
        c, ex, ey, hl, hw = s3d._frame(poly)
        self.c, self.ex, self.ey, self.hl, self.hw = np.asarray(c, float), np.asarray(ex, float), np.asarray(ey, float), hl, hw
        self.yaw = math.atan2(ex[1], ex[0])

    def p(self, x, y, z):
        """local (x along the long axis, y across, z up) -> world"""
        q = self.c + self.ex * x + self.ey * y
        return np.array([q[0], q[1], z], float)


def _emit(acc, P, rgb, code):
    """Triangles (T,3,3) on the roof material, flat shaded, no winding change (beams face every way)."""
    P = np.asarray(P, float)
    if len(P) == 0:
        return
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    ln = np.linalg.norm(n, axis=1)
    k = ln > 1e-9
    P, n = P[k], n[k] / ln[k][:, None]
    t = np.stack([-n[:, 1], n[:, 0], np.zeros(len(n))], 1)
    tl = np.linalg.norm(t, axis=1)
    flat = tl < 1e-3
    t[flat] = [1.0, 0.0, 0.0]; tl[flat] = 1.0
    t /= tl[:, None]
    b = np.cross(n, t)
    o = P.reshape(-1, 3).mean(axis=0)
    u = np.einsum("tij,tj->ti", P - o, t) + code * U_OFF
    v = np.einsum("tij,tj->ti", P - o, b)
    T = len(P)
    col = np.empty((T * 3, 4), np.float32); col[:, :3] = rgb; col[:, 3] = 1.0
    acc.add(P.reshape(-1, 3), np.arange(T * 3).reshape(-1, 3), np.repeat(n, 3, axis=0).astype(np.float32),
            np.stack([u, v], -1).reshape(-1, 2), col)


def _quads(acc, A, B, C, D, rgb, code):
    """quads A-B-C-D (each (N,3)), counter-clockwise seen from outside"""
    P = np.concatenate([np.stack([A, B, C], 1), np.stack([A, C, D], 1)])
    _emit(acc, P, rgb, code)


def beam(acc, p0, p1, w, rgb, code, w1=None):
    """square-section member from p0 to p1 (width w, tapering to w1)"""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    d = p1 - p0
    L = np.linalg.norm(d)
    if L < 1e-6:
        return
    d /= L
    a = np.cross(d, [0, 0, 1.0]) if abs(d[2]) < 0.95 else np.cross(d, [1.0, 0, 0])
    a /= np.linalg.norm(a)
    b = np.cross(d, a)
    w1 = w if w1 is None else w1
    off = [(1, 1), (-1, 1), (-1, -1), (1, -1)]
    r0 = [p0 + (a * sx + b * sy) * w / 2 for sx, sy in off]
    r1 = [p1 + (a * sx + b * sy) * w1 / 2 for sx, sy in off]
    A = np.array([r0[i] for i in range(4)]); B = np.array([r0[(i + 1) % 4] for i in range(4)])
    C = np.array([r1[(i + 1) % 4] for i in range(4)]); D = np.array([r1[i] for i in range(4)])
    _quads(acc, A, B, C, D, rgb, code)


def obox(acc, F, x0, x1, y0, y1, z0, z1, rgb, code):
    """box in the footprint frame, on the roof material (all six faces)"""
    c = [F.p(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]
    q = lambda i, j, k, l: (c[i], c[j], c[k], c[l])
    faces = [q(0, 1, 3, 2)[::-1], q(4, 5, 7, 6), q(0, 1, 5, 4), q(2, 6, 7, 3), q(0, 4, 6, 2), q(1, 3, 7, 5)]
    for f in faces:
        _quads(acc, *[np.array([v]) for v in f], rgb, code)


def ring_walls(acc, rings, rgb, bld, close=True):
    """facade walls between consecutive rings of 3D points (lists of (N,3), counter-clockwise from above).
    UV = (metres along the ring, z): the facade shader's windows / stone courses follow."""
    for R0, R1 in zip(rings[:-1], rings[1:]):
        R0, R1 = np.asarray(R0, float), np.asarray(R1, float)
        n = len(R0)
        idx = range(n) if close else range(n - 1)
        u = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(np.vstack([R0, R0[:1]]), axis=0)[:, :2], axis=1))])
        for i in idx:
            j = (i + 1) % n
            P = np.array([R0[i], R0[j], R1[j], R1[i]])
            nrm = np.cross(P[1] - P[0], P[3] - P[0])
            ln = np.linalg.norm(nrm)
            if ln < 1e-9:
                nrm = np.cross(P[2] - P[1], P[3] - P[1]); ln = np.linalg.norm(nrm)
                if ln < 1e-9:
                    continue
            nrm = (nrm / ln).astype(np.float32)
            uv = np.array([[u[i], P[0, 2]], [u[i + 1], P[1, 2]], [u[i + 1], P[2, 2]], [u[i], P[3, 2]]], np.float32)
            col = np.empty((4, 4), np.float32); col[:, :3] = rgb; col[:, 3] = 1.0
            acc.add(P, np.array([[0, 1, 2], [0, 2, 3]]), np.repeat(nrm[None], 4, axis=0), uv, col, bld)


def circle(F, x, y, z, r, n=24, ry=None):
    ry = r if ry is None else ry
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return [F.p(x + r * math.cos(t), y + ry * math.sin(t), z) for t in a]


def lathe(acc, F, x, y, prof, rgb, bld=None, code=None, n=24):
    """surface of revolution: prof = [(r, z), ...] bottom to top; facade (bld) or roof material (code)"""
    rings = [circle(F, x, y, z, max(r, 1e-3), n) for r, z in prof]
    if bld is not None:
        ring_walls(acc, rings, rgb, bld)
    else:
        for R0, R1 in zip(rings[:-1], rings[1:]):
            R0, R1 = np.asarray(R0), np.asarray(R1)
            _quads(acc, R0, np.roll(R0, -1, 0), np.roll(R1, -1, 0), R1, rgb, code)


def disc(acc, F, x, y, z, r, rgb, code, n=24, up=True):
    rg = np.asarray(circle(F, x, y, z, r, n))
    cen = np.repeat(np.asarray(F.p(x, y, z))[None], n, 0)
    A, B = (rg, np.roll(rg, -1, 0)) if up else (np.roll(rg, -1, 0), rg)
    _emit(acc, np.stack([cen, A, B], 1), rgb, code)


def bld_vec(kind, h, seed=0.37, era=0.3):
    return np.array([seed, max(1, int(h / 4.0)), kind, era], np.float32)


# ----------------------------------------------------------------------------------------------------------------- models
def eiffel(A, F, far):
    """Eiffel Tower, 330 m: four lattice legs curving in to the 2nd floor (115.7 m), one lattice shaft to the top
    platform (276 m), antenna to 330 m; floors at 57.6 / 115.7 / 276 m; the arches between the legs. Puddled iron,
    floodlit gold at night."""
    R = A["roof"]
    iron = np.array([0.20, 0.13, 0.065], np.float32)
    Z = [0.0, 20, 40, 57.6, 80, 100, 115.7, 140, 170, 200, 230, 255, 276.0]
    HW = [62.5, 50.5, 41.0, 35.5, 29.5, 24.5, 21.0, 16.4, 12.4, 9.6, 7.6, 6.3, 5.4]        # outer half width
    LW = [24.0, 19.5, 16.5, 14.5, 12.0, 10.5, 9.5]                                        # leg width up to the 2nd floor
    step = 2 if far else 1
    # legs: each a square lattice column from (hw, hw) inwards by lw, on the diagonal of the square plan
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        rings = []
        for k in range(0, 7):
            hw, lw = HW[k], LW[k]
            o = (sx * hw, sy * hw); i = (sx * (hw - lw), sy * (hw - lw))
            rings.append([F.p(o[0], o[1], Z[k]), F.p(i[0], o[1], Z[k]), F.p(i[0], i[1], Z[k]), F.p(o[0], i[1], Z[k])])
        for k in range(0, 6, 1):
            for c in range(4):
                beam(R, rings[k][c], rings[k + 1][c], 1.6 - 0.1 * k, iron, LIT)
            if far:
                continue
            for c in range(4):   # X braces on each face, two per storey
                a0, a1, b0, b1 = rings[k][c], rings[k][(c + 1) % 4], rings[k + 1][c], rings[k + 1][(c + 1) % 4]
                m0, m1 = (a0 + b0) / 2, (a1 + b1) / 2
                for p, q in ((a0, m1), (a1, m0), (m0, b1), (m1, b0)):
                    beam(R, p, q, 0.55, iron, LIT)
    # the shaft above the 2nd floor
    rings = [[F.p(sx * HW[k], sy * HW[k], Z[k]) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))] for k in range(6, 13)]
    for k in range(len(rings) - 1):
        for c in range(4):
            beam(R, rings[k][c], rings[k + 1][c], 1.1 - 0.08 * k, iron, LIT)
            if not far:
                a0, a1, b0, b1 = rings[k][c], rings[k][(c + 1) % 4], rings[k + 1][c], rings[k + 1][(c + 1) % 4]
                beam(R, a0, b1, 0.45, iron, LIT); beam(R, a1, b0, 0.45, iron, LIT)
    # floors: 1st (a hollow square deck with its galleries), 2nd, top
    for z0, z1, h, hole in ((52.0, 59.0, 36.0, 15.0), (112.0, 118.0, 21.5, 0.0)):
        if hole:
            for x0, x1, y0, y1 in ((-h, h, -h, -hole), (-h, h, hole, h), (-h, -hole, -hole, hole), (hole, h, -hole, hole)):
                obox(R, F, x0, x1, y0, y1, z0, z1, iron * 1.1, LIT)
        else:
            obox(R, F, -h, h, -h, h, z0, z1, iron * 1.1, LIT)
    obox(R, F, -6.0, 6.0, -6.0, 6.0, 272.0, 284.0, iron * 1.2, LIT)
    obox(R, F, -3.2, 3.2, -3.2, 3.2, 284.0, 300.0, iron, LIT)
    beam(R, F.p(0, 0, 300.0), F.p(0, 0, 330.0), 1.6, iron * 0.9, LIT, w1=0.4)
    # the arches between the legs (under the 1st floor, on the four sides)
    if not far:
        for side in range(4):
            pts = []
            for t in np.linspace(-1, 1, 11):
                x, z = t * 38.0, 39.0 - 19.0 * t * t
                yv = 44.0
                xx, yy = {0: (x, yv), 1: (-yv, x), 2: (-x, -yv), 3: (yv, -x)}[side]
                pts.append(F.p(xx, yy, z))
            for p, q in zip(pts[:-1], pts[1:]):
                beam(R, p, q, 1.3, iron, LIT)


def eiffel_cols(F):
    out = []
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        c = F.p(sx * 50.0, sy * 50.0, 0)
        out.append(dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=45.0, hx=12.5, hy=12.5, yaw=round(F.yaw, 4)))
    return out


def cn_tower(A, F, far):
    """CN Tower, 553 m: hexagonal concrete core with three tapering wings to ~335 m, the main pod (342-361 m, glass
    observation decks), the shaft to the SkyPod (447 m) and the antenna mast to 553 m."""
    Fa, R = A["facade"], A["roof"]
    conc = np.array([0.50, 0.49, 0.46], np.float32)
    mon = bld_vec(6, 553)
    glass = bld_vec(3, 30, 0.61, 0.9)
    lathe(Fa, F, 0, 0, [(8.5, 0), (8.0, 120), (7.2, 335), (6.2, 447)], conc, mon, n=6)
    for k in range(3):   # the three wings: tapering slabs at 120 degrees
        a = k * 2 * math.pi / 3
        ux, uy = math.cos(a), math.sin(a)
        rings = []
        for z, ext, t in ((0, 30.0, 9.0), (60, 24.0, 8.0), (150, 16.0, 6.5), (260, 10.5, 5.0), (335, 7.0, 4.0)):
            px, py = -uy * t / 2, ux * t / 2
            rings.append([F.p(ux * 5 + px, uy * 5 + py, z), F.p(ux * 5 - px, uy * 5 - py, z), F.p(ux * ext - px, uy * ext - py, z), F.p(ux * ext + px, uy * ext + py, z)])
        ring_walls(Fa, [r[::-1] for r in rings], conc, mon)
    # main pod and SkyPod
    lathe(Fa, F, 0, 0, [(9.0, 330), (22.0, 338)], conc, mon, n=32)
    lathe(Fa, F, 0, 0, [(22.0, 338), (24.0, 344), (24.0, 352)], np.array([0.05, 0.07, 0.09], np.float32), glass, n=32)
    lathe(Fa, F, 0, 0, [(24.0, 352), (20.0, 358), (18.0, 361), (8.0, 364)], conc, mon, n=32)
    disc(R, F, 0, 0, 330.0, 9.0, conc * 0.7, 0, n=32, up=False)
    lathe(Fa, F, 0, 0, [(6.2, 441), (9.0, 444), (9.0, 449), (5.0, 452)], np.array([0.05, 0.07, 0.09], np.float32), glass, n=24)
    beam(R, F.p(0, 0, 452.0), F.p(0, 0, 553.0), 5.0, np.array([0.55, 0.55, 0.56], np.float32), 3, w1=0.8)


def cn_cols(F):
    c = F.p(0, 0, 0)
    return [dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=120.0, hx=14.0, hy=14.0, yaw=round(F.yaw, 4))]


def fernsehturm(A, F, far):
    """Berliner Fernsehturm, 368 m: tapering concrete shaft (32 m at the foot), the steel sphere (32 m, centre 213 m)
    with its glass decks, the red and white antenna to 368 m."""
    Fa, R = A["facade"], A["roof"]
    conc = np.array([0.56, 0.56, 0.54], np.float32)
    lathe(Fa, F, 0, 0, [(16.0, 0), (11.0, 40), (7.5, 120), (6.5, 197), (5.0, 250)], conc, bld_vec(6, 368), n=24)
    sph = []
    for t in np.linspace(-math.pi / 2, math.pi / 2, 13):
        sph.append((16.0 * math.cos(t), 213.0 + 16.0 * math.sin(t)))
    lathe(R, F, 0, 0, sph, np.array([0.42, 0.44, 0.47], np.float32), code=3, n=28)
    lathe(Fa, F, 0, 0, [(16.25, 204.5), (16.25, 210.0)], np.array([0.05, 0.06, 0.08], np.float32), bld_vec(3, 6, 0.3, 0.9), n=28)
    z = 250.0
    for i, h in enumerate((22, 20, 18, 16, 14, 12, 10, 6)):
        rgb = np.array([0.55, 0.06, 0.04] if i % 2 == 0 else [0.62, 0.62, 0.6], np.float32)
        beam(R, F.p(0, 0, z), F.p(0, 0, z + h), 3.2 - 0.3 * i, rgb, 0, w1=3.0 - 0.3 * i)
        z += h


def fernsehturm_cols(F):
    c = F.p(0, 0, 0)
    return [dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=60.0, hx=12.0, hy=12.0, yaw=round(F.yaw, 4))]


def wheel(A, F, far, diameter=120.0, top=135.0, capsules=32, tint=(0.42, 0.5, 0.72)):
    """Observation wheel (London Eye: 120 m, top 135 m, 32 capsules): rim, spokes, hub, the A-frame legs on one side,
    the capsules round the outside. The wheel stands in the footprint's long axis."""
    R = A["roof"]
    steel = np.array(tint, np.float32)
    r = diameter / 2
    zc = top - r
    n = 48
    rim = [F.p(r * math.cos(t), 0.0, zc + r * math.sin(t)) for t in np.linspace(0, 2 * np.pi, n, endpoint=False)]
    for i in range(n):
        beam(R, rim[i], rim[(i + 1) % n], 1.8, steel, LIT)
    hub0, hub1 = F.p(0, -6, zc), F.p(0, 6, zc)
    beam(R, hub0, hub1, 3.0, steel * 0.8, LIT)
    if not far:
        for i in range(0, n, 2):
            beam(R, hub0 if i % 4 == 0 else hub1, rim[i], 0.22, steel, LIT)
        for i in range(capsules):
            t = 2 * np.pi * i / capsules
            c = (r + 2.6) * math.cos(t), (r + 2.6) * math.sin(t)
            prof = [(0.2, -2.0), (1.6, -1.4), (2.0, 0.0), (1.6, 1.4), (0.2, 2.0)]
            rings = [[F.p(c[0] + rr * math.cos(a) * 0.0 + rr * math.cos(a), dy, zc + c[1] + rr * math.sin(a))
                      for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)] for rr, dy in prof]
            for R0, R1 in zip(rings[:-1], rings[1:]):
                _quads(R, np.asarray(R0), np.roll(np.asarray(R0), -1, 0), np.roll(np.asarray(R1), -1, 0), np.asarray(R1),
                       np.array([0.3, 0.38, 0.5], np.float32), 4)
    # A-frame: two legs from the ground on one side up to the hub
    for sx in (-1, 1):
        beam(R, F.p(sx * 18.0, 42.0, 0.0), hub1, 2.4, steel * 0.85, LIT, w1=1.6)


def wheel_cols(F):
    out = [dict(cx=round(F.p(sx * 18.0, 42.0, 0)[0], 2), cy=round(F.p(sx * 18.0, 42.0, 0)[1], 2), z0=0.0, z1=8.0, hx=2.5, hy=2.5,
                yaw=round(F.yaw, 4)) for sx in (-1, 1)]
    return out


def column(A, F, far, height=57.0):
    """Column monument (Columbus Monument, Barcelona: 57 m): stepped stone pedestal, the column, capital, globe and
    the bronze figure."""
    Fa, R = A["facade"], A["roof"]
    stone = np.array([0.52, 0.48, 0.41], np.float32)
    mon = bld_vec(6, height)
    lathe(Fa, F, 0, 0, [(10.0, 0), (10.0, 6.5)], stone, mon, n=8)
    disc(R, F, 0, 0, 6.5, 10.0, stone * 0.9, 0, n=8)
    lathe(Fa, F, 0, 0, [(5.6, 6.5), (5.6, 13.0)], stone, mon, n=8)
    disc(R, F, 0, 0, 13.0, 5.6, stone * 0.9, 0, n=8)
    lathe(Fa, F, 0, 0, [(1.6, 13.0), (1.35, height - 9.0)], stone * 0.95, mon, n=16)
    obox(R, F, -2.2, 2.2, -2.2, 2.2, height - 9.0, height - 7.0, np.array([0.3, 0.24, 0.12], np.float32), 3)
    sph = [(1.9 * math.cos(t), height - 5.2 + 1.9 * math.sin(t)) for t in np.linspace(-math.pi / 2, math.pi / 2, 7)]
    lathe(R, F, 0, 0, sph, np.array([0.16, 0.13, 0.07], np.float32), code=3, n=12)
    bronze = np.array([0.1, 0.085, 0.05], np.float32)
    beam(R, F.p(0, 0, height - 3.4), F.p(0, 0, height - 0.5), 1.3, bronze, 3, w1=0.9)
    beam(R, F.p(0, 0, height - 2.0), F.p(2.4, 0, height + 0.2), 0.35, bronze, 3)   # the outstretched arm


def column_cols(F):
    c = F.p(0, 0, 0)
    return [dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=13.0, hx=8.0, hy=8.0, yaw=round(F.yaw, 4))]


def pyramid_tower(A, F, far, h=212.0, spire=48.0):
    """Transamerica Pyramid, 260 m: the tapering office tower (48 floors to 212 m) and the spire."""
    Fa, R = A["facade"], A["roof"]
    white = np.array([0.64, 0.63, 0.6], np.float32)
    L, W = min(F.hl, 27.0), min(F.hw, 27.0)
    sc = lambda z: 1.0 - (1.0 - 7.0 / max(L, 7.5)) * (z / h)
    rings = []
    for z in (0.0, 16.0, 60.0, 110.0, 160.0, h):
        s = sc(max(0.0, z - 16.0) * h / (h - 16.0)) if z > 16 else 1.0
        rings.append([F.p(L * s * x, W * s * y, z) for x, y in ((1, 1), (-1, 1), (-1, -1), (1, -1))][::-1][::-1])
    rings = [r[::-1] for r in rings]
    ring_walls(Fa, [r for r in rings], white, bld_vec(2, h, 0.52, 0.7))
    top = rings[-1]
    _quads(R, np.array([top[0]]), np.array([top[1]]), np.array([top[2]]), np.array([top[3]]), white * 0.9, 3)
    apex = F.p(0, 0, h + spire)
    for i in range(4):
        _emit(R, [[top[i], top[(i + 1) % 4], apex]], white * 0.95, 3)


def arc(A, F, far):
    """Arc de Triomphe, 50 m: four piers, the 29 m main arch through the long side, the 18.7 m side arches, the attic."""
    Fa = A["facade"]
    stone = np.array([0.56, 0.51, 0.42], np.float32)
    mon = bld_vec(6, 50)
    L, W = F.hl, F.hw
    ax, ay = 7.3, 4.2

    def block(x0, x1, y0, y1, z0, z1):
        rr = [[F.p(x, y, z) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))] for z in (z0, z1)]
        ring_walls(Fa, rr, stone, mon)
        _quads(A["roof"], np.array([rr[1][0]]), np.array([rr[1][1]]), np.array([rr[1][2]]), np.array([rr[1][3]]), stone * 0.9, 0)
        _quads(A["roof"], np.array([rr[0][3]]), np.array([rr[0][2]]), np.array([rr[0][1]]), np.array([rr[0][0]]), stone * 0.6, 0)
    for sx in (-1, 1):
        for sy in (-1, 1):
            block(min(sx * L, sx * ax), max(sx * L, sx * ax), min(sy * W, sy * ay), max(sy * W, sy * ay), 0.0, 29.2)
        block(min(sx * L, sx * ax), max(sx * L, sx * ax), -ay, ay, 18.7, 29.2)
    block(-L, L, -W, W, 29.2, 50.0)
    for z0, z1, o in ((29.2, 30.4, 0.5), (36.4, 38.2, 0.9), (48.6, 50.4, 0.7)):   # impost, entablature, attic cornices
        block(-L - o, L + o, -W - o, W + o, z0, z1)


def arc_cols(F):
    out = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            c = F.p(sx * (F.hl + 7.3) / 2, sy * (F.hw + 4.2) / 2, 0)
            out.append(dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=29.0, hx=round((F.hl - 7.3) / 2, 2), hy=round((F.hw - 4.2) / 2, 2), yaw=round(F.yaw, 4)))
    return out


def gate(A, F, far):
    """Brandenburger Tor, 26 m: six rows of paired Doric columns (five passages), entablature, attic, the quadriga."""
    Fa, R = A["facade"], A["roof"]
    stone = np.array([0.58, 0.54, 0.46], np.float32)
    mon = bld_vec(6, 26)
    W = min(F.hw, 5.5)
    xs = [-15.5, -9.3, -3.4, 3.4, 9.3, 15.5]
    for x in xs:
        for y in (-W + 1.2, W - 1.2):
            lathe(Fa, F, x, y, [(0.95, 0.0), (0.95, 1.0), (0.85, 1.0), (0.78, 14.5)], stone, mon, n=12)
    for x0, x1, z0, z1 in ((-17.0, 17.0, 14.5, 18.6), (-11.0, 11.0, 18.6, 21.8)):
        rr = [[F.p(x, y, z) for x, y in ((x0, -W), (x1, -W), (x1, W), (x0, W))] for z in (z0, z1)]
        ring_walls(Fa, rr, stone, mon)
        _quads(R, np.array([rr[1][0]]), np.array([rr[1][1]]), np.array([rr[1][2]]), np.array([rr[1][3]]), stone * 0.9, 0)
        _quads(R, np.array([rr[0][3]]), np.array([rr[0][2]]), np.array([rr[0][1]]), np.array([rr[0][0]]), stone * 0.6, 0)
    obox(R, F, -3.0, 3.0, -2.0, 2.0, 21.8, 26.0, np.array([0.12, 0.26, 0.2], np.float32), 5)   # the copper quadriga


def gate_cols(F):
    out = []
    for x in (-15.5, -9.3, -3.4, 3.4, 9.3, 15.5):
        c = F.p(x, 0, 0)
        out.append(dict(cx=round(c[0], 2), cy=round(c[1], 2), z0=0.0, z1=15.0, hx=1.0, hy=round(min(F.hw, 5.5), 2), yaw=round(F.yaw, 4)))
    return out


MODELS = {
    "Tour Eiffel": (eiffel, eiffel_cols),
    "CN Tower": (cn_tower, cn_cols),
    "Berliner Fernsehturm": (fernsehturm, fernsehturm_cols),
    "London Eye": (wheel, wheel_cols),
    "Singapore Flyer": (lambda A, F, far: wheel(A, F, far, 150.0, 165.0, 28, (0.5, 0.55, 0.65)), wheel_cols),
    "Monument a Colom": (column, column_cols),
    "Transamerica Pyramid": (pyramid_tower, None),
    "Arc de Triomphe": (arc, arc_cols),
    "Brandenburger Tor": (gate, gate_cols),
}


def match(d, poly):
    m = MODELS.get((d.get("name") or "").strip())
    if m is None:
        return None
    if poly.area < 60:     # a fragment or a part with the same name: the model is built from the main footprint
        return None
    return m


def build(A, poly, d, far):
    """Build the landmark model for item d on footprint poly. Returns triangles added."""
    m = match(d, poly)
    F = Frame(poly)
    t0 = A["facade"].tris + A["roof"].tris
    m[0](A, F, far)
    return A["facade"].tris + A["roof"].tris - t0


def colliders(d, poly):
    """None: use the footprint's own colliders"""
    m = match(d, poly)
    if m is None or m[1] is None:
        return None
    return m[1](Frame(poly))
