#!/usr/bin/env node
// Apache-2.0 — $0/mo Automated Replay Anti-Cheat Verifier (runs on GitHub Actions cron).
// Polls GET /v1/replays/pending from Cloudflare Worker, replays each recording through our
// C++20 deterministic `opengrid_replay_verifier` (AuthorityServerSim + AntiBotAnalyzer),
// and posts the verdict back to POST /v1/replays/:race/:account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CLOUD_URL = (process.env.OPENGRID_CLOUD_URL || '').replace(/\/$/, '');
const VERIFIER_KEY = process.env.VERIFIER_KEY || '';
const BIN = process.env.VERIFIER_BIN || path.resolve('core/build/opengrid_replay_verifier');

if (!CLOUD_URL || !VERIFIER_KEY) {
  console.log('Skipping remote replay poll: set OPENGRID_CLOUD_URL and VERIFIER_KEY to run against live cloud.');
  process.exit(0);
}

const headers = { authorization: `Bearer ${VERIFIER_KEY}`, 'content-type': 'application/json' };
const res = await fetch(`${CLOUD_URL}/v1/replays/pending`, { headers });
if (!res.ok) throw new Error(`HTTP ${res.status} fetching pending replays`);
const { replays } = await res.json();
console.log(`Pending replays to verify: ${replays.length}`);

for (const r of replays) {
  let verdict = 'unverifiable';
  try {
    const parsed = JSON.parse(r.data);
    const carId = String(parsed.car || 'vela_gt').replace(/[^a-z0-9_]/gi, '');
    const carPath = path.resolve(`data/cars/${carId}.json`);
    if (fs.existsSync(carPath) && Array.isArray(parsed.ticks) && parsed.ticks.length > 0) {
      const tmp = path.join(os.tmpdir(), `og_replay_${r.race}_${r.account}.json`);
      fs.writeFileSync(tmp, JSON.stringify(parsed));
      const out = execFileSync(BIN, [carPath, tmp], { encoding: 'utf8', timeout: 30_000 }).trim();
      fs.unlinkSync(tmp);
      const report = JSON.parse(out);
      verdict = report.verdict === 'ok' ? 'ok' : 'mismatch';
      console.log(`  ${r.race}/${r.account}: ${verdict} (${report.reason})`);
    }
  } catch (e) {
    console.warn(`  ${r.race}/${r.account}: unverifiable (${e.message})`);
  }
  await fetch(`${CLOUD_URL}/v1/replays/${encodeURIComponent(r.race)}/${encodeURIComponent(r.account)}`, {
    method: 'POST', headers, body: JSON.stringify({ verdict }),
  });
}
