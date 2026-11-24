#!/usr/bin/env node
// Validate the imported physics reference data (data/reference/chrono/*.json).
// Checks schema, units and physical plausibility so a bad import fails CI instead of silently skewing handling.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'data/reference/chrono';
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };
const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
if (!files.length) problems.push(`no reference JSON in ${dir}`);

for (const f of files) {
  const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const where = `${f}`;
  check(p.schema === 'opengrid.physics-reference/1', `${where}: schema must be opengrid.physics-reference/1`);
  check(typeof p.id === 'string' && p.id.length > 0, `${where}: id missing`);
  check(isPos(p.mass_kg), `${where}: mass_kg must be a positive number`);
  check(Array.isArray(p.inertia_kgm2) && p.inertia_kgm2.length === 3, `${where}: inertia must be [Ixx,Iyy,Izz]`);
  if (Array.isArray(p.inertia_kgm2) && p.inertia_kgm2.length === 3) {
    const [a, b, c] = p.inertia_kgm2;
    check([a, b, c].every(isPos), `${where}: inertia entries must be positive`);
    // principal moments of a rigid body obey the triangle inequality
    check(a <= b + c && b <= a + c && c <= a + b, `${where}: inertia violates the triangle inequality (unphysical)`);
  }
  check(Array.isArray(p.cg_m) && p.cg_m.length === 3, `${where}: cg_m must be 3 numbers`);
  check(isPos(p.wheelbase_m), `${where}: wheelbase_m must be positive`);
  check(p.wheels && p.wheels.count === 4, `${where}: wheels.count must be 4`);
  if (p.wheels) {
    check(isPos(p.wheels.mass_kg), `${where}: wheel mass must be positive`);
    check(Array.isArray(p.wheels.inertia_kgm2) && p.wheels.inertia_kgm2.every(isPos), `${where}: wheel inertia invalid`);
  }
  check(p.tire && isPos(p.tire.unloaded_radius_m), `${where}: tire.unloaded_radius_m must be positive`);
  if (p.tire && isPos(p.tire.unloaded_radius_m) && isPos(p.wheels?.radius_m)) {
    check(Math.abs(p.tire.unloaded_radius_m - p.wheels.radius_m) < 0.06, `${where}: tyre and wheel radius disagree by > 60 mm`);
  }
  if (p.engine?.full_load_torque_nm) {
    const pts = p.engine.full_load_torque_nm;
    check(Array.isArray(pts) && pts.length >= 5, `${where}: torque curve too short`);
    for (let i = 0; i < pts.length; i++) {
      check(Array.isArray(pts[i]) && pts[i].length === 2 && Number.isFinite(pts[i][0]) && Number.isFinite(pts[i][1]), `${where}: torque point ${i} malformed`);
      if (i) check(pts[i][0] > pts[i - 1][0], `${where}: torque RPM must increase monotonically`);
    }
    check(isPos(p.engine.max_rpm) && p.engine.max_rpm >= pts[pts.length - 1][0], `${where}: max_rpm below the last curve point`);
  }
  check(p.provenance && p.provenance.license === 'BSD-3-Clause', `${where}: provenance.license must be BSD-3-Clause`);
  check(p.provenance && /^[0-9a-f]{40}$/.test(p.provenance.commit || ''), `${where}: provenance.commit must be a full 40-char SHA`);
  check(p.provenance && /^https:\/\//.test(p.provenance.url || ''), `${where}: provenance.url missing`);
  if (!problems.some((m) => m.startsWith(where))) console.log(`[PASS] ${where} (${p.name})`);
}

if (problems.length) {
  for (const m of problems) console.error(`[FAIL] ${m}`);
  console.error(`\n${problems.length} problem(s) in ${files.length} reference file(s)`);
  process.exit(1);
}
console.log(`Physics reference data OK: ${files.length} files`);
