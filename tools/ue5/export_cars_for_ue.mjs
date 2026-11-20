#!/usr/bin/env node
// Export the web build's car models as plain glTF that Unreal's importer takes, split the way the UE5 pawn uses them.
//
//   cd tools/ue5 && npm install
//   node export_cars_for_ue.mjs                  every car in data/cars/*.visual.json
//   node export_cars_for_ue.mjs kestrel_gt       one car (the .visual.json base name)
//
// Output (gitignored): ue5/Import/<car>/
//   body.glb                  everything except wheels and calipers, merged into ONE mesh, origin on the ground at the
//                             body's length centre (the pawn places it from cg_in_model_m in the .visual.json)
//   wheel_FL.glb ... RR       each wheel (tyre, rim, disc, bell) merged, centred on its hub: these spin and steer
//   caliper_FL.glb ... RR     each caliper, centred on its hub: these steer but do not spin
//   manifest.json             what was written, hub positions, and what was converted
//
// What it undoes from the web pipeline: meshopt compression and vertex quantization (geometry is written as plain
// floats), WebP and KTX2 textures (re-encoded as PNG). KTX2 (only the Vela GT) needs the basisu tool: run
// `npm i --no-save basis_universal` in web/ once.
// Materials, including clear coat, pass through unchanged.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, prune, textureCompress, transformPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DATA = path.join(REPO, 'data', 'cars');
const OUT = path.join(REPO, 'ue5', 'Import');
const WHEELS = ['FL', 'FR', 'RL', 'RR'];

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const quiet = new Logger(Logger.Verbosity.WARN);

/** res://assets/cars/v4/x.glb -> web/public/assets/cars/v4/x.glb */
function modelFile(model) {
  return path.join(REPO, 'web', 'public', model.replace(/^res:\/\//, ''));
}

/** Does this GLB use KTX2 (Basis) textures? */
function usesKtx2(file) {
  const b = fs.readFileSync(file);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  return (json.extensionsUsed || []).includes('KHR_texture_basisu');
}

/** The basisu command-line tool from web/node_modules (npm i --no-save basis_universal), or null. */
function findBasisu() {
  const basisu = path.join(REPO, 'web', 'node_modules', 'basis_universal', 'bin', process.platform === 'win32' ? 'basisu.exe' : 'basisu');
  if (!fs.existsSync(basisu)) return null;
  // npm installs the binary without the execute bit on some systems; without it every texture silently fails.
  if (process.platform !== 'win32') { try { fs.accessSync(basisu, fs.constants.X_OK); } catch { fs.chmodSync(basisu, 0o755); } }
  return basisu;
}

/**
 * Replace every KTX2 texture in the document with a PNG decoded by basisu (largest mip). Done on the parsed document,
 * so meshopt-compressed buffers stay intact (web/scripts/decode-ktx2.cjs collapses them into one buffer, which
 * breaks EXT_meshopt_compression files such as the Vela GT).
 */
function decodeKtx2Textures(doc, basisu) {
  let decoded = 0;
  for (const tex of doc.getRoot().listTextures()) {
    if (tex.getMimeType() !== 'image/ktx2') continue;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ue5-ktx2-'));
    fs.writeFileSync(path.join(work, 'in.ktx2'), tex.getImage());
    execFileSync(basisu, ['-unpack', 'in.ktx2'], { cwd: work, stdio: 'ignore' });
    const pngs = fs.readdirSync(work).filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, s: fs.statSync(path.join(work, f)).size })).sort((a, b) => b.s - a.s);
    if (!pngs.length) throw new Error(`basisu produced no PNG for texture "${tex.getName()}"`);
    tex.setImage(fs.readFileSync(path.join(work, pngs[0].f))).setMimeType('image/png');
    fs.rmSync(work, { recursive: true, force: true });
    decoded++;
  }
  return decoded;
}

/**
 * Keep only the scene roots `keep` returns true for, optionally move the one kept root to the origin, then merge every
 * mesh under them into a single node with a single mesh (one static mesh on import, transforms baked in).
 */
function isolate(doc, keep, recentre) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  for (const n of scene.listChildren()) if (!keep(n)) n.dispose();
  const kept = scene.listChildren();
  if (recentre && kept.length === 1) kept[0].setTranslation([0, 0, 0]);
  const merged = doc.createMesh('merged');
  const visit = (n) => {
    const mesh = n.getMesh();
    if (mesh) {
      const m = n.getWorldMatrix();
      for (const p of mesh.listPrimitives()) {
        const copy = p.clone();
        transformPrimitive(copy, m);
        merged.addPrimitive(copy);
      }
    }
    n.listChildren().forEach(visit);
  };
  kept.forEach(visit);
  for (const n of [...scene.listChildren()]) n.dispose();
  scene.addChild(doc.createNode(kept.length === 1 ? kept[0].getName() : 'body').setMesh(merged));
  return merged.listPrimitives().length;
}

async function exportCar(id) {
  const visual = JSON.parse(fs.readFileSync(path.join(DATA, `${id}.visual.json`), 'utf8'));
  const src = modelFile(visual.model);
  if (!fs.existsSync(src)) return { id, error: `model not found: ${src}` };
  const file = src;
  const ktx2 = usesKtx2(src);
  const basisu = ktx2 ? findBasisu() : null;
  if (ktx2 && !basisu) return { id, error: 'KTX2 textures and no basisu: run `npm i --no-save basis_universal` in web/ and export again' };
  const note = ktx2 ? 'KTX2 textures decoded to PNG' : null;

  const nodes = visual.wheel_nodes || {};
  const wheelNames = WHEELS.map((w) => nodes[w.toLowerCase()] || `wheel_${w}`);
  const caliperNames = WHEELS.map((w) => `caliper_${w}`);
  const outDir = path.join(OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { car: visual.name, source: path.relative(REPO, src), notes: [note].filter(Boolean), files: {}, hubs_m: {} };

  // Parts the pawn moves on its own: wheels and calipers, wherever they sit in the hierarchy.
  const probe = await io.read(file);
  const probeScene = probe.getRoot().getDefaultScene() || probe.getRoot().listScenes()[0];
  const roots = probeScene.listChildren().map((n) => n.getName());
  const movingRoots = new Set([...wheelNames, ...caliperNames].filter((n) => roots.includes(n)));
  if (movingRoots.size === 0) {
    manifest.notes.push('wheels are not separate scene roots in this model: exported the whole car as body.glb only');
  }

  const write = async (name, keep, recentre) => {
    const doc = await io.read(file);
    doc.setLogger(quiet);
    const prims = isolate(doc, keep, recentre);
    if (prims === 0) return;
    if (basisu) decodeKtx2Textures(doc, basisu);
    await doc.transform(
      dequantize(),
      textureCompress({ encoder: sharp, targetFormat: 'png', slots: /.*/ }),
      prune(),
    );
    // Written without meshopt or quantization: plain float geometry and PNG textures.
    for (const ext of doc.getRoot().listExtensionsUsed()) {
      if (['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp', 'KHR_texture_basisu'].includes(ext.extensionName)) ext.dispose();
    }
    const out = path.join(outDir, `${name}.glb`);
    await io.write(out, doc);
    manifest.files[name] = { primitives: prims, bytes: fs.statSync(out).size };
  };

  await write('body', (n) => !movingRoots.has(n.getName()), false);
  for (let i = 0; i < 4; i++) {
    for (const [prefix, name] of [['wheel', wheelNames[i]], ['caliper', caliperNames[i]]]) {
      if (!movingRoots.has(name)) continue;
      const node = probeScene.listChildren().find((n) => n.getName() === name);
      manifest.hubs_m[`${prefix}_${WHEELS[i]}`] = node.getTranslation();
      await write(`${prefix}_${WHEELS[i]}`, (n) => n.getName() === name, true);
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { id, files: Object.keys(manifest.files).length, notes: manifest.notes };
}

const only = process.argv[2];
const ids = fs.readdirSync(DATA).filter((f) => f.endsWith('.visual.json')).map((f) => f.replace('.visual.json', ''))
  .filter((id) => !only || id === only);
if (ids.length === 0) { console.error(`no car "${only}" in data/cars`); process.exit(2); }
let failed = 0;
for (const id of ids) {
  try {
    const r = await exportCar(id);
    if (r.error) { failed++; console.log(`✗ ${id}: ${r.error}`); }
    else console.log(`✓ ${id}: ${r.files} files -> ue5/Import/${id}/${r.notes.length ? '  (' + r.notes.join('; ') + ')' : ''}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${id}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
