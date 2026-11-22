// Apache-2.0. open-grid-physics: Open Grid's vehicle physics core (C++, compiled to WebAssembly) for any JS engine.
//
// Axes: three.js world, Y up, the car drives along its local +Z, local +X is the car's LEFT. Units: SI (m, s, kg, N).
// Your engine owns the rigid body; every step this core turns its state plus the ground under each wheel into a force
// and a torque at the centre of gravity:
//
//   const physics = await loadPhysics();
//   const car = physics.createCar(specJson);          // car/1 spec (see cars/example_coupe.json)
//   each fixed step (240 Hz recommended):
//     const rays = car.rays(state);                   // state: pos xyz, quat xyzw, vel xyz, angvel xyz (world)
//     ... raycast each wheel from rays[6i..6i+2] to rays[6i+3..6i+5] in YOUR world ...
//     const out = car.step(contacts, input, dt);      // contacts: 4 x [hit, px, py, pz, nx, ny, nz, surface]
//     body.addForce(out.force); body.addTorque(out.torque);   // world frame, at the CG; you add gravity
//
// The buffer layout mirrors web/wasm/bridge.cpp, the same bridge the Open Grid game uses.

let modulePromise = null;
let mod = null;

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

async function loadModule(options) {
  const { default: createRsCore } = await import('./dist/rs_core.js');
  const wasmUrl = options.wasmUrl || new URL('./dist/rs_core.wasm', import.meta.url);
  if (options.wasmBinary) return createRsCore({ wasmBinary: options.wasmBinary });
  if (isNode) {
    const fs = await import('node:fs');
    return createRsCore({ wasmBinary: fs.readFileSync(wasmUrl) });
  }
  return createRsCore({ locateFile: () => String(wasmUrl) });
}

/**
 * Load the WebAssembly core once. Options: { wasmUrl } to serve the .wasm from your own path, or { wasmBinary }
 * (ArrayBuffer / Uint8Array) if you load it yourself.
 */
export async function loadPhysics(options = {}) {
  if (!modulePromise) modulePromise = loadModule(options).then((m) => (mod = m));
  await modulePromise;
  return new Physics();
}

export const DEFAULT_INPUT = Object.freeze({
  steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, shiftUp: false, shiftDown: false, device: 1,
});
export const DEFAULT_ASSISTS = Object.freeze({ abs: true, tc: true, esc: false, autoGearbox: true, autoClutch: 'perfect' });

export class Physics {
  /** A car from a car/1 spec (JSON text or object). Throws with the parser's message if the spec is invalid. */
  createCar(spec) { return new Car(typeof spec === 'string' ? spec : JSON.stringify(spec)); }
}

function view(id, ptr) { return new Float64Array(mod.HEAPF64.buffer, ptr, 448); }

export class Car {
  constructor(json) {
    const p = mod.stringToNewUTF8(json);
    this.id = mod._rs_create(p);
    mod._free(p);
    if (this.id < 0) throw new Error('car spec: ' + mod.UTF8ToString(mod._rs_last_error()));
    this._ptr = mod._rs_buffer(this.id);
    this._buf = null;
    mod._rs_info(this.id);
    const b = this.buf;
    /** Static facts from the spec: mass kg, principal inertia kg m^2 (body x, y, z), CG height m, rpm limits. */
    this.info = {
      mass: b[0], inertia: [b[1], b[2], b[3]], cgHeight: b[4], redline: b[7], idle: b[8],
      surfaces: { asphalt: b[9], pavement: b[10], wall: b[11] },
      driven: { front: b[12] > 0.5, rear: b[13] > 0.5 },
    };
    const spec = JSON.parse(json);
    this.info.wheelbase = spec.chassis && spec.chassis.wheelbase_m;
    this.info.maxSteerDeg = spec.front_axle && spec.front_axle.max_steer_deg;
    this.info.name = spec.name;
    const dt = spec.drivetrain || {};
    this.info.gearRatios = dt.gear_ratios || [];
    this.info.finalDrive = dt.final_drive || 1;
    this.info.wheelRadius = (spec.tire_rear && spec.tire_rear.radius_m) || 0.32;
    this.output = makeOutput();
  }

  /** Gearbox index for cruising at speed v m/s: the highest forward gear keeping rpm above ~55% of redline. */
  gearFor(v) {
    const r = this.info.gearRatios;
    let best = -1;
    for (let g = 2; g < r.length; g++) {
      const rpm = (v / this.info.wheelRadius) * r[g] * this.info.finalDrive * 60 / (2 * Math.PI);
      if (rpm > this.info.redline * 0.95) continue;
      if (best >= 0 && rpm < this.info.redline * 0.55) break;
      best = g;
    }
    return best >= 0 ? best : r.length - 1;
  }

  /** Raw view over the shared buffer (layout: web/wasm/bridge.cpp). Re-wrapped if WASM memory grows. */
  get buf() {
    if (!this._buf || this._buf.buffer !== mod.HEAPF64.buffer) this._buf = view(this.id, this._ptr);
    return this._buf;
  }

  /** Suspension rays for this state: 4 wheels (FL, FR, RL, RR) x [from xyz, to xyz]. */
  rays(state) {
    const b = this.buf;
    for (let i = 0; i < 13; i++) b[i] = state[i];
    mod._rs_rays(this.id);
    return b.subarray(16, 40);
  }

  /**
   * One physics step. contacts: 4 x [hit 0/1, point xyz, normal xyz, surface index] for the rays from rays().
   * input: { steer -1 right .. +1 left, throttle 0..1, brake 0..1, clutch 0..1, handbrake 0..1, shiftUp, shiftDown,
   * device 0 keyboard | 1 gamepad | 2 wheel }. Keyboard and gamepad steering is filtered and reduced with speed the
   * way a game would; device 2 passes it straight through (use it for wheels and bots). With autoGearbox on, brake at
   * a standstill selects reverse. Returns this.output (reused every call; copy what you keep).
   */
  step(contacts, input = DEFAULT_INPUT, dt = 1 / 240, assists = DEFAULT_ASSISTS) {
    const b = this.buf;
    for (let i = 0; i < 32; i++) b[48 + i] = contacts[i];
    writeInputs(b, { ...DEFAULT_INPUT, ...input }, { ...DEFAULT_ASSISTS, ...assists });
    mod._rs_step(this.id, dt);
    return readOutput(b, this.output);
  }

  /** Teleport helper: set wheel speeds and gear to match a body you just placed at forward speed (m/s). */
  resetMotion(speed, gear = -1) { mod._rs_reset_motion(this.id, speed, gear); }
  /** Fix damage, refuel, restore the engine. */
  repair() { mod._rs_repair(this.id); }
  /** Water film on the road in mm (0 = dry): wet grip and aquaplaning. */
  setRoadWater(mm) { mod._rs_set_road_water(this.id, mm); }
  /** Air and track temperature (C), altitude (m), humidity (0..1): air density, engine power, tyre heating. */
  setAtmosphere(airC, trackC, altitudeM = 15, humidity = 0.5) { mod._rs_set_atmosphere(this.id, airC, trackC, altitudeM, humidity); }
  /** Crash input for the next step: contact point (world), impulse N s, id of the other object. */
  contact(point, impulse, otherId = 0) { mod._rs_contact(this.id, point[0], point[1], point[2], impulse, otherId); }
}

function writeInputs(b, raw, a) {
  b[80] = raw.steer; b[81] = raw.throttle; b[82] = raw.brake; b[83] = raw.clutch; b[84] = raw.handbrake;
  b[85] = raw.shiftUp ? 1 : 0; b[86] = raw.shiftDown ? 1 : 0; b[87] = raw.device;
  b[88] = +a.abs; b[89] = +a.tc; b[90] = +a.esc; b[91] = +a.autoGearbox;
  b[93] = a.absSlip ?? 0; b[94] = a.tcSlip ?? 0; b[95] = a.countersteer ?? 0;
  b[92] = raw.directGear ?? -99;
  b[41] = raw.lineLock ?? 0;
  b[40] = a.autoClutch === 'off' ? -1 : a.autoClutch === 'poor' ? 2 : a.autoClutch === 'normal' ? 1 : 0;
}

function makeOutput() {
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    wheels.push({ centre: [0, 0, 0], steer: 0, spin: 0, contact: false, load: 0, slipRatio: 0, slipAngle: 0,
      compression: 0, angularVelocity: 0, surface: 0, temperature: 0, wear: 0 });
  }
  return { force: [0, 0, 0], torque: [0, 0, 0], speed: 0, rpm: 0, gear: 0, sideslip: 0, stalled: false,
    throttle: 0, brake: 0, steer: 0, abs: false, tc: false, esc: false, steerTorque: 0, massKg: 0, fuelLiters: 0,
    wheels };
}

// Offsets: web/wasm/bridge.cpp rs_step (same as web/src/physics/core.ts OUT)
function readOutput(b, o) {
  o.force[0] = b[96]; o.force[1] = b[97]; o.force[2] = b[98];
  o.torque[0] = b[99]; o.torque[1] = b[100]; o.torque[2] = b[101];
  o.speed = b[102]; o.rpm = b[103]; o.gear = b[104]; o.sideslip = b[105]; o.stalled = b[106] > 0.5;
  o.throttle = b[107]; o.brake = b[108]; o.steer = b[109];
  o.abs = b[113] > 0.5; o.tc = b[114] > 0.5; o.esc = b[115] > 0.5; o.steerTorque = b[116];
  o.massKg = b[274]; o.fuelLiters = b[260];
  for (let i = 0; i < 4; i++) {
    const w = o.wheels[i], k = 120 + 12 * i;
    w.centre[0] = b[k]; w.centre[1] = b[k + 1]; w.centre[2] = b[k + 2];
    w.steer = b[k + 3]; w.spin = b[k + 4]; w.contact = b[k + 5] > 0.5; w.load = b[k + 6];
    w.slipRatio = b[k + 7]; w.slipAngle = b[k + 8]; w.compression = b[k + 9]; w.angularVelocity = b[k + 10];
    w.surface = b[k + 11];
    w.temperature = b[168 + 4 * i + 2]; w.wear = b[168 + 4 * i + 3];
  }
  return o;
}
