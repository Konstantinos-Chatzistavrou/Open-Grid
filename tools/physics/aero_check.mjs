#!/usr/bin/env node
// Aero plausibility / validation check for Open Grid car configs against the legal reference table.
//
//   node tools/physics/aero_check.mjs [--speed 200] [--verbose]
//
// What it does: for every data/cars/*.json it reads aero.drag_area_m2 (CdA) and aero.downforce_area_m2
// (ClA, downforce positive), computes drag/downforce at the stated speed, and checks the values against
// documented envelopes derived from the reference data (data/physics/aero_reference.json):
//
//  - CdA in the road-to-race envelope (reference DrivAer Cd x assumed frontal area, widened for race cars)
//  - ClA inside a wing-bound derived from NACA 0012 cl_max and an assumed 1.0 m^2 device area
//  - L/D inside a stated envelope; road cars (ClA < 0.3) additionally compared to the DrivAer CdA band
//  - front balance inside 0.30..0.60 whenever the car has meaningful downforce
//
// It does NOT claim our cars were measured: their aero fields are game values and remain labelled as such.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? Number(args[i + 1]) : def; };
const verbose = args.includes('--verbose');
const speedKmh = opt('speed', 200);
const v = speedKmh / 3.6;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ref = JSON.parse(readFileSync(join(ROOT, 'data/physics/aero_reference.json'), 'utf8'));
const rho = ref.air_density_kg_m3 ?? 1.225;
const q = 0.5 * rho * v * v;

const carsDir = join(ROOT, 'data/cars');
const files = readdirSync(carsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.visual.json') && f !== 'catalog.json');

// --- reference envelopes (explicit assumptions from the JSON) ---------------------------------------------
const cdRef = ref.references.filter((r) => typeof r.cd === 'number').map((r) => r.cd);
const cdMin = Math.min(...cdRef), cdMax = Math.max(...cdRef);
const A = ref.assumptions.frontal_area_m2;
const drivaerCdA = { low: cdMin * A.low, high: cdMax * A.high };
const wing = ref.references.find((r) => r.id === 'naca0012_wing');
const clMaxBound = (wing?.cl_max ?? 1.4) * (ref.assumptions.wing_area_m2_for_bound ?? 1.0) * 1.15; // +15% underbody allowance

let failures = 0, checked = 0, missing = 0, warns = 0;
const rows = [];
const fail = (car, msg) => { failures++; console.log(`  [FAIL] ${car}: ${msg}`); };

console.log(`Aero check at ${speedKmh} km/h (q = ${q.toFixed(0)} Pa)`);
console.log(`references: DrivAer Cd ${cdMin}..${cdMax} (CC BY 4.0) -> CdA band ${drivaerCdA.low.toFixed(2)}..${drivaerCdA.high.toFixed(2)} m^2 at assumed A ${A.low}..${A.high} m^2`);
console.log(`ClA bound from NACA 0012 cl_max ${wing?.cl_max} x ${ref.assumptions.wing_area_m2_for_bound} m^2 (+15%): ${clMaxBound.toFixed(2)} m^2`);

// --- balance reference (CFD, explicitly not measured) ---------------------------------------------------
const balance = ref.balance_reference;
const balanceRefs = ref.references.filter((r) => typeof r.front_share_derived === 'number');
if (balance) {
  console.log(`balance reference: front share ${balance.front_share_range[0]}..${balance.front_share_range[1]} for ${balance.class}`);
  console.log(`  basis: ${balance.basis} — a class proxy, NOT a wind-tunnel measurement of our cars`);
}
// integrity: the reference's own front/rear coefficients must sum to its total lift
for (const r of ref.references) {
  if (typeof r.cl === 'number' && typeof r.cl_front === 'number' && typeof r.cl_rear === 'number'
      && Math.abs((r.cl_front + r.cl_rear) - r.cl) > 1e-3) {
    failures++;
    console.log(`  [FAIL] reference ${r.id}: CLf + CLr = ${(r.cl_front + r.cl_rear).toFixed(3)} but CL = ${r.cl}`);
  }
}
console.log('');

for (const f of files) {
  const car = JSON.parse(readFileSync(join(carsDir, f), 'utf8'));
  const a = car.aero;
  const name = car.name ?? f.replace('.json', '');
  if (!a || typeof a.drag_area_m2 !== 'number') { missing++; if (verbose) console.log(`  [skip] ${name}: no aero.drag_area_m2`); continue; }
  const cdA = a.drag_area_m2;
  const clA = typeof a.downforce_area_m2 === 'number' ? a.downforce_area_m2 : 0;
  const ld = cdA > 0 ? clA / cdA : 0;
  const dragN = q * cdA, downN = q * clA;
  const impliedCd = cdA / 2.0;
  checked++;
  rows.push({ name, cdA, clA, ld, dragN, downN, impliedCd, fb: a.front_balance });
  const isRoad = clA < 0.3;

  if (cdA < 0.30 || cdA > 1.35) fail(name, `CdA ${cdA} outside 0.30..1.35 m^2`);
  if (clA < 0 || clA > clMaxBound) fail(name, `ClA ${clA} outside 0..${clMaxBound.toFixed(2)} m^2 (wing-bound)`);
  if (ld < 0 || ld > 2.5) fail(name, `L/D ${ld.toFixed(2)} outside 0..2.5`);
  if (clA > 0.1 && (typeof a.front_balance !== 'number' || a.front_balance < 0.30 || a.front_balance > 0.60))
    fail(name, `front_balance ${a.front_balance} outside 0.30..0.60 with downforce`);
  if (isRoad && typeof a.front_balance === 'number' && clA > 0.1 && balance) {
    const [lo, hi] = balance.front_share_range;
    if (a.front_balance < lo || a.front_balance > hi) {
      warns++;
      console.log(`  [WARN] ${name}: front_balance ${a.front_balance} outside the CFD class band ${lo}..${hi} ` +
        '(CFD proxy, not measured; a rear-biased winged car can be legitimate — value left unchanged)');
    }
  }
  if (isRoad && (cdA < drivaerCdA.low * 0.8 || cdA > drivaerCdA.high * 1.2))
    fail(name, `road-class CdA ${cdA} outside DrivAer-derived band x 0.8..1.2 (${(drivaerCdA.low * 0.8).toFixed(2)}..${(drivaerCdA.high * 1.2).toFixed(2)})`);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('car', 22) + pad('CdA', 7) + pad('ClA', 7) + pad('L/D', 7) + pad('drag N', 9) + pad('down N', 9) + 'implied Cd @2.0m2');
for (const r of rows.sort((x, y) => y.clA - x.clA))
  console.log(pad(r.name, 22) + pad(r.cdA.toFixed(3), 7) + pad(r.clA.toFixed(2), 7) + pad(r.ld.toFixed(2), 7) + pad(r.dragN.toFixed(0), 9) + pad(r.downN.toFixed(0), 9) + r.impliedCd.toFixed(3));

console.log(`\nchecked ${checked} cars, ${missing} without aero, ${failures} failure(s)`);
console.log('Reference values: data/physics/aero_reference.json; assumptions and licences: docs/downforce-data.md');
console.log(`\nchecked ${checked} cars, ${missing} without aero, ${failures} failure(s), ${warns} balance warning(s)`);
process.exit(failures ? 1 : 0);
