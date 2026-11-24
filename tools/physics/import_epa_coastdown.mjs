#!/usr/bin/env node
// Import the US EPA "Test Car List Data" coast-down coefficients into a validation dataset.
//
// Source (US Government work, public domain):
//   https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy
//   MY2015: https://www.epa.gov/sites/default/files/2016-07/15tstcar.csv
//   MY2016: https://www.epa.gov/sites/default/files/2016-07/16tstcar.csv
//
// EPA road-load (SAE J2263): F(v) = A + B*v + C*v^2  [lbf], v in mph.
// We store the published imperial coefficients verbatim plus the SI conversion, so the JSON is auditable.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(ROOT, 'data/validation');
const SOURCES = {
  2015: 'https://www.epa.gov/sites/default/files/2016-07/15tstcar.csv',
  2016: 'https://www.epa.gov/sites/default/files/2016-07/16tstcar.csv',
};
const LBF = 4.4482216, MPH = 0.44704;

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const cacheDir = resolve(OUT, '.cache');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(OUT, { recursive: true });

const vehicles = [];
const seen = new Set();
for (const [my, url] of Object.entries(SOURCES)) {
  const file = resolve(cacheDir, `epa-${my}.csv`);
  if (!existsSync(file)) {
    process.stdout.write(`fetching ${my}… `);
    const res = await fetch(url);
    if (!res.ok) { console.log('FAILED', res.status); continue; }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
  const rows = parseCsv(readFileSync(file, 'utf8'));
  const head = rows[0].map((h) => h.trim().replace(/^"|"$/g, ''));
  const col = (name) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iMy = col('Model Year'), iMake = col('Represented Test Veh Make'), iModel = col('Represented Test Veh Model');
  const iId = col('Test Vehicle ID'), iCfg = col('Test Veh Configuration #'), iHp = col('Rated Horsepower');
  const iDrive = col('Drive System Description'), iTrans = col('Tested Transmission Type');
  const iEtw = col('Equivalent Test Weight (lbs.)');
  const iTA = col('Target Coef A (lbf)'), iTB = col('Target Coef B (lbf/mph)'), iTC = col('Target Coef C (lbf/mph**2)');
  const iSA = col('Set Coef A (lbf)'), iSB = col('Set Coef B (lbf/mph)'), iSC = col('Set Coef C (lbf/mph**2)');
  for (let r = 1; r < rows.length; r++) {
    const v = rows[r];
    if (!v || v.length < 10) continue;
    const id = v[iId], cfg = v[iCfg];
    const pick = (sa, sb, sc) => {
      const a = parseFloat(v[sa]), b = parseFloat(v[sb]), c = parseFloat(v[sc]);
      return a > 0 && b >= 0 && c > 0 ? [a, b, c] : null;
    };
    const coef = pick(iSA, iSB, iSC) ?? pick(iTA, iTB, iTC);
    const etwLb = parseFloat(v[iEtw]);
    if (!coef || !(etwLb > 500)) continue;
    // placeholders (A=B=C=1) and physically impossible road-load rows are not data
    const [ca, cb, cc] = coef;
    if (ca < 4 || ca > 250 || cb > 4 || cc < 0.004 || cc > 0.09) continue;
    const key = `${v[iMy]}|${id}|${cfg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [A, B, C] = coef;
    vehicles.push({
      year: +v[iMy], make: v[iMake].trim(), model: v[iModel].trim(), testId: id, config: +cfg,
      hp: parseFloat(v[iHp]) || null, drive: (v[iDrive] || '').trim(), transmission: (v[iTrans] || '').trim(),
      etw_lb: etwLb,
      mass_kg: +(etwLb * 0.45359237).toFixed(1),
      a_lbf: A, b_lbf_per_mph: B, c_lbf_per_mph2: C,
      f0_n: +(A * LBF).toFixed(2),
      f1_n_s_per_m: +((B * LBF) / MPH).toFixed(2),
      f2_n_s2_per_m2: +((C * LBF) / (MPH * MPH)).toFixed(3),
    });
  }
}

vehicles.sort((a, b) => a.year - b.year || a.make.localeCompare(b.make) || a.model.localeCompare(b.model));
const payload = {
  schema: 'epa-coastdown/1',
  source: {
    publisher: 'US Environmental Protection Agency (EPA)',
    dataset: 'Test Car List Data — coast-down / road-load coefficients',
    urls: SOURCES,
    license: 'Public domain (US Government work, 17 U.S.C. §105)',
    standard: 'SAE J2263 / 40 CFR 1066.310',
    retrieved: new Date().toISOString().slice(0, 10),
    conversion: { lbf_to_n: LBF, mph_to_m_s: MPH, note: 'F0=A*lbf, F1=B*lbf/mph, F2=C*lbf/mph^2; P(v)=F(v)*v' },
  },
  count: vehicles.length,
  vehicles,
};
writeFileSync(resolve(OUT, 'epa_coastdown.json'), JSON.stringify(payload, null, 1) + '\n');
writeFileSync(resolve(OUT, 'LICENSE-epa.txt'), `US EPA Test Car List Data (coast-down coefficients)\n\nSource: https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy\nUS Government work — public domain (17 U.S.C. §105). Retrieved ${payload.source.retrieved}.\nValues are reproduced verbatim (imperial) with an SI conversion added.\n`);
console.log(`wrote ${vehicles.length} vehicles → data/validation/epa_coastdown.json`);
