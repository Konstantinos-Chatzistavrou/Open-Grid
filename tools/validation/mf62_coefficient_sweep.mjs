// Writes a per-coefficient sweep: for each coefficient of rs::mf62 (core/include/rs/mf62.hpp) one tyre file in which ONLY that coefficient differs from a base tyre,
// plus the unperturbed bases. tools/validation/mfeval_reference_dir.m runs MFeval on all of them; test mf62_coefficient_sweep compares rs::mf62 with it and reports
// which coefficients MFeval's output actually depends on. Usage: node tools/validation/mf62_coefficient_sweep.mjs <outdir> [dead.txt]
//   second pass (dead.txt = the coefficients the first pass found no effect for, one KEY per line): the same sweep on DENSE bases d52 / d62, where every Pacejka-type coefficient that is
//   zero in the base (it would multiply or be multiplied by zero, e.g. RVY4 when RVY1..3 = 0) is set to a small non-zero value first, and a limit is moved INTO the range the cases cover.
//   bases: b62 = data/validation/mf62/tyres/opengrid_mf62_synthetic.tir (every coefficient explicit), b52 = the Chrono Audi PAC2002 tyre with FITTYP 21,
//          b61 = the synthetic MF 6.1 tyre (only the vertical / radius coefficients are swept on it: it differs from b62 only there)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.resolve(process.argv[2] ?? 'mf62_sweep');
const deadFile = process.argv[3];
fs.mkdirSync(path.join(outDir, 'tyres'), { recursive: true });
const hpp = fs.readFileSync(path.join(root, 'core/include/rs/mf62.hpp'), 'utf8');
const keys = [...hpp.matchAll(/X\((\w+), "([A-Z0-9_]+)", ([-+0-9.eE]+)\)/g)].map((m) => m[2]);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const bases = {
  b62: read('data/validation/mf62/tyres/opengrid_mf62_synthetic.tir'),
  b61: read('data/validation/mf62/tyres/opengrid_mf61_synthetic.tir'),
  b52: '[MODEL]\nFITTYP = 21\n' + read('data/tires/audi_245_40R18_pac2002.tir'),
};
const radius61 = new Set(['Q_FZ2', 'Q_V2', 'Q_FCX', 'Q_FCY', 'PFZ1', 'VERTICAL_STIFFNESS', 'BREFF', 'DREFF', 'FREFF', 'Q_RE0', 'Q_V1', 'BOTTOM_OFFST', 'RIM_RADIUS', 'UNLOADED_RADIUS', 'NOMPRES', 'INFLPRES']);

function valueOf(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*([^\\s$]+)`, 'm'));
  return m ? Number(m[1]) : null;
}
function setKey(text, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=)[^$\\n]*`, 'm');
  return re.test(text) ? text.replace(re, `$1 ${value} `) : text + `\n${key} = ${value}\n`;
}
// a perturbation that keeps the tyre well-behaved: +20 % of a non-zero value, else a small additive step suited to the coefficient
function perturbed(key, base) {
  // dense pass: the cases reach alpha / kappa down to -0.4 and a pressure of 0.7 x nominal (154 kPa), so these limits are set where the clamp engages
  if (deadFile && (key === 'ALPMIN' || key === 'KPUMIN')) return -0.2;
  if (deadFile && key === 'PRESMIN') return 170000;
  if (/^(ALP|CAM|KPU|PRES|FZ)(MIN|MAX)$/.test(key) && base !== null && Math.abs(base) > 1e-12) {
    // dense pass: pull the limit inside the cases' range so that the clamp engages (the plain sweep moved it outward, where nothing reached it)
    return +(deadFile ? base * (/MIN$/.test(key) && base > 0 ? 1.5 : 0.5) : base * 1.2).toPrecision(9);
  }
  if (base !== null && Math.abs(base) > 1e-12) return +(base * 1.2).toPrecision(9);
  if (/^Q_(CAM|FYS)/.test(key)) return 30;
  if (/^(QSY|QSX)/.test(key)) return 0.02;
  if (/^L/.test(key)) return 1.1;
  return 0.03;
}
const STRUCTURAL = new Set([...radius61, 'FNOMIN', 'LONGVL', 'NOMPRES', 'INFLPRES', 'FITTYP']);
function densify(text) {
  let out = text;
  for (const key of keys) {
    if (!/^[PQRS][A-Z]+\d+$/.test(key) || STRUCTURAL.has(key)) continue;
    const v = valueOf(out, key);
    if (v === null || Math.abs(v) < 1e-12) out = setKey(out, key, 0.03);
  }
  return out;
}
let n = 0;
const manifest = [];
const dead = deadFile ? new Set(fs.readFileSync(deadFile, 'utf8').split(/\s+/).filter(Boolean)) : null;
const runBases = dead ? { d62: densify(bases.b62), d52: densify(bases.b52) } : bases;
for (const [name, text] of Object.entries(runBases)) {
  fs.writeFileSync(path.join(outDir, 'tyres', `${name}__base.tir`), text);
  manifest.push(`${name}__base`);
  for (const key of keys) {
    if (name === 'b61' && !radius61.has(key)) continue;
    if (dead && !dead.has(key)) continue;
    const v = perturbed(key, valueOf(text, key));
    fs.writeFileSync(path.join(outDir, 'tyres', `${name}__${key}.tir`), setKey(text, key, v));
    manifest.push(`${name}__${key}`);
    ++n;
  }
}
console.log(`${n} perturbed tyres + 3 bases in ${outDir}/tyres`);
