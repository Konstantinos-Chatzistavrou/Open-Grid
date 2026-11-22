// Types for open-grid-physics. Axes: three.js world (Y up); the car drives along local +Z, local +X is its LEFT.

export type Vec3 = [number, number, number];

export interface LoadOptions {
  /** Where to fetch rs_core.wasm from (browser). Defaults to the file next to index.js. */
  wasmUrl?: string | URL;
  /** The .wasm bytes, if you load them yourself. */
  wasmBinary?: ArrayBuffer | Uint8Array;
}

export interface DriverInput {
  /** -1 full right .. +1 full left */
  steer?: number;
  throttle?: number;
  brake?: number;
  /** 0 released .. 1 pedal down */
  clutch?: number;
  handbrake?: number;
  shiftUp?: boolean;
  shiftDown?: boolean;
  /** 0 keyboard, 1 gamepad (both get speed-sensitive steering filtering), 2 wheel (steer passed straight through). */
  device?: 0 | 1 | 2;
  /** Select a gearbox index directly (H-pattern): 0 reverse, 1 neutral, 2 first, ... */
  directGear?: number;
  lineLock?: number;
}

export interface Assists {
  abs?: boolean;
  tc?: boolean;
  esc?: boolean;
  autoGearbox?: boolean;
  autoClutch?: 'off' | 'poor' | 'normal' | 'perfect';
  absSlip?: number;
  tcSlip?: number;
  countersteer?: number;
}

export const DEFAULT_INPUT: Readonly<Required<Pick<DriverInput, 'steer' | 'throttle' | 'brake' | 'clutch' | 'handbrake' | 'shiftUp' | 'shiftDown' | 'device'>>>;
export const DEFAULT_ASSISTS: Readonly<Assists>;

export interface CarInfo {
  name: string;
  mass: number;
  /** Principal inertia, body axes (x left, y up, z forward), kg m^2 */
  inertia: Vec3;
  cgHeight: number;
  redline: number;
  idle: number;
  surfaces: { asphalt: number; pavement: number; wall: number };
  driven: { front: boolean; rear: boolean };
  wheelbase: number;
  maxSteerDeg: number;
  gearRatios: number[];
  finalDrive: number;
  wheelRadius: number;
}

export interface WheelOutput {
  centre: Vec3;
  /** road-wheel steer angle, rad */
  steer: number;
  /** spin angle, rad (for drawing) */
  spin: number;
  contact: boolean;
  /** vertical load, N */
  load: number;
  slipRatio: number;
  /** rad */
  slipAngle: number;
  /** m */
  compression: number;
  /** rad/s */
  angularVelocity: number;
  surface: number;
  /** tyre core temperature, C */
  temperature: number;
  /** 0 new .. 1 worn out */
  wear: number;
}

export interface StepOutput {
  /** World-frame force at the CG, N. Gravity is NOT included: add it yourself (or let your engine do it). */
  force: Vec3;
  /** World-frame torque about the CG, N m */
  torque: Vec3;
  /** forward speed, m/s */
  speed: number;
  rpm: number;
  /** gearbox index: 0 reverse, 1 neutral, 2 first, ... */
  gear: number;
  /** rad */
  sideslip: number;
  stalled: boolean;
  /** pedal/steer values after assists and filtering */
  throttle: number;
  brake: number;
  steer: number;
  abs: boolean;
  tc: boolean;
  esc: boolean;
  /** steering-rack torque for force feedback, N m */
  steerTorque: number;
  /** current mass including fuel, kg */
  massKg: number;
  fuelLiters: number;
  wheels: [WheelOutput, WheelOutput, WheelOutput, WheelOutput];
}

export declare class Car {
  readonly id: number;
  readonly info: CarInfo;
  /** Raw shared buffer (layout: web/wasm/bridge.cpp). */
  readonly buf: Float64Array;
  /** state: pos xyz, quat xyzw, vel xyz, angvel xyz (world). Returns 4 x [from xyz, to xyz] (FL, FR, RL, RR). */
  rays(state: ArrayLike<number>): Float64Array;
  /** contacts: 4 x [hit 0|1, point xyz, normal xyz, surface]. The returned object is reused every call. */
  step(contacts: ArrayLike<number>, input?: DriverInput, dt?: number, assists?: Assists): StepOutput;
  /** Gearbox index that suits cruising at v m/s. */
  gearFor(v: number): number;
  /** Match wheel speeds and gear to a body you just placed at forward speed (m/s). gear -1 keeps the current one. */
  resetMotion(speed: number, gear?: number): void;
  repair(): void;
  setRoadWater(mm: number): void;
  setAtmosphere(airC: number, trackC: number, altitudeM?: number, humidity?: number): void;
  contact(point: Vec3, impulse: number, otherId?: number): void;
}

export declare class Physics {
  /** car/1 spec as JSON text or object; throws with the parser's message if invalid. */
  createCar(spec: string | object): Car;
}

export function loadPhysics(options?: LoadOptions): Promise<Physics>;
