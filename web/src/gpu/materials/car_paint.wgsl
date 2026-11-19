// Dual-Layer PBR Clear-Coat Automotive Paint + Dynamic Dirt/Wear Mask WGSL Library (Engine-Agnostic, OpenGrid).
// Evaluates in 3D car model space (UV-independent, zero seams across any car mesh):
//   - Layer 1: Metallic base coat with Fresnel color-flop + 3D micro-flake platelet sparkle
//   - Layer 2: Dielectric clear-coat attenuation & roughness response
//   - Dynamic dirt/wear mask driven by driving time & distance (lower sills, wheel-arch spray,
//     rear wake turbulence grime, and upper-body road dust haze).

fn hash3dPaint(p: vec3<f32>) -> vec3<f32> {
  var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

fn valueNoise3dPaint(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  let n000 = hash3dPaint(i + vec3<f32>(0.0, 0.0, 0.0)).x;
  let n100 = hash3dPaint(i + vec3<f32>(1.0, 0.0, 0.0)).x;
  let n010 = hash3dPaint(i + vec3<f32>(0.0, 1.0, 0.0)).x;
  let n110 = hash3dPaint(i + vec3<f32>(1.0, 1.0, 0.0)).x;
  let n001 = hash3dPaint(i + vec3<f32>(0.0, 0.0, 1.0)).x;
  let n101 = hash3dPaint(i + vec3<f32>(1.0, 0.0, 1.0)).x;
  let n011 = hash3dPaint(i + vec3<f32>(0.0, 1.0, 1.0)).x;
  let n111 = hash3dPaint(i + vec3<f32>(1.0, 1.0, 1.0)).x;

  let nx00 = mix(n000, n100, u.x);
  let nx10 = mix(n010, n110, u.x);
  let nx01 = mix(n001, n101, u.x);
  let nx11 = mix(n011, n111, u.x);
  let nxy0 = mix(nx00, nx10, u.y);
  let nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

fn fbm3dPaint(p: vec3<f32>) -> f32 {
  var v = 0.0;
  var amp = 0.55;
  var pos = p;
  for (var i = 0; i < 3; i++) {
    v += amp * valueNoise3dPaint(pos);
    pos = pos * 2.07 + vec3<f32>(13.1, 7.7, 5.3);
    amp *= 0.5;
  }
  return v;
}

// Evaluates organic 3D dirt/wear mask in car model space.
// Returns vec3<f32>(dirtCoverage, wetSplatter, wearHaze).
fn evalCarDirtWear(
  pLocal: vec3<f32>,
  nLocal: vec3<f32>,
  bottomY: f32,
  topY: f32,
  wear: f32,
  driveTime: f32
) -> vec3<f32> {
  if (wear <= 0.001) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }

  let heightSpan = max(topY - bottomY, 0.35);
  let h = clamp((pLocal.y - bottomY) / heightSpan, 0.0, 1.0);

  let nLarge = fbm3dPaint(pLocal * vec3<f32>(2.4, 3.2, 1.8) + vec3<f32>(1.7, 0.3, 4.1));
  let nMid = fbm3dPaint(pLocal * vec3<f32>(8.5, 10.0, 6.5) + vec3<f32>(7.3, 2.9, 1.1));
  let nSpeck = valueNoise3dPaint(pLocal * 34.0 + vec3<f32>(3.1, 5.7, 9.2));

  // 1. Lower rocker panels, front lip, rear diffuser
  let sillBand = 1.0 - smoothstep(0.06, 0.48 + wear * 0.16, h + (nLarge - 0.5) * 0.24);

  // 2. Wheel-arch spray plumes along outer flanks
  let flank = smoothstep(0.55, 0.85, abs(pLocal.x));
  let archSpray = flank * (1.0 - smoothstep(0.12, 0.64, h)) * smoothstep(0.28, 0.76, nMid * 0.62 + nSpeck * 0.38);

  // 3. Rear wake turbulence grime (WGSL smoothstep requires low < high)
  let rearWake = (1.0 - smoothstep(-1.75, -0.55, pLocal.z)) * (1.0 - smoothstep(0.22, 0.85, h));

  // 4. Subtle upper-surface dust settling on upward-facing panels
  let upFacing = smoothstep(0.30, 0.90, nLocal.y);
  let topDust = upFacing * (0.30 + 0.42 * nLarge) * smoothstep(0.20, 1.0, wear);

  let droplet = smoothstep(0.22, 0.74, nMid * 0.55 + nSpeck * 0.45);
  let wetRaw = clamp(sillBand * (0.60 + 0.50 * droplet) + archSpray * 0.90 + rearWake * (0.55 + 0.55 * droplet), 0.0, 1.0);

  let timeFactor = clamp(driveTime / 180.0, 0.0, 1.0);
  let effectiveWear = clamp(max(wear, timeFactor * 0.85), 0.0, 1.0);
  let dirtCoverage = clamp(wetRaw * smoothstep(0.02, 0.68, effectiveWear) + topDust * 0.52, 0.0, 0.95);
  let wetSplatter = clamp(wetRaw * smoothstep(0.04, 0.60, effectiveWear), 0.0, 1.0);
  let wearHaze = clamp(effectiveWear * (0.55 + 0.45 * (1.0 - h * 0.55)) * (0.7 + 0.3 * nLarge), 0.0, 1.0);

  return vec3<f32>(dirtCoverage, wetSplatter, wearHaze);
}

// Evaluates dual-layer automotive paint base coat color (Fresnel metallic color-flop,
// 3D micro-flake specular glint, clearcoat depth tint, and dirt/wear color blending).
fn evalDualLayerPaintColor(
  baseColor: vec3<f32>,
  pLocal: vec3<f32>,
  nWorld: vec3<f32>,
  vWorld: vec3<f32>,
  flopStrength: f32,
  flakeStrength: f32,
  clearcoatAmt: f32,
  dirtMask: vec3<f32>
) -> vec3<f32> {
  let N = normalize(nWorld);
  let V = normalize(vWorld);
  let ndotv = clamp(dot(N, V), 0.0, 1.0);

  let fres = pow(1.0 - ndotv, 2.8);
  let coreTint = baseColor * mix(1.0, 0.84, clearcoatAmt * 0.5);
  let flopHue = vec3<f32>(
    min(1.0, baseColor.r * 1.18 + 0.03),
    min(1.0, baseColor.g * 1.14 + 0.035),
    min(1.0, baseColor.b * 1.24 + 0.05)
  );
  var paintRgb = mix(coreTint, flopHue, fres * flopStrength);

  // 3D model-space metallic micro-flake platelet sparkle (no UV seams)
  let flakeCell = floor(pLocal * 210.0);
  let h3 = hash3dPaint(flakeCell);
  let flakeNormal = normalize(N + (h3 * 2.0 - vec3<f32>(1.0)) * 0.36);
  let sparkle = pow(clamp(dot(flakeNormal, V), 0.0, 1.0), 18.0) * smoothstep(0.62, 0.96, h3.x);
  let flakeGlow = mix(vec3<f32>(0.92, 0.95, 1.0), flopHue * 1.45, 0.55);
  let cleanFactor = 1.0 - dirtMask.x;
  paintRgb += flakeGlow * sparkle * flakeStrength * cleanFactor * (0.45 + 0.55 * ndotv);

  let coatDepth = 1.0 - clearcoatAmt * (0.12 * (1.0 - ndotv));
  paintRgb *= coatDepth;

  let wetGrimeCol = vec3<f32>(0.085, 0.078, 0.068);
  let dryDustCol = vec3<f32>(0.26, 0.235, 0.195);
  let grimeCol = mix(dryDustCol, wetGrimeCol, dirtMask.y * 0.72);
  paintRgb = mix(paintRgb, grimeCol, dirtMask.x * 0.88);
  paintRgb = mix(paintRgb, paintRgb * 0.74 + dryDustCol * 0.26, dirtMask.z * 0.34);

  return paintRgb;
}

// Standalone std140 UBO + PBR surface evaluator for custom WebGPU engines (matches packCarPaintUniforms).
struct CarPaintUniforms {
  invModel: mat4x4<f32>,
  baseColorAndMetal: vec4<f32>,      // rgb = baseColor, a = metalness
  liveryColorAndStyle: vec4<f32>,    // rgb = liveryColor, a = style index
  glowColorAndAmt: vec4<f32>,        // rgb = underglow, a = glowAmt
  coatParams: vec4<f32>,             // x = roughness, y = clearcoat, z = ccRough, w = flopStrength
  wearParams: vec4<f32>,             // x = flakeStrength, y = wear, z = driveTime, w = bottomY
  boundsExtra: vec4<f32>,            // x = topY, yzw = reserved
}

struct CarPaintSurface {
  albedo: vec3<f32>,
  roughness: f32,
  metalness: f32,
  clearcoat: f32,
  clearcoatRoughness: f32,
  emissive: vec3<f32>,
}

fn evalCarPaintSurface(
  u: CarPaintUniforms,
  worldPos: vec3<f32>,
  worldNormal: vec3<f32>,
  camPos: vec3<f32>
) -> CarPaintSurface {
  let pLocal = (u.invModel * vec4<f32>(worldPos, 1.0)).xyz;
  let nLocal = normalize((u.invModel * vec4<f32>(worldNormal, 0.0)).xyz);
  let vWorld = normalize(camPos - worldPos);
  let bottomY = u.wearParams.w;
  let topY = u.boundsExtra.x;

  let dirtMask = evalCarDirtWear(pLocal, nLocal, bottomY, topY, u.wearParams.y, u.wearParams.z);
  let albedo = evalDualLayerPaintColor(
    u.baseColorAndMetal.rgb,
    pLocal,
    worldNormal,
    vWorld,
    u.coatParams.w,
    u.wearParams.x,
    u.coatParams.y,
    dirtMask
  );

  let rough = clamp(mix(u.coatParams.x, 0.88, max(dirtMask.x, dirtMask.z * 0.35)), 0.04, 0.96);
  let metal = clamp(u.baseColorAndMetal.a * (1.0 - dirtMask.x * 0.92), 0.0, 1.0);
  let coat = clamp(u.coatParams.y * (1.0 - dirtMask.x * 0.94), 0.0, 1.0);
  let coatRough = clamp(mix(u.coatParams.z, 0.46, clamp(dirtMask.x * 0.85 + dirtMask.z * 0.4, 0.0, 1.0)), 0.01, 0.65);

  let hLow = (pLocal.y - bottomY) / max(topY - bottomY, 0.25);
  let under = 1.0 - smoothstep(0.02, 0.2, hLow);
  let emissive = u.glowColorAndAmt.rgb * (u.glowColorAndAmt.a * under * 0.18);

  return CarPaintSurface(albedo, rough, metal, coat, coatRough, emissive);
}
