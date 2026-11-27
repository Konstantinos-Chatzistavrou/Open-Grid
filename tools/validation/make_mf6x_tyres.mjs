// Writes data/validation/mf62/tyres/opengrid_mf61_synthetic.tir and ..._mf62_synthetic.tir: SYNTHETIC MF 6.1 / 6.2 tyre property files, NOT measurements.
// Base: the Project Chrono Audi 245/40 R18 PAC2002 tyre (data/tires/audi_245_40R18_pac2002.tir, Copyright (c) 2016 Project Chrono Development Team, BSD-3-Clause)
// with the MF 6.x coefficients added by OpenGrid (the values below were chosen to be plausible and well-behaved, nothing more). Every other coefficient the
// solver reads (core/include/rs/mf62.hpp) is written out explicitly with its default, so neither rs::mf62 nor MFeval depends on its own defaults.
// Usage: node tools/validation/make_mf6x_tyres.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = fs.readFileSync(path.join(root, 'data/tires/audi_245_40R18_pac2002.tir'), 'utf8').replace(/\r\n/g, '\n');
const hpp = fs.readFileSync(path.join(root, 'core/include/rs/mf62.hpp'), 'utf8');
const defaults = new Map([...hpp.matchAll(/X\((\w+), "([A-Z0-9_]+)", ([-+0-9.eE]+)\)/g)].map((m) => [m[2], m[3]]));

const common = {
  INFLPRES: 220000, NOMPRES: 220000, PRESMIN: 100000, PRESMAX: 500000, BOTTOM_OFFST: 0.01,
  Q_RE0: 1.0, Q_V1: 0.0004, Q_V2: 0.04, Q_FZ2: 15, Q_FCX: -0.02, Q_FCY: 0.2, PFZ1: 0.7,
  LONGITUDINAL_STIFFNESS: 290000, LATERAL_STIFFNESS: 170000, PCFX1: 0.15, PCFX2: 0.02, PCFX3: 0.4, PCFY1: 0.12, PCFY2: 0.01, PCFY3: 0.35,
  Q_RA1: 0.5, Q_RA2: 1.0, Q_RB1: 1.0, Q_RB2: -1.0,
  PKY4: 2, PKY5: 0, PKY6: -0.8, PKY7: -0.4, PPY1: 0.3, PPY2: 0.1, PPY3: 0.05, PPY4: -0.02, PPY5: 0.2, PEY5: -0.1,
  PPX1: -0.3, PPX2: 0.1, PPX3: 0.05, PPX4: -0.02, PPZ1: 0.1, PPZ2: 0.2,
  QSX1: 0.002, QSX2: 0.3, QSX3: 0.01, QSX4: 5, QSX5: 1, QSX6: 10, QSX7: 0.2, QSX8: 0.2, QSX9: 0.4, QSX10: 0, QSX11: 5, PPMX1: 0.1,
  QSY1: 0.01, QSY3: 0.0004, QSY4: 0.00004, QSY5: 0.0001, QSY6: 0.0002, QSY7: 0.85, QSY8: -0.4,
  PDXP1: 0.4, PDXP2: 0, PDXP3: 0, PKYP1: 1, PDYP1: 0.4, PDYP2: 0, PDYP3: 0, PDYP4: 0, PHYP1: 1, PHYP2: 0.15, PHYP3: 0, PHYP4: -4,
  PECP1: 0.5, PECP2: 0, QDTP1: 10, QCRP1: 0.2, QCRP2: 0.1, QBRP1: 0.1, QDRP1: 1.0,
};
const only62 = { Q_FCY2: -0.4, Q_CAM1: 80, Q_CAM2: 250, Q_CAM3: 0.5, Q_FYS1: -18000, Q_FYS2: -55000, Q_FYS3: 80000 };

function build(fittyp) {
  const over = { ...common, ...(fittyp === 62 ? only62 : {}), FITTYP: fittyp };
  let text = base;
  const present = new Set();
  for (const m of text.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)) present.add(m[1]);
  const added = [];
  const keys = new Set([...Object.keys(over), ...defaults.keys()]);
  for (const key of keys) {
    const want = key in over ? String(over[key]) : (present.has(key) ? null : defaults.get(key));
    if (key === 'FITTYP' || want === null) continue;
    if (key in over && present.has(key)) text = text.replace(new RegExp(`^(\\s*${key}\\s*=)[^$\\n]*`, 'm'), `$1 ${want} `);   // our value replaces the file's
    else if (!present.has(key)) added.push(`${key} = ${want}`);
  }
  const head = [
    `$ OpenGrid SYNTHETIC MF ${fittyp === 62 ? '6.2' : '6.1'} tyre property file (FITTYP = ${fittyp}): NOT a measurement.`,
    '$ Coefficients of the Project Chrono Audi 245/40 R18 PAC2002 tyre (Copyright (c) 2016 Project Chrono Development Team, BSD-3-Clause)',
    '$ plus MF 6.x coefficients chosen by OpenGrid (tools/validation/make_mf6x_tyres.mjs). Used as an MFeval comparison tyre (docs/mf62.md).',
    '$ Our additions are CC BY 4.0, credit: OpenGrid conformance suite by Konstantinos Chatzistavrou, https://github.com/Konstantinos-Chatzistavrou/Open-Grid (LICENSING.md); the Chrono coefficients stay BSD-3-Clause.',
    '[MODEL]', `FITTYP = ${fittyp}`,
  ].join('\n');
  return `${head}\n${text}\n[OPENGRID_ADDED_COEFFICIENTS]\n${added.sort().join('\n')}\n`;
}
for (const f of [61, 62]) {
  const out = path.join(root, `data/validation/mf62/tyres/opengrid_mf${f}_synthetic.tir`);
  fs.writeFileSync(out, build(f));
  console.log('wrote', path.relative(root, out));
}
