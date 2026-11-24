#!/usr/bin/env node
// Validate the measured-inertia reference table and sanity-bound the game's car configs against it.
//
//   node tools/physics/inertia_reference.mjs          report cars vs measured reference
//   node tools/physics/inertia_reference.mjs --check  exit 1 if the reference data or a car is implausible
//
// The reference data is a US Government work (public domain): Federal Register 62 FR 145, 29 July 1997,
// Tables 3/4 (NHTSA/VRTC, CU, CarT measurements of a 1994/1996 Isuzu Trooper and 1996 Acura SLX).
// It is REFERENCE data for real vehicles - not measurements of our fictional cars. The game's values are
// only checked for physical plausibility; this tool never rewrites them.
//
// Modern reference rows are from the 2020 NCAP SSF measurement report (NHTSA docket NHTSA-2001-9663-0497,
// public-domain US Government work): measured test weight, average track, CG height and SSF for 2019-2021
// vehicles. That report does NOT publish moments of inertia, so modern yaw inertia remains a documented gap.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SLUGFT2 = 1.35581795;   // kg*m^2 per slug*ft^2
const LB = 0.45359237;
const IN = 0.0254;

const ref = JSON.parse(readFileSync(join(ROOT, 'data/physics/inertia-reference.json'), 'utf8'));
const toSI = (e) => ({
  ...e,
  mass_kg: e.weight_lb * LB,
  cg_m: e.cg_in * IN,
  roll_kgm2: e.roll_slugft2 === null ? null : e.roll_slugft2 * SLUGFT2,
  yaw_kgm2: e.yaw_slugft2 === null ? null : e.yaw_slugft2 * SLUGFT2,
});

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

console.log('Measured reference (' + ref.source.title.split(',')[0] + ')');
const rows = ref.entries.map(toSI);
let lastVehicle = '';
for (const e of rows) {
  if (e.vehicle !== lastVehicle) { console.log('\n' + e.vehicle + ' [' + e.sourceOrg + ']'); lastVehicle = e.vehicle; }
  const i = e.yaw_kgm2, k = e.roll_kgm2;
  console.log('  ' + e.configuration.padEnd(44) + ' m ' + e.mass_kg.toFixed(0).padStart(5) + ' kg' +
    '  cg ' + e.cg_m.toFixed(3) + ' m' +
    (k === null ? '  roll/yaw n/a' : '  roll ' + k.toFixed(0).padStart(5) + '  yaw ' + i.toFixed(0).padStart(5) + ' kg m^2') +
    '  SSF ' + e.ssf.toFixed(2));
  if (!(e.mass_kg > 800 && e.mass_kg < 4000)) fail(e.id + ': mass out of range');
  if (!(e.cg_m > 0.3 && e.cg_m < 1.0)) fail(e.id + ': CG height out of range');
  if (k !== null) {
    if (!(k > 100 && k < 3000)) fail(e.id + ': roll inertia out of range');
    if (!(i > 500 && i < 9000)) fail(e.id + ': yaw inertia out of range');
    if (!(i > k)) fail(e.id + ': yaw inertia should exceed roll');
    const r2 = i / e.mass_kg;
    if (!(r2 > 0.6 && r2 < 4.0)) fail(e.id + ': yaw radius of gyration^2 implausible (' + r2.toFixed(2) + ' m^2)');
  }
  if (!(e.ssf > 0.8 && e.ssf < 2.0)) fail(e.id + ': SSF out of range');
}
if (!failures) ok('all ' + rows.length + ' reference entries pass unit and physical-range checks');

// Modern (2019-2021) NCAP/VIMF reference: measured CG height, track and weight. SSF is derived from track/(2h).
console.log('\nModern NCAP/VIMF reference (' + (ref.modernSource?.title?.split(' - ')[0] ?? '2020 NCAP') + ')');
let maxModernCg = 0;
for (const e of ref.modernEntries ?? []) {
  const m = e.weight_lb * LB, cg = e.cg_in * IN, tr = e.track_in * IN;
  const pred = tr / (2 * cg);
  console.log('  ' + e.vehicle.padEnd(22) + ' m ' + m.toFixed(0).padStart(5) + ' kg  cg ' + cg.toFixed(3) + ' m  track ' + tr.toFixed(2) +
    ' m  SSF ' + e.ssf.toFixed(2) + ' (track/2h ' + pred.toFixed(2) + ')');
  if (!(m > 900 && m < 4000)) fail(e.id + ': modern mass out of range');
  if (!(cg > 0.35 && cg < 0.95)) fail(e.id + ': modern CG out of range');
  if (!(e.ssf > 0.8 && e.ssf < 1.8)) fail(e.id + ': modern SSF out of range');
  if (Math.abs(pred - e.ssf) > 0.02) fail(e.id + ': SSF inconsistent with measured track and CG (' + pred.toFixed(2) + ' vs ' + e.ssf.toFixed(2) + ')');
  maxModernCg = Math.max(maxModernCg, cg);
}
if (!maxModernCg) fail('no modern reference entries');
else ok('modern entries measured (CG/track/weight): ' + (ref.modernEntries?.length ?? 0) + '; moments of inertia are NOT published in this source');

// Game cars: plausibility only (cg 0.35-0.85 m, yaw 1200-6000 kg m^2, yaw/mass 0.8-3.2 m^2, yaw > roll)
console.log('\nGame cars vs physical bounds');
const dir = join(ROOT, 'data/cars');
let cars = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (!c.chassis) continue;
  cars++;
  const m = c.chassis.mass_kg, cg = c.chassis.cg_height_m;
  const roll = c.chassis.inertia_roll_kgm2, yaw = c.chassis.inertia_yaw_kgm2;
  const r2 = yaw / m;
  const notes = [];
  if (!(cg > 0.35 && cg < 0.85)) notes.push('cg out of 0.35-0.85 m');
  if (!(yaw > 1200 && yaw < 6000)) notes.push('yaw out of 1200-6000 kg m^2');
  if (!(r2 > 0.8 && r2 < 3.2)) notes.push('yaw/mass out of 0.8-3.2 m^2');
  if (!(yaw > roll)) notes.push('yaw <= roll');
  // a sports car should sit at or below the measured modern passenger CG range
  if (maxModernCg && !(cg <= maxModernCg + 0.02)) notes.push('cg above modern measured reference');
  console.log('  ' + f.padEnd(24) + ' m ' + String(m).padStart(5) + ' kg  cg ' + cg.toFixed(2) + ' m  roll ' + roll.toFixed(0).padStart(5) +
    '  yaw ' + yaw.toFixed(0).padStart(5) + ' kg m^2  yaw/m ' + r2.toFixed(2) + ' m^2  ' + (notes.length ? 'FAIL: ' + notes.join('; ') : 'ok'));
  for (const n of notes) fail(f + ': ' + n);
}
ok(cars + ' car configs checked (values are gameplay data; the tool never edits them)');

console.log('\n' + (failures ? 'FAILED: ' + failures + ' check(s)' : 'PASSED: 0 check(s) failed'));
if (process.argv.includes('--check') && failures) process.exit(1);
