// Tyre Lab test (public/lab/): the SHIPPED WebAssembly module (rs::mf62 + rs::tirfit, built by wasm/build_lab.sh) loaded directly in Node, no browser:
// synthetic data from a known tyre -> fit from a different tyre -> the fitted curves against the truth on loads the fit never saw. Rebuild the module (bash wasm/build_lab.sh) if this fails after a core change.
// Usage: node tools/test_lab.mjs   (exit code 1 on failure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const { default: createTyreLab } = await import(path.join(here, '../public/lab/tyrelab.js'));
const M = await createTyreLab();
const withStr = (strs, fn) => { const p = strs.map((s) => M.stringToNewUTF8(s)); try { return fn(...p); } finally { p.forEach((x) => M._free(x)); } };
const J = (ptr) => JSON.parse(M.UTF8ToString(ptr));
const lab = {
  demo: (tir, noise) => M.UTF8ToString(withStr([tir], (a) => M._lab_demo(a, noise))),
  rows: (csv, sg) => J(withStr([csv], (a) => M._lab_rows(a, sg))),
  info: (tir) => J(withStr([tir], (a) => M._lab_tyre_info(a))),
  fit: (csv, tmpl, sets, sg, al, co) => J(withStr([csv, tmpl, sets], (a, b, c) => M._lab_fit(a, b, c, sg, al, co))),
  curve: (tir, ch, fz, gm, x0, x1, n) => withStr([tir], (t) => { const m = M._lab_curve(t, ch, fz, gm, x0, x1, n); const at = M._lab_curve_ptr() / 8; return Array.from(M.HEAPF64.subarray(at, at + m)); }),
};

let fails = 0, checks = 0;
const ok = (name, cond, extra = '') => { checks++; if (!cond) { fails++; console.log(`FAIL  ${name} ${extra}`); } else console.log(`ok    ${name}`); };
const tir = (f) => fs.readFileSync(path.join(root, 'data/tires', f), 'utf8');
const audi = tir('audi_245_40R18_pac2002.tir'), hmmwv = tir('hmmwv_pac2002.tir');

const info = lab.info(audi);
ok('the Audi tyre file loads and declares its geometry', info.ok && info.FNOMIN === 4850 && Math.abs(info.UNLOADED_RADIUS - 0.344) < 1e-9, JSON.stringify(info));
ok('a broken tyre file is an error, not a crash', lab.info('not a tyre file').ok === false);

const csv = lab.demo(audi, 0.01);
const rows = lab.rows(csv, 1);
ok('synthetic demo data: 1128 rows, 7 columns', Array.isArray(rows) && rows.length === 1128 && rows[0].length === 7, String(rows.length));
ok('the demo says it is synthetic', csv.startsWith('# SYNTHETIC'));
ok('a table with a non-number is refused with its line', lab.rows('fz,fy\n3000,abc\n', 1).error?.includes('line 2'));
ok('SAE angle sign flips the slip angle', lab.rows('fz,alpha,fy\n3000,0.1,500\n', -1)[0][2] === -0.1);

// a different tyre (truck) carrying the Audi's geometry, as the page does with the form's values
const set = (text, k, v) => { const re = new RegExp(`^(\\s*${k}\\s*=)[^$\\n]*`, 'm'); return re.test(text) ? text.replace(re, `$1 ${v} `) : `${text}\n${k} = ${v}\n`; };
let tmpl = hmmwv;
for (const [k, v] of Object.entries({ UNLOADED_RADIUS: 0.344, WIDTH: 0.245, ASPECT_RATIO: 0.4, RIM_RADIUS: 0.2286, NOMPRES: 220000, INFLPRES: 220000, FNOMIN: 4850 })) tmpl = set(tmpl, k, v);
const r = lab.fit(csv, tmpl, '', 1, 1, 1);
ok('the fit runs', r.ok === true, r.error);
if (r.ok) {
  const st = r.report.stages;
  ok('all five stages ran', st.length === 5 && st.every((s) => s.ran));
  ok('every stage fits to < 2 % of its peak (1 % noise in the data)', st.every((s) => s.rms_percent_of_peak < 2), JSON.stringify(st.map((s) => s.rms_percent_of_peak)));
  ok('the output starts with the provenance header', r.tir.startsWith('$ Fitted in the browser'));
  const { CHRONO_NOTICE, withNotice } = await import(path.join(here, '../public/lab/notice.js'));
  const licence = fs.readFileSync(path.join(root, 'data/tires/LICENSE-projectchrono.txt'), 'utf8');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const stripped = norm(licence);
  ok('the notice the page adds is the Chrono BSD-3 text (the licence file is in it)', norm(CHRONO_NOTICE).includes(stripped));
  const noticed = withNotice(r.tir, CHRONO_NOTICE);
  ok('the downloaded file carries the notice as comments, after the header, and still loads', noticed.includes('$ Copyright (c) 2016, Project Chrono Development Team') && noticed.indexOf('Licence notice') > noticed.indexOf('Fitted in the browser') && lab.info(noticed).ok === true);
  ok('the output file loads again', lab.info(r.tir).ok === true);
  ok('the scaling-factor reset is reported', r.report.notes.some((n) => n.includes('scaling factors were reset')));
  // held-out: loads the fit never saw, against the TRUE tyre
  for (const [ch, name, lim] of [[0, 'Fx', 2], [1, 'Fy', 2], [2, 'Mz', 6]]) {
    let se = 0, pk = 0, n = 0;
    for (const l of [0.6, 0.9, 1.1, 1.4]) {
      const fz = l * 4850, x0 = -0.24, x1 = 0.24;
      const a = lab.curve(audi, ch, fz, 0, x0, x1, 49), b = lab.curve(r.tir, ch, fz, 0, x0, x1, 49);
      a.forEach((v, i) => { se += (v - b[i]) ** 2; pk = Math.max(pk, Math.abs(v)); ++n; });
    }
    const pct = 100 * Math.sqrt(se / n) / pk;
    ok(`held-out ${name}: rms ${pct.toFixed(2)} % of the peak (limit ${lim} %)`, pct <= lim);
  }
}
const bad = lab.fit('fz,fy\n3000,abc\n', tmpl, '', 1, 1, 1);
ok('a bad table is reported by the fit as well', bad.ok === false && bad.error.includes('data:'));
ok('a bad template is reported', lab.fit(csv, 'garbage', '', 1, 1, 1).error?.includes('template:'));
ok('an unknown coefficient in the form values is refused', lab.fit(csv, tmpl, 'NOT_A_KEY=1', 1, 1, 1).error?.includes('not a coefficient'));

console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nall ${checks} passed`);
process.exit(fails ? 1 : 0);
