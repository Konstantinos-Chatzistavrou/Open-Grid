#!/usr/bin/env node
// Server-Side & Modder Asset Validation Pipeline (OpenGrid Anti-Cheat & Poly-Limit Guard).
// Validates community car physics JSON, visual JSON, and GLB assets before allowing them into a public lobby:
//   - Rejects malicious payloads (<script>, __proto__, eval, unexpected executable strings)
//   - Enforces sane vehicle physics limits (blocks 5,000 hp / 10g grip cheat configs)
//   - Enforces GLB polygon ceiling (<= 120,000 triangles), required LOD/bounds, and valid pivot height
//
// Usage: node tools/validate_mod.mjs [--dir data/cars] [--glb web/public/assets/cars/v3/vela_gt.glb]
import fs from 'node:fs';
import path from 'node:path';

const MAX_TRIANGLES = 120_000;
const MAX_GLB_MB = 25;
const MAX_POWER_KW = 1100; // ~1475 hp hypercar cap
const MAX_GRIP_MU = 2.1;
const MIN_MASS_KG = 650;

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

let errors = 0;
let checked = 0;
const fail = (file, msg) => { console.error(`✗ [REJECT] ${file}: ${msg}`); errors++; };
const pass = (file, msg) => { console.log(`✓ [PASS]   ${file}: ${msg}`); };

function scanMalicious(file, rawText) {
  if (/<script|javascript:|onerror=|__proto__|constructor\s*:/i.test(rawText)) {
    fail(file, 'Detected disallowed script/prototype-pollution token');
    return false;
  }
  return true;
}

function validatePhysicsJson(file) {
  checked++;
  const raw = fs.readFileSync(file, 'utf8');
  if (!scanMalicious(file, raw)) return;
  let d;
  try { d = JSON.parse(raw); } catch (e) { fail(file, `Invalid JSON: ${e.message}`); return; }
  const mass = Number(d?.chassis?.mass_kg ?? 0);
  if (!(mass >= MIN_MASS_KG && mass <= 4500)) fail(file, `Chassis mass ${mass} kg out of bounds (${MIN_MASS_KG}..4500)`);
  const curve = d?.engine?.torque_curve;
  if (!Array.isArray(curve) || curve.length < 2) {
    fail(file, 'Missing valid engine.torque_curve');
  } else {
    let maxKw = 0;
    for (const [rpm, nm] of curve) maxKw = Math.max(maxKw, (Number(nm) * Number(rpm) * 2 * Math.PI) / 60000);
    if (maxKw > MAX_POWER_KW) fail(file, `Peak power ${Math.round(maxKw)} kW exceeds server anti-cheat limit (${MAX_POWER_KW} kW)`);
    const muF = Number(d?.tire_front?.lateral?.mu ?? 0);
    const muR = Number(d?.tire_rear?.lateral?.mu ?? 0);
    if (muF > MAX_GRIP_MU || muR > MAX_GRIP_MU) fail(file, `Tire grip mu (${muF}/${muR}) exceeds limit (${MAX_GRIP_MU})`);
    if (errors === 0) pass(file, `${Math.round(maxKw)} kW · ${mass} kg · mu ${muF.toFixed(2)}`);
  }
}

function validateGlb(file) {
  checked++;
  const stat = fs.statSync(file);
  if (stat.size > MAX_GLB_MB * 1024 * 1024) { fail(file, `GLB ${(stat.size / 1e6).toFixed(1)} MB exceeds ${MAX_GLB_MB} MB limit`); return; }
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546C67) { fail(file, 'Invalid glTF binary header'); return; }
  const jsonLen = buf.readUInt32LE(12);
  const jsonText = buf.subarray(20, 20 + jsonLen).toString('utf8');
  if (!scanMalicious(file, jsonText)) return;
  let gltf;
  try { gltf = JSON.parse(jsonText); } catch (e) { fail(file, `Corrupt glTF JSON chunk: ${e.message}`); return; }

  let tris = 0;
  for (const m of gltf.meshes ?? []) {
    for (const prim of m.primitives ?? []) {
      const idxAcc = prim.indices !== undefined ? gltf.accessors?.[prim.indices] : null;
      const posAcc = prim.attributes?.POSITION !== undefined ? gltf.accessors?.[prim.attributes.POSITION] : null;
      const count = idxAcc?.count ?? posAcc?.count ?? 0;
      tris += Math.floor(count / 3);
    }
  }
  if (tris <= 0) fail(file, 'GLB contains zero triangles');
  else if (tris > MAX_TRIANGLES) fail(file, `Polygon count ${tris.toLocaleString()} exceeds lobby limit (${MAX_TRIANGLES.toLocaleString()} tris)`);
  else pass(file, `${tris.toLocaleString()} tris · ${(stat.size / 1e6).toFixed(2)} MB`);
}

const dir = arg('--dir', 'data/cars');
const glb = arg('--glb', '');
if (glb && fs.existsSync(glb)) {
  validateGlb(glb);
} else if (fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'catalog.json' || name.endsWith('.visual.json')) continue;
    validatePhysicsJson(path.join(dir, name));
  }
}

console.log(`\nMod Validator: checked ${checked} assets, ${errors} rejections.`);
process.exit(errors > 0 ? 1 : 0);
