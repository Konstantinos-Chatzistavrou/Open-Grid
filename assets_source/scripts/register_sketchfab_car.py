#!/usr/bin/env python3
"""Register a car built by sketchfab_build.py in the game (docs/adding_a_car.md):
  - GLB: dedup, prune, WebP textures (EXT_texture_webp), meshopt -> web/public/assets/cars/v5/<id>_hero.glb
  - data/cars/<id>.json: physics = a base car's file with this car's own numbers (assets_source/cars/<id>.json "game":
    mass, weight split, power, redline, layout, aero) and the model's measured wheelbase, track and tyre radii
  - data/cars/<id>.visual.json, a catalog entry, and the CREDITS line is printed for CREDITS.md.

    python3 assets_source/scripts/register_sketchfab_car.py <id> <raw.glb> <info.json>
Needs npx (gltf-transform). Repo root = two levels above this file."""
import copy, json, os, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
cid, raw, info_path = sys.argv[1:4]
cfg = json.load(open(f"{ROOT}/assets_source/cars/{cid}.json"))
G = cfg["game"]
info = json.load(open(info_path))
h = info["hubs_blender"]

# 1. GLB
out = os.path.join(ROOT, "web/public/assets/cars/v5"); os.makedirs(out, exist_ok=True)
tmp = tempfile.mkdtemp(); g = ["npx", "-y", "@gltf-transform/cli@4.5.1"]
for step, a, b, extra in (("dedup", raw, "a", []), ("prune", "a", "b", []), ("webp", "b", "c", ["--quality", "88"]),
                          ("meshopt", "c", None, ["--level", "high"])):
    src = a if a == raw else f"{tmp}/{a}.glb"
    dst = f"{out}/{cid}_hero.glb" if b is None else f"{tmp}/{b}.glb"
    r = subprocess.run(g + [step, src, dst] + extra, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"{step} failed: {r.stderr[-400:]}")

# 2. physics (Blender: front = -Y; game model space: +Z forward, +X left)
zF = -(h["FL"][1] + h["FR"][1]) / 2; zR = -(h["RL"][1] + h["RR"][1]) / 2; wb = zF - zR
trackF = h["FL"][0] - h["FR"][0]; trackR = h["RL"][0] - h["RR"][0]
phys = json.load(open(f"{ROOT}/data/cars/{G['base']}.json"))
phys["name"] = G["name"]
phys["notes"] = (f"{G['name']}: {G['base']} suspension and tyre model with this car's own mass, weight split, engine and aero; "
                 f"wheelbase, track and tyre radii measured on the model ({cfg['source']}). Starting values: tune with feel.")
ch = phys["chassis"]
m0 = ch["mass_kg"]; ch["mass_kg"] = G["mass_kg"]
for k in ("inertia_roll_kgm2", "inertia_pitch_kgm2", "inertia_yaw_kgm2"):
    ch[k] = round(ch[k] * G["mass_kg"] / m0 * (wb / ch["wheelbase_m"]) ** (2 if k != "inertia_roll_kgm2" else 0))
ch["wheelbase_m"] = round(wb, 3); ch["weight_front"] = G["weight_front"]; ch["cg_height_m"] = G.get("cg_height_m", ch["cg_height_m"])
phys["front_axle"]["track_m"] = round(trackF, 3); phys["rear_axle"]["track_m"] = round(trackR, 3)
phys["tire_front"]["radius_m"] = round(info["tyre_radius"], 3); phys["tire_rear"]["radius_m"] = round(info.get("tyre_radius_rear", info["tyre_radius"]), 3)
e = phys["engine"]
k = G["torque_scale"]; red = G.get("redline_rpm", e["redline_rpm"])
curve = [[r, round(t * k)] for r, t in e["torque_curve"] if r <= red]
if curve[-1][0] < red:   # stretch the top of the curve to the new redline
    curve.append([red, round(curve[-1][1] * 0.86)])
e["torque_curve"] = curve; e["redline_rpm"] = red
d = phys["drivetrain"]
d["layout"] = G.get("layout", d["layout"]); d["final_drive"] = G.get("final_drive", d["final_drive"])
d["clutch_max_torque_nm"] = round(max(t for _, t in curve) * 1.6)
if d["layout"] == "awd":
    d["awd_front_split"] = G.get("awd_front_split", 0.4)
    d["front_diff"] = {"type": "open"}; d["centre_diff"] = {"type": "lsd", "preload_nm": 40, "power_ramp": 0.3, "coast_ramp": 0.15}
    d.setdefault("rear_diff", {"type": "lsd", "preload_nm": 60, "power_ramp": 0.35, "coast_ramp": 0.2})
for kk, v in G.get("aero", {}).items():
    phys["aero"][kk] = v
json.dump(phys, open(f"{ROOT}/data/cars/{cid}.json", "w"), indent=2)

# 3. visual config
wf = ch["weight_front"]; cgz = zF - wb * (1 - wf)
L = info["length"]; half = abs(h["FL"][0])
bx = info["body_x"]; width = bx[1] - bx[0]
vis = json.load(open(f"{ROOT}/data/cars/vela_gt.visual.json"))
vis.update({
    "name": G["name"], "physics": f"cars/{cid}.json", "model": f"res://assets/cars/v5/{cid}_hero.glb",
    "notes": f"Derived from {cfg['source']} (CREDITS.md): badges, plates and lettering removed, renamed. Model space +X left, +Y up, +Z forward, origin on the ground at the body length centre. Front axle z {zF:.3f}, rear {zR:.3f} (wheelbase {wb:.3f}), model track {trackF:.3f} / {trackR:.3f}.",
    "wheel_nodes": {"fl": "wheel_FL", "fr": "wheel_FR", "rl": "wheel_RL", "rr": "wheel_RR"},
    "cg_in_model_m": [0.0, round(ch["cg_height_m"] + 0.04, 3), round(cgz, 3)],
    "wheel_visual_offset_m": 0.0,
    "collision_box": {"size_m": [round(min(width, 2.05) - 0.05, 2), 0.72, round(L - 0.05, 2)], "centre_in_model_m": [0.0, 0.72, 0.0],
                      "end_lift_m": 0.13, "end_lift_start_m": round(L / 2 - 0.6, 2),
                      "note": f"body {width:.2f} x {info['body_z_max']:.2f} x {L:.2f} m; flat underside, rising to each end; wheels are raycasts"},
    "paint_material": "paint", "default_paint": G["default_paint"],
    "headlights": [[-0.6, 0.55, round(L / 2 - 0.35, 2)], [0.6, 0.55, round(L / 2 - 0.35, 2)]],
    "panels": {"front": ["body"] + (["beam_L", "beam_R"] if G.get("beams") else []), "rear": ["taillight_bar"] if G.get("tail") else [], "left": [], "right": []},
    "detachable": {},
    "front_lights": ["beam_L", "beam_R"] if G.get("beams") else [], "rear_lights": ["taillight_bar"] if G.get("tail") else [],
    "engine_smoke_in_model_m": [0.0, 0.7, round((L / 2 - 0.7) * (1 if G.get("engine", "front") == "front" else -1), 2)],
    "lod_model": "res://assets/cars/v3/vela_gt_traffic.glb", "lod_distance_m": 30.0,
    "driver_seat_m": [0.37, 0.3, G.get("seat_z", 0.0)], "driver_scale": 1,
})
for kk in ("hood_skin", "bumper_shells"):
    vis.pop(kk, None)
json.dump(vis, open(f"{ROOT}/data/cars/{cid}.visual.json", "w"), indent=2)

# 4. catalog
cat = json.load(open(f"{ROOT}/data/cars/catalog.json"))
entry = {"id": cid, "price": G["price"], "name": G["name"], "tag": G["tag"], "physics": f"cars/{cid}.json", "visual": f"cars/{cid}.visual.json", "paint": G["paint"]}
cat["cars"] = [c for c in cat["cars"] if c["id"] != cid] + [entry]
json.dump(cat, open(f"{ROOT}/data/cars/catalog.json", "w"), indent=2)
pk = max(t for _, t in curve)
print(f"registered {cid}: wheelbase {wb:.3f}, track {trackF:.3f}/{trackR:.3f}, tyres {info['tyre_radius']}/{info.get('tyre_radius_rear')}, "
      f"peak torque {pk} Nm, glb {os.path.getsize(f'{out}/{cid}_hero.glb') // 1024} KB")
