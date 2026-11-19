// Standalone Native WebGPU Meshlet Compute Culling & Index Compaction Shader (Engine-Agnostic, OpenGrid).
// Ready for direct use with `device.createComputePipeline(...)` and `passEncoder.drawIndexedIndirect(indirectBuf, 0)`.

struct CullUniforms {
  planes: array<vec4<f32>, 6>,
  camPosAndMaxDist: vec4<f32>,     // xyz = camera position (object/world space), w = maxDist
  counts: vec4<u32>,               // x = activeMeshlets, yzw = reserved
}

@group(0) @binding(0) var<uniform> uCull: CullUniforms;
@group(0) @binding(1) var<storage, read> meshletSpheres: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> meshletCones: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> meshletApices: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> meshletSlices: array<vec4<u32>>;
@group(0) @binding(5) var<storage, read> sourceIndices: array<u32>;
@group(0) @binding(6) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(7) var<storage, read_write> indirectArgs: array<atomic<u32>, 5>;
@group(0) @binding(8) var<storage, read_write> cullStats: array<atomic<u32>, 4>;

@compute @workgroup_size(1)
fn resetArgs() {
  atomicStore(&indirectArgs[0], 0u); // indexCount
  atomicStore(&indirectArgs[1], 1u); // instanceCount
  atomicStore(&indirectArgs[2], 0u); // firstIndex
  atomicStore(&indirectArgs[3], 0u); // baseVertex
  atomicStore(&indirectArgs[4], 0u); // firstInstance
  atomicStore(&cullStats[0], 0u);    // visibleMeshlets
  atomicStore(&cullStats[1], 0u);    // frustumCulled
  atomicStore(&cullStats[2], 0u);    // coneCulled
  atomicStore(&cullStats[3], 0u);    // visibleIndices
}

@compute @workgroup_size(64)
fn cullAndCompact(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  if (m >= uCull.counts.x) {
    return;
  }

  let slice = meshletSlices[m];
  let firstIndex = slice.x;
  let indexCount = slice.y;
  if (indexCount == 0u) {
    return;
  }

  let code = cullMeshletTest(
    meshletSpheres[m],
    meshletCones[m],
    meshletApices[m],
    uCull.camPosAndMaxDist.xyz,
    uCull.planes[0],
    uCull.planes[1],
    uCull.planes[2],
    uCull.planes[3],
    uCull.planes[4],
    uCull.planes[5],
    uCull.camPosAndMaxDist.w
  );

  if (code == 0) {
    let outBase = atomicAdd(&indirectArgs[0], indexCount);
    atomicAdd(&cullStats[0], 1u);
    atomicAdd(&cullStats[3], indexCount);
    for (var i = 0u; i < indexCount; i++) {
      visibleIndices[outBase + i] = sourceIndices[firstIndex + i];
    }
  } else if (code == 1) {
    atomicAdd(&cullStats[1], 1u);
  } else {
    atomicAdd(&cullStats[2], 1u);
  }
}
