#!/usr/bin/env node
// meshopt.mjs - offline asset pass for Open Grid GLBs, built on gltfpack (meshoptimizer).
//
//   node tools/meshopt.mjs <in.glb|dir> [--out dir] [--simplify 0..1] [--aggressive] [--quantize] [--dry]
//
// What it does: welds/reorders vertices, quantizes attributes (optionally), applies meshopt compression
// (EXT_meshopt_compression, decoded by three's GLTFLoader + MeshoptDecoder) and can simplify to an LOD.
// NOTE: this is NOT a meshlet (Nanite) pipeline. gltfpack has no meshlet output and three's WebGPURenderer
// has no meshlet/indirect-cull path; that needs a custom renderer stage (see docs/meshlet-pipeline.md).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (!argv.length) { console.error('usage: node tools/meshopt.mjs <in.glb|dir> [--out dir] [--simplify 0..1] [--aggressive] [--quantize] [--dry]'); process.exit(1); }
const flags = new Set();
const opts = {};
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out' || a === '--simplify') opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else inputs.push(a);
}
const has = (name) => flags.has(name);
const outDir = opts.out ?? null;
const simplify = opts.simplify ?? null;
const files = [];
for (const inp of inputs) {
  const p = resolve(inp);
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) if (extname(f) === '.glb') files.push(join(p, f));
  } else if (extname(p) === '.glb') files.push(p);
}
if (!files.length) { console.error('no .glb files'); process.exit(1); }
const gltfpack = resolve('node_modules/.bin/gltfpack');
let before = 0, after = 0;
for (const file of files) {
  const out = outDir ? join(outDir, basename(file)) : file.replace(/\.glb$/, '.meshopt.glb');
  if (outDir) mkdirSync(outDir, { recursive: true });
  const args = ['-i', file, '-o', out, '-cc'];
  if (has('quantize')) args.push('-vp', '14', '-vt', '12', '-vn', '10');
  else args.push('-noq');
  if (simplify) args.push('-si', String(simplify));
  if (has('aggressive')) args.push('-sa');
  if (has('dry')) { console.log('would run', gltfpack, args.join(' ')); continue; }
  const b = statSync(file).size;
  execFileSync(gltfpack, args, { stdio: 'inherit' });
  const a = statSync(out).size;
  before += b; after += a;
  console.log(`${basename(file)}: ${(b / 1048576).toFixed(2)} MB -> ${(a / 1048576).toFixed(2)} MB (-${(100 * (1 - a / b)).toFixed(0)}%) -> ${out}`);
}
if (!has('dry')) console.log(`total ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB`);
