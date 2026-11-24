#!/usr/bin/env node
// Import measured aerodynamic drag area from the US EPA coast-down dataset into car configs.
//
// Source: US EPA "Test Car List Data" coast-down coefficients (US Government work, public domain,
// 17 U.S.C. 105), imported by tools/physics/import_epa_coastdown.mjs into
// data/validation/epa_coastdown.json. Road load F(v) = A + B v + C v^2, v in mph, F in lbf.
// The C term is aerodynamic: CdA = 2 * C_SI / rho, C_SI in N/(m/s)^2, rho = 1.225 kg/m^3.
//
// This tool sets a CLASS-PROXY drag area: the donor is a real measured car of a similar class,
// not the car being edited. It never touches downforce (no public measured lift data), and it
// records the donor, test id, coefficient and licence in the car's notes.
//
//   node tools/physics/import_epa_aero.mjs                       # print candidates
//   node tools/physics/import_epa_aero.mjs --apply               # apply the DONORS table below
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RHO = 1.225;
const DATA = JSON.parse(readFileSync(resolve('data/validation/epa_coastdown.json'), 'utf8'));
const vehicles = DATA.vehicles;
const apply = process.argv.includes('--apply');

// car file -> donor selection (year, make, model, preferred transmission substring)
const DONORS = [
  // compact RWD coupe (200 hp class)
  { car: 'kaze_kurogane.json', year: 2015, make: 'SUBARU', model: 'BRZ', trans: 'Manual', minHp: 150, maxHp: 350 },
  // AWD sport sedan (268 hp class)
  { car: 'hayate.json', year: 2015, make: 'SUBARU', model: 'WRX', trans: 'Manual', minHp: 200, maxHp: 350 },
  // RWD GT coupe (400 hp class)
  { car: 'vela_gt.json', year: 2015, make: 'CHEVROLET', model: 'CAMARO', trans: 'Semi-Automatic', minHp: 350, maxHp: 450 },
];

// EPA publishes several rows per test id (configuration variants): average f2 per test id so one
// car contributes one coefficient.
function pick(d) {
  const all = vehicles.filter((v) => v.year === d.year && v.make === d.make && v.model === d.model);
  const byTest = new Map();
  for (const v of all) {
    const t = byTest.get(v.testId) ?? { testId: v.testId, rows: [], hp: v.hp, transmission: v.transmission, drive: v.drive, year: v.year, make: v.make, model: v.model };
    t.rows.push(v);
    byTest.set(v.testId, t);
  }
  const tests = [...byTest.values()].map((t) => ({
    ...t,
    f2: t.rows.reduce((n, r) => n + r.f2_n_s2_per_m2, 0) / t.rows.length,
    c: t.rows.reduce((n, r) => n + r.c_lbf_per_mph2, 0) / t.rows.length,
  })).filter((t) => t.hp >= d.minHp && t.hp <= d.maxHp);
  const pref = tests.find((t) => (t.transmission || '').toLowerCase().includes(d.trans.toLowerCase()));
  return { all: tests, chosen: pref ?? tests[0] };
}
const cda = (v) => Math.round((2 * v.f2) / RHO * 1000) / 1000;

for (const d of DONORS) {
  const { all, chosen } = pick(d);
  if (!chosen) { console.log('MISSING donor for', d.car); continue; }
  console.log(
    [d.car, chosen.year + ' ' + chosen.make + ' ' + chosen.model, 'test=' + chosen.testId,
     'C=' + chosen.c.toFixed(5) + ' lbf/mph^2', 'f2=' + chosen.f2.toFixed(4),
     'CdA=' + cda(chosen) + ' m^2', 'records=' + all.length].join(' | '),
  );
}

if (!apply) process.exit(0);

for (const d of DONORS) {
  const { chosen } = pick(d);
  if (!chosen) continue;
  const path = resolve('data/cars', d.car);
  const car = JSON.parse(readFileSync(path, 'utf8'));
  const value = cda(chosen);
  const before = car.aero.drag_area_m2;
  car.aero.drag_area_m2 = value;
  const line = ' Aero drag area (' + before + ' -> ' + value + ' m^2) set 2026-11-24 from US EPA coast-down data'
    + ' (public domain, 17 USC 105): ' + chosen.year + ' ' + chosen.make + ' ' + chosen.model
    + ' test ' + chosen.testId + ', C=' + chosen.c.toFixed(5) + ' lbf/mph^2 -> CdA=' + value + ' m^2.'
    + ' CLASS PROXY (a measured car of the same class, not this car); confidence: medium.'
    + ' See docs/data-sources.md.';
  car.notes = (car.notes || '').trimEnd() + line;
  writeFileSync(path, JSON.stringify(car, null, 2) + '\n');
  console.log('applied', d.car, before, '->', value);
}
