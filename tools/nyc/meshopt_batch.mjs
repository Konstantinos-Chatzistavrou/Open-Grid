// Meshopt-compress many GLBs in ONE node process (npx per file costs seconds each on a busy laptop).
//   node tools/nyc/meshopt_batch.mjs [--level medium|high] file1.glb file2.glb ...   (files are replaced in place)
// Finds @gltf-transform (4.x) + meshoptimizer in the npx cache (npx -y @gltf-transform/cli@4.5.1 puts them there) or in
// GLTF_TRANSFORM_DIR (a node_modules folder).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

function findModules() {
  if (process.env.GLTF_TRANSFORM_DIR) return process.env.GLTF_TRANSFORM_DIR;
  const base = path.join(os.homedir(), '.npm', '_npx');
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const nm = path.join(base, d, 'node_modules');
    if (fs.existsSync(path.join(nm, '@gltf-transform', 'functions')) && fs.existsSync(path.join(nm, 'meshoptimizer'))) return nm;
  }
  throw new Error('no @gltf-transform in the npx cache: run "npx -y @gltf-transform/cli@4.5.1 --help" once');
}
const nm = findModules();
const req = createRequire(path.join(nm, 'x.js'));
const { NodeIO } = req('@gltf-transform/core');
const { ALL_EXTENSIONS } = req('@gltf-transform/extensions');
const { meshopt } = req('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = req('meshoptimizer');

const args = process.argv.slice(2);
let level = 'medium';
if (args[0] === '--level') { level = args[1]; args.splice(0, 2); }
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
let a = 0, b = 0, n = 0;
for (const f of args) {
  try {
    const before = fs.statSync(f).size;
    const doc = await io.read(f);
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level }));
    const tmp = f + '.tmp.glb';
    await io.write(tmp, doc);
    fs.renameSync(tmp, f);
    a += before; b += fs.statSync(f).size; n++;
  } catch (e) { console.error('meshopt failed', f, e.message); }
}
console.log(`meshopt: ${n} files, ${(a / 1e6).toFixed(1)} MB -> ${(b / 1e6).toFixed(1)} MB`);
