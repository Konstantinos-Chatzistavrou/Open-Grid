#!/usr/bin/env node
// Import powertrain reference data from legally usable sources.
//
//  - Engine maps + gear ratios: Project Chrono vehicle JSONs (BSD-3-Clause), pinned commit.
//    These are *simplified reference maps*, not measured dyno curves. Confidence is recorded as such.
//  - Final drives / gear counts: US EPA test-car certification CSVs (public domain, 17 USC 105).
//
//   node tools/physics/import_powertrain.mjs            # use data/powertrain/source + the EPA cache
//   node tools/physics/import_powertrain.mjs --fetch    # (re)download the Chrono sources at the pinned commit
//
// Outputs: data/powertrain/reference-powertrains.json, data/powertrain/final-drives.json,
//          data/powertrain/MANIFEST.json (urls, licences, sha256 of every input).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMMIT = 'e166f3e5a1383741e86cf1e195a46eba4a66473d';
const RAW = 'https://raw.githubusercontent.com/projectchrono/chrono/' + COMMIT;
const OUT = resolve('data/powertrain');
const SRC = resolve(OUT, 'source');

// vehicle -> powertrain files we use (engine + transmission), and the label we publish under
const VEHICLES = [
  { id: 'audi', name: 'Audi (Chrono example, 1.8T-like 250 Nm)', dir: 'data/vehicle/audi/json', engine: 'audi_EngineSimpleMap.json', trans: 'audi_ManualTransmissionShafts.json', layout: 'rwd' },
  { id: 'sedan', name: 'Sedan (Chrono example, 370 Nm I6-like)', dir: 'data/vehicle/sedan/powertrain', engine: 'Sedan_EngineSimpleMap.json', trans: 'Sedan_ManualTransmissionShafts.json', layout: 'rwd' },
  { id: 'uazbus', name: 'UAZ bus (Chrono example, diesel van)', dir: 'data/vehicle/uaz/powertrain', engine: 'UAZBUS_EngineSimpleMap.json', trans: 'UAZBUS_AutomaticTransmissionSimpleMap.json', layout: 'rwd' },
  { id: 'citybus', name: 'City bus (Chrono example, heavy diesel)', dir: 'data/vehicle/citybus/powertrain', engine: 'CityBus_EngineSimpleMap.json', trans: 'CityBus_AutomaticTransmissionSimpleMap.json', layout: 'rwd' },
];

/** Chrono JSON files contain // comments: strip them without touching string contents. */
function parseChrono(text) {
  let out = '', str = false, esc = false, i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (str) {
      out += c;
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false;
      i++;
      continue;
    }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    out += c; i++;
  }
  return JSON.parse(out);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const manifest = { fetched: new Date().toISOString(), commit: COMMIT, inputs: [] };
const grab = async (path) => {
  const dest = resolve(SRC, path);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  if (process.argv.includes('--fetch') || !existsSync(dest)) {
    const res = await fetch(RAW + '/' + path, { headers: { 'user-agent': 'open-grid-powertrain-data' } });
    if (!res.ok) throw new Error('fetch failed ' + path + ' ' + res.status);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(dest);
  manifest.inputs.push({ path, url: RAW + '/' + path, licence: 'BSD-3-Clause (Project Chrono)', sha256: sha(buf) });
  return buf.toString('utf8');
};

/** Chrono stores shaft speed ratios for these gearboxes (out/in, < 1 and ascending); invert to conventional ratios. */
function gears(json) {
  const box = json['Gear Box'] || {};
  const rev = box['Reverse Gear Ratio'];
  const fwd = box['Forward Gear Ratios'] || [];
  // Chrono's Shafts/SimpleMap gearboxes list shaft SPEED ratios (out/in): they ascend from a low gear
  // (e.g. 0.294) to an overdrive (>1). Conventional gear ratios descend from >1. Ascending => invert.
  const speedRatios = fwd.length > 1 && fwd.every((r, i) => i === 0 || r > fwd[i - 1]);
  const conv = (r) => (speedRatios ? 1 / r : r);
  return {
    convention: speedRatios ? 'chrono shaft-speed ratio (out/in) inverted to conventional gear ratio' : 'conventional gear ratio as stored',
    gear_ratios: [conv(rev), 0, ...fwd.map(conv)].map((v) => +v.toFixed(4)),
  };
}

function engine(json) {
  const maxRpm = json['Maximal Engine Speed RPM'] || json['Max Engine Speed RPM'] || null;
  // keep the full-load curve only: drop the sub-idle points and the non-positive engine-braking tail some
  // Chrono maps append at the limiter (that belongs to the zero-throttle/friction map, not full load)
  const curve = (json['Map Full Throttle'] || []).filter(([rpm, nm]) => rpm >= 800 && rpm <= (maxRpm || 1e9) && Number.isFinite(nm) && nm > 0);
  if (curve.length < 3) return null;
  const km = 2 * Math.PI / 60;
  let peakT = { rpm: 0, nm: 0 }, peakP = { rpm: 0, kw: 0 };
  for (const [rpm, nm] of curve) {
    if (nm > peakT.nm) peakT = { rpm, nm };
    const kw = nm * rpm * km / 1000;
    if (kw > peakP.kw) peakP = { rpm, kw };
  }
  return {
    curve: curve.map(([rpm, nm]) => [Math.round(rpm), +nm.toFixed(1)]),
    idle_rpm: 800,
    redline_rpm: maxRpm,
    peak_torque_nm: peakT.nm,
    peak_torque_rpm: peakT.rpm,
    peak_power_kw: +peakP.kw.toFixed(1),
    peak_power_rpm: peakP.rpm,
  };
}

const entries = [];
for (const v of VEHICLES) {
  const eng = engine(parseChrono(await grab(v.dir + '/' + v.engine)));
  const tr = gears(parseChrono(await grab(v.dir + '/' + v.trans)));
  if (!eng) { console.warn('skip (no full-throttle map):', v.id); continue; }
  entries.push({
    id: v.id,
    name: v.name,
    layout: v.layout,
    engine: {
      torque_curve: eng.curve,
      idle_rpm: eng.idle_rpm,
      redline_rpm: eng.redline_rpm,
      peak_torque_nm: eng.peak_torque_nm,
      peak_torque_rpm: eng.peak_torque_rpm,
      peak_power_kw: eng.peak_power_kw,
      peak_power_rpm: eng.peak_power_rpm,
    },
    drivetrain: { gear_ratios: tr.gear_ratios, ratio_convention: tr.convention },
    source: {
      upstream: RAW + '/' + v.dir + '/' + v.engine,
      transmission: RAW + '/' + v.dir + '/' + v.trans,
      commit: COMMIT,
      licence: 'BSD-3-Clause (Project Chrono)',
    },
    confidence: 'low-medium: simplified example maps in a BSD-3 reference simulator, NOT measured dyno data. Curve shape is plausible, absolute values are not certified for the named vehicle.',
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'reference-powertrains.json'), JSON.stringify({
  schema: 'open-grid/powertrain-reference@1',
  note: 'Reference engine and gearbox data for validation and scaling. Chrono maps are simplified examples, not measurements; see docs/powertrain-data.md.',
  licence: 'BSD-3-Clause (Project Chrono)',
  commit: COMMIT,
  entries,
}, null, 2) + '\n');

// ---- final drives and gear counts: EPA certification CSVs (public domain) ----
const CACHE = resolve('data/validation/.cache');
const EPA = [
  { file: 'epa-2015.csv', url: 'https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy' },
  { file: 'epa-2016.csv', url: 'https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy' },
];
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
const finalDrives = [];
for (const e of EPA) {
  const p = resolve(CACHE, e.file);
  if (!existsSync(p)) { console.warn('missing EPA cache', p); continue; }
  const buf = readFileSync(p);
  manifest.inputs.push({ path: p, url: e.url, licence: 'public domain (US Government, 17 USC 105)', sha256: sha(buf) });
  const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  const head = parseCsvLine(lines[0]).map((h) => h.replace(/^"|"$/g, ''));
  const col = (name) => head.indexOf(name);
  const iAxle = col('Axle Ratio'), iGears = col('# of Gears'), iTrans = col('Tested Transmission Type');
  const iDisp = col('Test Veh Displacement (L)'), iHp = col('Rated Horsepower'), iMake = col('Represented Test Veh Make'), iModel = col('Represented Test Veh Model'), iYear = col('Model Year');
  if (iAxle < 0 || iGears < 0) { console.warn('unexpected columns in', e.file); continue; }
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const axle = parseFloat(f[iAxle]), gears = parseInt(f[iGears], 10);
    if (!Number.isFinite(axle) || axle < 1 || axle > 8 || !Number.isFinite(gears) || gears < 3) continue;
    finalDrives.push({
      year: parseInt(f[iYear], 10) || null,
      make: (f[iMake] || '').trim(), model: (f[iModel] || '').trim(),
      transmission: (f[iTrans] || '').trim(), gears,
      displacement_l: parseFloat(f[iDisp]) || null,
      rated_hp: parseInt(f[iHp], 10) || null,
      final_drive: axle,
      source: e.file,
      licence: 'public domain (US EPA certification data, 17 USC 105)',
      confidence: 'high: manufacturer-submitted certification data',
    });
  }
}
// one row per (year, make, model, transmission, gears, axle) to keep the file compact
const seen = new Set();
const compact = [];
for (const r of finalDrives) {
  const k = [r.year, r.make, r.model, r.transmission, r.gears, r.final_drive].join('|');
  if (seen.has(k)) continue;
  seen.add(k); compact.push(r);
}
compact.sort((a, b) => (a.make + a.model).localeCompare(b.make + b.model) || a.gears - b.gears || a.final_drive - b.final_drive);
writeFileSync(resolve(OUT, 'final-drives.json'), JSON.stringify({
  schema: 'open-grid/final-drives@1',
  note: 'Axle ratios and gear counts from EPA certification data (public domain). Use for real-vehicle references; fictional cars should cite them as class proxies.',
  licence: 'public domain (US EPA, 17 USC 105)',
  rows: compact,
}, null, 2) + '\n');
writeFileSync(resolve(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('reference-powertrains:', entries.length, 'engines');
console.log('final-drives:', compact.length, 'real vehicle configurations');
