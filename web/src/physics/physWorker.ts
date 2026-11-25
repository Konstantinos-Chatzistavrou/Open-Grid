// Dedicated Web Worker running rs_core WASM + 6-DOF rigid-body integration at a fixed rate (400 / 360 / 1000 Hz)
// behind ?physworker=1. Communicates with the main thread exclusively through lock-free SharedArrayBuffer + Atomics
// SPSC ring buffers (no postMessage allocations per tick).
//
// Wheel ground contact: the main thread traces the 12 patch rays against the Rapier city world once per rendered frame
// and publishes the 12 ground planes (point + normal + surface) into the command ring. Each fixed-rate worker tick
// intersects fresh rs_core wheel rays against those planes (the same plane-intersection method used by the UE5 async
// physics bridge in core/include/rs/ue5_bridge.hpp).
import createRsCore from './rs_core.js';
import wasmUrl from './rs_core.wasm?url';
import {
  CMD_KIND,
  CMD_OFF,
  CMD_SLOT_DOUBLES,
  SNAP_OFF,
  SNAP_SLOT_DOUBLES,
  OUT_DOUBLES,
  SabSpscRing,
} from './sabRing';

interface RsWasm {
  HEAPF64: Float64Array;
  stringToNewUTF8(s: string): number;
  UTF8ToString(p: number): string;
  _free(p: number): void;
  _rs_create(json: number): number;
  _rs_last_error(): number;
  _rs_buffer(id: number): number;
  _rs_info(id: number): void;
  _rs_reset_motion(id: number, speed: number, gear: number): void;
  _rs_set_atmosphere(id: number, airC: number, trackC: number, altitudeM: number, humidity: number): void;
  _rs_set_turbo_stage(id: number, stage: number): void;
  _rs_rays_patch(id: number): void;
  _rs_step_patch(id: number, dt: number): void;
  _rs_repair(id: number): void;
}

interface InitMsg {
  type: 'init';
  cmdSab: SharedArrayBuffer;
  cmdCap: number;
  snapSab: SharedArrayBuffer;
  snapCap: number;
  carJson: string;
  rateHz: number;
}

interface SwapCarMsg {
  type: 'swapCar';
  carJson: string;
}

let wasm: RsWasm | null = null;
let carId = -1;
let bufPtr = 0;
let wasmBuf: Float64Array | null = null;
let specMass = 1400;
let Ix = 2400, Iy = 2600, Iz = 600;

let cmdRing: SabSpscRing | null = null;
let snapRing: SabSpscRing | null = null;
let rateHz = 400;
let running = false;

// Chassis state (three.js Y-up, origin = CG)
let px = 0, py = 0.5, pz = 0;
let qx = 0, qy = 0, qz = 0, qw = 1;
let vx = 0, vy = 0, vz = 0;
let wx = 0, wy = 0, wz = 0;

// Latest command state
let live = false;
const raw = new Float64Array(9);
const assists = new Float64Array(7);
let shiftUpPending = false;
let shiftDownPending = false;
let nosThrustN = 0;
let lastTurbo = -1;
let lastAirC = Number.NaN;
let lastTrackC = Number.NaN;
let lastAltM = Number.NaN;
let lastHum = Number.NaN;
let hasGround = false;
const groundPlanes = new Float64Array(96);   // 12 x [hit, px, py, pz, nx, ny, nz, surface]
const contactsPatch = new Float64Array(96);

const cmdSlot = new Float64Array(CMD_SLOT_DOUBLES);
const snapSlot = new Float64Array(SNAP_SLOT_DOUBLES);

let ticks = 0;
let stepUsEma = 0;

function getWasmBuf(): Float64Array {
  const m = wasm!;
  if (!wasmBuf || wasmBuf.buffer !== m.HEAPF64.buffer) {
    wasmBuf = new Float64Array(m.HEAPF64.buffer, bufPtr, OUT_DOUBLES);
  }
  return wasmBuf;
}

function loadCarJson(json: string): void {
  const m = wasm!;
  const p = m.stringToNewUTF8(json);
  const id = m._rs_create(p);
  m._free(p);
  if (id < 0) throw new Error('worker car config: ' + m.UTF8ToString(m._rs_last_error()));
  carId = id;
  bufPtr = m._rs_buffer(id);
  wasmBuf = null;
  m._rs_info(id);
  const b = getWasmBuf();
  specMass = b[0];
  Ix = b[1];
  Iy = b[2];
  Iz = b[3];
  lastTurbo = -1;
  lastAirC = Number.NaN;
}

function drainCommands(): void {
  const ring = cmdRing!;
  while (ring.tryPop(cmdSlot)) {
    const kind = cmdSlot[CMD_OFF.kind];
    if (kind === CMD_KIND.STOP) {
      running = false;
      return;
    }
    if (kind === CMD_KIND.REPAIR) {
      if (wasm && carId >= 0) wasm._rs_repair(carId);
      continue;
    }
    if (kind === CMD_KIND.RESET_POSE) {
      const o = CMD_OFF.resetPose;
      px = cmdSlot[o]; py = cmdSlot[o + 1]; pz = cmdSlot[o + 2];
      qx = cmdSlot[o + 3]; qy = cmdSlot[o + 4]; qz = cmdSlot[o + 5]; qw = cmdSlot[o + 6];
      vx = cmdSlot[o + 7]; vy = cmdSlot[o + 8]; vz = cmdSlot[o + 9];
      wx = cmdSlot[o + 10]; wy = cmdSlot[o + 11]; wz = cmdSlot[o + 12];
      const speed = cmdSlot[o + 13];
      const gear = Math.round(cmdSlot[o + 14]);
      if (wasm && carId >= 0) wasm._rs_reset_motion(carId, speed, gear);
      if (cmdSlot[CMD_OFF.hasGround] > 0.5) {
        groundPlanes.set(cmdSlot.subarray(CMD_OFF.ground, CMD_OFF.ground + 96), 0);
        hasGround = true;
      }
      live = cmdSlot[CMD_OFF.live] > 0.5;
      continue;
    }
    if (kind === CMD_KIND.FRAME) {
      live = cmdSlot[CMD_OFF.live] > 0.5;
      for (let i = 0; i < 9; i++) raw[i] = cmdSlot[CMD_OFF.raw + i];
      if (raw[5] > 0.5) shiftUpPending = true;
      if (raw[6] > 0.5) shiftDownPending = true;
      for (let i = 0; i < 7; i++) assists[i] = cmdSlot[CMD_OFF.assists + i];
      nosThrustN = cmdSlot[CMD_OFF.nosThrustN];
      const turbo = Math.round(cmdSlot[CMD_OFF.turboStage]);
      if (wasm && carId >= 0 && turbo !== lastTurbo) {
        wasm._rs_set_turbo_stage(carId, Math.max(0, Math.min(3, turbo)));
        lastTurbo = turbo;
      }
      const airC = cmdSlot[CMD_OFF.atmosphere];
      const trackC = cmdSlot[CMD_OFF.atmosphere + 1];
      const altM = cmdSlot[CMD_OFF.atmosphere + 2];
      const hum = cmdSlot[CMD_OFF.atmosphere + 3];
      if (wasm && carId >= 0 && (airC !== lastAirC || trackC !== lastTrackC || altM !== lastAltM || hum !== lastHum)) {
        wasm._rs_set_atmosphere(carId, airC, trackC, altM, hum);
        lastAirC = airC; lastTrackC = trackC; lastAltM = altM; lastHum = hum;
      }
      if (cmdSlot[CMD_OFF.hasGround] > 0.5) {
        groundPlanes.set(cmdSlot.subarray(CMD_OFF.ground, CMD_OFF.ground + 96), 0);
        hasGround = true;
      }
    }
  }
}

/** Intersect each fresh wheel ray with its cached ground plane (mirrors rs::ue5::intersect_ground_plane). */
function intersectGroundPlanes(b: Float64Array): void {
  for (let k = 0; k < 12; k++) {
    const co = 8 * k;
    if (!hasGround || groundPlanes[co] < 0.5) {
      contactsPatch[co] = 0;
      continue;
    }
    const ro = 280 + 6 * k;
    const ox = b[ro], oy = b[ro + 1], oz = b[ro + 2];
    const ex = b[ro + 3], ey = b[ro + 4], ez = b[ro + 5];
    const dx = ex - ox, dy = ey - oy, dz = ez - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) { contactsPatch[co] = 0; continue; }
    const invLen = 1 / len;
    const rdx = dx * invLen, rdy = dy * invLen, rdz = dz * invLen;

    const ppx = groundPlanes[co + 1], ppy = groundPlanes[co + 2], ppz = groundPlanes[co + 3];
    const nx = groundPlanes[co + 4], ny = groundPlanes[co + 5], nz = groundPlanes[co + 6];
    const denom = rdx * nx + rdy * ny + rdz * nz;
    if (denom > -1e-4) { contactsPatch[co] = 0; continue; }
    let t = ((ppx - ox) * nx + (ppy - oy) * ny + (ppz - oz) * nz) / denom;
    if (t < -0.05 || t > len) { contactsPatch[co] = 0; continue; }
    if (t < 0) t = 0;

    contactsPatch[co] = 1;
    contactsPatch[co + 1] = ox + rdx * t;
    contactsPatch[co + 2] = oy + rdy * t;
    contactsPatch[co + 3] = oz + rdz * t;
    contactsPatch[co + 4] = nx;
    contactsPatch[co + 5] = ny;
    contactsPatch[co + 6] = nz;
    contactsPatch[co + 7] = groundPlanes[co + 7];
  }
}

/** Rotate vector v by quaternion q = (qx, qy, qz, qw). */
function rotateVec(x: number, y: number, z: number, rx: number, ry: number, rz: number, rw: number, out: Float64Array, off: number): void {
  const tx = 2 * (ry * z - rz * y);
  const ty = 2 * (rz * x - rx * z);
  const tz = 2 * (rx * y - ry * x);
  out[off] = x + rw * tx + (ry * tz - rz * ty);
  out[off + 1] = y + rw * ty + (rz * tx - rx * tz);
  out[off + 2] = z + rw * tz + (rx * ty - ry * tx);
}

const tmpVec = new Float64Array(9);

function stepOnce(dt: number): void {
  const m = wasm!;
  const b = getWasmBuf();
  const t0 = performance.now();

  b[0] = px; b[1] = py; b[2] = pz;
  b[3] = qx; b[4] = qy; b[5] = qz; b[6] = qw;
  b[7] = vx; b[8] = vy; b[9] = vz;
  b[10] = wx; b[11] = wy; b[12] = wz;
  m._rs_rays_patch(carId);
  intersectGroundPlanes(b);
  b.set(contactsPatch, 280);

  // Auto-gearbox neutral-to-1st kick: the same rule as CarBody.tick (world.ts). Only when the car is nearly stopped and the box is
  // not grinding: a car rolling through neutral in the middle of a normal shift (the synchro model passes through it) must not get
  // a shiftUp, or each shift is pushed one gear higher again and fails (a spiral that ended in a 0 % gearbox stuck in neutral).
  const autoGear = assists[3] > 0.5;
  const curGear = Math.round(b[104] || 1);
  let shiftUp = shiftUpPending;
  if (autoGear && curGear === 1 && Math.abs(b[102]) < 1.0 && !(b[279] > 0.5) && raw[1] > 0.05 && raw[2] < 0.1) shiftUp = true;

  b[80] = raw[0]; b[81] = raw[1]; b[82] = raw[2]; b[83] = raw[3]; b[84] = raw[4];
  b[85] = shiftUp ? 1 : 0;
  b[86] = shiftDownPending ? 1 : 0;
  b[87] = raw[7];
  b[88] = assists[0]; b[89] = assists[1]; b[90] = assists[2]; b[91] = assists[3];
  b[92] = raw[8];
  b[93] = assists[4]; b[94] = assists[5]; b[95] = assists[6];
  shiftUpPending = false;
  shiftDownPending = false;

  m._rs_step_patch(carId, dt);

  // Forces and 6-DOF rigid body integration (three.js Y-up, exact Euler body-frame inertia matching check_core.mjs)
  const mass = b[274] > 0 ? b[274] : specMass;
  let fx = b[96], fy = b[97] - mass * 9.81, fz = b[98];
  if (nosThrustN > 0) {
    const fwdX = 2 * (qx * qz + qw * qy);
    const fwdZ = 1 - 2 * (qx * qx + qy * qy);
    fx += fwdX * nosThrustN;
    fz += fwdZ * nosThrustN;
  }
  const invM = dt / mass;
  vx += fx * invM;
  vy += fy * invM;
  vz += fz * invM;
  px += vx * dt;
  py += vy * dt;
  pz += vz * dt;

  // Body-frame angular velocity and torque via q^-1 = (-qx, -qy, -qz, qw)
  rotateVec(wx, wy, wz, -qx, -qy, -qz, qw, tmpVec, 0);
  rotateVec(b[99], b[100], b[101], -qx, -qy, -qz, qw, tmpVec, 3);
  const wbx = tmpVec[0], wby = tmpVec[1], wbz = tmpVec[2];
  const tbx = tmpVec[3], tby = tmpVec[4], tbz = tmpVec[5];
  const Iwx = Ix * wbx, Iwy = Iy * wby, Iwz = Iz * wbz;
  const nwbx = wbx + ((tbx - (wby * Iwz - wbz * Iwy)) / Ix) * dt;
  const nwby = wby + ((tby - (wbz * Iwx - wbx * Iwz)) / Iy) * dt;
  const nwbz = wbz + ((tbz - (wbx * Iwy - wby * Iwx)) / Iz) * dt;
  rotateVec(nwbx, nwby, nwbz, qx, qy, qz, qw, tmpVec, 6);
  wx = tmpVec[6]; wy = tmpVec[7]; wz = tmpVec[8];

  // Quaternion exponential integration
  const wLen = Math.hypot(wx, wy, wz);
  if (wLen > 1e-9) {
    const half = 0.5 * wLen * dt;
    const s = Math.sin(half) / wLen;
    const c = Math.cos(half);
    const dqx = wx * s, dqy = wy * s, dqz = wz * s, dqw = c;
    const nqx = dqw * qx + dqx * qw + dqy * qz - dqz * qy;
    const nqy = dqw * qy - dqx * qz + dqy * qw + dqz * qx;
    const nqz = dqw * qz + dqx * qy - dqy * qx + dqz * qw;
    const nqw = dqw * qw - dqx * qx - dqy * qy - dqz * qz;
    const invQ = 1 / Math.hypot(nqx, nqy, nqz, nqw);
    qx = nqx * invQ; qy = nqy * invQ; qz = nqz * invQ; qw = nqw * invQ;
  }

  const us = (performance.now() - t0) * 1000;
  stepUsEma = stepUsEma === 0 ? us : stepUsEma + (us - stepUsEma) * 0.02;
  ticks++;

  snapSlot[SNAP_OFF.tick] = ticks;
  snapSlot[SNAP_OFF.simTime] = ticks * dt;
  snapSlot[SNAP_OFF.stepUs] = stepUsEma;
  snapSlot[SNAP_OFF.rateHz] = rateHz;
  snapSlot[SNAP_OFF.pos] = px; snapSlot[SNAP_OFF.pos + 1] = py; snapSlot[SNAP_OFF.pos + 2] = pz;
  snapSlot[SNAP_OFF.quat] = qx; snapSlot[SNAP_OFF.quat + 1] = qy; snapSlot[SNAP_OFF.quat + 2] = qz; snapSlot[SNAP_OFF.quat + 3] = qw;
  snapSlot[SNAP_OFF.vel] = vx; snapSlot[SNAP_OFF.vel + 1] = vy; snapSlot[SNAP_OFF.vel + 2] = vz;
  snapSlot[SNAP_OFF.angvel] = wx; snapSlot[SNAP_OFF.angvel + 1] = wy; snapSlot[SNAP_OFF.angvel + 2] = wz;
  snapSlot.set(b, SNAP_OFF.out);
  snapRing!.tryPush(snapSlot, false);
}

function runLoop(): void {
  const dt = 1 / rateHz;
  const maxSteps = Math.max(1, Math.ceil(rateHz * 0.1));   // 0.1 s spiral-of-death clamp
  let lastMs = performance.now();
  let acc = 0;

  // Yield briefly via setTimeout(0) every ~50 ms so postMessage('swapCar') can still be processed
  // while keeping sub-millisecond Atomics.wait cadence inside each slice.
  function slice(): void {
    const sliceEnd = performance.now() + 50;
    while (running && performance.now() < sliceEnd) {
      drainCommands();
      if (!running) return;
      const now = performance.now();
      const elapsed = Math.min(0.1, Math.max(0, (now - lastMs) / 1000));
      lastMs = now;
      if (live && hasGround) {
        acc += elapsed;
        let ran = 0;
        while (acc >= dt && ran < maxSteps) {
          stepOnce(dt);
          acc -= dt;
          ran++;
        }
        if (ran === maxSteps) acc = 0;
        const waitMs = Math.max(0.5, Math.min(4, (dt - acc) * 1000));
        cmdRing!.waitForNotify(waitMs);
      } else {
        acc = 0;
        cmdRing!.waitForNotify(8);
      }
    }
    if (running) setTimeout(slice, 0);
  }
  slice();
}

self.onmessage = async (ev: MessageEvent<InitMsg | SwapCarMsg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    try {
      wasm = (await createRsCore({ locateFile: () => wasmUrl })) as RsWasm;
      cmdRing = new SabSpscRing(msg.cmdSab, msg.cmdCap, CMD_SLOT_DOUBLES);
      snapRing = new SabSpscRing(msg.snapSab, msg.snapCap, SNAP_SLOT_DOUBLES);
      rateHz = Math.max(60, Math.min(1000, msg.rateHz | 0));
      loadCarJson(msg.carJson);
      running = true;
      self.postMessage({ type: 'ready', rateHz });
      runLoop();
    } catch (e) {
      self.postMessage({ type: 'error', error: String(e) });
    }
  } else if (msg.type === 'swapCar') {
    try {
      loadCarJson(msg.carJson);
    } catch (e) {
      console.error('[physWorker] swapCar failed:', e);
    }
  }
};
