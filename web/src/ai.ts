// AI rivals: cars that race the player round the city route. Kinematic Rapier bodies
// (kinematicPositionBased) driven by Apache-2.0 Minimum-Curvature Optimal Racing Line,
// C2-Continuous Frenet Quintic Polynomial Trajectory Planner, physics-based adjustable
// difficulty (+ Adaptive mode), slipstream drafting, single-move inside corner defense,
// roadblock/wreck avoidance, and exact-parity CoreDamageSim + GPU VehicleDamageRig
// crash physics & visuals matching the player's car 1:1.
//
// Modes: 'off' (parked out of sight: free roam and online are just you), 'race' (on the grid,
// held until go(), then racing), 'cruise' (Free Roam street traffic + spontaneous drag rivals).
// ?ai=0..5 sets the number of rivals (default 5: a grid of six); ?blackcar=1 makes them matte
// black with lights off (night lighting test).
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_CAR, GROUP_VIEW, type PhysicsWorld } from './physics/world';
import { materialsOf } from './scene/city';
import { mergeSpinningWheels, mergeStaticMeshes } from './scene/merge';
import { applyPlate } from './scene/plate';
import { botName } from './username';
import { createContactShadow, setupCarMaterials, type CarVisualConfig } from './scene/car';
import { assetUrl, loadGLTF } from './scene/loaders';
import { drawEarly } from './scene/nyc/breach';
import { CoreDamageSim, SharedDamageVfx, VehicleDamageRig, type RoadObstacle } from './vehicleDamage';
import {
  AdaptiveDifficulty,
  computeMinCurvatureLine,
  difficultyProfile,
  FrenetPlanner,
  type DifficultyProfile,
  type FrenetObstacle,
  type FrenetPlanInput,
  type FrenetPlanResult,
  type OptimalRacingLine,
} from './aiPlanner';
import { getNeuralDriver, NEURAL_OBS_DIM, type NeuralActionOut, type NeuralDriverPolicy } from './neuralDriver';

/** strength of a rival's clustered headlight beam (SpotLight on WebGPU Clustered Forward+) */
const AI_BEAM = 340;
/** the beam target distance ahead of the nose */
const BEAM_AHEAD = 14.0, BEAM_Y = 0.65;

interface RouteSample { x: number; y: number; z: number; width_left: number; width_right: number }

const G = 9.81, WHEEL_R = 0.34;
export const STEP = 2;     // lane resolution, m
const PAINTS = [0x15181d, 0x0c1a33, 0xb8bcc2, 0x6b0f12, 0x1f3d2b];   // gunmetal, deep blue, silver, oxblood, racing green

/**
 * The computer drivers, strongest first: #Bot1 .. #Bot5 (username.ts: '#' marks a bot, no player name can have one).
 * Each driver has distinct pace, aggression, late-braking skill, overtaking boldness, and apex commitment.
 */
export const RIVALS = [
  { skill: 0.95, line: -1.8, push: 1.0, aggression: 0.92, brakingSkill: 0.96, overtakeBoldness: 0.94, apexBias: 0.98 },
  { skill: 0.92, line:  1.6, push: 0.7, aggression: 0.78, brakingSkill: 0.92, overtakeBoldness: 0.85, apexBias: 0.92 },
  { skill: 0.89, line: -0.6, push: 0.4, aggression: 0.62, brakingSkill: 0.88, overtakeBoldness: 0.74, apexBias: 0.86 },
  { skill: 0.85, line:  0.8, push: 0.2, aggression: 0.45, brakingSkill: 0.82, overtakeBoldness: 0.60, apexBias: 0.80 },
  { skill: 0.81, line:  2.2, push: 0.1, aggression: 0.30, brakingSkill: 0.76, overtakeBoldness: 0.48, apexBias: 0.74 },
].map((r, i) => ({ ...r, name: botName(i) }));

const X = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);

/** What the default car can do (from its physics JSON): limits for the speed profiles. */
export interface CarLimits { mu: number; muX: number; power: number; mass: number; dragArea: number }
export function limitsOf(phys: any): CarLimits {
  const p = Math.max(...phys.engine.torque_curve.map(([rpm, t]: [number, number]) => (t * rpm * 2 * Math.PI) / 60));
  return {
    mu: Math.min(phys.tire_front.lateral.mu, phys.tire_rear?.lateral.mu ?? phys.tire_front.lateral.mu),
    muX: phys.tire_front.longitudinal.mu,
    power: p * (phys.drivetrain?.efficiency ?? 0.9),
    mass: phys.chassis.mass_kg,
    dragArea: phys.aero?.drag_area_m2 ?? 0.7,
  };
}

/** The route as a closed (or point-to-point when closed=false), smoothed driving line every 2 m: centre (ground height), right vector, room either side, curvature. */
export class Lane {
  readonly pts: THREE.Vector3[];
  readonly right: THREE.Vector3[] = [];
  readonly wl: number[] = [];
  readonly wr: number[] = [];
  readonly curv: number[] = [];
  readonly length: number;
  readonly n: number;
  readonly closed: boolean;

  constructor(samples: RouteSample[], closed = true) {
    this.closed = closed;
    const src = samples.map((p) => new THREE.Vector3(p.x, p.z, -p.y));   // core Z-up -> three (x, z, -y)
    // resample to STEP m
    const m = src.length, raw: THREE.Vector3[] = [], wl: number[] = [], wr: number[] = [];
    const lastEdge = closed ? m : m - 1;
    for (let i = 0; i < lastEdge; i++) {
      const a = src[i], b = src[(i + 1) % m], d = a.distanceTo(b), k = Math.max(1, Math.round(d / STEP));
      for (let j = 0; j < k; j++) {
        raw.push(a.clone().lerp(b, j / k));
        wl.push(samples[i].width_left); wr.push(samples[i].width_right);
      }
    }
    if (!closed && m > 0) {
      raw.push(src[m - 1].clone());
      wl.push(samples[m - 1].width_left); wr.push(samples[m - 1].width_right);
    }
    const n = raw.length;
    const clampIdx = (k: number) => (closed ? ((k % n) + n) % n : Math.max(0, Math.min(n - 1, k)));
    // round the corners: the route turns 90 degrees within one 7 m sample; a car takes them wide
    let cur = raw.map((p) => p.clone());
    const W = 5;
    for (let pass = 0; pass < 4; pass++) {
      const next = cur.map((p) => p.clone());
      for (let i = 0; i < n; i++) {
        let x = 0, z = 0;
        for (let k = -W; k <= W; k++) { const q = cur[clampIdx(i + k)]; x += q.x; z += q.z; }
        next[i].x = x / (2 * W + 1); next[i].z = z / (2 * W + 1);
      }
      cur = next;
    }
    let acc = 0;
    const s: number[] = [];
    for (let i = 0; i < n; i++) { if (i) acc += cur[i].distanceTo(cur[i - 1]); s.push(acc); }
    const total = closed ? acc + cur[n - 1].distanceTo(cur[0]) : acc;
    // equal spacing again (smoothing bunches points in corners), then tangents and curvature
    const pts: THREE.Vector3[] = [], segs = Math.max(4, Math.round(total / STEP));
    for (let j = 0, i = 0; j < segs; j++) {
      const target = closed ? (j * total) / segs : (j * total) / Math.max(1, segs - 1);
      while (i < n - 1 && s[i + 1] <= target) i++;
      const nxtI = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const s1 = i + 1 < n ? s[i + 1] : total;
      pts.push(cur[i].clone().lerp(cur[nxtI], (target - s[i]) / Math.max(1e-6, s1 - s[i])));
      this.wl.push(wl[i]); this.wr.push(wr[i]);
    }
    this.n = segs;
    const idxAt = (k: number) => (closed ? ((k % segs) + segs) % segs : Math.max(0, Math.min(segs - 1, k)));
    const head: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = pts[idxAt(i - 1)], b = pts[idxAt(i + 1)];
      head.push(Math.atan2(b.x - a.x, b.z - a.z));
      this.right.push(new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize());   // forward x up
    }
    for (let i = 0; i < segs; i++) {
      // heading change over +-3 points (12 m) / 12 m
      let d = head[idxAt(i + 3)] - head[idxAt(i - 3)];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.curv.push(Math.abs(d) / (6 * STEP));
    }
    this.pts = pts;
    this.length = closed ? segs * STEP : (segs - 1) * STEP;   // points are total/segs apart: within 0.1 % of STEP
  }

  wrap(s: number) { return this.closed ? ((s % this.length) + this.length) % this.length : Math.max(0, Math.min(this.length, s)); }
  idx(s: number) { return Math.min(this.n - 1, Math.floor(this.wrap(s) / STEP)); }

  /** Signed curvature between arc lengths (s + a) and (s + b): > 0 = right turn, < 0 = left turn (rad/m). */
  signedCurv(s: number, a: number, b: number): number {
    const rA = this.right[this.idx(s + a)];
    const rB = this.right[this.idx(s + b)];
    // fwd = (right.z, 0, -right.x); dot(fwdB, rightA) = rB.z * rA.x - rB.x * rA.z = +sin(dTheta) for right turns
    const sinTurn = Math.max(-1, Math.min(1, rB.z * rA.x - rB.x * rA.z));
    return Math.asin(sinTurn) / Math.max(1, Math.abs(b - a));
  }

  /** Point at arc length s, lat metres right of the line (ground height of the line; the car keeps its own). */
  at(s: number, lat: number, out: THREE.Vector3) {
    s = this.wrap(s);
    const i = Math.min(this.n - 1, Math.floor(s / STEP));
    const j = this.closed ? (i + 1) % this.n : Math.min(this.n - 1, i + 1);
    const f = i === j ? 0 : s / STEP - Math.floor(s / STEP);
    out.lerpVectors(this.pts[i], this.pts[j], f);
    out.x += (this.right[i].x * (1 - f) + this.right[j].x * f) * lat;
    out.z += (this.right[i].z * (1 - f) + this.right[j].z * f) * lat;
    return out;
  }

  private _room = { left: 0, right: 0 };

  /** Room either side of the line at s (route half-widths, less a car's half width and a margin). */
  roomInto(s: number, out: { left: number; right: number }) {
    const i = this.idx(s);
    out.left = Math.max(0.6, this.wl[i] - 1.9);
    out.right = Math.max(0.6, this.wr[i] - 1.9);
    return out;
  }

  /** Room either side of the line at s (returns a reused scratch object — do not retain across calls). */
  room(s: number) { return this.roomInto(s, this._room); }

  /** Arc length of the lane point nearest p (whole lane; fine for a one-off at the start). */
  project(p: { x: number; z: number }) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) { const d = (this.pts[i].x - p.x) ** 2 + (this.pts[i].z - p.z) ** 2; if (d < bd) { bd = d; best = i; } }
    return best * STEP;
  }

  /** Speed profile from an explicit curvature array: corner limits, then braking zones (backward passes). */
  profileFromCurv(curvArr: ArrayLike<number>, aLat: number, aBrake: number, vmax: number): number[] {
    const v = new Array<number>(this.n);
    for (let i = 0; i < this.n; i++) {
      v[i] = Math.min(vmax, Math.sqrt(aLat / Math.max(1e-5, curvArr[i])));
    }
    if (!this.closed && v.length) v[v.length - 1] = 0;
    const passes = this.closed ? 2 : 1;
    const start = this.closed ? this.n - 1 : this.n - 2;
    for (let pass = 0; pass < passes; pass++)
      for (let i = start; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[(i + 1) % this.n] ** 2 + 2 * aBrake * STEP));
    return v;
  }

  /** Speed profile for one driver: corner limits, then braking zones (two backward passes round the loop). */
  profile(aLat: number, aBrake: number, vmax: number) {
    return this.profileFromCurv(this.curv, aLat, aBrake, vmax);
  }
}

/** rivals' small parts (AiCar.detail) are drawn within this distance of the camera */
const DETAIL_M = 30;

/** Frenet quintic trajectory replanning period (25 Hz -> < 0.05 ms total CPU for 5 rivals). */
const FRENET_REPLAN_DT = 0.04;

export type AiRacecraftState = 'race' | 'draft' | 'overtake' | 'defend' | 'avoid';

interface AiCar {
  name: string;
  root: THREE.Group;
  model: THREE.Object3D;
  shadow: THREE.Object3D | null;
  body: RAPIER.RigidBody;
  wheels: { node: THREE.Object3D; rest: THREE.Quaternion }[];
  light: THREE.SpotLight | null;
  /** small parts drawn only near the camera (interior, brake discs, calipers, exhaust, plate, underbody) and whether they are shown */
  detail: THREE.Object3D[]; detailOn: boolean;
  /** merged wheel meshes (merge.ts mergeSpinningWheels): userData.spin = wheel angle */
  spinners: THREE.Mesh[];
  /** arc length, speed, lateral offset (+ = right of the line), lateral target, preferred line */
  s: number; v: number; lat: number; latTarget: number; line: number;
  /** smooth C2 Frenet lateral kinematics & 25 Hz quintic plan buffer */
  latDot: number;
  latDdot: number;
  frenetTimer: number;
  frenetStartDot: number;
  frenetStartDdot: number;
  frenetOut: FrenetPlanResult;
  vprof: number[]; aGrip: number;
  spin: number; y: number; yTick: number;
  parked: boolean;
  /** crash state: sideways slide (m/s, + = right), yaw off the lane heading and its rate (rad, rad/s), synced damage 0..1, out of the race */
  latV: number; yawOff: number; yawRate: number; dmg: number; wrecked: boolean;
  /** exact-parity CoreDamageSim + GPU vertex-shader VehicleDamageRig */
  damageSim: CoreDamageSim;
  damageRig: VehicleDamageRig;
  /** driver personality */
  push: number;
  aggression: number;
  brakingSkill: number;
  overtakeBoldness: number;
  apexBias: number;
  /** live racecraft & human pressure mistake state */
  state: AiRacecraftState;
  overtakeSide: -1 | 0 | 1;
  overtakeHoldT: number;
  defendHoldT: number;
  defendCdT: number;
  defendLat: number;
  mistakeTimer: number;
  mistakeSign: -1 | 0 | 1;
  mistakeCd: number;
  lineDriftPhase: number;
  collider: RAPIER.Collider;
  prevPos: THREE.Vector3; prevQuat: THREE.Quaternion;
  pos: THREE.Vector3; quat: THREE.Quaternion;
}

export type AiMode = 'off' | 'race' | 'cruise';

export class AiTraffic {
  readonly cars: AiCar[] = [];
  mode: AiMode = 'off';
  /** race: cars wait on the grid until go() */
  held = true;
  /** Free Roam spontaneous 1v1 drag wager: index of the AI rival currently racing the player (-1 = none). */
  dragCarIdx = -1;
  /** Held during the 3-2-1 drag countdown right beside the player. */
  dragHeld = false;
  /** Physics-based AI difficulty (60% Rookie .. 110% Alien) + Adaptive mode (zero rubber-banding). */
  difficultyPct = 88;
  adaptiveDifficulty = false;
  lane: Lane;
  optLine: OptimalRacingLine;
  private diffProfile: DifficultyProfile = difficultyProfile(88);
  private adaptive = new AdaptiveDifficulty(88);
  private neural: NeuralDriverPolicy = getNeuralDriver(assetUrl('ai/neural_driver.json'));
  private neuralObs = new Float64Array(NEURAL_OBS_DIM);
  private neuralAct: NeuralActionOut = { steer: 0, throttle: 0, brake: 0 };
  private neuralBoost = { speedMul: 1, accelMul: 1, latNudge: 0 };
  private frenet = new FrenetPlanner();
  private frenetObs: FrenetObstacle[] = [];
  private frenetInput: FrenetPlanInput = {
    d0: 0,
    dDot0: 0,
    dDdot0: 0,
    egoV: 0,
    desiredLat: 0,
    minLat: -2,
    maxLat: 2,
    prevSide: 0,
    boldness: 0.5,
    nonRammingPlayer: false,
    obstacles: this.frenetObs,
    obstacleCount: 0,
  };
  private leadScratch: number[] = [];
  private damageVfx: SharedDamageVfx | null = null;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private of = new THREE.Vector3();
  private rayOrigin = { x: 0, y: 0, z: 0 };
  private ray = new RAPIER.Ray(this.rayOrigin, { x: 0, y: -1, z: 0 });
  private player = new THREE.Vector3();
  private playerV = 0;
  private playerS = 0;
  private grid: { s: number; lat: number }[] = [];
  private roomScratch = { left: 0, right: 0 };
  private roomScratch2 = { left: 0, right: 0 };
  private tmpLin = { x: 0, y: 0, z: 0 };
  private tmpAng = { x: 0, y: 0, z: 0 };
  private tmpV = new THREE.Vector3();
  private tmpLocal = new THREE.Vector3();
  private tmpInvQ = new THREE.Quaternion();
  private tmpFwdA = new THREE.Vector3();
  private obstaclesScratch: RoadObstacle[] = [];
  private simTime = 0;
  private lastUpdateMs = 0;
  private dt = 1 / 400;

  private constructor(private pw: PhysicsWorld, samples: RouteSample[], closed = true) {
    this.lane = new Lane(samples, closed);
    this.optLine = computeMinCurvatureLine(this.lane);
  }

  /** Set physics-based AI difficulty (60..110%) and optional Adaptive mode; rebuilds speed profiles immediately. */
  setDifficulty(pct: number, adaptive = false) {
    const clamped = Math.max(60, Math.min(110, Math.round(pct || 88)));
    this.difficultyPct = clamped;
    this.adaptiveDifficulty = adaptive;
    this.adaptive.reset(clamped);
    this.diffProfile = difficultyProfile(clamped);
    this.rebuildSpeedProfiles();
  }

  /** Live effective difficulty percentage (tracks adaptive skill when Adaptive mode is enabled). */
  get effectiveDifficultyPct(): number {
    return this.adaptiveDifficulty ? this.adaptive.effectivePct : this.difficultyPct;
  }

  /**
   * Recompute every rival's cornering + braking speed profile by blending centerline curvature with
   * the minimum-curvature optimal racing line weighted by `diff.apexAccuracy`, scaled by real tyre
   * grip utilization (`diff.gripUtil`) and braking limit (`diff.brakeUtil`).
   */
  private rebuildSpeedProfiles() {
    const n = this.lane.n;
    const diff = this.diffProfile;
    const wOpt = Math.max(0, Math.min(1, diff.apexAccuracy));
    const wCen = 1 - wOpt;
    const blendedCurv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      blendedCurv[i] = this.lane.curv[i] * wCen + this.optLine.optCurv[i] * wOpt;
    }
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i] as AiCar & { lim?: CarLimits };
      const rival = RIVALS[i % RIVALS.length];
      const lim = c.lim ?? { mu: 1.1, muX: 1.1, power: 250000, mass: 1400, dragArea: 0.7 };
      const aLat = rival.skill * diff.gripUtil * lim.mu * G;
      const aBrake = rival.brakingSkill * diff.brakeUtil * lim.muX * G;
      c.vprof = this.lane.profileFromCurv(blendedCurv, aLat, aBrake, 75);
    }
  }

  /** Must run after the city's colliders are queryable (after the first world.step()). */
  static async create(scene: THREE.Scene, pw: PhysicsWorld, cfg: CarVisualConfig, samples: RouteSample[], count: number, black: boolean, phys: any, closed = true) {
    const ai = new AiTraffic(pw, samples, closed);
    if (!count) return ai;
    ai.damageVfx = new SharedDamageVfx(scene);
    const lim = limitsOf(phys);
    // Traffic LOD model (~28k triangles, 1k textures) cloned per rival; each car gets its own
    // VehicleDamageRig with GPU vertex-shader Dents (zero per-hit CPU cost, early-outs when undamaged).
    const gltf = await loadGLTF(assetUrl(cfg.lod_model ?? cfg.model));
    const blackMat = new THREE.MeshStandardMaterial({ name: 'ai_black', color: 0x000000, roughness: 0.6, metalness: 0 });
    // Black paint: reduced base specular + a thin, sharp clear coat (measured in the night test).
    const blackPaint = new THREE.MeshPhysicalMaterial({
      name: 'ai_black_paint', color: 0x000000, roughness: 0.6, metalness: 0, specularIntensity: 0.2, clearcoat: 0.15, clearcoatRoughness: 0.05,
    });
    const cb = cfg.collision_box;
    for (let i = 0; i < count; i++) {
      const rival = RIVALS[i % RIVALS.length];
      const model = gltf.scene.clone(true);
      const wheels: AiCar['wheels'] = [];
      for (const name of Object.values(cfg.wheel_nodes)) {
        const node = model.getObjectByName(name);
        if (node) wheels.push({ node, rest: node.quaternion.clone() });
      }
      // The body follows the lane on the ground, the wheels stay at their modelled hubs: drop the
      // model so the hub sits at the rolling radius (the modelled tyre is 0.345 m).
      if (wheels.length) model.position.y = WHEEL_R - wheels[0].node.position.y;
      if (!black) setupCarMaterials(model, cfg, PAINTS[i % PAINTS.length], false);
      else {
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = false;
          const mat = materialsOf(m)[0];
          if (mat.name === 'light_beam') { m.visible = false; return; }
          m.material = mat.name === cfg.paint_material ? blackPaint : blackMat;
        });
      }
      if (new URLSearchParams(location.search).get('merge') !== '0') mergeStaticMeshes(model, wheels.map((w) => w.node));
      applyPlate(model, rival.name);   // #BOT1 on the plate
      // Construct VehicleDamageRig BEFORE mergeSpinningWheels so wheel_* nodes are skipped by SKIP_DENT_RE
      // and merged spinning wheel meshes keep their GPU spin positionNode intact!
      const damageSim = new CoreDamageSim(lim.mass);
      const damageRig = new VehicleDamageRig(model);
      const spinners = wheels.length === 4 && new URLSearchParams(location.search).get('merge') !== '0' ? mergeSpinningWheels(model, wheels.map((w) => w.node)) : [];
      const detail: THREE.Object3D[] = [];
      const casters: THREE.Mesh[] = [];
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (/^merged_(paint|trim|carbon|rubber)$|_tyre_\d$|^wheels_tyre/.test(m.name)) casters.push(m);
        if (/^interior|_disc$|^exhaust_tips|^plate$|mirror_glass|^underbody_merged|^wheels_disc$/.test(m.name)) detail.push(m);
      });
      if (casters.length >= 4 && !black) model.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = casters.includes(o as THREE.Mesh); });
      const root = new THREE.Group();
      root.name = `ai_${i}`;
      root.add(model);
      drawEarly(model);
      let shadow: THREE.Object3D | null = null;
      if (!black) root.add(shadow = createContactShadow(cb.size_m[0] * 1.22, cb.size_m[2] * 1.16, cb.centre_in_model_m[2]));
      scene.add(root);
      // Clustered Forward+ unshadowed SpotLight headlight beam per rival: culled in the WGSL compute pass with a tight
      // cone bounding sphere and skipped completely on CPU when intensity is 0 (free roam / wrecked).
      let light: THREE.SpotLight | null = null;
      if (!black) {
        light = new THREE.SpotLight(0xfff3e0, AI_BEAM, 42, 0.42, 0.5, 2);
        light.position.set(0, BEAM_Y, cb.size_m[2] / 2 + 0.15);
        light.target.position.set(0, -0.8, cb.size_m[2] / 2 + BEAM_AHEAD);
        root.add(light, light.target);
      }
      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      // Box from 0.15 m (nothing wedges under it) to 1.0 m: BELOW the top of the player's hull (1.2 m).
      const [sx, , sz] = cb.size_m, [cx, , cz] = cb.centre_in_model_m;
      const top = 1.0, bottom = 0.15;
      const collider = pw.world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, (top - bottom) / 2, sz / 2).setTranslation(cx, (top + bottom) / 2, cz)
        .setFriction(0.3).setRestitution(0).setCollisionGroups(GROUP_CAR), body);
      const car: AiCar = {
        name: rival.name, root, model, shadow, body, wheels: spinners.length ? [] : wheels, spinners, light, detail, detailOn: true,
        s: 0, v: 0, lat: rival.line, latTarget: rival.line, line: rival.line,
        latDot: 0, latDdot: 0, frenetTimer: FRENET_REPLAN_DT, frenetStartDot: 0, frenetStartDdot: 0,
        frenetOut: {
          targetLat: rival.line,
          nextLat: rival.line,
          nextDot: 0,
          nextDdot: 0,
          horizonT: 1.35,
          chosenSide: 0,
          blockedSpeedCap: Infinity,
        },
        vprof: [], aGrip: rival.skill * 0.6 * lim.muX * G,   // driven wheels carry ~60 % of the weight
        spin: 0, y: 0, yTick: 0, parked: false,
        latV: 0, yawOff: 0, yawRate: 0, dmg: 0, wrecked: false,
        damageSim, damageRig,
        push: rival.push,
        aggression: rival.aggression,
        brakingSkill: rival.brakingSkill,
        overtakeBoldness: rival.overtakeBoldness,
        apexBias: rival.apexBias,
        state: 'race',
        overtakeSide: 0,
        overtakeHoldT: 0,
        defendHoldT: 0,
        defendCdT: 0,
        defendLat: 0,
        mistakeTimer: 0,
        mistakeSign: 0,
        mistakeCd: 0,
        lineDriftPhase: i * 1.37 + 0.4,
        collider,
        prevPos: new THREE.Vector3(), prevQuat: new THREE.Quaternion(), pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
      };
      (car as AiCar & { lim: CarLimits }).lim = lim;
      ai.cars.push(car);
    }
    ai.rebuildSpeedProfiles();
    ai.setMode('off');
    return ai;
  }

  /** Rebind traffic & rivals to a new city's route during seamless city switching. */
  setRoute(samples: RouteSample[], closed = true) {
    this.lane = new Lane(samples, closed);
    this.optLine = computeMinCurvatureLine(this.lane);
    this.grid = [];
    this.playerS = 0;
    this.dragCarIdx = -1;
    this.dragHeld = false;
    this.damageVfx?.clear();
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      c.s = 0;
      c.v = 0;
      c.y = 0;
      c.yTick = 0;
      c.latDot = 0;
      c.latDdot = 0;
      c.frenetTimer = FRENET_REPLAN_DT;
      c.frenetStartDot = 0;
      c.frenetStartDdot = 0;
      c.frenetOut.chosenSide = 0;
      c.frenetOut.blockedSpeedCap = Infinity;
      c.dmg = 0;
      c.wrecked = false;
      c.damageSim.reset();
      c.damageRig.clear();
      c.state = 'race';
      c.overtakeSide = 0;
      c.overtakeHoldT = 0;
      c.defendHoldT = 0;
      c.defendCdT = 0;
      c.mistakeTimer = 0;
      c.mistakeSign = 0;
      c.mistakeCd = 0;
    }
    this.rebuildSpeedProfiles();
    this.setMode('off');
  }

  /**
   * Grid for a race: the player's start pose fixes slot 0's row. Two columns, rows 8 m apart;
   * the player starts in the middle of the field (P4 of 6), rivals ahead and behind.
   * Returns the player's lateral offset from the lane (their column, + = right).
   */
  setGrid(playerStart: { x: number; y: number; z: number }) {
    const s0 = this.lane.project(playerStart);
    const col = 2.2;
    const slots: { s: number; lat: number }[] = [];
    const total = this.cars.length + 1, playerSlot = Math.min(3, this.cars.length);
    for (let k = 0; k < total; k++) slots.push({ s: s0 + (playerSlot - k) * 8, lat: k % 2 ? col : -col });
    const mine = slots.splice(playerSlot, 1)[0];
    this.grid = slots;
    this.playerS = s0;
    return mine.lat;
  }

  /** Scale active cruising traffic cars by time-of-day density (22:00-01:00 dense, 01:00-03:00 sparse, 04:00-05:30 near-zero). */
  setCruiseDensity(density: number) {
    if (this.mode !== 'cruise') return;
    const keep = Math.max(1, Math.min(this.cars.length, Math.round(this.cars.length * density)));
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const active = i < keep || i === this.dragCarIdx;
      c.model.visible = active;
      if (c.shadow) c.shadow.visible = active;
      if (c.light) c.light.intensity = active ? AI_BEAM * c.damageRig.headlightFactor(c.damageSim) : 0;
      c.body.setEnabled(active);
      if (!active) c.body.setTranslation({ x: 0, y: -500, z: 0 }, true);
    }
  }

  /** Race: on the grid, held (go() releases them). Cruise: Free Roam AI traffic cruising the streets. Off: parked out of sight. */
  setMode(mode: AiMode) {
    this.mode = mode;
    this.held = mode === 'race';
    this.dragCarIdx = -1;
    this.dragHeld = false;
    this.reset();
    const on = mode !== 'off';
    for (const c of this.cars) {
      c.model.visible = on;
      if (c.shadow) c.shadow.visible = on;
      if (c.light) c.light.intensity = on ? AI_BEAM * c.damageRig.headlightFactor(c.damageSim) : 0;
      c.body.setEnabled(on);
    }
  }

  go() { this.held = false; }

  /** Engage AI rival `idx` in a Free Roam 1v1 spontaneous drag wager. */
  startDrag(idx: number, held: boolean) {
    this.dragCarIdx = idx;
    this.dragHeld = held;
    const c = this.cars[idx];
    if (c && held) c.v = 0;
  }
  releaseDrag() { this.dragHeld = false; }
  endDrag() { this.dragCarIdx = -1; this.dragHeld = false; }

  /** Back to the grid (race), cruising offsets (cruise), or out of sight (off). */
  reset() {
    this.held = this.mode === 'race';
    this.dragCarIdx = -1;
    this.dragHeld = false;
    this.player.set(0, 0, 0); this.playerV = 0;
    this.damageVfx?.clear();
    if (this.adaptiveDifficulty) {
      const prevPct = this.adaptive.effectivePct;
      this.adaptive.reset(this.difficultyPct);
      if (prevPct !== this.adaptive.effectivePct) {
        this.diffProfile = difficultyProfile(this.adaptive.effectivePct);
        this.rebuildSpeedProfiles();
      }
    }
    const cruiseOffsets = [20, 95, 220, 380, -70];
    for (const [i, c] of this.cars.entries()) {
      c.v = 0; c.parked = false; c.spin = 0;
      c.latV = c.yawOff = c.yawRate = c.dmg = 0; c.wrecked = false;
      c.latDot = c.latDdot = 0;
      c.frenetStartDot = c.frenetStartDdot = 0;
      c.frenetTimer = FRENET_REPLAN_DT;
      c.frenetOut.chosenSide = 0;
      c.frenetOut.blockedSpeedCap = Infinity;
      c.damageSim.reset();
      c.damageRig.clear();
      c.state = 'race';
      c.overtakeSide = 0;
      c.overtakeHoldT = 0;
      c.defendHoldT = 0;
      c.defendCdT = 0;
      c.defendLat = 0;
      c.mistakeTimer = 0;
      c.mistakeSign = 0;
      c.mistakeCd = 0;
      if (this.mode === 'race') {
        const g = this.grid[i] ?? { s: 40 + 10 * i, lat: c.line };
        c.s = this.lane.wrap(g.s); c.lat = c.latTarget = g.lat;
        c.frenetOut.targetLat = c.frenetOut.nextLat = g.lat;
        this.lane.at(c.s, c.lat, c.pos);
        c.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 30) ?? c.pos.y;
        c.pos.y = c.y;
        this.orient(c, 0);
      } else if (this.mode === 'cruise') {
        const sOff = cruiseOffsets[i % cruiseOffsets.length] ?? 40 * (i + 1);
        c.s = this.lane.wrap(this.playerS + sOff);
        c.lat = c.latTarget = i % 2 === 0 ? 1.8 : -1.8;
        c.frenetOut.targetLat = c.frenetOut.nextLat = c.lat;
        c.v = i === 0 ? 0 : 12 + (i % 3) * 2.5; // car #0 waits near the first light for instant drag challenge
        this.lane.at(c.s, c.lat, c.pos);
        c.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 30) ?? c.pos.y;
        c.pos.y = c.y;
        this.orient(c, 0);
      } else {
        c.pos.set(0, -500 - 10 * i, 0); c.quat.identity();
      }
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
      c.body.setTranslation(c.pos, true);
      c.body.setRotation(c.quat, true);
      c.root.position.copy(c.pos); c.root.quaternion.copy(c.quat);
    }
  }

  /** Debug/tests: stop car i at arc length s (or at a free pose); it stays until reset(). */
  park(i: number, s: number, pose?: { pos: THREE.Vector3; yaw: number }) {
    const c = this.cars[i];
    if (!c) return;
    c.parked = true; c.v = 0; c.s = this.lane.wrap(s);
    c.latDot = c.latDdot = c.frenetStartDot = c.frenetStartDdot = 0;
    c.frenetTimer = FRENET_REPLAN_DT;
    c.frenetOut.blockedSpeedCap = Infinity;
    if (pose) {
      c.pos.copy(pose.pos);
      c.quat.setFromAxisAngle(UP, pose.yaw);
      c.pos.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 3) ?? c.pos.y;
    } else {
      this.lane.at(c.s, c.lat, c.pos);
      c.pos.y = this.ground(c.pos.x, c.pos.z, c.pos.y + 30) ?? c.pos.y;
      this.orient(c, 0);
    }
    c.y = c.pos.y;
    c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);
    c.body.setTranslation(c.pos, true);
    c.body.setRotation(c.quat, true);
  }

  /**
   * Shader warm-up (loading screen): park every car in the player's headlight beam so the first
   * render builds all their pipelines, shadow pass included. Call setMode() afterwards.
   */
  stage(ground: THREE.Vector3, yaw: number) {
    for (const c of this.cars) { c.model.visible = true; if (c.shadow) c.shadow.visible = true; if (c.light) c.light.intensity = AI_BEAM; c.body.setEnabled(true); }
    for (let i = 0; i < this.cars.length; i++) {
      const d = 9 + 6 * i;
      this.park(i, 0, { pos: new THREE.Vector3(ground.x + Math.sin(yaw) * d, ground.y, ground.z + Math.cos(yaw) * d), yaw });
    }
  }

  /** Static ground under (x, z) from height top down len m, ignoring every car and piece of debris (dynamic + kinematic bodies). */
  groundAt(x: number, z: number, top: number, len = 60) { return this.ground(x, z, top, len); }
  private ground(x: number, z: number, top: number, len = 60): number | null {
    this.rayOrigin.x = x; this.rayOrigin.y = top; this.rayOrigin.z = z;
    const hit = this.pw.world.castRay(this.ray, len, true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, GROUP_VIEW);
    return hit ? top - hit.timeOfImpact : null;
  }

  /** Heading along the lane, plus the angle of any sideways move. */
  private orient(c: AiCar, latRate: number) {
    // flat on the road: heading only (yaw), never pitch or roll. Own vectors: f, x and up must not share storage.
    const s0 = this.lane.closed ? c.s : Math.max(2.5, Math.min(this.lane.length - 2.5, c.s));
    const f = this.lane.at(s0 + 2.5, c.lat, this.of).sub(this.lane.at(s0 - 2.5, c.lat, this.b)).setY(0).normalize();
    if (c.v > 0.5 && latRate) f.applyAxisAngle(UP, -Math.atan2(latRate, c.v));
    c.quat.setFromAxisAngle(UP, Math.atan2(f.x, f.z) - c.yawOff);
  }

  /** Arc length of a point near the lane: projection on the 2 m segment around a hint. */
  private sOf(p: { x: number; z: number }, hint: number) {
    let best = hint, bd = Infinity;
    for (let d = -30; d <= 30; d += STEP) {
      const s = hint + d, q = this.lane.at(s, 0, this.a), dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (dd < bd) { bd = dd; best = s; }
    }
    return bd > 60 * 60 ? this.lane.project(p) : this.lane.wrap(best);
  }

  /** Signed arc-length delta (target - origin) wrapped to [-L/2, L/2] on closed routes. */
  private arcDelta(originS: number, targetS: number): number {
    let d = targetS - originS;
    if (this.lane.closed) {
      const L = this.lane.length;
      if (d > L * 0.5) d -= L;
      else if (d < -L * 0.5) d += L;
    }
    return d;
  }

  /**
   * Expose all active AI cars as `RoadObstacle[]` (reused scratch array, zero per-tick allocations)
   * so Police Interceptors and other systems can intelligently overtake & avoid AI racers and wrecks.
   */
  obstacleList(): RoadObstacle[] {
    if (this.mode === 'off') {
      this.obstaclesScratch.length = 0;
      return this.obstaclesScratch;
    }
    let count = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (!c.body.isEnabled() || c.pos.y < -100) continue;
      let slot = this.obstaclesScratch[count];
      if (!slot) {
        slot = { x: 0, z: 0, v: 0, lat: 0, radius: 2.1, isCop: false, isBlock: false };
        this.obstaclesScratch[count] = slot;
      }
      slot.x = c.pos.x;
      slot.z = c.pos.z;
      slot.v = c.v;
      slot.lat = c.lat;
      slot.radius = 2.1;
      slot.isCop = false;
      slot.isBlock = c.wrecked;
      count++;
    }
    this.obstaclesScratch.length = count;
    return this.obstaclesScratch;
  }

  /** Apply an exact-parity crash impact via CoreDamageSim + GPU VehicleDamageRig. */
  private applyDamageImpact(c: AiCar, dv: number, lx: number, ly: number, lz: number, dt: number, sourceId: number) {
    const hit = c.damageSim.addImpact(dv, lx, ly, lz, dt, sourceId);
    if (!hit) return;
    c.dmg = c.damageSim.severity;
    c.wrecked = c.damageSim.totaled;
    c.root.position.copy(c.pos);
    c.root.quaternion.copy(c.quat);
    c.root.updateMatrixWorld();
    c.damageRig.applyHit(c.damageSim, hit, c.root, this.damageVfx);
    if (hit.justTotaled) this.onWreck(c.name);
  }

  /** Project a world-space contact source onto the AI car's model-space body hull (+Z front, +X left). */
  private localContactPoint(c: AiCar, wx: number, wy: number, wz: number, out: THREE.Vector3) {
    this.tmpInvQ.copy(c.quat).invert();
    out.set(wx - c.pos.x, wy - c.pos.y, wz - c.pos.z).applyQuaternion(this.tmpInvQ);
    const scale = Math.max(Math.abs(out.x) / 0.95, Math.abs(out.z) / 2.25, 1);
    out.x /= scale;
    out.z /= scale;
    out.y = Math.max(0.35, Math.min(1.05, 0.55 + out.y * 0.25));
    return out;
  }

  /**
   * Evaluate the trained Open Grid Neural Driver policy (when loaded, on Pro/Alien difficulties)
   * to provide learned apex sharpening, corner-exit acceleration, and racecraft speed modulation.
   * Zero per-tick allocations; silently returns identity if offline or below Pro difficulty.
   */
  private evalNeuralBoost(
    c: AiCar,
    target: number,
    room: { left: number; right: number },
    obsDs: number,
    obsRelLatRight: number,
    hasObs: boolean,
  ) {
    const out = this.neuralBoost;
    out.speedMul = 1;
    out.accelMul = 1;
    out.latNudge = 0;
    const effPct = this.effectiveDifficultyPct;
    if (effPct < 92 || !this.neural.ready) return out;

    const blend = Math.max(0, Math.min(1, (effPct - 90) / 18));
    const optLatRight = this.optLine.latAt(c.s);
    const latErrLeft = -(c.lat - optLatRight); // core convention: + = left
    const headingErr = c.v > 1.0 ? Math.atan2(-c.latDot, c.v) - c.yawOff : -c.yawOff;
    const slipAngle = c.v > 1.0 ? Math.atan2(-c.latV, c.v) : 0;

    const obs = this.neuralObs;
    obs[0] = Math.max(-1, Math.min(1, c.v / 80));
    obs[1] = Math.max(-2, Math.min(2, latErrLeft / 5));
    obs[2] = Math.sin(headingErr);
    obs[3] = Math.max(-2, Math.min(2, -c.yawRate / 2));
    obs[4] = Math.max(-2, Math.min(2, slipAngle / 0.5));
    // Core convention: + curvature = left turn (lane.signedCurv is + right turn, so negate)
    obs[5] = Math.max(-1, Math.min(1, -this.lane.signedCurv(c.s, 9, 21) * 40));
    obs[6] = Math.max(-1, Math.min(1, -this.lane.signedCurv(c.s, 27, 43) * 40));
    obs[7] = Math.max(-1, Math.min(1, -this.lane.signedCurv(c.s, 55, 75) * 40));
    obs[8] = Math.max(-1, Math.min(1, -this.lane.signedCurv(c.s, 98, 122) * 40));
    obs[9] = Math.max(0, Math.min(1, Math.max(0, room.left + c.lat) / 8));
    obs[10] = Math.max(0, Math.min(1, Math.max(0, room.right - c.lat) / 8));
    obs[11] = Math.max(-1, Math.min(1, (c.v - target) / 25));
    obs[12] = hasObs ? Math.max(0, Math.min(1, obsDs / 60)) : 1.0;
    obs[13] = hasObs ? Math.max(-1, Math.min(1, -obsRelLatRight / 5)) : 0.0;

    const act = this.neural.infer(obs, this.neuralAct);
    const netDrive = act.throttle - act.brake;
    out.speedMul = 1 + blend * Math.max(-0.04, Math.min(0.06, netDrive * 0.06));
    out.accelMul = 1 + blend * Math.max(0, (act.throttle - 0.5) * 0.10);
    // Core steer > 0 turns left -> negative right-offset nudge in web/src/ai.ts coordinates
    out.latNudge = -act.steer * 0.55 * blend;
    return out;
  }

  /**
   * Populate the zero-allocation Frenet obstacle scratch list, evaluate tactical racecraft
   * (minimum-curvature optimal racing line, slipstream drafting tow, clean single-move P1/P2
   * inside corner defense, human pressure bobble), and run the C2-continuous quintic
   * FrenetPlanner at ~25 Hz (`FRENET_REPLAN_DT`) while smoothly interpolating lateral kinematics
   * every physics tick.
   * Returns `true` when the car is tucked in a straight-line slipstream draft (+3.5% accel).
   */
  private planFrenetLane(
    c: AiCar,
    carIdx: number,
    laneIdx: number,
    dt: number,
    target: number,
    room: { left: number; right: number },
    isCruise: boolean,
    playerLat: number,
    extraObstacles?: readonly RoadObstacle[],
  ): boolean {
    const diff = this.diffProfile;
    if (c.overtakeHoldT > 0) c.overtakeHoldT = Math.max(0, c.overtakeHoldT - dt);
    if (c.defendHoldT > 0) c.defendHoldT = Math.max(0, c.defendHoldT - dt);
    if (c.defendCdT > 0) c.defendCdT = Math.max(0, c.defendCdT - dt);

    // --- 1. Optimal minimum-curvature racing line + subtle straight-line organic drift ---
    const localCurv = this.lane.curv[laneIdx];
    const lookAhead = Math.max(8, Math.min(26, c.v * 0.45));
    const aheadCurv = this.optLine.curvAt(c.s + lookAhead);
    const straightFactor = Math.max(0, 1 - Math.min(1, (localCurv + aheadCurv) / 0.012));

    let desiredLat: number;
    if (isCruise) {
      const cruiseLane = carIdx % 2 === 0 ? Math.min(room.right * 0.6, 2.0) : -Math.min(room.left * 0.6, 2.0);
      desiredLat = cruiseLane + Math.sin(this.simTime * 0.12 + c.lineDriftPhase) * 0.45;
    } else {
      const optLat = this.optLine.latAt(c.s + lookAhead);
      const organicDrift = (
        c.line * 0.35
        + Math.sin(this.simTime * 0.17 + c.lineDriftPhase) * 1.15
        + Math.cos(this.simTime * 0.09 + c.lineDriftPhase * 1.7) * 0.5
      ) * (0.25 + 0.75 * straightFactor) * (1 - 0.55 * diff.apexAccuracy);
      desiredLat = optLat * diff.apexAccuracy + organicDrift;
      // Brief wide-apex human bobble when under close corner pressure on lower difficulties
      if (c.mistakeTimer > 0) {
        desiredLat += c.mistakeSign * 0.6;
      }
    }

    // --- 2. Gather nearby obstacles (player, other AI cars, police cruisers, wrecks, roadblocks) ---
    const obs = this.frenetObs;
    let obsCount = 0;
    const maxLatMargin = Math.max(room.left, room.right) + 8;
    const pushObs = (ds: number, lat: number, v: number, clearLat: number, isBlock: boolean, isPlayer: boolean) => {
      if (ds < -22 || ds > 120) return;
      if (Math.abs(lat) > maxLatMargin) return;
      let slot = obs[obsCount];
      if (!slot) {
        slot = { ds: 0, lat: 0, v: 0, clearLat: 2.45, isBlock: false, isPlayer: false };
        obs[obsCount] = slot;
      }
      slot.ds = ds;
      slot.lat = lat;
      slot.v = v;
      slot.clearLat = clearLat;
      slot.isBlock = isBlock;
      slot.isPlayer = isPlayer;
      obsCount++;
    };

    let carsAhead = 0;
    if (this.player.lengthSq() > 0.01) {
      const pf = this.arcDelta(c.s, this.playerS);
      if (pf > 0) carsAhead++;
      pushObs(pf, playerLat, this.playerV, 2.5, false, true);
    }

    for (let k = 0; k < this.cars.length; k++) {
      if (k === carIdx) continue;
      const oc = this.cars[k];
      if (!oc.body.isEnabled() || oc.pos.y < -100) continue;
      const of = this.arcDelta(c.s, oc.s);
      if (!oc.wrecked && !oc.parked && of > 0) carsAhead++;
      pushObs(of, oc.lat, oc.v, 2.45, oc.wrecked || oc.parked, false);
    }

    if (extraObstacles && extraObstacles.length > 0) {
      const rVec = this.lane.right[laneIdx];
      const fx = rVec.z, fz = -rVec.x;
      for (let k = 0; k < extraObstacles.length; k++) {
        const eo = extraObstacles[k];
        const dx = eo.x - c.pos.x, dz = eo.z - c.pos.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 > 125 * 125) continue;
        const projF = dx * fx + dz * fz;
        const dist = Math.sqrt(dist2);
        const ds = Math.abs(projF) < 22 ? projF : (projF >= 0 ? dist : -dist);
        const clearLat = (eo.radius ?? 2.1) + (eo.isBlock ? 0.95 : eo.isCop ? 0.65 : 0.45);
        pushObs(ds, eo.lat, eo.v, clearLat, !!eo.isBlock, false);
      }
    }

    // --- 3. Tactical awareness: drafting tow, P1/P2 single-move corner defense, hazards ---
    let hardHazardAhead = false;
    let leadBlocker: FrenetObstacle | null = null;
    let leadBlockerDs = Infinity;
    let draftTarget: FrenetObstacle | null = null;
    let draftDs = Infinity;
    let rearThreat: FrenetObstacle | null = null;
    let anyAlongside = false;

    for (let k = 0; k < obsCount; k++) {
      const ob = obs[k];
      const latGap = Math.abs(ob.lat - c.lat);

      if (ob.ds >= -6.5 && ob.ds <= 6.5 && latGap < 3.4) {
        anyAlongside = true;
      }

      if (ob.isBlock && ob.ds > 0 && ob.ds < 115 && latGap < ob.clearLat + 1.4) {
        hardHazardAhead = true;
      }

      if (ob.ds > 0 && ob.ds < 50 && latGap < ob.clearLat + 0.35) {
        if ((ob.v < target - 0.8 || ob.isBlock) && ob.ds < leadBlockerDs) {
          leadBlocker = ob;
          leadBlockerDs = ob.ds;
        }
      }

      // Straight-line slipstream / drafting opportunity (6..30 m ahead)
      if (!isCruise && !ob.isBlock && localCurv < 0.004 && ob.ds >= 6 && ob.ds <= 30 && ob.v > 12 && latGap < 2.8) {
        if (ob.ds < draftDs) {
          draftTarget = ob;
          draftDs = ob.ds;
        }
      }

      // Faster challenger closing from behind (-18..-5 m) for clean inside defense
      if (!isCruise && !ob.isBlock && ob.ds >= -18 && ob.ds <= -5 && ob.v > c.v + 1.5 && latGap < 3.6) {
        if (!rearThreat || ob.ds > rearThreat.ds) rearThreat = ob;
      }
    }

    const isTop2 = carsAhead <= 1; // P1 (0 ahead) or P2 (1 ahead)
    if (!isCruise && !hardHazardAhead && !anyAlongside) {
      if (
        isTop2
        && rearThreat
        && c.defendHoldT <= 0
        && c.defendCdT <= 0
        && (c.aggression >= 0.45 || diff.overtakeBoldness >= 0.6)
      ) {
        const kApproach = this.lane.signedCurv(c.s, 20, 65);
        const kApex = this.lane.signedCurv(c.s, -4, 22);
        if (Math.abs(kApproach) > 0.0045 || Math.abs(kApex) > 0.0045) {
          // ONE clean defensive move toward the inside of the upcoming corner, leaving >= 2.7 m on the outside
          const turnSign = Math.sign(Math.abs(kApex) > Math.abs(kApproach) ? kApex : kApproach);
          if (turnSign > 0) {
            c.defendLat = Math.max(-room.left + 2.7, Math.min(room.right - 0.35, room.right * 0.65));
          } else {
            c.defendLat = Math.min(room.right - 2.7, Math.max(-room.left + 0.35, -room.left * 0.65));
          }
          c.defendHoldT = 2.1;
          c.defendCdT = 7.0;
        }
      }

      if (c.defendHoldT > 0) {
        desiredLat = c.defendLat;
      } else if (draftTarget && draftDs > 12 && !leadBlocker) {
        // Tuck cleanly into the slipstream on a straight before pulling out to pass
        desiredLat = draftTarget.lat;
      } else {
        // Open Grid Neural Driver apex & racecraft refinement on Pro/Alien difficulties
        const nb = this.evalNeuralBoost(
          c,
          target,
          room,
          leadBlocker ? leadBlockerDs : 60,
          leadBlocker ? leadBlocker.lat - c.lat : 0,
          !!leadBlocker,
        );
        desiredLat += nb.latNudge;
      }
    } else {
      this.neuralBoost.speedMul = 1;
      this.neuralBoost.accelMul = 1;
      this.neuralBoost.latNudge = 0;
    }

    desiredLat = Math.max(-room.left, Math.min(room.right, desiredLat));

    // --- 4. Run C2-Continuous Quintic Frenet Planner at 25 Hz & smoothly interpolate lateral kinematics ---
    if (c.frenetTimer >= FRENET_REPLAN_DT) {
      c.frenetStartDot = c.latDot;
      c.frenetStartDdot = c.latDdot;
      const fi = this.frenetInput;
      fi.d0 = c.lat;
      fi.dDot0 = c.latDot;
      fi.dDdot0 = c.latDdot;
      fi.egoV = c.v;
      fi.desiredLat = desiredLat;
      fi.minLat = -room.left;
      fi.maxLat = room.right;
      fi.prevSide = c.overtakeSide;
      fi.boldness = isCruise ? 0.3 : Math.max(0, Math.min(1, 0.4 * c.overtakeBoldness + 0.6 * diff.overtakeBoldness));
      fi.nonRammingPlayer = false;
      fi.obstacles = obs;
      fi.obstacleCount = obsCount;
      this.frenet.plan(fi, FRENET_REPLAN_DT, c.frenetOut);
      c.latTarget = c.frenetOut.targetLat;
      c.frenetTimer = 0;

      if (c.frenetOut.chosenSide !== 0) {
        c.overtakeSide = c.frenetOut.chosenSide;
        c.overtakeHoldT = 1.6;
      } else if (c.overtakeHoldT <= 0) {
        c.overtakeSide = 0;
      }
    }

    c.frenetTimer += dt;
    const u = Math.min(1, c.frenetTimer / FRENET_REPLAN_DT);
    c.latDot = c.frenetStartDot + (c.frenetOut.nextDot - c.frenetStartDot) * u;
    c.latDdot = c.frenetStartDdot + (c.frenetOut.nextDdot - c.frenetStartDdot) * u;

    // Live racecraft state label (for telemetry / debugging)
    if (hardHazardAhead) {
      c.state = 'avoid';
    } else if (c.overtakeSide !== 0 && leadBlocker) {
      c.state = 'overtake';
    } else if (!isCruise && c.defendHoldT > 0 && !anyAlongside) {
      c.state = 'defend';
    } else if (!isCruise && draftTarget && draftDs > 12 && !anyAlongside) {
      c.state = 'draft';
    } else {
      c.state = 'race';
    }

    // Active slipstream tow bonus (+3.5% acceleration) when tucked 6..30 m behind a car on a straight
    return !!(draftTarget && Math.abs(c.lat - draftTarget.lat) < 1.85 && localCurv < 0.004);
  }

  /** One physics tick (before world.step()). player = the player's chassis position. */
  tick(dt: number, player: { x: number; y: number; z: number }, extraObstacles?: readonly RoadObstacle[]) {
    if (this.mode === 'off') return;
    this.dt = dt;
    this.simTime += dt;
    this.playerV = this.player.lengthSq() === 0 ? 0 : Math.hypot(player.x - this.player.x, player.z - this.player.z) / dt;
    this.player.set(player.x, player.y, player.z);
    this.playerS = this.sOf(player, this.playerS);
    const playerLat = this.latOf(this.player, this.playerS);
    const nCars = this.cars.length;

    // Adaptive difficulty: sample median signed player lead vs active non-wrecked rivals (zero fake rubber-banding)
    if (this.mode === 'race' && !this.held && this.adaptiveDifficulty && this.player.lengthSq() > 0.01) {
      const leads = this.leadScratch;
      let lc = 0;
      for (let k = 0; k < nCars; k++) {
        const rc = this.cars[k];
        if (!rc.body.isEnabled() || rc.parked || rc.wrecked || rc.pos.y < -100) continue;
        leads[lc++] = this.arcDelta(rc.s, this.playerS);
      }
      if (lc > 0) {
        // Insertion sort tiny array (<= 5 rivals) with zero allocations
        for (let a = 1; a < lc; a++) {
          const v = leads[a];
          let b = a - 1;
          while (b >= 0 && leads[b] > v) {
            leads[b + 1] = leads[b];
            b--;
          }
          leads[b + 1] = v;
        }
        const mid = lc >> 1;
        const playerLeadM = lc % 2 === 1 ? leads[mid] : 0.5 * (leads[mid - 1] + leads[mid]);
        if (this.adaptive.sample(dt, playerLeadM)) {
          this.diffProfile = difficultyProfile(this.adaptive.effectivePct);
          this.rebuildSpeedProfiles();
        }
      }
    }

    for (let carIdx = 0; carIdx < nCars; carIdx++) {
      const c = this.cars[carIdx];
      c.prevPos.copy(c.pos); c.prevQuat.copy(c.quat);

      // Step exact-parity damage simulation (headlight flicker countdown, overheat smoulder -> fire)
      c.damageSim.step(dt);
      c.dmg = c.damageSim.severity;
      c.wrecked = c.damageSim.totaled;

      // Headlight beam intensity: fades near player & past 90 m, AND multiplies by exact-parity headlightFactor (2 s flicker -> dead)
      if (c.light) {
        const dp2 = (c.pos.x - player.x) ** 2 + (c.pos.z - player.z) ** 2;
        const hlFactor = c.damageRig.headlightFactor(c.damageSim);
        if ((c.wrecked && c.damageSim.headlightFlickerT <= 0) || dp2 > 90 * 90 || hlFactor <= 0) {
          c.light.intensity = 0;
        } else {
          const fw = this.a.set(0, 0, 1).applyQuaternion(c.quat);
          const lx = c.pos.x + fw.x * 6.5 - player.x, lz = c.pos.z + fw.z * 6.5 - player.z;
          const k = Math.min(1, Math.max(0, (Math.hypot(lx, lz) - 2.5) / 4.5));
          const farFade = dp2 > 70 * 70 ? Math.max(0, (90 - Math.sqrt(dp2)) / 20) : 1;
          c.light.intensity = AI_BEAM * k * k * (3 - 2 * k) * farFade * hlFactor;
        }
      }

      const isDragOpponent = this.mode === 'cruise' && carIdx === this.dragCarIdx;
      const still = c.v < 0.05 && Math.abs(c.latV) < 0.05 && Math.abs(c.yawRate) < 0.02;
      if (this.held || (isDragOpponent && this.dragHeld) || ((c.parked || c.wrecked) && still)) {
        c.body.setNextKinematicTranslation(c.pos);
        c.body.setNextKinematicRotation(c.quat);
        continue;
      }

      const i = this.lane.idx(c.s);
      const driven = !c.parked && !c.wrecked;
      const spun = Math.abs(c.yawOff) > 0.6;

      // Exact-parity damage scaling on cornering grip & top speed (powerScale -> 0.25 limp-home floor, gripScale -> 0.55)
      const gripScale = c.damageSim.gripScale;
      const powerScale = c.damageSim.powerScale;
      const dragScale = c.damageSim.dragScale;
      const paceDamageMul = Math.sqrt(gripScale) * (0.4 + 0.6 * powerScale);

      let target = driven && !spun ? c.vprof[(i + 1) % this.lane.n] * paceDamageMul : 0;
      const isCruise = this.mode === 'cruise' && !isDragOpponent;
      if (isCruise) {
        // Free Roam cruising traffic: chill 45-65 km/h street speed, pausing briefly when the player pulls up side-by-side
        const cruiseV = 13.5 + (carIdx % 3) * 2.4;
        const distPlayer = Math.hypot(c.pos.x - player.x, c.pos.z - player.z);
        const sideBySide = distPlayer < 14 && this.playerV < 6.5;
        target = driven && !spun ? (sideBySide ? 0 : Math.min(target, cruiseV)) : 0;
      } else if (this.mode === 'race' && driven && !spun) {
        // Realistic human pressure mistakes on lower difficulties (never catastrophic, never rubber-banded)
        if (c.mistakeTimer > 0) c.mistakeTimer = Math.max(0, c.mistakeTimer - dt);
        if (c.mistakeCd > 0) c.mistakeCd = Math.max(0, c.mistakeCd - dt);
        if (
          this.diffProfile.mistakeRate > 0
          && c.mistakeTimer <= 0
          && c.mistakeCd <= 0
          && this.player.lengthSq() > 0.01
        ) {
          const pGap = Math.abs(this.arcDelta(c.s, this.playerS));
          if (pGap < 14 && this.lane.curv[i] > 0.008 && Math.random() < this.diffProfile.mistakeRate * dt) {
            c.mistakeTimer = 0.7;
            c.mistakeCd = 6.0;
            const sCurv = this.lane.signedCurv(c.s, -4, 22);
            c.mistakeSign = sCurv >= 0 ? -1 : 1; // run slightly wide toward outside of the turn
          }
        }
        if (c.mistakeTimer > 0) {
          target *= 0.94;
        }
      }

      const room = this.lane.roomInto(c.s, this.roomScratch);
      let draftBonus = false;
      this.neuralBoost.speedMul = 1;
      this.neuralBoost.accelMul = 1;
      this.neuralBoost.latNudge = 0;
      if (driven && !spun) {
        draftBonus = this.planFrenetLane(c, carIdx, i, dt, target, room, isCruise, playerLat, extraObstacles);
        if (!isCruise) target *= this.neuralBoost.speedMul;
        // Clean longitudinal speed cap when directly boxed in behind a slower vehicle or hard block
        if (c.frenetOut.blockedSpeedCap < Infinity) {
          target = Math.min(target, c.frenetOut.blockedSpeedCap);
        }
      } else {
        c.latTarget = Math.max(-room.left, Math.min(room.right, c.lat));
        c.latDot = c.latDdot = c.frenetStartDot = c.frenetStartDdot = 0;
        c.frenetTimer = FRENET_REPLAN_DT;
        c.frenetOut.blockedSpeedCap = Infinity;
      }

      // Longitudinal dynamics: exact-parity powerScale, gripScale, dragScale + diffProfile.accelUtil + 3.5% straight-line draft tow
      const lim = (c as AiCar & { lim: CarLimits }).lim;
      const drag = (0.5 * 1.2 * lim.dragArea * dragScale * c.v * c.v) / lim.mass;
      const effPower = lim.power * powerScale * (draftBonus ? 1.035 : 1.0) * (isCruise ? 1.0 : this.neuralBoost.accelMul);
      const effGrip = c.aGrip * gripScale;
      const accelUtil = isCruise ? 1.0 : this.diffProfile.accelUtil;
      const acc = Math.max(0.2 * powerScale, (Math.min(effGrip, effPower / (lim.mass * Math.max(3, c.v))) - drag) * accelUtil);
      const brakeDecel = driven ? Math.max(11.2, lim.muX * G) * gripScale : 3.5;
      c.v = target > c.v ? Math.min(target, c.v + acc * dt) : Math.max(target, c.v - brakeDecel * dt);

      // Lateral dynamics: silky-smooth C2 Frenet velocity integration + subtle asymmetric front-wheel steerPull bias
      const sliding = Math.abs(c.latV) > 0.4 || spun || !driven;
      if (sliding) {
        c.latDot = c.latDdot = c.frenetStartDot = c.frenetStartDdot = 0;
        c.frenetTimer = FRENET_REPLAN_DT;
      }
      const lowSpeedScale = Math.min(1, c.v / 1.0);
      let dl = sliding ? 0 : c.latDot * Math.sqrt(gripScale) * lowSpeedScale * dt;
      if (!sliding) {
        if (dl > 0 && c.lat + dl > room.right) {
          dl = Math.max(0, room.right - c.lat);
          if (c.latDot > 0) c.latDot = 0;
        } else if (dl < 0 && c.lat + dl < -room.left) {
          dl = Math.min(0, -room.left - c.lat);
          if (c.latDot < 0) c.latDot = 0;
        }
      }
      if (driven && !spun && c.v > 2 && c.damageSim.steerPull !== 0) {
        dl += c.damageSim.steerPull * Math.min(1, c.v / 18) * 1.1 * dt;
      }
      const steerRate = dl / dt;   // heading leans into intentional lane changes, not crash slides

      // Crash slide & wall/curb impacts (exact-parity CoreDamageSim + VehicleDamageRig)
      if (c.latV !== 0) {
        dl += c.latV * dt;
        c.latV -= Math.sign(c.latV) * Math.min(Math.abs(c.latV), 7 * dt);
      }
      const nextLat = c.lat + dl;
      const edge = nextLat > room.right + 0.6 ? room.right + 0.6 : nextLat < -room.left - 0.6 ? -room.left - 0.6 : null;
      if (edge !== null) {
        const wallSpeed = Math.abs(c.latV);
        if (wallSpeed > 0.5) {
          // Model space: +X = left, -X = right. Hitting right wall (edge > 0) dents right side (-X).
          const sideX = edge > 0 ? -0.95 : 0.95;
          this.applyDamageImpact(c, wallSpeed, sideX, 0.5, 0.3, dt, 2);
          c.v *= 0.72;
        }
        dl = edge - c.lat;
        c.latV = 0;
        c.latDot = c.latDdot = 0;
      }

      if (c.yawRate !== 0 || c.yawOff !== 0) {
        c.yawOff += c.yawRate * dt;
        c.yawRate *= Math.exp(-2.2 * dt);
        if (driven || c.v < 1) c.yawOff -= c.yawOff * Math.min(1, (spun ? 0.9 : 2.4) * dt);
        if (Math.abs(c.yawOff) < 0.002 && Math.abs(c.yawRate) < 0.002) c.yawOff = c.yawRate = 0;
      }

      c.lat += dl;
      c.s = this.lane.wrap(c.s + c.v * dt);
      c.spin += (c.v * dt) / WHEEL_R;
      this.lane.at(c.s, c.lat, c.pos);
      if (++c.yTick % 8 === 0) {
        const y = this.ground(c.pos.x, c.pos.z, c.y + 2.5, 5) ?? this.ground(c.pos.x, c.pos.z, c.y + 25, 50);
        if (y !== null) c.y = y;
      }
      c.pos.y = c.y;
      this.orient(c, steerRate);
      c.body.setNextKinematicTranslation(c.pos);
      c.body.setNextKinematicRotation(c.quat);
    }

    // --- AI-to-AI collisions: clean separation, momentum exchange & exact-parity damage ---
    if (!this.held && nCars > 1) {
      for (let i = 0; i < nCars; i++) {
        const a = this.cars[i];
        if (!a.body.isEnabled() || a.pos.y < -100) continue;
        for (let j = i + 1; j < nCars; j++) {
          const b = this.cars[j];
          if (!b.body.isEnabled() || b.pos.y < -100) continue;
          const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          if (dx * dx + dz * dz > 26) continue; // > 5.1 m apart: cannot overlap (4.4^2 + 1.95^2 = 23.16)
          const fwdA = this.tmpFwdA.set(0, 0, 1).applyQuaternion(a.quat);
          const df = dx * fwdA.x + dz * fwdA.z;
          const dl = -dx * fwdA.z + dz * fwdA.x; // right = (-fwd.z, 0, fwd.x)
          if (Math.abs(df) >= 4.4 || Math.abs(dl) >= 1.95) continue;

          const ovF = 4.4 - Math.abs(df);
          const ovL = 1.95 - Math.abs(dl);
          const midX = (a.pos.x + b.pos.x) * 0.5;
          const midY = (a.pos.y + b.pos.y) * 0.5 + 0.55;
          const midZ = (a.pos.z + b.pos.z) * 0.5;

          let dvHit = 0;
          if (ovF < ovL) {
            // Front-to-rear contact
            const sgnF = df >= 0 ? 1 : -1; // +1 means b is ahead of a
            const pushS = ovF * 0.52;
            if (!a.parked) a.s = this.lane.wrap(a.s - sgnF * pushS);
            if (!b.parked) b.s = this.lane.wrap(b.s + sgnF * pushS);
            const closing = sgnF > 0 ? a.v - b.v : b.v - a.v;
            if (closing > 0) {
              dvHit = closing * 0.62;
              if (sgnF > 0) {
                a.v = Math.max(0, a.v - dvHit);
                b.v = Math.max(0, b.v + dvHit);
              } else {
                b.v = Math.max(0, b.v - dvHit);
                a.v = Math.max(0, a.v + dvHit);
              }
              const offCenter = Math.max(-1, Math.min(1, dl / 1.5));
              if (Math.abs(offCenter) > 0.25) {
                a.yawRate -= offCenter * dvHit * 0.14;
                b.yawRate += offCenter * dvHit * 0.18;
              }
            }
          } else {
            // Side-to-side contact
            const sgnL = dl >= 0 ? 1 : -1; // +1 means b is to the right of a
            const pushL = ovL * 0.52;
            const roomA = this.lane.roomInto(a.s, this.roomScratch);
            const roomB = this.lane.roomInto(b.s, this.roomScratch2);
            if (!a.parked) a.lat = Math.max(-roomA.left - 0.5, Math.min(roomA.right + 0.5, a.lat - sgnL * pushL));
            if (!b.parked) b.lat = Math.max(-roomB.left - 0.5, Math.min(roomB.right + 0.5, b.lat + sgnL * pushL));
            const relLat = (a.latV - b.latV) * sgnL;
            const relFwd = Math.abs(a.v - b.v);
            dvHit = Math.max(0, relLat) * 0.65 + relFwd * 0.14;
            const shove = Math.max(1.2, Math.min(7.5, dvHit + 0.8));
            if (!a.parked) { a.latV -= sgnL * shove * 0.5; a.latDot = a.latDdot = 0; }
            if (!b.parked) { b.latV += sgnL * shove * 0.5; b.latDot = b.latDdot = 0; }
            const lever = Math.max(-1, Math.min(1, df / 2.2));
            a.yawRate -= sgnL * lever * shove * 0.18;
            b.yawRate += sgnL * lever * shove * 0.18;
            a.v *= 0.96;
            b.v *= 0.96;
          }

          // Re-sync separated world transforms & kinematic bodies
          this.lane.at(a.s, a.lat, a.pos); a.pos.y = a.y;
          this.lane.at(b.s, b.lat, b.pos); b.pos.y = b.y;
          a.body.setNextKinematicTranslation(a.pos);
          b.body.setNextKinematicTranslation(b.pos);

          if (dvHit > 0.15) {
            const locA = this.localContactPoint(a, midX, midY, midZ, this.tmpLocal);
            this.applyDamageImpact(a, dvHit, locA.x, locA.y, locA.z, dt, 100 + j);
            const locB = this.localContactPoint(b, midX, midY, midZ, this.tmpLocal);
            this.applyDamageImpact(b, dvHit, locB.x, locB.y, locB.z, dt, 100 + i);
          }
        }
      }
    }
  }

  /** a rival has just been wrecked (HUD / audio hook) */
  onWreck: (name: string) => void = () => {};

  /**
   * After world.step(): share the player's collisions with rivals. The rival's body is kinematic, so the solver
   * treated it as an immovable wall and gave the player the whole velocity change. Two cars of about the same mass
   * split it: the player gets half of it back, the rival takes the other half (opposite direction) as a shove along
   * its lane, a slide across it, a yaw kick, and exact-parity CoreDamageSim + GPU VehicleDamageRig damage.
   * Returns true when a rival was touched this tick.
   */
  afterStep(playerCollider: RAPIER.Collider, playerBody: RAPIER.RigidBody, preV: THREE.Vector3, preW: THREE.Vector3): boolean {
    if (this.mode === 'off') return false;
    const p = playerBody.translation();
    let hit: AiCar | null = null;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const dx = p.x - c.pos.x, dz = p.z - c.pos.z;
      if (dx * dx + dz * dz > 64) continue;   // > 8 m apart: cannot touch
      let touching = false;
      this.pw.world.contactPair(playerCollider, c.collider, (m) => { if (m.numContacts() > 0) touching = true; });
      if (touching) { hit = c; break; }
    }
    if (!hit) return false;
    const c = hit, lv = playerBody.linvel(), av = playerBody.angvel();
    const dvx = lv.x - preV.x, dvz = lv.z - preV.z, dv = Math.hypot(dvx, dvz);
    if (dv < 0.02) return true;   // resting against it
    this.tmpLin.x = (preV.x + lv.x) / 2; this.tmpLin.y = lv.y; this.tmpLin.z = (preV.z + lv.z) / 2;
    this.tmpAng.x = (preW.x + av.x) / 2; this.tmpAng.y = (preW.y + av.y) / 2; this.tmpAng.z = (preW.z + av.z) / 2;
    playerBody.setLinvel(this.tmpLin, true);
    playerBody.setAngvel(this.tmpAng, true);
    // the rival's half, in its own frame (forward along its heading, right across it)
    const i = this.lane.idx(c.s), right = this.lane.right[i];
    const fwd = this.tmpV.set(0, 0, 1).applyQuaternion(c.quat);
    const rx = -dvx / 2, rz = -dvz / 2;
    const along = rx * fwd.x + rz * fwd.z, across = rx * right.x + rz * right.z;
    c.v = Math.max(0, c.v + along);
    c.latV += across;
    // where the player is along the rival's length: a shove behind its middle swings the tail out
    const lever = Math.max(-1, Math.min(1, ((p.x - c.pos.x) * fwd.x + (p.z - c.pos.z) * fwd.z) / 2.2));
    c.yawRate += across * lever * 0.55;
    // Exact-parity crash damage from model-space impact point
    const loc = this.localContactPoint(c, p.x, p.y, p.z, this.tmpLocal);
    this.applyDamageImpact(c, dv / 2, loc.x, loc.y, loc.z, this.dt, 1);
    return true;
  }

  private latOf(p: { x: number; z: number }, s: number) {
    const c = this.lane.at(s, 0, this.b), i = this.lane.idx(s);
    return (p.x - c.x) * this.lane.right[i].x + (p.z - c.z) * this.lane.right[i].z;
  }

  /** Draw between the last two ticks (alpha as for the player's car) and step damage smoke/spark VFX. */
  update(alpha: number, camera: THREE.Camera, frameDt?: number) {
    if (this.mode === 'off') return;
    let fdt: number;
    if (frameDt !== undefined && Number.isFinite(frameDt)) {
      fdt = Math.min(0.05, Math.max(0, frameDt));
    } else {
      const now = performance.now();
      fdt = this.lastUpdateMs > 0 ? Math.min(0.05, Math.max(0.001, (now - this.lastUpdateMs) * 0.001)) : 1 / 60;
      this.lastUpdateMs = now;
    }

    for (const c of this.cars) {
      c.root.position.lerpVectors(c.prevPos, c.pos, alpha);
      c.root.quaternion.slerpQuaternions(c.prevQuat, c.quat, alpha);
      // hide the model in the fog (lights stay: changing the light set recompiles materials)
      const d2 = c.root.position.distanceToSquared(camera.position);
      const vis = d2 < 210 * 210;
      c.model.visible = vis;
      if (!vis) continue;
      if (c.damageSim.severity >= 0.4) {
        c.root.updateMatrixWorld();
        c.damageRig.updateSmoke(fdt, c.damageSim, c.root, this.damageVfx);
      }
      // Only cars inside headlight shadow range (< 44 m) cast shadows: saves dozens of shadow draw calls with zero visual loss!
      const castSh = d2 < 44 * 44;
      if (c.shadow) c.shadow.visible = d2 < 95 * 95;
      if ((c as AiCar & { shOn?: boolean }).shOn !== castSh) {
        (c as AiCar & { shOn?: boolean }).shOn = castSh;
        c.model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          if (castSh) { if (m.userData.wasCaster) m.castShadow = true; }
          else if (m.castShadow) { m.userData.wasCaster = true; m.castShadow = false; }
        });
      }
      const near = d2 < (c.detailOn ? DETAIL_M + 4 : DETAIL_M) ** 2;   // hysteresis: no flicker at the edge
      if (near !== c.detailOn) { c.detailOn = near; for (const o of c.detail) o.visible = near; }
      for (const w of c.wheels) w.node.quaternion.setFromAxisAngle(X, c.spin).multiply(w.rest);
      for (const m of c.spinners) m.userData.spin = c.spin;
    }
    this.damageVfx?.update(fdt);
  }
}
