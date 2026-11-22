// Typed wrapper over the WASM bridge (web/wasm/bridge.cpp). Buffer offsets mirror that file.
// Everything here is already in three.js world axes: the bridge does all axis conversion.
import createRsCore from './rs_core.js';
import wasmUrl from './rs_core.wasm?url';

interface RsModule {
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
  _rs_set_road_water(id: number, mm: number): void;
  _rs_dyno_begin(id: number): void;
  _rs_dyno_end(id: number): void;
  _rs_dyno_reset_meter(id: number): void;
  _rs_dyno_step(id: number, dt: number): void;
  _rs_dyno_curve(id: number): number;
  _rs_cluster_sweep(id: number): void;
  _rs_set_turbo_stage(id: number, stage: number): void;
  _rs_rays(id: number): void;
  _rs_rays_patch(id: number): void;
  _rs_step(id: number, dt: number): void;
  _rs_step_patch(id: number, dt: number): void;
  _rs_contact(id: number, x: number, y: number, z: number, impulse: number, other: number): void;
  _rs_damage(id: number): void;
  _rs_repair(id: number): void;
  _rs_race_create(json: number, laps: number): number;
  _rs_race_buffer(): number;
  _rs_race_add(x: number, y: number, z: number): number;
  _rs_race_update(car: number, x: number, y: number, z: number, time: number): void;
}

let mod: RsModule | null = null;
export async function loadCore(): Promise<void> {
  mod = (await createRsCore({ locateFile: () => wasmUrl })) as RsModule;
}

export interface RawInput {
  steer: number; throttle: number; brake: number; clutch: number; handbrake: number; lineLock?: number;
  shiftUp: boolean; shiftDown: boolean; device: 0 | 1 | 2;
  /** H-pattern shifter: gear index the lever is in (0 R, 1 N, 2 1st ...); undefined / -99 = no shifter */
  directGear?: number;
}
export interface AssistToggles {
  abs: boolean; tc: boolean; esc: boolean; autoGearbox: boolean;
  /** strengths (assists.ts levels): ABS / TC wheel-slip targets, countersteer gain; 0 / absent = core default / off */
  absSlip?: number; tcSlip?: number; countersteer?: number;
  /** auto-clutch assist quality (default 'perfect'): 'off' = full manual clutch */
  autoClutch?: 'off' | 'poor' | 'normal' | 'perfect';
}

export interface CarInfo {
  mass: number; inertia: [number, number, number]; cgHeight: number;
  redline: number; idle: number; surfaces: { asphalt: number; pavement: number; wall: number };
}

export class CoreCar {
  readonly id: number;
  readonly info: CarInfo;
  private _buf: Float64Array | null = null;
  private _raysBuf: Float64Array | null = null;
  private _raysPatchBuf: Float64Array | null = null;
  private _ptr = 0;

  constructor(json: string) {
    if (!mod) throw new Error('loadCore() first');
    const p = mod.stringToNewUTF8(json);
    this.id = mod._rs_create(p);
    mod._free(p);
    if (this.id < 0) throw new Error('car config: ' + mod.UTF8ToString(mod._rs_last_error()));
    this._ptr = mod._rs_buffer(this.id);
    mod._rs_info(this.id);
    const b = this.buf;
    this.info = {
      mass: b[0], inertia: [b[1], b[2], b[3]], cgHeight: b[4], redline: b[7], idle: b[8],
      surfaces: { asphalt: b[9], pavement: b[10], wall: b[11] },
    };
  }

  // Cached view over WASM heap: only re-wrapped if WASM memory grows and detaches the old buffer.
  get buf(): Float64Array {
    const m = mod!;
    if (!this._buf || this._buf.buffer !== m.HEAPF64.buffer) {
      this._buf = new Float64Array(m.HEAPF64.buffer, this._ptr, 448);
      this._raysBuf = this._buf.subarray(16, 40);
      this._raysPatchBuf = this._buf.subarray(280, 352);
    }
    return this._buf;
  }

  resetMotion(speed: number, gear = -1) { mod!._rs_reset_motion(this.id, speed, gear); }

  /** Live ISA climate & asphalt temperature -> C++ air density, NA/turbo power, and road-to-tread conduction. */
  setAtmosphere(airC: number, trackC: number, altitudeM = 15, humidity = 0.5) {
    mod!._rs_set_atmosphere(this.id, airC, trackC, altitudeM, humidity);
  }

  /** Rain water film on the road (mm): wet grip and aquaplaning in the core (0 = dry). */
  setRoadWater(mm: number) { mod!._rs_set_road_water(this.id, mm); }

  /** Forced-induction turbo stage (0 = NA, 1..3 = Stage 1-3 turbocharger with spool & BOV flutter). */
  setTurboStage(stage: number) {
    mod!._rs_set_turbo_stage(this.id, Math.max(0, Math.min(3, Math.round(stage))));
  }

  /** Crash input for the current tick: point in three world, impulse N s, other object id. */
  contact(p: { x: number; y: number; z: number }, impulse: number, other: number) {
    mod!._rs_contact(this.id, p.x, p.y, p.z, impulse, other);
  }

  repair() { mod!._rs_repair(this.id); }

  damage(): Damage {
    mod!._rs_damage(this.id);
    const b = this.buf;
    const a = (o: number) => [b[o], b[o + 1], b[o + 2], b[o + 3]];
    return {
      crush: a(200), zone: a(204), wheel: a(208), engine: b[212], lastKj: b[213],
      lastPoint: [b[214], b[215], b[216]], lastZone: b[217], impacts: b[218], totaled: b[219] > 0.5, totalKj: b[220],
      smoulder: b[221], fire: b[222], brakes: b[223], brakesFailed: b[224] > 0.5, severity: b[225],
    };
  }

  /** state: pos(3) quat xyzw(4) vel(3) angvel(3). Returns ray from/to per wheel (FL, FR, RL, RR). */
  rays(state: ArrayLike<number>): Float64Array {
    const b = this.buf;
    for (let i = 0; i < 13; i++) b[i] = state[i];
    mod!._rs_rays(this.id);
    return this._raysBuf!;
  }

  /** Multi-point 3-ray longitudinal curb contact patch per wheel (12 rays = 72 doubles: 4 wheels x 3 rays x [from,to]). */
  raysPatch(state: ArrayLike<number>): Float64Array {
    const b = this.buf;
    for (let i = 0; i < 13; i++) b[i] = state[i];
    mod!._rs_rays_patch(this.id);
    return this._raysPatchBuf!;
  }

  /** contacts: 4 x [hit, px, py, pz, nx, ny, nz, surface]. Returns the output view (see bridge). */
  step(contacts: ArrayLike<number>, raw: RawInput, assists: AssistToggles, dt: number): Float64Array {
    const b = this.buf;
    for (let i = 0; i < 32; i++) b[48 + i] = contacts[i];
    b[80] = raw.steer; b[81] = raw.throttle; b[82] = raw.brake; b[83] = raw.clutch; b[84] = raw.handbrake;
    b[85] = raw.shiftUp ? 1 : 0; b[86] = raw.shiftDown ? 1 : 0; b[87] = raw.device;
    b[88] = +assists.abs; b[89] = +assists.tc; b[90] = +assists.esc; b[91] = +assists.autoGearbox;
    b[93] = assists.absSlip ?? 0; b[94] = assists.tcSlip ?? 0; b[95] = assists.countersteer ?? 0;
    b[92] = raw.directGear ?? -99;
    b[41] = raw.lineLock ?? 0;
    b[40] = assists.autoClutch === 'off' ? -1 : assists.autoClutch === 'poor' ? 2 : assists.autoClutch === 'normal' ? 1 : 0;
    mod!._rs_step(this.id, dt);
    return b;
  }

  // ---- Garage dyno (core rs/dyno.hpp): the same car on a flat virtual road under straps; see the bridge for slots.
  /** Dashboard needles (core rs/cluster.hpp): tach / speedo pointer positions, limiter cut, dial ranges. */
  cluster() {
    const b = this.buf;
    return { tachRpm: b[420], speedoKmh: b[421], limiterCut: b[422] > 0.5, tachMaxRpm: b[423], speedoMaxKmh: b[424] };
  }
  /** Key on: needle sweep to full scale and back (cluster self-test). */
  clusterSweep() { mod!._rs_cluster_sweep(this.id); }

  dynoBegin() { mod!._rs_dyno_begin(this.id); }
  dynoEnd() { mod!._rs_dyno_end(this.id); }
  dynoResetMeter() { mod!._rs_dyno_reset_meter(this.id); }
  dynoStep(raw: RawInput, assists: AssistToggles, dt: number): Float64Array {
    this.writeInputs(raw, assists);
    mod!._rs_dyno_step(this.id, dt);
    return this.buf;
  }
  /** Live and peak readings (SI units: W, Nm, m/s, s). */
  dynoReadout() {
    const b = this.buf;
    return { rpm: b[407], speed: b[408], wheelPower: b[409], crankTorque: b[410], peakPower: b[411], peakPowerRpm: b[412],
      peakTorque: b[413], peakTorqueRpm: b[414], topSpeed: b[415], zeroTo100: b[416], distance: b[417], wheelForce: b[418] };
  }
  /** Body pose of the virtual road car (three world): position xyz, quaternion xyzw. */
  dynoPose(): Float64Array { return this.buf.subarray(400, 407); }
  /** Power / torque curve: [rpm, wheel power W, crank torque Nm] per 100 rpm with a full-throttle reading. */
  dynoCurve(): [number, number, number][] {
    const p = mod!._rs_dyno_curve(this.id) >> 3, h = mod!.HEAPF64, n = h[p], out: [number, number, number][] = [];
    for (let i = 0; i < n; i++) out.push([h[p + 1 + 3 * i], h[p + 2 + 3 * i], h[p + 3 + 3 * i]]);
    return out;
  }

  private writeInputs(raw: RawInput, assists: AssistToggles) {
    const b = this.buf;
    b[80] = raw.steer; b[81] = raw.throttle; b[82] = raw.brake; b[83] = raw.clutch; b[84] = raw.handbrake;
    b[85] = raw.shiftUp ? 1 : 0; b[86] = raw.shiftDown ? 1 : 0; b[87] = raw.device;
    b[88] = +assists.abs; b[89] = +assists.tc; b[90] = +assists.esc; b[91] = +assists.autoGearbox;
    b[93] = assists.absSlip ?? 0; b[94] = assists.tcSlip ?? 0; b[95] = assists.countersteer ?? 0;
    b[92] = raw.directGear ?? -99;
    b[41] = raw.lineLock ?? 0;
    b[40] = assists.autoClutch === 'off' ? -1 : assists.autoClutch === 'poor' ? 2 : assists.autoClutch === 'normal' ? 1 : 0;
  }

  /** Multi-point curb patch step: contacts12 = 12 x [hit, px, py, pz, nx, ny, nz, surface] (96 doubles). */
  stepPatch(contacts12: ArrayLike<number>, raw: RawInput, assists: AssistToggles, dt: number): Float64Array {
    const b = this.buf;
    for (let i = 0; i < 96; i++) b[280 + i] = contacts12[i];
    b[80] = raw.steer; b[81] = raw.throttle; b[82] = raw.brake; b[83] = raw.clutch; b[84] = raw.handbrake;
    b[85] = raw.shiftUp ? 1 : 0; b[86] = raw.shiftDown ? 1 : 0; b[87] = raw.device;
    b[88] = +assists.abs; b[89] = +assists.tc; b[90] = +assists.esc; b[91] = +assists.autoGearbox;
    b[93] = assists.absSlip ?? 0; b[94] = assists.tcSlip ?? 0; b[95] = assists.countersteer ?? 0;
    b[92] = raw.directGear ?? -99;
    b[41] = raw.lineLock ?? 0;
    b[40] = assists.autoClutch === 'off' ? -1 : assists.autoClutch === 'poor' ? 2 : assists.autoClutch === 'normal' ? 1 : 0;
    mod!._rs_step_patch(this.id, dt);
    return b;
  }
}

export interface Damage {
  crush: number[]; zone: number[]; wheel: number[]; engine: number; lastKj: number;
  lastPoint: [number, number, number]; lastZone: number; impacts: number; totaled: boolean; totalKj: number;
  /** engine bay: smoke phase 0..1, then fire 0..1 (grows); brakes: effectiveness 1..0, failed = none at all */
  smoulder: number; fire: number; brakes: number; brakesFailed: boolean; severity: number;
}

// Output offsets (bridge.cpp, rs_step)
export const OUT = {
  /** dashboard (rs/cluster.hpp): tach / speedo pointer, limiter cut 0/1, dial ends */
  tachNeedle: 420, speedoNeedle: 421, limiterCut: 422, tachMax: 423, speedoMax: 424,
  force: 96, torque: 99, speed: 102, rpm: 103, gear: 104, sideslip: 105, stalled: 106,
  throttle: 107, brake: 108, steer: 109, abs: 113, tc: 114, esc: 115, steerTorque: 116,
  wheel: (i: number) => 120 + 12 * i,   // centre xyz, steer, spin, contact, load, slipRatio, slipAngle, compression, angVel, surface
  wheelExt: (i: number) => 168 + 4 * i, // mz (N m), camber (rad), core temperature (C), wear (0..1)
  brakeTemp: (i: number) => 184 + i,    // brake disc temperature, C
  treadSurface: (i: number) => 188 + i, // tread surface temperature, C
  pressure: (i: number) => 192 + i,     // tyre pressure, kPa gauge
  padMu: (i: number) => 196 + i,        // brake pad friction vs. its working range (< 1: cold or fading)
  // Extended Simcenter Tire 2606 & AAA telemetry [226..273]
  tireInner: (i: number) => 226 + i,    // inner rib tread temperature, C
  tireMiddle: (i: number) => 230 + i,   // middle rib tread temperature, C
  tireOuter: (i: number) => 234 + i,    // outer rib tread temperature, C
  tireFlash: (i: number) => 238 + i,    // WLF micro-asperity flash temperature, C
  flatSpot: (i: number) => 242 + i,     // brake-lockup flat-spot depth, mm
  cavityGain: (i: number) => 246 + i,   // Simcenter 2606 ~225 Hz toroidal cavity boom gain 0..1
  cavityLowHz: 250,                     // Doppler-split lower cavity frequency, Hz
  cavityHighHz: 251,                    // Doppler-split upper cavity frequency, Hz
  boostBar: 252,                        // turbo boost pressure, bar
  bovVenting: 253,                      // turbo blow-off valve flutter trigger (0/1)
  shiftCut: 254,                        // dog-box / DCT ignition-cut backfire trigger (0/1)
  drsActive: 255,                       // active aero DRS low-drag active (0/1)
  airbrakeActive: 256,                  // active aero high-downforce airbrake active (0/1)
  splitterStalled: 257,                 // ground-effect front splitter stall (0/1)
  oilTemp: 258,                         // engine oil temperature, C
  intakeAirTemp: 259,                   // intercooler intake air temperature, C
  fuelLiters: 260,                      // remaining fuel tank volume, L
  chassisTwist: 261,                    // frame torsional twist angle, deg
  brakeVaporSponge: 262,                // DOT 4 brake fluid boiling vapor-lock sponge 0..0.55
  airDensity: 263,                      // live ISA atmospheric air density, kg/m^3
  aycMoment: 264,                       // active torque-vectoring E-Diff yaw moment, N m
  blistering: (i: number) => 265 + i,   // internal rubber blistering 0..1
  graining: (i: number) => 269 + i,     // cold-tire surface graining 0..1
  treadPitchHz: 273,                    // tread block impact pitch frequency, Hz
  massKg: 274,                          // current total mass: spec (full tank) minus burnt fuel, kg
  clutchTemp: 275,                      // physical clutch friction disc temperature, C
  clutchHealth: 276,                    // clutch lining health, 0..1
  gearboxHealth: 277,                   // gearbox synchro & tooth health, 0..1
  missedShifts: 278,                    // cumulative missed shifts / tooth pop-outs counter
  gearGrind: 279,                       // active synchro / dog-tooth grind flag (0/1)
  // Dynamic kinematic suspension & 3-node tire telemetry [376..385] (camber is at wheelExt(i) + 1)
  wheelToe: (i: number) => 376 + i,     // dynamic alignment toe-in (+ = toe-in), rad
  rollCentreFront: 380,                 // dynamic front axle kinematic roll-centre height, m
  rollCentreRear: 381,                  // dynamic rear axle kinematic roll-centre height, m
  tireInnerAir: (i: number) => 382 + i, // cavity inner-air temperature (Node 3), C
} as const;

export interface LapInfo { laps: number; current: number; last: number; best: number; distance: number; position: number; finished: boolean; routeLength: number }

/** Core RaceTracker: progress along the route, laps and lap times (game logic stays in the core). */
export class CoreRace {
  private _buf: Float64Array | null = null;
  private _ptr = 0;
  private _infos: LapInfo[] = [];

  constructor(routeJson: string, laps = 0) {
    const p = mod!.stringToNewUTF8(routeJson);
    const r = mod!._rs_race_create(p, laps);
    mod!._free(p);
    if (r < 0) throw new Error('route: ' + mod!.UTF8ToString(mod!._rs_last_error()));
    this._ptr = mod!._rs_race_buffer();
  }
  addCar(p: { x: number; y: number; z: number }): number { return mod!._rs_race_add(p.x, p.y, p.z); }
  update(car: number, p: { x: number; y: number; z: number }, time: number): LapInfo {
    const m = mod!;
    m._rs_race_update(car, p.x, p.y, p.z, time);
    if (!this._buf || this._buf.buffer !== m.HEAPF64.buffer) {
      this._buf = new Float64Array(m.HEAPF64.buffer, this._ptr, 16);
    }
    const b = this._buf;
    let info = this._infos[car];
    if (!info) {
      info = { laps: 0, current: 0, last: 0, best: 0, distance: 0, position: 0, finished: false, routeLength: 0 };
      this._infos[car] = info;
    }
    info.laps = b[0];
    info.current = b[1];
    info.last = b[2];
    info.best = b[3];
    info.distance = b[4];
    info.position = b[5];
    info.finished = b[6] > 0.5;
    info.routeLength = b[7];
    return info;
  }
}
