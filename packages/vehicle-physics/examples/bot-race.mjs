// node examples/bot-race.mjs [path/to/bot.js] [laps] [car.json] [route.json]
// Races a bot alone on the example circuit, headless, and prints lap times. A bot module exports a default
// factory (or a `createBot`) returning { name, reset?(info), drive(observation) -> controls }. See bots/example_bot.js.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPhysics } from '../index.js';
import { runBotRace } from '../harness.js';

const [botArg, lapsArg, carArg, routeArg] = process.argv.slice(2);
const botUrl = botArg ? pathToFileURL(path.resolve(botArg)) : new URL('../bots/example_bot.js', import.meta.url);
const botModule = await import(botUrl);
const factory = botModule.default || botModule.createBot || botModule.createExampleBot;
const bot = typeof factory === 'function' ? factory() : factory;

const carSpec = fs.readFileSync(carArg || new URL('../cars/example_coupe.json', import.meta.url), 'utf8');
const route = fs.readFileSync(routeArg || new URL('../routes/example_circuit.json', import.meta.url), 'utf8');
const physics = await loadPhysics();
const wall = performance.now();
const r = runBotRace({ physics, carSpec, route, bot, laps: Number(lapsArg) || 3 });
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;

console.log(`${r.bot} in the ${r.car} at ${r.route}`);
r.lapTimes.forEach((t, i) => console.log(`  lap ${i + 1}  ${fmt(t)}`));
console.log(r.finished
  ? `  best ${fmt(r.bestLap)}  total ${fmt(r.raceTime)}  off track ${r.offTrackSeconds.toFixed(1)} s  score ${r.score.toFixed(3)}`
  : `  did not finish (${(r.distance / 1000).toFixed(2)} km driven)`);
console.log(`  simulated in ${((performance.now() - wall) / 1000).toFixed(1)} s`);
