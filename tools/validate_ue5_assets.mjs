#!/usr/bin/env node
// validate_ue5_assets.mjs - Audits all cars, physics/visual JSONs, paint finishes, and textures
// for Unreal Engine 5 import readiness (material slots, UVs, wheel nodes, polycount, schema parity).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function parseGlbJson(filePath) {
  const buf = readFileSync(filePath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
}

let errors = 0;
const warnings = [];
const fail = (msg) => { console.error(`  [FAIL] ${msg}`); errors++; };
const warn = (msg) => { console.warn(`  [WARN] ${msg}`); warnings.push(msg); };

console.log('=== OpenGrid UE5 Asset & Data Readiness Audit ===\n');

// 1. Validate shared paint finishes & baked RGBA dirt texture
const paintJsonPath = resolve('data/materials/car_paint_finishes.json');
if (!existsSync(paintJsonPath)) fail('Missing data/materials/car_paint_finishes.json');
else {
  const pf = JSON.parse(readFileSync(paintJsonPath, 'utf8'));
  const names = Object.keys(pf.finishes ?? {});
  console.log(`Paint finishes (${names.length}): ${names.join(', ')}`);
  for (const key of ['source_asset', 'web_asset']) {
    const p = resolve(pf.dirt_mask_texture[key]);
    if (!existsSync(p)) fail(`Missing dirt mask texture: ${pf.dirt_mask_texture[key]}`);
    else console.log(`  dirt mask [${key}]: ${(statSync(p).size / 1024).toFixed(1)} KB OK`);
  }
}

// 2. Validate every car in catalog.json
const catalog = JSON.parse(readFileSync(resolve('data/cars/catalog.json'), 'utf8'));
console.log(`\nCatalog cars (${catalog.cars.length}):`);
for (const entry of catalog.cars) {
  const physPath = resolve('data', entry.physics);
  const visRel = entry.visual ?? 'cars/vela_gt.visual.json';
  const visPath = resolve('data', visRel);
  if (!existsSync(physPath)) { fail(`${entry.id}: missing physics ${entry.physics}`); continue; }
  if (!existsSync(visPath)) { fail(`${entry.id}: missing visual ${visRel}`); continue; }

  const phys = JSON.parse(readFileSync(physPath, 'utf8'));
  const vis = JSON.parse(readFileSync(visPath, 'utf8'));
  const glbRel = vis.model.replace(/^res:\/\//, 'web/public/');
  const glbPath = resolve(glbRel);
  if (!existsSync(glbPath)) { fail(`${entry.id}: missing GLB ${glbRel}`); continue; }

  const gltf = parseGlbJson(glbPath);
  const nodeNames = new Set((gltf.nodes ?? []).map((n) => n.name));
  const matNames = (gltf.materials ?? []).map((m) => m.name);

  // Check wheel nodes
  const wheels = Object.values(vis.wheel_nodes ?? {});
  const missingWheels = wheels.filter((w) => !nodeNames.has(w));
  if (missingWheels.length) fail(`${entry.id}: missing wheel nodes in GLB: ${missingWheels.join(', ')}`);

  // Check paint material & UV / normal map readiness for UE5
  const paintIdx = matNames.indexOf(vis.paint_material);
  if (paintIdx < 0) fail(`${entry.id}: paint_material "${vis.paint_material}" not found in GLB`);

  let tris = 0;
  let paintPrims = 0;
  let paintHasUv = 0;
  let paintHasTangent = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const idxAcc = prim.indices !== undefined ? gltf.accessors[prim.indices] : gltf.accessors[prim.attributes.POSITION];
      if (idxAcc) tris += Math.floor(idxAcc.count / 3);
      if (prim.material === paintIdx) {
        paintPrims++;
        if (prim.attributes?.TEXCOORD_0 !== undefined) paintHasUv++;
        if (prim.attributes?.TANGENT !== undefined) paintHasTangent++;
      }
    }
  }

  const sizeMB = (statSync(glbPath).size / 1048576).toFixed(2);
  console.log(
    `  ${entry.id.padEnd(13)} | ${String(tris).padStart(7)} tris | ${sizeMB} MB | ` +
    `mass ${phys.chassis.mass_kg} kg | mats ${matNames.length} | paintUV ${paintHasUv}/${paintPrims}`,
  );
  if (paintPrims > 0 && paintHasUv < paintPrims) {
    warn(`${entry.id}: paint primitives missing TEXCOORD_0 (${paintHasUv}/${paintPrims}) -> UE5 triplanar/model-space mask works, bake UVs before authoring panel-gap normal maps`);
  }
  if (paintPrims > 0 && paintHasTangent === 0) {
    warn(`${entry.id}: paint has no exported TANGENT attribute (UE5 will compute MikkTSpace tangents on import if UVs exist)`);
  }
}

console.log(`\nSummary: ${errors} error(s), ${warnings.length} UE5 import advisory note(s).`);
process.exit(errors > 0 ? 1 : 0);
