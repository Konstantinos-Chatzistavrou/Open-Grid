// Generates routes/example_circuit.json: a made-up closed circuit (CC0-1.0) in Open Grid's route/1 format.
// Core frame: x east, y north, z up, metres; heading in radians from +x, counter-clockwise; + curvature = left turn.
// The shape is a smooth closed polar curve, resampled every 2 m, so it always closes without a seam.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'routes', 'example_circuit.json');

// r(t) for t in [0, 2pi): a long main straight-ish side, a tight end, a wiggle on the back side.
const R0 = 330;
const shape = (t) => R0 * (1 + 0.42 * Math.cos(2 * t) + 0.07 * Math.sin(3 * t) + 0.05 * Math.cos(5 * t + 0.6));
const point = (t) => { const r = shape(t); return [1.25 * r * Math.cos(t), 0.8 * r * Math.sin(t)]; };

// dense polyline, then arc-length resample
const dense = [];
const N = 20000;
for (let i = 0; i < N; i++) dense.push(point((2 * Math.PI * i) / N));
const cum = [0];
for (let i = 1; i <= N; i++) {
  const a = dense[i - 1], b = dense[i % N];
  cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
const L = cum[N];
const STEP = 2;
const M = Math.round(L / STEP);
const pts = [];
let j = 0;
for (let k = 0; k < M; k++) {
  const s = (k * L) / M;
  while (cum[j + 1] < s) j++;
  const t = (s - cum[j]) / (cum[j + 1] - cum[j]);
  const a = dense[j], b = dense[(j + 1) % N];
  pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
}

const samples = [];
let minR = Infinity;
for (let k = 0; k < M; k++) {
  const p0 = pts[(k - 1 + M) % M], p1 = pts[k], p2 = pts[(k + 1) % M];
  const h0 = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const h1 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
  let dh = h1 - h0;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  const curvature = dh / ((L / M) || STEP);
  minR = Math.min(minR, 1 / Math.max(1e-9, Math.abs(curvature)));
  const heading = Math.atan2(p2[1] - p0[1], p2[0] - p0[0]);
  // gentle elevation (ignored by the flat-ground harness, used by engines that build a road from it)
  const z = 6 * Math.sin((2 * Math.PI * k) / M) + 2 * Math.sin((6 * Math.PI * k) / M);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  samples.push({ x: r3(p1[0]), y: r3(p1[1]), z: r3(z), heading: Math.round(heading * 1e5) / 1e5,
    curvature: Math.round(curvature * 1e6) / 1e6, width_left: 6, width_right: 6 });
}

// light smoothing of the curvature (finite differences on a 2 m polyline are noisy)
const raw = samples.map((s) => s.curvature);
for (let k = 0; k < M; k++) {
  let acc = 0;
  for (let d = -4; d <= 4; d++) acc += raw[(k + d + M) % M];
  samples[k].curvature = Math.round((acc / 9) * 1e6) / 1e6;
}

const route = {
  schema: 'route/1',
  name: 'Example Circuit',
  license: 'CC0-1.0',
  closed: true,
  units: 'm',
  length_m: Math.round(L * 10) / 10,
  samples,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(route));
console.log(`wrote ${out}: ${(L / 1000).toFixed(2)} km, ${M} samples, tightest radius ${minR.toFixed(0)} m`);
