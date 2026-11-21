// Benchmark rs_core WASM and Rapier rigid-body physics separately for 16 cars at 1000 / 360 / 240 Hz.
// Mirrors core/bench/bench_runtime.cpp (same car spec, all features on via rs_create, 3-ray contact patch).
// Run from repo root: node web/tools/bench_runtime.mjs
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import RAPIER from '@dimforge/rapier3d-compat';
import createRsCore from '../src/physics/rs_core.js';

const wasmBin = fs.readFileSync(new URL('../src/physics/rs_core.wasm', import.meta.url));
const carJson = fs.readFileSync(new URL('../../data/cars/vela_gt.json', import.meta.url), 'utf8');

// ---- 1. Pure WASM rs_core (flat ground, lightweight JS rigid-body integrator) ------------------------------------
async function benchWasmCore(nCars, rateHz, simSeconds, usePatch3) {
  const M = await createRsCore({ wasmBinary: wasmBin });
  const dt = 1 / rateHz;
  const cars = [];
  for (let i = 0; i < nCars; i++) {
    const p = M.stringToNewUTF8(carJson);
    const id = M._rs_create(p);
    M._free(p);
    if (id < 0) throw new Error(M.UTF8ToString(M._rs_last_error()));
    M._rs_set_turbo_stage(id, 1);
    const ptr = M._rs_buffer(id);
    M._rs_info(id);
    const b = new Float64Array(M.HEAPF64.buffer, ptr, 384);
    const mass = b[0], Ix = b[1], Iy = b[2], Iz = b[3], cg = b[4];
    M._rs_reset_motion(id, 22.0, 3);
    cars.push({
      id, ptr, mass, Ix, Iy, Iz,
      px: (i % 2) * 4, py: cg, pz: i * 10,
      qx: 0, qy: 0, qz: 0, qw: 1,
      vx: 0, vy: 0, vz: 22.0,
      wx: 0, wy: 0, wz: 0,
      steer: i % 2 ? 0.12 : -0.12,
      throttle: 0.85,
      brake: 0.0,
    });
  }
  // Cache HEAPF64 view (all cars created, memory won't grow during stepping)
  const bufs = cars.map((c) => new Float64Array(M.HEAPF64.buffer, c.ptr, 384));
  const contactsPatch = new Float64Array(96);

  function stepCar(c, b) {
    b[0] = c.px; b[1] = c.py; b[2] = c.pz;
    b[3] = c.qx; b[4] = c.qy; b[5] = c.qz; b[6] = c.qw;
    b[7] = c.vx; b[8] = c.vy; b[9] = c.vz;
    b[10] = c.wx; b[11] = c.wy; b[12] = c.wz;
    if (usePatch3) {
      M._rs_rays_patch(c.id);
      for (let k = 0; k < 12; k++) {
        const ro = 280 + 6 * k;
        const fy = b[ro + 1], ty = b[ro + 4];
        const co = 8 * k;
        if (fy > 0 && ty <= 0) {
          const t = fy / (fy - ty);
          contactsPatch[co] = 1;
          contactsPatch[co + 1] = b[ro] + (b[ro + 3] - b[ro]) * t;
          contactsPatch[co + 2] = 0;
          contactsPatch[co + 3] = b[ro + 2] + (b[ro + 5] - b[ro + 2]) * t;
          contactsPatch[co + 4] = 0; contactsPatch[co + 5] = 1; contactsPatch[co + 6] = 0; contactsPatch[co + 7] = 0;
        } else {
          contactsPatch[co] = 0;
        }
      }
      b.set(contactsPatch, 280);
    } else {
      M._rs_rays(c.id);
      for (let k = 0; k < 4; k++) {
        const ro = 16 + 6 * k;
        const fy = b[ro + 1], ty = b[ro + 4];
        const co = 48 + 8 * k;
        if (fy > 0 && ty <= 0) {
          const t = fy / (fy - ty);
          b[co] = 1;
          b[co + 1] = b[ro] + (b[ro + 3] - b[ro]) * t;
          b[co + 2] = 0;
          b[co + 3] = b[ro + 2] + (b[ro + 5] - b[ro + 2]) * t;
          b[co + 4] = 0; b[co + 5] = 1; b[co + 6] = 0; b[co + 7] = 0;
        } else {
          b[co] = 0;
        }
      }
    }
    b[80] = c.steer; b[81] = c.throttle; b[82] = c.brake; b[83] = 0; b[84] = 0;
    b[85] = 0; b[86] = 0; b[87] = 1;
    b[88] = 1; b[89] = 1; b[90] = 1; b[91] = 1; b[92] = -99;
    b[93] = 0; b[94] = 0; b[95] = 0;
    if (usePatch3) M._rs_step_patch(c.id, dt);
    else M._rs_step(c.id, dt);

    const m = b[274] > 0 ? b[274] : c.mass;
    const invM = dt / m;
    c.vx += b[96] * invM;
    c.vy += (b[97] - m * 9.81) * invM;
    c.vz += b[98] * invM;
    c.px += c.vx * dt; c.py += c.vy * dt; c.pz += c.vz * dt;
    // Simple diagonal inertia integration (keeps car upright and realistic)
    c.wx += (b[99] / c.Ix) * dt;
    c.wy += (b[100] / c.Iy) * dt;
    c.wz += (b[101] / c.Iz) * dt;
    const qx = c.qx, qy = c.qy, qz = c.qz, qw = c.qw;
    const hdt = 0.5 * dt;
    const nqx = qx + hdt * (c.wx * qw + c.wy * qz - c.wz * qy);
    const nqy = qy + hdt * (c.wy * qw + c.wz * qx - c.wx * qz);
    const nqz = qz + hdt * (c.wz * qw + c.wx * qy - c.wy * qx);
    const nqw = qw + hdt * (-c.wx * qx - c.wy * qy - c.wz * qz);
    const invL = 1 / Math.hypot(nqx, nqy, nqz, nqw);
    c.qx = nqx * invL; c.qy = nqy * invL; c.qz = nqz * invL; c.qw = nqw * invL;
  }

  const warmup = Math.floor(rateHz / 4);
  const ticks = Math.round(simSeconds * rateHz);
  for (let t = 0; t < warmup; t++) {
    for (let i = 0; i < nCars; i++) stepCar(cars[i], bufs[i]);
  }

  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) {
    if (t % Math.floor(rateHz / 2) === 0) {
      const braking = Math.floor(t / Math.floor(rateHz / 2)) % 3 === 2;
      for (let i = 0; i < nCars; i++) {
        cars[i].throttle = braking ? 0.0 : 0.85;
        cars[i].brake = braking ? 0.75 : 0.0;
        cars[i].steer = Math.sin(0.5 * t * dt + i) * 0.25;
      }
    }
    for (let i = 0; i < nCars; i++) stepCar(cars[i], bufs[i]);
  }
  const elapsedMs = performance.now() - t0;
  let sink = 0;
  for (let i = 0; i < nCars; i++) sink += cars[i].pz + bufs[i][103];

  const usPerStep = (elapsedMs * 1000) / (ticks * nCars);
  const msPerSimSCar = (elapsedMs / simSeconds) / nCars;
  const msPerSimSAll = elapsedMs / simSeconds;
  console.log(
    `  ${String(rateHz).padStart(4)} Hz (${usePatch3 ? '3-ray' : '1-ray'}): ` +
    `${usPerStep.toFixed(2).padStart(6)} us/step/car | ${msPerSimSCar.toFixed(2).padStart(6)} ms/sim-s/car | ` +
    `${nCars} cars: ${msPerSimSAll.toFixed(1).padStart(6)} ms/sim-s (${(msPerSimSAll / 10).toFixed(1).padStart(5)}% of 1 core) | ` +
    `${(msPerSimSAll / 60).toFixed(2)} ms @60fps, ${(msPerSimSAll / 30).toFixed(2)} ms @30fps  [sink=${Math.round(sink)}]`
  );
  return { usPerStep, msPerSimSCar, msPerSimSAll };
}

// ---- 2. Separated rs_core vs Rapier raycasts vs Rapier world.step() ----------------------------------------------
async function benchRapierSplit(nCars, rateHz, simSeconds) {
  await RAPIER.init();
  const M = await createRsCore({ wasmBinary: wasmBin });
  const dt = 1 / rateHz;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;

  // Flat road + 250 static city-like prop boxes so BVH depth resembles a city tile neighborhood
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0));
  for (let i = 0; i < 250; i++) {
    const side = i % 2 === 0 ? -12 : 12;
    world.createCollider(RAPIER.ColliderDesc.cuboid(2, 4, 2).setTranslation(side, 4, (i - 125) * 8));
  }

  const GROUP_CAR = (0x0001 << 16) | 0xfffd;
  const cars = [];
  for (let i = 0; i < nCars; i++) {
    const p = M.stringToNewUTF8(carJson);
    const id = M._rs_create(p);
    M._free(p);
    M._rs_set_turbo_stage(id, 1);
    const ptr = M._rs_buffer(id);
    M._rs_info(id);
    const b = new Float64Array(M.HEAPF64.buffer, ptr, 384);
    const mass = b[0], Ix = b[1], Iy = b[2], Iz = b[3], cg = b[4];
    M._rs_reset_motion(id, 20.0, 3);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation((i % 2) * 4 - 2, cg, i * 10)
        .setLinvel(0, 0, 20)
        .setAdditionalMassProperties(mass, { x: 0, y: 0, z: 0 }, { x: Ix, y: Iy, z: Iz }, { x: 0, y: 0, z: 0, w: 1 })
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.95, 0.35, 2.2).setDensity(0).setFriction(0.3).setRestitution(0.1).setCollisionGroups(GROUP_CAR),
      body,
    );
    cars.push({ id, ptr, body });
  }
  const bufs = cars.map((c) => new Float64Array(M.HEAPF64.buffer, c.ptr, 384));
  const rayOrigin = { x: 0, y: 0, z: 0 };
  const rayDir = { x: 0, y: -1, z: 0 };
  const rayObj = new RAPIER.Ray(rayOrigin, rayDir);
  const fVec = { x: 0, y: 0, z: 0 };
  const tVec = { x: 0, y: 0, z: 0 };
  const contactsPatch = new Float64Array(96);

  let tRaysCore = 0, tRapierRay = 0, tStepCore = 0, tRapierStep = 0;

  function tickOnce(measure) {
    for (let i = 0; i < nCars; i++) {
      const c = cars[i], b = bufs[i];
      const tr = c.body.translation(), ro = c.body.rotation(), lv = c.body.linvel(), av = c.body.angvel();
      b[0] = tr.x; b[1] = tr.y; b[2] = tr.z;
      b[3] = ro.x; b[4] = ro.y; b[5] = ro.z; b[6] = ro.w;
      b[7] = lv.x; b[8] = lv.y; b[9] = lv.z;
      b[10] = av.x; b[11] = av.y; b[12] = av.z;

      const a0 = measure ? performance.now() : 0;
      M._rs_rays_patch(c.id);
      const a1 = measure ? performance.now() : 0;

      for (let k = 0; k < 12; k++) {
        const idx = 280 + 6 * k;
        const ax = b[idx], ay = b[idx + 1], az = b[idx + 2];
        const dx = b[idx + 3] - ax, dy = b[idx + 4] - ay, dz = b[idx + 5] - az;
        const len = Math.hypot(dx, dy, dz);
        const co = 8 * k;
        if (len < 1e-6) { contactsPatch[co] = 0; continue; }
        const inv = 1 / len;
        rayOrigin.x = ax; rayOrigin.y = ay; rayOrigin.z = az;
        rayDir.x = dx * inv; rayDir.y = dy * inv; rayDir.z = dz * inv;
        const hit = world.castRayAndGetNormal(rayObj, len, false, undefined, GROUP_CAR, undefined, c.body);
        if (!hit || hit.timeOfImpact < 0.04) { contactsPatch[co] = 0; continue; }
        const toi = hit.timeOfImpact;
        contactsPatch[co] = 1;
        contactsPatch[co + 1] = ax + rayDir.x * toi; contactsPatch[co + 2] = ay + rayDir.y * toi; contactsPatch[co + 3] = az + rayDir.z * toi;
        contactsPatch[co + 4] = hit.normal.x; contactsPatch[co + 5] = hit.normal.y; contactsPatch[co + 6] = hit.normal.z; contactsPatch[co + 7] = 0;
      }
      b.set(contactsPatch, 280);
      const a2 = measure ? performance.now() : 0;

      b[80] = 0.05; b[81] = 0.7; b[82] = 0; b[83] = 0; b[84] = 0;
      b[85] = 0; b[86] = 0; b[87] = 1;
      b[88] = 1; b[89] = 1; b[90] = 1; b[91] = 1; b[92] = -99;
      b[93] = 0; b[94] = 0; b[95] = 0;
      M._rs_step_patch(c.id, dt);
      const a3 = measure ? performance.now() : 0;

      c.body.resetForces(false);
      c.body.resetTorques(false);
      fVec.x = b[96]; fVec.y = b[97]; fVec.z = b[98];
      tVec.x = b[99]; tVec.y = b[100]; tVec.z = b[101];
      c.body.addForce(fVec, true);
      c.body.addTorque(tVec, true);

      if (measure) {
        tRaysCore += a1 - a0;
        tRapierRay += a2 - a1;
        tStepCore += a3 - a2;
      }
    }
    const s0 = measure ? performance.now() : 0;
    world.step();
    if (measure) tRapierStep += performance.now() - s0;
  }

  const warmup = Math.floor(rateHz / 4);
  const ticks = Math.round(simSeconds * rateHz);
  for (let t = 0; t < warmup; t++) tickOnce(false);
  for (let t = 0; t < ticks; t++) tickOnce(true);

  const coreMs = (tRaysCore + tStepCore) / simSeconds;
  const rayMs = tRapierRay / simSeconds;
  const stepMs = tRapierStep / simSeconds;
  const totalMs = coreMs + rayMs + stepMs;
  console.log(
    `  ${String(nCars).padStart(2)} cars @ ${String(rateHz).padStart(4)} Hz | ` +
    `rs_core: ${coreMs.toFixed(1).padStart(6)} ms/s | Rapier rays (12/car): ${rayMs.toFixed(1).padStart(6)} ms/s | ` +
    `Rapier step: ${stepMs.toFixed(1).padStart(6)} ms/s | TOTAL: ${totalMs.toFixed(1).padStart(6)} ms/s ` +
    `(${(totalMs / 60).toFixed(2)} ms @60fps, ${(totalMs / 30).toFixed(2)} ms @30fps)`
  );
  world.free();
}

console.log('=== WASM rs_core only (Node.js, 16 cars, all features on, vela_gt.json) ===');
await benchWasmCore(16, 1000, 2.0, true);
await benchWasmCore(16, 360, 2.0, true);
await benchWasmCore(16, 240, 2.0, true);
await benchWasmCore(16, 1000, 2.0, false);
await benchWasmCore(16, 360, 2.0, false);

console.log('\n=== WASM rs_core vs Rapier split (Node.js, 250 static boxes + road, 12 patch rays/car) ===');
for (const n of [1, 6, 16]) {
  for (const hz of [240, 360, 1000]) {
    await benchRapierSplit(n, hz, 1.0);
  }
}
