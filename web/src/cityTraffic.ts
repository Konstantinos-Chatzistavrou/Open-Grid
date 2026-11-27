// Apache-2.0 - background city traffic in the game: trafficSim.ts moves the cars on the street graph, this draws them. Every car is an instance of one low-poly body and one lights mesh, so the cost is
// two draw calls and about 190 triangles per car however many there are; the rival cars of a race (ai.ts) are different and cost about 28k triangles and a SpotLight each.
// Upload rules (scene/instancing.ts): instance buffers are static and only the used range is re-uploaded, with at least INSTANCE_MIN slots so the matrices live in a vertex buffer.
import * as THREE from 'three/webgpu';
import { instanceSlots } from './scene/instancing';
import { BASE_LENGTH, BASE_WIDTH, buildCarBody, buildCarLights, type ShapeArrays } from './trafficCarShape';
import { TrafficSim } from './trafficSim';
import type { RoadGraph } from './roadGraph';
import type { PhysicsWorld } from './physics/world';
import { TrafficCollision } from './trafficCollision';
import type RAPIER from '@dimforge/rapier3d-compat';

/** sRGB paint colours: white, black, silver, graphite, navy, red, green, yellow (a taxi in a big city) */
const PAINT = [0xe8e8ea, 0x15161a, 0x9a9da3, 0x3b3f46, 0x1d2f55, 0x8c1c1c, 0x1f3a2c, 0xd9a413];
const PITCH_SPAN = 0.7;   // fraction of the car's length between the two ground samples that give its pitch

function geometry(a: ShapeArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(a.color, 3));
  return g;
}

export interface CityTrafficOptions {
  graph: RoadGraph;
  /** most cars that will ever be asked for (the top tier): sizes the instance buffers */
  maxCars: number;
  leftHand: boolean;
  seed?: number;
  /** ground height under a three.js position (x, z); flat when omitted */
  heightAt?: (x: number, z: number) => number;
  /** the physics world: when given, the cars nearest the player are solid (trafficCollision.ts) */
  physics?: PhysicsWorld;
}

export class CityTraffic {
  readonly sim: TrafficSim;
  readonly group = new THREE.Group();
  /** solid boxes for the nearest cars, or null without a physics world */
  readonly collision: TrafficCollision | null;
  /** CPU time of the last update (ms): the simulation plus writing the instances */
  lastUpdateMs = 0;
  private readonly body: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly lightMat: THREE.MeshBasicNodeMaterial;
  private readonly heightAt: (x: number, z: number) => number;
  private readonly slots: number;
  private readonly prev = { x: 0, z: 0, set: false };
  private started = false;
  private readonly colors: THREE.Color[] = PAINT.map((h) => new THREE.Color(h));
  private readonly m4 = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scl = new THREE.Vector3();
  private readonly eul = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(scene: THREE.Scene, opt: CityTrafficOptions) {
    this.sim = new TrafficSim(opt.graph, { count: 0, seed: opt.seed ?? 1, leftHand: opt.leftHand });
    this.heightAt = opt.heightAt ?? (() => 0);
    this.collision = opt.physics ? new TrafficCollision(opt.physics, this.sim, this.heightAt) : null;
    this.slots = instanceSlots(opt.maxCars);
    const bodyMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    this.lightMat = new THREE.MeshBasicNodeMaterial({ vertexColors: true });
    this.lightMat.color.setScalar(0.6);
    this.body = this.makeMesh(geometry(buildCarBody()), bodyMat);
    this.lights = this.makeMesh(geometry(buildCarLights()), this.lightMat);
    const ic = new THREE.InstancedBufferAttribute(new Float32Array(this.slots * 3), 3);
    ic.setUsage(THREE.StaticDrawUsage);
    this.body.instanceColor = ic;
    this.group.name = 'city-traffic';
    this.group.add(this.body, this.lights);
    scene.add(this.group);
  }

  private makeMesh(g: THREE.BufferGeometry, mat: THREE.Material): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(g, mat, this.slots);
    m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;   // the instances are around the player and the bounding sphere of the base shape knows nothing of them
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  /** target number of cars now (a tier change, or the time of day's traffic density) */
  setCount(n: number) { this.sim.setCount(Math.min(n, this.slots)); }

  /** 0 = day, 1 = night: head and tail lights glow brighter */
  setNight(f: number) { this.lightMat.color.setScalar(0.6 + 2.4 * Math.max(0, Math.min(1, f))); }

  /**
   * Advance the cars by dt seconds and write them into the instances. `playerX`, `playerZ` are three.js world coordinates; the street graph's frame is the core frame
   * (x east, y north), which is (x, -z) here.
   */
  update(dt: number, playerX: number, playerZ: number) {
    const t0 = performance.now();
    let vx = 0, vy = 0;
    if (dt > 0 && this.prev.set) {
      const dx = playerX - this.prev.x, dz = playerZ - this.prev.z;
      if (dx * dx + dz * dz > 50 * 50) { this.sim.reset({ x: playerX, y: -playerZ, vx: 0, vy: 0 }); }   // teleported: a new neighbourhood
      else { vx = dx / dt; vy = -dz / dt; }
    }
    this.prev.x = playerX; this.prev.z = playerZ; this.prev.set = true;
    const player = { x: playerX, y: -playerZ, vx, vy };
    if (!this.started && this.sim.count > 0) { this.started = true; this.sim.reset(player); }   // the first frame with traffic fills the street at once
    this.sim.update(dt, player);
    this.write();
    this.collision?.sync(playerX, playerZ);
    this.lastUpdateMs = performance.now() - t0 || 1e-3;
  }

  private write() {
    const A = this.sim.agents, n = Math.min(A.length, this.slots);
    const bm = this.body.instanceMatrix.array as Float32Array, lm = this.lights.instanceMatrix.array as Float32Array;
    const col = this.body.instanceColor!.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const a = A[i];
      const x = a.x, z = -a.y, c = Math.cos(a.h), s = Math.sin(a.h);
      const half = a.length * PITCH_SPAN * 0.5;
      // forward in three.js is (cos h, -sin h) in (x, z)
      const hf = this.heightAt(x + c * half, z - s * half), hr = this.heightAt(x - c * half, z + s * half);
      const pitch = Math.atan2(hf - hr, a.length * PITCH_SPAN);
      this.pos.set(x, (hf + hr) / 2, z);
      this.eul.set(0, a.h, pitch);
      this.quat.setFromEuler(this.eul);
      this.scl.set(a.length / BASE_LENGTH, a.kind === 2 ? 1.28 : 1, a.width / BASE_WIDTH);
      this.m4.compose(this.pos, this.quat, this.scl);
      this.m4.toArray(bm, i * 16);
      for (let j = 0; j < 16; j++) lm[i * 16 + j] = bm[i * 16 + j];
      const p = this.colors[a.color % this.colors.length];
      col[i * 3] = p.r; col[i * 3 + 1] = p.g; col[i * 3 + 2] = p.b;
    }
    for (const m of [this.body, this.lights]) {
      m.count = n; m.visible = n > 0;
      if (n > 0) { m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, n * 16); m.instanceMatrix.needsUpdate = true; }
    }
    if (n > 0) { const ic = this.body.instanceColor!; ic.clearUpdateRanges(); ic.addUpdateRange(0, n * 3); ic.needsUpdate = true; }
  }

  /** show or hide the traffic; hidden traffic is not solid either */
  setActive(on: boolean) {
    this.group.visible = on;
    if (!on) this.collision?.releaseAll();
  }

  /** every physics step, before it */
  physicsTick(dt: number) { this.collision?.tick(dt); }

  /** every physics step, after it: the player's collisions with the cars */
  afterStep(playerCollider: RAPIER.Collider, playerBody: RAPIER.RigidBody, preV: { x: number; y: number; z: number }, preW: { x: number; y: number; z: number }): boolean {
    return this.collision?.afterStep(playerCollider, playerBody, preV, preW) ?? false;
  }

  /** cars drawn right now */
  get drawn(): number { return this.body.count; }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    this.collision?.dispose();
    for (const m of [this.body, this.lights]) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); m.dispose(); }
  }
}
