#!/usr/bin/env node
// Test of the "tyre file in, checked car out" pipeline: tools/new_car.mjs makes cars for every layout, rs_carcheck accepts them and rejects deliberately broken ones.
//   node tools/test_car_pipeline.mjs <path to rs_carcheck>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = process.argv[2];
if (!checker || !fs.existsSync(checker)) { console.error('usage: test_car_pipeline.mjs <rs_carcheck>'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_car_'));
let failures = 0;
const check = (what, ok, extra = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}${ok ? '' : ' ' + extra}`); if (!ok) ++failures; };
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const gen = (extra) => run(process.execPath, [path.join(root, 'tools/new_car.mjs'), '--no-check', '--out', tmp, '--tyre', path.join(root, 'data/tires/audi_245_40R18_pac2002.tir'), ...extra]);

// 1. a car for each layout from its numbers and a tyre file; every one passes the checker
for (const [layout, mass, wb, kw, rpm] of [['rwd', 1400, 2.7, 230, 7000], ['fwd', 1200, 2.6, 120, 6500], ['awd', 1500, 2.7, 280, 7200]]) {
  const id = `pipe_${layout}`;
  const g = gen(['--name', id, '--id', id, '--layout', layout, '--mass', String(mass), '--wheelbase', String(wb), '--power-kw', String(kw), '--redline', String(rpm)]);
  check(`${layout}: new_car writes the car`, g.status === 0 && fs.existsSync(path.join(tmp, `${id}.json`)), g.stderr);
  const c = run(checker, [path.join(tmp, `${id}.json`)]);
  check(`${layout}: rs_carcheck accepts it (0 FAIL)`, c.status === 0 && /0 FAIL/.test(c.stdout), c.stdout.slice(-300));
  const car = JSON.parse(fs.readFileSync(path.join(tmp, `${id}.json`), 'utf8'));
  check(`${layout}: the numbers given are the car's numbers`, car.chassis.mass_kg === mass && car.chassis.wheelbase_m === wb && car.drivetrain.layout === layout && car.engine.redline_rpm === rpm);
  let pk = 0;
  for (const [r, t] of car.engine.torque_curve) pk = Math.max(pk, t * r * Math.PI / 30);
  check(`${layout}: peak power is the requested ${kw} kW (+-0.5 %)`, Math.abs(pk / 1000 / kw - 1) < 0.005, String(pk / 1000));
  check(`${layout}: the tyre's own grip is in the car (front mu ${car.tire_front.lateral.mu})`, car.tire_front.lateral.mu > 0.9 && car.tire_front.lateral.mu < 1.2);
}

// 2. broken cars are caught
const base = JSON.parse(fs.readFileSync(path.join(tmp, 'pipe_rwd.json'), 'utf8'));
const broken = (name, edit) => { const c = JSON.parse(JSON.stringify(base)); edit(c); const f = path.join(tmp, `${name}.json`); fs.writeFileSync(f, JSON.stringify(c)); return run(checker, [f]); };
let r = broken('wrong_tyre_load', (c) => { c.tire_front.fz0_n = 25000; c.tire_rear.fz0_n = 25000; });
check('a tyre rated for 6x the car\'s load is a WARN (tyre load)', r.status === 0 && /\[WARN\] tyre load/.test(r.stdout), r.stdout.slice(-400));
r = broken('absurd_final_drive', (c) => { c.drivetrain.final_drive = 0.05; c.drivetrain.final_drive_teeth = [1, 20]; });
check('an absurd final drive is a FAIL (cannot launch) and a non-zero exit', r.status === 1 && /\[FAIL\] finite results/.test(r.stdout), r.stdout.slice(-400));
r = broken('weak_brakes', (c) => { c.brakes.max_total_torque_nm = 300; });
check('brakes at 5 % of what the tyres can use are a WARN (braking)', r.status === 0 && /\[WARN\] braking vs tyre grip/.test(r.stdout), r.stdout.slice(-400));
r = broken('tiny_engine', (c) => { c.engine.torque_curve = c.engine.torque_curve.map(([a, b]) => [a, b * 0.1]); });
check('an engine with a tenth of the torque is a FAIL (never reaches 100 km/h)', r.status === 1, r.stdout.slice(-400));

// 3. the generator refuses nonsense instead of writing it
r = gen(['--name', 'x', '--layout', 'rwd', '--mass', '5', '--wheelbase', '2.6', '--power-kw', '100', '--redline', '6000']);
check('a 5 kg car is refused', r.status !== 0 && /--mass/.test(r.stderr));
r = gen(['--name', 'x', '--layout', 'fwd', '--template', 'vela_gt', '--mass', '1300', '--wheelbase', '2.6', '--power-kw', '100', '--redline', '6000']);
check('a template with another drive layout is refused', r.status !== 0 && /layout/.test(r.stderr));
r = run(process.execPath, [path.join(root, 'tools/new_car.mjs'), '--name', 'x', '--mass', '1300', '--wheelbase', '2.6', '--power-kw', '100', '--redline', '6000', '--tyre', '/nonexistent.tir', '--out', tmp]);
check('a missing tyre file is refused', r.status !== 0 && /not found/.test(r.stderr));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
