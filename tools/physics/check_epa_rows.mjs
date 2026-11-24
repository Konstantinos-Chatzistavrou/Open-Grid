#!/usr/bin/env node
// Every one of the 1,699 EPA certification rows in data/powertrain/final-drives.json, one by one: a plausible car (year, make, model),
// a gear count of 3-10, an axle ratio of 1.5-7, an engine of 0.5-8.4 L and 40-1500 hp (the Bugatti Veyron Super Sport is in the data), and a specific output between 20 and 250 hp/L
// (naturally aspirated economy engines to turbocharged supercars). The rows' own licence and source fields must be present.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const { rows } = JSON.parse(readFileSync(`${ROOT}/data/powertrain/final-drives.json`, 'utf8'));
let bad = 0;
const fail = (i, m) => { if (bad++ < 20) console.log(`  [FAIL] row ${i} ${rows[i].year} ${rows[i].make} ${rows[i].model}: ${m}`); };
const stats = { hpl: [], fd: [] };
rows.forEach((r, i) => {
  if (!(r.year >= 2015 && r.year <= 2020)) fail(i, `year ${r.year}`);
  if (!r.make || !r.model) fail(i, 'no make / model');
  if (!Number.isInteger(r.gears) || r.gears < 3 || r.gears > 10) fail(i, `gears ${r.gears}`);
  if (!(r.final_drive >= 1.5 && r.final_drive <= 7)) fail(i, `axle ratio ${r.final_drive}`);
  if (!(r.displacement_l >= 0.5 && r.displacement_l <= 8.4)) fail(i, `displacement ${r.displacement_l} L`);
  if (!(r.rated_hp >= 40 && r.rated_hp <= 1500)) fail(i, `rated hp ${r.rated_hp}`);
  const hpl = r.rated_hp / r.displacement_l;
  if (!(hpl >= 20 && hpl <= 250)) fail(i, `specific output ${hpl.toFixed(0)} hp/L`);
  if (!r.licence || !r.source) fail(i, 'no licence / source');
  stats.hpl.push(hpl); stats.fd.push(r.final_drive);
});
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
console.log(`${rows.length} rows: specific output p5 ${q(stats.hpl, 0.05).toFixed(0)} / median ${q(stats.hpl, 0.5).toFixed(0)} / p95 ${q(stats.hpl, 0.95).toFixed(0)} hp/L; axle ratio p5 ${q(stats.fd, 0.05)} / median ${q(stats.fd, 0.5)} / p95 ${q(stats.fd, 0.95)}`);
console.log(bad ? `${bad} row(s) failed` : `PASSED: all ${rows.length} rows pass`);
process.exit(bad ? 1 : 0);
