// node scripts/leaderboard.mjs [laps]
// Races every bot in bots/ (each *.js exporting a default factory) on the example circuit in the example coupe and
// prints a Markdown table, best score first. Same rules for everyone: flat ground, 240 Hz, default assists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPhysics } from '../index.js';
import { runBotRace } from '../harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const laps = Number(process.argv[2]) || 3;
const carSpec = fs.readFileSync(path.join(root, 'cars/example_coupe.json'), 'utf8');
const route = fs.readFileSync(path.join(root, 'routes/example_circuit.json'), 'utf8');
const physics = await loadPhysics();

const files = fs.readdirSync(path.join(root, 'bots'), { recursive: true })
  .filter((f) => f.endsWith('.js')).sort();
const rows = [];
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(root, 'bots', f)));
  const factory = mod.default || mod.createBot;
  if (typeof factory !== 'function') continue;
  const r = runBotRace({ physics, carSpec, route, bot: factory(), laps, maxTime: 120 * laps });
  rows.push({ file: f, ...r });
}
rows.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));
const t = (x) => (x == null ? '-' : `${Math.floor(x / 60)}:${(x % 60).toFixed(3).padStart(6, '0')}`);
console.log(`| # | bot | file | best lap | ${laps} laps | off track | score |`);
console.log('|---|---|---|---|---|---|---|');
rows.forEach((r, i) => console.log(`| ${i + 1} | ${r.bot} | bots/${r.file} | ${t(r.bestLap)} | ${r.finished ? t(r.raceTime) : 'DNF'} | ${r.offTrackSeconds.toFixed(1)} s | ${r.score == null ? 'DNF' : r.score.toFixed(3)} |`));
