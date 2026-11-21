#!/usr/bin/env node
// Kit masters on GitHub Releases (docs/kit.md). The masters are not in git: each ledger
// (assets_source/masters/kit/<id>/source.json) names its files, their SHA-256 and the release tag that holds them.
// Release downloads are free for everyone (no Git LFS quota), so contributors fetch the masters themselves.
//
//   node tools/assets/masters.mjs fetch [id ...]    download missing masters from their release, check the SHA-256,
//                                                   make them read-only (default: every kit ledger)
//   node tools/assets/masters.mjs verify            check every local master against its ledger
//   node tools/assets/masters.mjs upload [id ...]   maintainer: upload local masters to their release with the GitHub CLI
//                                                   (`gh`, logged in); creates the release when missing; never replaces
//                                                   an asset already there (masters are read-only once added)
// REPO=owner/name overrides the repository (default: Konstantinos-Chatzistavrou/Open-Grid).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = path.join(ROOT, 'assets_source', 'masters', 'kit');
const REPO = process.env.REPO ?? 'Konstantinos-Chatzistavrou/Open-Grid';
const [cmd, ...ids] = process.argv.slice(2);

function ledgers() {
  return fs.readdirSync(KIT).sort()
    .filter((id) => fs.existsSync(path.join(KIT, id, 'source.json')) && (!ids.length || ids.includes(id)))
    .map((id) => ({ id, dir: path.join(KIT, id), d: JSON.parse(fs.readFileSync(path.join(KIT, id, 'source.json'), 'utf8')) }));
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function fetchOne(L, f) {
  const want = L.d.sha256?.[f], tag = L.d.master_release, p = path.join(L.dir, f);
  if (!want || !tag) throw new Error(`${L.id}: ledger has no sha256 / master_release for ${f}`);
  if (fs.existsSync(p) && sha(p) === want) return 'ok';
  const url = `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(f)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'OpenGrid-masters/1.0' } });
  if (!r.ok) throw new Error(`${L.id}: ${url} -> HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`${L.id}: ${f} SHA-256 ${got} does not match the ledger (${want})`);
  if (fs.existsSync(p)) fs.chmodSync(p, 0o644);
  fs.writeFileSync(p, buf);
  fs.chmodSync(p, 0o444);
  return `fetched ${(buf.length / 1048576).toFixed(1)} MB`;
}

async function main() {
  if (cmd === 'fetch') {
    for (const L of ledgers()) for (const f of L.d.files ?? []) console.log(`${L.id}/${f}: ${await fetchOne(L, f)}`);
  } else if (cmd === 'verify') {
    let bad = 0;
    for (const L of ledgers()) for (const f of L.d.files ?? []) {
      const p = path.join(L.dir, f);
      const s = !fs.existsSync(p) ? 'missing (fetch it)' : sha(p) === L.d.sha256?.[f] ? 'ok' : 'CHANGED (masters are read-only)';
      if (s.startsWith('CHANGED')) bad++;
      console.log(`${L.id}/${f}: ${s}`);
    }
    process.exit(bad ? 1 : 0);
  } else if (cmd === 'upload') {
    const byTag = new Map();
    for (const L of ledgers()) for (const f of L.d.files ?? []) {
      const p = path.join(L.dir, f);
      if (!fs.existsSync(p)) throw new Error(`${L.id}/${f}: not here, nothing to upload`);
      if (sha(p) !== L.d.sha256?.[f]) throw new Error(`${L.id}/${f}: SHA-256 differs from the ledger`);
      (byTag.get(L.d.master_release) ?? byTag.set(L.d.master_release, []).get(L.d.master_release)).push(p);
    }
    for (const [tag, files] of byTag) {
      let have = [];
      try {
        have = JSON.parse(execFileSync('gh', ['release', 'view', tag, '-R', REPO, '--json', 'assets'], { encoding: 'utf8' })).assets.map((a) => a.name);
      } catch {
        execFileSync('gh', ['release', 'create', tag, '-R', REPO, '--title', `Kit masters (${tag})`, '--notes',
          'Kit v1 master files (docs/kit.md). Each file is described, with its source, author and licence, by its ledger: '
          + 'assets_source/masters/kit/<id>/source.json. Fetch them with `node tools/assets/masters.mjs fetch`.'], { stdio: 'inherit' });
      }
      const todo = files.filter((p) => !have.includes(path.basename(p)));
      if (!todo.length) { console.log(`${tag}: every master already on the release`); continue; }
      execFileSync('gh', ['release', 'upload', tag, '-R', REPO, ...todo], { stdio: 'inherit' });
      console.log(`${tag}: uploaded ${todo.map((p) => path.basename(p)).join(', ')}`);
    }
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 13).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
