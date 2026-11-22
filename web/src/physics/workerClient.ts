// Main-thread facade for the ?physworker=1 SharedArrayBuffer + Atomics Web Worker physics prototype.
// Falls back cleanly (returns null) when crossOriginIsolated / SharedArrayBuffer is unavailable.
import * as THREE from 'three/webgpu';
import type { AssistToggles, RawInput } from './core';
import {
  CMD_KIND,
  CMD_OFF,
  CMD_SLOT_DOUBLES,
  SNAP_OFF,
  SNAP_SLOT_DOUBLES,
  OUT_DOUBLES,
  SabSpscRing,
} from './sabRing';

export interface WorkerStats {
  active: boolean;
  rateHz: number;
  ticks: number;
  stepUs: number;
  cmdDropped: number;
  snapDropped: number;
  crossOriginIsolated: boolean;
}

export class PhysicsWorkerClient {
  private worker: Worker;
  private cmdRing: SabSpscRing;
  private snapRing: SabSpscRing;
  private cmdBuf = new Float64Array(CMD_SLOT_DOUBLES);
  private snapBuf = new Float64Array(SNAP_SLOT_DOUBLES);
  readonly rateHz: number;

  // Render-side interpolation state
  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly currPos = new THREE.Vector3();
  readonly currQuat = new THREE.Quaternion();
  readonly currVel = new THREE.Vector3();
  readonly currAngVel = new THREE.Vector3();
  private lastTick = 0;
  private lastStepUs = 0;
  private lastSnapAt = 0;
  private hasSnap = false;

  private constructor(worker: Worker, cmdRing: SabSpscRing, snapRing: SabSpscRing, rateHz: number) {
    this.worker = worker;
    this.cmdRing = cmdRing;
    this.snapRing = snapRing;
    this.rateHz = rateHz;
  }

  static async create(carJson: string, rateHz = 240): Promise<PhysicsWorkerClient | null> {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      console.warn(
        `[physworker] SharedArrayBuffer unavailable (crossOriginIsolated=${Boolean(globalThis.crossOriginIsolated)}). Falling back to main-thread physics.`,
      );
      return null;
    }
    const cmdCap = 64;
    const snapCap = 256;
    const cmdRing = SabSpscRing.create(cmdCap, CMD_SLOT_DOUBLES);
    const snapRing = SabSpscRing.create(snapCap, SNAP_SLOT_DOUBLES);
    const worker = new Worker(new URL('./physWorker.ts', import.meta.url), { type: 'module' });

    const ready = await new Promise<boolean>((resolve) => {
      const onMsg = (ev: MessageEvent<{ type: string; error?: string }>) => {
        if (ev.data.type === 'ready') {
          worker.removeEventListener('message', onMsg);
          resolve(true);
        } else if (ev.data.type === 'error') {
          console.warn('[physworker] init error, falling back to main thread:', ev.data.error);
          worker.removeEventListener('message', onMsg);
          worker.terminate();
          resolve(false);
        }
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', (e) => {
        console.warn('[physworker] worker error, falling back to main thread:', e.message);
        worker.terminate();
        resolve(false);
      }, { once: true });
      worker.postMessage({
        type: 'init',
        cmdSab: cmdRing.sab,
        cmdCap,
        snapSab: snapRing.sab,
        snapCap,
        carJson,
        rateHz,
      });
    });

    if (!ready) return null;
    console.info(`[physworker] active (${rateHz} Hz, SharedArrayBuffer + Atomics SPSC rings)`);
    return new PhysicsWorkerClient(worker, cmdRing, snapRing, rateHz);
  }

  swapCar(carJson: string): void {
    this.worker.postMessage({ type: 'swapCar', carJson });
  }

  resetPose(
    pos: { x: number; y: number; z: number },
    quat: { x: number; y: number; z: number; w: number },
    vel: { x: number; y: number; z: number },
    angvel: { x: number; y: number; z: number },
    speed: number,
    gear: number,
    live: boolean,
    groundPlanes?: Float64Array,
  ): void {
    const b = this.cmdBuf;
    b.fill(0);
    b[CMD_OFF.kind] = CMD_KIND.RESET_POSE;
    b[CMD_OFF.live] = live ? 1 : 0;
    const o = CMD_OFF.resetPose;
    b[o] = pos.x; b[o + 1] = pos.y; b[o + 2] = pos.z;
    b[o + 3] = quat.x; b[o + 4] = quat.y; b[o + 5] = quat.z; b[o + 6] = quat.w;
    b[o + 7] = vel.x; b[o + 8] = vel.y; b[o + 9] = vel.z;
    b[o + 10] = angvel.x; b[o + 11] = angvel.y; b[o + 12] = angvel.z;
    b[o + 13] = speed;
    b[o + 14] = gear;
    if (groundPlanes) {
      b[CMD_OFF.hasGround] = 1;
      b.set(groundPlanes, CMD_OFF.ground);
    }
    this.cmdRing.tryPush(b, true);
    this.prevPos.set(pos.x, pos.y, pos.z);
    this.currPos.set(pos.x, pos.y, pos.z);
    this.prevQuat.set(quat.x, quat.y, quat.z, quat.w);
    this.currQuat.set(quat.x, quat.y, quat.z, quat.w);
    this.currVel.set(vel.x, vel.y, vel.z);
    this.currAngVel.set(angvel.x, angvel.y, angvel.z);
    this.hasSnap = false;
  }

  repair(): void {
    this.cmdBuf.fill(0);
    this.cmdBuf[CMD_OFF.kind] = CMD_KIND.REPAIR;
    this.cmdRing.tryPush(this.cmdBuf, true);
  }

  sendFrame(
    live: boolean,
    raw: RawInput,
    assists: AssistToggles,
    nosThrustN: number,
    groundPlanes: Float64Array,
    turboStage: number,
    airC: number,
    trackC: number,
    altM: number,
    humidity: number,
  ): void {
    const b = this.cmdBuf;
    b[CMD_OFF.kind] = CMD_KIND.FRAME;
    b[CMD_OFF.live] = live ? 1 : 0;
    b[CMD_OFF.raw] = raw.steer;
    b[CMD_OFF.raw + 1] = raw.throttle;
    b[CMD_OFF.raw + 2] = raw.brake;
    b[CMD_OFF.raw + 3] = raw.clutch;
    b[CMD_OFF.raw + 4] = raw.handbrake;
    b[CMD_OFF.raw + 5] = raw.shiftUp ? 1 : 0;
    b[CMD_OFF.raw + 6] = raw.shiftDown ? 1 : 0;
    b[CMD_OFF.raw + 7] = raw.device;
    b[CMD_OFF.raw + 8] = raw.directGear ?? -99;
    b[CMD_OFF.assists] = assists.abs ? 1 : 0;
    b[CMD_OFF.assists + 1] = assists.tc ? 1 : 0;
    b[CMD_OFF.assists + 2] = assists.esc ? 1 : 0;
    b[CMD_OFF.assists + 3] = assists.autoGearbox ? 1 : 0;
    b[CMD_OFF.assists + 4] = assists.absSlip ?? 0;
    b[CMD_OFF.assists + 5] = assists.tcSlip ?? 0;
    b[CMD_OFF.assists + 6] = assists.countersteer ?? 0;
    b[CMD_OFF.nosThrustN] = nosThrustN;
    b[CMD_OFF.turboStage] = turboStage;
    b[CMD_OFF.atmosphere] = airC;
    b[CMD_OFF.atmosphere + 1] = trackC;
    b[CMD_OFF.atmosphere + 2] = altM;
    b[CMD_OFF.atmosphere + 3] = humidity;
    b[CMD_OFF.hasGround] = 1;
    b.set(groundPlanes, CMD_OFF.ground);
    this.cmdRing.tryPush(b, true);
  }

  /** Drain snapshots from the worker->main SAB ring; updates prev/curr poses and copies the latest OUT_DOUBLES telemetry into `outBuf`. */
  drain(outBuf: Float64Array): number {
    let popped = 0;
    while (this.snapRing.tryPop(this.snapBuf)) {
      if (this.hasSnap) {
        this.prevPos.copy(this.currPos);
        this.prevQuat.copy(this.currQuat);
      }
      const s = this.snapBuf;
      this.lastTick = s[SNAP_OFF.tick];
      this.lastStepUs = s[SNAP_OFF.stepUs];
      this.currPos.set(s[SNAP_OFF.pos], s[SNAP_OFF.pos + 1], s[SNAP_OFF.pos + 2]);
      this.currQuat.set(s[SNAP_OFF.quat], s[SNAP_OFF.quat + 1], s[SNAP_OFF.quat + 2], s[SNAP_OFF.quat + 3]);
      this.currVel.set(s[SNAP_OFF.vel], s[SNAP_OFF.vel + 1], s[SNAP_OFF.vel + 2]);
      this.currAngVel.set(s[SNAP_OFF.angvel], s[SNAP_OFF.angvel + 1], s[SNAP_OFF.angvel + 2]);
      if (!this.hasSnap) {
        this.prevPos.copy(this.currPos);
        this.prevQuat.copy(this.currQuat);
        this.hasSnap = true;
      }
      popped++;
    }
    if (popped > 0) {
      outBuf.set(this.snapBuf.subarray(SNAP_OFF.out, SNAP_OFF.out + Math.min(OUT_DOUBLES, outBuf.length)), 0);
      this.lastSnapAt = performance.now();
    }
    return popped;
  }

  /** Fractional interpolation alpha in [0, 1] since the last drained snapshot. */
  alpha(nowMs: number): number {
    if (!this.hasSnap) return 1;
    const dtMs = 1000 / this.rateHz;
    return Math.max(0, Math.min(1, (nowMs - this.lastSnapAt) / dtMs));
  }

  stats(): WorkerStats {
    return {
      active: true,
      rateHz: this.rateHz,
      ticks: this.lastTick,
      stepUs: +this.lastStepUs.toFixed(2),
      cmdDropped: this.cmdRing.dropped(),
      snapDropped: this.snapRing.dropped(),
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    };
  }

  dispose(): void {
    this.cmdBuf.fill(0);
    this.cmdBuf[CMD_OFF.kind] = CMD_KIND.STOP;
    this.cmdRing.tryPush(this.cmdBuf, true);
    this.worker.terminate();
  }
}
