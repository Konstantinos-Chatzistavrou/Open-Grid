// Hybrid Real-Time Planar + Screen-Space Wet-Road Reflection WGSL Library (Engine-Agnostic, OpenGrid).
// Projects wet road pixels through the mirrored planar camera's view-projection matrix, perturbs UVs
// with rain micro-ripples, clamps specular fireflies, and blends seamlessly where SSR rays miss or fade.

fn projectPlanarRoadUv(
  worldPos: vec3<f32>,
  planarViewProj: mat4x4<f32>,
  ripplePerturb: vec2<f32>
) -> vec3<f32> {
  let clip = planarViewProj * vec4<f32>(worldPos, 1.0);
  let invW = 1.0 / max(clip.w, 0.001);
  let ndc = clip.xy * invW;
  // WebGPU texture V=0 is top edge; NDC y=+1 is top edge
  let pUv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) + ripplePerturb;
  let inBounds =
    step(0.005, pUv.x) * step(pUv.x, 0.995) *
    step(0.005, pUv.y) * step(pUv.y, 0.995) *
    step(0.05, clip.w);
  return vec3<f32>(clamp(pUv.x, 0.002, 0.998), clamp(pUv.y, 0.002, 0.998), inBounds);
}

fn evalHybridWetRoadReflection(
  ssrRgb: vec3<f32>,
  ssrAlpha: f32,
  planarSample: vec3<f32>,
  inBounds: f32,
  wetWeight: f32,
  viewDepth: f32,
  maxLuminance: f32,
  planarIntensity: f32
) -> vec3<f32> {
  let pLuma = dot(planarSample, vec3<f32>(0.2126, 0.7152, 0.0722));
  let pSafe = planarSample * min(1.0, maxLuminance / max(pLuma, 0.001));
  let distFade = 1.0 - smoothstep(45.0, 180.0, viewDepth);
  let ssrHit = clamp(ssrAlpha, 0.0, 1.0);
  let planarWeight = wetWeight * inBounds * distFade * (1.0 - ssrHit * 0.68) * planarIntensity;
  return ssrRgb + pSafe * planarWeight;
}
