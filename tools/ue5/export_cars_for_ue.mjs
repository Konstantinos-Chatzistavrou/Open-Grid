#!/usr/bin/env node
// Export the web build's car models as plain glTF that Unreal 5.8's Interchange importer takes, split the way
// AOpenGridCarPawn uses them, with:
//   1. Recursive scene-graph extraction for wheel_FL..RR, caliper_FL..RR, and stock_wing across all 18 cars (including
//      cars whose wheel/caliper/wing nodes sit inside a root wrapper node rather than directly under the scene).
//   2. Standardized UE 5.8 attachment sockets (`SOCKET_Wheel_FL..RR`, `SOCKET_Caliper_FL..RR`, `SOCKET_Wing`,
//      `SOCKET_Splitter`, `SOCKET_Diffuser`, `SOCKET_Skirt_L`, `SOCKET_Skirt_R`, `SOCKET_Exhaust_L`, `SOCKET_Exhaust_R`,
//      `SOCKET_Plate_Rear`) embedded as child nodes of `body.glb` and recorded in `manifest.json` (in metres and UE cm).
//   3. Baked GPU Morph Targets on `body.glb`:
//      - 6 directional crash crumple zones (`crush_front`, `crush_rear`, `crush_left`, `crush_right`, `crush_top`,
//        `crush_hood`) matching `web/src/scene/dents.ts` (with wheel-well arch keep-out masks so tyres never clip),
//      - 2 seamless widebody swell targets (`widebody_street`, `widebody_race`) matching `web/src/scene/parts/widebody.ts`.
//   4. Offline modular aftermarket part meshes (`ue5/Import/<car>/parts/*.glb`) sampled directly from the car's actual
//      3D body contour (`BodyFit` port from `web/src/scene/parts/{fit,widebody,wings,rims}.ts`):
//      `widebody_street.glb`, `widebody_gt.glb`, `wing_gt.glb`, `wing_ducktail.glb`, `splitter_race.glb`,
//      `diffuser_race.glb`, `skirts_aero.glb`, `rim_5spoke.glb`, `rim_mesh.glb`, `rim_te37.glb`.
//
//   cd tools/ue5 && npm install
//   node export_cars_for_ue.mjs                  every car in data/cars/*.visual.json
//   node export_cars_for_ue.mjs kestrel_gt       one car (the .visual.json base name)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Logger, NodeIO } from '@gltf-transform/core';
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

function modelFile(model) {
  return path.join(REPO, 'web', 'public', model.replace(/^res:\/\//, ''));
}

function usesKtx2(file) {
  const b = fs.readFileSync(file);
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  return (json.extensionsUsed || []).includes('KHR_texture_basisu');
}

function findBasisu() {
  const basisu = path.join(REPO, 'web', 'node_modules', 'basis_universal', 'bin', process.platform === 'win32' ? 'basisu.exe' : 'basisu');
  if (!fs.existsSync(basisu)) return null;
  if (process.platform !== 'win32') { try { fs.accessSync(basisu, fs.constants.X_OK); } catch { fs.chmodSync(basisu, 0o755); } }
  return basisu;
}

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

const smoother = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Compute the world-space bounding box and centroid of a node and its subtree (after dequantize). */
function nodeBounds(targetNode) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (n) => {
    const mesh = n.getMesh();
    if (mesh) {
      const m = n.getWorldMatrix();
      for (const p of mesh.listPrimitives()) {
        const pos = p.getAttribute('POSITION');
        if (!pos) continue;
        const v = [0, 0, 0];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, v);
          const wx = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
          const wy = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
          const wz = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
          if (wx < min[0]) min[0] = wx;
          if (wy < min[1]) min[1] = wy;
          if (wz < min[2]) min[2] = wz;
          if (wx > max[0]) max[0] = wx;
          if (wy > max[1]) max[1] = wy;
          if (wz > max[2]) max[2] = wz;
        }
      }
    }
    n.listChildren().forEach(visit);
  };
  visit(targetNode);
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], center: targetNode.getWorldTranslation(), size: [0, 0, 0] };
  return {
    min,
    max,
    center: [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/**
 * Walk the entire scene graph and merge primitives from nodes where `includeNode(n, ancestorMatched)` is true into one
 * mesh node. If `recentreTo` ([x,y,z]) is given, translates all merged vertices by `-recentreTo` so the part is centred
 * on its hub/socket origin.
 */
function isolateTree(doc, includeNode, outName, recentreTo = null) {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const merged = doc.createMesh(outName);
  const walk = (n, inheritedKeep) => {
    const keepHere = includeNode(n, inheritedKeep);
    const mesh = n.getMesh();
    if (keepHere && mesh) {
      const m = n.getWorldMatrix().slice();
      if (recentreTo) {
        m[12] -= recentreTo[0];
        m[13] -= recentreTo[1];
        m[14] -= recentreTo[2];
      }
      for (const p of mesh.listPrimitives()) {
        const copy = p.clone();
        transformPrimitive(copy, m);
        merged.addPrimitive(copy);
      }
    }
    for (const c of n.listChildren()) walk(c, keepHere);
  };
  for (const c of scene.listChildren()) walk(c, false);
  for (const n of [...scene.listChildren()]) n.dispose();
  const outNode = doc.createNode(outName).setMesh(merged);
  scene.addChild(outNode);
  return { node: outNode, mesh: merged, prims: merged.listPrimitives().length };
}

/**
 * Sample the car's body surface (all body primitives in model space) into the same outline grids as `BodyFit`
 * (`web/src/scene/parts/fit.ts`) so offline-exported UE 5.8 aero/widebody parts hug the exact bumper, sill, fender, and
 * rear deck contours.
 */
function sampleBodyFit(bodyMesh, wheels) {
  const NX = 72, NY = 24, NZ = 180;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const pts = [];
  for (const p of bodyMesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      pts.push(v[0], v[1], v[2]);
      for (let k = 0; k < 3; k++) {
        if (v[k] < min[k]) min[k] = v[k];
        if (v[k] > max[k]) max[k] = v[k];
      }
    }
  }
  if (!pts.length) {
    min[0] = -0.95; min[1] = 0; min[2] = -2.2;
    max[0] = 0.95; max[1] = 1.25; max[2] = 2.2;
  }
  const ground = wheels.length ? Math.min(...wheels.map((w) => w.y - w.r)) : min[1];
  const x0 = min[0], dx = Math.max(0.01, (max[0] - min[0]) / NX);
  const y0 = ground, dy = Math.max(0.02, (max[1] - ground) / NY);
  const z0 = min[2], dz = Math.max(0.01, (max[2] - min[2]) / NZ);
  const noseZ = new Float32Array(NX).fill(-Infinity);
  const noseY = new Float32Array(NX).fill(Infinity);
  const tailZ = new Float32Array(NX).fill(Infinity);
  const tailY = new Float32Array(NX).fill(Infinity);
  const sillX = [new Float32Array(NZ).fill(0), new Float32Array(NZ).fill(0)];
  const sillY = [new Float32Array(NZ).fill(Infinity), new Float32Array(NZ).fill(Infinity)];
  const shoulderX = [new Float32Array(NZ).fill(0), new Float32Array(NZ).fill(0)];
  const sideX = [new Float32Array(NY * NZ).fill(0), new Float32Array(NY * NZ).fill(0)];
  const deck = new Float32Array(NX * NZ).fill(-Infinity);

  const col = (x) => Math.min(NX - 1, Math.max(0, Math.floor((x - x0) / dx)));
  const yrow = (y) => Math.min(NY - 1, Math.max(0, Math.floor((y - y0) / dy)));
  const row = (z) => Math.min(NZ - 1, Math.max(0, Math.floor((z - z0) / dz)));
  const low = ground + 0.5;
  const sill = ground + 0.36;
  const wy = wheels.length ? wheels[0].y : ground + 0.34;
  const wr = wheels.length ? wheels[0].r : 0.34;

  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    const c = col(x), r = row(z), yr = yrow(y), s = x >= 0 ? 0 : 1, ax = Math.abs(x);
    if (y > deck[r * NX + c]) deck[r * NX + c] = y;
    if (ax > sideX[s][yr * NZ + r]) sideX[s][yr * NZ + r] = ax;
    if (y < low) { if (z > noseZ[c]) noseZ[c] = z; if (z < tailZ[c]) tailZ[c] = z; }
    if (y < sill && ax > sillX[s][r]) sillX[s][r] = ax;
    if (y > wy && y < wy + wr + 0.3 && ax > shoulderX[s][r]) shoulderX[s][r] = ax;
  }
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    const c = col(x), r = row(z), s = x >= 0 ? 0 : 1;
    if (y >= low) continue;
    if (z > noseZ[c] - 0.3 && y < noseY[c]) noseY[c] = y;
    if (z < tailZ[c] + 0.3 && y < tailY[c]) tailY[c] = y;
    if (y < sill && Math.abs(x) > sillX[s][r] - 0.14 && y < sillY[s][r]) sillY[s][r] = y;
  }
  const heal = (a, k = 1) => {
    const n = a.length;
    let last = NaN;
    for (let i = 0; i < n; i++) { if (Number.isFinite(a[i]) && a[i] !== 0) last = a[i]; else if (Number.isFinite(last)) a[i] = last; }
    last = NaN;
    for (let i = n - 1; i >= 0; i--) { if (Number.isFinite(a[i]) && a[i] !== 0) last = a[i]; else if (Number.isFinite(last)) a[i] = last; }
    const tmp = a.slice();
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) if (Number.isFinite(tmp[j])) { sum += tmp[j]; cnt++; }
      if (cnt) a[i] = sum / cnt;
    }
  };
  for (let s = 0; s < 2; s++) for (let yr = 0; yr < NY; yr++) heal(sideX[s].subarray(yr * NZ, (yr + 1) * NZ), 2);
  for (const a of [noseZ, noseY, tailZ, tailY, ...shoulderX]) heal(a, 1);
  for (const a of [...sillX, ...sillY]) heal(a, 4);

  const sample = (a, t) => {
    const f = Math.min(a.length - 1.001, Math.max(0, t - 0.5)), i = Math.floor(f), k = f - i;
    const v = a[i] * (1 - k) + a[Math.min(a.length - 1, i + 1)] * k;
    return Number.isFinite(v) ? v : 0;
  };
  const halfWidth = Math.max(0.7, Math.max(max[0], -min[0]));
  const deckAt = (x, z, r = 0.06) => {
    let y = -Infinity;
    const c0 = Math.max(0, Math.floor((x - r - x0) / dx)), c1 = Math.min(NX - 1, Math.floor((x + r - x0) / dx));
    const r0 = Math.max(0, Math.floor((z - r - z0) / dz)), r1 = Math.min(NZ - 1, Math.floor((z + r - z0) / dz));
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) y = Math.max(y, deck[rr * NX + cc]);
    return Number.isFinite(y) ? y : max[1] * 0.78;
  };
  const wingMount = () => {
    const zt = min[2], maxDeckY = ground + (max[1] - ground) * 0.84;
    let bestZ = zt + 0.22, bestY = -Infinity, bestScore = -Infinity;
    for (let z = zt + 0.14; z <= zt + 0.34; z += 0.025) {
      const yL = deckAt(halfWidth * 0.28, z, 0.05), yR = deckAt(-halfWidth * 0.28, z, 0.05), yC = deckAt(0, z, 0.05);
      const yy = Math.min(yL, yR, Math.max(yC, Math.min(yL, yR)));
      if (!Number.isFinite(yy) || yy > maxDeckY) continue;
      const yFwd = Math.min(deckAt(halfWidth * 0.28, z + 0.08, 0.05), deckAt(-halfWidth * 0.28, z + 0.08, 0.05));
      const score = yy - Math.max(0, yFwd - yy) * 1.4 - (z - (zt + 0.18)) * 0.12;
      if (score > bestScore) { bestScore = score; bestY = yy; bestZ = z; }
    }
    if (!Number.isFinite(bestY)) bestY = Math.min(maxDeckY, ground + (max[1] - ground) * 0.68);
    return { x: 0, y: bestY - 0.012, z: bestZ, span: halfWidth * 1.64 };
  };
  return {
    min, max, ground, halfWidth, wheels,
    nose: (x) => ({ z: sample(noseZ, (x - x0) / dx) || max[2], y: sample(noseY, (x - x0) / dx) || (ground + 0.16) }),
    tail: (x) => ({ z: sample(tailZ, (x - x0) / dx) || min[2], y: sample(tailY, (x - x0) / dx) || (ground + 0.18) }),
    sill: (z, side) => {
      const t = (z - z0) / dz, s = side > 0 ? 0 : 1;
      return { x: sample(sillX[s], t) || (halfWidth * 0.92), y: sample(sillY[s], t) || (ground + 0.13) };
    },
    bodySideAt: (y, z, side) => {
      const s = side > 0 ? 0 : 1;
      const fy = Math.min(NY - 1.001, Math.max(0, (y - y0) / dy - 0.5));
      const iy0 = Math.floor(fy), ky = fy - iy0, iy1 = Math.min(NY - 1, iy0 + 1);
      const tz = (z - z0) / dz;
      const sx0 = sample(sideX[s].subarray(iy0 * NZ, (iy0 + 1) * NZ), tz);
      const sx1 = sample(sideX[s].subarray(iy1 * NZ, (iy1 + 1) * NZ), tz);
      const v = sx0 * (1 - ky) + sx1 * ky;
      return v > 0.25 ? v : (sample(shoulderX[s], tz) || halfWidth * 0.92);
    },
    wingMount: wingMount(),
  };
}

/**
 * Add 6 crash crumple morph targets (`crush_front`, `crush_rear`, `crush_left`, `crush_right`, `crush_top`, `crush_hood`)
 * and 2 seamless widebody morph targets (`widebody_street`, `widebody_race`) to every primitive of `bodyMesh`.
 */
function addBodyMorphTargets(doc, bodyMesh, fit) {
  const buf = doc.getRoot().listBuffers()[0] || doc.createBuffer();
  const zRear = fit.min[2], zFront = fit.max[2], hw = fit.halfWidth, midY = fit.ground + (fit.max[1] - fit.ground) * 0.45;
  const whs = fit.wheels;
  const zAxleF = whs.length ? Math.max(...whs.map((w) => w.z)) : 1.35;
  const zAxleR = whs.length ? Math.min(...whs.map((w) => w.z)) : -1.35;
  const axleY = whs.length ? whs.reduce((a, w) => a + w.y, 0) / whs.length : 0.34;

  const archKeepOut = (x, y, z) => {
    let m = 1.0;
    for (const w of whs) {
      const dx = (x - w.x) / 0.24, dy = (y - w.y) / (w.r + 0.06), dz = (z - w.z) / (w.r + 0.06);
      const ed = Math.hypot(dx, dy, dz);
      m = Math.min(m, smoothstep(0.92, 1.48, ed));
    }
    return m;
  };

  const wbDispX = (x, y, z, wPush, reach, sillFrac) => {
    const s = x >= 0 ? 1 : -1;
    const skin = smoother(hw * 0.62, hw * 0.86, Math.abs(x));
    if (skin <= 0) return 0;
    let acc = 0;
    for (const w of whs) {
      if ((w.x >= 0 ? 1 : -1) !== s) continue;
      const d = Math.hypot(y - w.y, z - w.z), core = w.r + 0.07;
      const arch = 1 - smoother(core, core + reach, d);
      if (arch > 0) {
        const v = arch * (1 - smoother(w.y + w.r + 0.02, w.y + w.r + 0.38, y));
        acc += v ** 6;
      }
    }
    if (sillFrac > 0) {
      const span = smoother(zAxleR - 0.1, zAxleR + 0.85, z) * (1 - smoother(zAxleF - 0.85, zAxleF + 0.1, z));
      const v = sillFrac * span * (1 - smoother(axleY - 0.15, axleY + 0.45, y));
      if (v > 0) acc += v ** 6;
    }
    const shape = acc <= 0 ? 0 : Math.min(1, acc ** (1 / 6));
    return s * wPush * shape * skin;
  };

  const TARGET_DEFS = [
    {
      name: 'crush_front',
      fn: (x, y, z) => {
        const cz = 0.26, L = 0.9 + cz * 1.2;
        const along = Math.min(1, Math.max(0, (zFront - z) / L));
        const s = smoothstep(0, 1, 1 - along) * archKeepOut(x, y, z);
        if (s <= 1e-5) return [0, 0, 0];
        const upper = smoothstep(midY - 0.1, midY + 0.35, y);
        const buckle = Math.sin(along * Math.PI) * (cz * 0.32) * (upper * 1.3 - 0.3) * archKeepOut(x, y, z);
        const wrinkle = Math.sin(z * 17 + y * 9) * (cz * 0.07) * s * (x >= 0 ? 1 : -1);
        return [wrinkle, buckle, -cz * s];
      },
    },
    {
      name: 'crush_rear',
      fn: (x, y, z) => {
        const cz = 0.24, L = 0.9 + cz * 1.2;
        const along = Math.min(1, Math.max(0, (z - zRear) / L));
        const s = smoothstep(0, 1, 1 - along) * archKeepOut(x, y, z);
        if (s <= 1e-5) return [0, 0, 0];
        const upper = smoothstep(midY - 0.1, midY + 0.35, y);
        const buckle = Math.sin(along * Math.PI) * (cz * 0.28) * (upper * 1.3 - 0.3) * archKeepOut(x, y, z);
        const wrinkle = Math.sin(z * 17 + y * 9) * (cz * 0.06) * s * (x >= 0 ? 1 : -1);
        return [wrinkle, buckle, cz * s];
      },
    },
    {
      name: 'crush_left',
      fn: (x, y, z) => {
        if (x <= 0.15) return [0, 0, 0];
        const lat = smoothstep(hw * 0.45, hw, x);
        const lon = smoothstep(zRear + 0.2, zRear + 0.9, z) * (1 - smoothstep(zFront - 0.9, zFront - 0.2, z));
        const s = lat * (0.35 + 0.65 * lon) * archKeepOut(x, y, z);
        return [-0.16 * s, 0.03 * s * Math.sin(z * 9), 0];
      },
    },
    {
      name: 'crush_right',
      fn: (x, y, z) => {
        if (x >= -0.15) return [0, 0, 0];
        const lat = smoothstep(hw * 0.45, hw, -x);
        const lon = smoothstep(zRear + 0.2, zRear + 0.9, z) * (1 - smoothstep(zFront - 0.9, zFront - 0.2, z));
        const s = lat * (0.35 + 0.65 * lon) * archKeepOut(x, y, z);
        return [0.16 * s, 0.03 * s * Math.sin(z * 9), 0];
      },
    },
    {
      name: 'crush_top',
      fn: (x, y, z) => {
        const roofLow = fit.ground + (fit.max[1] - fit.ground) * 0.62;
        const s = smoothstep(roofLow, fit.max[1], y);
        return [0, -0.14 * s, -0.04 * s];
      },
    },
    {
      name: 'crush_hood',
      fn: (x, y, z) => {
        const inHoodZ = smoothstep(0.15, 0.55, z) * (1 - smoothstep(zFront - 0.25, zFront, z));
        const inHoodY = smoothstep(midY - 0.05, midY + 0.25, y) * (1 - smoothstep(midY + 0.45, fit.max[1], y));
        const s = inHoodZ * inHoodY * (1 - smoothstep(hw * 0.65, hw * 0.92, Math.abs(x)));
        const tent = Math.sin(Math.min(1, Math.max(0, (z - 0.2) / Math.max(0.4, zFront - 0.3))) * Math.PI);
        return [0, 0.14 * s * tent, -0.04 * s];
      },
    },
    {
      name: 'widebody_street',
      fn: (x, y, z) => [wbDispX(x, y, z, 0.048, 0.46, 0.0), 0, 0],
    },
    {
      name: 'widebody_race',
      fn: (x, y, z) => [wbDispX(x, y, z, 0.095, 0.60, 0.42), 0, 0],
    },
  ];

  for (const prim of bodyMesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const count = pos.getCount();
    const v = [0, 0, 0];
    for (const def of TARGET_DEFS) {
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos.getElement(i, v);
        const d = def.fn(v[0], v[1], v[2]);
        arr[i * 3] = d[0];
        arr[i * 3 + 1] = d[1];
        arr[i * 3 + 2] = d[2];
      }
      const acc = doc.createAccessor(`${def.name}_POSITION`).setType('VEC3').setArray(arr).setBuffer(buf);
      const target = doc.createPrimitiveTarget(def.name).setAttribute('POSITION', acc);
      prim.addTarget(target);
    }
  }
  return TARGET_DEFS.map((d) => d.name);
}

/** Build a standalone single-mesh glTF Document from positions, normals, indices, and PBR color/rough/metal. */
function makePartDoc(name, positions, normals, indices, baseColor = [0.06, 0.06, 0.065, 1.0], roughness = 0.32, metallic = 0.15) {
  const doc = new Document();
  doc.setLogger(quiet);
  const buf = doc.createBuffer();
  const mat = doc.createMaterial(name + '_mat')
    .setBaseColorFactor(baseColor)
    .setRoughnessFactor(roughness)
    .setMetallicFactor(metallic)
    .setDoubleSided(true);
  const posAcc = doc.createAccessor('POSITION').setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buf);
  const nrmAcc = doc.createAccessor('NORMAL').setType('VEC3').setArray(new Float32Array(normals)).setBuffer(buf);
  const idxAcc = doc.createAccessor('INDICES').setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buf);
  const prim = doc.createPrimitive().setMaterial(mat).setAttribute('POSITION', posAcc).setAttribute('NORMAL', nrmAcc).setIndices(idxAcc);
  const mesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(mesh);
  doc.createScene('Scene').addChild(node);
  return doc;
}

/** Geometry builder helper: append a deformed/oriented box or quad strip with flat/smooth normals. */
class GeoBuilder {
  constructor() { this.pos = []; this.nrm = []; this.idx = []; }
  addQuad(p0, p1, p2, p3) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    this.pos.push(...p0, ...p1, ...p2, ...p3);
    for (let i = 0; i < 4; i++) this.nrm.push(nx, ny, nz);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  addBox(cx, cy, cz, hx, hy, hz, rx = 0, ry = 0) {
    const crx = Math.cos(rx), srx = Math.sin(rx), cry = Math.cos(ry), sry = Math.sin(ry);
    const pt = (lx, ly, lz) => {
      const y1 = ly * crx - lz * srx, z1 = ly * srx + lz * crx;
      const x2 = lx * cry + z1 * sry, z2 = -lx * sry + z1 * cry;
      return [cx + x2, cy + y1, cz + z2];
    };
    const v = [
      pt(-hx, -hy, -hz), pt(hx, -hy, -hz), pt(hx, hy, -hz), pt(-hx, hy, -hz),
      pt(-hx, -hy, hz),  pt(hx, -hy, hz),  pt(hx, hy, hz),  pt(-hx, hy, hz),
    ];
    this.addQuad(v[4], v[5], v[6], v[7]);
    this.addQuad(v[1], v[0], v[3], v[2]);
    this.addQuad(v[3], v[7], v[6], v[2]);
    this.addQuad(v[0], v[1], v[5], v[4]);
    this.addQuad(v[1], v[2], v[6], v[5]);
    this.addQuad(v[0], v[4], v[7], v[3]);
  }
}

/** Generate and write offline modular UE 5.8 aftermarket part GLBs (`ue5/Import/<car>/parts/*.glb`). */
async function exportModularParts(outDir, fit) {
  const partsDir = path.join(outDir, 'parts');
  fs.mkdirSync(partsDir, { recursive: true });
  const written = {};
  const save = async (name, builder, col, rough, metal) => {
    const doc = makePartDoc(name, builder.pos, builder.nrm, builder.idx, col, rough, metal);
    const p = path.join(partsDir, `${name}.glb`);
    await io.write(p, doc);
    written[`parts/${name}`] = { triangles: builder.idx.length / 3, bytes: fs.statSync(p).size };
  };

  // 1 & 2. Sculpted body-conforming widebody fender flare sets (widebody_street & widebody_gt)
  for (const [name, flareW, lipH, reach] of [['widebody_street', 0.048, 0.065, 0.42], ['widebody_gt', 0.092, 0.095, 0.54]]) {
    const b = new GeoBuilder();
    for (const w of fit.wheels) {
      const s = w.x >= 0 ? 1 : -1;
      const segs = 24, rIn = w.r + 0.04, rOut = rIn + lipH;
      for (let i = 0; i < segs; i++) {
        const a0 = -0.12 * Math.PI + (i / segs) * 1.24 * Math.PI;
        const a1 = -0.12 * Math.PI + ((i + 1) / segs) * 1.24 * Math.PI;
        const z0 = w.z + Math.cos(a0) * rIn, y0 = Math.max(fit.ground + 0.08, w.y + Math.sin(a0) * rIn);
        const z1 = w.z + Math.cos(a1) * rIn, y1 = Math.max(fit.ground + 0.08, w.y + Math.sin(a1) * rIn);
        const z0o = w.z + Math.cos(a0) * rOut, y0o = Math.max(fit.ground + 0.08, w.y + Math.sin(a0) * rOut);
        const z1o = w.z + Math.cos(a1) * rOut, y1o = Math.max(fit.ground + 0.08, w.y + Math.sin(a1) * rOut);
        const xBody0 = s * (fit.bodySideAt(y0o, z0o, s) - 0.008);
        const xBody1 = s * (fit.bodySideAt(y1o, z1o, s) - 0.008);
        const taper0 = Math.sin(((i + 0.5) / segs) * Math.PI) ** 0.55;
        const taper1 = Math.sin(((i + 1.5) / segs) * Math.PI) ** 0.55;
        const xLip0 = s * (Math.abs(xBody0) + flareW * taper0);
        const xLip1 = s * (Math.abs(xBody1) + flareW * taper1);
        b.addQuad([xBody0, y0o, z0o], [xLip0, y0, z0], [xLip1, y1, z1], [xBody1, y1o, z1o]);
        b.addQuad([xLip0, y0, z0], [xBody0, y0 - 0.02, z0], [xBody1, y1 - 0.02, z1], [xLip1, y1, z1]);
      }
      void reach;
    }
    await save(name, b, [0.12, 0.12, 0.13, 1.0], 0.25, 0.2);
  }

  // 3. Front contour race splitter + tie rods (`splitter_race.glb`)
  {
    const b = new GeoBuilder();
    const N = 28, hw = fit.halfWidth * 0.96, protrude = 0.095, thick = 0.016;
    for (let i = 0; i < N; i++) {
      const x0 = -hw + (2 * hw * i) / N, x1 = -hw + (2 * hw * (i + 1)) / N;
      const n0 = fit.nose(x0), n1 = fit.nose(x1);
      const y0 = Math.min(n0.y, fit.ground + 0.16), y1 = Math.min(n1.y, fit.ground + 0.16);
      const z0In = n0.z - 0.16, z1In = n1.z - 0.16;
      const z0Out = n0.z + protrude * (1 - 0.25 * (x0 / hw) ** 2);
      const z1Out = n1.z + protrude * (1 - 0.25 * (x1 / hw) ** 2);
      b.addQuad([x0, y0, z0In], [x1, y1, z1In], [x1, y1, z1Out], [x0, y0, z0Out]);
      b.addQuad([x0, y0 - thick, z0Out], [x1, y1 - thick, z1Out], [x1, y1 - thick, z1In], [x0, y0 - thick, z0In]);
      b.addQuad([x0, y0 - thick, z0Out], [x0, y0, z0Out], [x1, y1, z1Out], [x1, y1 - thick, z1Out]);
    }
    for (const s of [-1, 1]) {
      const xr = s * hw * 0.36, nr = fit.nose(xr);
      b.addBox(xr, Math.min(nr.y, fit.ground + 0.16) + 0.055, nr.z + 0.04, 0.005, 0.06, 0.005, -0.35, 0);
    }
    await save('splitter_race', b, [0.05, 0.05, 0.055, 1.0], 0.35, 0.15);
  }

  // 4. Rear underbody finned diffuser (`diffuser_race.glb`)
  {
    const b = new GeoBuilder();
    const N = 24, hw = fit.halfWidth * 0.82, depth = 0.34, thick = 0.014;
    for (let i = 0; i < N; i++) {
      const x0 = -hw + (2 * hw * i) / N, x1 = -hw + (2 * hw * (i + 1)) / N;
      const t0 = fit.tail(x0), t1 = fit.tail(x1);
      const y0Out = Math.min(t0.y + 0.02, fit.ground + 0.20), y1Out = Math.min(t1.y + 0.02, fit.ground + 0.20);
      const y0In = Math.max(fit.ground + 0.08, y0Out - 0.06), y1In = Math.max(fit.ground + 0.08, y1Out - 0.06);
      const z0Out = t0.z - 0.03, z1Out = t1.z - 0.03;
      const z0In = t0.z + depth, z1In = t1.z + depth;
      b.addQuad([x0, y0In, z0In], [x1, y1In, z1In], [x1, y1Out, z1Out], [x0, y0Out, z0Out]);
      b.addQuad([x0, y0Out - thick, z0Out], [x1, y1Out - thick, z1Out], [x1, y1In - thick, z1In], [x0, y0In - thick, z0In]);
    }
    for (const f of [-0.65, -0.32, 0.0, 0.32, 0.65]) {
      const xf = f * hw, tf = fit.tail(xf), yf = Math.min(tf.y + 0.02, fit.ground + 0.20);
      b.addBox(xf, yf - 0.045, tf.z + 0.10, 0.006, 0.048, 0.14, 0.16, 0);
    }
    await save('diffuser_race', b, [0.05, 0.05, 0.055, 1.0], 0.36, 0.15);
  }

  // 5. Left & right aero side skirt blades (`skirts_aero.glb`)
  {
    const b = new GeoBuilder();
    const zF = fit.wheels.length ? Math.max(...fit.wheels.map((w) => w.z)) - 0.42 : 0.95;
    const zR = fit.wheels.length ? Math.min(...fit.wheels.map((w) => w.z)) + 0.42 : -0.95;
    const N = 20, flare = 0.038, thick = 0.014;
    for (const s of [-1, 1]) {
      for (let i = 0; i < N; i++) {
        const z0 = zR + ((zF - zR) * i) / N, z1 = zR + ((zF - zR) * (i + 1)) / N;
        const s0 = fit.sill(z0, s), s1 = fit.sill(z1, s);
        const x0In = s * (s0.x - 0.08), x1In = s * (s1.x - 0.08);
        const x0Out = s * (s0.x + flare), x1Out = s * (s1.x + flare);
        const y0 = Math.min(s0.y, fit.ground + 0.15), y1 = Math.min(s1.y, fit.ground + 0.15);
        b.addQuad([x0In, y0, z0], [x0Out, y0, z0], [x1Out, y1, z1], [x1In, y1, z1]);
        b.addQuad([x1In, y1 - thick, z1], [x1Out, y1 - thick, z1], [x0Out, y0 - thick, z0], [x0In, y0 - thick, z0]);
      }
      const sEnd = fit.sill(zR + 0.04, s);
      b.addBox(s * (sEnd.x + flare), Math.min(sEnd.y, fit.ground + 0.15) + 0.045, zR + 0.06, 0.005, 0.05, 0.08);
    }
    await save('skirts_aero', b, [0.05, 0.05, 0.055, 1.0], 0.35, 0.15);
  }

  // 6 & 7. Deck-anchored GT Swan-Neck Wing (`wing_gt.glb`) & Ducktail (`wing_ducktail.glb`)
  // Exported relative to SOCKET_Wing ([wm.x, wm.y, wm.z]) so attaching to SOCKET_Wing in UE 5.8 places them flush!
  {
    const wm = fit.wingMount;
    const span = Math.min(1.88, wm.span);
    const gt = new GeoBuilder();
    const h = 0.24, chord = 0.26;
    gt.addBox(0, h, -0.04, span * 0.5, 0.012, chord * 0.5, -0.14, 0);
    gt.addBox(0, h + 0.035, -0.14, span * 0.49, 0.008, chord * 0.22, -0.26, 0);
    for (const s of [-1, 1]) {
      gt.addBox(s * span * 0.5, h + 0.01, -0.06, 0.007, 0.11, chord * 0.62);
      gt.addBox(s * span * 0.28, h * 0.52, 0.02, 0.012, h * 0.56, 0.045, 0.12, 0);
      gt.addBox(s * span * 0.28, h + 0.04, -0.01, 0.012, 0.045, 0.07, -0.25, 0);
    }
    await save('wing_gt', gt, [0.04, 0.04, 0.045, 1.0], 0.28, 0.2);

    const dt = new GeoBuilder();
    dt.addBox(0, 0.045, -0.02, span * 0.44, 0.016, 0.11, -0.48, 0);
    await save('wing_ducktail', dt, [0.06, 0.06, 0.065, 1.0], 0.28, 0.2);

    // 7b. Towering RS Swan-Neck DRS Wing (`wing_swan_rs.glb`, Reel 5 GT3 RS style)
    const rs = new GeoBuilder();
    const hRs = 0.38, chRs = 0.28;
    rs.addBox(0, hRs, -0.05, span * 0.52, 0.014, chRs * 0.5, -0.14, 0);
    rs.addBox(0, hRs + 0.055, -0.15, span * 0.51, 0.009, chRs * 0.24, -0.26, 0);
    rs.addBox(0, 0.035, 0.04, span * 0.44, 0.014, 0.08, -0.38, 0);
    for (const s of [-1, 1]) {
      rs.addBox(s * span * 0.52, hRs + 0.02, -0.08, 0.008, 0.135, chRs * 0.72);
      rs.addBox(s * span * 0.18, hRs * 0.52, 0.02, 0.013, hRs * 0.56, 0.05, 0.16, 0);
      rs.addBox(s * span * 0.18, hRs + 0.045, -0.02, 0.013, 0.05, 0.08, -0.28, 0);
    }
    await save('wing_swan_rs', rs, [0.04, 0.04, 0.045, 1.0], 0.26, 0.22);

    // 7c. Group-B Fender-to-Fender Bridge Wing (`wing_bridge_037.glb`, Reel 2 Kimera EVO37 style)
    const br = new GeoBuilder();
    br.addBox(0, 0.22, -0.02, span * 0.49, 0.016, 0.13, -0.12, 0);
    for (const s of [-1, 1]) {
      br.addBox(s * span * 0.48, 0.11, 0.02, 0.018, 0.125, 0.20, 0.14, 0);
    }
    await save('wing_bridge_037', br, [0.76, 0.79, 0.82, 1.0], 0.22, 0.45);

    // 7d. High-Angle Tilted Rally Roof Spoiler (`wing_rally_roof.glb`, Reel 6 Ice Blue Delta style)
    const rr = new GeoBuilder();
    const roofLift = Math.max(0.28, (fit.max[1] - wm.y) + 0.06);
    rr.addBox(0, roofLift, 0.22, span * 0.39, 0.015, 0.12, -0.54, 0);
    for (const s of [-1, 1]) {
      rr.addBox(s * span * 0.38, roofLift - 0.03, 0.24, 0.013, 0.075, 0.14, -0.45, 0);
    }
    await save('wing_rally_roof', rr, [0.48, 0.64, 0.76, 1.0], 0.22, 0.42);
  }

  // 8..11. Custom 3D Alloy Rims (`rim_5spoke.glb`, `rim_mesh.glb`, `rim_te37.glb`, `rim_turbofan.glb`) centred on hub origin
  const rRim = (fit.wheels[0]?.r ?? 0.34) * 0.72, wRim = 0.24;
  for (const [name, spokes, split, col, turbofan] of [
    ['rim_5spoke', 5, false, [0.78, 0.80, 0.83, 1.0], false],
    ['rim_mesh', 10, true, [0.72, 0.58, 0.24, 1.0], false],
    ['rim_te37', 6, false, [0.18, 0.16, 0.14, 1.0], false],
    ['rim_turbofan', 16, false, [0.94, 0.96, 0.98, 1.0], true],
  ]) {
    const b = new GeoBuilder();
    const segs = 28;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * 2 * Math.PI, a1 = ((i + 1) / segs) * 2 * Math.PI;
      const y0 = Math.sin(a0) * rRim, z0 = Math.cos(a0) * rRim;
      const y1 = Math.sin(a1) * rRim, z1 = Math.cos(a1) * rRim;
      b.addQuad([-wRim * 0.5, y0, z0], [wRim * 0.5, y0, z0], [wRim * 0.5, y1, z1], [-wRim * 0.5, y1, z1]);
      if (turbofan) {
        const y0i = Math.sin(a0) * rRim * 0.22, z0i = Math.cos(a0) * rRim * 0.22;
        const y1i = Math.sin(a1) * rRim * 0.22, z1i = Math.cos(a1) * rRim * 0.22;
        const y0o = Math.sin(a0) * rRim * 0.84, z0o = Math.cos(a0) * rRim * 0.84;
        const y1o = Math.sin(a1) * rRim * 0.84, z1o = Math.cos(a1) * rRim * 0.84;
        b.addQuad([wRim * 0.26, y0i, z0i], [wRim * 0.30, y0o, z0o], [wRim * 0.30, y1o, z1o], [wRim * 0.26, y1i, z1i]);
      }
    }
    b.addBox(wRim * 0.18, 0, 0, 0.035, rRim * 0.24, rRim * 0.24);
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * 2 * Math.PI;
      if (split) {
        for (const da of [-0.09, 0.09]) {
          const ym = Math.sin(a + da) * rRim * 0.56, zm = Math.cos(a + da) * rRim * 0.56;
          b.addBox(wRim * 0.22, ym, zm, 0.014, 0.012, rRim * 0.42, -(a + da * 1.6), 0);
        }
      } else {
        const ym = Math.sin(a) * rRim * 0.54, zm = Math.cos(a) * rRim * 0.54;
        b.addBox(wRim * 0.22, ym, zm, 0.016, turbofan ? 0.014 : 0.024, rRim * 0.44, -a, 0);
      }
    }
    await save(name, b, col, turbofan ? 0.20 : 0.22, turbofan ? 0.35 : 0.88);
  }
  return written;
}

async function exportCar(id) {
  const visual = JSON.parse(fs.readFileSync(path.join(DATA, `${id}.visual.json`), 'utf8'));
  const src = modelFile(visual.model);
  if (!fs.existsSync(src)) return { id, error: `model not found: ${src}` };
  const ktx2 = usesKtx2(src);
  const basisu = ktx2 ? findBasisu() : null;
  if (ktx2 && !basisu) return { id, error: 'KTX2 textures and no basisu: run `npm i --no-save basis_universal` in web/ and export again' };
  const note = ktx2 ? 'KTX2 textures decoded to PNG' : null;

  const nodes = visual.wheel_nodes || {};
  const wheelNames = WHEELS.map((w) => nodes[w.toLowerCase()] || `wheel_${w}`);
  const caliperNames = WHEELS.map((w) => `caliper_${w}`);
  const wingName = 'wing';
  const outDir = path.join(OUT, id);
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    car: visual.name,
    source: path.relative(REPO, src),
    notes: [note].filter(Boolean),
    files: {},
    hubs_m: {},
    sockets_m: {},
    sockets_ue_cm: {},
    morph_targets: [],
  };

  // Probe the full scene graph (not just direct scene children) after dequantize so nested wheel/caliper/wing nodes are found.
  const probe = await io.read(src);
  probe.setLogger(quiet);
  await probe.transform(dequantize());
  const allNodes = new Map();
  for (const n of probe.getRoot().listNodes()) if (n.getName()) allNodes.set(n.getName(), n);

  const movingNames = new Set([...wheelNames, ...caliperNames].filter((n) => allNodes.has(n)));
  const hasStockWing = allNodes.has(wingName);
  const excludeFromBody = new Set([...movingNames, ...(hasStockWing ? [wingName] : [])]);

  const wheelFit = [];
  for (let i = 0; i < 4; i++) {
    const wn = allNodes.get(wheelNames[i]);
    if (wn) {
      const wb = nodeBounds(wn);
      const r = Math.max(0.28, (wb.size[1] + wb.size[2]) * 0.25);
      manifest.hubs_m[`wheel_${WHEELS[i]}`] = wb.center.map((v) => +v.toFixed(4));
      wheelFit.push({ x: wb.center[0], y: wb.center[1], z: wb.center[2], r });
    }
    const cn = allNodes.get(caliperNames[i]);
    if (cn) {
      const cb = nodeBounds(cn);
      manifest.hubs_m[`caliper_${WHEELS[i]}`] = cb.center.map((v) => +v.toFixed(4));
    }
  }

  let fit = null;
  const finalizeAndWrite = async (doc, outName, addExtras = null) => {
    if (basisu) decodeKtx2Textures(doc, basisu);
    await doc.transform(
      textureCompress({ encoder: sharp, targetFormat: 'png', slots: /.*/ }),
      prune(),
    );
    if (addExtras) addExtras(doc);
    for (const ext of doc.getRoot().listExtensionsUsed()) {
      if (['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp', 'KHR_texture_basisu'].includes(ext.extensionName)) ext.dispose();
    }
    const out = path.join(outDir, `${outName}.glb`);
    await io.write(out, doc);
    return fs.statSync(out).size;
  };

  // 1. Export body.glb (with 6 crash morph targets, 2 widebody morph targets, and SOCKET_* child nodes)
  {
    const doc = await io.read(src);
    doc.setLogger(quiet);
    await doc.transform(dequantize());
    const { node: bodyNode, mesh: bodyMesh, prims } = isolateTree(
      doc,
      (n, anc) => {
        if (excludeFromBody.has(n.getName())) return false;
        // Walk up ancestors to skip children of wheel/caliper/wing subtrees
        let p = n.getParentNode();
        while (p) { if (excludeFromBody.has(p.getName())) return false; p = p.getParentNode(); }
        return true;
      },
      'body',
      null,
    );
    fit = sampleBodyFit(bodyMesh, wheelFit);
    const wm = fit.wingMount;
    const noseMid = fit.nose(0), tailMid = fit.tail(0);
    const sillL = fit.sill(0, 1), sillR = fit.sill(0, -1);
    const sockets = {
      SOCKET_Wheel_FL: manifest.hubs_m.wheel_FL || [fit.halfWidth * 0.82, 0.34, 1.38],
      SOCKET_Wheel_FR: manifest.hubs_m.wheel_FR || [-fit.halfWidth * 0.82, 0.34, 1.38],
      SOCKET_Wheel_RL: manifest.hubs_m.wheel_RL || [fit.halfWidth * 0.82, 0.34, -1.38],
      SOCKET_Wheel_RR: manifest.hubs_m.wheel_RR || [-fit.halfWidth * 0.82, 0.34, -1.38],
      SOCKET_Caliper_FL: manifest.hubs_m.caliper_FL || manifest.hubs_m.wheel_FL || [fit.halfWidth * 0.82, 0.34, 1.38],
      SOCKET_Caliper_FR: manifest.hubs_m.caliper_FR || manifest.hubs_m.wheel_FR || [-fit.halfWidth * 0.82, 0.34, 1.38],
      SOCKET_Caliper_RL: manifest.hubs_m.caliper_RL || manifest.hubs_m.wheel_RL || [fit.halfWidth * 0.82, 0.34, -1.38],
      SOCKET_Caliper_RR: manifest.hubs_m.caliper_RR || manifest.hubs_m.wheel_RR || [-fit.halfWidth * 0.82, 0.34, -1.38],
      SOCKET_Wing: [wm.x, wm.y, wm.z],
      SOCKET_Splitter: [0, Math.min(noseMid.y, fit.ground + 0.16), noseMid.z],
      SOCKET_Diffuser: [0, Math.min(tailMid.y, fit.ground + 0.18), tailMid.z],
      SOCKET_Skirt_L: [sillL.x, Math.min(sillL.y, fit.ground + 0.15), 0],
      SOCKET_Skirt_R: [-sillR.x, Math.min(sillR.y, fit.ground + 0.15), 0],
      SOCKET_Exhaust_L: [fit.halfWidth * 0.42, Math.min(tailMid.y + 0.04, fit.ground + 0.22), tailMid.z - 0.02],
      SOCKET_Exhaust_R: [-fit.halfWidth * 0.42, Math.min(tailMid.y + 0.04, fit.ground + 0.22), tailMid.z - 0.02],
      SOCKET_Plate_Rear: [0, fit.ground + (fit.max[1] - fit.ground) * 0.38, tailMid.z - 0.015],
    };
    for (const [sName, pos] of Object.entries(sockets)) {
      const p = pos.map((v) => +v.toFixed(4));
      manifest.sockets_m[sName] = p;
      // glTF (+Z forward, +X left, +Y up, m) -> UE 5.8 (+X forward, +Y right, +Z up, cm)
      manifest.sockets_ue_cm[sName] = [+(p[2] * 100).toFixed(2), +(-p[0] * 100).toFixed(2), +(p[1] * 100).toFixed(2)];
    }
    const bytes = await finalizeAndWrite(doc, 'body', (d) => {
      manifest.morph_targets = addBodyMorphTargets(d, bodyMesh, fit);
      for (const [sName, pos] of Object.entries(manifest.sockets_m)) {
        bodyNode.addChild(d.createNode(sName).setTranslation(pos));
      }
    });
    manifest.files.body = { primitives: prims, bytes };
  }

  // 2. Export wheel_FL..RR.glb and caliper_FL..RR.glb centred on their hubs
  for (let i = 0; i < 4; i++) {
    for (const [prefix, targetName] of [['wheel', wheelNames[i]], ['caliper', caliperNames[i]]]) {
      if (!movingNames.has(targetName)) continue;
      const outKey = `${prefix}_${WHEELS[i]}`;
      const hub = manifest.hubs_m[outKey] || manifest.hubs_m[`wheel_${WHEELS[i]}`] || [0, 0, 0];
      const doc = await io.read(src);
      doc.setLogger(quiet);
      await doc.transform(dequantize());
      const { prims } = isolateTree(
        doc,
        (n) => {
          let p = n;
          while (p) { if (p.getName() === targetName) return true; p = p.getParentNode(); }
          return false;
        },
        outKey,
        hub,
      );
      if (prims > 0) {
        const bytes = await finalizeAndWrite(doc, outKey);
        manifest.files[outKey] = { primitives: prims, bytes };
      }
    }
  }

  // 3. Export stock_wing.glb (if present, recentred to SOCKET_Wing so UE 5.8 can toggle/replace it cleanly)
  if (hasStockWing) {
    const doc = await io.read(src);
    doc.setLogger(quiet);
    await doc.transform(dequantize());
    const { prims } = isolateTree(
      doc,
      (n) => {
        let p = n;
        while (p) { if (p.getName() === wingName) return true; p = p.getParentNode(); }
        return false;
      },
      'stock_wing',
      manifest.sockets_m.SOCKET_Wing,
    );
    if (prims > 0) {
      const bytes = await finalizeAndWrite(doc, 'stock_wing');
      manifest.files.stock_wing = { primitives: prims, bytes };
    }
  }

  // 4. Export modular aftermarket part meshes (parts/*.glb)
  const partFiles = await exportModularParts(outDir, fit);
  Object.assign(manifest.files, partFiles);

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { id, files: Object.keys(manifest.files).length, morphs: manifest.morph_targets.length, notes: manifest.notes };
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
    else console.log(`✓ ${id}: ${r.files} glTFs (${r.morphs} morph targets, 16 sockets) -> ue5/Import/${id}/${r.notes.length ? '  (' + r.notes.join('; ') + ')' : ''}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${id}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
