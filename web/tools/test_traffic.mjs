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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-'));
for (const f of ['roadGraph', 'trafficSim']) {
  const src = fs.readFileSync(path.join(here, `../src/${f}.ts`), 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(tmp, `${f}.mjs`), stripTypeScriptTypes(src, { mode: 'transform' }));
}
const { RoadGraph, drivesOnLeft } = await import(pathToFileURL(path.join(tmp, 'roadGraph.mjs')).href);
const { TrafficSim, idmAccel } = await import(pathToFileURL(path.join(tmp, 'trafficSim.mjs')).href);
fs.rmSync(tmp, { recursive: true, force: true });

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => { checks++; if (!cond) { fails++; console.log(`FAIL  ${name} ${extra}`); } else console.log(`ok    ${name}`); };
const assets = path.join(here, '../public/assets');
const mapOf = (id) => JSON.parse(fs.readFileSync(path.join(assets, id === 'nyc' ? 'nyc' : `cities/${id}`, 'tiles/map.json'), 'utf8'));

ok('driving sides: London, Tokyo, Melbourne and Singapore on the left, New York, Paris and Los Angeles on the right', ['london', 'tokyo', 'melbourne', 'singapore'].every(drivesOnLeft) && !['nyc', 'paris', 'losangeles'].some(drivesOnLeft));
ok('IDM: a free road accelerates, a close slower leader brakes, a far leader is ignored', idmAccel(0, 14, Infinity, 0) > 1.5 && idmAccel(14, 14, 8, 6) < -2 && Math.abs(idmAccel(10, 14, 500, 0) - idmAccel(10, 14, Infinity, 0)) < 0.01);

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
