#!/usr/bin/env node
// bake_dirt_tex.mjs - Deterministic offline baker for the UE5 & WebGPU tileable car dirt/splatter RGBA mask.
//
// Channel packing (512x512 seamlessly tileable, linear color space):
//   R: Broad multi-octave FBM road-film blotches (low-frequency dirt buildup)
//   G: Crisp radial mud/water splatter droplets (wheel-arch & sill kick-up)
//   B: Horizontal aerodynamic wind-swept grime streaks (flanks & rear wake)
//   A: Fine dried road-dust micro-speckle grain
//
// Zero external dependencies (uses built-in node:zlib for valid RGBA PNG encoding).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 512;

// Deterministic integer hash on periodic grid [0..period-1]
function hash2(ix, iy, period, seed) {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function tileValueNoise(u, v, period, seed) {
  const x = u * period;
  const y = v * period;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0, period, seed);
  const b = hash2(x0 + 1, y0, period, seed);
  const c = hash2(x0, y0 + 1, period, seed);
  const d = hash2(x0 + 1, y0 + 1, period, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function tileFbm(u, v, basePeriod, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += tileValueNoise(u, v, p, seed + o * 31) * amp;
    norm += amp;
    p *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Bake crisp periodic mud/water splatter droplets into a float field [0..1]
function bakeSplatterField(size) {
  const field = new Float32Array(size * size);
  let s = 0x51a77e12;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  // Mix of medium droplets + fine spray mist (wrapped toroidally so texture tiles seamlessly)
  const dropCount = 950;
  for (let i = 0; i < dropCount; i++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const isBig = i < 110;
    const rx = isBig ? 4.5 + rnd() * 11.0 : 1.2 + rnd() * 3.8;
    const ry = rx * (0.55 + rnd() * 0.55); // slightly elongated along travel axis
    const strength = isBig ? 0.65 + rnd() * 0.35 : 0.35 + rnd() * 0.55;
    const padX = Math.ceil(rx * 1.4);
    const padY = Math.ceil(ry * 1.4);

    for (let dy = -padY; dy <= padY; dy++) {
      const py = (((Math.floor(cy) + dy) % size) + size) % size;
      const ny = dy / ry;
      for (let dx = -padX; dx <= padX; dx++) {
        const px = (((Math.floor(cx) + dx) % size) + size) % size;
        const nx = dx / rx;
        const d = Math.hypot(nx, ny);
        if (d >= 1.15) continue;
        // Soft core + crisp splatter rim
        const w = (1 - smoothstep(0.45, 1.05, d)) * strength;
        const idx = py * size + px;
        if (w > field[idx]) field[idx] = w;
      }
    }
  }
  return field;
}

// Minimal lossless RGBA PNG writer (RFC 2083)
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function encodePngRgba(width, height, rgba) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = 0; // filter None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowOff + 1);
  }
  const compressed = deflateSync(raw, { level: 9 });

  const c1 = pngChunk('IHDR', ihdr);
  const c2 = pngChunk('IDAT', compressed);
  const c3 = pngChunk('IEND', new Uint8Array(0));
  const total = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let off = 0;
  for (const part of [sig, c1, c2, c3]) {
    total.set(part, off);
    off += part.length;
  }
  return total;
}

const splatter = bakeSplatterField(SIZE);
const rgba = new Uint8Array(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  const v = y / SIZE;
  for (let x = 0; x < SIZE; x++) {
    const u = x / SIZE;
    // R: broad blotchy road grime FBM
    const r = tileFbm(u, v, 4, 4, 11);
    // G: crisp splatter droplets modulated by mid-frequency breakup
    const sp = splatter[y * SIZE + x];
    const mid = tileFbm(u, v, 8, 3, 47);
    const g = Math.min(1, sp * 0.78 + smoothstep(0.42, 0.78, mid) * 0.35);
    // B: horizontal wind-swept aerodynamic streaks (stretched 4:1 along U)
    const warp = (tileValueNoise(u, v, 8, 73) - 0.5) * 0.04;
    const streakLo = tileFbm(u, (v + warp + 1) % 1, 2, 3, 97);
    const streakHi = tileValueNoise(u, (v + warp * 0.5 + 1) % 1, 32, 131);
    const streakU = tileValueNoise(u, v, 4, 157);
    const b = smoothstep(0.28, 0.76, streakLo * 0.45 + streakHi * 0.35 + streakU * 0.2);
    // A: fine dried road-dust micro-speckle
    const a = tileValueNoise(u, v, 64, 211) * 0.65 + tileValueNoise(u, v, 128, 251) * 0.35;

    const i = (y * SIZE + x) * 4;
    rgba[i + 0] = Math.round(Math.max(0, Math.min(1, r)) * 255);
    rgba[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    rgba[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    rgba[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  }
}

const png = encodePngRgba(SIZE, SIZE, rgba);
const targets = [
  resolve('assets_source/textures/car_dirt_mask_rgba.png'),
  resolve('web/public/assets/textures/car_dirt_mask_rgba.png'),
];
for (const out of targets) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`baked ${SIZE}x${SIZE} tileable RGBA dirt mask (${(png.byteLength / 1024).toFixed(1)} KB) -> ${out}`);
}
