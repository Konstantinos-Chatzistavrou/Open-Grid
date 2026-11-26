// Lock-free SPSC ring buffer over SharedArrayBuffer + Atomics (mirrors core/include/rs/spsc_ring.hpp).
//
// Memory layout (64-byte cache-line separated control header + Float64 payload slots):
//   byte   0..63  (Int32[0]):  head (monotonic write counter, owned by producer)
//   byte  64..127 (Int32[16]): tail (monotonic read counter, owned by consumer)
//   byte 128..191 (Int32[32]): notifySeq (bumped + Atomics.notify to wake a sleeping worker)
//                 (Int32[33]): dropped count (producer increments on full ring)
//   byte 192..    (Float64):   capacity * slotDoubles payload doubles
//
// One thread pushes, the other pops. Power-of-two capacity with signed-32-bit wrap-safe difference
// `((head - tail) | 0)` so it stays exact even across 2^31 pushes.

export const SAB_HEADER_BYTES = 192;
const HEAD_IDX = 0;       // byte 0
const TAIL_IDX = 16;      // byte 64
const NOTIFY_IDX = 32;    // byte 128
const DROPPED_IDX = 33;   // byte 132

export function sabRingByteLength(capacity: number, slotDoubles: number): number {
  if (capacity < 2 || (capacity & (capacity - 1)) !== 0) {
    throw new Error(`SabSpscRing capacity must be a power of two >= 2 (got ${capacity})`);
  }
  return SAB_HEADER_BYTES + capacity * slotDoubles * 8;
}

export class SabSpscRing {
  readonly sab: SharedArrayBuffer;
  readonly capacity: number;
  readonly slotDoubles: number;
  private readonly mask: number;
  private readonly ctrl: Int32Array;
  private readonly data: Float64Array;
  private headCache = 0;
  private tailCache = 0;

  constructor(sab: SharedArrayBuffer, capacity: number, slotDoubles: number) {
    if (capacity < 2 || (capacity & (capacity - 1)) !== 0) {
      throw new Error(`SabSpscRing capacity must be a power of two >= 2 (got ${capacity})`);
    }
    const need = sabRingByteLength(capacity, slotDoubles);
    if (sab.byteLength < need) {
      throw new Error(`SharedArrayBuffer too small: ${sab.byteLength} < ${need}`);
    }
    this.sab = sab;
    this.capacity = capacity;
    this.slotDoubles = slotDoubles;
    this.mask = capacity - 1;
    this.ctrl = new Int32Array(sab, 0, SAB_HEADER_BYTES / 4);
    this.data = new Float64Array(sab, SAB_HEADER_BYTES, capacity * slotDoubles);
  }

  static create(capacity: number, slotDoubles: number): SabSpscRing {
    const sab = new SharedArrayBuffer(sabRingByteLength(capacity, slotDoubles));
    return new SabSpscRing(sab, capacity, slotDoubles);
  }

  // ---- producer thread only --------------------------------------------------------------------------------------

  tryPush(src: Float64Array, wake = false): boolean {
    const h = Atomics.load(this.ctrl, HEAD_IDX);
    if (((h - this.tailCache) | 0) >= this.capacity) {
      this.tailCache = Atomics.load(this.ctrl, TAIL_IDX);
      if (((h - this.tailCache) | 0) >= this.capacity) {
        Atomics.add(this.ctrl, DROPPED_IDX, 1);
        return false;
      }
    }
    const off = (h & this.mask) * this.slotDoubles;
    this.data.set(src.length === this.slotDoubles ? src : src.subarray(0, this.slotDoubles), off);
    Atomics.store(this.ctrl, HEAD_IDX, (h + 1) | 0);
    if (wake) {
      Atomics.add(this.ctrl, NOTIFY_IDX, 1);
      Atomics.notify(this.ctrl, NOTIFY_IDX, 1);
    }
    return true;
  }

  wake(): void {
    Atomics.add(this.ctrl, NOTIFY_IDX, 1);
    Atomics.notify(this.ctrl, NOTIFY_IDX, 1);
  }

  // ---- consumer thread only --------------------------------------------------------------------------------------

  tryPop(dst: Float64Array): boolean {
    const t = Atomics.load(this.ctrl, TAIL_IDX);
    if (t === this.headCache) {
      this.headCache = Atomics.load(this.ctrl, HEAD_IDX);
      if (t === this.headCache) return false;
    }
    const off = (t & this.mask) * this.slotDoubles;
    dst.set(this.data.subarray(off, off + this.slotDoubles), 0);
    Atomics.store(this.ctrl, TAIL_IDX, (t + 1) | 0);
    return true;
  }

  /** Drain all queued items, keeping the newest in `dst`. Returns how many items were popped. */
  drainLatest(dst: Float64Array): number {
    let n = 0;
    while (this.tryPop(dst)) n++;
    return n;
  }

  /** Worker thread ONLY: sleep until producer calls wake() or timeoutMs elapses. */
  waitForNotify(timeoutMs: number): void {
    const seq = Atomics.load(this.ctrl, NOTIFY_IDX);
    // Re-check queue before sleeping so we never miss a wakeup right after tryPop returned false.
    const t = Atomics.load(this.ctrl, TAIL_IDX);
    const h = Atomics.load(this.ctrl, HEAD_IDX);
    if (t !== h) return;
    Atomics.wait(this.ctrl, NOTIFY_IDX, seq, timeoutMs);
  }

  // ---- diagnostics (either thread) -------------------------------------------------------------------------------

  sizeApprox(): number {
    const t = Atomics.load(this.ctrl, TAIL_IDX);
    const h = Atomics.load(this.ctrl, HEAD_IDX);
    const diff = (h - t) | 0;
    return diff > 0 ? diff : 0;
  }

  dropped(): number {
    return Atomics.load(this.ctrl, DROPPED_IDX) >>> 0;
  }
}

// ---- Wire formats for physics worker <-> main thread -------------------------------------------------------------

export const CMD_KIND = {
  FRAME: 1,       // live flag + raw input + assists + nos + turbo + atmosphere + 12 ground planes
  RESET_POSE: 2,  // teleport / grid placement / respawn: pos(3) quat(4) vel(3) angvel(3) speed gear
  REPAIR: 3,      // rs_repair
  STOP: 4,        // clean worker shutdown
} as const;

// Command slot layout (144 doubles = 1152 bytes):
//   [0]      kind (CMD_KIND)
//   [1]      live (1 = step physics, 0 = paused / showroom)
//   [2..10]  raw: steer, throttle, brake, clutch, handbrake, shiftUp, shiftDown, device, directGear
//   [11..17] assists: abs, tc, esc, autoGearbox, absSlip, tcSlip, countersteer
//   [18]     nosThrustN
//   [19]     turboStage
//   [20..23] atmosphere: airC, trackC, altitudeM, humidity
//   [24..38] reset pose: pos(3), quat xyzw(4), vel(3), angvel(3), speed, gear
//   [39]     hasGround (1 = ground planes valid)
//   [40..135] 12 ground planes x 8: [hit, px, py, pz, nx, ny, nz, surface] (three.js Y-up world)
//   [136..138] extra physics-up assists: steeringAssist (0..2), brakingAssist (0..2), recommendedSpeedMs
export const CMD_SLOT_DOUBLES = 148;
export const CMD_OFF = {
  kind: 0,
  live: 1,
  raw: 2,
  assists: 11,
  nosThrustN: 18,
  turboStage: 19,
  atmosphere: 20,
  resetPose: 24,
  hasGround: 39,
  ground: 40,
  extraAssists: 136,
} as const;

// Snapshot slot layout (520 doubles):
//   [0]      tick (monotonic physics tick counter)
//   [1]      simTime (seconds)
//   [2]      stepUs (smoothed worker rs_core + integrate cost per step, microseconds)
//   [3]      rateHz
//   [4..6]   pos xyz (three.js world, CG)
//   [7..10]  quat xyzw
//   [11..13] linvel xyz
//   [14..16] angvel xyz
//   [17..23] reserved
//   [24..519] full rs_core output buffer (OUT_DOUBLES = 496 doubles, mirrors CoreCar.buf)
/** Length of the rs_core shared buffer (bridge.cpp Car::buf): physics outputs, dashboard needles, dyno. */
export const OUT_DOUBLES = 496;
export const SNAP_SLOT_DOUBLES = 24 + OUT_DOUBLES;
export const SNAP_OFF = {
  tick: 0,
  simTime: 1,
  stepUs: 2,
  rateHz: 3,
  pos: 4,
  quat: 7,
  vel: 11,
  angvel: 14,
  out: 24,
} as const;
