#!/usr/bin/env python3
"""GPS map layers for one or all cities (the in-car navigation screen, web/src/minimap.ts).

For each city in tools/nyc/cities.json (or the ids given on the command line):
  * tiles/map.json   every edge gets `ms`: the speed limit in km/h. From the OSM `maxspeed` tag of the nearest way of the same
                     street where one is tagged (matched by position, 8 m, name and class preferred), else the typical limit of
                     that road class in the city's country (COUNTRY_LIMITS below). The share of tagged edges is printed.
  * tiles/areas.json water and green areas (parks, grass, cemeteries, pitches, woods) from derived/areas.ndjson, clipped to the
                     built area, simplified to 2 m, areas under 400 m2 dropped. {"v":1,"water":[A,...],"green":[A,...]},
                     A = {"b":[minx,miny,maxx,maxy],"r":[ring,...]}, ring = [x0,y0,x1,y1,...] in game-frame metres (outer first,
                     then holes; fill with the even-odd rule).
Source: OpenStreetMap contributors, ODbL (the extracts in assets_source/downloads, see docs/gps.md). The outputs are derived
databases of that data and stay under the ODbL (LICENSING.md, CREDITS.md).

  python3 tools/nyc/gps_layers.py            all 17 cities
  python3 tools/nyc/gps_layers.py paris nyc  just these
"""
import json, math, os, re, sys

import osmium
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, box
from shapely.strtree import STRtree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CITIES = json.load(open(os.path.join(os.path.dirname(__file__), "cities.json")))

# Road class tier, the same as the GPS's: 0 local, 1 collector, 2 arterial, 3 highway
TIER = {"living_street": 0, "residential": 0, "unclassified": 0, "service": 0, "road": 0,
        "tertiary": 1, "tertiary_link": 1, "secondary": 1, "secondary_link": 1,
        "primary": 2, "primary_link": 2, "trunk": 3, "trunk_link": 3, "motorway": 3, "motorway_link": 3}

# Typical limit (km/h) of an UNTAGGED road by tier, from the country's general rules (urban / built-up area). Used only where the
# OSM way carries no maxspeed. US: 25 mph local, 30-35 arterial, 55 freeway; New York City's citywide default is 25 mph.
COUNTRY_LIMITS = {
    "US": [40, 48, 56, 88], "GB": [48, 48, 48, 112], "FR": [30, 50, 50, 110], "JP": [40, 50, 60, 80], "DE": [30, 50, 50, 100],
    "ES": [30, 50, 50, 100], "PT": [30, 50, 50, 100], "NL": [30, 50, 50, 100], "CA": [40, 50, 60, 100], "KR": [30, 50, 60, 80],
    "SG": [40, 50, 60, 80], "AU": [40, 50, 60, 100], "GR": [30, 50, 50, 90],
}
CITY_LIMITS = {"nyc": [40, 40, 40, 64]}   # citywide 25 mph default, freeways ~40 mph

GREEN = {"park", "grass", "cemetery", "pitch"}
MIN_AREA_M2 = 400.0
SIMPLIFY_M = 2.0


def parse_maxspeed(v):
    """km/h from an OSM maxspeed value, or None (signals, none, walk, country-code rules, lists)."""
    v = v.strip().lower()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?", v)
    if not m:
        return None
    x = float(m.group(1))
    if m.group(2) == "mph":
        x *= 1.609344
    return int(round(x)) if 5 <= x <= 140 else None


def tile_bbox(tiles_dir):
    idx = json.load(open(os.path.join(tiles_dir, "index.json")))
    bb = [t["bbox"] for t in idx["tiles"].values() if "bbox" in t]
    return (min(b[0] for b in bb), min(b[1] for b in bb), max(b[2] for b in bb), max(b[3] for b in bb))


class Ways(osmium.SimpleHandler):
    """Tagged-maxspeed highways inside the box, in game-frame metres."""

    def __init__(self, tr, lonlat_box):
        super().__init__()
        self.tr, self.b = tr, lonlat_box
        self.out = []

    def way(self, w):
        t = w.tags
        hw = t.get("highway")
        if hw not in TIER:
            return
        ms = parse_maxspeed(t.get("maxspeed", "")) if "maxspeed" in t else None
        if ms is None:
            return
        try:
            pts = [(n.lon, n.lat) for n in w.nodes]
        except Exception:
            return
        if len(pts) < 2 or not (self.b[0] <= pts[0][0] <= self.b[2] and self.b[1] <= pts[0][1] <= self.b[3]):
            return
        X, Y = self.tr.transform([p[0] for p in pts], [p[1] for p in pts])
        self.out.append((hw, t.get("name", ""), ms, list(zip(X, Y))))


def process(cid):
    C = CITIES[cid]
    D = os.path.join(ROOT, C["data"])
    TD = os.path.join(ROOT, C["out"])
    origin = C["origin"]
    tr = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={origin[0]} +lon_0={origin[1]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    bx = tile_bbox(TD)
    pad = 250.0
    region = box(bx[0] - pad, bx[1] - pad, bx[2] + pad, bx[3] + pad)

    # ---- areas
    water, green = [], []
    verts = 0
    ap = os.path.join(D, "derived", "areas.ndjson")
    if not os.path.exists(ap):
        print(f"{cid}: no derived/areas.ndjson (rural build): no area layers", flush=True)
    for line in (open(ap) if os.path.exists(ap) else []):
        o = json.loads(line)
        kind = o["kind"]
        if kind != "water" and kind not in GREEN:
            continue
        rings = [r for r in o["rings"] if len(r) >= 4]
        if not rings:
            continue
        try:
            poly = Polygon(rings[0], rings[1:]).buffer(0)
        except Exception:
            continue
        if poly.is_empty or not poly.intersects(region):
            continue
        poly = poly.intersection(region)
        if poly.is_empty:
            continue
        poly = poly.simplify(SIMPLIFY_M, preserve_topology=True)
        for g in (poly.geoms if hasattr(poly, "geoms") else [poly]):
            if g.geom_type != "Polygon" or g.area < MIN_AREA_M2:
                continue
            rs = [list(g.exterior.coords)] + [list(h.coords) for h in g.interiors if Polygon(h).area >= MIN_AREA_M2]
            flat = [[round(c, 1) for p in r[:-1] for c in p] for r in rs]
            verts += sum(len(r) // 2 for r in flat)
            item = {"b": [round(v, 1) for v in g.bounds], "r": flat}
            (water if kind == "water" else green).append(item)
    with open(os.path.join(TD, "areas.json"), "w") as f:
        json.dump({"v": 1, "water": water, "green": green}, f, separators=(",", ":"))
    kb = os.path.getsize(os.path.join(TD, "areas.json")) / 1024

    # ---- speed limits
    mp = os.path.join(TD, "map.json")
    m = json.load(open(mp))
    lon0, lat0 = origin[1], origin[0]
    inv = Transformer.from_crs(f"+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m", "EPSG:4326", always_xy=True)
    (lo0, la0), (lo1, la1) = inv.transform(region.bounds[0], region.bounds[1]), inv.transform(region.bounds[2], region.bounds[3])
    h = Ways(tr, (min(lo0, lo1), min(la0, la1), max(lo0, lo1), max(la0, la1)))
    pbf = os.path.join(D, C["pbf"])
    if os.path.exists(pbf):
        h.apply_file(pbf, locations=True, idx="flex_mem")
    else:
        print(f"{cid}: {C['pbf']} is not in assets_source (rural build from other sources): class defaults only", flush=True)
    ways = [(hw, name, ms, LineString(pts)) for hw, name, ms, pts in h.out if len(set(pts)) > 1]
    tree = STRtree([w[3] for w in ways]) if ways else None
    dflt = CITY_LIMITS.get(cid) or COUNTRY_LIMITS.get(C.get("country", ""), [40, 50, 60, 100])
    nodes = m["nodes"]
    tagged = 0
    for e in m["edges"]:
        tier = TIER.get(e.get("hw", ""), 0)
        pts = e.get("pts") or []
        a, b = nodes[e["a"]], nodes[e["b"]]
        chain = [a] + pts + [b]
        mid = chain[len(chain) // 2] if len(chain) > 2 else [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        speed = None
        if tree is not None:
            p = Point(mid)
            best = None
            for i in tree.query(p.buffer(8.0)):
                hw, name, ms, g = ways[i]
                d = g.distance(p)
                if d > 8.0:
                    continue
                score = d + (0 if name and name == e.get("name") else 4) + (0 if TIER.get(hw) == tier else 3)
                if best is None or score < best[0]:
                    best = (score, ms)
            if best and best[0] < 9.0:
                speed = best[1]
        if speed is not None:
            tagged += 1
        e["ms"] = speed if speed is not None else dflt[tier]
    with open(mp, "w") as f:
        json.dump(m, f, separators=(",", ":"))
    n = len(m["edges"])
    print(f"{cid}: {len(water)} water + {len(green)} green areas, {verts} vertices, areas.json {kb:.0f} KB | "
          f"{n} edges, {tagged} with an OSM maxspeed ({100 * tagged / max(1, n):.0f} %), the rest the {C.get('country', '?')} default {dflt}", flush=True)


if __name__ == "__main__":
    ids = sys.argv[1:] or [k for k in CITIES if not k.startswith("_")]
    for cid in ids:
        process(cid)
