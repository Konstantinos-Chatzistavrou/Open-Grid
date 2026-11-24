#!/usr/bin/env node
// Import EVERY numeric vehicle file Project Chrono ships (data/vehicle: 531 JSON + 15 .tir tyre files) at a pinned commit,
// verbatim, into data/reference/chrono-vehicles/, with a manifest (path, git blob sha, bytes). BSD-3-Clause (Chrono's LICENSE,
// copied alongside). Not imported: meshes (.obj/.mtl), textures, POV-Ray includes and the 25 MB of OpenCRG road surfaces: they are
// not physics parameters (the CRG roads are listed in docs/chrono-data.md as available).
//
//   node tools/physics/import_chrono_vehicles.mjs            fetch (needs network) and write
//   node tools/physics/import_chrono_vehicles.mjs --verify   re-hash the files on disk against the manifest (CI, offline)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'e166f3e5a1383741e86cf1e195a46eba4a66473d';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = join(ROOT, 'data/reference/chrono-vehicles');
const RAW = `https://raw.githubusercontent.com/projectchrono/chrono/${COMMIT}`;
const gitBlobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

if (process.argv.includes('--verify')) {
  const man = JSON.parse(readFileSync(join(OUT, 'MANIFEST.json'), 'utf8'));
  let bad = 0;
  for (const f of man.files) {
    const p = join(OUT, f.path);
    if (!existsSync(p)) { console.log(`  [FAIL] missing ${f.path}`); bad++; continue; }
    if (gitBlobSha(readFileSync(p)) !== f.sha) { console.log(`  [FAIL] ${f.path} differs from the pinned upstream blob`); bad++; }
  }
  console.log(bad ? `${bad} file(s) differ` : `PASSED: ${man.files.length} files match Chrono ${man.commit.slice(0, 10)} byte for byte`);
  process.exit(bad ? 1 : 0);
}

const api = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'open-grid-data-import' } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r;
};
const tree = await (await api(`https://api.github.com/repos/projectchrono/chrono/git/trees/${COMMIT}?recursive=1`)).json();
if (tree.truncated) throw new Error('the repository tree is truncated: use per-directory trees');
const wanted = tree.tree.filter((t) => t.type === 'blob' && t.path.startsWith('data/vehicle/') && /\.(json|tir)$/.test(t.path));
console.log(`${wanted.length} files under data/vehicle at ${COMMIT.slice(0, 10)}`);
const files = [];
let next = 0;
async function worker() {
  while (next < wanted.length) {
    const t = wanted[next++];
    const rel = t.path.slice('data/vehicle/'.length);
    const buf = Buffer.from(await (await api(`${RAW}/${t.path}`)).arrayBuffer());
    if (gitBlobSha(buf) !== t.sha) throw new Error(`${t.path}: hash mismatch`);
    const dest = join(OUT, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    files.push({ path: rel, sha: t.sha, bytes: buf.length });
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
files.sort((a, b) => a.path.localeCompare(b.path));
const license = await (await api(`${RAW}/LICENSE`)).text();
writeFileSync(join(OUT, 'LICENSE-projectchrono.txt'), license);
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify({
  schema: 'open-grid/chrono-vehicles/1',
  source: 'https://github.com/projectchrono/chrono/tree/' + COMMIT + '/data/vehicle',
  commit: COMMIT,
  licence: 'BSD-3-Clause (Project Chrono LICENSE, copied alongside); files are verbatim, byte for byte',
  note: 'Model parameters published with the Chrono::Vehicle examples. Several are estimates or placeholders (see docs/chrono-data.md): treat as reference data of confidence low-medium, not as measurements.',
  files,
}, null, 1) + '\n');
console.log(`wrote ${files.length} files, ${(files.reduce((s, f) => s + f.bytes, 0) / 1024).toFixed(0)} KB, to data/reference/chrono-vehicles/`);
