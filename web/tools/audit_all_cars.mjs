// Apache-2.0 — Exhaustive 25-Car x (Stock + Stage-3 Twin-Turbo Tuned) WASM Physics End-to-End Auditor.
// Runs every car JSON in data/cars/ through the EXACT compiled browser rs_core.wasm across:
//   1. 25 s full-throttle race pull (top speed, clutch health/temp, gearbox health, zero missed shifts, finite)
//   2. 6 s full-steer + -5 deg camber launch with default Intermediate assists (clears 30 km/h, no ESC/TC deadlock)
//   3. 100->0 km/h ABS braking stop (straight, short, zero NaN)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createRsCore from '../src/physics/rs_core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const carsDir = path.resolve(__dirname, '../../data/cars');

const DT = 1 / 240;

function rotateVec(x, y, z, qx, qy, qz, qw) {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

function makeTuned(base) {
  const d = JSON.parse(JSON.stringify(base));
  // Stage-3 Engine (+15%) + Stage-3 Tyres (+15% grip) + Forged Twin-Turbo (1.32x) + Titanium Headers (1.11x)
  const mul = 1.15 * 1.32 * 1.11;
  d.engine.torque_curve = d.engine.torque_curve.map(([r, t]) => [r, Math.round(t * mul * 10) / 10]);
  const peakT = Math.max(...d.engine.torque_curve.map(([, t]) => t));
  if (d.drivetrain && typeof d.drivetrain.clutch_max_torque_nm === 'number') {
    d.drivetrain.clutch_max_torque_nm = Math.max(d.drivetrain.clutch_max_torque_nm * mul, peakT * 1.75);
  }
  for (const tk of ['tire_front', 'tire_rear']) {
    if (d[tk]?.longitudinal) d[tk].longitudinal.mu *= 1.15;
    if (d[tk]?.lateral) d[tk].lateral.mu *= 1.15;
  }
  return d;
}

function makeStanceCamber(tuned) {
  const d = JSON.parse(JSON.stringify(tuned));
  if (d.front_axle) d.front_axle.static_camber_deg = -5.0;
  if (d.rear_axle) d.rear_axle.static_camber_deg = -5.0;
  return d;
}

function runSim(mod, jsonObj, turboStage, seconds, inputFn, initSpeed = 0) {
  const p = mod.stringToNewUTF8(JSON.stringify(jsonObj));
  const id = mod._rs_create(p);
  mod._free(p);
  if (id < 0) throw new Error(`rs_create failed: ${mod.UTF8ToString(mod._rs_last_error())}`);
  const ptr = mod._rs_buffer(id) >> 3;
  mod._rs_info(id);
  const h = () => mod.HEAPF64;
  const specMass = h()[ptr];
  const Ix = h()[ptr + 1], Iy = h()[ptr + 2], Iz = h()[ptr + 3];
  const cgH = h()[ptr + 4];
  const asphalt = h()[ptr + 9];
  mod._rs_set_turbo_stage(id, turboStage);

  let px = 0, py = cgH, pz = 0;
  let qx = 0, qy = 0, qz = 0, qw = 1;
  let vx = 0, vy = 0, vz = initSpeed;
  let wx = 0, wy = 0, wz = 0;

  // Settle vertically
  mod._rs_reset_motion(id, initSpeed, initSpeed > 1 ? 3 : 2);
  let vmax = 0, maxClutchTemp = 0, minClutchHealth = 1, minGbHealth = 1, missed = 0;
  let maxGear = 1, finite = true, startZ = 0, stopDist = 0;

  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const b = h();
    b[ptr + 0] = px; b[ptr + 1] = py; b[ptr + 2] = pz;
    b[ptr + 3] = qx; b[ptr + 4] = qy; b[ptr + 5] = qz; b[ptr + 6] = qw;
    b[ptr + 7] = vx; b[ptr + 8] = vy; b[ptr + 9] = vz;
    b[ptr + 10] = wx; b[ptr + 11] = wy; b[ptr + 12] = wz;
    mod._rs_rays(id);

    // Intersect 4 wheel rays against flat plane y = 0
    for (let w = 0; w < 4; w++) {
      const r = ptr + 16 + 6 * w;
      const ox = b[r], oy = b[r + 1], oz = b[r + 2];
      const ex = b[r + 3], ey = b[r + 4], ez = b[r + 5];
      const c = ptr + 48 + 8 * w;
      const dy = ey - oy;
      if (dy < -1e-6 && oy >= 0 && ey <= 0) {
        const t = -oy / dy;
        b[c] = 1;
        b[c + 1] = ox + (ex - ox) * t;
        b[c + 2] = 0;
        b[c + 3] = oz + (ez - oz) * t;
        b[c + 4] = 0; b[c + 5] = 1; b[c + 6] = 0;
        b[c + 7] = asphalt;
      } else {
        b[c] = 0;
      }
    }

    const inp = inputFn(i * DT, b[ptr + 102]);
    b[ptr + 80] = inp.steer ?? 0;
    b[ptr + 81] = inp.throttle ?? 0;
    b[ptr + 82] = inp.brake ?? 0;
    b[ptr + 83] = inp.clutch ?? 0;
    b[ptr + 84] = 0;
    b[ptr + 85] = 0; b[ptr + 86] = 0;
    b[ptr + 87] = inp.device ?? 0; // Keyboard
    b[ptr + 88] = 1; // ABS
    b[ptr + 89] = inp.tc ?? 1;
    b[ptr + 90] = inp.esc ?? 1;
    b[ptr + 91] = 1; // autoGearbox
    b[ptr + 92] = -99;
    b[ptr + 93] = 0.10;
    b[ptr + 94] = 0.14; // Intermediate TC
    b[ptr + 95] = inp.cs ?? 0.4;
    b[ptr + 40] = 0; // Perfect auto-clutch
    b[ptr + 41] = 0;

    mod._rs_step(id, DT);
    const b2 = h();
    const mass = b2[ptr + 274] > 0 ? b2[ptr + 274] : specMass;
    const fx = b2[ptr + 96], fy = b2[ptr + 97] - mass * 9.81, fz = b2[ptr + 98];
    const tx = b2[ptr + 99], ty = b2[ptr + 100], tz = b2[ptr + 101];
    if (!Number.isFinite(fx + fy + fz + tx + ty + tz)) { finite = false; break; }

    vx += (fx / mass) * DT; vy += (fy / mass) * DT; vz += (fz / mass) * DT;
    px += vx * DT; py += vy * DT; pz += vz * DT;
    if (py < 0.15) { py = 0.15; if (vy < 0) vy = 0; }

    const wb = rotateVec(wx, wy, wz, -qx, -qy, -qz, qw);
    const tb = rotateVec(tx, ty, tz, -qx, -qy, -qz, qw);
    const Iwx = Ix * wb[0], Iwy = Iy * wb[1], Iwz = Iz * wb[2];
    const nwb = [
      wb[0] + ((tb[0] - (wb[1] * Iwz - wb[2] * Iwy)) / Ix) * DT,
      wb[1] + ((tb[1] - (wb[2] * Iwx - wb[0] * Iwz)) / Iy) * DT,
      wb[2] + ((tb[2] - (wb[0] * Iwy - wb[1] * Iwx)) / Iz) * DT,
    ];
    [wx, wy, wz] = rotateVec(nwb[0], nwb[1], nwb[2], qx, qy, qz, qw);
    const wLen = Math.hypot(wx, wy, wz);
    if (wLen > 1e-9) {
      const half = 0.5 * wLen * DT, s = Math.sin(half) / wLen, c = Math.cos(half);
      const dqx = wx * s, dqy = wy * s, dqz = wz * s, dqw = c;
      const nqx = dqw * qx + dqx * qw + dqy * qz - dqz * qy;
      const nqy = dqw * qy - dqx * qz + dqy * qw + dqz * qx;
      const nqz = dqw * qz + dqx * qy - dqy * qx + dqz * qw;
      const nqw = dqw * qw - dqx * qx - dqy * qy - dqz * qz;
      const invQ = 1 / Math.hypot(nqx, nqy, nqz, nqw);
      qx = nqx * invQ; qy = nqy * invQ; qz = nqz * invQ; qw = nqw * invQ;
    }

    const spdKmh = Math.abs(b2[ptr + 102]) * 3.6;
    if (spdKmh > vmax) vmax = spdKmh;
    if (b2[ptr + 104] > maxGear) maxGear = Math.round(b2[ptr + 104]);
    if (b2[ptr + 275] > maxClutchTemp) maxClutchTemp = b2[ptr + 275];
    if (b2[ptr + 276] < minClutchHealth) minClutchHealth = b2[ptr + 276];
    if (b2[ptr + 277] < minGbHealth) minGbHealth = b2[ptr + 277];
    missed = Math.max(missed, Math.round(b2[ptr + 278]));
    if (i === 0) startZ = pz;
    if (initSpeed > 1 && spdKmh < 1.5 && stopDist === 0) stopDist = Math.hypot(px, pz - startZ);
  }
  return { vmax, maxGear, maxClutchTemp, minClutchHealth, minGbHealth, missed, finite, stopDist };
}

async function main() {
  const mod = await createRsCore();
  const files = fs.readdirSync(carsDir).filter((f) => f.endsWith('.json') && f !== 'catalog.json').sort();
  let fails = 0;

  for (const f of files) {
    const base = JSON.parse(fs.readFileSync(path.join(carsDir, f), 'utf8'));
    if (!base.engine || !base.drivetrain) continue;
    const tuned = makeTuned(base);
    const stance = makeStanceCamber(tuned);

    const stockPull = runSim(mod, base, 0, 22, () => ({ throttle: 1, device: 0 }));
    const tunedPull = runSim(mod, tuned, 3, 22, () => ({ throttle: 1, device: 0 }));
    const steerLaunch = runSim(mod, stance, 3, 7, () => ({ throttle: 1, steer: 1, device: 0, esc: 1, tc: 1, cs: 0.4 }));
    const brakeStop = runSim(mod, base, 0, 6, () => ({ brake: 1, device: 0 }), 100 / 3.6);

    const ok =
      stockPull.finite && stockPull.vmax >= 180 && stockPull.minClutchHealth >= 0.90 && stockPull.maxClutchTemp < 210 && stockPull.missed === 0 &&
      tunedPull.finite && tunedPull.vmax > stockPull.vmax * 0.98 && tunedPull.minClutchHealth >= 0.90 && tunedPull.maxClutchTemp < 220 && tunedPull.missed === 0 &&
      steerLaunch.finite && steerLaunch.vmax >= 32 &&
      brakeStop.finite && brakeStop.stopDist > 20 && brakeStop.stopDist < 55;

    console.log(
      `  [${ok ? 'PASS' : 'FAIL'}] ${f.padEnd(26)} stock=${stockPull.vmax.toFixed(0)} km/h (g${stockPull.maxGear}, clH=${stockPull.minClutchHealth.toFixed(2)}) | ` +
      `st3=${tunedPull.vmax.toFixed(0)} km/h (g${tunedPull.maxGear}, clT=${tunedPull.maxClutchTemp.toFixed(0)}C, clH=${tunedPull.minClutchHealth.toFixed(2)}) | ` +
      `steer=${steerLaunch.vmax.toFixed(0)} km/h | 100-0=${brakeStop.stopDist.toFixed(1)}m`,
    );
    if (!ok) fails++;
  }
  console.log(`\nAudited ${files.length} cars in rs_core.wasm: ${fails} failure(s).`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
