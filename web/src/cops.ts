// Apache-2.0 — Disciplined Real-Life Tactical Police Interceptor Pursuit AI (OpenGrid).
//
// Features:
//   1. Roadside GATSO speed cameras (fast 1.2 s dispatch) PLUS proactive patrol high-speed sightings
//      so speeding in Night Street / Free Roam brings Police Interceptors onto your tail realistically.
//   2. 4-Unit Black & White Interceptor Squad (built via policeCar.ts with real flashing red/blue lights):
//      - Unit 04 (ESCORT): spawns behind at matching speed, holds disciplined escort/pull-over spacing & broadcasts PA orders.
//      - Unit 07 (INTERCEPT): active at Heat 1+ ahead to roll out and box/slow cleanly with safe lateral clearance.
//      - Unit 11 (BOX): joins at Heat 2+ on the opposite side for clean non-ramming box-in maneuvers.
//      - Unit 15 (BACKUP): joins at Heat 3+ as a disciplined trail/intercept interceptor.
//      - NEVER rams or PIT-wrecks the player; maintains >= 2.75 m lateral clearance when alongside and brakes cleanly behind.
//   3. Strict 90% Top Speed Cap: every interceptor's top speed is ALWAYS strictly 90% of the player's current car top speed
//      (further reduced by engine/aero damage when crashed), keeping corners and city streets intense while clean straights reward speed.
//   4. Minimum-Curvature Optimal Racing Line + C2-Continuous Frenet Quintic Trajectory Planner (aiPlanner.ts): smooth cornering lines,
//      traffic/rival/wreck overtaking with lateral hysteresis, roadblock avoidance, and strict player personal-space safety bubble.
//   5. Exact-Parity Crash Damage & Durability (CoreDamageSim + VehicleDamageRig + SharedDamageVfx):
//      police interceptors take the exact same impact math, GPU vertex dents, power/grip loss, broken headlights, hood steam/smoke,
//      and disable/wreck thresholds as the player car!
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Lane } from './ai';
import {
  computeMinCurvatureLine,
  FrenetPlanner,
  type FrenetObstacle,
  type FrenetPlanResult,
  type OptimalRacingLine,
} from './aiPlanner';
import { GROUP_CAR, type PhysicsWorld } from './physics/world';
import {
  buildPoliceInterceptor,
  updatePoliceLights,
  type PoliceLightRig,
} from './scene/policeCar';
import {
  CoreDamageSim,
  SharedDamageVfx,
  VehicleDamageRig,
  type RoadObstacle,
} from './vehicleDamage';

const ESCAPE_GAP = 275;        // m of clear road required before entering EVADING cooldown
const ESCAPE_HOLD_FAR = 3.8;   // s continuously > 275 m before entering EVADING
const EVADE_HOLD = 14.0;       // s in EVADING cooldown to completely shake the squad
const EVADE_REACQUIRE = 175;   // m within which any unit immediately re-engages during EVADING
const BUST_GAP = 9.5;          // m proximity required to pin & bust
const BUST_SLOW = 15;          // km/h under which a pinned car counts toward busted
const BUST_HOLD = 4.2;         // s pinned before busted
const GIVE_UP = 240;           // s max chase if player stays fast and un-busted
const LOS_HOLD = 6.5;          // s out of sight behind buildings to enter EVADING cooldown
const ROADBLOCK_AHEAD = 260;   // m ahead of player along route
const CAM_SPACING_M = 460;     // m between roadside speed cameras
const CAM_OVER_MARGIN = 15;    // km/h grace margin above posted limit before camera flashes
const CAM_COOLDOWN_S = 22;     // s cooldown per camera so it won't spam while parked
const DISPATCH_DELAY_S = 1.2;  // s brisk radio dispatch delay after camera flash
const LEAPFROG_BEHIND = 340;   // m behind before a non-lead undamaged unit redeploys ahead as fresh intercept
const LEAPFROG_AHEAD = 240;    // m ahead to redeploy intercept unit
const SOUND_SPEED = 340;       // m/s for acoustic Doppler calculation
const COP_MASS_KG = 1680;      // heavy-duty police interceptor mass (exact CoreDamageSim durability parity)
const PLAYER_SAFE_LAT = 2.75;  // m minimum lateral clearance alongside the player (strict non-ramming bubble)
const GENTLE_TAP_COOLDOWN = 10.5; // s cooldown for tiny low-speed catch bump (<= 0.14 intensity)
const FALLBACK_PLAYER_MAX_MS = 295 / 3.6;

export interface SpeedCamera {
  id: number;
  name: string;
  s: number;
  limitKmh: number;
  world: THREE.Vector3;
  yaw: number;
  cooldown: number;
  flashTimer: number;
  mesh: THREE.Group | null;
  flashMat: THREE.MeshBasicMaterial | null;
}

export interface NextCameraInfo {
  id: number;
  name: string;
  limitKmh: number;
  distM: number;
}

export interface RoadblockRerouteInfo {
  active: boolean;
  /** 'forming' = assembling ahead; 'punch' = top-3 lead pack too close, must thread gap; 'rerouted' = GPS bypass active */
  phase: 'forming' | 'punch' | 'rerouted';
  blockX: number;
  blockZ: number;
  distM: number;
  bypassSide: -1 | 1;
  /** Game-frame (x, y = -z) bypass polyline curving around the roadblock for GPS drawing. */
  detourPts: { x: number; y: number }[];
}

export interface SirenState {
  proximity: number;
  dopplerRatio: number;
  pan: number;
  aggressive: boolean;
  hornPulse: number;
}

export interface CopHooks {
  /** Player was pinned and busted. */
  bust(): void;
  /** Player broke away from the pursuit squad (or disabled all active units). */
  escaped(): void;
  /** Gentle low-speed contact bump if a cruiser physically catches alongside at low speed (intensity <= 0.14, never wrecks). */
  onPitNudge?(latSign: number, intensity: number): void;
  /** Tactical alert for HUD banner. */
  onAlert?(msg: string): void;
  /** Roadside speed camera caught the player speeding! */
  onCameraFlash?(cam: SpeedCamera, speedKmh: number, overKmh: number): void;
  /** Police dispatch / patrol unit scanner radio transmission. */
  onRadio?(unit: string, text: string, speak?: boolean, clipId?: string): void;
  /** Street radio / GPS reroute announcement on the racers' underground channel (146.52 MHz). */
  onStreetRadio?(callsign: string, text: string, clipId?: string): void;
  /** A pursuing police interceptor suffered heavy crash damage and was disabled/totaled. */
  onUnitDisabled?(callsign: string): void;
}

type UnitRole = 'escort' | 'intercept' | 'box' | 'backup';

export type CopTactic =
  | 'PURSUIT'
  | 'PULL OVER'
  | 'BOX IN'
  | 'ROADBLOCK AHEAD'
  | 'EVADING'
  | 'DISPATCHED';

interface PatrolUnit {
  unitNumber: string;
  callsign: string;
  s: number;
  lat: number;
  latDot: number;
  latDdot: number;
  speed: number;
  side: 1 | -1;
  role: UnitRole;
  world: THREE.Vector3;
  prevWorld: THREE.Vector3;
  velX: number;
  velZ: number;
  yaw: number;
  steerLean: number;
  root: THREE.Object3D | null;
  lights: PoliceLightRig | null;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  active: boolean;
  damageSim: CoreDamageSim;
  damageRig: VehicleDamageRig | null;
  latV: number;
  yawOff: number;
  yawRate: number;
  wrecked: boolean;
  overtakeSide: -1 | 0 | 1;
  overtakeHoldT: number;
}

interface Roadblock {
  active: boolean;
  s: number;
  world: THREE.Vector3;
  group: THREE.Group;
  bodies: RAPIER.RigidBody[];
  colliders: RAPIER.Collider[];
  carRoots: THREE.Object3D[];
  carWorlds: THREE.Vector3[];
  carYaws: number[];
  carLats: number[];
  damageSims: CoreDamageSim[];
  damageRigs: VehicleDamageRig[];
  lights: PoliceLightRig[];
  announced: boolean;
  bypassSide: -1 | 1;
  phase: 'forming' | 'punch' | 'rerouted';
  rerouteTimer: number;
  rerouteAnnounced: boolean;
  distM: number;
  detourPts: { x: number; y: number }[];
  chevrons: THREE.Group;
}

const ROADBLOCK_LAYOUTS = [
  { x: -4.1, z: 0, yaw: Math.PI * 0.42, num: '21' },
  { x: 4.1, z: 0.4, yaw: -Math.PI * 0.42, num: '22' },
] as const;

export class Cops {
  active = false;
  heat = 1;
  /** Closest active unit arc length (backwards-compatible telemetry). */
  s = 0;
  speed = 0;
  /** Closest active unit world position (used for LOS and audio). */
  readonly world = new THREE.Vector3();
  /** Lead unit visual root (kept compatible with existing setup). */
  root: THREE.Object3D | null = null;
  /** Current tactical state label for HUD. */
  tactic: CopTactic = 'PURSUIT';
  /** Roadside speed cameras placed along the active city route. */
  cameras: SpeedCamera[] = [];
  /** Nearest upcoming speed camera within 240 m (for HUD speed limit indicator). */
  nextCamera: NextCameraInfo | null = null;

  private units: PatrolUnit[] = [];
  private roadblock: Roadblock | null = null;
  private camGroup: THREE.Group | null = null;
  private scene: THREE.Scene | null = null;
  private pw: PhysicsWorld | null = null;
  private proto: THREE.Object3D | null = null;
  private vfx: SharedDamageVfx | null = null;

  private minDist = 999;
  private far = 0;
  private slow = 0;
  private evadeTimer = 0;
  private evading = false;
  private t = 0;
  private blind = 0;
  private gentleTapCd = 6.0;
  private pullOverRadioCd = 3.5;
  private pullOverOrderIdx = 0;
  private roadblockCd = 15.0;
  private dispatchDelay = 0;
  private dispatchHeat = 1;
  private recklessTimer = 0;
  private lastPlayerSpeedMs = 36;
  private lastCopTopSpeedMs = FALLBACK_PLAYER_MAX_MS * 0.90;
  private lastPullingAwayRadio = 0;
  private lastInterceptRadio = -20;
  private hornPulse = 0;
  private hornCd = 0;
  private prevPlayerPos = new THREE.Vector3();
  private hasPrevPlayer = false;
  private smoothDoppler = 1.0;
  private smoothPan = 0;
  private sirenSnapshot: SirenState = {
    proximity: 0,
    dopplerRatio: 1.0,
    pan: 0,
    aggressive: false,
    hornPulse: 0,
  };
  private tmpQuat = new THREE.Quaternion();
  private upAxis = new THREE.Vector3(0, 1, 0);
  private tmpLin = { x: 0, y: 0, z: 0 };
  private tmpAng = { x: 0, y: 0, z: 0 };
  private roomScratch = { left: 0, right: 0 };
  private obstaclesBuf: RoadObstacle[] = [];
  private optLine: OptimalRacingLine;
  private frenet = new FrenetPlanner();
  private frenetObsBuf: FrenetObstacle[] = [];
  private frenetOut: FrenetPlanResult = {
    targetLat: 0,
    nextLat: 0,
    nextDot: 0,
    nextDdot: 0,
    horizonT: 1.35,
    chosenSide: 0,
    blockedSpeedCap: Infinity,
  };

  constructor(private lane: Lane, private hooks: CopHooks) {
    this.optLine = computeMinCurvatureLine(this.lane);
    this.units = [
      this.makeUnit('04', 'UNIT-04', 1.2, 1, 'escort'),
      this.makeUnit('07', 'UNIT-07', -1.8, -1, 'intercept'),
      this.makeUnit('11', 'UNIT-11', -2.4, -1, 'box'),
      this.makeUnit('15', 'UNIT-15', 2.4, 1, 'backup'),
    ];
    this.buildCameraData();
  }

  private makeUnit(unitNumber: string, callsign: string, lat: number, side: 1 | -1, role: UnitRole): PatrolUnit {
    return {
      unitNumber,
      callsign,
      s: 0,
      lat,
      latDot: 0,
      latDdot: 0,
      speed: 0,
      side,
      role,
      world: new THREE.Vector3(),
      prevWorld: new THREE.Vector3(),
      velX: 0,
      velZ: 0,
      yaw: 0,
      steerLean: 0,
      root: null,
      lights: null,
      body: null,
      collider: null,
      active: false,
      damageSim: new CoreDamageSim(COP_MASS_KG),
      damageRig: null,
      latV: 0,
      yawOff: 0,
      yawRate: 0,
      wrecked: false,
      overtakeSide: 0,
      overtakeHoldT: 0,
    };
  }

  private resetUnitState(u: PatrolUnit) {
    u.damageSim.reset();
    u.damageRig?.clear();
    u.latDot = 0;
    u.latDdot = 0;
    u.latV = 0;
    u.yawOff = 0;
    u.yawRate = 0;
    u.steerLean = 0;
    u.wrecked = false;
    u.overtakeSide = 0;
    u.overtakeHoldT = 0;
  }

  /** Current police interceptor maximum top speed cap in km/h (strictly 90% of player car's top speed). */
  get currentMaxSpeedKmh(): number {
    return this.lastCopTopSpeedMs * 3.6;
  }

  /** Whether dispatch has been alerted by a speed camera and cruisers are inbound. */
  get dispatched() { return this.dispatchDelay > 0; }
  /** 0..1 progress toward getting busted (only rises when pinned < 15 km/h within 9.5 m). */
  get bustProgress() { return this.active ? Math.min(1, this.slow / BUST_HOLD) : 0; }
  /** 0..1 progress toward shaking off the pursuit during EVADING cooldown. */
  get evadeProgress() { return this.active && this.evading ? Math.min(1, this.evadeTimer / EVADE_HOLD) : 0; }

  /** Deterministically build roadside GATSO speed cameras along the route with curvature-based speed limits. */
  private buildCameraData() {
    this.cameras = [];
    const L = this.lane.length;
    if (L < 220) return;
    const count = Math.max(3, Math.min(14, Math.floor(L / CAM_SPACING_M)));
    const step = L / count;
    const nPts = this.lane.n;
    for (let k = 0; k < count; k++) {
      const s = this.lane.wrap(240 + k * step);
      const ci = this.lane.idx(s);
      const rA = this.lane.right[(ci - 3 + nPts) % nPts];
      const rB = this.lane.right[(ci + 3) % nPts];
      const dAng = Math.acos(Math.max(-1, Math.min(1, rA.x * rB.x + rA.z * rB.z)));
      const curv = dAng / 24;
      const limitKmh = curv > 0.012 ? 60 : curv > 0.0045 ? 80 : 100;
      const room = this.lane.room(s);
      const lat = Math.min(room.right + 1.05, 8.5);
      const world = new THREE.Vector3();
      this.lane.at(s, lat, world);
      const r = this.lane.right[ci];
      const yaw = Math.atan2(r.z, -r.x);
      this.cameras.push({
        id: k + 1,
        name: `CAM #${k + 1}`,
        s,
        limitKmh,
        world,
        yaw,
        cooldown: 0,
        flashTimer: 0,
        mesh: null,
        flashMat: null,
      });
    }
  }

  private buildCameraMeshes() {
    if (!this.scene) return;
    if (this.camGroup) {
      this.camGroup.removeFromParent();
      this.camGroup = null;
    }
    const g = new THREE.Group();
    g.name = 'police_speed_cameras';
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.1, 3.6, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c3240, metalness: 0.7, roughness: 0.35 });
    const boxGeo = new THREE.BoxGeometry(0.46, 0.56, 0.42);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x3b4252, metalness: 0.5, roughness: 0.4 });
    const stripeGeo = new THREE.BoxGeometry(0.48, 0.11, 0.44);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffb02e });
    const lensGeo = new THREE.SphereGeometry(0.11, 8, 8);

    for (const cam of this.cameras) {
      const unit = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = 1.8;
      const box = new THREE.Mesh(boxGeo, boxMat);
      box.position.set(0, 3.45, 0);
      const stripe = new THREE.Mesh(stripeGeo, stripeMat);
      stripe.position.set(0, 3.65, 0);
      const flashMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
      const lens = new THREE.Mesh(lensGeo, flashMat);
      lens.position.set(0, 3.42, -0.22);
      unit.add(pole, box, stripe, lens);
      unit.position.copy(cam.world);
      unit.rotation.y = cam.yaw;
      g.add(unit);
      cam.mesh = unit;
      cam.flashMat = flashMat;
    }
    this.scene.add(g);
    this.camGroup = g;
  }

  setCamerasVisible(on: boolean) {
    if (this.camGroup) this.camGroup.visible = on;
  }

  /** Rebind police pursuit path and rebuild roadside speed cameras for a new city. */
  setLane(lane: Lane) {
    this.breakOff();
    this.lane = lane;
    this.optLine = computeMinCurvatureLine(this.lane);
    this.s = 0;
    this.buildCameraData();
    this.buildCameraMeshes();
  }

  /** Build 4 Black & White Police Interceptors + 2 Roadblock Interceptors with flashing lights, GPU dent rigs & Rapier colliders. */
  setupVisuals(proto: THREE.Object3D, scene: THREE.Scene, pw: PhysicsWorld) {
    this.proto = proto;
    this.scene = scene;
    this.pw = pw;
    this.buildCameraMeshes();

    if (this.vfx) {
      this.vfx.smoke.sprite.removeFromParent();
      this.vfx.sparks.sprite.removeFromParent();
    }
    this.vfx = new SharedDamageVfx(scene);

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.root) u.root.removeFromParent();
      const built = buildPoliceInterceptor(proto, u.unitNumber, true);
      built.root.name = `cop_unit_${i}_${u.unitNumber}`;
      built.root.visible = false;
      updatePoliceLights(built.lights, 0, false);
      scene.add(built.root);
      u.root = built.root;
      u.lights = built.lights;
      u.damageSim = new CoreDamageSim(COP_MASS_KG);
      u.damageRig = new VehicleDamageRig(built.root);
      this.resetUnitState(u);

      if (!u.body) {
        const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0));
        const collider = pw.world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.98, 0.48, 2.3)
            .setTranslation(0, 0.62, 0)
            .setFriction(0.35)
            .setRestitution(0.05)
            .setCollisionGroups(GROUP_CAR),
          body,
        );
        body.setEnabled(false);
        u.body = body;
        u.collider = collider;
      }
      if (i === 0) this.root = built.root;
    }

    // Build reusable tactical roadblock (2 angled Police Interceptors + cones + bypass chevrons + Rapier colliders + damage rigs)
    if (this.roadblock) {
      this.roadblock.group.removeFromParent();
    }
    const rbGroup = new THREE.Group();
    rbGroup.name = 'cop_roadblock';
    rbGroup.visible = false;
    const rbLights: PoliceLightRig[] = [];
    const rbBodies: RAPIER.RigidBody[] = [];
    const rbColliders: RAPIER.Collider[] = [];
    const rbCarRoots: THREE.Object3D[] = [];
    const rbCarWorlds: THREE.Vector3[] = [];
    const rbCarYaws: number[] = [];
    const rbCarLats: number[] = [];
    const rbDamageSims: CoreDamageSim[] = [];
    const rbDamageRigs: VehicleDamageRig[] = [];

    const coneGeo = new THREE.ConeGeometry(0.24, 0.72, 6);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xff5a1f });

    // Wide 4.6 m skill gap so attentive drivers can thread through cleanly
    for (const lay of ROADBLOCK_LAYOUTS) {
      const built = buildPoliceInterceptor(proto, lay.num, true);
      built.root.position.set(lay.x, 0.02, lay.z);
      built.root.rotation.y = lay.yaw;
      updatePoliceLights(built.lights, 0, false);
      rbLights.push(built.lights);
      rbCarRoots.push(built.root);
      rbCarWorlds.push(new THREE.Vector3());
      rbCarYaws.push(lay.yaw);
      rbCarLats.push(lay.x);
      rbDamageSims.push(new CoreDamageSim(COP_MASS_KG));
      rbDamageRigs.push(new VehicleDamageRig(built.root));
      rbGroup.add(built.root);

      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0));
      const collider = pw.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.98, 0.55, 2.3)
          .setTranslation(0, 0.65, 0)
          .setFriction(0.4)
          .setRestitution(0.08)
          .setCollisionGroups(GROUP_CAR),
        body,
      );
      body.setEnabled(false);
      rbBodies.push(body);
      rbColliders.push(collider);
    }
    for (const cx of [-6.2, -2.3, 2.3, 6.2]) {
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(cx, 0.36, -1.3);
      rbGroup.add(cone);
    }

    // 3D glowing neon-amber bypass chevron markers showing the GPS reroute side around the roadblock
    const chevrons = new THREE.Group();
    const chevGeo = new THREE.BoxGeometry(0.95, 0.22, 0.22);
    const chevMat = new THREE.MeshBasicMaterial({ color: 0xffb02e });
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(chevGeo, chevMat);
      m.position.set(0, 1.35, -24 - k * 14);
      m.rotation.y = 0.55;
      chevrons.add(m);
    }
    chevrons.visible = false;
    rbGroup.add(chevrons);

    scene.add(rbGroup);
    this.roadblock = {
      active: false,
      s: 0,
      world: new THREE.Vector3(),
      group: rbGroup,
      bodies: rbBodies,
      colliders: rbColliders,
      carRoots: rbCarRoots,
      carWorlds: rbCarWorlds,
      carYaws: rbCarYaws,
      carLats: rbCarLats,
      damageSims: rbDamageSims,
      damageRigs: rbDamageRigs,
      lights: rbLights,
      announced: false,
      bypassSide: 1,
      phase: 'forming',
      rerouteTimer: 0,
      rerouteAnnounced: false,
      distM: 0,
      detourPts: [],
      chevrons,
    };
  }

  /** Nearest arc length to a world point around a hint. */
  nearest(pos: THREE.Vector3, hint: number) {
    let best = hint, bestD = Infinity;
    const n = this.lane.n;
    const h = this.lane.idx(hint);
    for (let k = -60; k <= 60; k++) {
      const i = (h + k + n) % n;
      const p = this.lane.pts[i];
      const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i * (this.lane.length / n); }
    }
    return best;
  }

  /** Monitor roadside speed cameras AND proactive patrol sightings; triggers immediate pursuits! */
  updateCameras(dt: number, playerS: number, playerPos: THREE.Vector3, kmh: number, enabled: boolean, heatLevel = 1) {
    this.setCamerasVisible(enabled);
    this.nextCamera = null;
    this.lastPlayerSpeedMs = Math.max(0, kmh / 3.6);

    if (!enabled) {
      this.dispatchDelay = 0;
      this.recklessTimer = 0;
      return;
    }

    // Escalate active pursuit squad if heat rises mid-chase
    if (this.active && heatLevel > this.heat) {
      this.heat = Math.min(5, Math.floor(heatLevel));
      this.activateHeatReinforcements(playerS);
    }

    // Pending dispatch countdown: brisk 1.2 s arrival after speed camera alerts police radio
    if (this.dispatchDelay > 0 && !this.active) {
      this.dispatchDelay -= dt;
      if (this.dispatchDelay <= 0) {
        this.dispatchDelay = 0;
        this.spawn(playerS, playerPos, this.dispatchHeat, 'camera');
      }
    }

    // Proactive patrol sighting: speeding > 140 km/h for 4.5 s (or 2.0 s at Heat 2+) brings a live patrol onto you
    if (!this.active && this.dispatchDelay <= 0) {
      if (kmh > 140) {
        this.recklessTimer += dt;
        const triggerS = heatLevel >= 2 ? 2.0 : 4.5;
        if (this.recklessTimer >= triggerS) {
          this.recklessTimer = 0;
          this.spawn(playerS, playerPos, Math.max(1, heatLevel), 'patrol', kmh);
        }
      } else {
        this.recklessTimer = Math.max(0, this.recklessTimer - dt * 0.5);
      }
    } else {
      this.recklessTimer = 0;
    }

    if (!this.cameras.length) return;

    const L = this.lane.length;
    const half = L * 0.5;
    const signedDelta = (a: number, b: number) => {
      const raw = ((a - b) % L + L) % L;
      return raw > half ? raw - L : raw;
    };

    let closestAheadDist = 240;
    for (const cam of this.cameras) {
      if (cam.cooldown > 0) cam.cooldown = Math.max(0, cam.cooldown - dt);
      if (cam.flashTimer > 0) {
        cam.flashTimer = Math.max(0, cam.flashTimer - dt);
        if (cam.flashMat) {
          const bright = cam.flashTimer > 0.35 || (cam.flashTimer > 0.12 && cam.flashTimer < 0.24);
          cam.flashMat.color.setHex(bright ? 0xffffff : 0xff3b30);
        }
      } else if (cam.flashMat) {
        cam.flashMat.color.setHex(0xff3b30);
      }

      const ahead = signedDelta(cam.s, playerS);
      if (ahead > 0 && ahead < closestAheadDist) {
        closestAheadDist = ahead;
        this.nextCamera = { id: cam.id, name: cam.name, limitKmh: cam.limitKmh, distM: Math.round(ahead) };
      }

      // Trigger speed camera when passing within 14 m over limit + grace margin
      if (cam.cooldown <= 0 && Math.abs(ahead) < 14) {
        const dWorld = Math.hypot(cam.world.x - playerPos.x, cam.world.z - playerPos.z);
        if (dWorld < 20 && kmh > cam.limitKmh + CAM_OVER_MARGIN) {
          cam.cooldown = CAM_COOLDOWN_S;
          cam.flashTimer = 0.55;
          const spd = Math.round(kmh);
          const over = spd - cam.limitKmh;
          this.hooks.onCameraFlash?.(cam, spd, over);

          if (!this.active && this.dispatchDelay <= 0) {
            this.dispatchDelay = DISPATCH_DELAY_S;
            this.dispatchHeat = Math.max(1, Math.min(5, heatLevel + (over >= 70 ? 1 : 0)));
            this.tactic = 'DISPATCHED';
            this.hooks.onAlert?.(`📸 ${cam.name} FLASHED · ${spd} km/h IN ${cam.limitKmh} ZONE · INTERCEPTORS DISPATCHED`);
            this.hooks.onRadio?.(
              'DISPATCH',
              `All units, speed camera ${cam.id} tripped — suspect clocked at ${spd} in a ${cam.limitKmh} zone. Interceptors respond immediately, over.`,
              true,
              'cam_dispatch',
            );
          } else if (this.active) {
            if (this.evading) {
              this.evading = false;
              this.evadeTimer = 0;
              this.far = 0;
              this.blind = 0;
              this.tactic = 'PURSUIT';
              this.hooks.onRadio?.(
                'DISPATCH',
                `Camera ${cam.id} just caught the suspect again at ${spd} kilometers per hour! All units re-engaging.`,
                true,
                'cam_respot',
              );
            } else {
              this.hooks.onRadio?.(
                'DISPATCH',
                `Update: suspect blew past camera ${cam.id} at ${spd} in a ${cam.limitKmh} zone.`,
                false,
                'cam_respot',
              );
            }
          }
        }
      }
    }
  }

  /** Bring Heat 2+ and Heat 3+ units online mid-chase if Heat escalated. */
  private activateHeatReinforcements(playerS: number) {
    const cap = this.lastCopTopSpeedMs;
    const pSpd = Math.min(cap, Math.max(32, this.lastPlayerSpeedMs));
    const u2 = this.units[2];
    if (this.heat >= 2 && !u2.active) {
      this.resetUnitState(u2);
      u2.active = true;
      u2.s = this.lane.wrap(playerS - 65);
      u2.lat = -2.4;
      u2.speed = Math.min(cap, Math.max(32, pSpd * 0.98));
      this.placeUnit(u2, true);
    }
    const u3 = this.units[3];
    if (this.heat >= 3 && !u3.active) {
      this.resetUnitState(u3);
      u3.active = true;
      u3.s = this.lane.wrap(playerS + 190);
      u3.lat = 2.2;
      u3.speed = Math.min(cap * 0.65, Math.max(20, pSpd * 0.55));
      this.placeUnit(u3, true);
    }
  }

  spawn(
    playerS: number,
    playerPos: THREE.Vector3,
    heatLevel = 1,
    trigger: 'camera' | 'patrol' | 'manual' = 'manual',
    triggerKmh = 160,
  ) {
    this.active = true;
    this.dispatchDelay = 0;
    this.recklessTimer = 0;
    this.heat = Math.max(1, Math.min(5, Math.floor(heatLevel || 1)));
    this.t = 0;
    this.far = 0;
    this.slow = 0;
    this.evadeTimer = 0;
    this.evading = false;
    this.blind = 0;
    this.gentleTapCd = 6.0;
    this.pullOverRadioCd = 3.5;
    this.pullOverOrderIdx = 0;
    this.roadblockCd = this.heat >= 2 ? 9.0 : 14.0;
    this.lastPullingAwayRadio = 0;
    this.lastInterceptRadio = -10;
    this.hornPulse = 0.85;
    this.hornCd = 4.0;
    this.hasPrevPlayer = false;
    this.tactic = 'PURSUIT';

    this.vfx?.clear();
    const cap = this.lastCopTopSpeedMs;
    const pSpd = Math.min(cap, Math.max(30, this.lastPlayerSpeedMs));

    // Unit 0 (ESCORT, Unit-04): 48 m behind at disciplined pursuit speed
    const u0 = this.units[0];
    this.resetUnitState(u0);
    u0.active = true;
    u0.s = this.lane.wrap(playerS - 48);
    u0.lat = 1.4;
    u0.speed = Math.min(cap, Math.max(32, pSpd * 0.98));

    // Unit 1 (INTERCEPT, Unit-07): Active even at Heat 1+! Spawns 155 m AHEAD rolling onto the route
    const u1 = this.units[1];
    this.resetUnitState(u1);
    u1.active = true;
    u1.s = this.lane.wrap(playerS + 155);
    u1.lat = -1.8;
    u1.speed = Math.min(cap * 0.65, Math.max(18, pSpd * 0.45));

    // Unit 2 (BOX, Unit-11): Joins at Heat 2+ from 65 m behind on opposite side
    const u2 = this.units[2];
    this.resetUnitState(u2);
    u2.active = this.heat >= 2;
    u2.s = this.lane.wrap(playerS - 65);
    u2.lat = -2.4;
    u2.speed = Math.min(cap, Math.max(32, pSpd * 0.96));

    // Unit 3 (BACKUP, Unit-15): Joins at Heat 3+
    const u3 = this.units[3];
    this.resetUnitState(u3);
    u3.active = this.heat >= 3;
    u3.s = this.lane.wrap(this.heat >= 4 ? playerS + 190 : playerS - 110);
    u3.lat = 2.4;
    u3.speed = this.heat >= 4
      ? Math.min(cap * 0.65, Math.max(20, pSpd * 0.5))
      : Math.min(cap, Math.max(34, pSpd * 0.98));

    this.hideRoadblock();
    this.placeUnits(playerPos, true);
    this.s = u0.s;
    this.speed = u0.speed;
    this.world.copy(u0.world);
    this.minDist = Math.hypot(u0.world.x - playerPos.x, u0.world.z - playerPos.z);

    if (trigger === 'patrol') {
      this.hooks.onAlert?.(`🚨 PATROL SPOTTED YOU AT ${Math.round(triggerKmh)} KM/H · HEAT ${this.heat}`);
      this.hooks.onRadio?.(
        'UNIT-04',
        `Dispatch, Unit 4 on patrol — suspect just blew past at ${Math.round(triggerKmh)}! Lights and sirens, engaging pursuit!`,
        true,
        'patrol_spotted',
      );
    } else {
      const count = this.units.filter((u) => u.active).length;
      this.hooks.onAlert?.(count >= 3 ? `🚨 ${count}-UNIT INTERCEPTOR SQUAD · HEAT ${this.heat}` : '🚨 POLICE INTERCEPTORS IN PURSUIT');
      this.hooks.onRadio?.(
        'UNIT-04',
        `10-4 Dispatch, Unit 4 has visual on the speeding vehicle. Unit 7 moving to intercept ahead!`,
        true,
        'unit_visual',
      );
    }
  }

  breakOff() {
    this.active = false;
    this.dispatchDelay = 0;
    this.recklessTimer = 0;
    this.evading = false;
    this.evadeTimer = 0;
    this.slow = 0;
    this.far = 0;
    this.blind = 0;
    this.hornPulse = 0;
    this.minDist = 999;
    this.tactic = 'PURSUIT';
    this.sirenSnapshot = { proximity: 0, dopplerRatio: 1.0, pan: 0, aggressive: false, hornPulse: 0 };
    this.vfx?.clear();
    for (const u of this.units) {
      u.active = false;
      this.resetUnitState(u);
      if (u.lights) updatePoliceLights(u.lights, 0, false);
      if (u.root) u.root.visible = false;
      if (u.body) {
        u.body.setTranslation({ x: 0, y: -600, z: 0 }, true);
        u.body.setEnabled(false);
      }
    }
    this.hideRoadblock();
  }

  private hideRoadblock() {
    if (!this.roadblock) return;
    this.roadblock.active = false;
    this.roadblock.announced = false;
    this.roadblock.rerouteAnnounced = false;
    this.roadblock.rerouteTimer = 0;
    this.roadblock.detourPts = [];
    this.roadblock.chevrons.visible = false;
    this.roadblock.group.visible = false;
    for (const sim of this.roadblock.damageSims) sim.reset();
    for (const rig of this.roadblock.damageRigs) rig.clear();
    for (const l of this.roadblock.lights) updatePoliceLights(l, 0, false);
    for (const b of this.roadblock.bodies) {
      b.setTranslation({ x: 0, y: -600, z: 0 }, true);
      b.setEnabled(false);
    }
  }

  /** Deploy a police roadblock ahead + trigger quick GPS & Street Radio reroute (first 3 cars must punch through!). */
  deployRoadblock(playerS: number, playerRank = 1, isRace = true) {
    const rb = this.roadblock;
    if (!rb) return;
    rb.s = this.lane.wrap(playerS + ROADBLOCK_AHEAD);
    this.lane.at(rb.s, 0, rb.world);
    const i = this.lane.idx(rb.s);
    const r = this.lane.right[i];
    const room = this.lane.room(rb.s);
    const roadYaw = Math.atan2(r.z, -r.x);
    const bypassSide: -1 | 1 = room.right >= room.left ? 1 : -1;
    const sideWord = bypassSide > 0 ? 'RIGHT' : 'LEFT';

    rb.bypassSide = bypassSide;
    rb.group.position.set(rb.world.x, rb.world.y, rb.world.z);
    rb.group.rotation.y = roadYaw;
    rb.group.visible = true;
    rb.active = true;
    rb.announced = true;
    rb.rerouteAnnounced = false;
    rb.distM = ROADBLOCK_AHEAD;

    // Position the 3 glowing bypass chevrons toward the clear bypass side
    rb.chevrons.position.set(bypassSide * 4.8, 0, 0);
    rb.chevrons.rotation.y = bypassSide > 0 ? -0.35 : 0.35;

    // Build smooth 11-point GPS bypass detour polyline in game frame (x, y = -z) curving around the roadblock
    const detourPts: { x: number; y: number }[] = [];
    const tmp = new THREE.Vector3();
    for (let k = 0; k <= 10; k++) {
      const f = k / 10;
      const ds = -115 + f * 195;
      const bell = Math.sin(Math.PI * f);
      const latOff = bypassSide * bell * Math.max(9.5, Math.min(16.0, (bypassSide > 0 ? room.right : room.left) + 5.5));
      this.lane.at(this.lane.wrap(rb.s + ds), latOff, tmp);
      detourPts.push({ x: tmp.x, y: -tmp.z });
    }
    rb.detourPts = detourPts;

    const cosY = Math.cos(roadYaw), sinY = Math.sin(roadYaw);
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < ROADBLOCK_LAYOUTS.length; k++) {
      const l = ROADBLOCK_LAYOUTS[k];
      const wx = rb.world.x + l.x * cosY + l.z * sinY;
      const wz = rb.world.z - l.x * sinY + l.z * cosY;
      const wyaw = roadYaw + l.yaw;
      rb.carWorlds[k].set(wx, rb.world.y, wz);
      rb.carYaws[k] = wyaw;
      rb.carLats[k] = (wx - rb.world.x) * r.x + (wz - rb.world.z) * r.z;
      rb.damageSims[k].reset();
      rb.damageRigs[k].clear();
      q.setFromAxisAngle(up, wyaw);
      rb.bodies[k].setEnabled(true);
      rb.bodies[k].setTranslation({ x: wx, y: rb.world.y, z: wz }, true);
      rb.bodies[k].setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    }

    const topThreeMustPunch = isRace && playerRank >= 1 && playerRank <= 3;
    rb.phase = topThreeMustPunch ? 'punch' : 'forming';
    rb.rerouteTimer = topThreeMustPunch ? 1.35 : 0.95;
    rb.chevrons.visible = !topThreeMustPunch;

    this.tactic = 'ROADBLOCK AHEAD';
    this.triggerHorn();
    this.hooks.onRadio?.(
      'DISPATCH',
      'Roadblock forming two hundred fifty meters ahead of the lead pack! Lock down the strip!',
      true,
      'roadblock_deploy',
    );
    if (topThreeMustPunch) {
      this.hooks.onAlert?.('🚧 ROADBLOCK FORMING · P1–P3 THREAD GAP!');
      this.hooks.onStreetRadio?.(
        'GPS',
        `🚧 ROADBLOCK FORMING AHEAD! Top 3 (P1–P3) are too close — PUNCH THROUGH THE GAP! Rerouting P4+ ${sideWord}!`,
        'street_rb_punch',
      );
    } else {
      this.hooks.onAlert?.(`↪ QUICK GPS REROUTE · BYPASS ${sideWord}`);
      this.hooks.onStreetRadio?.(
        'GPS',
        `🚧 ROADBLOCK FORMING AHEAD! Quick reroute calculating — P1–P3 punching through, prep ${sideWord} bypass!`,
        'street_rb_forming',
      );
    }
  }

  /** Active roadblock reroute state for in-car GPS display, or null. */
  get roadblockReroute(): RoadblockRerouteInfo | null {
    const rb = this.roadblock;
    if (!rb?.active) return null;
    return {
      active: true,
      phase: rb.phase,
      blockX: rb.world.x,
      blockZ: rb.world.z,
      distM: rb.distM,
      bypassSide: rb.bypassSide,
      detourPts: rb.detourPts,
    };
  }

  /** World position of active roadblock (for minimap warning icon), or null. */
  get roadblockWorld(): THREE.Vector3 | null {
    return this.roadblock?.active ? this.roadblock.world : null;
  }

  /** All active non-wrecked patrol unit positions (for minimap pursuit blips). */
  unitPositions(): THREE.Vector3[] {
    return this.units.filter((u) => u.active && !u.wrecked).map((u) => u.world);
  }

  /** All speed camera world positions (for minimap radar blips). */
  cameraPositions(): { x: number; z: number; limitKmh: number }[] {
    return this.cameras.map((c) => ({ x: c.world.x, z: c.world.z, limitKmh: c.limitKmh }));
  }

  /**
   * Reused array of active police cruiser & roadblock obstacles so AI racers can see and intelligently
   * dodge moving interceptors, wrecked cruisers, and roadblock vehicles.
   */
  obstacleList(): RoadObstacle[] {
    const out = this.obstaclesBuf;
    let n = 0;
    const pushObs = (x: number, z: number, v: number, lat: number, radius: number, isBlock: boolean) => {
      if (n < out.length) {
        const slot = out[n++];
        slot.x = x;
        slot.z = z;
        slot.v = v;
        slot.lat = lat;
        slot.radius = radius;
        slot.isCop = true;
        slot.isBlock = isBlock;
      } else {
        out.push({ x, z, v, lat, radius, isCop: true, isBlock });
        n++;
      }
    };

    if (this.active) {
      for (let i = 0; i < this.units.length; i++) {
        const u = this.units[i];
        if (!u.active) continue;
        pushObs(u.world.x, u.world.z, u.speed, u.lat, 1.35, u.wrecked);
      }
      const rb = this.roadblock;
      if (rb?.active) {
        for (let k = 0; k < rb.carWorlds.length; k++) {
          const w = rb.carWorlds[k];
          pushObs(w.x, w.z, 0, rb.carLats[k], 2.1, true);
        }
      }
    }
    out.length = n;
    return out;
  }

  private triggerHorn() {
    if (this.hornCd > 0) return;
    this.hornPulse = 1.0;
    this.hornCd = 5.5;
  }

  /** Mark a police unit disabled/totaled after lethal crash energy, broadcast radio, and end pursuit if none left. */
  private markUnitDisabled(u: PatrolUnit) {
    if (u.wrecked) return;
    u.wrecked = true;
    this.hooks.onUnitDisabled?.(u.callsign);
    this.hooks.onAlert?.(`💥 ${u.callsign} DISABLED · OUT OF PURSUIT!`);
    this.hooks.onRadio?.(
      u.callsign,
      'Unit disabled! Heavy vehicle damage, out of the pursuit!',
      true,
      'unit_disabled',
    );
    // If ALL active pursuit units are disabled/wrecked, pursuit immediately ends!
    const anyOperational = this.units.some((x) => x.active && !x.wrecked);
    if (!anyOperational && this.active) {
      this.breakOff();
      this.hooks.escaped();
    }
  }

  /**
   * After `pw.world.step()`: share player collisions with active police patrol units and roadblock cruisers.
   * Mirrors `AiTraffic.afterStep`: player keeps half the solver velocity change, the police cruiser takes the
   * other half as longitudinal/lateral shove + yaw spin + exact `CoreDamageSim` crash damage & GPU vertex dents!
   */
  afterStep(
    playerCollider: RAPIER.Collider,
    playerBody: RAPIER.RigidBody,
    preV: THREE.Vector3,
    preW: THREE.Vector3,
  ): boolean {
    if (!this.active || !this.pw) return false;
    const world = this.pw.world;
    const p = playerBody.translation();
    const stepDt = Math.max(1 / 400, Math.min(0.05, world.timestep || 1 / 400));

    // 1. Check active patrol units within 8 m
    let hitUnit: PatrolUnit | null = null;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.active || !u.collider) continue;
      const dx = p.x - u.world.x;
      const dz = p.z - u.world.z;
      if (dx * dx + dz * dz > 64) continue;
      let touching = false;
      world.contactPair(playerCollider, u.collider, (m) => {
        if (m.numContacts() > 0) touching = true;
      });
      if (touching) {
        hitUnit = u;
        break;
      }
    }

    if (hitUnit) {
      const u = hitUnit;
      const lv = playerBody.linvel();
      const av = playerBody.angvel();
      const dvx = lv.x - preV.x;
      const dvz = lv.z - preV.z;
      const dv = Math.hypot(dvx, dvz);
      if (dv < 0.02) return true;

      // Split velocity change realistically (player keeps half, cruiser takes the other half)
      this.tmpLin.x = (preV.x + lv.x) * 0.5;
      this.tmpLin.y = lv.y;
      this.tmpLin.z = (preV.z + lv.z) * 0.5;
      this.tmpAng.x = (preW.x + av.x) * 0.5;
      this.tmpAng.y = (preW.y + av.y) * 0.5;
      this.tmpAng.z = (preW.z + av.z) * 0.5;
      playerBody.setLinvel(this.tmpLin, true);
      playerBody.setAngvel(this.tmpAng, true);

      // Apply the cruiser's half in its own frame
      const ci = this.lane.idx(u.s);
      const right = this.lane.right[ci];
      const sinY = Math.sin(u.yaw);
      const cosY = Math.cos(u.yaw);
      const fwdX = sinY;
      const fwdZ = cosY;
      const rx = -dvx * 0.5;
      const rz = -dvz * 0.5;
      const along = rx * fwdX + rz * fwdZ;
      const across = rx * right.x + rz * right.z;
      u.speed = Math.max(0, u.speed + along);
      u.latV += across;

      const wx = p.x - u.world.x;
      const wz = p.z - u.world.z;
      const lever = Math.max(-1, Math.min(1, (wx * fwdX + wz * fwdZ) / 2.2));
      u.yawRate += across * lever * 0.55;

      // Model-space impact point (+Z = front, +X = left)
      const lz = Math.max(-2.3, Math.min(2.3, wx * fwdX + wz * fwdZ));
      const lx = Math.max(-0.98, Math.min(0.98, wx * cosY - wz * sinY));
      const ly = 0.55;
      const hitRes = u.damageSim.addImpact(dv * 0.5, lx, ly, lz, stepDt, 1);
      if (hitRes) {
        if (u.root && u.damageRig) {
          u.root.updateMatrixWorld(true);
          u.damageRig.applyHit(u.damageSim, hitRes, u.root, this.vfx);
        }
        if (hitRes.justTotaled || (u.damageSim.totaled && !u.wrecked)) {
          this.markUnitDisabled(u);
        }
      }
      return true;
    }

    // 2. Check active roadblock cruisers within 8 m
    const rb = this.roadblock;
    if (rb?.active) {
      for (let k = 0; k < rb.colliders.length; k++) {
        const w = rb.carWorlds[k];
        const dx = p.x - w.x;
        const dz = p.z - w.z;
        if (dx * dx + dz * dz > 64) continue;
        let touching = false;
        world.contactPair(playerCollider, rb.colliders[k], (m) => {
          if (m.numContacts() > 0) touching = true;
        });
        if (!touching) continue;

        const lv = playerBody.linvel();
        const av = playerBody.angvel();
        const dvx = lv.x - preV.x;
        const dvz = lv.z - preV.z;
        const dv = Math.hypot(dvx, dvz);
        if (dv < 0.02) return true;

        this.tmpLin.x = (preV.x + lv.x) * 0.5;
        this.tmpLin.y = lv.y;
        this.tmpLin.z = (preV.z + lv.z) * 0.5;
        this.tmpAng.x = (preW.x + av.x) * 0.5;
        this.tmpAng.y = (preW.y + av.y) * 0.5;
        this.tmpAng.z = (preW.z + av.z) * 0.5;
        playerBody.setLinvel(this.tmpLin, true);
        playerBody.setAngvel(this.tmpAng, true);

        const wyaw = rb.carYaws[k];
        const sinY = Math.sin(wyaw);
        const cosY = Math.cos(wyaw);
        const lz = Math.max(-2.3, Math.min(2.3, dx * sinY + dz * cosY));
        const lx = Math.max(-0.98, Math.min(0.98, dx * cosY - dz * sinY));
        const hitRes = rb.damageSims[k].addImpact(dv * 0.5, lx, 0.55, lz, stepDt, 1);
        if (hitRes && rb.carRoots[k] && rb.damageRigs[k]) {
          rb.carRoots[k].updateMatrixWorld(true);
          rb.damageRigs[k].applyHit(rb.damageSims[k], hitRes, rb.carRoots[k], this.vfx);
        }
        return true;
      }
    }

    return false;
  }

  /** Update wrecked cruiser's dim hazard/flickering lightbar so disabled units look unmistakably knocked out. */
  private applyWreckedLights(rig: PoliceLightRig, tSec: number) {
    updatePoliceLights(rig, tSec, false);
    rig.wasActive = true;
    const haz = Math.sin(tSec * 5.2 + rig.phaseOffset * 6.0) > 0.15;
    const glitch = Math.sin(tSec * 29.0 + rig.phaseOffset * 13.0) > 0.55;
    if (haz) {
      rig.barPods[0].color.setRGB(1.35, 0.08, 0.14);
      rig.barPods[2].color.setRGB(1.45, 0.72, 0.08);
      rig.barPods[3].color.setRGB(1.45, 0.72, 0.08);
      if (glitch) rig.barPods[5].color.setRGB(0.08, 0.55, 1.55);
      rig.rearR.color.setRGB(1.2, 0.06, 0.10);
      rig.groundWashMat.color.setHex(0xff4c1e);
      rig.groundWashMat.opacity = 0.16;
      if (rig.pointLight) {
        rig.pointLight.color.setHex(0xff421a);
        rig.pointLight.intensity = 12;
      }
    } else {
      rig.groundWashMat.opacity = 0.02;
      if (rig.pointLight) rig.pointLight.intensity = 0;
    }
    rig.wigWagL.color.setHex(0x14161c);
    rig.wigWagR.color.setHex(0x14161c);
  }

  /**
   * Main pursuit update:
   *  - Strict 90% top speed cap relative to player car's top speed (`playerMaxSpeedMs * 0.90`)
   *  - Minimum-Curvature Optimal Racing Line + C2-continuous Frenet quintic polynomial trajectory planner
   *  - Disciplined real-life police tactics (PULL OVER / BOX IN / ROADBLOCK AHEAD; NEVER ramming/PIT-wrecking!)
   *  - Exact-parity damage/smoke/disabled-unit progression
   */
  update(
    dt: number,
    playerS: number,
    playerPos: THREE.Vector3,
    kmh: number,
    playerRank = 1,
    isRace = true,
    playerHeadingRad?: number,
    playerMaxSpeedMs?: number,
    trafficObstacles?: readonly RoadObstacle[],
  ) {
    const safeDt = Math.max(1e-4, Math.min(0.1, dt));

    // Always keep currentMaxSpeedKmh accurately synchronized with 90% of player's top speed
    const basePlayerMaxMs = Math.max(45, playerMaxSpeedMs ?? FALLBACK_PLAYER_MAX_MS);
    const copTopSpeed = basePlayerMaxMs * 0.90;
    this.lastCopTopSpeedMs = copTopSpeed;

    if (!this.active) {
      this.sirenSnapshot.proximity = this.dispatchDelay > 0 ? 0.2 : 0;
      this.sirenSnapshot.dopplerRatio = 1.0;
      this.sirenSnapshot.pan = 0;
      this.sirenSnapshot.aggressive = false;
      this.sirenSnapshot.hornPulse = 0;
      this.vfx?.update(safeDt);
      return;
    }

    this.t += safeDt;
    this.gentleTapCd = Math.max(0, this.gentleTapCd - safeDt);
    this.pullOverRadioCd = Math.max(0, this.pullOverRadioCd - safeDt);
    this.roadblockCd -= safeDt;
    this.hornCd = Math.max(0, this.hornCd - safeDt);
    this.hornPulse = Math.max(0, this.hornPulse - safeDt * 1.45);
    this.lastPlayerSpeedMs = Math.max(0, kmh / 3.6);

    // Player velocity estimate for Doppler calculation
    let pVelX = 0;
    let pVelZ = 0;
    if (this.hasPrevPlayer) {
      pVelX = (playerPos.x - this.prevPlayerPos.x) / safeDt;
      pVelZ = (playerPos.z - this.prevPlayerPos.z) / safeDt;
    }
    this.prevPlayerPos.copy(playerPos);
    this.hasPrevPlayer = true;

    const L = this.lane.length;
    const half = L * 0.5;
    const signedDelta = (a: number, b: number) => {
      const raw = ((a - b) % L + L) % L;
      return raw > half ? raw - L : raw;
    };

    const pIdx = this.lane.idx(playerS);
    const pCenter = this.lane.pts[pIdx];
    const pRight = this.lane.right[pIdx];
    const playerLat = (playerPos.x - pCenter.x) * pRight.x + (playerPos.z - pCenter.z) * pRight.z;
    const playerSpeedMs = kmh / 3.6;

    // Realistic base interceptor acceleration (8.5..10.5 m/s²) and corner grip (mu = 1.12), scaled by damage per unit
    const baseAccel = Math.min(10.5, 8.5 + (this.heat - 1) * 0.5);

    let minDist = Infinity;
    let closestUnit: PatrolUnit | null = null;
    let closeUnitCount = 0;
    let operationalCount = 0;

    for (let uIdx = 0; uIdx < this.units.length; uIdx++) {
      const u = this.units[uIdx];
      if (!u.active) continue;

      // Step exact CoreDamageSim timers (overheat smoulder, fire, headlight flicker)
      u.damageSim.step(safeDt);
      if (u.damageSim.totaled && !u.wrecked) {
        this.markUnitDisabled(u);
        if (!this.active) return;
      }

      const room = this.lane.roomInto(u.s, this.roomScratch);

      // ---- Disabled / Wrecked Police Cruiser: coasts/skids to a smoking stop on the street ----
      if (u.wrecked) {
        u.latDot = 0;
        u.latDdot = 0;
        u.speed = Math.max(0, u.speed - 4.2 * safeDt);
        let dl = 0;
        if (u.latV !== 0) {
          dl = u.latV * safeDt;
          u.latV -= Math.sign(u.latV) * Math.min(Math.abs(u.latV), 7.0 * safeDt);
          const minEdge = -room.left - 0.6;
          const maxEdge = room.right + 0.6;
          if (u.lat + dl > maxEdge) {
            dl = maxEdge - u.lat;
            u.latV = 0;
            u.speed *= 0.72;
          } else if (u.lat + dl < minEdge) {
            dl = minEdge - u.lat;
            u.latV = 0;
            u.speed *= 0.72;
          }
        }
        if (u.yawRate !== 0) {
          u.yawOff += u.yawRate * safeDt;
          u.yawRate *= Math.exp(-2.2 * safeDt);
          if (Math.abs(u.yawRate) < 0.002) u.yawRate = 0;
        }
        u.steerLean *= Math.exp(-5.0 * safeDt);
        u.lat += dl;
        u.s = this.lane.wrap(u.s + u.speed * safeDt);
        u.prevWorld.copy(u.world);
        this.lane.at(u.s, u.lat, u.world);
        u.velX = (u.world.x - u.prevWorld.x) / safeDt;
        u.velZ = (u.world.z - u.prevWorld.z) / safeDt;
        if (u.root && u.damageRig) {
          u.damageRig.updateSmoke(safeDt, u.damageSim, u.root, this.vfx);
        }
        continue;
      }

      operationalCount++;
      let gapAhead = signedDelta(playerS, u.s); // > 0 player ahead; < 0 cop ahead

      // Dynamic leapfrog intercept: if a non-lead operational unit falls > 340 m behind while NOT evading,
      // redeploy it as a fresh intercept unit 240 m AHEAD (never leapfrog a wrecked unit!)
      if (!this.evading && uIdx > 0 && gapAhead > LEAPFROG_BEHIND) {
        this.resetUnitState(u);
        u.s = this.lane.wrap(playerS + LEAPFROG_AHEAD);
        const aheadRoom = this.lane.roomInto(u.s, this.roomScratch);
        u.lat = Math.max(-aheadRoom.left, Math.min(aheadRoom.right, playerLat + u.side * PLAYER_SAFE_LAT));
        u.speed = Math.min(copTopSpeed * 0.62, Math.max(18, playerSpeedMs * 0.55));
        this.placeUnit(u, true);
        gapAhead = signedDelta(playerS, u.s);
        if (this.t - this.lastInterceptRadio > 16) {
          this.lastInterceptRadio = this.t;
          this.hooks.onRadio?.(
            u.callsign,
            `Unit ${u.unitNumber} pulling onto the avenue ahead — moving to intercept cleanly!`,
            true,
            'intercept_ahead',
          );
        }
      }

      const curRoom = this.lane.roomInto(u.s, this.roomScratch);
      const roomLeft = Math.max(1.2, curRoom.left);
      const roomRight = Math.max(1.2, curRoom.right);

      // Per-unit damage-scaled performance (strictly <= 90% of player car's top speed!)
      const powerScale = u.damageSim.powerScale;
      const gripScale = u.damageSim.gripScale;
      const dragScale = u.damageSim.dragScale;
      const unitTopSpeed = Math.min(
        copTopSpeed,
        copTopSpeed * Math.sqrt(Math.max(0.25, powerScale) / Math.max(1, dragScale)),
      );
      const maxAccel = baseAccel * powerScale;
      const maxBrake = 12.2 * gripScale;
      const cornerMu = 1.12 * gripScale;

      // Multi-point upcoming corner speed lookahead along minimum-curvature racing line
      let cornerLimit = unitTopSpeed;
      const lookDists = [0, 14, 30, 50, 70];
      for (let lk = 0; lk < lookDists.length; lk++) {
        const dLook = lookDists[lk];
        const absK = this.optLine.curvAt(u.s + dLook);
        if (absK > 0.005) {
          const vTurn = Math.sqrt((cornerMu * 9.81) / absK);
          const vAllow = dLook > 0 ? Math.sqrt(vTurn * vTurn + 2 * maxBrake * dLook) : vTurn;
          if (vAllow < cornerLimit) cornerLimit = vAllow;
        }
      }

      // Role-based disciplined tactical longitudinal offset (NO aggressive rear-quarter ramming!)
      const wantOffsetS =
        u.role === 'escort'
          ? -6.0
          : u.role === 'intercept'
          ? 5.0
          : u.role === 'box'
          ? 1.8
          : -9.5;
      const d = signedDelta(playerS + wantOffsetS, u.s);

      let targetSpeed: number;
      if (this.evading) {
        targetSpeed = Math.min(unitTopSpeed * 0.90, cornerLimit);
      } else if (gapAhead < -22) {
        // Ahead of the player: maintain steady intercept pace so player can see lights & maneuver cleanly
        const aheadDist = -gapAhead;
        const holdFactor = aheadDist > 85 ? 0.44 : 0.70;
        targetSpeed = Math.min(unitTopSpeed * 0.75, Math.max(15, playerSpeedMs * holdFactor));
      } else if (d > 8) {
        // Behind target escort slot: accelerate up to strict 90% cap
        targetSpeed = unitTopSpeed;
      } else if (d > -6) {
        // Alongside / disciplined escort & box-in window: match speed smoothly without surging into bumper
        targetSpeed = Math.min(unitTopSpeed, Math.max(0, playerSpeedMs + d * 0.75));
      } else {
        // Ahead of player during box-in: ease pace gently to encourage player to slow & pull over
        targetSpeed = Math.max(0, playerSpeedMs - 2.6);
      }

      // ---- Minimum-Curvature Optimal Racing Line + C2-Continuous Frenet Quintic Trajectory Planner ----
      const ci = this.lane.idx(u.s);
      const rNow = this.lane.right[ci];
      const fwdX = rNow.z;
      const fwdZ = -rNow.x;

      const lineLookAhead = Math.min(34, 12 + u.speed * 0.45);
      const optLineLat = this.optLine.latAt(u.s + lineLookAhead);

      // Disciplined escort / box-in lateral offset (ALWAYS >= 2.75 m clearance alongside player!)
      let tacticalLat = optLineLat;
      const nearPlayerLong = gapAhead > -28 && gapAhead < 48;
      if (!this.evading && nearPlayerLong) {
        const rightTarget = playerLat + PLAYER_SAFE_LAT + 0.25;
        const leftTarget = playerLat - PLAYER_SAFE_LAT - 0.25;
        const canRight = rightTarget <= roomRight;
        const canLeft = leftTarget >= -roomLeft;
        let escortLat: number;
        if (u.role === 'escort' || u.role === 'backup') {
          // Lead escort pulls slightly to the clearer side (never directly riding into bumper)
          escortLat = (u.side > 0 ? canRight : !canLeft) ? rightTarget : leftTarget;
        } else {
          // Intercept / box unit takes the opposite lane with >= 2.75 m safe clearance
          escortLat = (u.side < 0 ? canLeft : !canRight) ? leftTarget : rightTarget;
        }
        // Blend optimal racing line when > 20 m away; prioritize disciplined escort lane when close
        const proxBlend = Math.max(0, Math.min(1, 1 - Math.abs(gapAhead) / 45));
        tacticalLat = optLineLat * (1 - proxBlend * 0.75) + escortLat * (proxBlend * 0.75);
      }
      const desiredLat = Math.max(-roomLeft, Math.min(roomRight, tacticalLat + u.damageSim.steerPull));

      // Populate reused FrenetObstacle scratch buffer (zero allocations):
      // player (strict non-ramming bubble >= 2.75 m), other active/wrecked units, roadblocks, and AI traffic/rivals
      const fObs = this.frenetObsBuf;
      let obsCount = 0;
      const pushFrenetObs = (
        ds: number,
        lat: number,
        v: number,
        clearLat: number,
        isBlock: boolean,
        isPlayer: boolean,
      ) => {
        if (obsCount < fObs.length) {
          const o = fObs[obsCount++];
          o.ds = ds;
          o.lat = lat;
          o.v = v;
          o.clearLat = clearLat;
          o.isBlock = isBlock;
          o.isPlayer = isPlayer;
        } else {
          fObs.push({ ds, lat, v, clearLat, isBlock, isPlayer });
          obsCount++;
        }
      };

      const obsLookAhead = Math.max(42, 22 + u.speed * 1.9);

      // 1. Player car (strict non-ramming bubble)
      if (gapAhead > -12 && gapAhead < obsLookAhead) {
        pushFrenetObs(gapAhead, playerLat, playerSpeedMs, PLAYER_SAFE_LAT, false, true);
      }

      // 2. Other active/wrecked police cruisers
      for (let j = 0; j < this.units.length; j++) {
        if (j === uIdx) continue;
        const ou = this.units[j];
        if (!ou.active) continue;
        const ds = signedDelta(ou.s, u.s);
        if (ds > -12 && ds < obsLookAhead) {
          pushFrenetObs(ds, ou.lat, ou.speed, ou.wrecked ? 2.95 : 2.5, ou.wrecked, false);
        }
      }

      // 3. Active roadblock cruisers
      if (this.roadblock?.active) {
        const rbDs = signedDelta(this.roadblock.s, u.s);
        if (rbDs > -14 && rbDs < obsLookAhead + 18) {
          for (let k = 0; k < this.roadblock.carLats.length; k++) {
            pushFrenetObs(rbDs + ROADBLOCK_LAYOUTS[k].z, this.roadblock.carLats[k], 0, 3.25, true, false);
          }
        }
      }

      // 4. AI racers / civilian street traffic
      if (trafficObstacles) {
        for (let k = 0; k < trafficObstacles.length; k++) {
          const to = trafficObstacles[k];
          const dx = to.x - u.world.x;
          const dz = to.z - u.world.z;
          const ds = dx * fwdX + dz * fwdZ;
          if (ds > -12 && ds < obsLookAhead) {
            const obsLat = Number.isFinite(to.lat) ? to.lat : u.lat + (dx * rNow.x + dz * rNow.z);
            const clearLat = to.isBlock ? 3.1 : Math.max(2.45, (to.radius ?? 1.3) + 1.25);
            pushFrenetObs(ds, obsLat, to.v, clearLat, !!to.isBlock, false);
          }
        }
      }

      if (u.overtakeHoldT > 0) {
        u.overtakeHoldT = Math.max(0, u.overtakeHoldT - safeDt);
        if (u.overtakeHoldT <= 0) u.overtakeSide = 0;
      }

      const spun = Math.abs(u.yawOff) > 0.6;
      const sliding = Math.abs(u.latV) > 0.4 || spun;

      const plan = this.frenet.plan(
        {
          d0: u.lat,
          dDot0: sliding ? 0 : u.latDot,
          dDdot0: sliding ? 0 : u.latDdot,
          egoV: u.speed,
          desiredLat,
          minLat: -roomLeft,
          maxLat: roomRight,
          prevSide: u.overtakeHoldT > 0 ? u.overtakeSide : 0,
          boldness: Math.min(0.88, 0.52 + (this.heat - 1) * 0.08),
          nonRammingPlayer: true,
          obstacles: fObs,
          obstacleCount: obsCount,
        },
        safeDt,
        this.frenetOut,
      );

      if (plan.chosenSide !== 0) {
        if (u.overtakeSide === 0 || u.overtakeHoldT <= 0.1) {
          u.overtakeSide = plan.chosenSide;
        }
        u.overtakeHoldT = 1.4;
      }

      // Smooth longitudinal braking cap from Frenet planner when blocked ahead
      if (Number.isFinite(plan.blockedSpeedCap)) {
        targetSpeed = Math.min(targetSpeed, plan.blockedSpeedCap);
      }

      // STRICT ANTI-REAR-END BRAKING behind the player car so police NEVER ram your rear bumper!
      if (gapAhead > 0 && gapAhead < 22 && Math.abs(u.lat - playerLat) < 2.65) {
        const followSafe = Math.max(0, playerSpeedMs + (gapAhead - 6.8) * 0.95);
        targetSpeed = Math.min(targetSpeed, followSafe);
      }

      targetSpeed = Math.min(targetSpeed, cornerLimit, unitTopSpeed);

      // Spun-out recovery: brake briefly to gather the cruiser up
      if (spun) targetSpeed = 0;

      // Longitudinal velocity update (smooth acceleration with aero drag falloff, strictly capped at unitTopSpeed <= 90% player max!)
      const speedFrac = Math.min(0.98, u.speed / Math.max(1, unitTopSpeed));
      const availAccel = maxAccel * (1 - 0.35 * speedFrac * speedFrac);
      const dvSpeed = targetSpeed - u.speed;
      if (dvSpeed > 0) u.speed += Math.min(dvSpeed, availAccel * safeDt);
      else u.speed += Math.max(dvSpeed, -maxBrake * safeDt);
      u.speed = Math.max(0, Math.min(unitTopSpeed, u.speed));

      // C2-continuous Frenet lateral movement + crash slide physics (mirrors AiTraffic with wall-impact CoreDamageSim!)
      let dl: number;
      if (sliding) {
        dl = 0;
        u.latDot *= Math.exp(-6 * safeDt);
        u.latDdot = 0;
      } else {
        dl = plan.nextLat - u.lat;
        u.latDot = plan.nextDot;
        u.latDdot = plan.nextDdot;
        if (u.speed < 0.5) {
          const sFac = u.speed / 0.5;
          dl *= sFac;
          u.latDot *= sFac;
          u.latDdot *= sFac;
        }
      }

      // Smooth visual heading lean driven by C2-continuous Frenet lateral velocity (u.latDot)
      const targetLean = u.speed > 1.0 && !sliding
        ? Math.max(-0.26, Math.min(0.26, Math.atan2(u.latDot, Math.max(4, u.speed))))
        : 0;
      u.steerLean += (targetLean - u.steerLean) * Math.min(1, safeDt * 8);

      // Sideways crash slide scrubbed by tyres; wall/curb collision applies exact CoreDamageSim damage!
      if (u.latV !== 0) {
        dl += u.latV * safeDt;
        u.latV -= Math.sign(u.latV) * Math.min(Math.abs(u.latV), 7.0 * safeDt);
        const minEdge = -roomLeft - 0.6;
        const maxEdge = roomRight + 0.6;
        const hitRight = u.lat + dl > maxEdge;
        const hitLeft = u.lat + dl < minEdge;
        if (hitRight || hitLeft) {
          const hitDv = Math.abs(u.latV);
          dl = (hitRight ? maxEdge : minEdge) - u.lat;
          u.latV = 0;
          u.latDot = 0;
          u.latDdot = 0;
          u.speed *= 0.72;
          // Model space: +X is left, -X is right
          const lx = hitRight ? -0.95 : 0.95;
          const wallHit = u.damageSim.addImpact(hitDv, lx, 0.55, 0.35, safeDt, 2);
          if (wallHit) {
            if (u.root && u.damageRig) {
              u.root.updateMatrixWorld(true);
              u.damageRig.applyHit(u.damageSim, wallHit, u.root, this.vfx);
            }
            if (wallHit.justTotaled || (u.damageSim.totaled && !u.wrecked)) {
              this.markUnitDisabled(u);
              if (!this.active) return;
            }
          }
        }
      }

      if (u.yawRate !== 0 || u.yawOff !== 0) {
        u.yawOff += u.yawRate * safeDt;
        u.yawRate *= Math.exp(-2.2 * safeDt);
        u.yawOff -= u.yawOff * Math.min(1, (spun ? 0.9 : 2.4) * safeDt);
        if (Math.abs(u.yawOff) < 0.002 && Math.abs(u.yawRate) < 0.002) {
          u.yawOff = 0;
          u.yawRate = 0;
        }
      }

      u.lat += dl;
      u.s = this.lane.wrap(u.s + u.speed * safeDt);

      u.prevWorld.copy(u.world);
      this.lane.at(u.s, u.lat, u.world);
      u.velX = (u.world.x - u.prevWorld.x) / safeDt;
      u.velZ = (u.world.z - u.prevWorld.z) / safeDt;

      // Emit hood steam/smoke when engine/cooling is damaged
      if (u.root && u.damageRig) {
        u.damageRig.updateSmoke(safeDt, u.damageSim, u.root, this.vfx);
      }

      const dist3 = Math.hypot(u.world.x - playerPos.x, u.world.z - playerPos.z);
      if (dist3 < minDist) {
        minDist = dist3;
        closestUnit = u;
      }
      if (dist3 < 45) closeUnitCount++;

      // Close-range airhorn / PA attention pulse when closing within 24 m
      if (!this.evading && dist3 < 24 && u.speed > playerSpeedMs + 2.5) {
        this.triggerHorn();
      }

      // Very gentle low-speed catch-tap ONLY if the cruiser physically catches right beside you while you slow down (< 70 km/h, < 3.8 m)
      if (!this.evading && dist3 < 3.8 && kmh < 70 && kmh > 6 && this.gentleTapCd <= 0) {
        const pushDir = u.lat < playerLat ? 1 : -1;
        this.gentleTapCd = GENTLE_TAP_COOLDOWN;
        this.hooks.onPitNudge?.(pushDir, 0.12);
      }
    }

    // If all active units were disabled/wrecked, immediately end pursuit cleanly
    if (operationalCount === 0 || !closestUnit) {
      this.breakOff();
      this.hooks.escaped();
      return;
    }

    // Update roadblock smoke/damage timers & shared particle VFX
    if (this.roadblock?.active) {
      for (let k = 0; k < this.roadblock.damageSims.length; k++) {
        this.roadblock.damageSims[k].step(safeDt);
        this.roadblock.damageRigs[k].updateSmoke(
          safeDt,
          this.roadblock.damageSims[k],
          this.roadblock.carRoots[k],
          this.vfx,
        );
      }
    }
    this.vfx?.update(safeDt);

    // Update realistic multi-flash LED strobes + broken/flickering headlights + dim wrecked hazard lights
    for (const u of this.units) {
      if (!u.lights) continue;
      if (!u.active) {
        updatePoliceLights(u.lights, this.t, false);
      } else if (u.wrecked) {
        this.applyWreckedLights(u.lights, this.t);
      } else {
        updatePoliceLights(u.lights, this.t, true);
        if (u.damageRig && u.damageSim.headlightsBroken) {
          const hf = u.damageRig.headlightFactor(u.damageSim);
          u.lights.wigWagL.color.multiplyScalar(hf);
          u.lights.wigWagR.color.multiplyScalar(hf);
        }
      }
    }
    if (this.roadblock) {
      for (let k = 0; k < this.roadblock.lights.length; k++) {
        const l = this.roadblock.lights[k];
        if (!this.roadblock.active) {
          updatePoliceLights(l, this.t, false);
        } else if (this.roadblock.damageSims[k].totaled) {
          this.applyWreckedLights(l, this.t);
        } else {
          updatePoliceLights(l, this.t, true);
        }
      }
    }

    // Disciplined Police Tactics & Realistic PA / Radio Pull-Over Orders (when within 35 m, every 14-18 s)
    if (!this.evading) {
      if (this.roadblock?.active) {
        this.tactic = 'ROADBLOCK AHEAD';
      } else if (minDist < 35) {
        this.tactic = closeUnitCount >= 2 ? 'BOX IN' : 'PULL OVER';
        if (this.pullOverRadioCd <= 0) {
          this.pullOverRadioCd = 14 + Math.random() * 4;
          const idx = this.pullOverOrderIdx++;
          if (closeUnitCount >= 2 && idx % 3 === 2) {
            this.hooks.onRadio?.(
              closestUnit.callsign,
              'Unit Four moving alongside to box the suspect in. Do not ram — keep it clean.',
              true,
              'boxing_in',
            );
          } else if (idx % 2 === 0) {
            this.hooks.onRadio?.(
              closestUnit.callsign,
              'Police! Pull your vehicle over to the side of the road and stop immediately!',
              true,
              'pull_over_1',
            );
          } else {
            this.hooks.onRadio?.(
              closestUnit.callsign,
              'Driver, this is the police! Slow down and pull over now!',
              true,
              'pull_over_2',
            );
          }
        }
      } else {
        this.tactic = 'PURSUIT';
      }
    }

    // Police radio reaction when player genuinely pulls away at very high speed on a straight
    if (!this.evading && minDist > 165 && kmh > 240 && this.t - this.lastPullingAwayRadio > 18) {
      this.lastPullingAwayRadio = this.t;
      this.hooks.onRadio?.(
        closestUnit.callsign,
        `Suspect is pulling away at over ${Math.round(kmh)}! Calling intercept units ahead!`,
        true,
        'high_speed',
      );
    }

    // Deploy tactical roadblock ahead during sustained pursuit (Heat >= 2 or > 10 s chase) + trigger quick GPS/Radio reroute!
    if (!this.evading && this.roadblock && !this.roadblock.active && this.roadblockCd <= 0 && kmh > 65 && (this.heat >= 2 || this.t > 10)) {
      this.deployRoadblock(playerS, playerRank, isRace);
    } else if (this.roadblock?.active) {
      const rb = this.roadblock;
      const rbGap = signedDelta(rb.s, playerS);
      rb.distM = Math.round(rbGap);
      if (!rb.rerouteAnnounced) {
        rb.rerouteTimer -= safeDt;
        if (rb.rerouteTimer <= 0) {
          rb.rerouteAnnounced = true;
          const sideWord = rb.bypassSide > 0 ? 'RIGHT' : 'LEFT';
          if (rb.phase === 'forming') {
            rb.phase = 'rerouted';
            rb.chevrons.visible = true;
            this.hooks.onStreetRadio?.(
              'GPS',
              `↪ REROUTE ACTIVE! Swing ${sideWord} onto the bypass around the police block!`,
              'street_rb_reroute',
            );
          } else {
            rb.chevrons.visible = true;
            this.hooks.onStreetRadio?.(
              'GPS',
              `↪ REROUTE LOCKED for P4+ (${sideWord} bypass) — P1–P3 thread the cruisers!`,
              'street_rb_reroute',
            );
          }
        }
      }
      if (rbGap < -35) {
        const wasPunch = rb.phase === 'punch';
        this.hideRoadblock();
        this.roadblockCd = 20.0;
        this.tactic = this.evading ? 'EVADING' : 'PURSUIT';
        this.hooks.onAlert?.(wasPunch ? '✓ PUNCHED THROUGH ROADBLOCK!' : '✓ ROADBLOCK BYPASSED');
        this.hooks.onRadio?.(closestUnit.callsign, 'Suspect cleared the roadblock, continuing pursuit!', false, 'roadblock_cleared');
        this.hooks.onStreetRadio?.(
          'GPS',
          wasPunch ? '🔥 Front pack punched through the block! Back on main route.' : '✓ Bypass complete — back on main race route!',
          'street_rb_cleared',
        );
      }
    }

    // Track closest operational unit for LOS raycast, HUD distance, and acoustic Doppler stereo siren
    this.s = closestUnit.s;
    this.speed = closestUnit.speed;
    this.world.copy(closestUnit.world);
    this.minDist = Number.isFinite(minDist) ? minDist : 999;
    this.placeUnits(playerPos);

    // Compute acoustic Doppler ratio & stereo pan for closest operational unit
    const dx = closestUnit.world.x - playerPos.x;
    const dz = closestUnit.world.z - playerPos.z;
    const distSafe = Math.max(0.5, Math.hypot(dx, dz));
    const dirX = dx / distSafe;
    const dirZ = dz / distSafe;
    const vRel = (closestUnit.velX - pVelX) * dirX + (closestUnit.velZ - pVelZ) * dirZ;
    const rawDoppler = THREE.MathUtils.clamp(SOUND_SPEED / Math.max(120, SOUND_SPEED + vRel), 0.86, 1.16);
    this.smoothDoppler += (rawDoppler - this.smoothDoppler) * Math.min(1, safeDt * 8);

    let rightX: number;
    let rightZ: number;
    if (playerHeadingRad !== undefined && Number.isFinite(playerHeadingRad)) {
      const fwdX = Math.sin(playerHeadingRad);
      const fwdZ = Math.cos(playerHeadingRad);
      rightX = -fwdZ;
      rightZ = fwdX;
    } else {
      rightX = pRight.x;
      rightZ = pRight.z;
    }
    const rawPan = THREE.MathUtils.clamp(dirX * rightX + dirZ * rightZ, -1, 1);
    this.smoothPan += (rawPan - this.smoothPan) * Math.min(1, safeDt * 10);

    const prox = Math.max(0, Math.min(1, 1 - this.minDist / 260));
    this.sirenSnapshot.proximity = prox;
    this.sirenSnapshot.dopplerRatio = this.smoothDoppler;
    this.sirenSnapshot.pan = this.smoothPan;
    this.sirenSnapshot.aggressive =
      this.minDist < 38 ||
      this.tactic === 'PULL OVER' ||
      this.tactic === 'BOX IN' ||
      !!this.roadblock?.active;
    this.sirenSnapshot.hornPulse = this.hornPulse;

    // Bust meter: busted when pulled over / stopped (< 15 km/h within 9.5 m for 4.2 s)
    if (this.minDist < BUST_GAP && kmh < BUST_SLOW) {
      this.slow += safeDt;
    } else {
      this.slow = Math.max(0, this.slow - safeDt * 1.4);
    }
    if (this.slow >= BUST_HOLD) {
      this.hooks.onRadio?.(closestUnit.callsign, 'Suspect vehicle boxed in and stopped. Driver in custody, 10-15.', true, 'busted');
      this.breakOff();
      this.hooks.bust();
      return;
    }

    // Escape: hold > 275 m clear continuously for 3.8 s to enter EVADING
    if (this.minDist > ESCAPE_GAP) {
      this.far += safeDt;
      if (!this.evading && this.far >= ESCAPE_HOLD_FAR) {
        this.enterEvading('Suspect pulled out of visual range, switching to high-speed search pattern.', 'evading_gap');
      }
    } else {
      this.far = 0;
      if (this.evading && this.minDist < EVADE_REACQUIRE) {
        this.evading = false;
        this.evadeTimer = 0;
        this.blind = 0;
        this.tactic = 'PURSUIT';
        this.triggerHorn();
        this.hooks.onAlert?.('🚨 VISUAL RE-ACQUIRED · BACK IN PURSUIT!');
        this.hooks.onRadio?.(closestUnit.callsign, 'Visual re-acquired! Closing in, back in pursuit!', true, 'reacquired');
      }
    }

    if (this.evading) {
      this.evadeTimer += safeDt;
      if (this.evadeTimer >= EVADE_HOLD) {
        this.hooks.onRadio?.('DISPATCH', '10-22, cancel pursuit. Suspect evaded — all units return to patrol.', true, 'escaped');
        this.breakOff();
        this.hooks.escaped();
        return;
      }
    } else if (this.t > GIVE_UP && this.minDist > 130) {
      this.hooks.onRadio?.('DISPATCH', 'Pursuit terminated for public safety. All units stand down.', true, 'escaped');
      this.breakOff();
      this.hooks.escaped();
    }
  }

  private enterEvading(radioLine: string, clipId: string) {
    if (this.evading) return;
    this.evading = true;
    this.evadeTimer = 0;
    this.tactic = 'EVADING';
    this.hooks.onAlert?.('💨 EVADING PURSUIT · STAY CLEAR FOR 14s');
    this.hooks.onRadio?.('UNIT-04', radioLine, true, clipId);
  }

  /** Line-of-sight escape: losing sight behind city buildings for 6.5 s triggers EVADING cooldown. */
  see(blocked: boolean, dt: number) {
    if (!this.active) return;
    this.blind = blocked ? this.blind + dt : 0;
    if (this.blind >= LOS_HOLD && !this.evading) {
      this.enterEvading('Lost visual behind downtown blocks, widening search grid.', 'evading_los');
    }
  }

  /** Rich siren telemetry for spatial Doppler siren & airhorn audio. */
  get sirenState(): SirenState {
    return this.sirenSnapshot;
  }

  /** Backwards-compatible siren proximity (0..1 within 260 m). */
  get proximity() { return this.active ? Math.max(0, 1 - this.minDist / 260) : 0; }
  /** Backwards-compatible distance (m) to closest pursuing unit. */
  get distance() { return this.minDist; }

  private placeUnit(u: PatrolUnit, teleport = false) {
    if (!u.active) {
      if (u.root) u.root.visible = false;
      if (u.body) {
        u.body.setTranslation({ x: 0, y: -600, z: 0 }, true);
        u.body.setEnabled(false);
      }
      return;
    }
    this.lane.at(u.s, u.lat, u.world);
    if (teleport) u.prevWorld.copy(u.world);
    const i = this.lane.idx(u.s);
    const r = this.lane.right[i];
    const roadYaw = Math.atan2(r.z, -r.x);
    const yaw = roadYaw - u.steerLean - u.yawOff;
    u.yaw = yaw;
    if (u.root) {
      u.root.position.set(u.world.x, u.world.y + 0.02, u.world.z);
      u.root.rotation.y = yaw;
      u.root.visible = true;
    }
    if (u.body) {
      this.tmpQuat.setFromAxisAngle(this.upAxis, yaw);
      u.body.setEnabled(true);
      const pos = { x: u.world.x, y: u.world.y, z: u.world.z };
      const rot = { x: this.tmpQuat.x, y: this.tmpQuat.y, z: this.tmpQuat.z, w: this.tmpQuat.w };
      if (teleport) {
        u.body.setTranslation(pos, true);
        u.body.setRotation(rot, true);
      } else {
        u.body.setNextKinematicTranslation(pos);
        u.body.setNextKinematicRotation(rot);
      }
    }
  }

  private placeUnits(_playerPos: THREE.Vector3, teleport = false) {
    for (const u of this.units) {
      this.placeUnit(u, teleport);
    }
  }
}
