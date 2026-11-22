import type { Assists, Car, CarInfo, DriverInput, Physics, StepOutput, Vec3 } from './index.js';

export const GRAVITY: number;

export declare class FlatGroundCar {
  constructor(car: Car, options?: { position?: [number, number | null, number]; yaw?: number; groundY?: number; surface?: number });
  readonly car: Car;
  pos: Vec3;
  quat: [number, number, number, number];
  vel: Vec3;
  angVel: Vec3;
  time: number;
  forward(): Vec3;
  left(): Vec3;
  /** Forward speed in m/s; gear defaults to car.gearFor(v). */
  setSpeed(v: number, gear?: number): void;
  step(input: DriverInput, dt?: number, assists?: Assists): StepOutput;
}

export interface RouteSample {
  p: Vec3;
  dir: Vec3;
  /** 1/m, + = left */
  curvature: number;
  widthLeft: number;
  widthRight: number;
  s: number;
}

export declare class FlatRoute {
  constructor(routeJson: string | object);
  readonly name: string;
  readonly closed: boolean;
  readonly length: number;
  readonly samples: RouteSample[];
  start(): { position: [number, null, number]; yaw: number };
  project(p: Vec3, hint?: number, window?: number): { s: number; lateral: number; index: number; sample: RouteSample };
  at(s: number): RouteSample;
}

/** A centreline point ahead of the car, in the car's frame (x = left, z = forward, metres). */
export interface LookaheadPoint {
  /** metres along the route from the car's position */
  distance: number;
  curvature: number;
  x: number;
  z: number;
  widthLeft: number;
  widthRight: number;
}

export interface BotObservation {
  time: number;
  lap: number;
  /** distance along the route, m */
  s: number;
  routeLength: number;
  /** forward speed, m/s */
  speed: number;
  rpm: number;
  gear: number;
  redline: number;
  /** offset from the centreline, m, + = left */
  lateral: number;
  widthLeft: number;
  widthRight: number;
  /** car heading minus route heading, rad, + = pointing left of the route */
  headingError: number;
  /** rad/s, + = turning left */
  yawRate: number;
  sideslip: number;
  /** points at 5, 10, 15, 20, 30, 40, 50, 65, 80, 100, 125, 150, 200 m */
  ahead: LookaheadPoint[];
  wheels: { slipRatio: number; slipAngle: number; load: number; contact: boolean }[];
  car: { wheelbase: number; maxSteerDeg: number; mass: number };
}

export interface BotControls {
  steer: number;
  throttle: number;
  brake: number;
  handbrake?: number;
  shiftUp?: boolean;
  shiftDown?: boolean;
  clutch?: number;
}

export interface Bot {
  name?: string;
  reset?(info: { car: CarInfo; route: { name: string; length: number; closed: boolean } }): void;
  drive(observation: BotObservation): BotControls;
}

export interface RaceResult {
  bot: string;
  car: string;
  route: string;
  finished: boolean;
  laps: number;
  lapTimes: number[];
  bestLap: number | null;
  raceTime: number | null;
  offTrackSeconds: number;
  /** raceTime + 2 x offTrackSeconds; null if not finished */
  score: number | null;
  distance: number;
}

export function runBotRace(options: {
  physics: Physics;
  carSpec: string | object;
  route: string | object | FlatRoute;
  bot: Bot;
  laps?: number;
  dt?: number;
  maxTime?: number;
  assists?: Assists;
}): RaceResult;
