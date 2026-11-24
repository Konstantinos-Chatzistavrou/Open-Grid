#!/usr/bin/env node
// NACA 4-digit section generator. The geometry comes from the published NACA 4-digit definition
// (Abbott & von Doenhoff, "Theory of Wing Sections", NACA Report 824, 1945 - a US Government work,
// public domain), so the output needs no third-party licence. Thin-airfoil lift slope (2*pi per rad)
// is classical theory. Cd0 here is an ESTIMATE (0.006 + 0.004*t) for game aero, not measured data.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SECTIONS = [
  { name: 'NACA 0012', m: 0.00, p: 0.40, t: 0.12 },
  { name: 'NACA 2412', m: 0.02, p: 0.40, t: 0.12 },
  { name: 'NACA 4412', m: 0.04, p: 0.40, t: 0.12 },
  { name: 'NACA 6412', m: 0.06, p: 0.40, t: 0.12 },
  { name: 'NACA 0018', m: 0.00, p: 0.40, t: 0.18 },
  { name: 'NACA 23012', m: 0.02, p: 0.30, t: 0.12 },   // approximate 5-digit family member
];

function section({ m, p, t }, n = 60) {
  const yt = (x) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
  const yc = (x) => (m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x));
  const dyc = (x) => (m === 0 ? 0 : x < p ? (2 * m / (p * p)) * (p - x) : (2 * m / (1 - p) ** 2) * (p - x));
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    const beta = (Math.PI * i) / n;
    const x = 0.5 * (1 - Math.cos(beta));
    const th = Math.atan(dyc(x));
    const yt0 = yt(x), yc0 = yc(x);
    upper.push([+(x - yt0 * Math.sin(th)).toFixed(5), +(yc0 + yt0 * Math.cos(th)).toFixed(5)]);
    lower.push([+(x + yt0 * Math.sin(th)).toFixed(5), +(yc0 - yt0 * Math.cos(th)).toFixed(5)]);
  }
  return { upper, lower };
}

const out = {
  source: 'NACA 4-digit definition, Abbott & von Doenhoff (NACA Report 824, 1945), public domain',
  note: 'Cd0 is an estimate for game aero, not measured data. Cl_alpha is thin-airfoil theory.',
  sections: SECTIONS.map((s) => ({
    name: s.name,
    maxCamber: s.m,
    camberPosition: s.p,
    thickness: s.t,
    clAlphaPerRad: 2 * Math.PI,
    cd0Estimate: +(0.006 + 0.004 * (s.t / 0.12)).toFixed(4),
    ...section(s),
  })),
};
const dest = resolve(process.argv[2] ?? 'data/physics/airfoils.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
console.log('wrote', dest, out.sections.length, 'sections');
