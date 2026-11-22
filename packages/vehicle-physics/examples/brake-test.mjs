// node examples/brake-test.mjs [car.json]
// Straight-line checks on flat ground: 0-100 km/h, 60-0 mph with ABS, top speed. No game engine involved.
import fs from 'node:fs';
import { loadPhysics } from '../index.js';
import { FlatGroundCar } from '../harness.js';

const specPath = process.argv[2] || new URL('../cars/example_coupe.json', import.meta.url);
const spec = fs.readFileSync(specPath, 'utf8');
const physics = await loadPhysics();
const dt = 1 / 240;

function fresh() {
  const sim = new FlatGroundCar(physics.createCar(spec));
  for (let i = 0; i < 240; i++) sim.step({ handbrake: 1, device: 2 }, dt);   // settle on the springs
  return sim;
}

// 0-100 km/h from rest, full throttle, automatic gearbox and launch
let sim = fresh();
let t0 = sim.time, t100 = null, top = 0;
while (sim.time - t0 < 90) {
  const out = sim.step({ throttle: 1, device: 2 }, dt);
  if (t100 === null && out.speed >= 100 / 3.6) t100 = sim.time - t0;
  top = Math.max(top, out.speed);
}

// 60-0 mph with ABS, clutch down
sim = fresh();
sim.setSpeed(26.8224);
const z0 = sim.pos[2];
let tStop = 0;
while (sim.vel[2] > 0.05 && tStop < 10) { sim.step({ brake: 1, clutch: 1, device: 2 }, dt); tStop += dt; }

console.log(`${sim.car.info.name}`);
console.log(`  0-100 km/h   ${t100 === null ? 'n/a' : t100.toFixed(2) + ' s'}`);
console.log(`  60-0 mph     ${(sim.pos[2] - z0).toFixed(1)} m (ABS) in ${tStop.toFixed(2)} s`);
console.log(`  top speed    ${(top * 3.6).toFixed(0)} km/h (after 90 s)`);
