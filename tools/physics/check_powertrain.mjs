#!/usr/bin/env node
// Sanity checks for data/powertrain: curve shape, rpm ordering, gear plausibility, final-drive bounds.
import { readFileSync } from 'node:fs';
const ref = JSON.parse(readFileSync('data/powertrain/reference-powertrains.json', 'utf8'));
const fd = JSON.parse(readFileSync('data/powertrain/final-drives.json', 'utf8'));
let fails = 0;
const check = (name, ok, detail) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? ': ' + detail : '')); if (!ok) fails++; };

check('reference-powertrains schema', ref.schema === 'open-grid/powertrain-reference@1');
check('engines present', ref.entries.length >= 2, String(ref.entries.length));
for (const e of ref.entries) {
  const c = e.engine.torque_curve;
  check(e.id + ': at least 5 curve points', c.length >= 5, String(c.length));
  check(e.id + ': rpm strictly ascending', c.every((p, i) => i === 0 || p[0] > c[i - 1][0]));
  check(e.id + ': finite positive torque range', c.every((p) => Number.isFinite(p[1]) && p[1] > -50));
  check(e.id + ': redline above last point', !e.engine.redline_rpm || e.engine.redline_rpm >= c[c.length - 1][0]);
  check(e.id + ': gears start with reverse + neutral', e.drivetrain.gear_ratios[0] < 0 && e.drivetrain.gear_ratios[1] === 0);
  const fwd = e.drivetrain.gear_ratios.slice(2);
  check(e.id + ': forward ratios descend', fwd.every((r, i) => i === 0 || r <= fwd[i - 1]), fwd.map((r) => r.toFixed(2)).join('/'));
  check(e.id + ': first gear within 2..10', fwd[0] >= 2 && fwd[0] <= 10, String(fwd[0]));
}
check('final-drives schema', fd.schema === 'open-grid/final-drives@1');
check('final-drive rows', fd.rows.length > 100, String(fd.rows.length));
check('final drives within 1.5..7', fd.rows.every((r) => r.final_drive >= 1.5 && r.final_drive <= 7));
check('gear counts within 3..10', fd.rows.every((r) => r.gears >= 3 && r.gears <= 10));
console.log(fails ? 'FAILED: ' + fails : 'PASSED: 0 checks failed');
process.exit(fails ? 1 : 0);
