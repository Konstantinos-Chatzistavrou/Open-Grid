#!/usr/bin/env node
// Physics reference checkers.
//
//   node tools/physics/brake_reference.mjs               braking: FMVSS 135 envelope vs each car's friction limit
//   node tools/physics/brake_reference.mjs --tracks DIR  track geometry sanity for a folder of TUM-format CSVs
//
// Reference data: data/physics/brakes-reference.json (FMVSS 135, public domain) and
// data/validation/tracks-extra/ (TUM racetrack-database, LGPL-3.0). The tools only read: they never edit car data.
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const G = 9.81;
const args = process.argv.slice(2);
const trackDir = args.includes('--tracks') ? args[args.indexOf('--tracks') + 1] : null;
let failed = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ': ' + detail : ''}`);
};

function cars() {
  const dir = join(ROOT, 'data/cars');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.visual.json') && f !== 'catalog.json')
    .map((f) => ({ file: f, cfg: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

function braking() {
  const ref = JSON.parse(readFileSync(join(ROOT, 'data/physics/brakes-reference.json'), 'utf8'));
  console.log('FMVSS 135 braking reference (public domain): ' + ref.source.url);
  // self-check: the JSON table must match the published formula
  for (const r of ref.requirements) {
    const cold = 0.10 * r.v_kmh + 0.0060 * r.v_kmh ** 2;
    check(Math.abs(cold - r.cold_max_stop_m) < 0.01, `table matches formula at ${r.v_kmh} km/h`, `${cold.toFixed(2)} m`);
  }
  const at100 = ref.requirements.find((r) => r.v_kmh === 100);
  console.log(`\nAt 100 km/h the legal maximum is ${at100.cold_max_stop_m} m (cold) / ${at100.hot_max_stop_m} m (hot),`);
  console.log(`i.e. a mean deceleration of at least ${at100.implied_mean_decel_cold_g} g.\n`);
  console.log('car                        mu_f  mu_r   wf    a_eff(g)  stop100(m)  cold margin  verdict');
  for (const { file, cfg } of cars()) {
    const tf = cfg.tire_front ?? {}, tr = cfg.tire_rear ?? {};
    const muF = Number(tf.longitudinal?.mu ?? tf.lateral?.mu);
    const muR = Number(tr.longitudinal?.mu ?? tr.lateral?.mu);
    const wf = Number(cfg.chassis?.weight_front);
    if (!Number.isFinite(muF) || !Number.isFinite(muR) || !Number.isFinite(wf)) {
      check(false, 'car has tyre mu and weight_front', file);
      continue;
    }
    const a = G * (muF * wf + muR * (1 - wf));
    const v = 100 / 3.6;
    const d = (v * v) / (2 * a);
    const margin = at100.cold_max_stop_m / d;
    const ok = d <= at100.cold_max_stop_m && muF >= 0.5 && muF <= 2.0 && muR >= 0.5 && muR <= 2.0 && wf > 0.3 && wf < 0.7;
    if (!ok) failed++;
    console.log(
      `${basename(file, '.json').padEnd(26)} ${muF.toFixed(2)}  ${muR.toFixed(2)}  ${wf.toFixed(2)}  ${(a / G).toFixed(2).padStart(7)}  ${d.toFixed(1).padStart(9)}  ${margin.toFixed(2).padStart(10)}x  ${ok ? 'ok' : 'FAIL'}`,
    );
  }
  check(failed === 0, 'every car stops within the FMVSS 135 cold requirement at its tyre grip');
  console.log('\nNote: friction-limited best case (both axles at mu, no load-transfer/ABS/brake-torque limits).');
}

function tracks(dir) {
  const EXPECT = { Spa: 7004, Silverstone: 5891, Suzuka: 5807 };
  const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
  check(files.length > 0, 'tracks folder has CSV files', `${files.length}`);
  for (const f of files) {
    const rows = readFileSync(join(dir, f), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('#'))
      .map((l) => l.split(',').map(Number))
      .filter((r) => r.length >= 4 && r.every(Number.isFinite));
    if (rows.length < 20) { check(false, `${f}: enough points`, `${rows.length}`); continue; }
    let len = 0, minW = Infinity, maxW = -Infinity, minR = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i], b = rows[(i + 1) % rows.length];
      len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      const w = a[2] + a[3];
      minW = Math.min(minW, w); maxW = Math.max(maxW, w);
    }
    for (let i = 0; i < rows.length; i++) {
      const a = rows[(i - 1 + rows.length) % rows.length], b = rows[i], c = rows[(i + 1) % rows.length];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      if (area < 1e-6) continue;
      minR = Math.min(minR, (ab * bc * ca) / (4 * area));
    }
    const name = basename(f, '.csv');
    const exp = EXPECT[name];
    const within = exp ? Math.abs(len - exp) / exp < 0.03 : true;
    console.log(`${name.padEnd(14)} ${rows.length} pts  length ${len.toFixed(0)} m${exp ? ` (published ${exp}, ${(100 * Math.abs(len - exp) / exp).toFixed(2)}%)` : ''}  minR ${minR.toFixed(1)} m  width ${minW.toFixed(1)}-${maxW.toFixed(1)} m`);
    check(len > 1000 && len < 25000, `${name}: length plausible`);
    check(within, `${name}: length within 3% of published`);
    check(minR > 5, `${name}: minimum radius > 5 m`, `${minR.toFixed(1)} m`);
    check(minW >= 4 && maxW <= 40, `${name}: width 4-40 m`, `${minW.toFixed(1)}-${maxW.toFixed(1)}`);
  }
  console.log('\nTrack data: TUMFTM/racetrack-database, LGPL-3.0 (third-party; see data/validation/tracks-extra/SOURCE.md).');
}

if (trackDir) tracks(trackDir); else braking();
console.log(`\n${failed === 0 ? 'PASSED: 0 checks failed' : `FAILED: ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);
