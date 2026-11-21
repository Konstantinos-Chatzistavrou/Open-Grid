#!/usr/bin/env python3
"""Cut a box out of a big OSM extract (e.g. Geofabrik's greece-latest.osm.pbf) into a small .osm.pbf the city pipeline can
read in seconds (extract.py keeps every node location in memory: a country file is too big for the laptop).

    python3 tools/nyc/cut_pbf.py <in.osm.pbf> <out.osm.pbf> <south> <west> <north> <east>

"Complete ways" strategy (like `osmium extract -s complete_ways`): every node inside the box, every way with a node inside
it (with all of its nodes, also those outside), every relation with a member inside it, and the members of those relations
(so a multipolygon or a coastline crossing the box edge stays whole). Data licence: ODbL (OpenStreetMap contributors).
"""
import os
import sys
import time

import osmium


def cut(src, dst, s, w, n, e):
    t0 = time.time()
    tr = osmium.IdTracker()
    nodes = 0
    for o in osmium.FileProcessor(src, osmium.osm.NODE):
        loc = o.location
        if loc.valid() and s <= loc.lat <= n and w <= loc.lon <= e:
            tr.add_node(o.id); nodes += 1
    print(f"nodes in the box: {nodes} ({time.time() - t0:.0f}s)", flush=True)
    ways = 0
    for o in osmium.FileProcessor(src, osmium.osm.WAY):
        if tr.contains_any_references(o):
            tr.add_way(o.id); ways += 1
    rels = 0
    for o in osmium.FileProcessor(src, osmium.osm.RELATION):
        if tr.contains_any_references(o):
            tr.add_relation(o.id); rels += 1
    print(f"ways {ways}, relations {rels} ({time.time() - t0:.0f}s)", flush=True)
    tr.complete_backward_references(src, relation_depth=1)     # members of the relations, nodes of every way
    if os.path.exists(dst):
        os.remove(dst)
    with osmium.SimpleWriter(dst) as wr:
        for o in osmium.FileProcessor(src).with_filter(tr.id_filter()):
            wr.add(o)
    print(f"wrote {dst}: {os.path.getsize(dst) / 1e6:.1f} MB ({time.time() - t0:.0f}s)", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 7:
        sys.exit(__doc__)
    cut(sys.argv[1], sys.argv[2], *map(float, sys.argv[3:]))
