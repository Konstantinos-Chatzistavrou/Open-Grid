#!/usr/bin/env node
// OpenGrid conformance runner: judges the FILES a simulation wrote (SPEC.md); it knows nothing about how they were made. Node 18+, no dependencies.
//
//   node conformance/run.mjs tyre    --impl <dir> [--columns fx,fy,mz] [--rtol 1e-6] [--manifest conformance/tyre/manifest.json]
//   node conformance/run.mjs vehicle --spec <spec.json> --logs <dir>
//   node conformance/run.mjs selftest --adapter <path to rs_conformance> [--car data/cars/vela_gt.json]    (the reference adapter run through the same judges, plus deliberately broken inputs)
//
// WHAT A PASS MEANS. tyre: your tyre model returns MFeval's numbers (the MATLAB reference implementation of Pacejka's Magic Formula 5.2 / 6.1 / 6.2, BSD-3, run under GNU Octave) on 393 operating points per tyre.
// vehicle: the logs obey physics the car's own spec implies (weights, drag, energy, grip, symmetry, determinism, step-size convergence). That is SELF-CONSISTENCY: it catches impossible or broken
// vehicle models, it does not show the car matches its real counterpart. A tyre pass is a statement about one equation set; a vehicle pass is not a statement about accuracy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const G = 9.80665;

// ---------------------------------------------------------------------------------------------- csv
function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) throw new Error(`${file}: no data rows`);
  const names = lines[0].split(',').map((s) => s.trim());
  const num = (s) => { const t = s.trim().toLowerCase(); if (t === '' ) return NaN; if (t === 'nan') return NaN; if (t === 'inf' || t === '+inf') return Infinity; if (t === '-inf') return -Infinity; return Number(t); };
  const rows = lines.slice(1).map((l) => l.split(',').map(num));
  const cols = {};
  names.forEach((n, i) => { cols[n.toLowerCase()] = rows.map((r) => r[i]); });
  return { names, cols, n: rows.length };
}

// ---------------------------------------------------------------------------------------------- tyre
const TYRE_COLS = ['fx', 'fy', 'fz', 'mx', 'my', 'mz', 'kappa', 'alpha', 'gamma', 'phit', 'vx', 'p', 're', 'rho', 'two_a', 't', 'mux', 'muy', 'omega', 'rl', 'two_b', 'mzr', 'cx', 'cy', 'cz', 'kya', 'sigmax', 'sigmay', 'instkya', 'kxk'];
const atolOf = (c) => (c === 're' || c === 'rho' || c === 'rl' ? 1e-7 : c === 'cz' ? 1.0 : 1e-9);

function compareTyre(ref, impl, { columns, rtol }) {
  const used = TYRE_COLS.filter((c) => c !== 'instkya' && impl.cols[c] && ref.cols[c] && (!columns || columns.includes(c)));
  const res = { compared: 0, skippedNaN: 0, radiusRows: 0, bad: {}, worstRel: 0, columns: used.length, rowsMatch: impl.n === ref.n };
  if (!res.rowsMatch) return res;
  for (let i = 0; i < ref.n; ++i) {
    const radiusFailed = !Number.isFinite(ref.cols.cz[i]);
    if (radiusFailed) ++res.radiusRows;
    for (const c of used) {
      if (radiusFailed && (c === 'rho' || c === 'rl' || c === 'cz')) continue;
      const r = ref.cols[c][i], m = impl.cols[c][i];
      if (!Number.isFinite(r)) { ++res.skippedNaN; continue; }      // the reference itself gave no number here
      ++res.compared;
      const d = Math.abs(m - r), tol = atolOf(c) + rtol * Math.abs(r);
      if (!(Number.isFinite(m) && d <= tol)) { (res.bad[c] ??= []).push({ row: i + 2, mine: m, ref: r }); }
      if (Number.isFinite(m)) res.worstRel = Math.max(res.worstRel, d / (Math.abs(r) + 1e-9));
    }
  }
  return res;
}

function runTyre() {
  const manifestPath = path.resolve(opt('--manifest', path.join(here, 'tyre/manifest.json')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dir = path.dirname(manifestPath);
  const implDir = opt('--impl');
  if (!implDir) { console.error('tyre: --impl <dir with one <tag>.csv per tyre> is required'); return 2; }
  const columns = opt('--columns') ? opt('--columns').toLowerCase().split(',') : null;
  const rtol = Number(opt('--rtol', manifest.tolerance?.rtol ?? 1e-6));
  let failed = 0, missing = 0;
  console.log(`tyre conformance against ${manifest.reference.name}: ${manifest.tyres.length} tyres, ${manifest.cases_count} cases each, rtol ${rtol}${columns ? ', columns ' + columns.join(',') : ''}`);
  for (const t of manifest.tyres) {
    const f = path.join(implDir, `${t.tag}.csv`);
    if (!fs.existsSync(f)) { console.log(`  [MISSING] ${t.tag}: ${f}`); ++missing; continue; }
    const ref = readCsv(path.resolve(dir, t.golden)), impl = readCsv(f);
    const r = compareTyre(ref, impl, { columns, rtol });
    const nBad = Object.values(r.bad).reduce((a, b) => a + b.length, 0);
    const ok = r.rowsMatch && nBad === 0 && r.compared > 0;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${t.tag.padEnd(26)} ${t.version.padEnd(5)} ${r.compared} values over ${r.columns} columns, worst relative deviation ${r.worstRel.toExponential(1)}${r.rowsMatch ? '' : `, ROW COUNT ${impl.n} != ${ref.n}`}${r.skippedNaN ? `, ${r.skippedNaN} reference NaN/Inf skipped` : ''}`);
    for (const [c, list] of Object.entries(r.bad).sort((a, b) => b[1].length - a[1].length).slice(0, 6)) console.log(`         ${c}: ${list.length} mismatches, e.g. case line ${list[0].row}: yours ${list[0].mine} reference ${list[0].ref}`);
    if (!ok) ++failed;
  }
  console.log(failed || missing ? `\n${failed} tyre(s) FAILED, ${missing} missing` : '\nall tyres conform');
  return failed || missing ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------- vehicle
function pathLength(c) { let s = 0; for (let i = 1; i < c.t.length; ++i) s += Math.hypot(c.x[i] - c.x[i - 1], c.y[i] - c.y[i - 1]); return s; }
function timeAt(c, pred, from = 0) { for (let i = from; i < c.t.length; ++i) if (pred(c.speed[i])) return c.t[i]; return NaN; }
function maxDecel(c, win = 0.25) {   // largest mean deceleration over a window, m/s^2
  let best = 0; let j = 0;
  for (let i = 0; i < c.t.length; ++i) { while (j < c.t.length && c.t[j] - c.t[i] < win) ++j; if (j >= c.t.length) break; best = Math.max(best, (c.speed[i] - c.speed[j]) / (c.t[j] - c.t[i])); }
  return best;
}
function maxAccel(c, win = 0.25) {
  let best = 0; let j = 0;
  for (let i = 0; i < c.t.length; ++i) { while (j < c.t.length && c.t[j] - c.t[i] < win) ++j; if (j >= c.t.length) break; best = Math.max(best, (c.speed[j] - c.speed[i]) / (c.t[j] - c.t[i])); }
  return best;
}
function circleFit(xs, ys) {   // Kasa algebraic least squares
  const n = xs.length; let sx = 0, sy = 0; for (let i = 0; i < n; ++i) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n; let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; ++i) { const u = xs[i] - mx, v = ys[i] - my; suu += u * u; svv += v * v; suv += u * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u; }
  const det = suu * svv - suv * suv;
  const uc = (0.5 * (suuu + suvv) * svv - 0.5 * (svvv + svuu) * suv) / det, vc = (0.5 * (svvv + svuu) * suu - 0.5 * (suuu + suvv) * suv) / det;
  return { cx: mx + uc, cy: my + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function vehicleChecks(spec, dir) {
  const out = [];
  const add = (level, name, detail) => out.push({ level, name, detail });
  const need = (f) => { const p = path.join(dir, f); if (!fs.existsSync(p)) { add('FAIL', `log ${f}`, 'missing'); return null; } return readCsv(p).cols; };
  const m = spec.mass_kg, rot = spec.rotating_mass_factor ?? 1.03, rho = spec.air_density_kg_m3 ?? 1.225;

  // 1. static weights: analytic
  let c = need('static.csv');
  if (c && c.fz_fl) {
    const idx = c.t.map((t, i) => (t >= 1.0 ? i : -1)).filter((i) => i >= 0);
    const f = ['fz_fl', 'fz_fr', 'fz_rl', 'fz_rr'].map((k) => mean(idx.map((i) => c[k][i])));
    const sum = f.reduce((a, b) => a + b, 0), front = (f[0] + f[1]) / sum;
    const lr = Math.max(Math.abs(f[0] - f[1]) / (f[0] + f[1]), Math.abs(f[2] - f[3]) / (f[2] + f[3]));
    add(Math.abs(sum / (m * G) - 1) <= 0.005 ? 'PASS' : 'FAIL', 'static: total wheel load = m g', `${sum.toFixed(0)} N against ${(m * G).toFixed(0)} N (${((sum / (m * G) - 1) * 100).toFixed(2)} %, allowed 0.5 %)`);
    add(Math.abs(front - spec.weight_front) <= 0.01 ? 'PASS' : 'FAIL', 'static: front weight share', `${(front * 100).toFixed(2)} % against ${(spec.weight_front * 100).toFixed(2)} % (allowed 1 point)`);
    add(lr <= 0.01 ? 'PASS' : 'FAIL', 'static: left / right equal', `largest left-right difference ${(lr * 100).toFixed(2)} % of the axle load (allowed 1 %)`);
  } else if (c) add('FAIL', 'static', 'columns fz_fl fz_fr fz_rl fz_rr are required');

  // 2. coast-down: analytic drag + rolling resistance, 97 -> 60 km/h
  c = need('coast.csv');
  if (c) {
    const hi = 27.0, lo = 60 / 3.6, ti = timeAt(c, (v) => v <= hi), tj = timeAt(c, (v) => v <= lo);
    if (Number.isFinite(ti) && Number.isFinite(tj)) {
      const meas = tj - ti; let ana = 0; const N = 400;
      for (let k = 0; k < N; ++k) { const v = lo + (hi - lo) * (k + 0.5) / N; const a = (0.5 * rho * spec.drag_area_m2 * v * v + (spec.rolling_resistance_c0 + spec.rolling_resistance_c2 * (v / 30) ** 2) * m * G) / (m * rot); ana += (hi - lo) / N / a; }
      const dev = meas / ana - 1;
      add(Math.abs(dev) <= 0.15 ? 'PASS' : 'FAIL', 'coast-down 97 -> 60 km/h vs drag and rolling resistance', `${meas.toFixed(2)} s measured, ${ana.toFixed(2)} s from 1/2 rho CdA v^2 + Crr m g (${(dev * 100).toFixed(1)} %, allowed 15 %)`);
    } else add('FAIL', 'coast-down', 'the log does not cover 97 -> 60 km/h');
  }

  // 3. braking
  c = need('brake.csv');
  if (c) {
    const v0 = c.speed[0]; let rise = 0; for (let i = 1; i < c.t.length; ++i) rise = Math.max(rise, c.speed[i] - c.speed[i - 1]);
    const a = maxDecel(c) / G, mu = spec.tyre_mu_long_peak, lim = 1.15 * mu + 0.05, d = pathLength(c), dMin = v0 * v0 / (2 * lim * G), dRef = v0 * v0 / (2 * mu * G);
    add(rise <= 0.05 ? 'PASS' : 'FAIL', 'braking: speed never rises', `largest single rise ${rise.toFixed(3)} m/s (allowed 0.05)`);
    add(a <= lim ? 'PASS' : 'FAIL', 'braking: deceleration within the tyres', `peak ${a.toFixed(2)} g against a tyre peak of ${mu.toFixed(2)} (limit 1.15 x + 0.05 g for downforce)`);
    add(d >= 0.97 * dMin ? 'PASS' : 'FAIL', 'braking: stopping distance not shorter than the tyres allow', `${d.toFixed(1)} m from ${(v0 * 3.6).toFixed(0)} km/h; the tyres' limit is ${dMin.toFixed(1)} m (v^2 / 2 mu g = ${dRef.toFixed(1)} m)`);
    add(d <= 3 * dRef ? 'PASS' : 'WARN', 'braking: stopping distance not absurdly long', `${(d / dRef).toFixed(2)} x v^2 / 2 mu g (warns above 3)`);
  }

  // 4. launch: energy
  c = need('launch.csv');
  if (c) {
    const t0 = timeAt(c, (v) => v > 0.2), t1 = timeAt(c, (v) => v >= 100 / 3.6);
    const ke = 0.5 * m * (100 / 3.6) ** 2, tMin = ke / (spec.peak_power_kw * 1000);
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      add(t1 - t0 >= 0.98 * tMin ? 'PASS' : 'FAIL', 'launch: 0-100 km/h not faster than the engine\'s energy allows', `${(t1 - t0).toFixed(2)} s; kinetic energy / peak power = ${tMin.toFixed(2)} s`);
      const a = maxAccel(c) / G, lim = 1.15 * spec.tyre_mu_long_peak + 0.05;
      add(a <= lim ? 'PASS' : 'FAIL', 'launch: acceleration within the tyres', `peak ${a.toFixed(2)} g against a tyre peak of ${spec.tyre_mu_long_peak.toFixed(2)}`);
    } else add('FAIL', 'launch', 'the log never reaches 100 km/h');
  }

  // 5. circles: kinematic consistency and left / right mirror
  const circ = {};
  for (const side of ['left', 'right']) {
    c = need(`circle_${side}.csv`);
    if (!c) continue;
    const last = c.t.map((t, i) => (t >= c.t[c.t.length - 1] - 8 ? i : -1)).filter((i) => i >= 0);
    const fit = circleFit(last.map((i) => c.x[i]), last.map((i) => c.y[i]));
    const v = mean(last.map((i) => c.speed[i])), ay = mean(last.map((i) => c.ay[i])), yr = mean(last.map((i) => c.yaw_rate[i])), st = mean(last.map((i) => c.steer_deg[i]));
    circ[side] = { R: fit.r, v, ay, yr, st };
    add(Math.abs(Math.abs(ay) / (v * v / fit.r) - 1) <= 0.03 ? 'PASS' : 'FAIL', `circle ${side}: lateral acceleration = v^2 / R of the path`, `${Math.abs(ay).toFixed(3)} m/s^2 against ${(v * v / fit.r).toFixed(3)} (R fitted ${fit.r.toFixed(1)} m, allowed 3 %)`);
    add(Math.abs(Math.abs(yr) / (v / fit.r) - 1) <= 0.03 ? 'PASS' : 'FAIL', `circle ${side}: yaw rate = v / R of the path`, `${Math.abs(yr).toFixed(4)} rad/s against ${(v / fit.r).toFixed(4)} (allowed 3 %)`);
  }
  if (circ.left && circ.right) {
    const L = circ.left, R = circ.right;
    add(L.ay > 0 && R.ay < 0 && L.yr > 0 && R.yr < 0 && L.st * R.st < 0 ? 'PASS' : 'FAIL', 'circles: left turns left, right turns right', `ay ${L.ay.toFixed(2)} / ${R.ay.toFixed(2)}, yaw rate ${L.yr.toFixed(3)} / ${R.yr.toFixed(3)}, steer ${L.st.toFixed(2)} / ${R.st.toFixed(2)} deg`);
    // compare the per-radius quantities, so a slightly different path radius does not count against the car
    const gl = Math.abs(L.ay) * L.R / (L.v * L.v), gr = Math.abs(R.ay) * R.R / (R.v * R.v);
    const sl = Math.abs(L.st) / (spec.wheelbase_m / L.R * 180 / Math.PI), sr = Math.abs(R.st) / (spec.wheelbase_m / R.R * 180 / Math.PI);
    add(Math.abs(sl / sr - 1) <= 0.05 ? 'PASS' : 'FAIL', 'circles: steering needed left = right (mirror symmetry)', `steer / Ackermann angle ${sl.toFixed(3)} left, ${sr.toFixed(3)} right (${((sl / sr - 1) * 100).toFixed(1)} %, allowed 5 %)`);
    add(Math.abs(gl / gr - 1) <= 0.03 ? 'PASS' : 'FAIL', 'circles: lateral acceleration left = right', `${gl.toFixed(3)} left, ${gr.toFixed(3)} right of v^2 / R (${((gl / gr - 1) * 100).toFixed(1)} %, allowed 3 %)`);
  }

  // 6. determinism and step-size convergence
  const a1 = path.join(dir, 'brake.csv'), a2 = path.join(dir, 'brake_repeat.csv'), a3 = path.join(dir, 'brake_half_dt.csv');
  if (fs.existsSync(a1) && fs.existsSync(a2)) add(fs.readFileSync(a1, 'utf8') === fs.readFileSync(a2, 'utf8') ? 'PASS' : 'FAIL', 'determinism: the same braking run twice is identical', 'brake.csv = brake_repeat.csv byte for byte');
  if (fs.existsSync(a1) && fs.existsSync(a3)) {
    const b1 = readCsv(a1).cols, b3 = readCsv(a3).cols, d1 = pathLength(b1), d3 = pathLength(b3), t1 = b1.t[b1.t.length - 1], t3 = b3.t[b3.t.length - 1];
    add(Math.abs(d3 / d1 - 1) <= 0.03 && Math.abs(t3 / t1 - 1) <= 0.03 ? 'PASS' : 'FAIL', 'step size: halving the time step changes the stop by < 3 %', `distance ${d1.toFixed(2)} -> ${d3.toFixed(2)} m (${((d3 / d1 - 1) * 100).toFixed(2)} %), time ${t1.toFixed(2)} -> ${t3.toFixed(2)} s (${((t3 / t1 - 1) * 100).toFixed(2)} %)`);
  }
  return out;
}

function runVehicle() {
  const specPath = opt('--spec'), dir = opt('--logs');
  if (!specPath || !dir) { console.error('vehicle: --spec <spec.json> --logs <dir> are required'); return 2; }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const res = vehicleChecks(spec, dir);
  let fail = 0, warn = 0;
  console.log(`vehicle conformance of ${spec.name ?? specPath}`);
  for (const r of res) { console.log(`  [${r.level}] ${r.name}: ${r.detail}`); fail += r.level === 'FAIL'; warn += r.level === 'WARN'; }
  console.log(`\n${fail} FAIL, ${warn} WARN. These are self-consistency checks: they do not show the vehicle matches its real counterpart.`);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify({ spec: spec.name, fail, warn, checks: res }, null, 2));
  return fail ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------- selftest
function runSelftest() {
  const adapter = opt('--adapter');
  if (!adapter || !fs.existsSync(adapter)) { console.error('selftest: --adapter <path to rs_conformance> is required'); return 2; }
  const repo = path.join(here, '..');
  const car = path.resolve(opt('--car', path.join(repo, 'data/cars/vela_gt.json')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_conf_'));
  let failures = 0;
  const check = (what, ok, extra = '') => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${what}${ok ? '' : ' ' + extra}`); if (!ok) ++failures; };
  const manifestPath = path.join(here, 'tyre/manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('tyre: the reference adapter against MFeval\'s committed output');
  const implDir = path.join(tmp, 'tyre'); fs.mkdirSync(implDir);
  for (const t of manifest.tyres) {
    const r = spawnSync(adapter, ['tyre', path.resolve(here, 'tyre', t.tir), path.resolve(here, 'tyre', manifest.cases), path.join(implDir, `${t.tag}.csv`)], { encoding: 'utf8' });
    if (r.status !== 0) { check(`adapter runs on ${t.tag}`, false, r.stderr); continue; }
    const ref = readCsv(path.resolve(here, 'tyre', t.golden)), impl = readCsv(path.join(implDir, `${t.tag}.csv`));
    const c = compareTyre(ref, impl, { columns: null, rtol: manifest.tolerance.rtol });
    check(`${t.tag}: equals MFeval (${c.compared} values)`, c.rowsMatch && Object.keys(c.bad).length === 0 && c.compared > 1000);
  }
  // negative controls: the judge must reject a model that is a little off
  const tag = manifest.tyres[0].tag, ref0 = readCsv(path.resolve(here, 'tyre', manifest.tyres[0].golden)), impl0 = readCsv(path.join(implDir, `${tag}.csv`));
  const bent = JSON.parse(JSON.stringify(impl0)); bent.cols.fy = bent.cols.fy.map((v) => v * 1.001);
  check('negative control: a tyre whose Fy is 0.1 % high is rejected', Object.keys(compareTyre(ref0, bent, { columns: null, rtol: 1e-6 }).bad).includes('fy'));
  const shifted = JSON.parse(JSON.stringify(impl0)); shifted.cols.mz = shifted.cols.mz.map((v) => v + 0.01);
  check('negative control: a tyre whose Mz is 0.01 N m off is rejected', Object.keys(compareTyre(ref0, shifted, { columns: null, rtol: 1e-6 }).bad).includes('mz'));
  const subset = compareTyre(ref0, impl0, { columns: ['fx', 'fy'], rtol: 1e-6 });
  check('a subset of columns can be judged (a model without Mx, Mz, ...)', subset.columns === 2 && Object.keys(subset.bad).length === 0);

  if (!fs.existsSync(car)) { console.log(`vehicle: skipped (no car file at ${car}; pass --car <car.json>)`); fs.rmSync(tmp, { recursive: true, force: true }); console.log(failures ? `\n${failures} FAILED` : '\nselftest passed (tyre only)'); return failures ? 1 : 0; }
  console.log('vehicle: the reference adapter on ' + path.basename(car));
  const logs = path.join(tmp, 'veh'); fs.mkdirSync(logs);
  const r = spawnSync(adapter, ['vehicle', car, logs], { encoding: 'utf8' });
  check('adapter writes the logs', r.status === 0, r.stderr);
  const spec = JSON.parse(fs.readFileSync(path.join(logs, 'spec.json'), 'utf8'));
  const res = vehicleChecks(spec, logs);
  for (const x of res) console.log(`    [${x.level}] ${x.name}: ${x.detail}`);
  check('every vehicle check passes on the reference adapter', res.length >= 14 && res.every((x) => x.level !== 'FAIL'));
  // negative controls on the logs
  const mutate = (file, fn) => { const d = path.join(tmp, 'mut_' + Math.random().toString(36).slice(2)); fs.cpSync(logs, d, { recursive: true }); const p = path.join(d, file); const lines = fs.readFileSync(p, 'utf8').split('\n'); const head = lines[0].split(','); fs.writeFileSync(p, [lines[0], ...lines.slice(1).map((l) => (l ? fn(l.split(',').map(Number), head).join(',') : l))].join('\n')); return d; };
  const failsOf = (d, spc = spec) => vehicleChecks(spc, d).filter((x) => x.level === 'FAIL').map((x) => x.name);
  let f = failsOf(mutate('static.csv', (v, h) => { v[h.indexOf('fz_fl')] *= 1.05; return v; }));
  check('negative control: a front-left wheel load 5 % high is caught (weight, left / right)', f.some((n) => n.startsWith('static')));
  f = failsOf(mutate('coast.csv', (v, h) => { const i = h.indexOf('t'); v[i] *= 0.6; return v; }));
  check('negative control: a car that loses speed 1.7 x too fast is caught by the coast-down', f.some((n) => n.startsWith('coast-down')));
  f = failsOf(mutate('brake.csv', (v, h) => { v[h.indexOf('t')] *= 0.5; return v; }));
  check('negative control: braking in half the time (3 g) is caught', f.some((n) => n.startsWith('braking')));
  f = failsOf(mutate('launch.csv', (v, h) => { v[h.indexOf('t')] *= 0.2; return v; }));
  check('negative control: a launch 5 x too quick (energy) is caught', f.some((n) => n.startsWith('launch')));
  f = failsOf(mutate('circle_right.csv', (v, h) => { v[h.indexOf('steer_deg')] *= 0.8; return v; }));
  check('negative control: 20 % less steering on the right than the left is caught (mirror symmetry)', f.some((n) => n.startsWith('circles: steering')));
  f = failsOf(mutate('brake_half_dt.csv', (v, h) => { v[h.indexOf('x')] *= 1.08; return v; }));
  check('negative control: a stop 8 % longer at half the step is caught (convergence)', f.some((n) => n.startsWith('step size')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nselftest passed');
  return failures ? 1 : 0;
}

const code = cmd === 'tyre' ? runTyre() : cmd === 'vehicle' ? runVehicle() : cmd === 'selftest' ? runSelftest() : (console.error('usage: run.mjs tyre|vehicle|selftest (see the header of this file)'), 2);
process.exit(code);
