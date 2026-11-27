// Writes data/validation/mf62/mf62_cases.csv: the operating points on which rs::mf62 is compared with MFeval (tools/validation/mfeval_reference.m
// runs MFeval on the same list; core/tests/test_mf62.cpp, test mf62_vs_mfeval, compares the two).
// Columns: fz_rel, kappa, alpha, gamma, phit, vx_rel, p_rel, usemode. Per tyre file: fz = fz_rel * FNOMIN, vx = vx_rel * LONGVL,
// pressure = p_rel * NOMPRES (p_rel 0 = the file's INFLPRES). Usage: node tools/validation/mf62_cases.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../data/validation/mf62/mf62_cases.csv');
const rows = [];
const add = (fz, k, a, g, ph, v, p, mode) => rows.push([fz, k, a, g, ph, v, p, mode]);
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => +(a + ((b - a) * i) / (n - 1)).toFixed(6));
const loads = [0.25, 0.5, 1, 1.5, 2];

for (const fz of loads) for (const a of lin(-0.4, 0.4, 17)) add(fz, 0, a, 0, 0, 1, 0, 111);                    // pure lateral slip
for (const fz of loads) for (const k of lin(-0.4, 0.4, 17)) add(fz, k, 0, 0, 0, 1, 0, 111);                    // pure longitudinal slip
for (const fz of [0.5, 1, 1.5]) for (const k of [-0.2, -0.05, 0.05, 0.2]) for (const a of [-0.15, -0.05, 0.05, 0.15]) for (const g of [0, 0.05]) add(fz, k, a, g, 0, 1, 0, 111);   // combined
for (const fz of [0.5, 1, 1.5]) for (const g of lin(-0.17, 0.17, 9)) for (const a of [0, 0.08]) add(fz, 0, a, g, 0, 1, 0, 111);   // camber
for (const pr of [0.7, 0.85, 1, 1.15, 1.3]) for (const a of [0, 0.1]) for (const g of [0, 0.05]) add(1, 0.03, a, g, 0, 1, pr, 111);   // pressure
for (const v of [0.001, 0.005, 0.02, 0.06, 0.3, 1, 2, -0.3, -1]) add(1, 0.05, 0.08, 0, 0, v, 0, 111);            // low speed and reverse (not exactly 0: see docs/mf62.md)
for (const fz of [0.5, 1]) for (const a of [0.1, 0.3, 0.6]) for (const g of [0, 0.1]) add(fz, 0.02, a, g, 0, 1, 0, 121);   // alpha*
add(1, 0, 0.2, 0, 0, -1, 0, 121);
for (const ph of [-0.5, -0.1, 0.1, 0.5]) for (const a of [0, 0.1]) for (const k of [0, 0.1]) add(1, k, a, 0.03, ph, 1, 0, 112);   // turn slip (never phit = 0 or Vx = 0: MFeval gives NaN there)
add(1, 0, 0.05, 0, 0.2, 0.3, 0, 112);
add(1, 0.7, 0, 0, 0, 1, 0, 211); add(1, 0, 0.8, 0, 0, 1, 0, 211); add(1, 0, 1.2, 0, 0, 1, 0, 211); add(1, 0.1, 0.1, 0.3, 0, 1, 0, 211);   // limits off
add(0.5, 0, 0.3, 0, 0, 1, 0, 221); add(1, 0, 0.2, 0, 0, 0.5, 0, 211);
for (const fz of [0, 0.02, 0.05, 3, 5]) add(fz, 0.05, 0.1, 0.02, 0, 1, 0, 111);                               // no load, below FZMIN, above FZMAX
add(1, 2, 0, 0, 0, 1, 0, 111); add(1, 0, 2, 0, 0, 1, 0, 111); add(1, 0, 0.1, 0.4, 0, 1, 0, 111);               // beyond the file's slip / camber limits

const text = 'fz_rel,kappa,alpha,gamma,phit,vx_rel,p_rel,usemode\n' + rows.map((r) => r.join(',')).join('\n') + '\n';
fs.writeFileSync(out, text);
console.log(`wrote ${rows.length} cases to ${path.relative(process.cwd(), out)}`);
