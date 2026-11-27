// Apache-2.0 - makes the nearest background cars solid for the player. The instanced cars of cityTraffic.ts have no physics body of their own; this keeps a small pool of kinematic Rapier boxes and lends
// them to the cars closest to the player (the same trick as the rival cars of ai.ts, which share the player's collisions: the solver treats a kinematic body as an immovable wall, so the player gets
// half the velocity change back and the car takes the other half).
//
// The simulation moves a car once per frame, the physics steps at 400 Hz: a body that jumped to its new place once a frame would look like a 100 m/s car for one step. So between frames each body
// is advanced EVERY step from the car's own velocity, and is put back on the simulation's pose when the next frame arrives.
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUP_CAR, type PhysicsWorld } from './physics/world';
import type { TrafficAgent, TrafficSim } from './trafficSim';

/** cars that can be solid at once */
export const COLLISION_POOL = 8;
/** a car is a candidate when it is this close to the player (m) */
export const COLLISION_RANGE = 40;
/** seconds a car that was hit stays where it is before it drives on (a fender-bender) */
export const HIT_HOLD_S = 12;
const BOX_HALF_HEIGHT = 0.42;    // the box spans 0.15 m to 0.99 m: below the top of the player's hull, so nothing wedges under it
const BOX_CENTRE_Y = 0.57;
const PARK = { x: 0, y: -5000, z: 0 };

interface Slot {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  agent: TrafficAgent | null;
  /** three.js position and velocity (x, z) of the box, advanced every physics step */
  x: number; y: number; z: number; vx: number; vz: number; yaw: number;
}

export class TrafficCollision {
  private readonly slots: Slot[] = [];
  /** the last car the player touched and the hardest speed change (m/s, the car's half of it) of that contact: for the HUD and sound. A contact lasts until 0.5 s pass without touching. */
  lastHit: { agent: TrafficAgent; dv: number; at: number } | null = null;

  constructor(private readonly pw: PhysicsWorld, private readonly sim: TrafficSim, private readonly heightAt: (x: number, z: number) => number) {
    for (let i = 0; i < COLLISION_POOL; i++) {
      const body = pw.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(PARK.x, PARK.y, PARK.z));
      const collider = pw.world.createCollider(RAPIER.ColliderDesc.cuboid(2.2, BOX_HALF_HEIGHT, 0.9).setTranslation(0, BOX_CENTRE_Y, 0).setFriction(0.3).setRestitution(0).setCollisionGroups(GROUP_CAR), body);
      this.slots.push({ body, collider, agent: null, x: PARK.x, y: PARK.y, z: PARK.z, vx: 0, vz: 0, yaw: 0 });
    }
  }

  /** Once per frame: give the boxes to the cars nearest the player and put them on the simulation's pose. (playerX, playerZ in three.js coordinates.) */
  sync(playerX: number, playerZ: number) {
    const near: { a: TrafficAgent; d2: number }[] = [];
    for (const a of this.sim.agents) {
      const dx = a.x - playerX, dy = a.y + playerZ;    // the simulation's y is three.js -z
      const d2 = dx * dx + dy * dy;
      if (d2 < COLLISION_RANGE * COLLISION_RANGE) near.push({ a, d2 });
    }
    near.sort((p, q) => p.d2 - q.d2);
    const want = new Set<TrafficAgent>();
    for (let i = 0; i < Math.min(COLLISION_POOL, near.length); i++) want.add(near[i].a);
    // cars that keep their box, then free the rest, then give boxes to the newcomers
    for (const s of this.slots) if (s.agent && !want.has(s.agent)) this.release(s);
    for (const s of this.slots) if (s.agent) want.delete(s.agent);
    for (const a of want) { const s = this.slots.find((q) => !q.agent); if (!s) break; s.agent = a; this.place(s, a, true); }
    for (const s of this.slots) if (s.agent) this.place(s, s.agent, false);
  }

  private release(s: Slot) {
    s.agent = null; s.vx = s.vz = 0;
    s.x = PARK.x; s.y = PARK.y; s.z = PARK.z;
    s.body.setTranslation(PARK, true);
  }

  private place(s: Slot, a: TrafficAgent, fresh: boolean) {
    const x = a.x, z = -a.y, c = Math.cos(a.h), sn = Math.sin(a.h);
    s.x = x; s.z = z; s.y = this.heightAt(x, z);
    s.vx = c * a.v; s.vz = -sn * a.v;
    s.yaw = a.h;
    const q = { x: 0, y: Math.sin(a.h / 2), z: 0, w: Math.cos(a.h / 2) };
    if (fresh) {
      s.collider.setHalfExtents({ x: a.length / 2, y: BOX_HALF_HEIGHT, z: a.width / 2 });
      s.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
      s.body.setRotation(q, true);
    } else {
      s.body.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
      s.body.setNextKinematicRotation(q);
    }
  }

  /** Every physics step, before it: move each box by its car's velocity. */
  tick(dt: number) {
    for (const s of this.slots) {
      if (!s.agent) continue;
      s.x += s.vx * dt; s.z += s.vz * dt;
      s.body.setNextKinematicTranslation({ x: s.x, y: s.y, z: s.z });
    }
  }

  /**
   * After the step: when the player touches a box, give the player half of the lost velocity back and hand the other half to the car (it stops where it is for a while).
   * `preV`, `preW`: the player's linear and angular velocity before the step. Returns true when a car was touched.
   */
  afterStep(playerCollider: RAPIER.Collider, playerBody: RAPIER.RigidBody, preV: { x: number; y: number; z: number }, preW: { x: number; y: number; z: number }): boolean {
    const p = playerBody.translation();
    for (const s of this.slots) {
      const a = s.agent;
      if (!a) continue;
      const dx = p.x - s.x, dz = p.z - s.z;
      if (dx * dx + dz * dz > 64) continue;   // 8 m apart: cannot touch
      let touching = false;
      this.pw.world.contactPair(playerCollider, s.collider, (m) => { if (m.numContacts() > 0) touching = true; });
      if (!touching) continue;
      const lv = playerBody.linvel(), av = playerBody.angvel();
      const dvx = lv.x - preV.x, dvz = lv.z - preV.z, dv = Math.hypot(dvx, dvz);
      if (dv < 0.02) { this.sim.hit(a, 0, HIT_HOLD_S); return true; }    // resting against it
      playerBody.setLinvel({ x: (preV.x + lv.x) / 2, y: lv.y, z: (preV.z + lv.z) / 2 }, true);
      playerBody.setAngvel({ x: (preW.x + av.x) / 2, y: (preW.y + av.y) / 2, z: (preW.z + av.z) / 2 }, true);
      // the car's half, along its heading (three.js forward is (cos h, -sin h))
      const along = (-dvx / 2) * Math.cos(s.yaw) + (-dvz / 2) * -Math.sin(s.yaw);
      this.sim.hit(a, along, HIT_HOLD_S);
      s.vx = s.vz = 0;
      const now = performance.now(), h = this.lastHit;
      this.lastHit = h && h.agent === a && now - h.at < 500 ? { agent: a, dv: Math.max(h.dv, dv / 2), at: now } : { agent: a, dv: dv / 2, at: now };
      return true;
    }
    return false;
  }

  /** Traffic is switched off: no box may stay in the world. */
  releaseAll() { for (const s of this.slots) if (s.agent) this.release(s); }

  dispose() {
    for (const s of this.slots) this.pw.world.removeRigidBody(s.body);
    this.slots.length = 0;
  }
}
