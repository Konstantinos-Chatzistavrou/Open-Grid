// Realistic Speed-Camera Triggered Tactical Physics Police AI (OpenGrid).
//
// How pursuits work realistically:
//   1. Speed Cameras (GATSO roadside radar traps) line the city's streets with posted speed limits
//      (60 / 80 / 100 km/h based on road curvature). Cops stay in standby until a camera catches you
//      speeding (> limit + 15 km/h) — never spawning out of thin air at the start line!
//   2. When a camera flashes you, Police Dispatch broadcasts over CH-04 Scanner Radio and dispatches
//      units (~4 s realistic response delay, arriving ~115 m behind rather than on your rear bumper).
//   3. Zero arcade rubber-banding: cruisers obey realistic acceleration (~6.2 m/s²), aerodynamic drag,
//      speed caps (195-244 km/h by Heat), and corner grip (mu = 0.86) so skilled cornering or a fast
//      supercar on a straight genuinely pulls away!
//   4. Fair bust mechanics (must be nearly pinned < 12 km/h within 8 m for 5.0 s with a live bust meter)
//      and realistic EVADING / COOLDOWN phase when you pull > 165 m clear or break line-of-sight.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Lane } from './ai';
import { GROUP_CAR, type PhysicsWorld } from './physics/world';

const ESCAPE_GAP = 165;        // m of clear road to enter EVADING cooldown
const EVADE_HOLD = 6.5;        // s in EVADING cooldown to completely shake the squad
const BUST_GAP = 8.0;          // m proximity required to pin & bust
const BUST_SLOW = 12;          // km/h under which a pinned car counts toward busted
const BUST_HOLD = 5.0;         // s pinned before busted (fair chance to reverse / escape!)
const GIVE_UP = 95;            // s max chase if player stays fast and un-busted
const LOS_HOLD = 2.8;          // s out of sight behind buildings to enter EVADING cooldown
const PIT_COOLDOWN = 9.0;      // s between PIT attempts (realistic, not spammed)
const ROADBLOCK_AHEAD = 260;   // m ahead of player along route
const CAM_SPACING_M = 460;     // m between roadside speed cameras
const CAM_OVER_MARGIN = 15;    // km/h grace margin above posted limit before camera flashes
const CAM_COOLDOWN_S = 22;     // s cooldown per camera so it won't spam while parked

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
  onRadio?(unit: string, text: string, speak?: boolean): void;
  /** Street radio / GPS reroute announcement on the racers' underground channel (146.52 MHz). */
  onStreetRadio?(callsign: string, text: string): void;
}

interface PatrolUnit {
  s: number;
  lat: number;
  speed: number;
  side: 1 | -1;
  role: 'pit' | 'flank';
  world: THREE.Vector3;
  root: THREE.Object3D | null;
  lights: { r: THREE.MeshBasicMaterial; b: THREE.MeshBasicMaterial } | null;
  body: RAPIER.RigidBody | null;
  active: boolean;
}

interface Roadblock {
  active: boolean;
  s: number;
  world: THREE.Vector3;
  group: THREE.Group;
  bodies: RAPIER.RigidBody[];
  lights: { r: THREE.MeshBasicMaterial; b: THREE.MeshBasicMaterial }[];
  announced: boolean;
  bypassSide: -1 | 1;
  phase: 'forming' | 'punch' | 'rerouted';
  rerouteTimer: number;
  rerouteAnnounced: boolean;
  distM: number;
  detourPts: { x: number; y: number }[];
  chevrons: THREE.Group;
}

function attachLightbar(root: THREE.Object3D): { r: THREE.MeshBasicMaterial; b: THREE.MeshBasicMaterial } {
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.08, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x111218 }),
  );
  bar.position.set(0, 1.38, -0.08);
  const rl = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.11, 0.2),
    new THREE.MeshBasicMaterial({ color: 0xff2d55 }),
  );
  rl.position.set(-0.24, 1.4, -0.08);
  const bl = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.11, 0.2),
    new THREE.MeshBasicMaterial({ color: 0x2a9dff }),
  );
  bl.position.set(0.24, 1.4, -0.08);
  root.add(bar, rl, bl);
  return {
    r: rl.material as THREE.MeshBasicMaterial,
    b: bl.material as THREE.MeshBasicMaterial,
  };
}

export class Cops {
  active = false;
  heat = 1;
  /** Lead unit arc length (backwards-compatible telemetry). */
  s = 0;
  speed = 0;
  /** Lead unit world position (used for LOS and audio). */
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

  private gap = 0;
  private far = 0;
  private slow = 0;
  private evadeTimer = 0;
  private evading = false;
  private t = 0;
  private blind = 0;
  private pitCd = 6.0;
  private pitWarned = false;
  private roadblockCd = 18.0;
  private flashPhase = false;
  private flashAcc = 0;
  private dispatchDelay = 0;
  private dispatchHeat = 1;
  private lastPullingAwayRadio = 0;
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private upAxis = new THREE.Vector3(0, 1, 0);

  constructor(private lane: Lane, private hooks: CopHooks) {
    this.units = [
      { s: 0, lat: 0.7, speed: 0, side: 1, role: 'pit', world: this.world, root: null, lights: null, body: null, active: false },
      { s: 0, lat: -1.8, speed: 0, side: -1, role: 'flank', world: new THREE.Vector3(), root: null, lights: null, body: null, active: false },
    ];
    this.buildCameraData();
  }

  /** Whether dispatch has been alerted by a speed camera and cruisers are inbound. */
  get dispatched() { return this.dispatchDelay > 0; }
  /** 0..1 progress toward getting busted (only rises when pinned < 12 km/h within 8 m). */
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
      // Offset first camera ~240 m down-street so the start line isn't immediately flashed
      const s = this.lane.wrap(240 + k * step);
      const ci = this.lane.idx(s);
      const rA = this.lane.right[(ci - 3 + nPts) % nPts];
      const rB = this.lane.right[(ci + 3) % nPts];
      const dAng = Math.acos(Math.max(-1, Math.min(1, rA.x * rB.x + rA.z * rB.z)));
      const curv = dAng / 24;
      // Realistic speed limits: 60 km/h technical downtown, 80 km/h avenues, 100 km/h express straights
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

  /** Provide the unmarked cruiser template, scene, and Rapier world for multi-unit pursuits + physical roadblocks. */
  setupVisuals(proto: THREE.Object3D, scene: THREE.Scene, pw: PhysicsWorld) {
    this.proto = proto;
    this.scene = scene;
    this.pw = pw;
    this.buildCameraMeshes();

    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const model = i === 0 ? proto : proto.clone(true);
      const wrap = new THREE.Group();
      wrap.name = `cop_unit_${i}`;
      wrap.add(model);
      const lights = attachLightbar(wrap);
      wrap.visible = false;
      scene.add(wrap);
      u.root = wrap;
      u.lights = lights;
      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0));
      pw.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.95, 0.425, 2.1).setTranslation(0, 0.575, 0).setFriction(0.35).setRestitution(0.05).setCollisionGroups(GROUP_CAR),
        body,
      );
      body.setEnabled(false);
      u.body = body;
      if (i === 0) this.root = wrap;
    }

    // Build reusable tactical roadblock (2 angled cruisers + flashing cones + Rapier kinematic colliders)
    const rbGroup = new THREE.Group();
    rbGroup.name = 'cop_roadblock';
    rbGroup.visible = false;
    const rbLights: { r: THREE.MeshBasicMaterial; b: THREE.MeshBasicMaterial }[] = [];
    const rbBodies: RAPIER.RigidBody[] = [];

    const coneGeo = new THREE.ConeGeometry(0.24, 0.72, 6);
    const coneMat = new THREE.MeshBasicMaterial({ color: 0xff5a1f });

    // Wide 4.6 m skill gap so attentive drivers can thread through cleanly
    const layouts = [
      { x: -4.1, z: 0, yaw: Math.PI * 0.42 },
      { x: 4.1, z: 0.4, yaw: -Math.PI * 0.42 },
    ];
    for (const lay of layouts) {
      const car = proto.clone(true);
      const wrap = new THREE.Group();
      wrap.add(car);
      wrap.position.set(lay.x, 0.02, lay.z);
      wrap.rotation.y = lay.yaw;
      rbLights.push(attachLightbar(wrap));
      rbGroup.add(wrap);

      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -600, 0));
      pw.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.95, 0.55, 2.1).setTranslation(0, 0.65, 0).setFriction(0.4).setRestitution(0.08).setCollisionGroups(GROUP_CAR),
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

  /** Monitor roadside speed cameras; triggers police radio dispatch only when caught exceeding speed limit! */
  updateCameras(dt: number, playerS: number, playerPos: THREE.Vector3, kmh: number, enabled: boolean, heatLevel = 1) {
    this.setCamerasVisible(enabled);
    this.nextCamera = null;
    if (!enabled || !this.cameras.length) {
      this.dispatchDelay = 0;
      return;
    }

    const L = this.lane.length;
    const half = L * 0.5;
    const signedDelta = (a: number, b: number) => {
      const raw = ((a - b) % L + L) % L;
      return raw > half ? raw - L : raw;
    };

    // Pending dispatch countdown: realistic 4 s arrival delay after speed camera alerts police radio
    if (this.dispatchDelay > 0 && !this.active) {
      this.dispatchDelay -= dt;
      if (this.dispatchDelay <= 0) {
        this.dispatchDelay = 0;
        this.spawn(playerS, playerPos, this.dispatchHeat);
      }
    }

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

      // Trigger speed camera when passing within 15 m laterally/longitudinally over limit + grace margin
      if (cam.cooldown <= 0 && Math.abs(ahead) < 14) {
        const dWorld = Math.hypot(cam.world.x - playerPos.x, cam.world.z - playerPos.z);
        if (dWorld < 20 && kmh > cam.limitKmh + CAM_OVER_MARGIN) {
          cam.cooldown = CAM_COOLDOWN_S;
          cam.flashTimer = 0.55;
          const spd = Math.round(kmh);
          const over = spd - cam.limitKmh;
          this.hooks.onCameraFlash?.(cam, spd, over);

          if (!this.active && this.dispatchDelay <= 0) {
            // Fresh pursuit triggered by speed camera! Dispatch over police radio first, unit rolls in 4s later
            this.dispatchDelay = 4.0;
            this.dispatchHeat = Math.max(1, Math.min(5, heatLevel + (over >= 70 ? 1 : 0)));
            this.tactic = 'DISPATCHED';
            this.hooks.onAlert?.(`📸 ${cam.name} FLASHED · ${spd} km/h IN ${cam.limitKmh} ZONE · POLICE DISPATCHED`);
            this.hooks.onRadio?.(
              'DISPATCH',
              `All units, speed camera ${cam.id} tripped — suspect clocked at ${spd} in a ${cam.limitKmh} zone. Interceptor unit respond, over.`,
              true,
            );
          } else if (this.active) {
            // Re-spotted by another speed camera during pursuit or cooldown!
            if (this.evading) {
              this.evading = false;
              this.evadeTimer = 0;
              this.far = 0;
              this.blind = 0;
              this.tactic = 'PURSUIT';
              this.hooks.onRadio?.(
                'DISPATCH',
                `Camera ${cam.id} just caught the suspect again at ${spd} kilometers per hour! Units re-engaging.`,
                true,
              );
            } else {
              this.hooks.onRadio?.(
                'DISPATCH',
                `Update: suspect blew past camera ${cam.id} at ${spd} in a ${cam.limitKmh} zone.`,
                false,
              );
            }
          }
        }
      }
    }
  }

  spawn(playerS: number, playerPos: THREE.Vector3, heatLevel = 1) {
    this.active = true;
    this.dispatchDelay = 0;
    this.heat = Math.max(1, Math.min(5, Math.floor(heatLevel || 1)));
    this.t = 0;
    this.far = 0;
    this.slow = 0;
    this.evadeTimer = 0;
    this.evading = false;
    this.blind = 0;
    this.pitCd = 6.5;
    this.pitWarned = false;
    this.roadblockCd = this.heat >= 2 ? 9.0 : 14.0;
    this.lastPullingAwayRadio = 0;
    this.tactic = 'PURSUIT';

    // Realistic arrival distance: cruisers roll in ~105-145 m behind from patrol, NOT 32 m on your bumper!
    const u0 = this.units[0];
    u0.active = true;
    u0.s = this.lane.wrap(playerS - 105);
    u0.lat = 1.6;
    u0.speed = 32; // ~115 km/h rolling pursuit speed
    this.s = u0.s;
    this.speed = u0.speed;
    this.gap = 105;

    const u1 = this.units[1];
    u1.active = this.heat >= 3; // Second cruiser only joins at Heat 3+
    u1.s = this.lane.wrap(playerS - 145);
    u1.lat = -1.9;
    u1.speed = 30;

    this.hideRoadblock();
    this.placeUnits(playerPos, true);
    this.hooks.onAlert?.(this.heat >= 3 ? `🚨 INTERCEPTOR SQUAD INBOUND · HEAT ${this.heat}` : '🚨 PATROL UNIT IN PURSUIT');
    this.hooks.onRadio?.(
      'UNIT-04',
      `10-4 Dispatch, Unit 4 has visual on the speeding vehicle. Lights and sirens, moving to intercept.`,
      true,
    );
  }

  breakOff() {
    this.active = false;
    this.dispatchDelay = 0;
    this.evading = false;
    this.evadeTimer = 0;
    this.slow = 0;
    this.tactic = 'PURSUIT';
    for (const u of this.units) {
      u.active = false;
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
      const ds = -115 + f * 195; // from 115 m before block to 80 m past block
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

    // First 3 cars in a race (P1-P3) get caught past the detour turnoff and must punch through the gap;
    // P4+ (and Free Roam) get the quick GPS + Street Radio reroute around the block!
    const topThreeMustPunch = isRace && playerRank >= 1 && playerRank <= 3;
    rb.phase = topThreeMustPunch ? 'punch' : 'forming';
    rb.rerouteTimer = topThreeMustPunch ? 1.35 : 0.95;
    rb.chevrons.visible = !topThreeMustPunch;

    this.tactic = 'ROADBLOCK AHEAD';
    this.hooks.onRadio?.('DISPATCH', 'Roadblock forming two hundred fifty meters ahead of the lead pack! Lock down the strip!', true);
    if (topThreeMustPunch) {
      this.hooks.onAlert?.('🚧 ROADBLOCK FORMING · P1–P3 THREAD GAP!');
      this.hooks.onStreetRadio?.('GPS', `🚧 ROADBLOCK FORMING AHEAD! Top 3 (P1–P3) are too close — PUNCH THROUGH THE GAP! Rerouting P4+ ${sideWord}!`);
    } else {
      this.hooks.onAlert?.(`↪ QUICK GPS REROUTE · BYPASS ${sideWord}`);
      this.hooks.onStreetRadio?.('GPS', `🚧 ROADBLOCK FORMING AHEAD! Quick reroute calculating — P1–P3 punching through, prep ${sideWord} bypass!`);
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

  /** dt seconds, player's arc length, world position, speed (km/h), race position (1-based), and whether in a race. */
  update(dt: number, playerS: number, playerPos: THREE.Vector3, kmh: number, playerRank = 1, isRace = true) {
    if (!this.active) return;
    this.t += dt;
    this.pitCd = Math.max(0, this.pitCd - dt);
    this.roadblockCd -= dt;

    // Strobe police lightbars at 6 Hz
    this.flashAcc += dt;
    if (this.flashAcc >= 0.14) {
      this.flashAcc = 0;
      this.flashPhase = !this.flashPhase;
      const rc = this.flashPhase ? 0xff2d55 : 0x2a0008;
      const bc = this.flashPhase ? 0x001030 : 0x2a9dff;
      for (const u of this.units) if (u.lights) { u.lights.r.color.setHex(rc); u.lights.b.color.setHex(bc); }
      if (this.roadblock) for (const l of this.roadblock.lights) { l.r.color.setHex(rc); l.b.color.setHex(bc); }
    }

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

    // Realistic patrol sedan / interceptor speed caps (zero unfair 350 km/h rubber-banding!)
    // Heat 1: 195 km/h | Heat 2: 208 km/h | Heat 3: 220 km/h | Heat 4: 232 km/h | Heat 5: 244 km/h
    const topSpeed = (195 + (this.heat - 1) * 12.25) / 3.6;
    const maxAccel = 5.4 + this.heat * 0.38; // realistic heavy cruiser acceleration (m/s²)
    const maxBrake = 9.0;                    // m/s²

    let minDist = Infinity;
    let closestGap = 999;

    for (const u of this.units) {
      if (!u.active) continue;
      const gapAhead = signedDelta(playerS, u.s); // positive = player ahead of cop
      const room = this.lane.room(u.s);

      // Realistic heavy cruiser corner grip limit (mu = 0.86): heavy sedans genuinely lose speed in tight corners!
      const ci = this.lane.idx(u.s);
      const nPts = this.lane.n;
      const rA = this.lane.right[(ci - 2 + nPts) % nPts];
      const rB = this.lane.right[(ci + 2) % nPts];
      const dAng = Math.acos(Math.max(-1, Math.min(1, rA.x * rB.x + rA.z * rB.z)));
      const curv = dAng / 16;
      const cornerLimit = curv > 0.007 ? Math.sqrt((0.86 * 9.81) / curv) : topSpeed;

      const wantOffsetS = u.role === 'pit' ? -4.0 : -1.8;
      const d = signedDelta(playerS + wantOffsetS, u.s);
      const playerSpeedMs = kmh / 3.6;
      // NO rubber-banding: cruiser either floors it up to its own physical topSpeed or paces gently when close
      let targetSpeed: number;
      if (this.evading) {
        targetSpeed = Math.min(topSpeed * 0.82, cornerLimit);
      } else if (d > 14) {
        targetSpeed = topSpeed;
      } else if (d > -6) {
        targetSpeed = Math.min(topSpeed, Math.max(0, playerSpeedMs + d * 0.42));
      } else {
        targetSpeed = Math.max(0, playerSpeedMs - 4);
      }
      targetSpeed = Math.min(targetSpeed, cornerLimit);

      // High-speed aerodynamic drag falloff above 140 km/h (cruisers struggle to climb past 190 km/h)
      const speedFrac = Math.min(0.95, u.speed / topSpeed);
      const availAccel = maxAccel * (1 - 0.65 * speedFrac * speedFrac);
      const dv = targetSpeed - u.speed;
      if (dv > 0) u.speed += Math.min(dv, availAccel * dt);
      else u.speed += Math.max(dv, -maxBrake * dt);
      u.speed = Math.max(0, Math.min(topSpeed, u.speed));
      u.s = this.lane.wrap(u.s + u.speed * dt);

      const understeerPush = u.speed > cornerLimit * 1.02 ? (u.speed - cornerLimit) * 0.5 : 0;
      const latBias = u.role === 'pit' ? (playerLat > 0 ? -2.0 : 2.0) : (playerLat > 0 ? 2.2 : -2.2);
      const engagedPit = !this.evading && u.role === 'pit' && Math.abs(gapAhead - 2.1) < 2.2 && this.pitCd <= 0 && kmh > 55;
      const wantLat = Math.max(-room.left, Math.min(room.right, playerLat + (engagedPit ? latBias * 0.5 : latBias) + understeerPush * u.side));
      u.lat += (wantLat - u.lat) * Math.min(1, dt * (engagedPit ? 3.8 : 2.1));

      this.lane.at(u.s, u.lat, u.world);
      const dist3 = Math.hypot(u.world.x - playerPos.x, u.world.z - playerPos.z);
      if (dist3 < minDist) {
        minDist = dist3;
        closestGap = gapAhead;
      }

      // Controlled realistic PIT only when cruiser genuinely earns side-by-side rear-quarter overlap
      if (!this.evading && u.role === 'pit' && Math.abs(gapAhead - 2.1) < 3.0 && Math.abs(u.lat - playerLat) < 2.6 && kmh > 55) {
        if (!this.pitWarned && this.pitCd < 1.2) {
          this.pitWarned = true;
          this.tactic = 'PIT MANEUVER';
          this.hooks.onAlert?.('⚠ INTERCEPTOR ALIGNING FOR PIT');
          this.hooks.onRadio?.('UNIT-04', 'I have the rear quarter, requesting permission for PIT.', false);
        }
        if (this.pitCd <= 0 && dist3 < 3.8) {
          const pushDir = u.lat < playerLat ? 1 : -1;
          this.pitCd = PIT_COOLDOWN;
          this.pitWarned = false;
          this.hooks.onPitNudge?.(pushDir, 0.45 + this.heat * 0.06);
          this.hooks.onAlert?.('🚨 PIT CONTACT · COUNTER-STEER!');
        }
      }
    }

    // Police radio reaction when player genuinely pulls away at high speed
    if (!this.evading && minDist > 115 && kmh > 205 && this.t - this.lastPullingAwayRadio > 18) {
      this.lastPullingAwayRadio = this.t;
      this.hooks.onRadio?.('UNIT-04', `Suspect is pulling away at over ${Math.round(kmh)}! Cruiser is topped out!`, true);
    }

    // Deploy roadblock ahead during sustained pursuit (Heat >= 2 or > 11 s chase) + trigger quick GPS/Radio reroute!
    if (!this.evading && this.roadblock && !this.roadblock.active && this.roadblockCd <= 0 && kmh > 65 && (this.heat >= 2 || this.t > 11)) {
      this.deployRoadblock(playerS, playerRank, isRace);
    } else if (this.roadblock?.active) {
      const rb = this.roadblock;
      const rbGap = signedDelta(rb.s, playerS);
      rb.distM = Math.round(rbGap);
      // Quick reroute announcement (~1 s after block begins forming)
      if (!rb.rerouteAnnounced) {
        rb.rerouteTimer -= dt;
        if (rb.rerouteTimer <= 0) {
          rb.rerouteAnnounced = true;
          const sideWord = rb.bypassSide > 0 ? 'RIGHT' : 'LEFT';
          if (rb.phase === 'forming') {
            rb.phase = 'rerouted';
            rb.chevrons.visible = true;
            this.hooks.onStreetRadio?.('GPS', `↪ REROUTE ACTIVE! Swing ${sideWord} onto the bypass around the police block!`);
          } else {
            // Top 3 still punching through, reroute broadcast goes out to chasing pack behind them
            rb.chevrons.visible = true;
            this.hooks.onStreetRadio?.('GPS', `↪ REROUTE LOCKED for P4+ (${sideWord} bypass) — P1–P3 thread the cruisers!`);
          }
        }
      }
      if (rbGap < -35) {
        const wasPunch = rb.phase === 'punch';
        this.hideRoadblock();
        this.roadblockCd = 22.0;
        this.tactic = this.evading ? 'EVADING' : 'PURSUIT';
        this.hooks.onAlert?.(wasPunch ? '✓ PUNCHED THROUGH ROADBLOCK!' : '✓ ROADBLOCK BYPASSED');
        this.hooks.onRadio?.('UNIT-04', 'Suspect cleared the roadblock, continuing pursuit!', false);
        this.hooks.onStreetRadio?.('GPS', wasPunch ? '🔥 Front pack punched through the block! Back on main route.' : '✓ Bypass complete — back on main race route!');
      }
    }

    this.s = this.units[0].s;
    this.speed = this.units[0].speed;
    this.gap = closestGap;
    this.placeUnits(playerPos);

    // Fair bust meter: only builds if nearly stopped (< 12 km/h) AND pinned within 8 m; decays smoothly if you break loose!
    if (minDist < BUST_GAP && kmh < BUST_SLOW) {
      this.slow += dt;
    } else {
      this.slow = Math.max(0, this.slow - dt * 1.6);
    }
    if (this.slow >= BUST_HOLD) {
      this.hooks.onRadio?.('UNIT-04', 'Suspect vehicle pinned and immobilized. Driver in custody, 10-15.', true);
      this.breakOff();
      this.hooks.bust();
      return;
    }

    // Realistic EVADING cooldown transition when player pulls > 165 m clear
    if (minDist > ESCAPE_GAP) {
      this.far += dt;
      if (!this.evading && this.far >= 1.8) {
        this.enterEvading('Suspect out of visual range, switching to search pattern.');
      }
    } else {
      this.far = 0;
      if (this.evading && minDist < 95) {
        this.evading = false;
        this.evadeTimer = 0;
        this.tactic = 'PURSUIT';
        this.hooks.onRadio?.('UNIT-04', 'Visual re-acquired! Back in pursuit!', true);
      }
    }

    if (this.evading) {
      this.evadeTimer += dt;
      if (this.evadeTimer >= EVADE_HOLD) {
        this.hooks.onRadio?.('DISPATCH', '10-22, cancel pursuit. Suspect evaded — all units return to patrol.', true);
        this.breakOff();
        this.hooks.escaped();
        return;
      }
    } else if (this.t > GIVE_UP && minDist > 90) {
      this.hooks.onRadio?.('DISPATCH', 'Pursuit terminated for public safety. All units stand down.', true);
      this.breakOff();
      this.hooks.escaped();
    }
  }

  private enterEvading(radioLine: string) {
    if (this.evading) return;
    this.evading = true;
    this.evadeTimer = 0;
    this.tactic = 'EVADING';
    this.hooks.onAlert?.('💨 EVADING PURSUIT · STAY OUT OF SIGHT');
    this.hooks.onRadio?.('UNIT-04', radioLine, true);
  }

  /** Line-of-sight escape: losing sight behind city buildings triggers EVADING cooldown cleanly. */
  see(blocked: boolean, dt: number) {
    if (!this.active) return;
    this.blind = blocked ? this.blind + dt : 0;
    if (this.blind >= LOS_HOLD && !this.evading) {
      this.enterEvading('Lost visual behind downtown blocks, entering cooldown search.');
    }
  }

  get proximity() { return this.active ? Math.max(0, 1 - Math.abs(this.gap) / 185) : 0; }
  get distance() { return Math.abs(this.gap); }

  private placeUnits(_playerPos: THREE.Vector3, teleport = false) {
    for (const u of this.units) {
      if (!u.active) {
        if (u.root) u.root.visible = false;
        if (u.body) {
          u.body.setTranslation({ x: 0, y: -600, z: 0 }, true);
          u.body.setEnabled(false);
        }
        continue;
      }
      this.lane.at(u.s, u.lat, u.world);
      const i = this.lane.idx(u.s);
      const r = this.lane.right[i];
      const yaw = Math.atan2(r.z, -r.x);
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
      void this.tmpPos;
    }
  }
}
