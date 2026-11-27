// Background traffic (src/roadGraph.ts, src/trafficSim.ts) on the REAL street graphs of the game's cities, in Node, no browser.
// Pass criteria were written before the first run: they are the rules a driver of a believable city must obey (stay on the road, on the right side, not on top of each other, flowing, near the player).
// Usage: node tools/test_traffic.mjs   (exit code 1 on failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// load the TypeScript sources as they are: types stripped, './x' imports pointed at the stripped copies
const tmp = fs.mkdtempSync(path.join(here, '..', 'node_modules', '.traffic-test-'));   // inside web/ so `@dimforge/rapier3d-compat` resolves
// trafficCollision.ts only needs GROUP_CAR from physics/world.ts, which pulls in three.js: take the constant from the source instead of importing the module
const groupCar = /export const GROUP_CAR = ([^;]+);/.exec(fs.readFileSync(path.join(here, '../src/physics/world.ts'), 'utf8'))[1];
fs.writeFileSync(path.join(tmp, 'world_shim.mjs'), `export const GROUP_CAR = ${groupCar};\n`);
for (const f of ['roadGraph', 'trafficSim', 'trafficCarShape', 'trafficCollision']) {
  const src = fs.readFileSync(path.join(here, `../src/${f}.ts`), 'utf8').replace(/from '\.\/physics\/world'/g, "from './world_shim.mjs'").replace(/from '\.\/(\w+)'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(tmp, `${f}.mjs`), stripTypeScriptTypes(src, { mode: 'transform' }));
}
const { RoadGraph, drivesOnLeft } = await import(pathToFileURL(path.join(tmp, 'roadGraph.mjs')).href);
const { TrafficSim, idmAccel } = await import(pathToFileURL(path.join(tmp, 'trafficSim.mjs')).href);
const shape = await import(pathToFileURL(path.join(tmp, 'trafficCarShape.mjs')).href);
const { TrafficCollision, COLLISION_POOL, HIT_HOLD_S } = await import(pathToFileURL(path.join(tmp, 'trafficCollision.mjs')).href);
const RAPIER = (await import('@dimforge/rapier3d-compat')).default;
await RAPIER.init();
fs.rmSync(tmp, { recursive: true, force: true });

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => { checks++; if (!cond) { fails++; console.log(`FAIL  ${name} ${extra}`); } else console.log(`ok    ${name}`); };
const assets = path.join(here, '../public/assets');
const mapOf = (id) => JSON.parse(fs.readFileSync(path.join(assets, id === 'nyc' ? 'nyc' : `cities/${id}`, 'tiles/map.json'), 'utf8'));

ok('driving sides: London, Tokyo, Melbourne and Singapore on the left, New York, Paris and Los Angeles on the right', ['london', 'tokyo', 'melbourne', 'singapore'].every(drivesOnLeft) && !['nyc', 'paris', 'losangeles'].some(drivesOnLeft));
ok('IDM: a free road accelerates, a close slower leader brakes, a far leader is ignored', idmAccel(0, 14, Infinity, 0) > 1.5 && idmAccel(14, 14, 8, 6) < -2 && Math.abs(idmAccel(10, 14, 500, 0) - idmAccel(10, 14, Infinity, 0)) < 0.01);

{
  // the car's shape: triangle budget, size, outward normals, colours, the lights mesh
  const body = shape.buildCarBody(), lights = shape.buildCarLights();
  const tris = body.position.length / 9, ltris = lights.position.length / 9;
  const b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  for (let i = 0; i < body.position.length; i += 3) { for (const [k, o] of [['x', 0], ['y', 1], ['z', 2]]) { const v = body.position[i + o]; b[k][0] = Math.min(b[k][0], v); b[k][1] = Math.max(b[k][1], v); } }
  ok(`car shape: ${tris} body triangles (budget 260) and ${ltris} light triangles`, tris > 100 && tris <= 260 && ltris === 8);
  ok(`car shape: ${(b.x[1] - b.x[0]).toFixed(2)} m long, ${(b.z[1] - b.z[0]).toFixed(2)} m wide, ${b.y[1].toFixed(2)} m tall, wheels reach the ground`, Math.abs(b.x[1] - b.x[0] - shape.BASE_LENGTH) < 0.01 && Math.abs(b.z[1] - b.z[0] - shape.BASE_WIDTH) < 0.01 && Math.abs(b.y[0]) < 1e-6 && b.y[1] < 1.5);
  let bad = 0, hullOut = 0, hull = 0, wheelOut = 0, wheelTris = 0;
  for (let i = 0; i < body.position.length; i += 9) {
    const nx = body.normal[i], ny = body.normal[i + 1], nz = body.normal[i + 2];
    if (Math.abs(Math.hypot(nx, ny, nz) - 1) > 1e-4 || !Number.isFinite(body.position[i])) ++bad;
    const cx = (body.position[i] + body.position[i + 3] + body.position[i + 6]) / 3, cy = (body.position[i + 1] + body.position[i + 4] + body.position[i + 7]) / 3, cz = (body.position[i + 2] + body.position[i + 5] + body.position[i + 8]) / 3;
    const isWheel = Math.abs(cz) > 0.68 && cy < 0.66 && Math.abs(Math.abs(cx) - 1.4) < 0.5 && body.color[i] < 0.03;
    if (isWheel) { ++wheelTris; const wx = cx < 0 ? -1.42 : 1.38, wz = cz < 0 ? -0.8 : 0.8; if (nx * (cx - wx) + ny * (cy - 0.32) + nz * (cz - wz) > 0) ++wheelOut; }
    else { ++hull; if (nx * cx + ny * (cy - 0.8) + nz * cz > 0) ++hullOut; }   // away from the middle of the car (the underside faces down, which is away from y = 0.8 too)
  }
  ok('car shape: every normal is a unit vector and no coordinate is NaN', bad === 0);
  ok(`car shape: ${hullOut} of ${hull} hull faces point away from the middle of the car, ${wheelOut} of ${wheelTris} wheel faces away from their wheel (all of them)`, hullOut === hull && wheelOut === wheelTris && wheelTris === 4 * 6 * 4 && hull + wheelTris === tris);
  const glass = []; for (let i = 0; i < body.color.length; i += 9) if (body.color[i] < 0.1 && body.color[i + 2] > 0.06) glass.push(i);
  ok(`car shape: windows exist (${glass.length} dark-blue faces) and the paint is white vertex colour so the instance colour is the paint`, glass.length >= 8 && body.color.some((v, i) => i % 9 === 0 && v === 1));
  ok('car shape: head lights are bright white at the front, tail lights red at the back', (() => { let f = 0, r = 0; for (let i = 0; i < lights.position.length; i += 9) { if (lights.position[i] > 2 && lights.color[i] > 0.9 && lights.color[i + 2] > 0.7) ++f; if (lights.position[i] < -2 && lights.color[i] > 0.9 && lights.color[i + 1] < 0.1) ++r; } return f === 4 && r === 4; })());
}
{
  // ---- solid cars: the player (a dynamic box on the real Rapier) runs into a parked car at 20 m/s, stepped at 400 Hz with the same calls main.ts makes
  const road = new RoadGraph({ nodes: [[0, 0], [600, 0]], edges: [{ a: 0, b: 1, w: 7, hw: 'residential', oneway: true, ms: 30 }] });
  const run = (hitFromBehind, releaseFirst) => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 400;
    world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(300, -0.5, 0));
    const sim = new TrafficSim(road, { count: 1, seed: 3, spawnMin: 10, spawnMax: 80 });
    const col = new TrafficCollision({ world }, sim, () => 0);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.7, 0).setCcdEnabled(true));
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(2.2, 0.55, 0.9).setMass(1400).setFriction(0.3).setCollisionGroups(Number(0x00010000 | 0xfffd)), body);
    sim.reset({ x: 0, y: 0, vx: 0, vy: 0 });
    const A = sim.agents[0];
    A.v = 0; A.hold = 5;   // parked for 5 s: only the impact can make it wait longer
    body.setTranslation({ x: A.x - 22, y: 0.7, z: 0 }, true);
    body.setLinvel({ x: 20, y: 0, z: 0 }, true);
    const carX0 = A.x;
    let maxCarV = 0, maxX = -1e9, hit = false, finite = true, maxVy = 0, maxPen = -1e9;
    for (let tick = 0; tick < 400 * 2.5; tick++) {
      const p = body.translation();
      if (tick % 13 === 0) { sim.update(13 / 400, { x: p.x, y: -p.z, vx: 0, vy: 0 }); col.sync(p.x, p.z); if (releaseFirst) col.releaseAll(); }
      col.tick(1 / 400);
      const lv = body.linvel(), av = body.angvel();
      world.step();
      if (col.afterStep(collider, body, lv, av)) hit = true;
      const q = body.translation(), v = body.linvel();
      maxX = Math.max(maxX, q.x); maxCarV = Math.max(maxCarV, A.v); maxVy = Math.max(maxVy, Math.abs(v.y));
      maxPen = Math.max(maxPen, q.x + 2.2 - (A.x - A.length / 2));   // how far the player's nose is past the car's tail, at this very step
      if (![q.x, q.y, q.z, v.x, v.y, v.z].every(Number.isFinite)) finite = false;
    }
    const v = body.linvel(), parked = col.slots.filter((s) => s.agent).length;
    return { hit, speed: Math.hypot(v.x, v.z), maxX, carX0, maxPen, carX: A.x, carHalf: A.length / 2, maxCarV, finite, maxVy, hold: A.hold, peak: col.lastHit && col.lastHit.dv, active: parked, sameAgent: sim.agents.includes(A) };
  };
  const r = run(true, false);
  ok(`solid cars: the player is stopped by the car (20 m/s -> ${r.speed.toFixed(1)} m/s) and its nose is never more than ${r.maxPen.toFixed(2)} m past the car's tail (0.6 allowed)`, r.hit && r.speed < 3 && r.maxPen < 0.6);
  ok(`solid cars: nothing explodes: every value finite, vertical speed at most ${r.maxVy.toFixed(1)} m/s`, r.finite && r.maxVy < 6);
  ok(`solid cars: hit from behind the car is shoved on (up to ${r.maxCarV.toFixed(1)} m/s) and the contact's peak speed change is recorded (${(r.peak ?? 0).toFixed(1)} m/s)`, r.maxCarV > 3 && r.peak > 3);
  ok(`solid cars: the impact makes the car wait ${HIT_HOLD_S} s (it started with 5; ${r.hold.toFixed(1)} s are left after the 2.5 s run)`, r.hold > 8 && r.sameAgent);
  const free = run(true, true);
  ok(`solid cars: with the traffic switched off (boxes released) the player drives through the car's place (reaches x = ${free.maxX.toFixed(1)} m, the car stood at ${free.carX0.toFixed(1)} m; no contact, no box left: ${free.active})`, !free.hit && free.maxX > free.carX0 + 3 && free.active === 0);
  ok(`solid cars: the pool is ${COLLISION_POOL} boxes`, COLLISION_POOL === 8);
}
for (const city of ['london', 'nyc', 'tokyo', 'losangeles']) {
  const raw = mapOf(city);
  const g = new RoadGraph(raw);
  console.log(`--- ${city}: ${raw.nodes.length} junctions, ${raw.edges.length} roads -> ${g.arcs.length} lanes`);
  const valid = raw.edges.filter((e) => e.a !== e.b);      // a road from a junction to itself (a loop) is skipped
  const twoWay = valid.filter((e) => !e.oneway).length, oneWay = valid.length - twoWay;
  ok(`${city}: every road becomes one lane (one-way) or two (two-way); ${raw.edges.length - valid.length} self-loops skipped`, g.arcs.length === oneWay + 2 * twoWay, `${g.arcs.length} vs ${oneWay + 2 * twoWay}`);
  ok(`${city}: one-way roads have no opposite lane, two-way ones are paired`, g.arcs.every((a) => (a.oneway ? a.rev === -1 : g.arcs[a.rev].rev === a.id && g.arcs[a.rev].from === a.to && g.arcs[a.rev].to === a.from)));
  const lenOk = g.arcs.filter((a) => raw.edges[a.edge].len && Math.abs(a.len - raw.edges[a.edge].len) / raw.edges[a.edge].len < 0.25).length / g.arcs.length;
  ok(`${city}: the shape's length matches the road's recorded length on ${(lenOk * 100).toFixed(1)} % of lanes (needs 98 %)`, lenOk > 0.98);
  const ends = g.arcs.every((a) => Math.hypot(a.pts[0] - g.nodeX[a.from], a.pts[1] - g.nodeY[a.from]) < 0.01 && Math.hypot(a.pts[a.pts.length - 2] - g.nodeX[a.to], a.pts[a.pts.length - 1] - g.nodeY[a.to]) < 0.01);
  ok(`${city}: every lane starts at its junction and ends at the next one`, ends);
  {
    // the spatial index must find a road from any point on it, including the middle of a long road with only two shape points
    let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let found = 0, longFound = 0, longTotal = 0;
    for (let i = 0; i < 3000; i++) {
      const a = g.arcs[Math.floor(rnd() * g.arcs.length)], s = a.len * rnd(), q = g.poseAt(a, s);
      const hit = g.arcsNear(q.x, q.y, 1).includes(a.id);
      if (hit) ++found;
      if (a.len > 150) { ++longTotal; if (hit) ++longFound; }
    }
    ok(`${city}: the spatial index finds a road from any point on it (${found} of 3000; ${longFound} of ${longTotal} long roads)`, found === 3000);
    const q = g.poseAt(g.arcs[Math.floor(g.arcs.length / 3)], 1);
    const near = g.nearestArc(q.x, q.y, 30);
    ok(`${city}: nearestArc returns a road within a metre of a point on a road`, !!near && near.dist < 1.0);
  }
  ok(`${city}: limits are the posted ones (median ${(raw.edges.map((e) => e.ms).sort((x, y) => x - y)[raw.edges.length >> 1])} km/h)`, g.arcs.every((a) => a.limit > 1 && a.limit < 40));

  // ---- a simulated ten minutes with a player driving a circle of 800 m radius at 15 m/s
  const left = drivesOnLeft(city);
  const N = 40;
  const mid = g.arcs[Math.floor(g.arcs.length / 2)];
  const c = g.poseAt(mid, mid.len / 2);
  const player = { x: c.x, y: c.y, vx: 0, vy: 0 };
  const mk = (seed) => { const s = new TrafficSim(g, { count: N, seed, leftHand: left }); s.reset(player); return s; };
  const sim = mk(7);
  ok(`${city}: ${N} cars appear around the player at once (${sim.agents.length})`, sim.agents.length === N);
  let steps = 0, agentSteps = 0, overlap = 0, offRoad = 0, tooFast = 0, tooFastEntering = 0, noRoadSteps = 0, wrongSide = 0, sideChecked = 0, farFromPlayer = 0, countShort = 0, movingSum = 0, limitSum = 0;
  const dt = 0.1;
  const t0 = performance.now();
  for (let t = 0; t < 600; t += dt) {
    const ang = (t * 15) / 800;
    player.x = c.x + 800 * (Math.cos(ang) - 1); player.y = c.y + 800 * Math.sin(ang);
    player.vx = -15 * Math.sin(ang); player.vy = 15 * Math.cos(ang);
    sim.update(dt, player);
    if (t < 60) continue;                       // warm-up: the population settles
    ++steps;
    if (sim.agents.length < N) {
      // a shortfall only counts where the city has a road in the 150-300 m ring to put a car on (the test path crosses water and parks in some cities)
      const hasRoad = g.arcsNear(player.x, player.y, 360).some((id) => { const r = g.arcs[id]; const q0 = g.poseAt(r, 0), q1 = g.poseAt(r, r.len / 2), q2 = g.poseAt(r, r.len); return [q0, q1, q2].some((q) => { const d = Math.hypot(q.x - player.x, q.y - player.y); return d >= 150 && d <= 300; }); });
      if (hasRoad) ++countShort; else ++noRoadSteps;
    }
    for (const a of sim.agents) {
      ++agentSteps;
      if (a.s < -1e-6 || a.s > a.arc.len + 1e-6) ++offRoad;
      // cruising above 1.35 x the limit is a fault; a car that has just turned into a slower road (first 15 m) may still be slowing from the faster one
      if (a.v > a.arc.limit * 1.35) { if (a.s > 15) ++tooFast; else ++tooFastEntering; }
      movingSum += a.v; limitSum += a.arc.limit;
      if (Math.hypot(a.x - player.x, a.y - player.y) > 480) ++farFromPlayer;
      if (!a.arc.oneway && a.s > 12) { ++sideChecked; if (left ? a.off >= 0 : a.off <= 0) ++wrongSide; }
      for (const o of sim.agents) if (o.id < a.id && Math.hypot(o.x - a.x, o.y - a.y) < 2.4) { ++overlap; break; }
    }
  }
  const ms = (performance.now() - t0) / (600 / dt);
  const frac = (n, d) => (d ? n / d : 0);
  console.log(`   ${agentSteps} car-steps; ${tooFastEntering} above 1.35 x the limit within 15 m of entering a slower road; ${(100 * frac(noRoadSteps, steps)).toFixed(1)} % of steps had no road to spawn on; overlap ${(100 * frac(overlap, agentSteps)).toFixed(2)} %, mean speed ${(100 * movingSum / limitSum).toFixed(0)} % of the limit, stalled-removed ${sim.stats.stalledRemoved} of ${sim.stats.spawned} spawned, ${(ms).toFixed(3)} ms per update`);
  ok(`${city}: cars always stay on their road (0 steps off it)`, offRoad === 0, String(offRoad));
  ok(`${city}: nobody cruises faster than 1.35 x the posted limit (past the first 15 m of a road)`, tooFast === 0, String(tooFast));
  ok(`${city}: turning into a slower road never leaves a car above 1.35 x its limit for more than 0.05 % of car-steps (${tooFastEntering})`, tooFastEntering < 0.0005 * agentSteps);
  ok(`${city}: cars drive on the ${left ? 'left' : 'right'} of two-way roads (${sideChecked} checks)`, sideChecked > 1000 && wrongSide === 0, String(wrongSide));
  ok(`${city}: fewer than 2 % of car-steps have two cars on top of each other (${(100 * frac(overlap, agentSteps)).toFixed(2)} %)`, frac(overlap, agentSteps) < 0.02);
  ok(`${city}: traffic flows: mean speed above 35 % of the limits (${(100 * movingSum / limitSum).toFixed(0)} %)`, movingSum / limitSum > 0.35);
  ok(`${city}: fewer than 10 % of the cars ever need replacing for being stuck (${sim.stats.stalledRemoved} of ${sim.stats.spawned})`, sim.stats.stalledRemoved < 0.10 * sim.stats.spawned);
  ok(`${city}: the population is the requested ${N} on at least 95 % of steps where the city has a road to spawn on`, frac(countShort, steps) < 0.05, `${(100 * frac(countShort, steps)).toFixed(1)} % short`);
  ok(`${city}: no car is more than 480 m from the player`, farFromPlayer === 0, String(farFromPlayer));
  ok(`${city}: one update of ${N} cars costs under 1 ms in Node (${ms.toFixed(3)} ms)`, ms < 1.0);

  // ---- determinism, and a tier change
  const A = mk(99), B = mk(99);
  for (let i = 0; i < 200; i++) { A.update(0.1, player); B.update(0.1, player); }
  ok(`${city}: the same seed gives the same traffic`, A.agents.length === B.agents.length && A.agents.every((a, i) => a.x === B.agents[i].x && a.y === B.agents[i].y));
  A.setCount(12);
  for (let i = 0; i < 20; i++) A.update(0.1, player);
  ok(`${city}: a lower tier (12 cars) is reached within 2 s`, A.agents.length === 12, String(A.agents.length));
  A.setCount(0);
  A.update(0.1, player);
  ok(`${city}: tier 0 removes all cars`, A.agents.length === 0);
}
console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nall ${checks} passed`);
process.exit(fails ? 1 : 0);
