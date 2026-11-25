#!/usr/bin/env node
// Force-feedback SIGNAL check without a wheel: runs the physics core (the same WebAssembly the game uses) through a few manoeuvres and
// checks the steering torque the game would send to the wheel (output buffer [116], scaled by tanh(T / 450 N m) in src/ffb/index.ts).
// What it cannot tell you is how that feels in the hands or what a particular wheel does with it: that needs hardware
// (docs/ffb_test_plan.md). What it does catch: a wrong sign, no build-up with load, no lightening past the grip limit, a left/right
// asymmetry, a torque that jumps harder than a wheel motor can follow, and buzz on a straight.
//
//   cd packages/vehicle-physics && npm run sync-wasm      (once; copies the game's WASM into the package)
//   node web/tools/ffb_signal_check.mjs [car.json ...]   default: data/cars/vela_gt.json data/cars/tornado_gt3.json
//   FFB_CSV=out.csv node web/tools/ffb_signal_check.mjs   also write the steer-ramp trace for plotting
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = path.join(root, 'packages/vehicle-physics');
if (!fs.existsSync(path.join(pkg, 'dist/rs_core.wasm'))) { console.error('run "npm run sync-wasm" in packages/vehicle-physics first'); process.exit(2); }
const { loadPhysics } = await import(pathToFileURL(path.join(pkg, 'index.js')).href);
const { FlatGroundCar } = await import(pathToFileURL(path.join(pkg, 'harness.js')).href);
const physics = await loadPhysics();
const RACK_REF_NM = 450;   // src/ffb/index.ts: rack torque that maps to full force
const dt = 1 / 240;
const cars = process.argv.slice(2).length ? process.argv.slice(2) : ['data/cars/vela_gt.json', 'data/cars/tornado_gt3.json'];
let fails = 0;
const check = (ok, label, detail) => { if (!ok) fails++; console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`); };

function fresh(spec, kmh) {
  const sim = new FlatGroundCar(physics.createCar(spec));
  for (let i = 0; i < 240; i++) sim.step({ handbrake: 1, device: 2 }, dt);   // settle on the springs
  sim.setSpeed(kmh / 3.6);
  return sim;
}
// hold the speed with a gentle proportional throttle / brake so a run does not coast down
const cruise = (sim, kmh) => { const e = kmh / 3.6 - sim.vel[2]; return { throttle: Math.max(0, Math.min(1, 0.25 + 0.15 * e)), brake: Math.max(0, Math.min(1, -0.2 * e - 0.05)) }; };
const run = (sim, kmh, secs, steerAt) => {
  const rows = [];
  for (let i = 0; i < secs / dt; i++) {
    const t = i * dt, steer = steerAt(t);
    const out = sim.step({ ...cruise(sim, kmh), steer, device: 2 }, dt);
    const sa = 0.5 * (out.wheels[0].slipAngle + out.wheels[1].slipAngle);
    rows.push({ t, steer, torque: out.steerTorque, slip: sa, speed: out.speed });
  }
  return rows;
};

for (const file of cars) {
  const specPath = path.resolve(root, file);
  const spec = fs.readFileSync(specPath, 'utf8');
  console.log(`\n${JSON.parse(spec).name}  (${path.relative(root, specPath)})`);

  // 1. steer ramp at 100 km/h: 0 -> 30 % of lock in 12 s (to the front tyres' limit and past it)
  const ramp = run(fresh(spec, 100), 100, 12, (t) => 0.30 * t / 12);
  const peak = ramp.reduce((m, r) => (Math.abs(r.torque) > Math.abs(m.torque) ? r : m), ramp[0]);
  const end = ramp[ramp.length - 1];
  check(peak.torque < 0, 'steering left: the torque pulls the wheels back (negative)', `${peak.torque.toFixed(0)} N m at steer ${peak.steer.toFixed(2)}`);
  const early = ramp.filter((r) => r.steer > 0.01 && r.steer < 0.04);
  const mid = ramp.filter((r) => r.steer > 0.06 && r.steer < 0.09);
  const avg = (a) => a.reduce((s, r) => s + Math.abs(r.torque), 0) / Math.max(1, a.length);
  check(avg(mid) > avg(early) * 1.5, 'it builds with cornering load', `${avg(early).toFixed(0)} N m at steer ~0.03 -> ${avg(mid).toFixed(0)} N m at ~0.075`);
  const drop = 1 - Math.abs(end.torque) / Math.abs(peak.torque);
  check(drop > 0.05, 'it goes light past the grip limit (understeer feel)', `peak ${Math.abs(peak.torque).toFixed(0)} N m at front slip ${(peak.slip * 57.3).toFixed(1)} deg, ${(drop * 100).toFixed(0)} % lighter at ${(end.slip * 57.3).toFixed(1)} deg`);
  check(Math.abs(peak.torque) / RACK_REF_NM > 0.15 && Math.abs(peak.torque) / RACK_REF_NM < 2.5, 'the peak is in the range the 450 N m scale was chosen for', `${(Math.abs(peak.torque) / RACK_REF_NM * 100).toFixed(0)} % of RACK_REF_NM (tanh: ${(Math.tanh(Math.abs(peak.torque) / RACK_REF_NM) * 100).toFixed(0)} % of full force)`);
  if (process.env.FFB_CSV) fs.writeFileSync(process.env.FFB_CSV.replace(/(\.csv)?$/, `_${JSON.parse(spec).name.replace(/\W+/g, '_')}.csv`), 't,steer,torque_nm,front_slip_rad,speed\n' + ramp.filter((_, i) => i % 6 === 0).map((r) => [r.t, r.steer, r.torque, r.slip, r.speed].map((x) => x.toFixed(4)).join(',')).join('\n'));

  // 2. left / right symmetry
  const left = run(fresh(spec, 100), 100, 4, () => 0.06), right = run(fresh(spec, 100), 100, 4, () => -0.06);
  const tl = avg(left.slice(-240)), tr = avg(right.slice(-240));
  check(Math.abs(tl - tr) / Math.max(tl, tr) < 0.08, 'left and right steering feel the same', `${tl.toFixed(0)} vs ${tr.toFixed(0)} N m`);

  // 3. a sudden input: the largest torque change in one 240 Hz frame, as a share of full force
  const step = run(fresh(spec, 100), 100, 3, (t) => (t < 1 ? 0 : t < 1.1 ? 0.06 * (t - 1) / 0.1 : 0.06));
  let jump = 0;
  for (let i = 1; i < step.length; i++) jump = Math.max(jump, Math.abs(Math.tanh(step[i].torque / RACK_REF_NM) - Math.tanh(step[i - 1].torque / RACK_REF_NM)));
  check(jump < 0.15, 'a quick steering step does not slam the motor (per-frame change)', `${(jump * 100).toFixed(1)} % of full force in one 4 ms frame`);

  // 4. straight at 200 km/h: no buzz
  const straight = run(fresh(spec, 200), 200, 3, () => 0).slice(240);
  const m = straight.reduce((s, r) => s + r.torque, 0) / straight.length;
  const sd = Math.sqrt(straight.reduce((s, r) => s + (r.torque - m) ** 2, 0) / straight.length);
  check(sd / RACK_REF_NM < 0.01 && Math.abs(m) / RACK_REF_NM < 0.02, 'a straight line at 200 km/h is quiet', `mean ${m.toFixed(1)} N m, std ${sd.toFixed(2)} N m`);
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed (signal only: a wheel in the hands is still needed, see docs/ffb_test_plan.md)');
process.exit(fails ? 1 : 0);
