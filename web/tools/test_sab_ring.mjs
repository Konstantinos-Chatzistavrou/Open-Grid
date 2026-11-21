// 2-thread stress test for the SharedArrayBuffer + Atomics SPSC ring buffer (mirrors core/tests/test_runtime.cpp).
// Uses Node worker_threads (same SharedArrayBuffer / Atomics memory model as browser Web Workers).
// Run: node web/tools/test_sab_ring.mjs
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const SAB_HEADER_BYTES = 192;
const HEAD_IDX = 0;
const TAIL_IDX = 16;
const NOTIFY_IDX = 32;
const CAPACITY = 64;
const MASK = CAPACITY - 1;
const SLOT_DOUBLES = 8;
const COUNT = 500_000;

if (!isMainThread) {
  const { sab } = workerData;
  const ctrl = new Int32Array(sab, 0, SAB_HEADER_BYTES / 4);
  const data = new Float64Array(sab, SAB_HEADER_BYTES, CAPACITY * SLOT_DOUBLES);
  const slot = new Float64Array(SLOT_DOUBLES);
  let tailCache = 0;
  let fullSpins = 0;

  for (let seq = 0; seq < COUNT; seq++) {
    slot[0] = seq;
    slot[1] = seq * 1.5 + 0.25;
    slot[2] = seq ^ 0x5a5a5a;
    slot[3] = -seq - 7;
    slot[4] = seq * 3 + 1;
    slot[5] = seq * 7 - 3;
    slot[6] = (seq % 997) + 0.125;
    slot[7] = seq + 42;

    for (;;) {
      const h = Atomics.load(ctrl, HEAD_IDX);
      if (((h - tailCache) | 0) < CAPACITY) {
        data.set(slot, (h & MASK) * SLOT_DOUBLES);
        Atomics.store(ctrl, HEAD_IDX, (h + 1) | 0);
        if ((seq & 1023) === 0) {
          Atomics.add(ctrl, NOTIFY_IDX, 1);
          Atomics.notify(ctrl, NOTIFY_IDX, 1);
        }
        break;
      }
      tailCache = Atomics.load(ctrl, TAIL_IDX);
      if (((h - tailCache) | 0) >= CAPACITY) fullSpins++;
    }
  }
  parentPort.postMessage({ fullSpins });
} else {
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + CAPACITY * SLOT_DOUBLES * 8);
  const ctrl = new Int32Array(sab, 0, SAB_HEADER_BYTES / 4);
  const data = new Float64Array(sab, SAB_HEADER_BYTES, CAPACITY * SLOT_DOUBLES);
  const dst = new Float64Array(SLOT_DOUBLES);

  const t0 = performance.now();
  const w = new Worker(new URL(import.meta.url), { workerData: { sab } });
  const doneP = new Promise((res, rej) => {
    w.once('message', res);
    w.once('error', rej);
  });

  let headCache = 0;
  let expected = 0;
  let outOfOrder = 0;
  let torn = 0;

  while (expected < COUNT) {
    const t = Atomics.load(ctrl, TAIL_IDX);
    if (t === headCache) {
      headCache = Atomics.load(ctrl, HEAD_IDX);
      if (t === headCache) continue;
    }
    const off = (t & MASK) * SLOT_DOUBLES;
    dst.set(data.subarray(off, off + SLOT_DOUBLES), 0);
    Atomics.store(ctrl, TAIL_IDX, (t + 1) | 0);

    const s = dst[0];
    if (s !== expected) outOfOrder++;
    if (
      dst[1] !== s * 1.5 + 0.25 ||
      dst[2] !== (s ^ 0x5a5a5a) ||
      dst[3] !== -s - 7 ||
      dst[4] !== s * 3 + 1 ||
      dst[5] !== s * 7 - 3 ||
      dst[6] !== (s % 997) + 0.125 ||
      dst[7] !== s + 42
    ) {
      torn++;
    }
    expected = s + 1;
  }

  const { fullSpins } = await doneP;
  const ms = performance.now() - t0;
  const remaining = (Atomics.load(ctrl, HEAD_IDX) - Atomics.load(ctrl, TAIL_IDX)) | 0;
  console.log(
    `SAB SPSC ring stress test: ${COUNT} items in ${ms.toFixed(1)} ms (${(COUNT / ms / 1000).toFixed(2)} M/s), ` +
    `fullSpins=${fullSpins}, outOfOrder=${outOfOrder}, torn=${torn}, remaining=${remaining}`,
  );
  if (outOfOrder !== 0 || torn !== 0 || expected !== COUNT || remaining !== 0) {
    process.exit(1);
  }
}
