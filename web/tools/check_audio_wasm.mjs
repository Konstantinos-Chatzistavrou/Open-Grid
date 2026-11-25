#!/usr/bin/env node
// Node verification of the compiled WebAssembly AudioWorklet engine (web/public/audio/rs_audio.wasm):
// runs 0.5 s of 48 kHz stereo audio in 128-frame AudioWorklet quanta across V12Na and I5Turbo,
// verifying finite output, strict true-peak <= 0.97, stereo RMS, and real-time WASM speed.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workletCode = fs.readFileSync(path.join(root, 'web/public/audio/opengrid-audio-worklet.js'), 'utf8');
const wasmBinary = fs.readFileSync(path.join(root, 'web/public/audio/rs_audio.wasm'));

const sandbox = {
  console, Math, ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, DataView, WebAssembly, Promise, TextDecoder, TextEncoder, performance,
  setTimeout, clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(workletCode + '\nthis.__createRsAudio = createRsAudio;', sandbox);

const bytes = new Uint8Array(wasmBinary);
const mod = await sandbox.__createRsAudio({
  instantiateWasm(imports, receiveInstance) {
    WebAssembly.instantiate(bytes, imports).then((res) => receiveInstance(res.instance));
    return {};
  },
});
let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}`); };

for (const [name, voiceId] of [['V12Na', 4], ['I5Turbo', 11], ['Rotary4', 9]]) {
  const ok = mod._rsa_init(voiceId, 48000, 4000, 3, 2, 1);
  check(ok === 1, `${name}: rsa_init succeeded`);
  const telPtr = mod._rsa_telemetry_ptr() >> 2;
  const lPtr = mod._rsa_out_l_ptr() >> 2;
  const rPtr = mod._rsa_out_r_ptr() >> 2;

  const tel = new Float32Array(128);
  tel[0] = 6800; tel[1] = 8500; tel[2] = 0.92; tel[3] = 0.0; tel[4] = 0.92;
  tel[5] = 1.35; tel[6] = 1; tel[12] = 1420; tel[13] = 0.5;
  tel[17] = 48; tel[20] = 2; tel[21] = 1; tel[22] = 0.16; tel[23] = 0.7;
  tel[24] = 0.5; tel[25] = 0.5; tel[27] = 0.6; tel[28] = 0.3; tel[29] = 1;
  for (let w = 0; w < 4; w++) {
    const o = 32 + 20 * w;
    tel[o + 0] = 1; tel[o + 1] = 4200; tel[o + 2] = 0.08; tel[o + 3] = 0.12;
    tel[o + 4] = 145; tel[o + 5] = 0.33; tel[o + 6] = 85; tel[o + 7] = 180;
    tel[o + 8] = 225; tel[o + 9] = w === 0 ? 0.8 : 0; tel[o + 16] = 216; tel[o + 17] = 234; tel[o + 18] = 0.35;
  }
  mod.HEAPF32.set(tel, telPtr);
  mod._rsa_apply_telemetry();
  mod._rsa_trigger_pop(0.9);
  mod._rsa_trigger_flutter(1.2);

  // Render 0.50 s in 128-frame AudioWorklet quanta (188 quanta = 24,064 frames @ 48 kHz)
  const quanta = 188;
  let finite = true, peak = 0, sum2 = 0, dc = 0;
  const t0 = performance.now();
  for (let q = 0; q < quanta; q++) {
    mod._rsa_render(128);
    const h = mod.HEAPF32;
    for (let i = 0; i < 128; i++) {
      const l = h[lPtr + i], r = h[rPtr + i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) finite = false;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sum2 += 0.5 * (l * l + r * r);
      dc += 0.5 * (l + r);
    }
  }
  const ms = performance.now() - t0;
  const total = quanta * 128;
  const rms = Math.sqrt(sum2 / total);
  const rt = 500 / Math.max(ms, 0.1);
  console.log(`         ${name} WASM AudioWorklet: peak=${peak.toFixed(3)} rms=${rms.toFixed(3)} DC=${Math.abs(dc / total).toFixed(5)} | ${rt.toFixed(1)}x real-time (${ms.toFixed(1)} ms for 500 ms audio)`);
  check(finite && peak > 0.12 && peak <= 0.97 && rms > 0.03 && rt > 1.2, `${name}: finite, bounded <=0.97, punchy & faster than real-time in WASM`);
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall WASM AudioWorklet checks PASSED');
process.exit(fails ? 1 : 0);
