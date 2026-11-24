#!/usr/bin/env node
// Track-geometry validation against the LGPL-3.0 TUM racetrack database.
//
// Checks (no invented tolerances — assumptions are stated and printed):
//  1. data integrity: finite points, positive widths, closed loop;
//  2. centre-line length vs the circuit's PUBLISHED lap distance:
//       Monza       5,793 m  (monzanet.it)
//       Brands Hatch 3,916 m (brandshatch.co.uk, GP circuit)
//     tolerance 2% — ASSUMPTION: a published lap distance is the centre line to within
//     rounding and racing-line offset (documented, not measured);
//  3. curvature from 3-point circumcircles; minimum radius sanity (> 5 m);
//  4. friction-circle corner speed at mu = 1.30 — ASSUMPTION: dry racing tyre peak,
//     used only as a physical plausibility bound (all corners < 400 km/h).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const DATA = resolve(ROOT, 'data/validation/racetrack-database');
const REF = {
  Monza: { lengthM: 5793, source: 'monzanet.it (circuit length 5,793 m)' },
  BrandsHatch: { lengthM: 3916, source: 'brandshatch.co.uk (GP circuit 3.916 km)' },
};
const G = 9.81;
const MU = 1.30;                 // assumption: dry racing peak
const LEN_TOL = 0.02;            // assumption: published lap distance vs centre line
const MIN_RADIUS_M = 5;
const MAX_CORNER_KMH = 400;

function parse(file) {
  const text = readFileSync(file, 'utf8');
  const rows = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const pts = [];
  for (const line of rows) {
    const [x, y, wr, wl] = line.split(',').map(Number);
    if (![x, y, wr, wl].every(Number.isFinite)) throw new Error(`bad row in ${file}: ${line}`);
    if (wr <= 0 || wl <= 0) throw new Error(`non-positive width in ${file}: ${line}`);
    pts.push({ x, y, wr, wl });
  }
  return pts;
}

function length(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

/** circumradius of three points (m); Infinity when collinear */
function circumradius(a, b, c) {
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ca = Math.hypot(a.x - c.x, a.y - c.y);
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  if (area2 < 1e-9) return Infinity;
  return (ab * bc * ca) / (2 * area2);
}

function analyse(name, pts) {
  const ref = REF[name];
  const len = length(pts);
  const closeGap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const widths = pts.map((p) => p.wr + p.wl);
  let minR = Infinity, minAt = 0;
  const W = 4;
  for (let i = 0; i < pts.length; i++) {
    const r = circumradius(pts[(i - W + pts.length) % pts.length], pts[i], pts[(i + W) % pts.length]);
    if (r < minR) { minR = r; minAt = i; }
  }
  const vCorner = Math.sqrt(MU * G * minR) * 3.6;   // km/h at the tightest corner
  const lenErr = ref ? Math.abs(len - ref.lengthM) / ref.lengthM : 0;
  const checks = [
    { name: 'closed-loop gap < 50 m', ok: closeGap < 50, value: +closeGap.toFixed(1) },
    { name: 'min radius > 5 m', ok: minR > MIN_RADIUS_M, value: +minR.toFixed(1) },
    { name: 'corner speed < 400 km/h', ok: vCorner < MAX_CORNER_KMH, value: +vCorner.toFixed(1) },
    { name: 'width 1-30 m', ok: Math.min(...widths) > 1 && Math.max(...widths) < 30,
      value: [+Math.min(...widths).toFixed(1), +Math.max(...widths).toFixed(1)] },
  ];
  if (ref) checks.push({ name: `length within ${(LEN_TOL * 100).toFixed(0)}% of published`, ok: lenErr <= LEN_TOL,
    value: { length_m: +len.toFixed(1), published_m: ref.lengthM, error_pct: +(lenErr * 100).toFixed(2) } });
  return {
    track: name, points: pts.length, length_m: +len.toFixed(1), published_length_m: ref?.lengthM ?? null,
    published_source: ref?.source ?? null, length_error_pct: ref ? +(lenErr * 100).toFixed(2) : null,
    closure_gap_m: +closeGap.toFixed(2), min_radius_m: +minR.toFixed(2), min_radius_index: minAt,
    width_min_m: +Math.min(...widths).toFixed(2), width_max_m: +Math.max(...widths).toFixed(2),
    corner_speed_kmh_at_mu: +vCorner.toFixed(1), mu_assumed: MU, checks,
    sha256: createHash('sha256').update(readFileSync(resolve(DATA, name + '.csv'))).digest('hex'),
  };
}

const reports = [];
let failed = 0;
for (const name of Object.keys(REF)) {
  const rep = analyse(name, parse(resolve(DATA, name + '.csv')));
  for (const c of rep.checks) if (!c.ok) failed++;
  reports.push(rep);
  console.log(`\n${rep.track}: ${rep.points} pts, ${rep.length_m} m centre line` +
    (rep.published_length_m ? ` vs published ${rep.published_length_m} m (${rep.length_error_pct}%)` : '') +
    `; min radius ${rep.min_radius_m} m => corner limit ${rep.corner_speed_kmh_at_mu} km/h at mu=${MU}`);
  for (const c of rep.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${JSON.stringify(c.value)}`);
}
const out = {
  schema: 'track-validation/1',
  generated: new Date().toISOString(),
  dataset: { name: 'TUMFTM/racetrack-database', license: 'LGPL-3.0',
    url: 'https://github.com/TUMFTM/racetrack-database', files: 'Monza.csv, BrandsHatch.csv (unmodified)' },
  assumptions: { mu: MU, length_tolerance: LEN_TOL, note: 'published lap distance vs centre line; mu is a plausibility bound only' },
  tracks: reports,
};
mkdirSync(resolve(ROOT, 'docs/validation'), { recursive: true });
writeFileSync(resolve(ROOT, 'docs/validation/racetrack-database-report.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${failed} check(s) failed. Report: docs/validation/racetrack-database-report.json`);
process.exit(failed ? 1 : 0);
