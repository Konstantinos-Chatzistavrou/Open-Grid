// Tactical Physics Police AI (OpenGrid — Race Events with Cop Mode ON ONLY; never active in Free Roam).
//
// Replaces arcade ramming with real pursuit tactics:
//   1. Interceptor (Unit 0 — PIT Specialist): aligns its nose with the player's rear quarter panel
//      and executes a controlled physics PIT nudge (lateral impulse + yaw torque via Rapier) that a
//      skilled driver can catch with counter-steer.
//   2. Flanker (Unit 1, Heat >= 2): mirrors the opposite flank to box in escape lines.
//   3. Tactical Roadblocks (Heat >= 2 or sustained chase): stages 2 angled patrol cruisers + flashing
//      lightbars + glowing barrier cones 220 m ahead along the route with a narrow 3.8 m escape gap
//      and real Rapier colliders.
import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Lane } from './ai';
import { GROUP_CAR, type PhysicsWorld } from './physics/world';

const CHASE_SPEED = 56;        // m/s (~201 km/h)
const ESCAPE_GAP = 155;        // m of clear road to break contact
const ESCAPE_HOLD = 4.0;       // s to hold escape gap
const BUST_GAP = 9.5;          // m
const BUST_SLOW = 18;          // km/h under which a pinned car is busted
const BUST_HOLD = 1.8;         // s
const GIVE_UP = 55;            // s max pursuit duration if player keeps moving
const LOS_HOLD = 3.5;          // s out of sight behind buildings
const PIT_COOLDOWN = 4.5;      // s between PIT attempts
const ROADBLOCK_AHEAD = 225;   // m ahead of player along route

export interface CopHooks {
  /** Player was pinned and busted during a Cop Race Event. */
  bust(): void;
  /** Player broke away from the pursuit squad. */
  escaped(): void;
  /** Tactical PIT maneuver engaged on the player's rear quarter (latSign = +1 right / -1 left, intensity 0..1). */
  onPitNudge?(latSign: number, intensity: number): void;
  /** Tactical radio alert for HUD banner (e.g. PIT incoming, Roadblock ahead). */
  onAlert?(msg: string): void;
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
  /** Current tactical state label for HUD ('PURSUIT' | 'PIT MANEUVER' | 'ROADBLOCK AHEAD'). */
  tactic: 'PURSUIT' | 'PIT MANEUVER' | 'ROADBLOCK AHEAD' = 'PURSUIT';

  private units: PatrolUnit[] = [];
  private roadblock: Roadblock | null = null;
  private scene: THREE.Scene | null = null;
  private pw: PhysicsWorld | null = null;
  private proto: THREE.Object3D | null = null;

  private gap = 0;
  private far = 0;
  private slow = 0;
  private t = 0;
  private blind = 0;
  private pitCd = 2.0;
  private pitWarned = false;
  private roadblockCd = 8.0;
  private flashPhase = false;
  private flashAcc = 0;
  private tmpPos = new THREE.Vector3();

  constructor(private lane: Lane, private hooks: CopHooks) {
    this.units = [
      { s: 0, lat: 0.7, speed: 0, side: 1, role: 'pit', world: this.world, root: null, lights: null, active: false },
      { s: 0, lat: -1.8, speed: 0, side: -1, role: 'flank', world: new THREE.Vector3(), root: null, lights: null, active: false },
    ];
  }

  /** Provide the unmarked cruiser template, scene, and Rapier world for multi-unit pursuits + physical roadblocks. */
  setupVisuals(proto: THREE.Object3D, scene: THREE.Scene, pw: PhysicsWorld) {
    this.proto = proto;
    this.scene = scene;
    this.pw = pw;

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

    // Two angled cruisers left & right of center leaving a 3.8 m central/offset skill gap
    const layouts = [
      { x: -3.7, z: 0, yaw: Math.PI * 0.42 },
      { x: 3.7, z: 0.4, yaw: -Math.PI * 0.42 },
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
    // Glowing barrier cones flanking the cruisers
    for (const cx of [-5.8, -1.9, 1.9, 5.8]) {
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(cx, 0.36, -1.3);
      rbGroup.add(cone);
    }

    scene.add(rbGroup);
    this.roadblock = { active: false, s: 0, world: new THREE.Vector3(), group: rbGroup, bodies: rbBodies, lights: rbLights, announced: false };
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

  spawn(playerS: number, playerPos: THREE.Vector3, heatLevel = 2) {
    this.active = true;
    this.heat = Math.max(1, Math.min(5, Math.floor(heatLevel || 1)));
    this.t = 0;
    this.far = 0;
    this.slow = 0;
    this.blind = 0;
    this.pitCd = 2.5;
    this.pitWarned = false;
    this.roadblockCd = this.heat >= 3 ? 5.0 : 10.0;
    this.tactic = 'PURSUIT';

    const u0 = this.units[0];
    u0.active = true;
    u0.s = this.lane.wrap(playerS - 32);
    u0.lat = 1.6;
    u0.speed = 24;
    this.s = u0.s;
    this.speed = u0.speed;
    this.gap = 32;

    const u1 = this.units[1];
    u1.active = this.heat >= 2;
    u1.s = this.lane.wrap(playerS - 52);
    u1.lat = -1.9;
    u1.speed = 26;

    this.hideRoadblock();
    this.placeUnits(playerPos);
    this.hooks.onAlert?.(this.heat >= 2 ? `🚨 TACTICAL PURSUIT · HEAT ${this.heat} · 2 UNITS` : '🚨 POLICE PURSUIT ENGAGED');
  }

  breakOff() {
    this.active = false;
    this.tactic = 'PURSUIT';
    for (const u of this.units) {
      u.active = false;
      if (u.root) u.root.visible = false;
    }
    this.hideRoadblock();
  }

  private hideRoadblock() {
    if (!this.roadblock) return;
    this.roadblock.active = false;
    this.roadblock.announced = false;
    this.roadblock.group.visible = false;
    for (const b of this.roadblock.bodies) {
      b.setTranslation({ x: 0, y: -600, z: 0 }, true);
      b.setEnabled(false);
    }
  }

  private deployRoadblock(playerS: number) {
    const rb = this.roadblock;
    if (!rb) return;
    rb.s = this.lane.wrap(playerS + ROADBLOCK_AHEAD);
    this.lane.at(rb.s, 0, rb.world);
    const i = this.lane.idx(rb.s);
    const r = this.lane.right[i];
    const roadYaw = Math.atan2(r.z, -r.x);
    rb.group.position.set(rb.world.x, rb.world.y, rb.world.z);
    rb.group.rotation.y = roadYaw;
    rb.group.visible = true;
    rb.active = true;
    rb.announced = true;

    const cosY = Math.cos(roadYaw), sinY = Math.sin(roadYaw);
    const layouts = [
      { x: -3.7, z: 0, yaw: Math.PI * 0.42 },
      { x: 3.7, z: 0.4, yaw: -Math.PI * 0.42 },
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
    this.tactic = 'ROADBLOCK AHEAD';
    this.hooks.onAlert?.('🚧 TACTICAL ROADBLOCK AHEAD · THREAD THE GAP');
  }

  /** World position of active roadblock (for minimap warning icon), or null. */
  get roadblockWorld(): THREE.Vector3 | null {
    return this.roadblock?.active ? this.roadblock.world : null;
  }

  /** All active patrol unit positions (for minimap blips). */
  unitPositions(): THREE.Vector3[] {
    return this.units.filter((u) => u.active).map((u) => u.world);
  }

  /** dt seconds, player's arc length, world position, and speed (km/h). */
  update(dt: number, playerS: number, playerPos: THREE.Vector3, kmh: number) {
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

    // Player lateral offset from route centerline
    const pIdx = this.lane.idx(playerS);
    const pCenter = this.lane.pts[pIdx];
    const pRight = this.lane.right[pIdx];
    const playerLat = (playerPos.x - pCenter.x) * pRight.x + (playerPos.z - pCenter.z) * pRight.z;
    const topSpeed = CHASE_SPEED + (this.heat - 1) * 3.5;

    let minDist = Infinity;
    let closestGap = 999;

    for (const u of this.units) {
      if (!u.active) continue;
      const gapAhead = signedDelta(playerS, u.s); // positive = player ahead of cop
      const room = this.lane.room(u.s);

      // Tactical positioning:
      //  - PIT specialist aims 2.1 m behind the player's rear axle, offset 1.9 m to one side, then swings in for a PIT!
      //  - Flanker mirrors the opposite side to box in lateral movement.
      const wantOffsetS = u.role === 'pit' ? (this.pitCd <= 0.3 && kmh > 38 ? -2.0 : -4.5) : -1.5;
      const targetS = playerS + wantOffsetS;
      const d = signedDelta(targetS, u.s);
      const wantSpeed = Math.max(-4, Math.min(topSpeed, kmh / 3.6 + d * 1.55));
      u.speed += (wantSpeed - u.speed) * Math.min(1, dt * 3.2);
      u.s = this.lane.wrap(u.s + u.speed * dt);

      const latBias = u.role === 'pit' ? (playerLat > 0 ? -1.85 : 1.85) : (playerLat > 0 ? 2.1 : -2.1);
      const engagedPit = u.role === 'pit' && Math.abs(gapAhead - 2.1) < 2.2 && this.pitCd <= 0 && kmh > 40;
      const wantLat = Math.max(-room.left, Math.min(room.right, playerLat + (engagedPit ? latBias * 0.48 : latBias)));
      u.lat += (wantLat - u.lat) * Math.min(1, dt * (engagedPit ? 5.5 : 2.6));

      this.lane.at(u.s, u.lat, u.world);
      const dist3 = Math.hypot(u.world.x - playerPos.x, u.world.z - playerPos.z);
      if (dist3 < minDist) {
        minDist = dist3;
        closestGap = gapAhead;
      }

      // Execute controlled physics PIT nudge when nose overlaps rear quarter panel
      if (u.role === 'pit' && Math.abs(gapAhead - 2.1) < 3.4 && Math.abs(u.lat - playerLat) < 2.8 && kmh > 40) {
        if (!this.pitWarned && this.pitCd < 0.8) {
          this.pitWarned = true;
          this.tactic = 'PIT MANEUVER';
          this.hooks.onAlert?.('⚠ INTERCEPTOR ALIGNING FOR PIT MANEUVER');
        }
        if (this.pitCd <= 0 && dist3 < 4.2) {
          const pushDir = u.lat < playerLat ? 1 : -1;
          this.pitCd = PIT_COOLDOWN;
          this.pitWarned = false;
          this.hooks.onPitNudge?.(pushDir, 0.65 + this.heat * 0.08);
          this.hooks.onAlert?.('🚨 PIT CONTACT · COUNTER-STEER!');
        }
      }
    }

    // Deploy tactical roadblock ahead if heat >= 2 (or sustained pursuit) and player is moving fast
    if (this.roadblock && !this.roadblock.active && this.roadblockCd <= 0 && kmh > 55 && (this.heat >= 2 || this.t > 12)) {
      this.deployRoadblock(playerS);
    } else if (this.roadblock?.active) {
      const rbGap = signedDelta(this.roadblock.s, playerS);
      if (rbGap < -35) {
        // Cleared the roadblock!
        this.hideRoadblock();
        this.roadblockCd = 16.0;
        this.tactic = 'PURSUIT';
        this.hooks.onAlert?.('✓ ROADBLOCK CLEARED');
      }
    }

    this.s = this.units[0].s;
    this.speed = this.units[0].speed;
    this.gap = closestGap;
    this.placeUnits(playerPos);

    if (minDist > ESCAPE_GAP) this.far += dt; else this.far = 0;
    if (minDist < BUST_GAP && kmh < BUST_SLOW) this.slow += dt; else this.slow = 0;
    if (this.slow >= BUST_HOLD) { this.breakOff(); this.hooks.bust(); return; }
    if (this.far >= ESCAPE_HOLD || this.t > GIVE_UP) { this.breakOff(); this.hooks.escaped(); }
  }

  /** Line-of-sight escape: losing sight behind city buildings breaks the pursuit cleanly. */
  see(blocked: boolean, dt: number) {
    if (!this.active) return;
    this.blind = blocked ? this.blind + dt : 0;
    if (this.blind >= LOS_HOLD) { this.breakOff(); this.hooks.escaped(); }
  }

  get proximity() { return this.active ? Math.max(0, 1 - Math.abs(this.gap) / 165) : 0; }
  get distance() { return Math.abs(this.gap); }

  private placeUnits(_playerPos: THREE.Vector3) {
    for (const u of this.units) {
      if (!u.active) {
        if (u.root) u.root.visible = false;
        continue;
      }
      this.lane.at(u.s, u.lat, u.world);
      const i = this.lane.idx(u.s);
      const r = this.lane.right[i];
      if (u.root) {
        u.root.position.set(u.world.x, u.world.y + 0.02, u.world.z);
        u.root.rotation.y = Math.atan2(r.z, -r.x);
        u.root.visible = true;
      }
      void this.tmpPos;
    }
  }
}
