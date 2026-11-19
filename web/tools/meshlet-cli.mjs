#!/usr/bin/env node
// meshlet-cli.mjs - Offline 'Nanite' meshlet asset compiler for OpenGrid (Node.js + meshoptimizer).
//
// Converts .glb car and city/track models (including EXT_meshopt_compression & quantized glTF) into
// GPU-ready .mlet meshlet buffer containers for WebGPU compute frustum + normal-cone culling and
// drawIndexedIndirect rendering (see web/src/fx/meshletCuller.ts).
//
// Usage:
//   node web/tools/meshlet-cli.mjs <in.glb|dir> [--out <out.mlet|dir>] [--max-verts 64]
//                                  [--max-tris 124] [--cone-weight 0.25] [--json-stats] [--dry]
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptClusterizer } from '../node_modules/three/examples/jsm/libs/meshopt_clusterizer.module.js';
import { MeshoptDecoder } from '../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';

const MAGIC = 0x54454c4d; // 'MLET' little-endian
const FORMAT_VERSION = 1;

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

// ---- minimal 4x4 matrix math (column-major, glTF convention) ----------------------------------------------------------
function mat4Identity() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Mul(a, b) {
  const o = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4], b1 = b[col * 4 + 1], b2 = b[col * 4 + 2], b3 = b[col * 4 + 3];
    o[col * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return o;
}

function nodeLocalMatrix(node) {
  if (node.matrix && node.matrix.length === 16) return Float64Array.from(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ]);
}

function normalMatrix3(m) {
  // Inverse-transpose of upper-left 3x3
  const a00 = m[0], a01 = m[4], a02 = m[8];
  const a10 = m[1], a11 = m[5], a12 = m[9];
  const a20 = m[2], a21 = m[6], a22 = m[10];
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-12) return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const inv = 1 / det;
  // transpose(inv(A)) stored row-major for direct dot
  return new Float64Array([
    b01 * inv, b11 * inv, b21 * inv,
    (-a22 * a01 + a02 * a21) * inv, (a22 * a00 - a02 * a20) * inv, (-a21 * a00 + a01 * a20) * inv,
    (a12 * a01 - a02 * a11) * inv, (-a12 * a00 + a02 * a10) * inv, (a11 * a00 - a01 * a10) * inv,
  ]);
}

// ---- GLB parser + EXT_meshopt_compression decoder ---------------------------------------------------------------------
function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a valid GLB file');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`Unsupported glTF version ${version}`);
  let off = 12;
  let gltf = null;
  let bin = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    off += 8;
    const slice = buf.subarray(off, off + len);
    if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(slice));
    else if (type === 0x004e4942) bin = slice;
    off += len;
  }
  if (!gltf) throw new Error('GLB missing JSON chunk');
  return { gltf, bin: bin ?? new Uint8Array(0) };
}

function decodeBufferViews(gltf, bin) {
  const views = gltf.bufferViews ?? [];
  const decoded = new Array(views.length);
  for (let i = 0; i < views.length; i++) {
    const bv = views[i];
    const ext = bv.extensions?.EXT_meshopt_compression;
    if (ext) {
      const byteOffset = ext.byteOffset ?? 0;
      const byteLength = ext.byteLength ?? 0;
      const count = ext.count;
      const stride = ext.byteStride;
      const src = new Uint8Array(bin.buffer, bin.byteOffset + byteOffset, byteLength);
      const out = new Uint8Array(count * stride);
      MeshoptDecoder.decodeGltfBuffer(out, count, stride, src, ext.mode, ext.filter ?? 'NONE');
      decoded[i] = out;
    } else {
      const byteOffset = bv.byteOffset ?? 0;
      const byteLength = bv.byteLength ?? 0;
      decoded[i] = new Uint8Array(bin.buffer, bin.byteOffset + byteOffset, byteLength);
    }
  }
  return decoded;
}

function readScalar(dv, byteOff, componentType, normalized) {
  switch (componentType) {
    case 5120: { const v = dv.getInt8(byteOff); return normalized ? Math.max(v / 127, -1) : v; }
    case 5121: { const v = dv.getUint8(byteOff); return normalized ? v / 255 : v; }
    case 5122: { const v = dv.getInt16(byteOff, true); return normalized ? Math.max(v / 32767, -1) : v; }
    case 5123: { const v = dv.getUint16(byteOff, true); return normalized ? v / 65535 : v; }
    case 5125: return dv.getUint32(byteOff, true);
    case 5126: return dv.getFloat32(byteOff, true);
    default: throw new Error(`Unsupported componentType ${componentType}`);
  }
}

function readAccessor(gltf, decodedViews, accessorIdx) {
  const acc = gltf.accessors[accessorIdx];
  const bvIdx = acc.bufferView;
  const comps = TYPE_COUNT[acc.type];
  const compSize = COMPONENT_SIZE[acc.componentType];
  const count = acc.count;
  const normalized = !!acc.normalized;
  const out = acc.componentType === 5125 && !normalized && comps === 1
    ? new Uint32Array(count)
    : new Float32Array(count * comps);

  if (bvIdx !== undefined) {
    const bv = gltf.bufferViews[bvIdx];
    const viewBytes = decodedViews[bvIdx];
    const stride = bv.byteStride ?? comps * compSize;
    const baseOff = acc.byteOffset ?? 0;
    const dv = new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength);
    for (let i = 0; i < count; i++) {
      const elemOff = baseOff + i * stride;
      for (let c = 0; c < comps; c++) {
        out[i * comps + c] = readScalar(dv, elemOff + c * compSize, acc.componentType, normalized);
      }
    }
  }
  return { data: out, count, comps };
}

// ---- GLB -> meshlet compiler ------------------------------------------------------------------------------------------
export function compileGlbToMeshlets(glbBytes, opts = {}) {
  const maxVerts = opts.maxVerts ?? 64;
  const maxTris = opts.maxTris ?? 124;
  const coneWeight = opts.coneWeight ?? 0.25;

  const { gltf, bin } = parseGlb(glbBytes);
  const decodedViews = decodeBufferViews(gltf, bin);

  // Collect world-transformed mesh primitives from scene graph
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const materials = gltf.materials ?? [];
  const sceneIdx = gltf.scene ?? 0;
  const roots = gltf.scenes?.[sceneIdx]?.nodes ?? nodes.map((_, i) => i);

  // Group geometry by material index so each material forms a compact meshlet batch
  const byMat = new Map();
  function getMatBucket(matIdx) {
    const key = matIdx ?? -1;
    let b = byMat.get(key);
    if (!b) {
      b = {
        materialIndex: key,
        materialName: key >= 0 ? (materials[key]?.name || `mat_${key}`) : 'default',
        positions: [],
        normals: [],
        uvs: [],
        indices: [],
        vertCount: 0,
      };
      byMat.set(key, b);
    }
    return b;
  }

  function visitNode(nodeIdx, parentMat) {
    const node = nodes[nodeIdx];
    if (!node) return;
    if (node.name && node.name.endsWith('-colonly')) return; // skip physics-only collision meshes
    const world = mat4Mul(parentMat, nodeLocalMatrix(node));
    if (node.mesh !== undefined && meshes[node.mesh]) {
      const nMat = normalMatrix3(world);
      const det3 =
        world[0] * (world[5] * world[10] - world[9] * world[6]) -
        world[4] * (world[1] * world[10] - world[9] * world[2]) +
        world[8] * (world[1] * world[6] - world[5] * world[2]);
      const flipWinding = det3 < 0;

      for (const prim of meshes[node.mesh].primitives ?? []) {
        if ((prim.mode ?? 4) !== 4) continue; // TRIANGLES only
        if (prim.attributes?.POSITION === undefined) continue;

        const posAcc = readAccessor(gltf, decodedViews, prim.attributes.POSITION);
        const nrmAcc = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, decodedViews, prim.attributes.NORMAL) : null;
        const uvAcc = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(gltf, decodedViews, prim.attributes.TEXCOORD_0) : null;

        const bucket = getMatBucket(prim.material);
        const baseV = bucket.vertCount;
        const vCount = posAcc.count;

        for (let i = 0; i < vCount; i++) {
          const px = posAcc.data[i * 3], py = posAcc.data[i * 3 + 1], pz = posAcc.data[i * 3 + 2];
          bucket.positions.push(
            world[0] * px + world[4] * py + world[8] * pz + world[12],
            world[1] * px + world[5] * py + world[9] * pz + world[13],
            world[2] * px + world[6] * py + world[10] * pz + world[14],
          );
          if (nrmAcc) {
            const nx = nrmAcc.data[i * 3], ny = nrmAcc.data[i * 3 + 1], nz = nrmAcc.data[i * 3 + 2];
            const tx = nMat[0] * nx + nMat[1] * ny + nMat[2] * nz;
            const ty = nMat[3] * nx + nMat[4] * ny + nMat[5] * nz;
            const tz = nMat[6] * nx + nMat[7] * ny + nMat[8] * nz;
            const len = Math.hypot(tx, ty, tz) || 1;
            bucket.normals.push(tx / len, ty / len, tz / len);
          } else {
            bucket.normals.push(0, 1, 0);
          }
          if (uvAcc) {
            bucket.uvs.push(uvAcc.data[i * 2], uvAcc.data[i * 2 + 1]);
          } else {
            bucket.uvs.push(0, 0);
          }
        }

        if (prim.indices !== undefined) {
          const idxAcc = readAccessor(gltf, decodedViews, prim.indices);
          const nTris = Math.floor(idxAcc.count / 3);
          for (let t = 0; t < nTris; t++) {
            const i0 = baseV + Math.round(idxAcc.data[t * 3]);
            const i1 = baseV + Math.round(idxAcc.data[t * 3 + (flipWinding ? 2 : 1)]);
            const i2 = baseV + Math.round(idxAcc.data[t * 3 + (flipWinding ? 1 : 2)]);
            bucket.indices.push(i0, i1, i2);
          }
        } else {
          const nTris = Math.floor(vCount / 3);
          for (let t = 0; t < nTris; t++) {
            const i0 = baseV + t * 3;
            const i1 = baseV + t * 3 + (flipWinding ? 2 : 1);
            const i2 = baseV + t * 3 + (flipWinding ? 1 : 2);
            bucket.indices.push(i0, i1, i2);
          }
        }
        bucket.vertCount += vCount;
      }
    }
    for (const child of node.children ?? []) visitNode(child, world);
  }

  const rootMat = mat4Identity();
  for (const r of roots) visitNode(r, rootMat);

  // Build meshoptimizer meshlets per material bucket and pack into unified GPU buffers
  const allPos = [];
  const allNrm = [];
  const allUv = [];
  const allIdx = [];
  const spheres = [];  // vec4<f32>: center.xyz, radius
  const cones = [];    // vec4<f32>: axis.xyz, cutoff
  const apices = [];   // vec4<f32>: apex.xyz, maxDist
  const slices = [];   // vec4<u32>: firstIndex, indexCount, baseVertex, materialGroup
  const groups = [];

  let totalInputTris = 0;
  let totalMeshlets = 0;
  let coneCullableCount = 0;
  let globalVertBase = 0;
  let globalIdxBase = 0;

  let groupId = 0;
  for (const bucket of byMat.values()) {
    if (bucket.indices.length < 3) continue;
    const posF32 = Float32Array.from(bucket.positions);
    const idxU32 = Uint32Array.from(bucket.indices);
    totalInputTris += idxU32.length / 3;

    const ml = MeshoptClusterizer.buildMeshlets(idxU32, posF32, 3, maxVerts, maxTris, coneWeight);
    const bounds = MeshoptClusterizer.computeMeshletBounds(ml, posF32, 3);

    const groupFirstMeshlet = totalMeshlets;
    const groupFirstIndex = globalIdxBase;
    const groupFirstVertex = globalVertBase;

    for (let i = 0; i < posF32.length; i++) allPos.push(posF32[i]);
    for (let i = 0; i < bucket.normals.length; i++) allNrm.push(bucket.normals[i]);
    for (let i = 0; i < bucket.uvs.length; i++) allUv.push(bucket.uvs[i]);

    for (let m = 0; m < ml.meshletCount; m++) {
      const vOff = ml.meshlets[m * 4 + 0];
      const tOff = ml.meshlets[m * 4 + 1];
      const tCount = ml.meshlets[m * 4 + 3];
      const b = bounds[m];
      const firstIndex = globalIdxBase;
      const indexCount = tCount * 3;

      for (let t = 0; t < tCount; t++) {
        const a = ml.vertices[vOff + ml.triangles[tOff + t * 3 + 0]];
        const c = ml.vertices[vOff + ml.triangles[tOff + t * 3 + 1]];
        const d = ml.vertices[vOff + ml.triangles[tOff + t * 3 + 2]];
        allIdx.push(globalVertBase + a, globalVertBase + c, globalVertBase + d);
      }

      spheres.push(b.centerX, b.centerY, b.centerZ, b.radius);
      cones.push(b.coneAxisX, b.coneAxisY, b.coneAxisZ, b.coneCutoff);
      apices.push(b.coneApexX, b.coneApexY, b.coneApexZ, 0);
      slices.push(firstIndex, indexCount, 0, groupId);
      if (b.coneCutoff < 0.999) coneCullableCount++;

      globalIdxBase += indexCount;
      totalMeshlets++;
    }

    groups.push({
      id: groupId,
      materialName: bucket.materialName,
      firstMeshlet: groupFirstMeshlet,
      meshletCount: ml.meshletCount,
      firstVertex: groupFirstVertex,
      vertexCount: bucket.vertCount,
      firstIndex: groupFirstIndex,
      indexCount: globalIdxBase - groupFirstIndex,
    });
    globalVertBase += bucket.vertCount;
    groupId++;
  }

  const positions = Float32Array.from(allPos);
  const normals = Float32Array.from(allNrm);
  const uvs = Float32Array.from(allUv);
  const indices = Uint32Array.from(allIdx);
  const meshletSpheres = Float32Array.from(spheres);
  const meshletCones = Float32Array.from(cones);
  const meshletApices = Float32Array.from(apices);
  const meshletSlices = Uint32Array.from(slices);

  const meta = {
    version: FORMAT_VERSION,
    maxVerts,
    maxTris,
    coneWeight,
    vertexCount: globalVertBase,
    indexCount: indices.length,
    triangleCount: totalInputTris,
    meshletCount: totalMeshlets,
    coneCullableRatio: totalMeshlets > 0 ? +(coneCullableCount / totalMeshlets).toFixed(3) : 0,
    avgTrisPerMeshlet: totalMeshlets > 0 ? +(totalInputTris / totalMeshlets).toFixed(1) : 0,
    groups,
  };

  // Serialize binary .mlet container:
  //   [0..3]  u32 MAGIC ('MLET')
  //   [4..7]  u32 version (1)
  //   [8..11] u32 jsonByteLength (padded to 16 bytes)
  //   [12..15] u32 reserved (0)
  //   [16..]  UTF-8 JSON header (zero-padded to 16-byte alignment)
  //   followed by 16-byte-aligned binary sections in exact order:
  //     positions (f32*3*V), normals (f32*3*V), uvs (f32*2*V), indices (u32*I),
  //     meshletSpheres (f32*4*M), meshletCones (f32*4*M), meshletApices (f32*4*M), meshletSlices (u32*4*M)
  const align16 = (n) => (n + 15) & ~15;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(meta));
  const jsonPadded = align16(jsonBytes.byteLength);
  const sections = [positions, normals, uvs, indices, meshletSpheres, meshletCones, meshletApices, meshletSlices];
  let totalBytes = 16 + jsonPadded;
  for (const s of sections) totalBytes += align16(s.byteLength);

  const outBuf = new Uint8Array(totalBytes);
  const hdr = new DataView(outBuf.buffer);
  hdr.setUint32(0, MAGIC, true);
  hdr.setUint32(4, FORMAT_VERSION, true);
  hdr.setUint32(8, jsonPadded, true);
  hdr.setUint32(12, 0, true);
  outBuf.set(jsonBytes, 16);

  let cursor = 16 + jsonPadded;
  for (const s of sections) {
    outBuf.set(new Uint8Array(s.buffer, s.byteOffset, s.byteLength), cursor);
    cursor += align16(s.byteLength);
  }

  return { buffer: outBuf, meta };
}

// ---- CLI entry --------------------------------------------------------------------------------------------------------
async function runCli() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(
      'usage: node web/tools/meshlet-cli.mjs <in.glb|dir> [--out <file.mlet|dir>] [--max-verts 64] [--max-tris 124] [--cone-weight 0.25] [--json-stats] [--dry]',
    );
    process.exit(argv.length ? 0 : 1);
  }

  await Promise.all([MeshoptClusterizer.ready, MeshoptDecoder.ready]);

  const opts = { maxVerts: 64, maxTris: 124, coneWeight: 0.25, out: null, jsonStats: false, dry: false };
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--max-verts') opts.maxVerts = Number(argv[++i]);
    else if (a === '--max-tris') opts.maxTris = Number(argv[++i]);
    else if (a === '--cone-weight') opts.coneWeight = Number(argv[++i]);
    else if (a === '--json-stats') opts.jsonStats = true;
    else if (a === '--dry') opts.dry = true;
    else inputs.push(a);
  }

  const files = [];
  for (const inp of inputs) {
    const p = resolve(inp);
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) if (extname(f).toLowerCase() === '.glb') files.push(join(p, f));
    } else if (extname(p).toLowerCase() === '.glb') {
      files.push(p);
    }
  }
  if (!files.length) {
    console.error('meshlet-cli: no .glb files found');
    process.exit(1);
  }

  const reports = [];
  for (const file of files) {
    const t0 = performance.now();
    const glb = readFileSync(file);
    const { buffer, meta } = compileGlbToMeshlets(glb, opts);
    const ms = +(performance.now() - t0).toFixed(1);

    let outPath;
    if (opts.out) {
      const outRes = resolve(opts.out);
      outPath = files.length === 1 && extname(outRes) === '.mlet'
        ? outRes
        : join(outRes, basename(file).replace(/\.glb$/i, '.mlet'));
    } else {
      outPath = file.replace(/\.glb$/i, '.mlet');
    }

    if (!opts.dry) {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buffer);
    }

    const rep = {
      input: basename(file),
      output: opts.dry ? '(dry-run)' : outPath,
      inputKB: +(glb.byteLength / 1024).toFixed(1),
      outputKB: +(buffer.byteLength / 1024).toFixed(1),
      vertices: meta.vertexCount,
      triangles: meta.triangleCount,
      meshlets: meta.meshletCount,
      avgTrisPerMeshlet: meta.avgTrisPerMeshlet,
      coneCullablePct: +(meta.coneCullableRatio * 100).toFixed(1),
      groups: meta.groups.length,
      buildMs: ms,
    };
    reports.push(rep);
    if (!opts.jsonStats) {
      console.log(
        `${rep.input}: ${rep.triangles.toLocaleString()} tris -> ${rep.meshlets.toLocaleString()} meshlets ` +
        `(avg ${rep.avgTrisPerMeshlet} tris/ml, ${rep.coneCullablePct}% cone-cullable, ${rep.groups} mat groups) ` +
        `[${rep.outputKB} KB in ${rep.buildMs} ms] -> ${rep.output}`,
      );
    }
  }
  if (opts.jsonStats) console.log(JSON.stringify(reports, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runCli();
