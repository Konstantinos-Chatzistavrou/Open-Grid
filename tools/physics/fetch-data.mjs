#!/usr/bin/env node
// Fetch the large, CC BY 4.0 measurement datasets that are too heavy to keep in git.
// Everything lands in data/physics/external/ (git-ignored) with a manifest of URL, licence and sha256.
//
//   node tools/physics/fetch-data.mjs            # ice tyre sets + vehicle-dynamics benchmark (~130 MB)
//   node tools/physics/fetch-data.mjs --all      # also the 540 MB four-post rig dataset
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';

const ROOT = resolve('data/physics/external');
const MANIFEST = resolve(ROOT, 'MANIFEST.json');
const KNOWN = {
  'ice/part1.zip': 'c9c96113cff3f60af25b0961a0a7c72b8904c1622581e82e1f7a1605cd7a5a73',
  'ice/part2.zip': null,
  'ice/part3.zip': null,
  'vdyn/data.csv': '62444bcd43338311c0c67d5cec62c662fdad3fff7ac97c3c31c4e6ff7a578561',
  'fourpost/EVE_dataSet4EC.zip': null,
};
const SETS = [
  { key: 'ice/part1.zip', url: 'https://zenodo.org/records/1009017/files/Tyre_ice_tests_Part1.zip?download=1', licence: 'CC BY 4.0', title: 'Tyre tests on ice, Part 1' },
  { key: 'ice/part2.zip', url: 'https://zenodo.org/records/1009023/files/Tyre_ice_tests_Part2.zip?download=1', licence: 'CC BY 4.0', title: 'Tyre tests on ice, Part 2' },
  { key: 'ice/part3.zip', url: 'https://zenodo.org/records/1009025/files/Tyre_ice_tests_Part3.zip?download=1', licence: 'CC BY 4.0', title: 'Tyre tests on ice, Part 3' },
  { key: 'vdyn/data.csv', url: 'https://zenodo.org/records/8307853/files/data.csv?download=1', licence: 'CC BY 4.0', title: 'Vehicle-dynamics optimisation benchmark (data.csv)' },
  { key: 'fourpost/EVE_dataSet4EC.zip', url: 'https://zenodo.org/records/1050978/files/EVE_dataSet4EC.zip?download=1', licence: 'CC BY 4.0', title: 'Four-post rig acceleration data', all: true },
];

const all = process.argv.includes('--all');
mkdirSync(ROOT, { recursive: true });
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { updated: '', entries: {} };

for (const s of SETS) {
  if (s.all && !all) continue;
  const dest = resolve(ROOT, s.key);
  if (existsSync(dest)) { console.log('have', s.key); continue; }
  mkdirSync(resolve(dest, '..'), { recursive: true });
  console.log('fetch', s.key, '<-', s.url);
  const res = await fetch(s.url, { headers: { 'user-agent': 'open-grid-physics-data' } });
  if (!res.ok || !res.body) { console.error('  failed', res.status); continue; }
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  const tap = new TransformStream({ transform(chunk, ctrl) { hash.update(chunk); ctrl.enqueue(chunk); } });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(tap)), out);
  const sha = hash.digest('hex');
  const known = KNOWN[s.key];
  if (known && known !== sha) { console.error('  CHECKSUM MISMATCH - deleting', s.key); (await import('node:fs')).unlinkSync(dest); continue; }
  manifest.entries[s.key] = { url: s.url, licence: s.licence, title: s.title, sha256: sha, fetched: new Date().toISOString() };
  console.log('  ok', (sha.slice(0, 16)), '...');
}
manifest.updated = new Date().toISOString();
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
console.log('manifest', MANIFEST);
