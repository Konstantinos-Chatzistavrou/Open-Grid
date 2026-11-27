#!/usr/bin/env node
// A driveable car (schema car/1) from a few numbers and a tyre property file: the "my tyre data in, car out" step of docs/own_tyre_data.md.
//
//   node tools/new_car.mjs --name "My Car" --layout rwd --mass 1300 --wheelbase 2.6 --track 1.55 --cg-height 0.5 --weight-front 0.52 \
//        --power-kw 250 --redline 7500 --tyre my_tyre.tir [--tyre-rear other.tir] [--id my_car] [--out data/cars] [--template vela_gt] \
//        [--visual-from vela_gt] [--compound road|semi_slick|slick] [--cda 0.65 --cla 0.3] [--top-speed-kmh 250]
//
// WHAT IS YOURS and what is the template's. Yours (taken as given): mass, wheelbase, track, CG height, front weight share, peak power, redline, the tyres (the file's own grip, stiffness, load and camber
// sensitivity, aligning torque, vertical stiffness, size). Derived by SCALING a shipped car of the same layout (--template, default: rwd vela_gt, fwd mistra_200t, awd kaze_ryujin): inertias (mass x length^2),
// spring / damper / anti-roll rates (so the ride frequency stays the template's), suspension hardpoints (track and wheel radius), torque-curve shape (power and rpm), gear ratios (final drive set so the redline
// gives the template's speed, or --top-speed-kmh), brake torque (mass x radius), aero (the template's unless --cda / --cla), clutch size, tyre relaxation lengths, thermal compound. Those are PLAUSIBLE numbers for a
// car of that size, not data about your car: replace them with real ones where you have them. The visual reuses the template's model (--visual-from): its wheels line up only if wheelbase and track are close.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const num = (k, d) => { const v = opt(k); return v === undefined ? d : Number(v); };
const die = (m) => { console.error(`new_car: ${m}`); process.exit(1); };
const r5 = (x) => Number(Number(x).toPrecision(5));

const name = opt('--name'), layout = opt('--layout', 'rwd');
const mass = num('--mass'), wheelbase = num('--wheelbase'), powerKw = num('--power-kw'), redline = num('--redline');
const tyreFront = opt('--tyre'), tyreRear = opt('--tyre-rear', tyreFront);
if (!name || !mass || !wheelbase || !powerKw || !redline || !tyreFront) {
  die('required: --name --mass (kg) --wheelbase (m) --power-kw --redline (rpm) --tyre <file.tir>   (optional: --layout rwd|fwd|awd --track --cg-height --weight-front --id --out --template --visual-from --tyre-rear --compound --cda --cla --top-speed-kmh)');
}
if (!['rwd', 'fwd', 'awd'].includes(layout)) die('--layout must be rwd, fwd or awd');
if (mass < 300 || mass > 6000) die('--mass should be in kg (300 .. 6000)');
if (wheelbase < 1.2 || wheelbase > 5) die('--wheelbase should be in metres (1.2 .. 5)');
if (powerKw < 5 || powerKw > 1500) die('--power-kw should be in kW (5 .. 1500)');
if (redline < 2500 || redline > 20000) die('--redline should be in rpm (2500 .. 20000)');

const dataDir = path.join(root, 'data');
const templateId = opt('--template', { rwd: 'vela_gt', fwd: 'mistra_200t', awd: 'kaze_ryujin' }[layout]);
const tplPath = path.join(dataDir, 'cars', `${templateId}.json`);
if (!fs.existsSync(tplPath)) die(`template car ${tplPath} not found`);
const T = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
if (T.drivetrain.layout !== layout) die(`template ${templateId} is ${T.drivetrain.layout}, not ${layout}: pick a --template with the same layout`);
const C = JSON.parse(JSON.stringify(T));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const id = opt('--id', slug(name));
const outDir = path.resolve(opt('--out', path.join(dataDir, 'cars')));

// ---- tyres: the file's own numbers (tools/tir2car.mjs converts them), the car's size from the file's geometry
function readTir(file) {
  const P = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*([^$!]*)/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^'|'$/g, '');
    P[m[1]] = /^[-+0-9.eE]+$/.test(v) ? Number(v) : v;
  }
  return P;
}
function tyreFrom(file, tplTyre) {
  if (!fs.existsSync(file)) die(`tyre file ${file} not found`);
  const P = readTir(file);
  let blk;
  try { blk = JSON.parse(execFileSync(process.execPath, [path.join(root, 'tools', 'tir2car.mjs'), file], { encoding: 'utf8' })); }
  catch (e) { die(`tools/tir2car.mjs could not convert ${file}: ${e.message}`); }
  const r0 = typeof P.UNLOADED_RADIUS === 'number' ? P.UNLOADED_RADIUS : tplTyre.radius_m;
  const w = typeof P.WIDTH === 'number' ? P.WIDTH : tplTyre.section_width_m;
  const ar = typeof P.ASPECT_RATIO === 'number' ? P.ASPECT_RATIO : tplTyre.aspect_ratio;
  const rim = typeof P.RIM_RADIUS === 'number' ? P.RIM_RADIUS : r0 - w * ar;
  const t = JSON.parse(JSON.stringify(tplTyre));
  Object.assign(t, blk);                              // the file's curves, load rating, vertical stiffness, carcass
  t.compound = opt('--compound', tplTyre.compound ?? 'road');
  t.radius_m = r5(r0);
  t.size = `${Math.round(w * 1000)}/${Math.round(ar * 100)} R${Math.round(rim * 2 / 0.0254)}`;
  // wheel + tyre inertia ~ mass x r^2 with mass ~ width x radius: scaled from the template's (an estimate)
  t.inertia_kgm2 = r5(tplTyre.inertia_kgm2 * (w / tplTyre.section_width_m) * (r0 / tplTyre.radius_m) ** 3);
  t.section_width_m = r5(w);
  t.aspect_ratio = r5(ar);
  t.source = `${path.basename(file)}, converted by tools/tir2car.mjs; size, inertia and the rest of this block from tools/new_car.mjs`;
  return t;
}
C.tire_front = tyreFrom(tyreFront, T.tire_front);
C.tire_rear = tyreFrom(tyreRear, T.tire_rear ?? T.tire_front);

// ---- chassis
const wf = num('--weight-front', T.chassis.weight_front);
const cgh = num('--cg-height', T.chassis.cg_height_m * Math.cbrt(mass / T.chassis.mass_kg));
const trackF = num('--track', T.front_axle.track_m), trackR = num('--track-rear', trackF * (T.rear_axle.track_m / T.front_axle.track_m));
const mr = mass / T.chassis.mass_kg, lr = wheelbase / T.chassis.wheelbase_m;
Object.assign(C.chassis, {
  mass_kg: mass, cg_height_m: r5(cgh), weight_front: wf, wheelbase_m: wheelbase,
  inertia_pitch_kgm2: Math.round(T.chassis.inertia_pitch_kgm2 * mr * lr * lr),
  inertia_yaw_kgm2: Math.round(T.chassis.inertia_yaw_kgm2 * mr * lr * lr),
  inertia_roll_kgm2: Math.round(T.chassis.inertia_roll_kgm2 * mr * (trackF / T.front_axle.track_m) ** 2),
  torsional_stiffness_nm_per_deg: Math.round((T.chassis.torsional_stiffness_nm_per_deg ?? 0) * mr),
});

// ---- axles: rates scale with the corner mass (same ride frequency as the template), hardpoints with track and wheel radius
function scaleAxle(ax, tplAx, track, cornerRatio, tyreR, tplR) {
  const trackRatio = track / tplAx.track_m, rr = tyreR / tplR;
  ax.track_m = r5(track);
  for (const k of ['spring_rate_n_per_m', 'bump_stop_rate_n_per_m', 'damper_bump_ns_per_m', 'damper_rebound_ns_per_m', 'anti_roll_rate_n_per_m']) if (typeof tplAx[k] === 'number') ax[k] = Math.round(tplAx[k] * cornerRatio);
  if (typeof tplAx.handbrake_torque_nm === 'number') ax.handbrake_torque_nm = Math.round(tplAx.handbrake_torque_nm * mr);
  const k = ax.kinematics;
  if (k) for (const [key, v] of Object.entries(k)) if (Array.isArray(v) && v.length === 3) k[key] = [v[0], r5(v[1] * trackRatio), r5(v[2] * rr)];
}
scaleAxle(C.front_axle, T.front_axle, trackF, (mass * wf) / (T.chassis.mass_kg * T.chassis.weight_front), C.tire_front.radius_m, T.tire_front.radius_m);
scaleAxle(C.rear_axle, T.rear_axle, trackR, (mass * (1 - wf)) / (T.chassis.mass_kg * (1 - T.chassis.weight_front)), C.tire_rear.radius_m, (T.tire_rear ?? T.tire_front).radius_m);

// ---- engine: the template's torque curve shape, rpm axis to the new redline, torque to the requested peak power
const s = redline / T.engine.redline_rpm;
let p0 = 0;
for (const [rpm, tq] of T.engine.torque_curve) p0 = Math.max(p0, tq * rpm * 2 * Math.PI / 60);
const tScale = (powerKw * 1000) / (s * p0);
C.engine.torque_curve = T.engine.torque_curve.map(([rpm, tq]) => [Math.round(rpm * s), r5(tq * tScale)]);
C.engine.idle_rpm = Math.round(T.engine.idle_rpm * s);
C.engine.redline_rpm = redline;
const peakTq = Math.max(...C.engine.torque_curve.map((p) => p[1]));

// ---- aero
if (opt('--cda')) C.aero.drag_area_m2 = Number(opt('--cda'));
if (opt('--cla')) C.aero.downforce_area_m2 = Number(opt('--cla'));

// ---- drivetrain: final drive for the same speed at the new redline (or --top-speed-kmh), clutch for the new torque
const driveR = layout === 'fwd' ? C.tire_front.radius_m : C.tire_rear.radius_m, driveR0 = layout === 'fwd' ? T.tire_front.radius_m : (T.tire_rear ?? T.tire_front).radius_m;
const topGear = T.drivetrain.gear_ratios[T.drivetrain.gear_ratios.length - 1];
// Gearing: top gear reaches the redline slightly above the speed the engine can actually hold (power at the wheels = drag + rolling resistance, 90 % driveline efficiency), unless --top-speed-kmh is given.
// Scaling the template's final drive blindly would gear a 110 kW hatchback for 330 km/h.
const crr = C.tire_rear.rolling_resistance ?? 0.012, cdA = C.aero.drag_area_m2 ?? 0.7;
let vmax = 30;
for (let i = 0; i < 80; ++i) vmax = Math.cbrt((0.9 * powerKw * 1000 - crr * mass * 9.81 * vmax) / (0.5 * 1.2 * cdA));
const topKmh = num('--top-speed-kmh');
const targetV = topKmh ? topKmh / 3.6 : vmax * 1.05;
const fd = (redline * 2 * Math.PI / 60 * driveR) / (targetV * topGear);
const driven = Math.max(10, Math.round(fd * 10));
C.drivetrain.final_drive_teeth = [driven, 10];
C.drivetrain.final_drive = r5(driven / 10);
C.drivetrain.clutch_max_torque_nm = Math.ceil(peakTq * 1.5 / 50) * 50;

// ---- brakes
C.brakes.max_total_torque_nm = Math.round(T.brakes.max_total_torque_nm * mr * (driveR / driveR0));
C.brakes.bias_front = r5(Math.min(0.85, Math.max(0.5, T.brakes.bias_front + (wf - T.chassis.weight_front))));

C.name = name;
C.notes = `Generated by tools/new_car.mjs from the template ${templateId} and the tyre file ${path.basename(tyreFront)}${tyreRear !== tyreFront ? ' / ' + path.basename(tyreRear) : ''}. GIVEN: mass, wheelbase, track, CG height, front weight share, peak power, redline, tyres. ` +
  `SCALED from the template, plausible but not data about this car: inertias, spring / damper / anti-roll rates, suspension hardpoints, torque-curve shape, gear ratios, brakes, aero, clutch, tyre relaxation lengths. Replace them with real numbers where you have them.`;

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${id}.json`);
fs.writeFileSync(outFile, JSON.stringify(C, null, 2) + '\n');
console.log(`wrote ${outFile}`);

// ---- visual: the template's (or --visual-from) model as a placeholder
let visFrom = opt('--visual-from', templateId);
if (!fs.existsSync(path.join(dataDir, 'cars', `${visFrom}.visual.json`)) && !opt('--visual-from')) {
  console.log(`(the template ${templateId} has no 3D model: using vela_gt's as the placeholder; --visual-from <car id> picks another)`);
  visFrom = 'vela_gt';
}
const visSrc = path.join(dataDir, 'cars', `${visFrom}.visual.json`);
if (fs.existsSync(visSrc)) {
  const V = JSON.parse(fs.readFileSync(visSrc, 'utf8'));
  fs.writeFileSync(path.join(outDir, `${id}.visual.json`), JSON.stringify(V, null, 2) + '\n');
  console.log(`wrote ${path.join(outDir, `${id}.visual.json`)} (reuses the model of ${visFrom}: wheels line up only if wheelbase and track are close; see docs/adding_a_car.md for a real model)`);
}

// ---- derived numbers worth a glance
const kw = powerKw;
console.log(`\n${name}: ${mass} kg, ${wheelbase} m wheelbase, ${kw} kW (${(kw / (mass / 1000)).toFixed(0)} kW/t), ${layout}, ${C.tire_front.size} front / ${C.tire_rear.size} rear, front tyre grip mu ${C.tire_front.lateral.mu}, nominal load ${C.tire_front.fz0_n} N`);
const staticFront = mass * 9.81 * wf / 2;
console.log(`static front tyre load ${Math.round(staticFront)} N against the tyre's nominal ${C.tire_front.fz0_n} N`);
console.log(`final drive ${C.drivetrain.final_drive}: top gear reaches the redline at ${(redline * 2 * Math.PI / 60 * driveR / (C.drivetrain.final_drive * topGear) * 3.6).toFixed(0)} km/h; the power and drag allow about ${(vmax * 3.6).toFixed(0)} km/h`);
console.log(`\ncatalog entry for data/cars/catalog.json ("cars" array); open the car with ?menu=0&car=${id} (a dev-server URL owns every car, so no level entry is needed to try it):`);
console.log(JSON.stringify({ id, price: 0, name, tag: 'Generated by tools/new_car.mjs', physics: `cars/${id}.json`, visual: `cars/${id}.visual.json`, paint: '#2a9d8f' }, null, 2));

// ---- check it, if the checker is built
const checker = ['core/build/rs_carcheck', 'core/build/rs_carcheck.exe'].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
if (checker && !argv.includes('--no-check')) {
  console.log('\n--- rs_carcheck ---');
  try { process.stdout.write(execFileSync(checker, [outFile], { encoding: 'utf8' })); }
  catch (e) { process.stdout.write(e.stdout ?? ''); console.log('rs_carcheck reported a FAIL: the car above is not usable as is'); process.exitCode = 3; }
} else if (!checker) console.log('\n(core/build/rs_carcheck not built: cmake --build core/build --target rs_carcheck, then run it on the file for the sanity check)');
