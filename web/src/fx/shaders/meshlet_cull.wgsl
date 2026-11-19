// WebGPU Compute Meshlet Culling Shader ('Nanite' Pipeline, OpenGrid)
// Per-meshlet 6-plane frustum culling + meshoptimizer normal-cone backface culling + distance culling.
// Return codes:
//   0 = VISIBLE
//   1 = FRUSTUM_CULLED
//   2 = CONE_BACKFACE_CULLED
//   3 = DISTANCE_CULLED

fn cullMeshletTest(
  sphere: vec4<f32>,
  cone: vec4<f32>,
  apex: vec4<f32>,
  camPos: vec3<f32>,
  p0: vec4<f32>,
  p1: vec4<f32>,
  p2: vec4<f32>,
  p3: vec4<f32>,
  p4: vec4<f32>,
  p5: vec4<f32>,
  maxDist: f32
) -> i32 {
  let center = sphere.xyz;
  let radius = sphere.w;

  // 1. 6-plane frustum sphere test (planes point inward; signed distance < -radius is outside)
  if (dot(p0.xyz, center) + p0.w < -radius) { return 1; }
  if (dot(p1.xyz, center) + p1.w < -radius) { return 1; }
  if (dot(p2.xyz, center) + p2.w < -radius) { return 1; }
  if (dot(p3.xyz, center) + p3.w < -radius) { return 1; }
  if (dot(p4.xyz, center) + p4.w < -radius) { return 1; }
  if (dot(p5.xyz, center) + p5.w < -radius) { return 1; }

  // 2. Distance cull (optional; maxDist <= 0 disables)
  if (maxDist > 0.0) {
    let toCenter = center - camPos;
    let dist = length(toCenter);
    if (dist - radius > maxDist) {
      return 3;
    }
  }

  // 3. Meshoptimizer normal-cone backface culling:
  // Cull cluster when camera lies entirely inside the back-facing cone of all triangles in the meshlet.
  // cone.w >= 0.999 marks degenerate/wide cones (> 180 deg) that cannot be backface-culled.
  if (cone.w < 0.999) {
    let viewVec = apex.xyz - camPos;
    let vLen = length(viewVec);
    if (vLen > 1e-4) {
      if (dot(viewVec / vLen, cone.xyz) >= cone.w) {
        return 2;
      }
    }
  }

  return 0;
}
