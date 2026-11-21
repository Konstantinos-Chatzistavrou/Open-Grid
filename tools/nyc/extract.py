#!/usr/bin/env python3
"""Stage 1: raw data -> one clean, metric, game-frame dataset in assets_source/downloads/nyc/derived/ (gitignored, re-creatable).

Inputs  (tools/nyc/fetch_footprints.py and the BBBike OSM extract, see docs/nyc_tiles.md):
  assets_source/downloads/nyc/NewYork.osm.pbf              OpenStreetMap (ODbL), cut to the Manhattan bbox here
  assets_source/downloads/nyc/footprints_manhattan.json    NYC Open Data building footprints (public domain): roof height (ft), year, code
Outputs (NDJSON, one JSON object per line; coordinates in METRES in the game frame: origin Times Square, x east, y north, z up):
  buildings.ndjson  {id, h (roof height m, above ground), g (ground elevation m), year, code, rings: [[ [x,y],... ] outer first, then holes]}
                    OSM cities also: min, name and the Simple 3D Buildings tags (rs roof:shape, rh roof:height, rl roof:levels,
                    ro roof:orientation, rd roof:direction, bc/rc building/roof colour, bm/rm building/roof material, mm man_made)
  parts.ndjson      OSM cities: building:part volumes {id, h, min, name, the same 3D tags, rings} (tools/nyc/s3d.py)
  roads.ndjson      {id, hw (highway type), name, lanes, oneway, bridge, tunnel, layer, width (m, from tags or by type), pts}
  areas.ndjson      {id, kind (park|water|plaza|pedestrian|cemetery|pitch|parking|grass|island), name, rings}
  rails.ndjson      {id, kind (subway|rail|tram), tunnel, bridge, pts}
  nodes.ndjson      {kind (tree|signal|crossing|hydrant|bench|lamp|bus_stop|subway_entrance|bike|artwork|fountain|stop|waste), x, y, tags}
  meta.json         origin, bbox, counts
"""
import json, math, os, sys, time

import osmium
from pyproj import Transformer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))
from tilelib import CITY, CITY_ID, FRINGE   # CITY=<id> picks the city (cities.json); New York by default
D = os.path.join(ROOT, CITY["data"])
OUT = os.path.join(D, "derived")
ORIGIN = tuple(CITY["origin"])   # (lat, lon) of the game frame's (0, 0): Times Square for New York
_A = CITY["area"]                # S W N E of the drivable area
if CITY.get("mask") == "manhattan":
    BBOX = tuple(_A)             # Manhattan island with a little river around it
else:                            # area cities: the content reaches FRINGE m beyond the drivable box, plus a margin for the tile edges
    _m = FRINGE + 450.0
    _dlat, _dlon = _m / 111320.0, _m / (111320.0 * math.cos(math.radians(ORIGIN[0])))
    BBOX = (_A[0] - _dlat, _A[1] - _dlon, _A[2] + _dlat, _A[3] + _dlon)
FT = 0.3048
FLOOR_M = 3.3
TR = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={ORIGIN[0]} +lon_0={ORIGIN[1]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m", always_xy=True)


def xy(lons, lats):
    X, Y = TR.transform(list(lons), list(lats))
    return [[round(a, 2), round(b, 2)] for a, b in zip(X, Y)]


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


# default full road widths (m, kerb to kerb) by OSM highway type when no width/lanes tag: Manhattan avenues ~ 30 m, streets ~ 18 m
HW_WIDTH = {"motorway": 22, "motorway_link": 9, "trunk": 20, "trunk_link": 9, "primary": 24, "primary_link": 9, "secondary": 18, "secondary_link": 8,
            "tertiary": 14, "tertiary_link": 7, "residential": 12, "unclassified": 12, "living_street": 8, "service": 6, "pedestrian": 8, "footway": 2.5,
            "cycleway": 2.5, "path": 2, "steps": 2, "track": 4, "road": 12}
ROAD_KEEP = set(HW_WIDTH) - {"steps"}
AREA_KIND = [("leisure", {"park": "park", "garden": "park", "playground": "park", "pitch": "pitch", "recreation_ground": "park", "dog_park": "park", "common": "park"}),
             ("landuse", {"grass": "grass", "recreation_ground": "park", "cemetery": "cemetery", "village_green": "park"}),
             ("natural", {"water": "water", "wetland": "water", "grassland": "grass", "wood": "park"}),
             ("amenity", {"parking": "parking", "fountain": "fountain"}),
             ("place", {"square": "plaza"}), ("highway", {"pedestrian": "pedestrian", "footway": "pedestrian"}),
             ("man_made", {"pier": "pier"}), ("waterway", {"riverbank": "water", "dock": "water"})]
NODE_KIND = [("natural", {"tree": "tree"}), ("highway", {"traffic_signals": "signal", "crossing": "crossing", "street_lamp": "lamp", "bus_stop": "bus_stop", "stop": "stop"}),
             ("emergency", {"fire_hydrant": "hydrant"}), ("amenity", {"bench": "bench", "bicycle_parking": "bike", "waste_basket": "waste", "fountain": "fountain"}),
             ("railway", {"subway_entrance": "subway_entrance"}), ("tourism", {"artwork": "artwork"}), ("leisure", {"picnic_table": "bench"})]


def _num(v):
    try:
        return float(str(v).replace(",", ".").split()[0].rstrip("m"))
    except (ValueError, IndexError):
        return None


def _year(t):
    for k in ("start_date", "building:start_date", "construction_date", "year_of_construction"):
        v = t.get(k, "")
        for i in range(len(v) - 3):
            if v[i:i + 4].isdigit() and 1000 < int(v[i:i + 4]) < 2100:
                return int(v[i:i + 4])
    return 0


class Handler(osmium.SimpleHandler):
    def __init__(self, files, osm_buildings=False):
        super().__init__()
        self.f = files
        self.osm_buildings = osm_buildings
        self.parts = []   # building:part (x, y, height) for outlines without a height of their own
        self.n = {k: 0 for k in ("roads", "areas", "rails", "nodes", "buildings", "parts")}

    def building(self, a, t):
        """OSM buildings (cities without an official footprint set): height from height / building:levels / roof:levels,
        else 0 (filled later from the neighbours or the city's typical floors by type: fill_heights)."""
        bt = t.get("building") or "yes"
        if bt in ("no", "roof", "carport", "canopy", "ruins", "shed", "bunker") or t.get("location") == "underground" or t.get("layer", "0").startswith("-"):
            return
        h = _num(t.get("height")) or _num(t.get("building:height"))
        lv = _num(t.get("building:levels"))
        if not h and lv:
            h = lv * FLOOR_M + (_num(t.get("roof:levels")) or 0) * FLOOR_M * 0.6 + 1.0
        mh = _num(t.get("min_height")) or ((_num(t.get("building:min_level")) or 0) * FLOOR_M)
        # Simple 3D Buildings tags (tools/nyc/s3d.py): roof shape / height / levels / orientation / direction, colours, materials
        s3 = {k: v for k, v in (("rs", t.get("roof:shape")), ("rh", _num(t.get("roof:height"))), ("rl", _num(t.get("roof:levels"))),
                                ("ro", t.get("roof:orientation")), ("rd", t.get("roof:direction")), ("bc", t.get("building:colour")),
                                ("rc", t.get("roof:colour")), ("bm", t.get("building:material")), ("rm", t.get("roof:material")),
                                ("mm", t.get("man_made")), ("wd", t.get("wikidata"))) if v}
        try:
            for o in a.outer_rings():
                oc = [(n.lon, n.lat) for n in o]
                if not inside(oc[0][1], oc[0][0]):
                    continue
                r = [xy([p[0] for p in oc], [p[1] for p in oc])]
                if t.get("building:part") and not t.get("building"):
                    if h:
                        cx = sum(p[0] for p in r[0]) / len(r[0]); cy = sum(p[1] for p in r[0]) / len(r[0])
                        self.parts.append((cx, cy, h))
                    for i in a.inner_rings(o):
                        ic = [(n.lon, n.lat) for n in i]
                        r.append(xy([p[0] for p in ic], [p[1] for p in ic]))
                    self.f["parts"].write(json.dumps({"id": f"p{a.orig_id()}_{self.n['parts']}", "h": round(h, 1) if h else 0, "min": round(mh, 1),
                                                      "name": t.get("name", ""), **s3, "rings": r}) + "\n")
                    self.n["parts"] += 1
                    continue
                for i in a.inner_rings(o):
                    ic = [(n.lon, n.lat) for n in i]
                    r.append(xy([p[0] for p in ic], [p[1] for p in ic]))
                self.f["buildings"].write(json.dumps({"id": f"o{a.orig_id()}_{self.n['buildings']}", "h": round(h, 1) if h else 0, "g": 0, "min": round(mh, 1),
                                                      "year": _year(t), "code": bt, "name": t.get("name", ""), **s3, "rings": r}) + "\n")
                self.n["buildings"] += 1
        except (osmium.InvalidLocationError, RuntimeError):
            return

    def node(self, n):
        if not n.tags or not n.location.valid() or not inside(n.location.lat, n.location.lon):
            return
        t = n.tags
        for key, m in NODE_KIND:
            v = t.get(key)
            if v in m:
                x, y = xy([n.location.lon], [n.location.lat])[0]
                self.f["nodes"].write(json.dumps({"kind": m[v], "x": x, "y": y, "tags": {k: t[k] for k in ("direction", "name", "genus", "height") if k in t}}) + "\n")
                self.n["nodes"] += 1
                return

    def way(self, w):
        t = w.tags
        if not t or len(w.nodes) < 2:
            return
        hw, rw = t.get("highway"), t.get("railway")
        if not (hw in ROAD_KEEP or rw in ("subway", "rail", "tram", "light_rail")):
            return
        if hw and CITY.get("skip_elevated") and (hw in ("motorway", "motorway_link") or
                                                 (t.get("bridge") and t.get("layer", "0") not in ("0", "1") and hw in ("trunk", "trunk_link", "primary"))):
            return   # Tokyo's expressways / LA's freeways run on viaducts and in trenches: the flat street level is the map
        try:
            pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2 or not inside(pts[len(pts) // 2][1], pts[len(pts) // 2][0]):
            return
        P = xy([p[0] for p in pts], [p[1] for p in pts])
        tunnel, bridge = t.get("tunnel") in ("yes", "building_passage", "culvert") , t.get("bridge") in ("yes", "viaduct", "movable")
        if hw:
            if t.get("area") == "yes" and hw in ("pedestrian", "footway") and P[0] == P[-1]:
                return   # closed pedestrian areas come through the area handler
            lanes = int(t["lanes"]) if t.get("lanes", "").isdigit() else None
            try:
                width = float(t["width"].split()[0]) if "width" in t else None
            except ValueError:
                width = None
            if width is None:
                width = HW_WIDTH[hw] if lanes is None or hw in ("footway", "cycleway", "path", "pedestrian") else max(HW_WIDTH[hw] * 0.55, lanes * 3.4 + (3 if t.get("parking:lane:both") or t.get("parking:lane:right") else 0))
            self.f["roads"].write(json.dumps({"id": w.id, "hw": hw, "name": t.get("name", ""), "lanes": lanes, "oneway": t.get("oneway") in ("yes", "1", "true"),
                                              "bridge": bridge, "tunnel": tunnel, "layer": int(t["layer"]) if t.get("layer", "").lstrip("-").isdigit() else 0,
                                              "sidewalk": t.get("sidewalk", ""), "width": round(width, 1), "pts": P}) + "\n")
            self.n["roads"] += 1
        else:
            self.f["rails"].write(json.dumps({"id": w.id, "kind": "subway" if rw == "subway" else rw, "tunnel": tunnel or rw == "subway", "bridge": bridge, "pts": P}) + "\n")
            self.n["rails"] += 1

    def area(self, a):
        t = a.tags
        if self.osm_buildings and (t.get("building") or t.get("building:part")):
            self.building(a, t)
            return
        kind = None
        for key, m in AREA_KIND:
            v = t.get(key)
            if v in m:
                if key == "highway" and t.get("area") != "yes":
                    continue
                kind = m[v]
                break
        if not kind:
            return
        try:
            rings = []
            for o in a.outer_rings():
                oc = [(n.lon, n.lat) for n in o]
                if not inside(oc[len(oc) // 2][1], oc[len(oc) // 2][0]):
                    continue
                r = [xy([p[0] for p in oc], [p[1] for p in oc])]
                for i in a.inner_rings(o):
                    ic = [(n.lon, n.lat) for n in i]
                    r.append(xy([p[0] for p in ic], [p[1] for p in ic]))
                rings.append(r)
        except (osmium.InvalidLocationError, RuntimeError):
            return
        for r in rings:
            self.f["areas"].write(json.dumps({"id": a.orig_id(), "kind": kind, "name": t.get("name", ""), "rings": r}) + "\n")
            self.n["areas"] += 1


def footprints():
    rows = json.load(open(os.path.join(D, "footprints_manhattan.json")))
    n = 0
    with open(os.path.join(OUT, "buildings.ndjson"), "w") as f:
        for r in rows:
            g = r.get("the_geom")
            if not g or not r.get("height_roof"):
                continue
            polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]] if g["type"] == "Polygon" else []
            h = float(r["height_roof"]) * FT
            ge = float(r.get("ground_elevation") or 0) * FT
            for pi, poly in enumerate(polys):
                rings = [xy([p[0] for p in ring], [p[1] for p in ring]) for ring in poly]
                f.write(json.dumps({"id": f"{r['base_bbl']}_{pi}", "h": round(h, 1), "g": round(ge, 1), "year": int(r["construction_year"]) if r.get("construction_year", "").isdigit() else 0,
                                    "code": r.get("feature_code", ""), "rings": rings}) + "\n")
                n += 1
    return n


def fill_heights(path, parts):
    """OSM cities: buildings without a height take the tallest building:part inside them, else the median of the known
    heights within 70 m (a Paris block is one height), else the city's typical floors for the building type (cities.json
    `floors`), varied +-25 % by a hash so a street is not one flat cornice."""
    import zlib
    import numpy as np
    from shapely.geometry import Point, Polygon
    from shapely.strtree import STRtree
    rows = [json.loads(l) for l in open(path)]
    polys = []
    for r in rows:
        try:
            p = Polygon(r["rings"][0], r["rings"][1:])
            polys.append(p if p.is_valid else p.buffer(0))
        except Exception:
            polys.append(Polygon())
    if parts:
        pts = [Point(x, y) for x, y, _ in parts]
        pt = STRtree(pts)
        for r, p in zip(rows, polys):
            if p.is_empty:
                continue
            hs = [parts[i][2] for i in pt.query(p, predicate="contains")]
            if hs and max(hs) > (r["h"] or 0):
                r["h"] = round(max(hs), 1)
    known = [(i, p.representative_point()) for i, (r, p) in enumerate(zip(rows, polys)) if r["h"] and not p.is_empty]
    tree = STRtree([c for _, c in known]) if known else None
    fl = CITY.get("floors", {})
    filled = {"part/explicit": len(known), "neighbours": 0, "type": 0}
    for r, p in zip(rows, polys):
        if r["h"] or p.is_empty:
            continue
        c = p.representative_point()
        hs = []
        if tree is not None:
            hs = [rows[known[i][0]]["h"] for i in tree.query(c.buffer(70.0))]
        seed = (zlib.crc32(r["id"].encode()) & 0xFFFF) / 65535.0
        if len(hs) >= 3:
            r["h"] = round(float(np.median(hs)) * (0.88 + 0.24 * seed), 1)
            filled["neighbours"] += 1
        else:
            floors = fl.get(r["code"], fl.get("default", 4))
            sm = CITY.get("small_floors")   # [footprint m2, floors]: Tokyo's and London's small lots are 2-3 storey houses
            if sm and p.area < sm[0]:
                floors = min(floors, sm[1] if p.area > sm[0] * 0.4 else max(1, sm[1] - 1))
            if p.area < 60:   # kiosks, sheds
                floors = 1
            r["h"] = round(max(3.5, floors * FLOOR_M * (0.75 + 0.5 * seed) + 1.0), 1)
            filled["type"] += 1
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return filled


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    osm_b = CITY.get("buildings") != "nyc_footprints"
    nb = 0 if osm_b else footprints()
    print(f"buildings: {nb} ({time.time() - t0:.0f}s)", flush=True)
    layers = ("roads", "areas", "rails", "nodes") + (("buildings", "parts") if osm_b else ())
    files = {k: open(os.path.join(OUT, f"{k}.ndjson"), "w") for k in layers}
    h = Handler(files, osm_buildings=osm_b)
    h.apply_file(os.path.join(D, CITY["pbf"]), locations=True, idx="flex_mem")
    for f in files.values():
        f.close()
    if osm_b:
        nb = h.n["buildings"]
        print("heights:", fill_heights(os.path.join(OUT, "buildings.ndjson"), h.parts), flush=True)
    meta = {"city": CITY_ID, "origin_latlon": ORIGIN, "bbox_latlon": BBOX, "frame": "metres, x east, y north, z up, origin " + CITY.get("spawn", [0, 0, "the city origin"])[2] if CITY_ID != "nyc" else "metres, x east, y north, z up, origin Times Square", "buildings": nb, **h.n}
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=1)
    print(meta, f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main())
