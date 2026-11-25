// Forza Horizon 6 Real-Time VFX Director for OpenGrid's WebGPU harness.
//
// Zero-allocation, strictly pooled (<= 480 particles total, 1 draw call per layer, 0 PointLights, 0 mid-drive shader
// recompiles):
//   1. Physical 4-Wheel Brake Rotor Thermal Integrator (20 C .. 920 C) driving glowing rotors & brake audio
//   2. Volumetric 4-Wheel Drift & Lockup Tyre Smoke (160 sprites, all 4 wheels, slip + tread-temp tinted)
//   3. Wet-Road Rooster-Tail Water Spray Plumes (120 sprites, rearward-arching wet highway mist)
//   4. Titanium Scrape, Curb-Strike & Collision Sparks (120 velocity-stretched additive sparks with ground bounce)
//   5. High-Speed Rain Streaks / Wind-Warp Motes (80 camera-relative velocity-aligned streaks > 90 km/h when wet)
//   6. Suspension Thump / Curb-Strike & Bottom-Out Detector feeding GameAudio.suspensionThump()
import * as THREE from 'three/webgpu';
import {
  abs, float, instancedBufferAttribute, mix, pow, sin, smoothstep, time, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { noise01 } from './noiseTex';
import { OUT } from '../physics/core';

const SMOKE_MAX = 160;
const SPRAY_MAX = 120;
const SPARK_MAX = 120;
const RAIN_MAX = 80;
// Total pooled particles across all 4 layers: 160 + 120 + 120 + 80 = 480 (strictly <= 480)

export interface ForzaVfxOptions {
  /** Enable GPU particle layers (true on WebGPU; CPU thermal & suspension telemetry always run). */
  particles?: boolean;
  /** Low-power / laptop / mobile mode scales emission rates smoothly while keeping full visual language. */
  lowPower?: boolean;
}

/** Reused per-frame input struct (allocated once by caller and mutated in-place: zero per-frame allocations). */
export interface ForzaVfxFrameInput {
  dt: number;
  active: boolean;
  out: Float64Array;
  carPos: THREE.Vector3;
  carQuat: THREE.Quaternion;
  carVel: THREE.Vector3;
  camera: THREE.Camera;
  roadWetness: number;
  asphaltSurfaceId: number;
  handbrake: number;
  wheelRadii: readonly [number, number, number, number];
}

// --- Layer 1: Volumetric 4-Wheel Drift & Lockup Tyre Smoke (160 sprites) -----------------------------------------

class SmokePool {
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly ls: THREE.InstancedBufferAttribute; // x: age (0..1), y: seed
  private readonly vel: Float32Array;
  private readonly swirl: Float32Array;
  private readonly growRate: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  readonly sprite: THREE.Sprite;
  private next = 0;
  private active = 0;
  private dirtyClear = false;

  constructor(private readonly max = SMOKE_MAX) {
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.ls = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.vel = new Float32Array(max * 3);
    this.swirl = new Float32Array(max);
    this.growRate = new Float32Array(max);
    this.baseAlpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);

    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    m.positionNode = instancedBufferAttribute(this.pos);
    const sz = instancedBufferAttribute(this.size) as unknown as THREE.Node<'float'>;
    const c = instancedBufferAttribute(this.col, 'vec4') as unknown as THREE.Node<'vec4'>;
    const ls = instancedBufferAttribute(this.ls, 'vec2') as unknown as THREE.Node<'vec2'>;
    const age = ls.x;
    const seed = ls.y;
    const p = uv().sub(0.5);

    m.scaleNode = vec2(sz, sz);
    m.rotationNode = seed.mul(6.28318).add(age.mul(seed.sub(0.5).mul(3.1)));

    // 2-tap precomputed noise cloud billow (ultra-cheap on integrated GPUs)
    const n1 = noise01(vec2(p.x.mul(2.6).add(seed.mul(19.0)), p.y.mul(2.6).sub(time.mul(0.32))));
    const n2 = noise01(vec2(p.x.mul(5.8).sub(seed.mul(11.0)), p.y.mul(5.8).sub(time.mul(0.58))));
    const n = n1.mul(0.64).add(n2.mul(0.36)).sub(0.5).mul(1.25);
    const r = p.length();
    const disc = smoothstep(float(0.5), float(0.10), r);
    const billow = smoothstep(float(-0.34), float(0.42), n.add(0.34).sub(r.mul(0.68)));
    // Hemisphere shading: softly lit top from streetlights/sky, deeper base near asphalt
    const shade = mix(float(0.58), float(1.16), p.y.add(0.5).clamp(0, 1));
    const fade = smoothstep(float(0.0), float(0.08), age).mul(pow(float(1.0).sub(age).clamp(0, 1), float(1.35)));
    m.colorNode = vec4(c.xyz.mul(shade), disc.mul(billow).mul(fade).mul(c.w));

    this.sprite = new THREE.Sprite(m);
    this.sprite.name = 'forza_tyre_smoke';
    this.sprite.count = 1;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
  }

  emit(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, grow: number,
    r: number, g: number, b: number, alpha: number, swirlVel: number,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.life[i] <= 0) this.active++;
    this.pos.setXYZ(i, px, py, pz);
    this.col.setXYZW(i, r, g, b, alpha);
    this.size.setX(i, size);
    this.ls.setXY(i, 0, Math.random());
    const i3 = i * 3;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.swirl[i] = swirlVel;
    this.growRate[i] = grow;
    this.baseAlpha[i] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = this.ls.needsUpdate = true;
    this.sprite.count = this.max;
    this.sprite.visible = true;
    this.dirtyClear = true;
  }

  update(dt: number) {
    if (this.active === 0) {
      if (this.sprite.visible) this.sprite.visible = false;
      return;
    }
    if (dt <= 0) return;
    const dragK = Math.exp(-1.25 * dt);
    let alive = 0;
    const posArr = this.pos.array as Float32Array;
    const sizeArr = this.size.array as Float32Array;
    const lsArr = this.ls.array as Float32Array;
    const colArr = this.col.array as Float32Array;

    for (let i = 0; i < this.max; i++) {
      const rem = this.life[i];
      if (rem <= 0) {
        colArr[i * 4 + 3] = 0;
        sizeArr[i] = 0;
        continue;
      }
      const nextRem = rem - dt;
      this.life[i] = nextRem;
      if (nextRem <= 0) {
        colArr[i * 4 + 3] = 0;
        sizeArr[i] = 0;
        continue;
      }
      alive++;
      const age = 1 - nextRem / this.maxLife[i];
      const i3 = i * 3;
      // Gentle buoyancy + lateral vortex curl
      const sw = this.swirl[i];
      const vx = (this.vel[i3] + sw * 0.25) * dragK;
      const vy = (this.vel[i3 + 1] + 0.55 * dt) * dragK;
      const vz = (this.vel[i3 + 2] - sw * 0.18) * dragK;
      this.vel[i3] = vx;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = vz;
      posArr[i3] += vx * dt;
      posArr[i3 + 1] += vy * dt;
      posArr[i3 + 2] += vz * dt;
      sizeArr[i] += this.growRate[i] * dt;
      lsArr[i * 2] = age;
      colArr[i * 4 + 3] = this.baseAlpha[i];
    }
    this.active = alive;
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = this.ls.needsUpdate = true;
    this.sprite.visible = alive > 0;
  }

  clear() {
    if (!this.dirtyClear && this.active === 0) return;
    this.life.fill(0);
    this.active = 0;
    const colArr = this.col.array as Float32Array;
    const sizeArr = this.size.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      colArr[i * 4 + 3] = 0;
      sizeArr[i] = 0;
    }
    this.col.needsUpdate = this.size.needsUpdate = true;
    this.sprite.visible = false;
    this.dirtyClear = false;
  }

  warmup(on: boolean) {
    this.sprite.count = 1;
    this.sprite.visible = on;
  }
}

// --- Layer 2: Wet-Road Rooster-Tail Water Spray Plumes (120 sprites) ---------------------------------------------

class SprayPool {
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  private readonly size: THREE.InstancedBufferAttribute;
  private readonly ls: THREE.InstancedBufferAttribute;
  private readonly vel: Float32Array;
  private readonly growRate: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  readonly sprite: THREE.Sprite;
  private next = 0;
  private active = 0;
  private dirtyClear = false;

  constructor(private readonly max = SPRAY_MAX) {
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.ls = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.vel = new Float32Array(max * 3);
    this.growRate = new Float32Array(max);
    this.baseAlpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);

    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    m.positionNode = instancedBufferAttribute(this.pos);
    const sz = instancedBufferAttribute(this.size) as unknown as THREE.Node<'float'>;
    const c = instancedBufferAttribute(this.col, 'vec4') as unknown as THREE.Node<'vec4'>;
    const ls = instancedBufferAttribute(this.ls, 'vec2') as unknown as THREE.Node<'vec2'>;
    const age = ls.x;
    const seed = ls.y;
    const p = uv().sub(0.5);

    // Slightly wider elliptical mist plume
    m.scaleNode = vec2(sz.mul(1.18), sz.mul(0.92));
    m.rotationNode = seed.mul(6.28318).add(age.mul(seed.sub(0.5).mul(1.6)));

    // Fine water-droplet aerosol mist texture
    const n1 = noise01(vec2(p.x.mul(3.4).add(seed.mul(13.0)), p.y.mul(3.4).add(time.mul(0.75))));
    const n2 = noise01(vec2(p.x.mul(7.6).sub(seed.mul(7.0)), p.y.mul(7.6).sub(time.mul(1.2))));
    const mist = n1.mul(0.55).add(n2.mul(0.45));
    const r = p.length();
    const soft = smoothstep(float(0.5), float(0.06), r);
    const dens = soft.mul(smoothstep(float(0.18), float(0.78), mist.add(0.28).sub(r.mul(0.55))));
    const fade = smoothstep(float(0.0), float(0.06), age).mul(pow(float(1.0).sub(age).clamp(0, 1), float(1.45)));
    const rim = mix(float(0.76), float(1.22), p.y.add(0.5).clamp(0, 1));
    m.colorNode = vec4(c.xyz.mul(rim), dens.mul(fade).mul(c.w));

    this.sprite = new THREE.Sprite(m);
    this.sprite.name = 'forza_wet_spray';
    this.sprite.count = 1;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
  }

  emit(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, grow: number, alpha: number,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.life[i] <= 0) this.active++;
    this.pos.setXYZ(i, px, py, pz);
    // Cool silvery-blue wet night spray that catches city neon & headlights
    this.col.setXYZW(i, 0.64, 0.73, 0.84, alpha);
    this.size.setX(i, size);
    this.ls.setXY(i, 0, Math.random());
    const i3 = i * 3;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.growRate[i] = grow;
    this.baseAlpha[i] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = this.ls.needsUpdate = true;
    this.sprite.count = this.max;
    this.sprite.visible = true;
    this.dirtyClear = true;
  }

  update(dt: number) {
    if (this.active === 0) {
      if (this.sprite.visible) this.sprite.visible = false;
      return;
    }
    if (dt <= 0) return;
    const dragK = Math.exp(-2.4 * dt);
    let alive = 0;
    const posArr = this.pos.array as Float32Array;
    const sizeArr = this.size.array as Float32Array;
    const lsArr = this.ls.array as Float32Array;
    const colArr = this.col.array as Float32Array;

    for (let i = 0; i < this.max; i++) {
      const rem = this.life[i];
      if (rem <= 0) {
        colArr[i * 4 + 3] = 0;
        sizeArr[i] = 0;
        continue;
      }
      const nextRem = rem - dt;
      this.life[i] = nextRem;
      if (nextRem <= 0) {
        colArr[i * 4 + 3] = 0;
        sizeArr[i] = 0;
        continue;
      }
      alive++;
      const age = 1 - nextRem / this.maxLife[i];
      const i3 = i * 3;
      const vx = this.vel[i3] * dragK;
      const vy = (this.vel[i3 + 1] - 3.6 * dt) * dragK; // gravity settles mist back onto wet road
      const vz = this.vel[i3 + 2] * dragK;
      this.vel[i3] = vx;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = vz;
      posArr[i3] += vx * dt;
      posArr[i3 + 1] += vy * dt;
      posArr[i3 + 2] += vz * dt;
      sizeArr[i] += this.growRate[i] * dt;
      lsArr[i * 2] = age;
      colArr[i * 4 + 3] = this.baseAlpha[i];
    }
    this.active = alive;
    this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = this.ls.needsUpdate = true;
    this.sprite.visible = alive > 0;
  }

  clear() {
    if (!this.dirtyClear && this.active === 0) return;
    this.life.fill(0);
    this.active = 0;
    const colArr = this.col.array as Float32Array;
    const sizeArr = this.size.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      colArr[i * 4 + 3] = 0;
      sizeArr[i] = 0;
    }
    this.col.needsUpdate = this.size.needsUpdate = true;
    this.sprite.visible = false;
    this.dirtyClear = false;
  }

  warmup(on: boolean) {
    this.sprite.count = 1;
    this.sprite.visible = on;
  }
}

// --- Layer 3: Titanium Scrape, Curb-Strike & Collision Sparks (120 velocity-stretched bouncing sparks) -----------

class SparkPool {
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly scale2: THREE.InstancedBufferAttribute; // x: streak length, y: thickness
  private readonly rot: THREE.InstancedBufferAttribute;    // screen-space velocity angle (rad)
  private readonly meta: THREE.InstancedBufferAttribute;   // x: age (0..1), y: seed, z: heat/alpha
  private readonly vel: Float32Array;
  private readonly groundY: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  readonly sprite: THREE.Sprite;
  private next = 0;
  private active = 0;
  private dirtyClear = false;

  constructor(private readonly max = SPARK_MAX) {
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.scale2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.meta = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.vel = new Float32Array(max * 3);
    this.groundY = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);

    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.positionNode = instancedBufferAttribute(this.pos);
    m.scaleNode = instancedBufferAttribute(this.scale2, 'vec2') as unknown as THREE.Node<'vec2'>;
    m.rotationNode = instancedBufferAttribute(this.rot) as unknown as THREE.Node<'float'>;

    const mt = instancedBufferAttribute(this.meta, 'vec3') as unknown as THREE.Node<'vec3'>;
    const age = mt.x;
    const seed = mt.y;
    const energy = mt.z;
    const p = uv().sub(0.5);

    // Tapered incandescent streak: bright titanium-white head at +X, molten gold tail toward -X
    const along = smoothstep(float(-0.5), float(0.28), p.x).mul(smoothstep(float(0.5), float(0.26), p.x));
    const across = pow(smoothstep(float(0.5), float(0.0), abs(p.y)), float(2.2));
    const core = along.mul(across);
    const flicker = sin(time.mul(44.0).add(seed.mul(62.0))).mul(0.22).add(0.88);

    // Physical cooling ramp: white-hot titanium -> molten amber -> deep crimson ember
    const hotCol = mix(vec3(1.0, 0.96, 0.84), vec3(1.0, 0.56, 0.12), smoothstep(float(0.05), float(0.45), age));
    const col = mix(hotCol, vec3(0.92, 0.18, 0.02), smoothstep(float(0.45), float(0.95), age));
    const headBoost = smoothstep(float(0.05), float(0.32), p.x).mul(1.8).add(1.0);
    const alpha = core.mul(float(1.0).sub(age).clamp(0, 1)).mul(energy);
    // HDR multiplier > 2.0 produces crisp Forza titanium bloom trails
    m.colorNode = vec4(col.mul(flicker).mul(headBoost).mul(3.6).mul(energy), alpha);

    this.sprite = new THREE.Sprite(m);
    this.sprite.name = 'forza_titanium_sparks';
    this.sprite.count = 1;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
  }

  emit(
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    life: number, thickness: number, energy: number, groundY: number,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    if (this.life[i] <= 0) this.active++;
    this.pos.setXYZ(i, px, py, pz);
    this.scale2.setXY(i, thickness * 5.0, thickness);
    this.rot.setX(i, 0);
    this.meta.setXYZ(i, 0, Math.random(), energy);
    const i3 = i * 3;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.groundY[i] = groundY;
    this.baseSize[i] = thickness;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.pos.needsUpdate = this.scale2.needsUpdate = this.rot.needsUpdate = this.meta.needsUpdate = true;
    this.sprite.count = this.max;
    this.sprite.visible = true;
    this.dirtyClear = true;
  }

  update(dt: number, camRight: THREE.Vector3, camUp: THREE.Vector3) {
    if (this.active === 0) {
      if (this.sprite.visible) this.sprite.visible = false;
      return;
    }
    if (dt <= 0) return;
    const dragK = Math.exp(-1.75 * dt);
    const rx = camRight.x, ry = camRight.y, rz = camRight.z;
    const ux = camUp.x, uy = camUp.y, uz = camUp.z;
    let alive = 0;

    const posArr = this.pos.array as Float32Array;
    const scArr = this.scale2.array as Float32Array;
    const rotArr = this.rot.array as Float32Array;
    const mtArr = this.meta.array as Float32Array;

    for (let i = 0; i < this.max; i++) {
      const rem = this.life[i];
      if (rem <= 0) {
        scArr[i * 2] = 0;
        scArr[i * 2 + 1] = 0;
        mtArr[i * 3 + 2] = 0;
        continue;
      }
      const nextRem = rem - dt;
      this.life[i] = nextRem;
      if (nextRem <= 0) {
        scArr[i * 2] = 0;
        scArr[i * 2 + 1] = 0;
        mtArr[i * 3 + 2] = 0;
        continue;
      }
      alive++;
      const age = 1 - nextRem / this.maxLife[i];
      const i3 = i * 3;
      let vx = this.vel[i3] * dragK;
      let vy = (this.vel[i3 + 1] - 14.5 * dt) * dragK;
      let vz = this.vel[i3 + 2] * dragK;

      let px = posArr[i3] + vx * dt;
      let py = posArr[i3 + 1] + vy * dt;
      let pz = posArr[i3 + 2] + vz * dt;

      // Real ground bounce at y = groundY with asphalt friction & micro-scatter
      const gy = this.groundY[i];
      if (py < gy) {
        py = gy + 0.01;
        if (vy < -0.6) {
          vy = -vy * 0.38;
          vx = vx * 0.78 + (Math.random() - 0.5) * 1.4;
          vz = vz * 0.78 + (Math.random() - 0.5) * 1.4;
        } else {
          vy = 0;
          vx *= 0.85;
          vz *= 0.85;
        }
      }

      this.vel[i3] = vx;
      this.vel[i3 + 1] = vy;
      this.vel[i3 + 2] = vz;
      posArr[i3] = px;
      posArr[i3 + 1] = py;
      posArr[i3 + 2] = pz;

      // Project velocity onto camera plane to align stretched spark streak
      const sx = vx * rx + vy * ry + vz * rz;
      const sy = vx * ux + vy * uy + vz * uz;
      const screenSpd = Math.hypot(sx, sy);
      const thick = this.baseSize[i] * (1 - age * 0.45);
      const streakLen = thick * Math.min(14, Math.max(2.2, 2.2 + screenSpd * 0.55));
      scArr[i * 2] = streakLen;
      scArr[i * 2 + 1] = thick;
      rotArr[i] = screenSpd > 0.05 ? Math.atan2(sy, sx) : 0;
      mtArr[i * 3] = age;
    }

    this.active = alive;
    this.pos.needsUpdate = this.scale2.needsUpdate = this.rot.needsUpdate = this.meta.needsUpdate = true;
    this.sprite.visible = alive > 0;
  }

  clear() {
    if (!this.dirtyClear && this.active === 0) return;
    this.life.fill(0);
    this.active = 0;
    const scArr = this.scale2.array as Float32Array;
    const mtArr = this.meta.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      scArr[i * 2] = 0;
      scArr[i * 2 + 1] = 0;
      mtArr[i * 3 + 2] = 0;
    }
    this.scale2.needsUpdate = this.meta.needsUpdate = true;
    this.sprite.visible = false;
    this.dirtyClear = false;
  }

  warmup(on: boolean) {
    this.sprite.count = 1;
    this.sprite.visible = on;
  }
}

// --- Layer 4: High-Speed Rain Streaks / Wind-Warp Motes (80 camera-relative streaks) -----------------------------

class RainStreakPool {
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly scale2: THREE.InstancedBufferAttribute;
  private readonly rot: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly seed: Float32Array;
  private initialized = false;
  readonly sprite: THREE.Sprite;

  constructor(private readonly max = RAIN_MAX) {
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.scale2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.rot = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.seed = new Float32Array(max);
    for (let i = 0; i < max; i++) this.seed[i] = Math.random();

    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.positionNode = instancedBufferAttribute(this.pos);
    m.scaleNode = instancedBufferAttribute(this.scale2, 'vec2') as unknown as THREE.Node<'vec2'>;
    m.rotationNode = instancedBufferAttribute(this.rot) as unknown as THREE.Node<'float'>;

    const op = instancedBufferAttribute(this.alphaAttr) as unknown as THREE.Node<'float'>;
    const p = uv().sub(0.5);
    const along = smoothstep(float(-0.5), float(0.0), p.x).mul(smoothstep(float(0.5), float(0.0), p.x));
    const across = pow(smoothstep(float(0.5), float(0.0), abs(p.y)), float(2.0));
    const streak = along.mul(across);
    // Subtle cool cyan-silver street-lit mist streaks
    m.colorNode = vec4(vec3(0.76, 0.86, 1.0).mul(1.25), streak.mul(op));

    this.sprite = new THREE.Sprite(m);
    this.sprite.name = 'forza_speed_rain';
    this.sprite.count = 1;
    this.sprite.visible = false;
    this.sprite.frustumCulled = false;
  }

  private respawnMote(
    i: number,
    camPos: THREE.Vector3,
    camFwd: THREE.Vector3,
    camRight: THREE.Vector3,
    camUp: THREE.Vector3,
    depthMin: number,
    depthMax: number,
  ) {
    const d = depthMin + Math.random() * (depthMax - depthMin);
    // Bias motes slightly toward the peripheral vision ring for authentic Forza high-speed warp
    let sx = (Math.random() - 0.5) * 18.0;
    let sy = (Math.random() - 0.32) * 9.5;
    if (Math.abs(sx) < 1.8 && Math.abs(sy) < 1.2) sx += sx >= 0 ? 2.2 : -2.2;
    const i3 = i * 3;
    const posArr = this.pos.array as Float32Array;
    posArr[i3] = camPos.x + camFwd.x * d + camRight.x * sx + camUp.x * sy;
    posArr[i3 + 1] = camPos.y + camFwd.y * d + camRight.y * sx + camUp.y * sy;
    posArr[i3 + 2] = camPos.z + camFwd.z * d + camRight.z * sx + camUp.z * sy;
  }

  update(
    dt: number,
    active: boolean,
    speedMps: number,
    roadWetness: number,
    carVel: THREE.Vector3,
    camPos: THREE.Vector3,
    camFwd: THREE.Vector3,
    camRight: THREE.Vector3,
    camUp: THREE.Vector3,
    lowPower: boolean,
  ) {
    // Active above 90 km/h (25 m/s) when roadWetness > 0.25
    const speedFactor = THREE.MathUtils.smoothstep(speedMps, 25.0, 62.0);
    const wetFactor = THREE.MathUtils.smoothstep(roadWetness, 0.25, 0.72);
    const strength = active ? speedFactor * wetFactor : 0;

    if (strength <= 0.01) {
      if (this.sprite.visible) this.sprite.visible = false;
      this.initialized = false;
      return;
    }

    const useCount = lowPower ? Math.min(this.max, 48) : this.max;
    const posArr = this.pos.array as Float32Array;
    const scArr = this.scale2.array as Float32Array;
    const rotArr = this.rot.array as Float32Array;
    const alArr = this.alphaAttr.array as Float32Array;

    if (!this.initialized) {
      for (let i = 0; i < useCount; i++) {
        this.respawnMote(i, camPos, camFwd, camRight, camUp, 3.0, 26.0);
      }
      this.initialized = true;
    }

    // Relative rain velocity = downward rain (-6.8 m/s) minus car velocity (with camera wind-warp multiplier)
    const rvx = -carVel.x * 0.85;
    const rvy = -6.8 - carVel.y * 0.5;
    const rvz = -carVel.z * 0.85;

    const rx = camRight.x, ry = camRight.y, rz = camRight.z;
    const ux = camUp.x, uy = camUp.y, uz = camUp.z;
    const fx = camFwd.x, fy = camFwd.y, fz = camFwd.z;
    const cx = camPos.x, cy = camPos.y, cz = camPos.z;

    for (let i = 0; i < useCount; i++) {
      const i3 = i * 3;
      let px = posArr[i3] + rvx * dt;
      let py = posArr[i3 + 1] + rvy * dt;
      let pz = posArr[i3 + 2] + rvz * dt;

      const dx = px - cx, dy = py - cy, dz = pz - cz;
      const forwardDist = dx * fx + dy * fy + dz * fz;
      const lateralDist = Math.abs(dx * rx + dy * ry + dz * rz);
      const vertDist = Math.abs(dx * ux + dy * uy + dz * uz);

      if (forwardDist < 1.6 || forwardDist > 28.0 || lateralDist > 14.0 || vertDist > 9.0) {
        this.respawnMote(i, camPos, camFwd, camRight, camUp, 12.0, 26.0);
        px = posArr[i3];
        py = posArr[i3 + 1];
        pz = posArr[i3 + 2];
      } else {
        posArr[i3] = px;
        posArr[i3 + 1] = py;
        posArr[i3 + 2] = pz;
      }

      // Radial wind-warp direction: combines actual rain motion + subtle perspective expansion away from screen center
      const ddx = px - cx, ddy = py - cy, ddz = pz - cz;
      const projX = ddx * rx + ddy * ry + ddz * rz;
      const projY = ddx * ux + ddy * uy + ddz * uz;
      const sx = rvx * rx + rvy * ry + rvz * rz + projX * (0.6 + speedFactor * 1.4);
      const sy = rvx * ux + rvy * uy + rvz * uz + projY * (0.6 + speedFactor * 1.4);
      const screenSpd = Math.hypot(sx, sy);

      const s = this.seed[i];
      const len = (0.35 + speedFactor * 1.25) * (0.7 + s * 0.6);
      const thick = 0.016 + s * 0.012;
      scArr[i * 2] = len;
      scArr[i * 2 + 1] = thick;
      rotArr[i] = screenSpd > 0.05 ? Math.atan2(sy, sx) : -Math.PI * 0.5;
      // Soft depth fade near camera and far clip
      const fDist = Math.max(0.1, ddx * fx + ddy * fy + ddz * fz);
      const depthFade = THREE.MathUtils.smoothstep(fDist, 2.0, 5.5) * (1 - THREE.MathUtils.smoothstep(fDist, 19.0, 26.5));
      alArr[i] = strength * depthFade * (0.16 + s * 0.22);
    }

    for (let i = useCount; i < this.max; i++) {
      scArr[i * 2] = 0;
      scArr[i * 2 + 1] = 0;
      alArr[i] = 0;
    }

    this.pos.needsUpdate = this.scale2.needsUpdate = this.rot.needsUpdate = this.alphaAttr.needsUpdate = true;
    this.sprite.count = useCount;
    this.sprite.visible = true;
  }

  clear() {
    this.initialized = false;
    this.sprite.visible = false;
  }

  warmup(on: boolean) {
    this.sprite.count = 1;
    this.sprite.visible = on;
  }
}

// --- Main Controller: ForzaVfxController -------------------------------------------------------------------------

export class ForzaVfxController {
  private readonly smoke: SmokePool | null;
  private readonly spray: SprayPool | null;
  private readonly sparks: SparkPool | null;
  private readonly rain: RainStreakPool | null;
  private readonly lowPower: boolean;

  /** Physical per-wheel carbon-ceramic brake rotor temperature in Celsius [FL, FR, RL, RR] (20..920 C). */
  readonly rotorTempC: [number, number, number, number] = [40, 40, 40, 40];
  /** Peak rotor temperature across all 4 wheels (C) — fed into GameAudio.updateBrakes(). */
  peakRotorTempC = 40;
  /** Average rotor temperature across all 4 wheels (C). */
  avgRotorTempC = 40;
  /** Suspension thump intensity triggered on this frame (0 = none, 0..1 = curb strike / hard landing). */
  suspensionThump = 0;

  // Per-wheel emission accumulators & suspension history (zero allocations)
  private readonly smokeAcc = new Float32Array(4);
  private readonly sprayAcc = new Float32Array(4);
  private readonly prevComp = new Float32Array(4);
  private readonly prevContact = new Uint8Array(4);
  private thumpCooldown = 0;
  private scrapeSparkCooldown = 0;
  private hasPrevSusp = false;

  // Pre-allocated scratch vectors (NEVER allocate inside update!)
  private readonly _carFwd = new THREE.Vector3();
  private readonly _carRight = new THREE.Vector3();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _camRight = new THREE.Vector3();
  private readonly _camUp = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();

  constructor(scene: THREE.Scene, opts: ForzaVfxOptions = {}) {
    const enableParticles = opts.particles !== false;
    this.lowPower = !!opts.lowPower;
    if (enableParticles) {
      this.smoke = new SmokePool(SMOKE_MAX);
      this.spray = new SprayPool(SPRAY_MAX);
      this.sparks = new SparkPool(SPARK_MAX);
      this.rain = new RainStreakPool(RAIN_MAX);
      scene.add(this.smoke.sprite, this.spray.sprite, this.sparks.sprite, this.rain.sprite);
    } else {
      this.smoke = this.spray = this.sparks = this.rain = null;
    }
  }

  /** Compile all 4 particle WGSL pipelines during the loading screen (zero mid-drive hitches). */
  warmup(on: boolean) {
    this.smoke?.warmup(on);
    this.spray?.warmup(on);
    this.sparks?.warmup(on);
    this.rain?.warmup(on);
  }

  /** Clear all particles and cool brake rotors back to ambient (used on car reset / entering garage). */
  reset(coolRotors = true) {
    this.smoke?.clear();
    this.spray?.clear();
    this.sparks?.clear();
    this.rain?.clear();
    this.smokeAcc.fill(0);
    this.sprayAcc.fill(0);
    this.hasPrevSusp = false;
    this.suspensionThump = 0;
    this.thumpCooldown = 0;
    if (coolRotors) {
      this.rotorTempC[0] = this.rotorTempC[1] = this.rotorTempC[2] = this.rotorTempC[3] = 40;
      this.peakRotorTempC = 40;
      this.avgRotorTempC = 40;
    }
  }

  /**
   * Emit a burst of titanium scrape / curb-strike / collision sparks at a world point.
   * Zero allocations: all arguments are primitive scalars.
   */
  emitSparks(
    px: number, py: number, pz: number,
    baseVx: number, baseVy: number, baseVz: number,
    count: number, intensity = 1, groundY = 0,
  ) {
    if (!this.sparks) return;
    const n = Math.min(28, Math.max(1, Math.round(count * (this.lowPower ? 0.6 : 1))));
    const spdScale = 3.5 + intensity * 6.5;
    for (let k = 0; k < n; k++) {
      const ang = Math.random() * Math.PI * 2;
      const spread = (0.35 + Math.random() * 0.85) * spdScale;
      const vx = baseVx * 0.55 + Math.cos(ang) * spread;
      const vy = Math.max(1.2, baseVy * 0.3 + (0.45 + Math.random() * 1.15) * (2.6 + intensity * 3.8));
      const vz = baseVz * 0.55 + Math.sin(ang) * spread;
      const life = 0.24 + Math.random() * (0.34 + intensity * 0.24);
      const thick = 0.022 + Math.random() * 0.022 * Math.min(1.5, intensity);
      const energy = Math.min(1.4, 0.72 + Math.random() * 0.55 * intensity);
      this.sparks.emit(
        px + (Math.random() - 0.5) * 0.16,
        Math.max(groundY + 0.04, py + (Math.random() - 0.5) * 0.12),
        pz + (Math.random() - 0.5) * 0.16,
        vx, vy, vz, life, thick, energy, groundY,
      );
    }
  }

  /** Per-frame update: integrates brake thermals, suspension thumps, and all 4 pooled particle layers. */
  update(f: ForzaVfxFrameInput) {
    const dt = Math.min(0.05, Math.max(0, f.dt));
    this.suspensionThump = 0;
    if (this.thumpCooldown > 0) this.thumpCooldown = Math.max(0, this.thumpCooldown - dt);
    if (this.scrapeSparkCooldown > 0) this.scrapeSparkCooldown = Math.max(0, this.scrapeSparkCooldown - dt);

    // Extract camera basis directly from camera.matrixWorld (zero allocations!)
    const cm = f.camera.matrixWorld.elements;
    this._camRight.set(cm[0], cm[1], cm[2]).normalize();
    this._camUp.set(cm[4], cm[5], cm[6]).normalize();
    this._camFwd.set(-cm[8], -cm[9], -cm[10]).normalize();
    this._camPos.set(cm[12], cm[13], cm[14]);

    // Extract car heading & right vectors
    this._carFwd.set(0, 0, 1).applyQuaternion(f.carQuat);
    this._carRight.set(1, 0, 0).applyQuaternion(f.carQuat);

    const out = f.out;
    const speedMps = Math.abs(out[OUT.speed] || 0);
    const brakePressure = THREE.MathUtils.clamp(out[OUT.brake] || 0, 0, 1);
    const handbrake = THREE.MathUtils.clamp(f.handbrake || 0, 0, 1);
    const wetness = THREE.MathUtils.clamp(f.roadWetness || 0, 0, 1);
    const outValid = (out[OUT.wheel(0)] !== 0 || out[OUT.wheel(0) + 1] !== 0 || out[OUT.wheel(0) + 2] !== 0
      || out[OUT.wheel(1)] !== 0 || out[OUT.wheel(1) + 2] !== 0);

    // --- 1. Physical 4-Wheel Brake Rotor Thermal Integrator + 4-Wheel Smoke/Spray/Suspension ---
    let peakT = 20;
    let sumT = 0;
    let maxThump = 0;
    const ambientC = 20;
    const rateScale = this.lowPower ? 0.62 : 1.0;

    if (dt > 0) {
      for (let i = 0; i < 4; i++) {
        const o = OUT.wheel(i);
        const wRadius = f.wheelRadii[i] || 0.34;
        const contact = outValid ? out[o + 5] > 0.5 : false;
        const loadN = outValid ? Math.max(0, out[o + 6] || 0) : 3400;
        const slipRatio = outValid ? Math.abs(out[o + 7] || 0) : 0;
        const slipAngle = outValid ? Math.abs(out[o + 8] || 0) : 0;
        const compression = outValid ? (out[o + 9] || 0) : 0;
        const omega = outValid ? Math.abs(out[o + 10] || 0) : 0;
        const surface = outValid ? (out[o + 11] || 0) : f.asphaltSurfaceId;
        const coreBrakeT = outValid ? (out[OUT.brakeTemp(i)] || 0) : 0;
        const treadC = outValid ? (out[OUT.treadSurface(i)] || 65) : 65;

        // World contact patch position directly under the wheel hub
        const wx = outValid ? out[o] : f.carPos.x;
        const wy = outValid ? (out[o + 1] - wRadius + 0.05) : Math.max(0.05, f.carPos.y - 0.45);
        const wz = outValid ? out[o + 2] : f.carPos.z;
        const groundY = Math.max(-20, wy - 0.04);

        // --- A. Brake Rotor Thermal Balance ---
        let T = this.rotorTempC[i];
        if (f.active) {
          const brakeEff = i < 2 ? brakePressure : Math.max(brakePressure, handbrake * 0.92);
          const wheelSpd = Math.max(omega * wRadius, speedMps * 0.45);
          // Only heat when rolling + braking
          const rollingBrake = speedMps > 0.6 ? brakeEff : 0;
          const loadFactor = THREE.MathUtils.clamp(loadN / 3400, 0.25, 2.2);
          const axleBias = i < 2 ? 1.22 : 0.74;
          const heatRate = rollingBrake * Math.min(88, wheelSpd) * loadFactor * axleBias * 3.2;

          // Convective airflow + wet mist + high-temp radiative cooling
          const hConv = 0.052 + 0.0044 * speedMps + 0.048 * wetness;
          const tNorm = Math.max(0, (T - ambientC) / 880);
          const radCool = 52 * tNorm * tNorm * tNorm;
          const coolRate = (T - ambientC) * hConv + radCool;

          T = THREE.MathUtils.clamp(T + (heatRate - coolRate) * dt, ambientC, 920);
          // Respect C++ core brake temperature if C++ has soaked even hotter
          if (coreBrakeT > T && coreBrakeT <= 960) {
            T += (Math.min(920, coreBrakeT) - T) * Math.min(1, dt * 1.8);
          }
        } else {
          // Cool gently in menus/garage
          T = ambientC + (T - ambientC) * Math.exp(-0.22 * dt);
        }
        this.rotorTempC[i] = T;
        if (T > peakT) peakT = T;
        sumT += T;

        // --- B. Suspension Thump & Curb/Bottom-Out Sparks ---
        if (f.active && outValid) {
          if (this.hasPrevSusp) {
            const wasContact = this.prevContact[i] === 1;
            const dComp = compression - this.prevComp[i];
            const compRate = dComp / Math.max(0.004, dt);

            // Hard airborne touchdown
            if (!wasContact && contact && loadN > 5200) {
              const landInt = THREE.MathUtils.clamp((loadN - 4800) / 11000, 0.22, 1.0);
              if (landInt > maxThump) maxThump = landInt;
              if (landInt > 0.48 && speedMps > 12 && this.scrapeSparkCooldown <= 0) {
                this.emitSparks(wx, wy + 0.04, wz, f.carVel.x, f.carVel.y, f.carVel.z, 7 + landInt * 8, landInt, groundY);
                this.scrapeSparkCooldown = 0.14;
              }
            } else if (contact && speedMps > 7) {
              // Sharp curb hit / pothole jolt / compression bottom-out
              const onCurb = surface !== f.asphaltSurfaceId;
              const spikeThresh = onCurb ? 0.55 : 1.05;
              if (compRate > spikeThresh && loadN > 4600) {
                const th = THREE.MathUtils.clamp((compRate - spikeThresh) * 0.42 + (onCurb ? 0.22 : 0), 0.16, 0.92);
                if (th > maxThump) maxThump = th;
                // Titanium undertray bottom-out sparks at high speed over curbs
                if ((compression > 0.12 || th > 0.62) && speedMps > 24 && this.scrapeSparkCooldown <= 0) {
                  this.emitSparks(wx, wy + 0.04, wz, f.carVel.x, 0.8, f.carVel.z, 5 + th * 6, 0.75, groundY);
                  this.scrapeSparkCooldown = 0.16;
                }
              }
            }
          }
          this.prevComp[i] = compression;
          this.prevContact[i] = contact ? 1 : 0;
        }

        // --- C. Volumetric 4-Wheel Drift & Front-Lockup Tyre Smoke ---
        if (this.smoke && f.active && outValid && contact) {
          // Only smoke when genuinely sliding past peak grip (~10.5 deg drift or >38% burnout/lockup slip),
          // NEVER during normal clean cruising, mild acceleration, or routine cornering.
          const latSlip = slipAngle / 0.42;
          const combinedSlip = Math.hypot(slipRatio, latSlip);
          const isFrontLockup = i < 2 && brakePressure > 0.45 && slipRatio > 0.32 && speedMps > 6.5;
          const isSlideOrSpin = combinedSlip > 0.42 && (speedMps > 2.5 || omega * wRadius > 6.5);

          if (isFrontLockup || isSlideOrSpin) {
            // Wet roads dampen dry rubber smoke slightly while water spray intensifies
            const wetDamp = 1 - wetness * 0.42;
            const intensity = THREE.MathUtils.clamp((combinedSlip - 0.36) * 1.15, 0.12, 1.35) * wetDamp;
            const emitHz = (14 + intensity * 26) * rateScale;
            this.smokeAcc[i] += emitHz * dt;

            // Warm rubber tint shifts from crisp cool lockup grey -> warm creamy hot-rubber billow
            const tempWarm = THREE.MathUtils.smoothstep(treadC, 60, 125);
            const r = 0.72 + tempWarm * 0.14;
            const g = 0.73 + tempWarm * 0.10;
            const b = 0.78 + tempWarm * 0.02;

            const sideSign = (i === 0 || i === 2) ? -1 : 1;
            let spawned = 0;
            while (this.smokeAcc[i] >= 1 && spawned < 3) {
              this.smokeAcc[i] -= 1;
              spawned++;
              const jitterX = (Math.random() - 0.5) * 0.22;
              const jitterZ = (Math.random() - 0.5) * 0.22;
              // Velocity carries slight car momentum + outward swirl + rising billow
              const carry = 0.22;
              const outThrow = sideSign * (0.45 + Math.random() * 0.9) * Math.min(1.2, latSlip);
              const vx = f.carVel.x * carry + this._carRight.x * outThrow - this._carFwd.x * (0.8 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.9;
              const vy = 0.55 + Math.random() * 0.85 + intensity * 0.45;
              const vz = f.carVel.z * carry + this._carRight.z * outThrow - this._carFwd.z * (0.8 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.9;
              const life = (0.85 + Math.random() * 0.75) * (0.85 + intensity * 0.25);
              const initSize = (isFrontLockup ? 0.28 : 0.34) + Math.min(0.42, intensity * 0.34);
              const grow = 1.25 + intensity * 0.85;
              const alpha = THREE.MathUtils.clamp((0.14 + intensity * 0.16) * (isFrontLockup ? 1.05 : 1.0), 0.08, 0.34);
              const swirl = (Math.random() - 0.5) * (1.5 + intensity * 2.2);
              this.smoke.emit(
                wx + jitterX, wy + 0.04, wz + jitterZ,
                vx, vy, vz, life, initSize, grow, r, g, b, alpha, swirl,
              );
            }
            if (this.smokeAcc[i] > 3) this.smokeAcc[i] = 3;
          } else {
            this.smokeAcc[i] = 0;
          }
        }

        // --- D. Wet-Road Rooster-Tail Water Spray Plumes ---
        // Only spray rooster-tail mist when there is actual standing rain/water (wetness > 0.50),
        // NOT on dry clear-night asphalt specular sheen (wetness ~0.22-0.42).
        if (this.spray && f.active && outValid && contact && wetness > 0.50 && speedMps > 9.0) {
          const speedNorm = THREE.MathUtils.clamp((speedMps - 9.0) / 48.0, 0.08, 1.35);
          const wetNorm = THREE.MathUtils.smoothstep(wetness, 0.50, 0.95);
          const isRear = i >= 2;
          // Rear tyres throw taller, denser rooster-tails; front tyres throw low side mist
          const axleMul = isRear ? 1.25 : 0.65;
          const emitHz = (9 + speedNorm * 24) * wetNorm * axleMul * rateScale;
          this.sprayAcc[i] += emitHz * dt;

          const sideSign = (i === 0 || i === 2) ? -1 : 1;
          let spawned = 0;
          while (this.sprayAcc[i] >= 1 && spawned < 2) {
            this.sprayAcc[i] -= 1;
            spawned++;
            const backKick = (3.0 + speedNorm * 7.5) * (0.75 + Math.random() * 0.5);
            const upArc = (isRear ? 1.55 : 0.95) + speedNorm * (isRear ? 2.4 : 1.2) + Math.random() * 0.85;
            const sideSplay = sideSign * (0.55 + Math.random() * 1.15) * (0.6 + speedNorm * 0.5);
            const vx = f.carVel.x * 0.52 - this._carFwd.x * backKick + this._carRight.x * sideSplay;
            const vy = upArc;
            const vz = f.carVel.z * 0.52 - this._carFwd.z * backKick + this._carRight.z * sideSplay;
            const life = 0.34 + Math.random() * 0.28 + speedNorm * 0.14;
            const initSize = (isRear ? 0.36 : 0.28) + speedNorm * 0.34;
            const grow = 1.65 + speedNorm * 1.8;
            const alpha = THREE.MathUtils.clamp(0.08 + wetNorm * speedNorm * (isRear ? 0.16 : 0.10), 0.04, 0.25);
            this.spray.emit(
              wx - this._carFwd.x * 0.24 + (Math.random() - 0.5) * 0.14,
              wy + 0.08,
              wz - this._carFwd.z * 0.24 + (Math.random() - 0.5) * 0.14,
              vx, vy, vz, life, initSize, grow, alpha,
            );
          }
          if (this.sprayAcc[i] > 2) this.sprayAcc[i] = 2;
        } else {
          this.sprayAcc[i] = 0;
        }
      }

      if (f.active && outValid) this.hasPrevSusp = true;
      else this.hasPrevSusp = false;

      this.peakRotorTempC = peakT;
      this.avgRotorTempC = sumT * 0.25;

      if (maxThump > 0.08 && this.thumpCooldown <= 0) {
        this.suspensionThump = maxThump;
        this.thumpCooldown = 0.11;
      }
    }

    // --- 2. Advance all 4 GPU particle pools (1 draw call per active layer) ---
    if (dt > 0) {
      this.smoke?.update(dt);
      this.spray?.update(dt);
      this.sparks?.update(dt, this._camRight, this._camUp);
      this.rain?.update(
        dt, f.active, speedMps, wetness, f.carVel,
        this._camPos, this._camFwd, this._camRight, this._camUp, this.lowPower,
      );
    }
  }
}
