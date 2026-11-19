// Clustered Forward+ WGSL core math & attenuation library (Engine-Agnostic, OpenGrid)
// Evaluates view-space frustum cluster AABBs, sphere-AABB light culling, resolution-independent
// cluster lookup, and unified PointLight (streetlights) + SpotLight (headlights) attenuation.

fn clusterAabbMin(
  cx: i32,
  cy: i32,
  cz: i32,
  nx: f32,
  ny: f32,
  nz: f32,
  nearZ: f32,
  farZ: f32,
  invFocalX: f32,
  invFocalY: f32
) -> vec3<f32> {
  let fx = f32(cx);
  let fy = f32(cy);
  let fz = f32(cz);

  let ndcXmin = (fx * 2.0 / nx) - 1.0;
  let ndcYmin = 1.0 - ((fy + 1.0) * 2.0 / ny);

  let ratio = farZ / max(nearZ, 0.001);
  let zNear = nearZ * pow(ratio, fz / nz);
  let zFar = nearZ * pow(ratio, (fz + 1.0) / nz);

  let xMinNear = ndcXmin * zNear * invFocalX;
  let xMinFar = ndcXmin * zFar * invFocalX;
  let yMinNear = ndcYmin * zNear * invFocalY;
  let yMinFar = ndcYmin * zFar * invFocalY;

  return vec3<f32>(min(xMinNear, xMinFar), min(yMinNear, yMinFar), -zFar);
}

fn clusterAabbMax(
  cx: i32,
  cy: i32,
  cz: i32,
  nx: f32,
  ny: f32,
  nz: f32,
  nearZ: f32,
  farZ: f32,
  invFocalX: f32,
  invFocalY: f32
) -> vec3<f32> {
  let fx = f32(cx);
  let fy = f32(cy);
  let fz = f32(cz);

  let ndcXmax = ((fx + 1.0) * 2.0 / nx) - 1.0;
  let ndcYmax = 1.0 - (fy * 2.0 / ny);

  let ratio = farZ / max(nearZ, 0.001);
  let zNear = nearZ * pow(ratio, fz / nz);
  let zFar = nearZ * pow(ratio, (fz + 1.0) / nz);

  let xMaxNear = ndcXmax * zNear * invFocalX;
  let xMaxFar = ndcXmax * zFar * invFocalX;
  let yMaxNear = ndcYmax * zNear * invFocalY;
  let yMaxFar = ndcYmax * zFar * invFocalY;

  return vec3<f32>(max(xMaxNear, xMaxFar), max(yMaxNear, yMaxFar), -zNear);
}

fn sphereIntersectsAabb(
  center: vec3<f32>,
  radius: f32,
  aabbMin: vec3<f32>,
  aabbMax: vec3<f32>
) -> f32 {
  let closest = clamp(center, aabbMin, aabbMax);
  let diff = center - closest;
  let distSq = dot(diff, diff);
  return select(0.0, 1.0, distSq <= radius * radius);
}

fn clusterIndexFromScreen(
  suv: vec2<f32>,
  viewDepth: f32,
  nearZ: f32,
  farZ: f32,
  nx: i32,
  ny: i32,
  nz: i32
) -> i32 {
  let fnx = f32(nx);
  let fny = f32(ny);
  let fnz = f32(nz);

  let tx = clamp(i32(floor(suv.x * fnx)), 0, nx - 1);
  let ty = clamp(i32(floor(suv.y * fny)), 0, ny - 1);

  let safeNear = max(nearZ, 0.001);
  let safeDepth = max(viewDepth, safeNear);
  let invLog = 1.0 / max(log(farZ / safeNear), 0.0001);
  let sliceF = floor(log(safeDepth / safeNear) * invLog * fnz);
  let tz = clamp(i32(sliceF), 0, nz - 1);

  return tx + ty * nx + tz * (nx * ny);
}

// Unified clustered PointLight + SpotLight attenuation (physical inverse-square + smooth spot cone).
// lightVec = lightViewPos - fragViewPos.
// spotDir  = unit direction FROM light TOWARD its target in view space.
// coneCos <= -1.5 indicates a PointLight; otherwise a SpotLight.
fn evalClusteredAttenuation(
  lightVec: vec3<f32>,
  cutoffDist: f32,
  decayExp: f32,
  spotDir: vec3<f32>,
  coneCos: f32,
  penumbraCos: f32
) -> f32 {
  let distSq = dot(lightVec, lightVec);
  let cutoffSq = cutoffDist * cutoffDist;
  if (cutoffDist > 0.0 && distSq >= cutoffSq) {
    return 0.0;
  }

  let dist = sqrt(max(distSq, 1e-6));
  var atten = 1.0 / max(pow(dist, decayExp), 0.01);
  if (cutoffDist > 0.0) {
    let ratio = dist / cutoffDist;
    let ratio2 = ratio * ratio;
    let falloff = clamp(1.0 - ratio2 * ratio2, 0.0, 1.0);
    atten *= falloff * falloff;
  }

  if (coneCos > -1.5) {
    let fromLight = -lightVec / dist;
    let angleCos = dot(fromLight, spotDir);
    let spot = smoothstep(coneCos, max(penumbraCos, coneCos + 1e-4), angleCos);
    atten *= spot;
  }

  return atten;
}
