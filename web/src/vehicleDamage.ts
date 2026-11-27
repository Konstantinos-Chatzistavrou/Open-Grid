// Apache-2.0 — Exact-parity crash damage & durability simulation + GPU dent/smoke visuals for AI racers and Police Interceptors.
// Mirrors `core/include/rs/damage.hpp` and `core/src/damage.cpp` 1:1 (same two-layer energy math, same structural bands,
// same engine/cabin/wheel durability thresholds, same limp-home power floor, same GPU vertex-shader Dents & hood smoke/sparks).
import * as THREE from 'three/webgpu';
import { Dents } from './scene/dents';
import { Particles } from './scene/damage';
import { materialsOf } from './scene/city';

export const ZONE_FRONT = 0;
export const ZONE_REAR = 1;
export const ZONE_LEFT = 2;
export const ZONE_RIGHT = 3;

const G = 9.81;
const SKIP_DENT_RE = /wheel_|Wheel|caliper_|interior|seat|dashboard|steering|wheel_well|underbody|hood_inner|glass|lightbar|strobe|antenna/i;
const INWARD = [
  new THREE.Vector3(0, 0, -1), // front -> push backward
  new THREE.Vector3(0, 0, 1),  // rear -> push forward
  new THREE.Vector3(-1, 0, 0), // left (+X in model space) -> push right (-X)
  new THREE.Vector3(1, 0, 0),  // right (-X in model space) -> push left (+X)
];

/** Exact DamageParams defaults from `core/include/rs/damage.hpp`. */
export const CORE_DAMAGE_PARAMS = {
  stiffnessFrontRear: 1.0e6,  // N/m
  stiffnessSide: 0.35e6,      // N/m
  frontMax: 0.65,             // m
  rearMax: 0.70,              // m
  sideMax: 0.40,              // m
  minImpulse: 600.0,          // N*s (~1.5 km/h dv)
  minForceG: 3.0,             // g (gentle bumps/pushes never dent or break structure)
  heavyDvLo: 9.0,             // m/s (~32 km/h)
  heavyDvHi: 18.0,            // m/s (~65 km/h)
  engineStart: 150.0,         // kJ/t
  engineFull: 600.0,          // kJ/t
  engineOtherShare: 0.25,
  cabinTotal: 300.0,          // kJ/t into one side -> totaled
  wheelDvLo: 8.5,             // m/s
  wheelDvHi: 17.5,            // m/s
  wheelEnergy: 165.0,         // kJ/t per wheel
  wheelZoneShare: 0.28,
  totaledEngine: 0.90,
  limpPower: 0.25,            // matches player's limp-home floor
  severityFull: 1200.0,       // kJ/t
  overheatSeverity: 0.50,
  fireSeverity: 0.90,
  smoulderS: 20.0,
  fireGrowS: 45.0,
  headlightKj: 15.0,
  lightsCrush: 0.12,
  flickerS: 2.0,
} as const;

/** Exact integral `band_energy(dv, lo, hi)` from `core/src/damage.cpp` (returns J/kg = kJ/t * 1000). */
function bandEnergyJkg(dv: number, lo: number, hi: number): number {
  if (dv <= lo) return 0;
  const part = (u: number) => (u * u * u / 3 - lo * u * u / 2) / (hi - lo);
  if (dv <= hi) return part(dv) - part(lo);
  return part(hi) - part(lo) + 0.5 * (dv * dv - hi * hi);
}

export interface RoadObstacle {
  x: number;
  z: number;
  v: number;
  lat: number;
  radius?: number;
  isCop?: boolean;
  isBlock?: boolean;
}

export interface ImpactHitResult {
  zone: number;
  energyKj: number;
  justTotaled: boolean;
  crushDepthM: number;
  localPoint: THREE.Vector3;
}

/**
 * Exact TypeScript mirror of `rs::DamageModel` (`core/src/damage.cpp`) so every AI racer and Police Interceptor
 * has the exact same crash durability, panel crush, engine power loss, wheel alignment bend, headlight failure,
 * and total threshold as the player's car.
 */
export class CoreDamageSim {
  readonly massKg: number;
  readonly zoneEnergy = [0, 0, 0, 0];        // J
  readonly crush = [0, 0, 0, 0];             // m
  readonly zone = [0, 0, 0, 0];              // 0..1
  readonly wheel = [0, 0, 0, 0];             // 0..1 (FL, FR, RL, RR)
  readonly sideStructKjt = [0, 0];           // left, right kJ/t
  engineEnergyKjt = 0;
  structuralKjt = 0;
  engine = 0;                                // 0..1
  severity = 0;                              // 0..1
  smoulder = 0;                              // 0..1
  fire = 0;                                  // 0..1
  totaled = false;
  headlightsBroken = false;
  headlightFlickerT = 0;
  totalEnergyKj = 0;

  // Per-event accumulator (same 0.15 s window as `DamageModel::events_` in damage.cpp)
  private eventId = -1;
  private eventTime = -1;
  private eventJ = 0;
  private clock = 0;

  constructor(massKg = 1520) {
    this.massKg = Math.max(850, massKg);
  }

  reset() {
    this.zoneEnergy.fill(0);
    this.crush.fill(0);
    this.zone.fill(0);
    this.wheel.fill(0);
    this.sideStructKjt.fill(0);
    this.engineEnergyKjt = 0;
    this.structuralKjt = 0;
    this.engine = 0;
    this.severity = 0;
    this.smoulder = 0;
    this.fire = 0;
    this.totaled = false;
    this.headlightsBroken = false;
    this.headlightFlickerT = 0;
    this.totalEnergyKj = 0;
    this.eventId = -1;
    this.eventTime = -1;
    this.eventJ = 0;
    this.clock = 0;
  }

  /** Engine power multiplier (1.0 intact -> limpPower 0.25 when engine wrecked). */
  get powerScale(): number {
    return 1 - (1 - CORE_DAMAGE_PARAMS.limpPower) * Math.min(1, this.engine);
  }

  /** Cornering grip multiplier (1.0 intact -> 0.58 with severe suspension/wheel damage). */
  get gripScale(): number {
    const avgW = (this.wheel[0] + this.wheel[1] + this.wheel[2] + this.wheel[3]) * 0.25;
    return Math.max(0.55, 1 - avgW * 0.42 - this.severity * 0.12);
  }

  /** Asymmetric front wheel damage causes subtle steering pull (-left / +right). */
  get steerPull(): number {
    return (this.wheel[1] - this.wheel[0]) * 0.45;
  }

  /** Aero/body crush drag multiplier (crushed panels increase drag slightly like core). */
  get dragScale(): number {
    return 1 + (this.zone[0] * 0.35 + this.zone[1] * 0.18 + (this.zone[2] + this.zone[3]) * 0.12);
  }

  /** Step thermal progression (overheating steam -> fire, headlight flicker countdown). */
  step(dt: number) {
    this.clock += dt;
    if (this.headlightFlickerT > 0) this.headlightFlickerT = Math.max(0, this.headlightFlickerT - dt);
    const p = CORE_DAMAGE_PARAMS;
    if (this.severity >= p.overheatSeverity) {
      this.smoulder = Math.min(1, this.smoulder + dt / p.smoulderS);
    }
    if (this.severity >= p.fireSeverity && this.smoulder >= 0.95) {
      this.fire = Math.min(1, this.fire + dt / p.fireGrowS);
    }
  }

  /**
   * Apply a crash impulse given speed change `dv` (m/s), model-space impact point `(lx, ly, lz)`
   * (where +Z = front, -Z = rear, +X = left, -X = right), tick `dt`, and contact source id.
   */
  addImpact(dv: number, lx: number, ly: number, lz: number, dt: number, sourceId = 1): ImpactHitResult | null {
    if (dv <= 0.01) return null;
    const p = CORE_DAMAGE_PARAMS;
    const impulse = dv * this.massKg;
    const forceG = impulse / (Math.max(dt, 1e-4) * this.massKg * G);
    if (forceG < p.minForceG) return null;

    // Zone classification matching `damage.cpp` (model space +Z front, +X left)
    const zone = Math.abs(lz) > 1.15 * Math.abs(lx)
      ? (lz >= 0 ? ZONE_FRONT : ZONE_REAR)
      : (lx >= 0 ? ZONE_LEFT : ZONE_RIGHT);

    if (this.eventId !== sourceId || this.eventTime < 0 || this.clock - this.eventTime > 0.15) {
      this.eventId = sourceId;
      this.eventJ = 0;
    }
    this.eventTime = this.clock;
    const j0 = this.eventJ;
    const j1 = j0 + impulse;
    this.eventJ = j1;

    const energy = (j: number) => {
      const jj = Math.max(0, j - p.minImpulse);
      return (jj * jj) / (2 * this.massKg);
    };
    const de = energy(j1) - energy(j0); // Joules
    if (de <= 0) return null;

    const deKj = de / 1000;
    const eventKj = energy(j1) / 1000;
    this.totalEnergyKj += deKj;

    // ---- Layer 1: Panel crush ----
    this.zoneEnergy[zone] += de;
    const kZone = zone <= ZONE_REAR ? p.stiffnessFrontRear : p.stiffnessSide;
    this.crush[zone] = Math.sqrt((2 * this.zoneEnergy[zone]) / kZone);
    const full = zone === ZONE_FRONT ? p.frontMax : zone === ZONE_REAR ? p.rearMax : p.sideMax;
    this.zone[zone] = Math.min(1, this.crush[zone] / full);

    if (zone === ZONE_FRONT && !this.headlightsBroken && (eventKj >= p.headlightKj || this.crush[ZONE_FRONT] >= p.lightsCrush)) {
      this.headlightsBroken = true;
      this.headlightFlickerT = p.flickerS;
    }

    // ---- Layer 2: Structural energy (1 J/kg === 1 kJ/t — exact match to core/src/damage.cpp!) ----
    const dv0 = j0 / this.massKg;
    const dv1 = j1 / this.massKg;
    const dStructKjt = bandEnergyJkg(dv1, p.heavyDvLo, p.heavyDvHi) - bandEnergyJkg(dv0, p.heavyDvLo, p.heavyDvHi);
    const dWheelKjt = bandEnergyJkg(dv1, p.wheelDvLo, p.wheelDvHi) - bandEnergyJkg(dv0, p.wheelDvLo, p.wheelDvHi);

    if (dStructKjt > 0) {
      this.structuralKjt += dStructKjt;
      const engShare = zone === ZONE_FRONT ? 1.0 : p.engineOtherShare;
      this.engineEnergyKjt += dStructKjt * engShare;
      this.engine = Math.max(0, Math.min(1, (this.engineEnergyKjt - p.engineStart) / (p.engineFull - p.engineStart)));

      if (zone === ZONE_LEFT) this.sideStructKjt[0] += dStructKjt;
      if (zone === ZONE_RIGHT) this.sideStructKjt[1] += dStructKjt;

      // Zone structural load also reaches wheels in that zone
      for (let w = 0; w < 4; w++) {
        const inZone = zone === ZONE_FRONT ? w < 2 : zone === ZONE_REAR ? w >= 2 : zone === ZONE_LEFT ? w % 2 === 0 : w % 2 === 1;
        if (inZone) this.wheel[w] = Math.min(1, this.wheel[w] + (dStructKjt * p.wheelZoneShare) / p.wheelEnergy);
      }
    }
    if (dWheelKjt > 0) {
      // Closest wheel takes direct suspension energy
      const wi = (lz >= 0 ? 0 : 2) + (lx >= 0 ? 0 : 1);
      this.wheel[wi] = Math.min(1, this.wheel[wi] + (dWheelKjt * 0.5) / p.wheelEnergy);
    }

    this.severity = Math.min(1, Math.max(this.engine, this.structuralKjt / p.severityFull));
    const wasTotaled = this.totaled;
    if (
      this.engine >= p.totaledEngine ||
      this.sideStructKjt[0] >= p.cabinTotal ||
      this.sideStructKjt[1] >= p.cabinTotal ||
      this.severity >= 1.0
    ) {
      this.totaled = true;
    }

    return {
      zone,
      energyKj: deKj,
      justTotaled: !wasTotaled && this.totaled,
      crushDepthM: this.crush[zone],
      localPoint: new THREE.Vector3(lx, ly, lz),
    };
  }
}

/** Shared instanced smoke + spark pool for all AI racers and Police Interceptors (only 2 draw calls total for the entire city!). */
export class SharedDamageVfx {
  readonly smoke: Particles;
  readonly sparks: Particles;
  private tmpPos = new THREE.Vector3();
  private tmpVel = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.smoke = new Particles(140, { additive: false, gravity: 1.4, grow: 1.8, drag: 1.4, style: 'smoke', opacity: 0.65 });
    this.smoke.color.setHex(0x8a929e);
    this.sparks = new Particles(120, { additive: true, gravity: -9.8, grow: -0.4, drag: 1.8, style: 'soft' });
    this.sparks.color.setHex(0xffc966);
    scene.add(this.smoke.sprite, this.sparks.sprite);
  }

  emitSparks(worldPos: THREE.Vector3, count: number, intensity = 1) {
    const n = Math.min(18, Math.max(2, Math.round(count)));
    for (let i = 0; i < n; i++) {
      this.tmpPos.copy(worldPos).addScaledVector(
        this.tmpVel.set(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5),
        0.35,
      );
      this.tmpVel.set(
        (Math.random() - 0.5) * 9 * intensity,
        2.0 + Math.random() * 5.0 * intensity,
        (Math.random() - 0.5) * 9 * intensity,
      );
      this.sparks.emit(this.tmpPos, this.tmpVel, 0.25 + Math.random() * 0.35, 0.14 + Math.random() * 0.14);
    }
  }

  emitHoodSmoke(worldPos: THREE.Vector3, dark = false) {
    this.smoke.color.setHex(dark ? 0x262a32 : 0x9ba3b0);
    this.tmpVel.set((Math.random() - 0.5) * 1.1, 1.3 + Math.random() * 1.2, (Math.random() - 0.5) * 1.1);
    this.smoke.emit(worldPos, this.tmpVel, 1.2 + Math.random() * 0.9, dark ? 0.65 : 0.48);
  }

  update(dt: number) {
    this.smoke.update(dt);
    this.sparks.update(dt);
  }

  clear() {
    this.smoke.clear();
    this.sparks.clear();
  }
}

/**
 * Per-car visual damage rig (GPU vertex-shader Dents + hood smoke origin).
 * Uses `Dents` with per-car cloned body materials so each AI rival and Police Interceptor visibly crumples
 * independently at zero per-hit CPU cost (early-outs on GPU while undamaged).
 */
export class VehicleDamageRig {
  readonly dents = new Dents();
  readonly hoodLocal = new THREE.Vector3(0, 0.82, 1.45);
  private smokeAcc = 0;
  private tmpWorld = new THREE.Vector3();

  constructor(model: THREE.Object3D) {
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(model);
    if (!box.isEmpty()) {
      const localBox = box.clone().applyMatrix4(model.matrixWorld.clone().invert());
      this.dents.setBounds(localBox);
      this.hoodLocal.set(0, localBox.min.y + (localBox.max.y - localBox.min.y) * 0.58, localBox.max.z * 0.68);
    }
    const clonedMats = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // Check full ancestor chain so wheels/glass/lightbars are never dented
      let cur: THREE.Object3D | null = m;
      while (cur && cur !== model) {
        if (SKIP_DENT_RE.test(cur.name)) return;
        cur = cur.parent;
      }
      const mats = materialsOf(m);
      let anyDentable = false;
      const nextMats = mats.map((mat) => {
        if ((mat as { transparent?: boolean }).transparent || (mat as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial) {
          return mat;
        }
        anyDentable = true;
        let cm = clonedMats.get(mat);
        if (!cm) {
          cm = mat.clone();
          (cm as unknown as { positionNode?: THREE.Node }).positionNode = this.dents.positionNode;
          clonedMats.set(mat, cm);
        }
        return cm;
      });
      if (anyDentable) {
        m.material = Array.isArray(m.material) ? nextMats : nextMats[0];
        this.dents.register(m, model);
      }
    });
  }

  /** Apply an impact hit visually (GPU vertex dent + zone crumple + optional spark burst). */
  applyHit(sim: CoreDamageSim, hit: ImpactHitResult, carRoot: THREE.Object3D, vfx?: SharedDamageVfx | null) {
    const depth = Math.min(0.42, 0.06 + Math.sqrt(Math.max(0, hit.energyKj)) * 0.036);
    const radius = Math.min(1.15, 0.45 + depth * 1.4);
    this.dents.add(hit.localPoint, INWARD[hit.zone] ?? INWARD[0], depth, radius);
    this.dents.setCrush(sim.crush[0], sim.crush[1], sim.crush[2], sim.crush[3]);
    if (vfx && hit.energyKj > 1.5) {
      this.tmpWorld.copy(hit.localPoint).applyMatrix4(carRoot.matrixWorld);
      vfx.emitSparks(this.tmpWorld, 5 + hit.energyKj * 0.4, Math.min(1.4, 0.6 + hit.energyKj * 0.03));
    }
  }

  /** Update ongoing hood steam/smoke when engine/cooling is damaged. */
  updateSmoke(dt: number, sim: CoreDamageSim, carRoot: THREE.Object3D, vfx?: SharedDamageVfx | null) {
    if (!vfx || sim.severity < CORE_DAMAGE_PARAMS.overheatSeverity * 0.85) return;
    const rate = sim.totaled ? 12 : 4 + sim.severity * 7;
    this.smokeAcc += dt * rate;
    if (this.smokeAcc >= 1) {
      this.smokeAcc -= Math.floor(this.smokeAcc);
      this.tmpWorld.copy(this.hoodLocal).applyMatrix4(carRoot.matrixWorld);
      vfx.emitHoodSmoke(this.tmpWorld, sim.totaled || sim.severity > 0.78);
    }
  }

  /** Headlight multiplier accounting for frontal impact flicker & failure. */
  headlightFactor(sim: CoreDamageSim): number {
    if (!sim.headlightsBroken) return 1;
    if (sim.headlightFlickerT > 0) {
      return Math.sin(sim.headlightFlickerT * 42) > 0.15 ? 0.7 : 0.05;
    }
    return 0;
  }

  clear() {
    this.dents.clear();
    this.smokeAcc = 0;
  }
}
