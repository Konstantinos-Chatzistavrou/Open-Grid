#!/usr/bin/env node
// Apache-2.0 — OpenGrid Steward Review & Restorative Protest Admin CLI ($0/mo).
// Lists open Restorative Protests and resolves them (`upheld` refunds 100% of lost victim DR & SR
// and quarantines intentional wreckers automatically in Cloudflare D1).
//
// Usage:
//   OPENGRID_CLOUD_URL=https://opengrid.opengrid-racing.workers.dev VERIFIER_KEY=<key> node tools/steward.mjs list
//   OPENGRID_CLOUD_URL=... VERIFIER_KEY=... node tools/steward.mjs resolve <protestId> upheld "Intentional T1 divebomb"
//   OPENGRID_CLOUD_URL=... VERIFIER_KEY=... node tools/steward.mjs resolve <protestId> dismissed "Racing incident"

const CLOUD_URL = (process.env.OPENGRID_CLOUD_URL || 'https://opengrid.opengrid-racing.workers.dev').replace(/\/$/, '');
const VERIFIER_KEY = process.env.VERIFIER_KEY || '';
const [cmd, id, verdict, ...noteParts] = process.argv.slice(2);

if (!VERIFIER_KEY) {
  console.error('Missing VERIFIER_KEY env var (the same secret set on Cloudflare Worker).');
  process.exit(2);
}

const headers = { authorization: `Bearer ${VERIFIER_KEY}`, 'content-type': 'application/json' };

if (cmd === 'list') {
  const res = await fetch(`${CLOUD_URL}/v1/protests?status=open`, { headers });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  const rows = j.protests || [];
  if (!rows.length) {
    console.log('No open protests in the steward queue.');
    process.exit(0);
  }
  for (const p of rows) {
    console.log(`[${p.id}] race=${p.race_id} type=${p.incident_type} reporter=${p.reporter} accused=${p.accused} lap=${p.lap} notes=${JSON.stringify(p.notes || '')}`);
  }
} else if (cmd === 'resolve' && id && (verdict === 'upheld' || verdict === 'dismissed')) {
  const note = noteParts.join(' ') || (verdict === 'upheld' ? 'Upheld by OpenGrid Stewards' : 'Dismissed as racing incident');
  const res = await fetch(`${CLOUD_URL}/v1/protests/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: verdict, note }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  console.log('Resolved:', JSON.stringify(j));
} else {
  console.log('Usage:');
  console.log('  node tools/steward.mjs list');
  console.log('  node tools/steward.mjs resolve <protestId> <upheld|dismissed> [verdict note]');
  process.exit(1);
}
