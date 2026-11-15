#!/usr/bin/env python3
"""The built extent of a city in the game frame.

New York (mask "manhattan"): Manhattan's outline (NYC Open Data borough boundaries, public domain, dataset gthc-hcne) ->
derived/manhattan_mask.json (list of polygons, each a list of rings [[x,y],..]). Used to drop Brooklyn/Queens/New Jersey
data that the bbox picks up, and as the world extent: the shore is the edge of the drivable world.

Area cities (mask "area", CITY=london ...): the city's `area` box (cities.json) -> derived/drive.json (the drivable box,
one ring) and derived/mask.json (that box grown by FRINGE m: real buildings and streets stand behind the barriers at the
city limit, so the edge reads as a closed road, not the end of the world)."""
import json, os, sys, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
from extract import D, OUT, xy
from tilelib import CITY, FRINGE

os.makedirs(OUT, exist_ok=True)
if CITY.get("mask") == "manhattan":
    raw = os.path.join(D, "manhattan_boundary.json")
    if not os.path.exists(raw):
        url = "https://data.cityofnewyork.us/resource/gthc-hcne.json?$where=" + urllib.parse.quote("borocode='1'")
        open(raw, "wb").write(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "OpenGrid/1.0"}), timeout=120).read())
    g = json.load(open(raw))[0]["the_geom"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    mask = [[xy([p[0] for p in r], [p[1] for p in r]) for r in poly] for poly in polys]
    json.dump(mask, open(os.path.join(OUT, "manhattan_mask.json"), "w"))
else:
    from shapely.geometry import Polygon
    s, w, n, e = CITY["area"]
    ring = xy([w, e, e, w, w], [s, s, n, n, s])
    drive = Polygon(ring)
    json.dump([[round(x, 2), round(y, 2)] for x, y in drive.exterior.coords], open(os.path.join(OUT, "drive.json"), "w"))
    grown = drive.buffer(FRINGE, join_style=2)
    mask = [[[[round(x, 2), round(y, 2)] for x, y in grown.exterior.coords]]]
    json.dump(mask, open(os.path.join(OUT, "mask.json"), "w"))
xs = [p[0] for poly in mask for r in poly for p in r]; ys = [p[1] for poly in mask for r in poly for p in r]
print("polygons", len(mask), "extent x", round(min(xs)), round(max(xs)), "y", round(min(ys)), round(max(ys)), "(metres from the origin)")
