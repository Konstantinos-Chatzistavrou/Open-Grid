// Free-roam rules (src/worldClock.ts, src/zoneBoard.ts), in Node, no browser: the weather that changes with the clock in solo free roam, and the leaderboard's honest pace targets.
// Usage: node tools/test_freeroam.mjs   (exit code 1 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

const here = path.dirname(fileURLToPath(import.meta.url));
const { WorldClock } = await import(pathToFileURL(path.join(here, '../src/worldClock.ts')).href);
const { paceTargets } = await import(pathToFileURL(path.join(here, '../src/zoneBoard.ts')).href);

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => { checks++; if (!cond) { fails++; console.log(`FAIL  ${name} ${extra}`); } else console.log(`ok    ${name}`); };
const scene = new THREE.Scene(), moon = new THREE.DirectionalLight();
const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

// ---- weather
{
  const c = new WorldClock();
  c.setWeather('dry');
  let changes = 0;
  c.onWeatherChange = () => { ++changes; };
  for (let i = 0; i < 20000; ++i) c.update(300, scene, moon);   // 20000 x 20 game minutes: fixed weather must never move
  ok('races and ?weather= (dynamic off): the weather never changes, however long it runs', changes === 0 && c.weather === 'dry');
}
{
  const c = new WorldClock();
  c.dynamic = true;
  c.rng = lcg(12345);
  c.setWeather('dry');
  const changes = [];
  c.onWeatherChange = (w) => changes.push(w);
  let rainSteps = 0, total = 0, spells = [], spell = 0;
  for (let i = 0; i < 14400; ++i) {          // 200 game days in 20-minute steps (dt 300 s real = 1200 game s)
    c.update(300, scene, moon);
    ++total;
    if (c.weather === 'rain') { ++rainSteps; ++spell; } else if (spell) { spells.push(spell); spell = 0; }
  }
  const share = rainSteps / total, meanSpell = spells.reduce((a, b) => a + b, 0) / spells.length;
  ok(`the weather changes during a session (${changes.length} changes in 200 game days)`, changes.length > 100);
  ok(`the long-run rain share is about a quarter (${(share * 100).toFixed(1)} %)`, share > 0.18 && share < 0.36);
  ok(`a rain spell lasts about three steps of 20 game minutes (mean ${meanSpell.toFixed(2)})`, meanSpell > 2.4 && meanSpell < 4.6);
  ok('it alternates: a change is always to the other weather', changes.every((w, i) => w !== (i ? changes[i - 1] : 'dry')));
}
{
  // rain arrives gradually: about a minute to settle, not the 5 s of a fixed-weather change
  const c = new WorldClock();
  c.dynamic = true;
  c.rng = () => 0;                 // always below the thresholds: dry -> rain at the next step
  c.setWeather('dry');
  const seen = [];
  c.onWeatherChange = (w) => seen.push(w);
  while (!seen.length) c.update(1, scene, moon);          // 1 s steps until the step fires
  const w0 = c.wetness;
  for (let i = 0; i < 2; ++i) c.update(0.5, scene, moon);
  const w1 = c.wetness;
  for (let i = 0; i < 120; ++i) c.update(1, scene, moon);
  ok(`rain: wetness rises gradually (${w0.toFixed(2)} -> ${w1.toFixed(2)} after 1 s -> ${c.wetness.toFixed(2)} after 2 min)`, w1 < 0.5 && c.wetness > 0.9);
  ok('rain puts a water film on the road for the physics', c.roadWaterMm > 0.5);
}
{
  const c = new WorldClock();
  c.setWeather('rain');
  const w = c.wetness;
  c.dynamic = false; c.setWeather('dry');
  ok('a fixed-weather change is instant (screenshots and tests rely on it)', c.wetness < w && c.weather === 'dry');
}
const mainSrc = fs.readFileSync(path.join(here, '../src/main.ts'), 'utf8');
ok('main.ts enables dynamic weather for solo free roam only (not online, not with ?weather=)', /worldClock\.dynamic = mode === 'free' && !params\.get\('weather'\)/.test(mainSrc));

// ---- leaderboard
{
  const t = paceTargets([100, 200, 300]);
  ok('five pace targets', t.length === 5);
  ok('every one is marked as a target, not a player', t.every((e) => e.pace === true));
  ok('names are unique (a board merges by name) and say "target"', new Set(t.map((e) => e.name)).size === 5 && t.every((e) => /target$/.test(e.name)));
  ok('scores descend from the elite target to the bronze one', t.every((e, i) => i === 0 || e.score <= t[i - 1].score), JSON.stringify(t.map((e) => e.score)));
  ok('stars follow the thresholds (3, 3, 2, 2, 1)', t.map((e) => e.stars).join('') === '33221');
  const zs = fs.readFileSync(path.join(here, '../src/zones.ts'), 'utf8');
  ok('the board does not call itself global', !/GLOBAL/i.test(zs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('the invented player names are gone', !/Kurogane_JP|Valkyrie99|MidnightApex|StreetGhost|Redline_NYC/.test(zs + fs.readFileSync(path.join(here, '../src/zoneBoard.ts'), 'utf8').replace(/\/\/.*$/gm, '')));
}
// ---- feature tiers
{
  const { TIERS, TIER_ORDER, tierFor, MEASURED_LOW_TRAFFIC } = await import(pathToFileURL(path.join(here, '../src/tiers.ts')).href);
  ok('every preset has a tier', ['max', 'ultra', 'high', 'medium', 'low', 'potato'].every((p) => TIERS[p]));
  const mono = (key) => TIER_ORDER.every((p, i) => i === 0 || TIERS[p][key] >= TIERS[TIER_ORDER[i - 1]][key]);
  ok('background traffic never decreases from potato up to max', mono('backgroundTraffic'));
  ok('pedestrians never decrease from potato up to max', mono('pedestrians'));
  ok('the detailed rival cars stay at the current 5 on every tier (no regression, and they are the expensive kind)', TIER_ORDER.every((p) => TIERS[p].rivalCars === 5));
  ok('the minimum tier (low) stays inside the measured range and has no pedestrians (they do not exist yet)', TIERS.low.backgroundTraffic > 0 && TIERS.low.backgroundTraffic <= MEASURED_LOW_TRAFFIC && TIERS.low.pedestrians === 0);
  ok('only low claims to be measured: the others need a stronger device (or a phone) to be run', TIERS.low.measured === true && TIER_ORDER.filter((p) => p !== 'low').every((p) => TIERS[p].measured === false));
  ok('an unknown preset falls back to the minimum tier', tierFor('nonsense') === TIERS.low);
}
console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nall ${checks} passed`);
process.exit(fails ? 1 : 0);
