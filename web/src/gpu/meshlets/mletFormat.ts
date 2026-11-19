// Engine-agnostic `.mlet` Meshlet Binary Container Specification & Parser (ZERO Three.js imports).
// Matches the binary format emitted by `web/tools/meshlet-cli.mjs`.

export const MLET_MAGIC = 0x54454c4d; // 'MLET' little-endian
export const MLET_VERSION = 1;

export interface MletGroupMeta {
  id: number;
  materialName: string;
  firstMeshlet: number;
  meshletCount: number;
  firstVertex: number;
  vertexCount: number;
  firstIndex: number;
  indexCount: number;
}

export interface MletMeta {
  version: number;
  maxVerts: number;
  maxTris: number;
  coneWeight: number;
  vertexCount: number;
  indexCount: number;
  triangleCount: number;
  meshletCount: number;
  coneCullableRatio: number;
  avgTrisPerMeshlet: number;
  groups: MletGroupMeta[];
}

export interface ParsedMlet {
  meta: MletMeta;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  meshletSpheres: Float32Array; // vec4<f32> * M: center.xyz, radius
  meshletCones: Float32Array;   // vec4<f32> * M: axis.xyz, cutoff
  meshletApices: Float32Array;  // vec4<f32> * M: apex.xyz, reserved
  meshletSlices: Uint32Array;   // vec4<u32> * M: firstIndex, indexCount, baseVertex, groupId
}

export interface MeshletBatchGpuStats {
  meshletCount: number;
  visibleMeshlets: number;
  frustumCulled: number;
  coneCulled: number;
  visibleIndices: number;
  totalIndices: number;
}

/** Parse a binary `.mlet` ArrayBuffer into zero-copy TypedArray views ready for WebGPU upload. */
export function parseMletBuffer(buffer: ArrayBuffer): ParsedMlet {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MLET_MAGIC) throw new Error('Invalid .mlet magic header');
  const version = dv.getUint32(4, true);
  if (version !== MLET_VERSION) throw new Error(`Unsupported .mlet version ${version}`);
  const jsonPadded = dv.getUint32(8, true);

  const jsonRaw = new Uint8Array(buffer, 16, jsonPadded);
  let jsonLen = jsonPadded;
  while (jsonLen > 0 && jsonRaw[jsonLen - 1] === 0) jsonLen--;
  const meta = JSON.parse(new TextDecoder().decode(jsonRaw.subarray(0, jsonLen))) as MletMeta;

  const align16 = (n: number) => (n + 15) & ~15;
  let cursor = 16 + jsonPadded;
  const takeF32 = (count: number) => {
    const arr = new Float32Array(buffer, cursor, count);
    cursor += align16(count * 4);
    return arr;
  };
  const takeU32 = (count: number) => {
    const arr = new Uint32Array(buffer, cursor, count);
    cursor += align16(count * 4);
    return arr;
  };

  const V = meta.vertexCount;
  const I = meta.indexCount;
  const M = meta.meshletCount;

  const positions = takeF32(V * 3);
  const normals = takeF32(V * 3);
  const uvs = takeF32(V * 2);
  const indices = takeU32(I);
  const meshletSpheres = takeF32(M * 4);
  const meshletCones = takeF32(M * 4);
  const meshletApices = takeF32(M * 4);
  const meshletSlices = takeU32(M * 4);

  return { meta, positions, normals, uvs, indices, meshletSpheres, meshletCones, meshletApices, meshletSlices };
}
