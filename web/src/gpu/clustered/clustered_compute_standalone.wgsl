// Standalone Native WebGPU Clustered Forward+ Compute Shader (Engine-Agnostic, OpenGrid).
// Ready for direct use with `device.createComputePipeline(...)` in any WebGPU / wgpu engine.

struct ClusterParams {
  gridDims: vec4<u32>,   // x=tilesX, y=tilesY, z=zSlices, w=maxLightsPerCluster
  cameraNear: f32,
  cameraFar: f32,
  invFocalX: f32,
  invFocalY: f32,
}

@group(0) @binding(0) var<uniform> params: ClusterParams;
@group(0) @binding(1) var<storage, read> cullSpheres: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> zSliceRanges: array<vec4<i32>>;
@group(0) @binding(3) var<storage, read_write> clusterLightIndices: array<vec4<i32>>;

fn writeClusterSlot(clusterIdx: u32, chunksPerCluster: u32, slot: u32, encodedLightIdx: i32) {
  let chunk = clusterIdx * chunksPerCluster + (slot >> 2u);
  let lane = slot & 3u;
  var v = clusterLightIndices[chunk];
  if (lane == 0u) { v.x = encodedLightIdx; }
  else if (lane == 1u) { v.y = encodedLightIdx; }
  else if (lane == 2u) { v.z = encodedLightIdx; }
  else { v.w = encodedLightIdx; }
  clusterLightIndices[chunk] = v;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nx = params.gridDims.x;
  let ny = params.gridDims.y;
  let nz = params.gridDims.z;
  let maxPerCluster = params.gridDims.w;
  let totalClusters = nx * ny * nz;
  let clusterIdx = gid.x;
  if (clusterIdx >= totalClusters) {
    return;
  }

  let cx = i32(clusterIdx % nx);
  let cy = i32((clusterIdx / nx) % ny);
  let cz = i32(clusterIdx / (nx * ny));

  let aabbMin = clusterAabbMin(
    cx, cy, cz,
    f32(nx), f32(ny), f32(nz),
    params.cameraNear, params.cameraFar,
    params.invFocalX, params.invFocalY
  );
  let aabbMax = clusterAabbMax(
    cx, cy, cz,
    f32(nx), f32(ny), f32(nz),
    params.cameraNear, params.cameraFar,
    params.invFocalX, params.invFocalY
  );

  let chunksPerCluster = (maxPerCluster + 3u) >> 2u;
  let baseChunk = clusterIdx * chunksPerCluster;
  for (var c = 0u; c < chunksPerCluster; c++) {
    clusterLightIndices[baseChunk + c] = vec4<i32>(0);
  }

  let zRange = zSliceRanges[cz];
  let rangeStart = zRange.x;
  let rangeEnd = zRange.y;

  var writeIdx = 0u;
  for (var li = rangeStart; li < rangeEnd; li++) {
    if (writeIdx >= maxPerCluster) {
      break;
    }
    let sphere = cullSpheres[li];
    if (sphereIntersectsAabb(sphere.xyz, sphere.w, aabbMin, aabbMax) > 0.5) {
      writeClusterSlot(clusterIdx, chunksPerCluster, writeIdx, li + 1);
      writeIdx += 1u;
    }
  }
}
