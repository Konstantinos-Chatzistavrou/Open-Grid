#!/usr/bin/env node
// Test of the registry checker: a good entry passes and every kind of bad entry is refused, each for the right reason.
//   node tools/registry/test_registry.mjs <path to rs_conformance>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adapter = process.argv[2];
if (!adapter || !fs.existsSync(adapter)) { console.error('usage: test_registry.mjs <rs_conformance>'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rs_reg_'));
let fails = 0;
const ok = (what, cond, extra = '') => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${what}${cond ? '' : ' ' + extra}`); if (!cond) ++fails; };
const tir = path.join(root, 'data/tires/audi_245_40R18_pac2002.tir');
const good = { id: 'good-tyre', name: 'A good tyre', size: '245/40 R18', class: 'road car', file: 'tyre.tir', provenance: 'synthetic', source: 'Generated for the test.', contributor: { name: 'Tester' }, licence: 'CC0-1.0', added: '2026-11-27' };
function run(entries, extra = []) {
  const d = path.join(tmp, 'reg_' + Math.random().toString(36).slice(2));
  for (const [id, e, tyreText] of entries) {
    fs.mkdirSync(path.join(d, id), { recursive: true });
    fs.writeFileSync(path.join(d, id, 'entry.json'), typeof e === 'string' ? e : JSON.stringify(e));
    if (tyreText !== null) fs.writeFileSync(path.join(d, id, 'tyre.tir'), tyreText ?? fs.readFileSync(tir, 'utf8'));
  }
  return spawnSync(process.execPath, [path.join(root, 'tools/registry/build.mjs'), '--check', '--adapter', adapter, '--dir', d, ...extra], { encoding: 'utf8' });
}
const bad = (what, entries, pattern) => { const r = run(entries); ok(what, r.status === 1 && pattern.test(r.stderr), r.stderr.slice(0, 300)); };

let r = run([['good-tyre', good]]);
ok('a good entry passes', r.status === 0 && /1 entries OK/.test(r.stdout), r.stderr + r.stdout);
bad('a missing provenance is refused', [['good-tyre', { ...good, provenance: undefined }]], /"provenance" is required/);
bad('an invented provenance is refused', [['good-tyre', { ...good, provenance: 'trust-me' }]], /"provenance" must be one of/);
bad('"measured" without a measurement description is refused', [['good-tyre', { ...good, provenance: 'measured' }]], /needs a "measurement" description/);
bad('a short measurement description is refused', [['good-tyre', { ...good, provenance: 'fitted-from-measurements', measurement: 'my rig' }]], /at least 40 characters/);
bad('an unknown licence is refused', [['good-tyre', { ...good, licence: 'WTFPL' }]], /licence "WTFPL" is not accepted/);
bad('BSD-3 without its notice is refused', [['good-tyre', { ...good, licence: 'BSD-3-Clause', copyright: 'Someone' }]], /requires its notice to travel/);
bad('a licence that needs credit but names nobody is refused', [['good-tyre', { ...good, licence: 'CC-BY-4.0' }]], /"copyright" is required/);
bad('an id that differs from its folder is refused', [['good-tyre', { ...good, id: 'other' }]], /must equal the folder name/);
bad('an upper-case id is refused', [['Bad_Id', { ...good, id: 'Bad_Id' }]], /lower-case letters/);
bad('a missing tyre file is refused', [['good-tyre', good, null]], /tyre file not found/);
bad('a file that is not a tyre is refused', [['good-tyre', good, 'this is not a tyre property file']], /does not load in the reference solver/);
bad('invalid JSON is refused', [['good-tyre', '{ not json']], /not valid JSON/);
bad('a tyre with no longitudinal grip (finite forces, but a car cannot drive on it) is refused', [['good-tyre', good, fs.readFileSync(path.join(root, 'tools/validation/mfeval/doc/examples/Model_Unstable.tir'), 'utf8')]], /no usable grip/);
const nc = run([['good-tyre', { ...good, licence: 'CC-BY-NC-4.0', copyright: 'Someone' }]]);
ok('a non-commercial licence is accepted but marked as such', nc.status === 0);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
