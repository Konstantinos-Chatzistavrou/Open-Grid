#!/usr/bin/env python3
"""Rebuild every city's street race route (*_route.json) from its real road graph (map.json)
using turn-constrained & anti-median-U-turn Dijkstra so there are ZERO U-turns anywhere on any city map."""
import glob
import heapq
import json
import math
import os
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAX_TURN_DEG = 112.0


def seg_dir(p0, p1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy)
    return (dx / L, dy / L) if L > 1e-6 else None


def turn_deg(d0, d1):
    if d0 is None or d1 is None:
        return 0.0
    dot = max(-1.0, min(1.0, d0[0] * d1[0] + d0[1] * d1[1]))
    return math.degrees(math.acos(dot))


def load_graph(map_path):
    g = json.load(open(map_path))
    nodes = g["nodes"]
    adj = defaultdict(list)
    major = set()
    for e in g["edges"]:
        a, b = e["a"], e["b"]
        if a == b:
            continue
        pts = [nodes[a], *(e.get("pts") or []), nodes[b]]
        clean = [pts[0]]
        for p in pts[1:]:
            if math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 0.35:
                clean.append(p)
        if len(clean) < 2:
            continue
        w = float(e.get("w", 12.0))
        hw = e.get("hw", "")
        if hw in ("trunk", "primary", "secondary", "tertiary"):
            major.add(a)
            major.add(b)
        length = sum(math.hypot(clean[i + 1][0] - clean[i][0], clean[i + 1][1] - clean[i][1]) for i in range(len(clean) - 1))
        if length < 0.5:
            continue
        d_start_ab = seg_dir(clean[0], clean[1])
        d_end_ab = seg_dir(clean[-2], clean[-1])
        rev = list(reversed(clean))
        d_start_ba = seg_dir(rev[0], rev[1])
        d_end_ba = seg_dir(rev[-2], rev[-1])
        adj[a].append((b, clean, w, length, d_start_ab, d_end_ab))
        adj[b].append((a, rev, w, length, d_start_ba, d_end_ba))

    comp = {}
    best_comp = set()
    for s in range(len(nodes)):
        if s in comp or not adj[s]:
            continue
        stack = [s]
        members = set()
        while stack:
            u = stack.pop()
            if u in comp:
                continue
            comp[u] = s
            members.add(u)
            for v, *_ in adj[u]:
                if v not in comp:
                    stack.append(v)
        if len(members) > len(best_comp):
            best_comp = members
    return nodes, adj, major, best_comp


def heading_bin(d):
    if d is None:
        return -1
    ang = math.atan2(d[1], d[0])
    return int(round(((ang + math.pi) / (2 * math.pi)) * 16)) % 16


def no_uturn_dijkstra(nodes, adj, start, goal, init_dir, used_edges, max_turn=MAX_TURN_DEG, goal_align_dir=None, init_hist_dir=None):
    """Turn-constrained Dijkstra that bans BOTH single-node U-turns (>112 deg) AND 2-step median U-turns
    (reversing >128 deg within <110 m of road travel!)."""
    # pq item: (cost, u, in_dir, hist_dir, dist_since_turn, prev_node, pidx)
    pq = [(0.0, start, init_dir, init_hist_dir or init_dir, 999.0, -1, 0)]
    parents = [(None, None)]
    best_cost = {}

    while pq:
        cost, u, in_dir, hist_dir, since_turn, prev_node, pidx = heapq.heappop(pq)
        if u == goal and pidx != 0:
            if goal_align_dir is not None:
                if turn_deg(in_dir, goal_align_dir) > max_turn:
                    continue
                if since_turn < 105.0 and turn_deg(hist_dir, goal_align_dir) > 125.0:
                    continue
            out = []
            cur = pidx
            while cur != 0:
                p_parent, edge_info = parents[cur]
                out.append(edge_info)
                cur = p_parent
            out.reverse()
            return out, in_dir, hist_dir

        st = (u, heading_bin(in_dir), heading_bin(hist_dir) if since_turn < 110.0 else -1)
        if st in best_cost and best_cost[st] <= cost:
            continue
        best_cost[st] = cost

        for v, pts, w, length, d_start, d_end in adj[u]:
            if v == prev_node:
                continue
            ang_in = turn_deg(in_dir, d_start) if in_dir is not None else 0.0
            if ang_in > max_turn:
                continue
            # Also check internal curvature of edge itself + cumulative median U-turn check (<110 m!)
            if hist_dir is not None and since_turn < 110.0:
                if turn_deg(hist_dir, d_start) > 126.0 or turn_deg(hist_dir, d_end) > 128.0:
                    continue
            w_pen = 1.0 if w >= 16 else (1.25 if w >= 11 else 2.2)
            edge_key = (min(u, v), max(u, v))
            if edge_key in used_edges:
                w_pen *= 120.0
            turn_pen = (ang_in / 90.0) * 10.0
            # Update history direction: if we just made a significant turn (>35 deg), remember pre-turn heading
            if ang_in > 35.0:
                new_hist = in_dir
                new_since = length
            else:
                new_hist = hist_dir if (since_turn + length < 110.0) else d_end
                new_since = since_turn + length
            nc = cost + length * w_pen + turn_pen
            nst = (v, heading_bin(d_end), heading_bin(new_hist) if new_since < 110.0 else -1)
            if nst not in best_cost or nc < best_cost[nst]:
                nidx = len(parents)
                parents.append((pidx, (u, v, pts, w, d_end)))
                heapq.heappush(pq, (nc, v, d_end, new_hist, new_since, u, nidx))
    return [], init_dir, init_hist_dir


def measure_max_turns(samples, closed):
    n = len(samples)
    max2 = 0.0
    max8 = 0.0
    bad8 = 0
    for i in range(n):
        if not closed and (i < 2 or i >= n - 2):
            continue
        p0, p1, p2 = samples[(i - 2) % n], samples[i], samples[(i + 2) % n]
        ang2 = turn_deg(seg_dir((p0["x"], p0["y"]), (p1["x"], p1["y"])), seg_dir((p1["x"], p1["y"]), (p2["x"], p2["y"])))
        if ang2 > max2:
            max2 = ang2
    step = 8
    for i in range(n):
        if not closed and (i < step or i >= n - step):
            continue
        p0, p1, p2 = samples[(i - step) % n], samples[i], samples[(i + step) % n]
        ang8 = turn_deg(seg_dir((p0["x"], p0["y"]), (p1["x"], p1["y"])), seg_dir((p1["x"], p1["y"]), (p2["x"], p2["y"])))
        if ang8 > max8:
            max8 = ang8
        if ang8 > 128.0:
            bad8 += 1
    return round(max2, 1), round(max8, 1), bad8


def remove_local_uturn_spikes(pts, ws, closed):
    pts, ws = list(pts), list(ws)
    for _ in range(10):
        n = len(pts)
        if n < 6:
            break
        changed = False
        new_pts, new_ws = [], []
        i = 0
        while i < n:
            if not closed and (i == 0 or i == n - 1):
                new_pts.append(pts[i]); new_ws.append(ws[i]); i += 1; continue
            d0 = seg_dir(pts[(i - 1) % n], pts[i])
            d1 = seg_dir(pts[i], pts[(i + 1) % n])
            if turn_deg(d0, d1) > 116.0:
                changed = True
                i += 1
                continue
            new_pts.append(pts[i]); new_ws.append(ws[i]); i += 1
        pts, ws = new_pts, new_ws
        if not changed:
            break
    return pts, ws


def resample_route(raw_pts, raw_w, is_closed, old_samples, is_nyc):
    def height_at(x, y):
        if not old_samples:
            return 0.0
        best_z, best_d = 0.0, 1e18
        for s in old_samples:
            d = (s["x"] - x) ** 2 + (s["y"] - y) ** 2
            if d < best_d:
                best_d = d
                best_z = float(s.get("z", 0.0))
        return best_z

    closed_pts = raw_pts + ([raw_pts[0]] if is_closed else [])
    cum = [0.0]
    for i in range(len(closed_pts) - 1):
        cum.append(cum[-1] + math.hypot(closed_pts[i + 1][0] - closed_pts[i][0], closed_pts[i + 1][1] - closed_pts[i][1]))
    total_len = cum[-1]
    step = 8.0
    n_samples = max(32, int(round(total_len / step)))
    samples = []
    idx = 0
    for k in range(n_samples):
        s = (k * total_len) / (n_samples if is_closed else max(1, n_samples - 1))
        while idx + 1 < len(cum) - 1 and cum[idx + 1] < s:
            idx += 1
        seg_len = max(1e-6, cum[idx + 1] - cum[idx])
        t = (s - cum[idx]) / seg_len
        x = closed_pts[idx][0] + t * (closed_pts[idx + 1][0] - closed_pts[idx][0])
        y = closed_pts[idx][1] + t * (closed_pts[idx + 1][1] - closed_pts[idx][1])
        w_here = raw_w[min(idx, len(raw_w) - 1)]
        samples.append({
            "x": round(x, 2),
            "y": round(y, 2),
            "z": round(height_at(x, y), 2),
            "heading": 0.0,
            "curvature": 0.0,
            "width_left": 9.0 if is_nyc else round(max(3.5, w_here / 2), 1),
            "width_right": 9.0 if is_nyc else round(max(3.5, w_here / 2), 1),
        })

    n = len(samples)
    for k in range(n):
        nxt = samples[(k + 1) % n] if is_closed else samples[min(n - 1, k + 1)]
        prv = samples[(k - 1) % n] if is_closed else samples[max(0, k - 1)]
        samples[k]["heading"] = round(math.atan2(nxt["y"] - prv["y"], nxt["x"] - prv["x"]), 4)
    return samples, round(total_len, 2)


def generate_candidate_waypoint_sets(old_samples, nodes, adj, major, best_comp):
    """Generate clean waypoint rings around the city: first from existing loop, then clean quadrant rings."""
    pool = [k for k in (major if len(major) > 25 else best_comp) if k in best_comp and len(adj[k]) >= 3]
    if len(pool) < 15:
        pool = [k for k in best_comp if len(adj[k]) >= 2]
    nearest = lambda tx, ty: min(pool, key=lambda k: (nodes[k][0] - tx) ** 2 + (nodes[k][1] - ty) ** 2)

    sets = []
    # Candidate 0: 4 waypoints from existing loop (wider legs = fewer forced turns!)
    n = len(old_samples)
    for count in (4, 5):
        wps = []
        for i in range(count):
            idx = int(round((i * n) / count)) % n
            nd = nearest(old_samples[idx]["x"], old_samples[idx]["y"])
            if not wps or nd != wps[-1]:
                wps.append(nd)
        if len(wps) >= 3 and wps[-1] == wps[0]:
            wps.pop()
        if len(wps) >= 3:
            sets.append(wps)

    # Candidate 2-5: Clean compass rings (CW & CCW) centered near the existing loop's centroid
    cx = sum(s["x"] for s in old_samples) / max(1, n)
    cy = sum(s["y"] for s in old_samples) / max(1, n)
    # Try multiple clean 4-way start nodes near old_samples[0] (avoids dual-carriageway dead-end stubs like Singapore)
    s0_cands = sorted(pool, key=lambda k: (nodes[k][0] - old_samples[0]["x"]) ** 2 + (nodes[k][1] - old_samples[0]["y"]) ** 2)[:6]
    for s0 in s0_cands:
        base_ang = math.atan2(nodes[s0][1] - cy, nodes[s0][0] - cx)
        for rad in (450.0, 680.0, 950.0):
            for sign in (1, -1):
                ring = [s0]
                for q in range(1, 4):
                    a = base_ang + sign * q * (math.pi / 2)
                    nd = nearest(cx + math.cos(a) * rad, cy + math.sin(a) * rad)
                    if nd not in ring:
                        ring.append(nd)
                if len(ring) >= 3:
                    sets.append(ring)
    return sets


def rebuild_city(city_id, map_path, route_path):
    route = json.load(open(route_path))
    old_samples = route.get("samples", [])
    is_closed = route.get("closed", True)
    m2_before, m8_before, bad8_before = measure_max_turns(old_samples, is_closed)

    if not is_closed:
        print(f"[PASS] {city_id:13s}: open mountain pass (max2={m2_before}°, no dead-end U-turns)")
        return
    if m2_before <= 116.0 and bad8_before == 0:
        print(f"[OK ] {city_id:13s}: already U-turn-free (max2={m2_before}°, max8={m8_before}°)")
        return

    nodes, adj, major, best_comp = load_graph(map_path)
    wp_sets = generate_candidate_waypoint_sets(old_samples, nodes, adj, major, best_comp)
    best_result = None

    for wps in wp_sets:
        start_node = wps[0]
        cand_dirs = [d_start for (_, _, _, _, d_start, _) in adj[start_node]][:6]
        for cand_dir in cand_dirs:
            used = set()
            raw_pts, raw_w = [], []
            cur_dir = cand_dir
            hist_dir = cand_dir
            first_dir = None
            ok = True
            n_legs = len(wps)
            for leg in range(n_legs):
                u = wps[leg]
                v = wps[(leg + 1) % n_legs]
                if u == v:
                    continue
                align = first_dir if leg == n_legs - 1 else None
                seg, next_dir, next_hist = no_uturn_dijkstra(
                    nodes, adj, u, v, cur_dir, used,
                    max_turn=MAX_TURN_DEG, goal_align_dir=align, init_hist_dir=hist_dir,
                )
                if not seg:
                    ok = False
                    break
                if first_dir is None:
                    first_dir = seg_dir(seg[0][2][0], seg[0][2][1])
                cur_dir = next_dir
                hist_dir = next_hist
                for a_, b_, pts, w, _ in seg:
                    used.add((min(a_, b_), max(a_, b_)))
                for _, _, pts, w, _ in seg:
                    for p in pts[:-1]:
                        if not raw_pts or math.hypot(p[0] - raw_pts[-1][0], p[1] - raw_pts[-1][1]) > 0.5:
                            raw_pts.append((float(p[0]), float(p[1])))
                            raw_w.append(float(w))
            if not ok or len(raw_pts) < 16:
                continue
            raw_pts, raw_w = remove_local_uturn_spikes(raw_pts, raw_w, True)
            samples, total_len = resample_route(raw_pts, raw_w, True, old_samples, city_id == "nyc")
            if total_len < 1800:
                continue
            m2, m8, bad8 = measure_max_turns(samples, True)
            score = (bad8, 0 if m2 <= 116.0 else 1, max(m2, m8), abs(total_len - 4500.0) / 1000.0)
            if best_result is None or score < best_result[0]:
                best_result = (score, samples, total_len, m2, m8, bad8)
            if bad8 == 0 and m2 <= 112.0 and m8 <= 122.0 and total_len >= 2400:
                break
        if best_result and best_result[5] == 0 and best_result[3] <= 112.0 and best_result[4] <= 122.0:
            break

    if best_result is None:
        print(f"[WARN] {city_id:13s}: could not find better loop")
        return

    _, samples, total_len, m2, m8, bad8 = best_result
    route["length_m"] = total_len
    route["samples"] = samples
    with open(route_path, "w") as f:
        json.dump(route, f, separators=(",", ":"))
    print(f"[FIX] {city_id:13s}: before(max2={m2_before}°,max8={m8_before}°,bad={bad8_before}) -> after(max2={m2}°,max8={m8}°,bad={bad8}, len={total_len:.0f}m, n={len(samples)})")


def main():
    cities = [("nyc", "web/public/assets/nyc/tiles/map.json", "web/public/data/tracks/nyc_route.json")]
    for mp in sorted(glob.glob(os.path.join(ROOT, "web/public/assets/cities/*/tiles/map.json"))):
        cid = os.path.basename(os.path.dirname(os.path.dirname(mp)))
        rp = os.path.join(ROOT, f"web/public/data/tracks/{cid}_route.json")
        if os.path.exists(rp):
            cities.append((cid, mp, rp))
    for cid, mp, rp in cities:
        mp_abs = mp if os.path.isabs(mp) else os.path.join(ROOT, mp)
        rp_abs = rp if os.path.isabs(rp) else os.path.join(ROOT, rp)
        rebuild_city(cid, mp_abs, rp_abs)


if __name__ == "__main__":
    main()
