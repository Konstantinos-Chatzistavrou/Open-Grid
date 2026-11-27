// Relentless Tactical Police Interceptor Pursuit AI (OpenGrid).
//
// Features:
//   1. Roadside GATSO speed cameras (fast 1.2 s dispatch) PLUS proactive patrol high-speed sightings
//      so speeding in Night Street / Free Roam gets Police Interceptors on your tail immediately.
//   2. 4-Unit Black & White Interceptor Squad (built via policeCar.ts with real flashing red/blue lights):
//      - Unit 04 (PIT): spawns 48 m behind at matching speed — fills your rear-view mirror instantly!
//      - Unit 07 (INTERCEPT): spawns 155 m AHEAD even at Heat 1+ so you face live cruisers pulling out ahead!
//      - Unit 11 (FLANK): joins at Heat 2+ from 65 m behind on opposite side to box you in!
//      - Unit 15 (ENFORCER): joins at Heat 3+ as a high-speed heavy interceptor!
//      - Non-lead units that fall > 340 m behind dynamically leapfrog 240 m AHEAD as fresh intercept patrols.
//   3. High-performance twin-turbo interceptor tuning (245-325 km/h by Heat) + aggressive box-in & PIT maneuvers.
//   4. Challenging escape mechanics (275 m gap for 3.8 s, 6.5 s LOS break, 14.0 s EVADING cooldown with
//      92% hunt speed and immediate < 175 m re-acquisition) + Doppler stereo siren telemetry.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Lane } from './ai';
import { GROUP_CAR, type PhysicsWorld } from './physics/world';
import {
  buildPoliceInterceptor,
  updatePoliceLights,
  type PoliceLightRig,
} from './scene/policeCar';

const ESCAPE_GAP = 275;        // m of clear road required before entering EVADING cooldown
const ESCAPE_HOLD_FAR = 3.8;   // s continuously > 275 m before entering EVADING
const EVADE_HOLD = 14.0;       // s in EVADING cooldown to completely shake the squad
const EVADE_REACQUIRE = 175;   // m within which any unit immediately re-engages during EVADING
const BUST_GAP = 9.5;          // m proximity required to pin & bust
const BUST_SLOW = 15;          // km/h under which a pinned car counts toward busted
const BUST_HOLD = 4.2;         // s pinned before busted
const GIVE_UP = 240;           // s max chase if player stays fast and un-busted
const LOS_HOLD = 6.5;          // s out of sight behind buildings to enter EVADING cooldown
const PIT_COOLDOWN = 6.5;      // s between PIT attempts
const ROADBLOCK_AHEAD = 260;   // m ahead of player along route
const CAM_SPACING_M = 460;     // m between roadside speed cameras
const CAM_OVER_MARGIN = 15;    // km/h grace margin above posted limit before camera flashes
const CAM_COOLDOWN_S = 22;     // s cooldown per camera so it won't spam while parked
const DISPATCH_DELAY_S = 1.2;  // s brisk radio dispatch delay after camera flash
const LEAPFROG_BEHIND = 340;   // m behind before a non-lead unit redeploys ahead as fresh intercept
const LEAPFROG_AHEAD = 240;    // m ahead to redeploy intercept unit
const SOUND_SPEED = 340;       // m/s for acoustic Doppler calculation

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
  /** Player broke away from the pursuit squad. */
  escaped(): void;
  /** Tactical PIT maneuver engaged on the player's rear quarter (latSign = +1 right / -1 left, intensity 0..1). */
  onPitNudge?(latSign: number, intensity: number): void;
  /** Tactical alert for HUD banner. */
  onAlert?(msg: string): void;
  /** Roadside speed camera caught the player speeding! */
  onCameraFlash?(cam: SpeedCamera, speedKmh: number, overKmh: number): void;
  /** Police dispatch / patrol unit scanner radio transmission. */
  onRadio?(unit: string, text: string, speak?: boolean, clipId?: string): void;
  /** Street radio / GPS reroute announcement on the racers' underground channel (146.52 MHz). */
  onStreetRadio?(callsign: string, text: string, clipId?: string): void;
}

type UnitRole = 'pit' | 'intercept' | 'flank' | 'enforcer';

interface PatrolUnit {
  unitNumber: string;
  callsign: string;
  s: number;
  lat: number;
  speed: number;
  side: 1 | -1;
  role: UnitRole;
  world: THREE.Vector3;
  prevWorld: THREE.Vector3;
  velX: number;
  velZ: number;
  yaw: number;
  root: THREE.Object3D | null;
  lights: PoliceLightRig | null;
  body: RAPIER.RigidBody | null;
  active: boolean;
}

interface Roadblock {
  active: boolean;
  s: number;
  world: THREE.Vector3;
  group: THREE.Group;
  bodies: RAPIER.RigidBody[];
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
  tactic: 'PURSUIT' | 'PIT MANEUVER' | 'ROADBLOCK AHEAD' | 'EVADING' | 'DISPATCHED' = 'PURSUIT';
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

  private minDist = 999;
  private far = 0;
  private slow = 0;
  private evadeTimer = 0;
  private evading = false;
  private t = 0;
  private blind = 0;
  private pitCd = 4.5;
  private pitWarned = false;
  private roadblockCd = 15.0;
  private dispatchDelay = 0;
  private dispatchHeat = 1;
  private recklessTimer = 0;
  private lastPlayerSpeedMs = 36;
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

  constructor(private lane: Lane, private hooks: CopHooks) {
    this.units = [
      {
        unitNumber: '04', callsign: 'UNIT-04', s: 0, lat: 1.2, speed: 0, side: 1, role: 'pit',
        world: new THREE.Vector3(), prevWorld: new THREE.Vector3(), velX: 0, velZ: 0, yaw: 0,
        root: null, lights: null, body: null, active: false,
      },
      {
        unitNumber: '07', callsign: 'UNIT-07', s: 0, lat: -1.6, speed: 0, side: -1, role: 'intercept',
        world: new THREE.Vector3(), prevWorld: new THREE.Vector3(), velX: 0, velZ: 0, yaw: 0,
        root: null, lights: null, body: null, active: false,
      },
      {
        unitNumber: '11', callsign: 'UNIT-11', s: 0, lat: -2.0, speed: 0, side: -1, role: 'flank',
        world: new THREE.Vector3(), prevWorld: new THREE.Vector3(), velX: 0, velZ: 0, yaw: 0,
        root: null, lights: null, body: null, active: false,
      },
      {
        unitNumber: '15', callsign: 'UNIT-15', s: 0, lat: 2.0, speed: 0, side: 1, role: 'enforcer',
        world: new THREE.Vector3(), prevWorld: new THREE.Vector3(), velX: 0, velZ: 0, yaw: 0,
        root: null, lights: null, body: null, active: false,
      },
    ];
    this.buildCameraData();
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
    this.s = 0;
    this.buildCameraData();
    this.buildCameraMeshes();
  }

  /** Build 4 Black & White Police Interceptors + 2 Roadblock Interceptors with flashing lights & Rapier colliders. */
  setupVisuals(proto: THREE.Object3D, scene: THREE.Scene, pw: PhysicsWorld) {
    this.proto = proto;
    this.scene = scene;
    this.pw = pw;
    this.buildCameraMeshes();

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
      if (!u.body) {
        const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0));
        pw.world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.98, 0.48, 2.3).setTranslation(0, 0.62, 0).setFriction(0.35).setRestitution(0.05).setCollisionGroups(GROUP_CAR),
          body,
        );
        body.setEnabled(false);
        u.body = body;
      }
      if (i === 0) this.root = built.root;
    }

    // Build reusable tactical roadblock (2 angled Police Interceptors + cones + bypass chevrons + Rapier colliders)
    if (this.roadblock) {
      this.roadblock.group.removeFromParent();
    }
    const rbGroup = new THREE.Group();
    rbGroup.name = 'cop_roadblock';
    rbGroup.visible = false;
    const rbLights: PoliceLightRig[] = [];
    const rbBodies: RAPIER.RigidBody[] = [];

    const coneGeo = new THREE.ConeGeometry(0.24, 0.72, 6);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xff5a1f });

    // Wide 4.6 m skill gap so attentive drivers can thread through cleanly
    const layouts = [
      { x: -4.1, z: 0, yaw: Math.PI * 0.42, num: '21' },
      { x: 4.1, z: 0.4, yaw: -Math.PI * 0.42, num: '22' },
    ];
    for (const lay of layouts) {
      const built = buildPoliceInterceptor(proto, lay.num, true);
      built.root.position.set(lay.x, 0.02, lay.z);
      built.root.rotation.y = lay.yaw;
      updatePoliceLights(built.lights, 0, false);
      rbLights.push(built.lights);
      rbGroup.add(built.root);

      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0));
      pw.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.98, 0.55, 2.3).setTranslation(0, 0.65, 0).setFriction(0.4).setRestitution(0.08).setCollisionGroups(GROUP_CAR),
        body,
      );
      body.setEnabled(false);
      rbBodies.push(body);
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
      active: false, s: 0, world: new THREE.Vector3(), group: rbGroup, bodies: rbBodies, lights: rbLights,
      announced: false, bypassSide: 1, phase: 'forming', rerouteTimer: 0, rerouteAnnounced: false, distM: 0,
      detourPts: [], chevrons,
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

    // Proactive patrol sighting: speeding > 140 km/h for 4.5 s (or 2.0 s at Heat 2+) brings a live patrol right onto you!
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

      // Trigger speed camera when passing within 15 m over limit + grace margin
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
    const pSpd = Math.max(36, this.lastPlayerSpeedMs);
    const u2 = this.units[2];
    if (this.heat >= 2 && !u2.active) {
      u2.active = true;
      u2.s = this.lane.wrap(playerS - 65);
      u2.lat = -2.0;
      u2.speed = Math.max(36, pSpd * 1.04);
      this.placeUnit(u2, true);
    }
    const u3 = this.units[3];
    if (this.heat >= 3 && !u3.active) {
      u3.active = true;
      u3.s = this.lane.wrap(playerS + 190);
      u3.lat = 1.8;
      u3.speed = Math.max(22, pSpd * 0.55);
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
    this.pitCd = 4.5;
    this.pitWarned = false;
    this.roadblockCd = this.heat >= 2 ? 9.0 : 14.0;
    this.lastPullingAwayRadio = 0;
    this.lastInterceptRadio = -10;
    this.hornPulse = 0.85;
    this.hornCd = 4.0;
    this.hasPrevPlayer = false;
    this.tactic = 'PURSUIT';

    const pSpd = Math.max(34, this.lastPlayerSpeedMs);

    // Unit 0 (PIT, Unit-04): 48 m behind at matching/closing speed — immediately visible in mirrors!
    const u0 = this.units[0];
    u0.active = true;
    u0.s = this.lane.wrap(playerS - 48);
    u0.lat = 1.2;
    u0.speed = Math.max(36, pSpd * 1.05);

    // Unit 1 (INTERCEPT, Unit-07): Active even at Heat 1+! Spawns 155 m AHEAD rolling onto the route!
    const u1 = this.units[1];
    u1.active = true;
    u1.s = this.lane.wrap(playerS + 155);
    u1.lat = -1.6;
    u1.speed = Math.max(18, pSpd * 0.45);

    // Unit 2 (FLANK, Unit-11): Joins at Heat 2+ from 65 m behind on opposite side
    const u2 = this.units[2];
    u2.active = this.heat >= 2;
    u2.s = this.lane.wrap(playerS - 65);
    u2.lat = -2.1;
    u2.speed = Math.max(36, pSpd * 1.04);

    // Unit 3 (ENFORCER, Unit-15): Joins at Heat 3+ (high-speed interceptor closing from 110 m behind or 190 m ahead)
    const u3 = this.units[3];
    u3.active = this.heat >= 3;
    u3.s = this.lane.wrap(this.heat >= 4 ? playerS + 190 : playerS - 110);
    u3.lat = 2.0;
    u3.speed = this.heat >= 4 ? Math.max(22, pSpd * 0.5) : Math.max(40, pSpd * 1.08);

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
    for (const u of this.units) {
      u.active = false;
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
    const layouts = [
      { x: -4.1, z: 0, yaw: Math.PI * 0.42 },
      { x: 4.1, z: 0.4, yaw: -Math.PI * 0.42 },
    ];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < layouts.length; k++) {
      const l = layouts[k];
      const wx = rb.world.x + l.x * cosY + l.z * sinY;
      const wz = rb.world.z - l.x * sinY + l.z * cosY;
      q.setFromAxisAngle(up, roadYaw + l.yaw);
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

  /** All active patrol unit positions (for minimap blips). */
  unitPositions(): THREE.Vector3[] {
    return this.units.filter((u) => u.active).map((u) => u.world);
  }

  /** All speed camera world positions (for minimap radar blips). */
  cameraPositions(): { x: number; z: number; limitKmh: number }[] {
    return this.cameras.map((c) => ({ x: c.world.x, z: c.world.z, limitKmh: c.limitKmh }));
  }

  private triggerHorn() {
    if (this.hornCd > 0) return;
    this.hornPulse = 1.0;
    this.hornCd = 5.5;
  }

  /** dt seconds, player's arc length, world position, speed (km/h), race position (1-based), in-race flag, optional player heading (rad). */
  update(
    dt: number,
    playerS: number,
    playerPos: THREE.Vector3,
    kmh: number,
    playerRank = 1,
    isRace = true,
    playerHeadingRad?: number,
  ) {
    if (!this.active) {
      this.sirenSnapshot.proximity = this.dispatchDelay > 0 ? 0.2 : 0;
      this.sirenSnapshot.dopplerRatio = 1.0;
      this.sirenSnapshot.pan = 0;
      this.sirenSnapshot.aggressive = false;
      this.sirenSnapshot.hornPulse = 0;
      return;
    }

    const safeDt = Math.max(1e-4, Math.min(0.1, dt));
    this.t += safeDt;
    this.pitCd = Math.max(0, this.pitCd - safeDt);
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

    // High-performance twin-turbo Interceptor tuning (genuinely hard to shake!)
    // Heat 1: 245 km/h | Heat 2: 265 km/h | Heat 3: 285 km/h | Heat 4: 305 km/h | Heat 5: 325 km/h
    const topSpeed = (245 + (this.heat - 1) * 20) / 3.6;
    const maxAccel = 9.2 + this.heat * 0.75; // twin-turbo interceptor acceleration (m/s²)
    const maxBrake = 12.5;                   // heavy-duty pursuit brakes (m/s²)
    const cornerMu = 1.18 + this.heat * 0.03;

    let minDist = Infinity;
    let closestUnit: PatrolUnit = this.units[0];

    for (let uIdx = 0; uIdx < this.units.length; uIdx++) {
      const u = this.units[uIdx];
      if (!u.active) continue;

      let gapAhead = signedDelta(playerS, u.s); // positive = player ahead of cop; negative = cop ahead of player

      // Dynamic leapfrog intercept: if a non-lead unit falls > 340 m behind while NOT evading,
      // redeploy it as a fresh intercept unit 240 m AHEAD so the player constantly faces live police!
      if (!this.evading && uIdx > 0 && gapAhead > LEAPFROG_BEHIND) {
        u.s = this.lane.wrap(playerS + LEAPFROG_AHEAD);
        const aheadRoom = this.lane.room(u.s);
        u.lat = Math.max(-aheadRoom.left, Math.min(aheadRoom.right, playerLat + u.side * 1.4));
        u.speed = Math.max(20, Math.min(topSpeed * 0.6, playerSpeedMs * 0.55));
        this.placeUnit(u, true);
        gapAhead = signedDelta(playerS, u.s);
        if (this.t - this.lastInterceptRadio > 16) {
          this.lastInterceptRadio = this.t;
          this.hooks.onRadio?.(
            u.callsign,
            `Unit ${u.unitNumber} pulling onto the avenue ahead — moving to intercept and box in the suspect!`,
            true,
            'intercept_ahead',
          );
        }
      }

      const room = this.lane.room(u.s);

      // Planted interceptor corner grip limit
      const ci = this.lane.idx(u.s);
      const nPts = this.lane.n;
      const rA = this.lane.right[(ci - 2 + nPts) % nPts];
      const rB = this.lane.right[(ci + 2) % nPts];
      const dAng = Math.acos(Math.max(-1, Math.min(1, rA.x * rB.x + rA.z * rB.z)));
      const curv = dAng / 16;
      const cornerLimit = curv > 0.006 ? Math.sqrt((cornerMu * 9.81) / curv) : topSpeed;

      // Role-based tactical offset along track (box-in formation: PIT rear quarter, intercept/flank pull ahead/beside!)
      const wantOffsetS =
        u.role === 'pit'
          ? -3.2
          : u.role === 'intercept'
          ? 3.6
          : u.role === 'flank'
          ? 1.4
          : -1.6;
      const d = signedDelta(playerS + wantOffsetS, u.s);

      let targetSpeed: number;
      if (this.evading) {
        // Units keep hunting hard at 92% speed during EVADING!
        targetSpeed = Math.min(topSpeed * 0.92, cornerLimit);
      } else if (gapAhead < -18) {
        // Unit is AHEAD of the player: roll at a visible tactical intercept/blocking pace so the player
        // closes right up onto flashing police lights and must thread/dodge past!
        const aheadDist = -gapAhead;
        const holdFactor = aheadDist > 80 ? 0.42 : 0.68;
        targetSpeed = Math.min(topSpeed * 0.72, Math.max(15, playerSpeedMs * holdFactor));
      } else if (d > 6) {
        // Behind the player: floor it to close the gap fast!
        targetSpeed = topSpeed;
      } else if (d > -8) {
        // Alongside / box-in window: match aggressively with slight closing authority
        targetSpeed = Math.min(topSpeed, Math.max(0, playerSpeedMs + d * 0.85 + 2.2));
      } else {
        // Slightly ahead during box-in: brake/pace tightly to pin the player's nose!
        targetSpeed = Math.max(0, playerSpeedMs - 3.5);
      }
      targetSpeed = Math.min(targetSpeed, cornerLimit);

      // Mild high-speed aerodynamic drag falloff (0.35 instead of 0.65)
      const speedFrac = Math.min(0.96, u.speed / Math.max(1, topSpeed));
      const availAccel = maxAccel * (1 - 0.35 * speedFrac * speedFrac);
      const dv = targetSpeed - u.speed;
      if (dv > 0) u.speed += Math.min(dv, availAccel * safeDt);
      else u.speed += Math.max(dv, -maxBrake * safeDt);
      u.speed = Math.max(0, Math.min(topSpeed, u.speed));
      u.s = this.lane.wrap(u.s + u.speed * safeDt);

      // Aggressive lateral positioning: intercept ahead moves into player's lane; flanker boxes opposite side; PIT hunts rear quarter
      let latBias: number;
      if (gapAhead < -15 && gapAhead > -180) {
        // Intercepting from ahead: move toward player's lane to force evasive action
        latBias = u.side * 0.7;
      } else if (u.role === 'pit') {
        latBias = playerLat > 0 ? -2.0 : 2.0;
      } else if (u.role === 'flank' || u.role === 'intercept') {
        // Box-in from opposite side of PIT unit (and pull in tighter when player slows down!)
        const squeeze = kmh < 50 ? 1.45 : 2.15;
        latBias = playerLat > 0 ? squeeze : -squeeze;
      } else {
        // Enforcer rides tight on rear bumper / opposite quarter
        latBias = u.side * 1.4;
      }

      const engagedPit =
        !this.evading &&
        (u.role === 'pit' || u.role === 'enforcer') &&
        Math.abs(gapAhead - 2.0) < 2.6 &&
        this.pitCd <= 0 &&
        kmh > 50;

      const understeerPush = u.speed > cornerLimit * 1.03 ? (u.speed - cornerLimit) * 0.35 : 0;
      const wantLat = Math.max(
        -room.left,
        Math.min(room.right, playerLat + (engagedPit ? latBias * 0.4 : latBias) + understeerPush * u.side),
      );
      u.lat += (wantLat - u.lat) * Math.min(1, safeDt * (engagedPit ? 4.8 : 2.9));

      u.prevWorld.copy(u.world);
      this.lane.at(u.s, u.lat, u.world);
      u.velX = (u.world.x - u.prevWorld.x) / safeDt;
      u.velZ = (u.world.z - u.prevWorld.z) / safeDt;

      const dist3 = Math.hypot(u.world.x - playerPos.x, u.world.z - playerPos.z);
      if (dist3 < minDist) {
        minDist = dist3;
        closestUnit = u;
      }

      // Close-range airhorn burst when closing aggressively < 22 m
      if (!this.evading && dist3 < 22 && u.speed > playerSpeedMs + 3) {
        this.triggerHorn();
      }

      // Tactical PIT maneuver when PIT or Enforcer unit earns rear-quarter overlap
      if (
        !this.evading &&
        (u.role === 'pit' || u.role === 'enforcer') &&
        Math.abs(gapAhead - 2.0) < 3.4 &&
        Math.abs(u.lat - playerLat) < 2.8 &&
        kmh > 50
      ) {
        if (!this.pitWarned && this.pitCd < 1.4) {
          this.pitWarned = true;
          this.tactic = 'PIT MANEUVER';
          this.triggerHorn();
          this.hooks.onAlert?.('⚠ INTERCEPTOR ALIGNING FOR PIT');
          this.hooks.onRadio?.(u.callsign, 'I have the rear quarter, moving in for PIT maneuver!', false, 'pit_request');
        }
        if (this.pitCd <= 0 && dist3 < 4.2) {
          const pushDir = u.lat < playerLat ? 1 : -1;
          this.pitCd = PIT_COOLDOWN;
          this.pitWarned = false;
          this.triggerHorn();
          this.hooks.onPitNudge?.(pushDir, 0.50 + this.heat * 0.06);
          this.hooks.onAlert?.('🚨 PIT CONTACT · COUNTER-STEER!');
          this.hooks.onRadio?.(u.callsign, 'PIT contact! Suspect fishtailing — box them in!', false, 'pit_contact');
        }
      }
    }

    // Update realistic multi-flash LED strobes + dynamic PointLights on all pursuit units and active roadblock
    for (const u of this.units) {
      if (u.lights) updatePoliceLights(u.lights, this.t, u.active);
    }
    if (this.roadblock) {
      for (const l of this.roadblock.lights) updatePoliceLights(l, this.t, this.roadblock.active);
    }

    // Police radio reaction when player genuinely pulls away at very high speed
    if (!this.evading && minDist > 165 && kmh > 250 && this.t - this.lastPullingAwayRadio > 18) {
      this.lastPullingAwayRadio = this.t;
      this.hooks.onRadio?.(
        'UNIT-04',
        `Suspect is flying at over ${Math.round(kmh)}! Calling intercept units ahead to cut them off!`,
        true,
        'high_speed',
      );
    }

    // Deploy roadblock ahead during sustained pursuit (Heat >= 2 or > 10 s chase) + trigger quick GPS/Radio reroute!
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
        this.hooks.onRadio?.('UNIT-04', 'Suspect cleared the roadblock, continuing pursuit!', false, 'roadblock_cleared');
        this.hooks.onStreetRadio?.(
          'GPS',
          wasPunch ? '🔥 Front pack punched through the block! Back on main route.' : '✓ Bypass complete — back on main race route!',
          'street_rb_cleared',
        );
      }
    }

    // Track closest active unit for LOS raycast, HUD distance, and acoustic Doppler stereo siren
    this.s = closestUnit.s;
    this.speed = closestUnit.speed;
    this.world.copy(closestUnit.world);
    this.minDist = Number.isFinite(minDist) ? minDist : 999;
    this.placeUnits(playerPos);

    // Compute acoustic Doppler ratio & stereo pan for closest active unit
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
    this.sirenSnapshot.aggressive = this.minDist < 42 || this.tactic === 'PIT MANEUVER' || !!this.roadblock?.active;
    this.sirenSnapshot.hornPulse = this.hornPulse;

    // Bust meter: dangerous when boxed in (< 15 km/h within 9.5 m for 4.2 s)
    if (this.minDist < BUST_GAP && kmh < BUST_SLOW) {
      this.slow += safeDt;
    } else {
      this.slow = Math.max(0, this.slow - safeDt * 1.4);
    }
    if (this.slow >= BUST_HOLD) {
      this.hooks.onRadio?.('UNIT-04', 'Suspect vehicle pinned and immobilized. Driver in custody, 10-15.', true, 'busted');
      this.breakOff();
      this.hooks.bust();
      return;
    }

    // Harder escape: must hold > 275 m clear continuously for 3.8 s to enter EVADING
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
    const yaw = Math.atan2(r.z, -r.x);
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
