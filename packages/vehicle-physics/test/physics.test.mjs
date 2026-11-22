import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadPhysics } from '../index.js';
import { FlatGroundCar, FlatRoute, runBotRace } from '../harness.js';
import { createExampleBot } from '../bots/example_bot.js';

const spec = fs.readFileSync(new URL('../cars/example_coupe.json', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../routes/example_circuit.json', import.meta.url), 'utf8');
const physics = await loadPhysics();
const dt = 1 / 240;

function settled() {
  const sim = new FlatGroundCar(physics.createCar(spec));
  for (let i = 0; i < 240; i++) sim.step({ handbrake: 1, device: 2 }, dt);
  return sim;
}

test('a bad spec throws with the parser message', () => {
  assert.throws(() => physics.createCar('{"schema":"car/1"}'), /car spec/);
});

test('car info comes from the spec', () => {
  const car = physics.createCar(spec);
  assert.equal(car.info.name, 'Example Coupe');
  assert.equal(car.info.mass, 1320);
  assert.equal(car.info.driven.rear, true);
  assert.equal(car.info.inertia.length, 3);
});

test('settles on its springs at about the CG height, level', () => {
  const sim = settled();
  assert.ok(Math.abs(sim.pos[1] - sim.car.info.cgHeight) < 0.05, `cg ${sim.pos[1]}`);
  assert.ok(Math.hypot(...sim.vel) < 0.05);
  const out = sim.step({ handbrake: 1, device: 2 }, dt);
  const total = out.wheels.reduce((a, w) => a + w.load, 0);
  assert.ok(Math.abs(total - sim.car.info.mass * 9.81) / (sim.car.info.mass * 9.81) < 0.05, `loads ${total}`);
});

test('60-0 mph with ABS stops in a road-car distance and straight', () => {
  const sim = settled();
  sim.setSpeed(26.8224);
  const z0 = sim.pos[2];
  let t = 0;
  while (sim.vel[2] > 0.05 && t < 10) { sim.step({ brake: 1, clutch: 1, device: 2 }, dt); t += dt; }
  const d = sim.pos[2] - z0;
  assert.ok(d > 28 && d < 38, `60-0 ${d.toFixed(1)} m`);
  assert.ok(Math.abs(sim.pos[0]) < 0.5, `drift ${sim.pos[0]}`);
});

test('accelerates from rest and changes gear', () => {
  const sim = settled();
  let out, t100 = null, maxGear = 0;
  while (sim.time < 20) {
    out = sim.step({ throttle: 1, device: 2 }, dt);
    maxGear = Math.max(maxGear, out.gear);
    if (t100 === null && out.speed >= 100 / 3.6) t100 = sim.time - 1;
  }
  assert.ok(t100 !== null && t100 > 3 && t100 < 9, `0-100 ${t100}`);
  assert.ok(maxGear >= 4, `top gear reached ${maxGear}`);
});

test('steer +1 turns left', () => {
  const sim = settled();
  sim.setSpeed(15);
  for (let i = 0; i < 480; i++) sim.step({ steer: 0.3, throttle: 0.2, device: 2 }, dt);
  assert.ok(sim.angVel[1] > 0.2, `yaw rate ${sim.angVel[1]}`);
  assert.ok(sim.pos[0] > 2, `x ${sim.pos[0]}`);   // +X is the car's left at start
});

test('route projection: centreline has zero offset, a point to the left is positive', () => {
  const r = new FlatRoute(route);
  assert.ok(r.closed && r.length > 2000);
  const smp = r.samples[100];
  const p = r.project(smp.p, 95);
  assert.ok(Math.abs(p.lateral) < 0.05 && Math.abs(p.s - smp.s) < 0.5);
  const left = [smp.p[0] + smp.dir[2] * 3, 0, smp.p[2] - smp.dir[0] * 3];
  assert.ok(Math.abs(r.project(left, 95).lateral - 3) < 0.2);
});

test('the example bot finishes two clean laps', () => {
  const res = runBotRace({ physics, carSpec: spec, route, bot: createExampleBot(), laps: 2 });
  assert.equal(res.finished, true);
  assert.equal(res.lapTimes.length, 2);
  assert.ok(res.offTrackSeconds < 1, `off track ${res.offTrackSeconds}`);
  assert.ok(res.bestLap > 40 && res.bestLap < 120, `best ${res.bestLap}`);
});
