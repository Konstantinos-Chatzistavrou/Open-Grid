#!/usr/bin/env node
// Before / after screenshots for kit changes (docs/kit.md): the garage car, and one city street at night, dry and wet.
// Playwright (playwright-core) driving the system Chrome headless with WebGPU (no window, no browser download).
//
//   cd tools/assets && npm install            (once)
//   node tools/assets/screens.mjs <out dir> [label=query ...]
//     default labels: before="hdri=0" after=""   (each label is extra URL query for every shot)
//   BASE=http://127.0.0.1:5173 (the Vite dev server: cd web && npm run dev)   CITY=nyc   CAR=vela_gt
// Shots: <label>_garage.png, <label>_street_dry.png, <label>_street_wet.png. Wrap in `flock /tmp/racing-gpu.lock`
// when other GPU tests may run (one game at a time on a laptop GPU).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] ?? 'shots';
const labels = process.argv.slice(3).length
  ? process.argv.slice(3).map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; })
  : [['before', 'hdri=0'], ['after', '']];
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const CITY = process.env.CITY ?? 'nyc';
const CAR = process.env.CAR ?? 'vela_gt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});

async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [page error]', String(e).slice(0, 300)));
  await page.goto(`${BASE}/?${query}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__game && window.__game.state && window.__game.state !== 'boot', null, { timeout: 240000, polling: 500 });
  return { ctx, page };
}

async function garageShot(extra, file) {
  const q = ['menu=1', 'touch=0', 'cap=0', 'user=shot_test', `car=${CAR}`, `city=${CITY}`, extra].filter(Boolean).join('&');
  const { ctx, page } = await open(q);
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), g = window.__game;
    if (document.querySelector('[data-act=uname-save]')) {
      const i = document.querySelector('#menu input'); i.focus(); i.value = 'shot_test'; i.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250); document.querySelector('[data-act=uname-save]').click(); await sleep(1500);
    }
    for (let i = 0; i < 90 && g.menu().tuning; i++) await sleep(500);
    if (g.menu().screen !== 'garage') { document.querySelector('[data-act=garage-open]')?.click(); await sleep(3000); }
    document.getElementById('menu').style.visibility = 'hidden';
    g.orbit.az = 0.8; g.orbit.el = 0.15; g.orbit.dist = 6.2; g.orbit.holdUntil = performance.now() + 120000;
  });
  await sleep(5000);
  await page.screenshot({ path: file });
  await ctx.close();
}

async function streetShot(extra, weather, file) {
  const q = ['menu=0', 'touch=0', 'cap=0', 'user=shot_test', `car=${CAR}`, `city=${CITY}`, `weather=${weather}`, extra].filter(Boolean).join('&');
  const { ctx, page } = await open(q);
  await page.evaluate(() => { const g = window.__game; if (g.input) g.input.hold = true; });
  await sleep(12000);   // tiles streamed, the car probe's six faces captured
  await page.screenshot({ path: file });
  const info = await page.evaluate(() => ({ weather: window.__game.worldClock?.weather, hour: window.__game.worldClock?.hour?.toFixed?.(2) }));
  console.log(`  ${path.basename(file)}: weather ${info.weather}, hour ${info.hour}`);
  await ctx.close();
}

for (const [label, extra] of labels) {
  console.log(label, extra ? `(${extra})` : '(default)');
  await garageShot(extra, path.join(out, `${label}_garage.png`));
  await streetShot(extra, 'dry', path.join(out, `${label}_street_dry.png`));
  await streetShot(extra, 'rain', path.join(out, `${label}_street_wet.png`));
}
await browser.close();
console.log('shots in', out);
