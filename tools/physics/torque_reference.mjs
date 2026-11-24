#!/usr/bin/env node
// Structural checks for data/physics/torque-reference.json. Read-only.
//
// Checks per curve: at least 3 points, strictly increasing rpm, finite positive torque, a measured
// flag, a source with a licence, and reported brake power consistent with P = T * omega within 3%.
// Usage: node tools/physics/torque_reference.mjs --check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../data/physics/torque-reference.json', import.meta.url));
const doc = JSON.parse(readFileSync(path, 'utf8'));
let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL', m); };
const ok = (m) => console.log('  ok  ', m);

if (typeof doc.schema !== 'string' || !doc.schema.startsWith('open-grid/torque-reference/')) fail('schema string missing or wrong');
else ok('schema ' + doc.schema);
if (!Array.isArray(doc.curves) || doc.curves.length === 0) fail('no curves');

for (const c of doc.curves || []) {
  const id = c.id || '(no id)';
  const pts = c.points_rpm_nm;
  if (!c.measured) fail(id + ': not flagged measured');
  if (c.digitised) fail(id + ': digitised data must not be presented as measured');
  if (!c.source?.license?.id || !c.source?.url) fail(id + ': source licence/URL missing');
  else ok(id + ': licence ' + c.source.license.id + ' from ' + c.source.url);
  if (!Array.isArray(pts) || pts.length < 3) { fail(id + ': fewer than 3 points'); continue; }
  let prev = -Infinity, peak = { rpm: 0, nm: -Infinity }, bad = false;
  for (const [rpm, nm] of pts) {
    if (!Number.isFinite(rpm) || !Number.isFinite(nm) || rpm <= 0 || nm <= 0) { fail(id + ': non-finite or non-positive point ' + rpm + '/' + nm); bad = true; break; }
    if (rpm <= prev) { fail(id + ': rpm not strictly increasing at ' + rpm); bad = true; break; }
    prev = rpm;
    if (nm > peak.nm) peak = { rpm, nm };
  }
  if (bad) continue;
  ok(id + ': ' + pts.length + ' points, ' + pts[0][0] + '-' + pts[pts.length - 1][0] + ' rpm, peak ' + peak.nm + ' Nm at ' + peak.rpm + ' rpm');
  if (Array.isArray(c.reported_power_kw)) {
    for (const [rpm, kw] of c.reported_power_kw) {
      const nm = pts.find((p) => p[0] === rpm)?.[1];
      if (!nm) { fail(id + ': reported power at rpm with no torque point ' + rpm); continue; }
      const calc = (nm * 2 * Math.PI * rpm / 60) / 1000;
      const rel = Math.abs(calc - kw) / Math.max(kw, 0.1);
      if (rel > 0.03) fail(id + ': power mismatch at ' + rpm + ' rpm: reported ' + kw + ' kW, T*omega ' + calc.toFixed(2) + ' kW');
    }
    ok(id + ': reported power consistent with torque within 3%');
  }
}
console.log(failures === 0 ? 'PASSED: 0 check(s) failed' : 'FAILED: ' + failures + ' check(s)');
process.exit(failures === 0 ? 0 : 1);
