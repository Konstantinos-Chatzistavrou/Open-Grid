# OpenGrid Car Modding Pipeline

OpenGrid is designed so community modders can add complete cars—with realistic physics, destructible panels, and custom aftermarket parts—**without modifying a single line of C++ or TypeScript**.

## 1. Required Files per Car Mod

Every car consists of three engine-agnostic files that work identically in the WebGPU client and the Unreal Engine 5 plugin:

| File | Purpose |
|---|---|
| `data/cars/<car_id>.json` | Physics specification (`schema: "car/1"`): mass, CG, inertia, Pacejka MF 6.2 tires, suspension rates/kinematics, torque curve, gearbox ratios, aero CdA/ClA (optional `aero.drs` / `aero.airbrake` booleans, default false: only a car with a real active rear wing sets them). |
| `data/cars/<car_id>.visual.json` | Visual & hitbox contract: `.glb` path, collision box (`size_m`, `centre_in_model_m`), wheel node names, headlight/taillight slots, driver seat coordinates. |
| `web/public/assets/cars/v3/<car_id>.glb` | Clean triangulated glTF/GLB mesh (real-world metres, `+Z` forward, `+Y` up) with standard material slots (`paint_body`, `glass`, `trim_dark`, `chrome`, `caliper`). |

Register the car by adding one entry to `data/cars/catalog.json`.

## 2. Optional Meshlet Optimization (Nanite-Style Culling)

For high-poly community cars (50k–250k triangles), run the offline meshoptimizer meshlet pipeline before publishing:

```bash
cd web
npx tsx ../tools/meshlets/batch.ts --input ../assets_source/cars/<car_id>.glb --out public/assets/meshlets/<car_id>
```

## 3. Custom Parts & Body Kits

Drop replacement bumpers, hoods, fenders, wings, rims, splitters, diffusers, and exhausts into the car's mesh kit using matching pivot coordinates (`stock` = factory panel). Part aerodynamic and mass deltas are measured automatically and shown live in the Garage telemetry bars.

## 4. Legal & IP Guidelines

- **Do not** extract, convert, or redistribute meshes, JBeam files, textures, or audio from BeamNG.drive, Forza, Gran Turismo, or any other commercial game.
- **Debranding**: Remove OEM badges and avoid patented iconic body contours; prefer original fictional silhouettes and generic OEM+ tuning names (e.g., *Twin-Turbo V8*, *Forged 5-Spoke*, *Carbon Ducktail*).
