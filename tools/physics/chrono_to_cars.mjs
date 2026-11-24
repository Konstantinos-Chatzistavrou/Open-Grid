#!/usr/bin/env node
// Convert complete Project Chrono vehicles (the imported data/reference/chrono-vehicles files) into cars of OUR schema (car/1), so the
// physics core can drive them: chassis mass / inertia / centre of gravity, axle positions and tracks, double-wishbone hardpoints,
// spring and damper rates at the WHEEL (rate at the spring x motion ratio^2, the motion ratio measured on the hardpoints), brake
// torques, steering lock, engine map, gear ratios, final drive, driven axles, and the Magic Formula tyre (.tir via tools/tir2car.mjs).
// Output: data/reference/chrono-vehicles/cars/<id>.json (generated, committed; tests in core/tests/test_reference_data.cpp load them).
//
//   node tools/physics/chrono_to_cars.mjs
//
// Only vehicles whose axles are both double-wishbone are converted (audi, sedan, hmmwv, suv): the solid axles, leaf springs, multi-link
// and trailing-arm layouts of the other vehicles have no counterpart in our kinematics. Chrono has no aero data: the drag area and
// lift area are the Vela's class values and are marked as such; tests that need aero do not use these cars.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChrono } from './chrono_parse.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CH = join(ROOT, 'data/reference/chrono-vehicles');
const OUT = join(CH, 'cars');
mkdirSync(OUT, { recursive: true });
const load = (rel) => parseChrono(readFileSync(join(CH, rel), 'utf8'));
const vela = JSON.parse(readFileSync(join(ROOT, 'data/cars/vela_gt.json'), 'utf8'));

const VEHICLES = [
  { id: 'chrono_audi', name: 'Chrono Audi', vehicle: 'audi/json/audi_Vehicle.json', tir: 'audi/json/audi_Pac02Tire.tir', tire: 'audi/json/audi_Pac02Tire.json', engine: 'audi/json/audi_EngineSimpleMap.json', trans: 'audi/json/audi_ManualTransmissionShafts.json', driveline: 'audi/json/audi_Driveline2WD.json' },
  { id: 'chrono_sedan', name: 'Chrono Sedan', vehicle: 'sedan/vehicle/Sedan_Vehicle.json', tir: 'sedan/tire/Sedan_Pac02Tire.tir', tire: 'sedan/tire/Sedan_Pac02Tire.json', engine: 'sedan/powertrain/Sedan_EngineSimpleMap.json', trans: 'sedan/powertrain/Sedan_ManualTransmissionShafts.json', driveline: 'sedan/driveline/Sedan_Driveline2WD.json' },
  { id: 'chrono_hmmwv', name: 'Chrono HMMWV', vehicle: 'hmmwv/vehicle/HMMWV_Vehicle_4WD.json', tir: 'hmmwv/tire/HMMWV_Pac02Tire.tir', tire: 'hmmwv/tire/HMMWV_Pac02Tire.json', engine: 'hmmwv/powertrain/HMMWV_EngineSimpleMap.json', trans: 'hmmwv/powertrain/HMMWV_AutomaticTransmissionSimpleMap.json', driveline: 'hmmwv/driveline/HMMWV_Driveline4WD.json' },
  { id: 'chrono_patrol', name: 'Chrono Nissan Patrol', vehicle: 'Nissan_Patrol/json/suv_Vehicle.json', tir: 'Nissan_Patrol/json/suv_Pac02Tire.tir', tire: 'Nissan_Patrol/json/suv_Pac02Tire.json', engine: 'Nissan_Patrol/json/suv_EngineSimple.json', trans: 'Nissan_Patrol/json/suv_AutomaticTransmissionSimpleMap.json', driveline: 'Nissan_Patrol/json/suv_Driveline2WD.json' },
];

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(...a);
const unit = (a) => a.map((v) => v / norm(a));

/** Motion ratio dL / dz of the spring over the wheel's vertical travel: the lower arm turns about the axis through its two chassis
 *  points; the spring's arm end moves with it, the wheel (lower ball joint) rises by the same turn. Chrono's spring and shock sit on the lower arm. */
function motionRatio(susp) {
  const lca = susp['Lower Control Arm'], sp = susp.Spring;
  const p0 = lca['Location Chassis Front'], p1 = lca['Location Chassis Back'], axis = unit(sub(p0, p1));
  const turn = (pt) => cross(axis, sub(pt, p0));   // displacement per radian of the arm
  const A = sp['Location Arm'], C = sp['Location Chassis'];
  const n = unit(sub(A, C));
  const dL = dot(turn(A), n);
  const dz = turn(lca['Location Upright'])[2];
  return Math.abs(dL / dz);
}

const report = [];
for (const v of VEHICLES) {
  const veh = load(v.vehicle), ch = load(veh.Chassis['Input File']);
  const axles = veh.Axles.map((a) => ({ a, susp: load(a['Suspension Input File']), wheel: load(a['Left Wheel Input File']), brake: load(a['Left Brake Input File']) }));
  const tir = Object.fromEntries(readFileSync(join(CH, v.tir), 'utf8').split(/\r?\n/).map((l) => /^\s*([A-Z][A-Z0-9_]*)\s*=\s*([-+0-9.eE]+)/.exec(l)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
  const tireJson = load(v.tire);
  const R = tir.UNLOADED_RADIUS;
  const front = axles[0], rear = axles[1];
  const xf = front.a['Suspension Location'][0], xr = rear.a['Suspension Location'][0];
  // height of the wheel centre above the chassis frame per axle; the chassis frame must sit at one height over both
  const zw = axles.map((x) => x.a['Suspension Location'][2] + x.susp.Spindle.COM[2]);
  const hRef = axles.map((_, i) => R - zw[i]);
  if (Math.abs(hRef[0] - hRef[1]) > 0.05) { console.log(`${v.id}: skipped, the axles put the chassis frame ${Math.abs(hRef[0] - hRef[1]).toFixed(3)} m apart`); continue; }
  const href = (hRef[0] + hRef[1]) / 2;
  // masses and positions: the chassis components, then per wheel the wheel, tyre, spindle, upright, both arms
  const parts = [];   // {m, x, y, z (above ground), I:[ixx,iyy,izz] about own centre}
  for (const c of ch.Components) if (!c.Void) parts.push({ m: c.Mass, x: c['Centroidal Frame'].Location[0], y: c['Centroidal Frame'].Location[1], z: href + c['Centroidal Frame'].Location[2], I: c['Moments of Inertia'] });
  axles.forEach((ax, ai) => {
    const sx = ax.a['Suspension Location'][0], sz = ax.a['Suspension Location'][2];
    for (const side of [1, -1]) {
      const mw = ax.wheel.Mass + tireJson.Mass;
      parts.push({ m: mw, x: sx, y: side * ax.susp.Spindle.COM[1], z: R, I: [ax.wheel.Inertia[0] + tireJson.Inertia[0], ax.wheel.Inertia[1] + tireJson.Inertia[1], ax.wheel.Inertia[2] + tireJson.Inertia[2]] });
      for (const k of ['Spindle', 'Upright', 'Upper Control Arm', 'Lower Control Arm']) {
        const p = ax.susp[k]; if (!p?.Mass) continue;
        parts.push({ m: p.Mass, x: sx + p.COM[0], y: side * p.COM[1], z: href + sz + p.COM[2], I: [0, 0, 0] });
      }
    }
  });
  const M = parts.reduce((s, p) => s + p.m, 0);
  const cg = [0, 1, 2].map((i) => parts.reduce((s, p) => s + p.m * [p.x, p.y, p.z][i], 0) / M);
  let Ixx = 0, Iyy = 0, Izz = 0;
  for (const p of parts) {
    const dx = p.x - cg[0], dy = p.y - cg[1], dz = p.z - cg[2];
    Ixx += p.I[0] + p.m * (dy * dy + dz * dz); Iyy += p.I[1] + p.m * (dx * dx + dz * dz); Izz += p.I[2] + p.m * (dx * dx + dy * dy);
  }
  const L = xf - xr;
  const weightFront = (cg[0] - xr) / L;
  const trackF = 2 * Math.abs(front.susp.Spindle.COM[1]), trackR = 2 * Math.abs(rear.susp.Spindle.COM[1]);
  // suspension: hardpoints into our frame (x from the axle, y from the centre line, z above ground with the wheel centre at R)
  const hp = (axle) => {
    const s = axle.susp;
    const P = (a) => [a[0] - s.Spindle.COM[0], a[1], a[2] - s.Spindle.COM[2] + R];   // wheel centre at height R, x from the axle
    return {
      type: 'double_wishbone',
      lca_front: P(s['Lower Control Arm']['Location Chassis Front']), lca_rear: P(s['Lower Control Arm']['Location Chassis Back']), lca_outer: P(s['Lower Control Arm']['Location Upright']),
      uca_front: P(s['Upper Control Arm']['Location Chassis Front']), uca_rear: P(s['Upper Control Arm']['Location Chassis Back']), uca_outer: P(s['Upper Control Arm']['Location Upright']),
      tie_inner: P(s.Tierod['Location Chassis']), tie_outer: P(s.Tierod['Location Upright']),
      shock_lower: P(s.Spring['Location Arm']), shock_upper: P(s.Spring['Location Chassis']),
    };
  };
  // wheel rate at the static wheel load: a linear spring gives its coefficient; a Spring Curve Data table (HMMWV, Patrol) gives the
  // tangent stiffness where the spring force equals the static wheel load divided by the motion ratio
  const susp = (axle, wheelLoad) => {
    const mr = motionRatio(axle.susp);
    const sp = axle.susp.Spring;
    let k = sp['Spring Coefficient'];
    if (!k && Array.isArray(sp['Spring Curve Data'])) {
      const cur = sp['Spring Curve Data'], f = wheelLoad / mr;
      let i = cur.findIndex(([, force]) => force >= f);
      if (i <= 0) i = 1;
      k = (cur[i][1] - cur[i - 1][1]) / (cur[i][0] - cur[i - 1][0]);
    }
    return { mr, wheel_rate: k * mr * mr, damper: axle.susp.Shock['Damping Coefficient'] * mr * mr };
  };
  const sF = susp(front, (M * 9.80665 * weightFront) / 2), sR = susp(rear, (M * 9.80665 * (1 - weightFront)) / 2);
  // brakes: BrakeSimple "Maximum Torque" per wheel
  const bT = axles.map((x) => x.brake['Maximum Torque']);
  const brakeTotal = 2 * bT[0] + 2 * bT[1];
  // powertrain
  const eng = load(v.engine), trans = load(v.trans), dl = load(v.driveline);
  let torque;
  if (eng.Template === 'EngineSimpleMap') torque = eng['Map Full Throttle'].filter(([r, t]) => r > 0 && t > 0 && r <= eng['Maximal Engine Speed RPM']);
  else {
    const T = eng['Maximum Engine Torque'], P = eng['Maximum Engine Power'], W = eng['Maximum Engine Speed'];
    torque = [];
    for (let k = 1; k <= 12; k++) { const w = (W * k) / 12, t = Math.min(T, P / w); torque.push([+(w * 30 / Math.PI).toFixed(0), +t.toFixed(1)]); }
  }
  const maxRpm = eng['Maximal Engine Speed RPM'] ?? Math.round((eng['Maximum Engine Speed'] * 30) / Math.PI);
  const gb = trans['Gear Box'] ?? trans['Gear Ratios'] ?? {};
  const fwd = (gb['Forward Gear Ratios'] ?? []).map((r) => +(1 / r).toFixed(4));
  const rev = gb['Reverse Gear Ratio'] ? +(1 / gb['Reverse Gear Ratio']).toFixed(4) : -3.2;
  const conical = dl['Gear Ratio']?.['Conical Gear'] ?? dl['Gear Ratio']?.['Conical Gear Ratio'] ?? dl['Conical Gear Ratio'];
  const finalDrive = conical ? +(1 / conical).toFixed(4) : 3.7;
  const driven = veh.Driveline['Suspension Indexes'];
  const layout = driven.length > 1 ? 'awd' : driven[0] === 0 ? 'fwd' : 'rwd';
  const maxSteer = veh['Maximum Steering Angle (deg)'] ?? 28;
  const tirBlock = JSON.parse(execFileSync('node', [join(ROOT, 'tools/tir2car.mjs'), join(CH, v.tir)], { encoding: 'utf8' }));
  const mkTire = () => ({ ...JSON.parse(JSON.stringify(vela.tire_front)), ...tirBlock, compound: 'road', radius_m: R, inertia_kgm2: +(tireJson.Inertia[1] + front.wheel.Inertia[1]).toFixed(3) });
  const car = JSON.parse(JSON.stringify(vela));
  car.name = v.name;
  car.notes = `Converted by tools/physics/chrono_to_cars.mjs from Project Chrono ${v.vehicle} (BSD-3, data/reference/chrono-vehicles, pinned commit). Mass, inertia and CG are Chrono's chassis plus wheels, tyres and suspension parts; wheel rates are the spring rate x the measured motion ratio squared (front ${sF.mr.toFixed(3)}, rear ${sR.mr.toFixed(3)}); aero is the Vela's class value (Chrono has none). Reference data, not a game car.`;
  car.chassis = { mass_kg: +M.toFixed(1), cg_height_m: +cg[2].toFixed(4), weight_front: +weightFront.toFixed(4), wheelbase_m: +L.toFixed(4), inertia_roll_kgm2: +Ixx.toFixed(1), inertia_pitch_kgm2: +Iyy.toFixed(1), inertia_yaw_kgm2: +Izz.toFixed(1) };
  for (const [key, axle, s, track] of [['front_axle', front, sF, trackF], ['rear_axle', rear, sR, trackR]]) {
    const a = car[key];
    a.track_m = +track.toFixed(4); a.spring_rate_n_per_m = Math.round(s.wheel_rate); a.damper_bump_ns_per_m = Math.round(s.damper); a.damper_rebound_ns_per_m = Math.round(s.damper);
    a.kinematics = hp(axle);
    // Chrono specifies none of these: no steering compliance, no anti-roll bar (unless its own antiroll file says so), no anti-dive /
    // anti-squat tuning and a plain linear shock. Leaving the Vela's values in would add a 0.12 deg/kN steering compliance (a quarter of
    // the wheel angle on a 2.5 t car) and a progressive damper to a vehicle that has neither.
    a.steer_compliance_deg_per_kn = 0; a.anti_roll_rate_n_per_m = 0; a.anti_pitch = 0; delete a.anti_lift_braking;
    a.damper_knee_mps = 10; a.damper_high_speed_ratio = 1.0;
    a.spring_rest_length_m = 0.30; a.max_compression_m = 0.10;
    if (key === 'front_axle') a.max_steer_deg = maxSteer; else delete a.max_steer_deg;
  }
  car.tire_front = mkTire(); car.tire_rear = mkTire();
  car.brakes = { max_total_torque_nm: brakeTotal, bias_front: +((2 * bT[0]) / brakeTotal).toFixed(3) };
  car.engine = { torque_curve: torque, idle_rpm: 800, redline_rpm: maxRpm, inertia_kgm2: 0.25, friction_const_nm: 20, friction_linear_nm_per_radps: 0.03 };
  car.drivetrain = { ...vela.drivetrain, layout, gear_ratios: [rev, 0, ...fwd], final_drive: finalDrive, efficiency: 0.92, clutch_max_torque_nm: Math.max(...torque.map((t) => t[1])) * 2 };
  delete car.drivetrain.gear_teeth; delete car.drivetrain.final_drive_teeth;
  if (layout === 'awd') car.drivetrain.front_torque_share = 0.5; else delete car.drivetrain.front_torque_share;
  car.reference = { source: v.vehicle, motion_ratio_from_hardpoints: [+sF.mr.toFixed(4), +sR.mr.toFixed(4)], minimum_turning_radius_m: veh['Minimum Turning Radius'] ?? null, chrono_wheelbase_m: veh.Wheelbase ?? null };
  car.aero = { ...vela.aero, notes: 'Vela class value: Chrono has no aero data' };
  writeFileSync(join(OUT, `${v.id}.json`), JSON.stringify(car, null, 2) + '\n');
  report.push({ id: v.id, mass: +M.toFixed(0), cgz: +cg[2].toFixed(3), L: +L.toFixed(3), jsonL: veh.Wheelbase, track: [+trackF.toFixed(3), +trackR.toFixed(3)], wf: +weightFront.toFixed(3), MR: [+sF.mr.toFixed(3), +sR.mr.toFixed(3)], kw: [Math.round(sF.wheel_rate), Math.round(sR.wheel_rate)], cw: [Math.round(sF.damper), Math.round(sR.damper)], brake: bT, steer: maxSteer, layout, fd: finalDrive, gears: fwd.length, hRef: hRef.map((h) => +h.toFixed(3)) });
}
for (const r of report) console.log(JSON.stringify(r));
console.log(`${report.length} vehicles written to data/reference/chrono-vehicles/cars/`);
