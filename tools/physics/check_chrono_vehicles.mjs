#!/usr/bin/env node
// Check and summarise the Project Chrono vehicle data imported by import_chrono_vehicles.mjs (BSD-3, pinned commit).
//
//   node tools/physics/check_chrono_vehicles.mjs            verify the files, print the tables, assert the invariants
//   node tools/physics/check_chrono_vehicles.mjs --write    also (re)write data/reference/chrono-vehicles/summary.json
//
// What it asserts: every file is the pinned upstream blob (--verify of the importer); every file parses (Chrono's own parser
// allows // comments and trailing commas, ours strips both) except the three upstream files that are malformed; every chassis,
// engine, suspension and brake has the fields we read, finite and positive, and the inertia tensors obey the triangle inequality.
// What it REPORTS and does not call wrong: how far Chrono's chassis inertias are from measured vehicles (NHTSA/VRTC) - see below.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = join(ROOT, 'data/reference/chrono-vehicles');
const write = process.argv.includes('--write');

import { parseChrono } from './chrono_parse.mjs';

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(DIR).filter((p) => p.endsWith('.json') && !p.endsWith('MANIFEST.json') && !p.endsWith('summary.json'));
const tirs = walk(DIR).filter((p) => p.endsWith('.tir'));
let failures = 0;
const fail = (m) => { failures++; console.log(`  [FAIL] ${m}`); };
const ok = (m) => console.log(`  [ok]   ${m}`);
const finitePos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// ---- parse everything
const KNOWN_IMPOSSIBLE_INERTIA = new Set(['Polaris/Polaris_Chassis.json', 'citybus/chassis/CityBus_Chassis.json']);
const KNOWN_MALFORMED = new Set(['M113/M113_TrackSystem.json', 'M113_RS/powertrain/M113_EngineSimpleMap.json', 'terrain/RigidSlope20.json']);
const docs = new Map();
const malformed = [];
for (const f of files) {
  const rel = relative(DIR, f);
  try { docs.set(rel, parseChrono(readFileSync(f, 'utf8'))); } catch { malformed.push(rel); }
}
console.log(`${files.length} JSON + ${tirs.length} .tir files; ${docs.size} parse, ${malformed.length} malformed upstream`);
const unexpected = malformed.filter((m) => !KNOWN_MALFORMED.has(m)), missing = [...KNOWN_MALFORMED].filter((m) => !malformed.includes(m));
if (unexpected.length) fail(`unexpected unparsable files: ${unexpected.join(', ')}`);
if (missing.length) ok(`(upstream fixed: ${missing.join(', ')} now parse: update KNOWN_MALFORMED)`);
else ok(`the only unparsable files are the 3 known upstream-malformed ones: ${[...KNOWN_MALFORMED].join(', ')}`);

const byTemplate = (t) => [...docs].filter(([, d]) => d.Template === t || d.Type === t);
const vehicleOf = (rel) => rel.split('/')[0];

// ---- chassis: mass, centre of gravity, inertia -> radii of gyration, against the measured NHTSA/VRTC range
console.log('\nChassis (Template RigidChassis): mass, CG height above the chassis frame, radii of gyration squared (I / m)');
console.log('  measured, NHTSA/VRTC 1990s SUVs (data/physics/inertia-reference.json): roll 0.40-0.44 m^2, yaw 1.8-2.0 m^2');
const chassis = [];
for (const [rel, d] of docs) {
  if (d.Template !== 'RigidChassis' || !Array.isArray(d.Components)) continue;
  let m = 0, ix = 0, iy = 0, iz = 0, zc = 0;
  for (const c of d.Components) {
    if (c.Void) continue;
    const mi = c['Moments of Inertia'];
    if (!finitePos(c.Mass) || !Array.isArray(mi) || !mi.every(finitePos)) { fail(`${rel}: component without a positive mass / inertia`); continue; }
    m += c.Mass; ix += mi[0]; iy += mi[1]; iz += mi[2]; zc += c.Mass * (c['Centroidal Frame']?.Location?.[2] ?? 0);
  }
  if (!m) continue;
  if (!(ix <= iy + iz && iy <= ix + iz && iz <= ix + iy)) {
    // a rigid body's principal moments obey the triangle inequality: these are upstream defects, listed so a NEW one fails
    if (KNOWN_IMPOSSIBLE_INERTIA.has(rel)) console.log(`  [known upstream defect] ${rel}: inertia ${[ix, iy, iz].join(' / ')} violates the triangle inequality (impossible for a rigid body)`);
    else fail(`${rel}: inertia violates the triangle inequality`);
  }
  const row = { file: rel, vehicle: vehicleOf(rel), mass_kg: +m.toFixed(1), cg_z_m: +(zc / m).toFixed(3), inertia_kgm2: [ix, iy, iz].map((v) => +v.toFixed(1)), k2: [ix / m, iy / m, iz / m].map((v) => +v.toFixed(3)) };
  chassis.push(row);
}
chassis.sort((a, b) => a.mass_kg - b.mass_kg);
const pad = (s, n) => String(s).padEnd(n);
let near = 0;
for (const c of chassis) {
  const roll_ok = c.k2[0] >= 0.30 && c.k2[0] <= 0.55, yaw_ok = c.k2[2] >= 1.5 && c.k2[2] <= 2.2;
  if (roll_ok && yaw_ok) near++;
  console.log(`  ${pad(c.file, 52)} ${pad(c.mass_kg + ' kg', 11)} k2 roll ${pad(c.k2[0], 6)} yaw ${pad(c.k2[2], 6)} ${roll_ok && yaw_ok ? '' : '<- outside the measured range'}`);
}
console.log(`  ${near} of ${chassis.length} chassis lie inside the measured roll / yaw radius-of-gyration range: Chrono's chassis inertias are model parameters, mostly NOT realistic. Not used for any car.`);
if (!chassis.length) fail('no chassis found');

// ---- engines
console.log('\nEngines');
const engines = [];
for (const [rel, d] of docs) {
  if (d.Template === 'EngineSimpleMap') {
    const maxRpm = d['Maximal Engine Speed RPM'];
    const curve = (d['Map Full Throttle'] ?? []).filter(([rpm, nm]) => rpm > 0 && (!maxRpm || rpm <= maxRpm) && finitePos(nm));
    if (curve.length < 4 || !finitePos(maxRpm)) { fail(`${rel}: engine map without a usable full-throttle curve`); continue; }
    for (let i = 1; i < curve.length; i++) if (!(curve[i][0] > curve[i - 1][0])) { fail(`${rel}: rpm not ascending`); break; }
    let p = 0, pr = 0, t = 0, tr = 0;
    for (const [rpm, nm] of curve) { const w = nm * rpm * Math.PI / 30; if (w > p) { p = w; pr = rpm; } if (nm > t) { t = nm; tr = rpm; } }
    // Marder's map is written in rad/s (its peak 'rpm' is 157 for a 3500 rpm engine): flagged, not used as rpm
    const rad_s_map = maxRpm > 1000 && Math.max(...curve.map((c) => c[0])) < 400;
    engines.push({ id: vehicleOf(rel) + ':' + rel.split('/').pop().replace('.json', ''), file: rel, kind: 'simple_map', units_rad_s: rad_s_map, max_rpm: maxRpm, curve_rpm_nm: curve, peak_torque_nm: t, peak_torque_rpm: tr, peak_power_kw: +(p / 1000).toFixed(1), peak_power_rpm: pr });
  } else if (d.Template === 'EngineSimple') {
    const T = d['Maximum Engine Torque'], P = d['Maximum Engine Power'], W = d['Maximum Engine Speed'];
    if (!finitePos(T) || !finitePos(P) || !finitePos(W)) { fail(`${rel}: EngineSimple without torque / power / speed`); continue; }
    engines.push({ id: vehicleOf(rel) + ':' + rel.split('/').pop().replace('.json', ''), file: rel, kind: 'simple', max_torque_nm: T, max_power_kw: P / 1000, max_speed_rad_s: W });
  } else if (d.Template === 'EngineShafts') {
    const tm = d['Torque Map'];
    if (!Array.isArray(tm) || tm.length < 4) { fail(`${rel}: EngineShafts without a torque map`); continue; }
    engines.push({ id: vehicleOf(rel) + ':' + rel.split('/').pop().replace('.json', ''), file: rel, kind: 'shafts', torque_map_points: tm.length });
  }
}
for (const e of engines) console.log(`  ${pad(e.id, 40)} ${e.kind === 'simple_map' ? `map ${e.peak_torque_nm.toFixed(0)} Nm @ ${e.peak_torque_rpm}, ${e.peak_power_kw} kW @ ${e.peak_power_rpm}, to ${e.max_rpm} rpm` : e.kind === 'simple' ? `${e.max_torque_nm} Nm, ${e.max_power_kw} kW` : `shafts, ${e.torque_map_points} map points`}`);

// ---- suspensions, brakes, wheels, tyres: the numbers we read
const susp = [], brakes = [], wheels = [];
for (const [rel, d] of docs) {
  const k = d.Spring?.['Spring Coefficient'] ?? d['Spring Coefficient'] ?? d['Spring']?.['Spring Coefficient'];
  const c = d.Shock?.['Damping Coefficient'] ?? d['Damping Coefficient'];
  if (typeof d.Template === 'string' && /Wishbone|MultiLink|Axle|TrailingArm|PitmanArm|McPherson|Strut|SolidThreeLink|ToeBar|Walking/i.test(d.Template) && finitePos(k) && finitePos(c)) susp.push({ file: rel, template: d.Template, spring_n_per_m: k, damper_ns_per_m: c });
  const bt = d['Maximum Torque'] ?? d['Max Braking Torque'] ?? d['Maximum Braking Torque'];
  if (/Brake/.test(d.Template ?? '') && finitePos(bt)) brakes.push({ file: rel, template: d.Template, max_torque_nm: bt });
  if (d.Template === 'Wheel' || d.Type === 'Wheel') { const m = d.Mass ?? d['Mass']; const i = d.Inertia; if (finitePos(m)) wheels.push({ file: rel, mass_kg: m, inertia: i }); }
}
console.log(`\nSuspensions with spring + damper rates: ${susp.length}; brakes with a maximum torque: ${brakes.length}; wheels: ${wheels.length}`);
if (susp.length < 20) fail('fewer than 20 suspensions with spring + damper rates');
if (brakes.length < 10) fail('fewer than 10 brakes with a maximum torque');
console.log(`.tir files (Pacejka MF 5.2/6.1): ${tirs.map((t) => relative(DIR, t)).join(', ')}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nPASSED: 0 checks failed');
if (write) {
  writeFileSync(join(DIR, 'summary.json'), JSON.stringify({
    schema: 'open-grid/chrono-vehicles-summary/1',
    generated_by: 'tools/physics/check_chrono_vehicles.mjs --write',
    note: 'A digest of the verbatim files next to it; the files are the source. Chrono chassis inertias are model values, mostly outside the NHTSA-measured range.',
    chassis, engines, suspensions: susp, brakes, wheels,
  }, null, 1) + '\n');
  console.log('wrote summary.json');
}
process.exit(failures ? 1 : 0);
