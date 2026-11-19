// Dual-Layer PBR Clear-Coat Automotive Paint + Texture-Sampled Dirt/Wear WGSL Library (Engine-Agnostic, OpenGrid).
// Replaces expensive 18-hash procedural 3D FBM with 2 hardware-filtered reads of the baked 512x512 tileable
// RGBA dirt/splatter mask (`car_dirt_mask_rgba.png` — identical asset reusable in UE5 Substrate materials):
//   R = broad road-film blotches
//   G = crisp radial mud/water splatter droplets
//   B = aerodynamic wind-swept grime streaks
//   A = fine dried road-dust micro-speckle

fn hash3dPaint(p: vec3<f32>) -> vec3<f32> {
  var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}

// Evaluates organic dirt/splatter/scuff/wake-spray mask using 2 pre-sampled RGBA mask texels
// (triplanar side projection + top/rear projection). ZERO procedural FBM loops.
// Returns vec3<f32>(dirtCoverage, wetSplatter, wearHaze).
fn evalCarDirtWearTex(
  pLocal: vec3<f32>,
  nLocal: vec3<f32>,
  bottomY: f32,
  topY: f32,
  wear: f32,
  scuff: f32,
  wakeSpray: f32,
  texSide: vec4<f32>,
  texTop: vec4<f32>
) -> vec3<f32> {
  let wearLevel = max(max(wear, scuff), wakeSpray);
  if (wearLevel <= 0.001) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }

  let heightSpan = max(topY - bottomY, 0.35);
  let h = clamp((pLocal.y - bottomY) / heightSpan, 0.0, 1.0);

  // Triplanar blend between side-projected streaks/splatter and top-projected dust/blotches
  let upBlend = smoothstep(0.35, 0.85, abs(nLocal.y));
  let mask = mix(texSide, texTop, upBlend);
  let blotch = mask.r;
  let splatter = mask.g;
  let streaks = mask.b;
  let grain = mask.a;

  // 1. Lower rocker panels, front splitter, rear diffuser (strongest near wet asphalt)
  let sillBand = 1.0 - smoothstep(0.05, 0.48 + wear * 0.16, h + (blotch - 0.5) * 0.26);

  // 2. Wheel-arch spray plumes & wind-swept aerodynamic flank streaks
  let flank = smoothstep(0.54, 0.84, abs(pLocal.x));
  let archSpray = flank * (1.0 - smoothstep(0.10, 0.66, h)) * smoothstep(0.20, 0.78, splatter * 0.65 + streaks * 0.35);

  // 3. Rear wake turbulence grime (WGSL smoothstep requires low < high)
  let rearWake = (1.0 - smoothstep(-1.75, -0.50, pLocal.z)) * (1.0 - smoothstep(0.20, 0.86, h));

  // 4. Front nose/hood road-mist spray when drafting closely behind rivals
  let frontNose = smoothstep(0.35, 1.85, pLocal.z) * (1.0 - smoothstep(0.30, 0.92, h));
  let draftMist = frontNose * wakeSpray * (0.45 + 0.55 * splatter);

  // 5. Wall-scrape / crash damage matte scuffing on outer flanks & bumpers
  let scrapeZone = max(flank, max(smoothstep(1.2, 2.0, pLocal.z), 1.0 - smoothstep(-2.0, -1.2, pLocal.z)));
  let scuffMask = scrapeZone * scuff * smoothstep(0.18, 0.72, streaks * 0.6 + blotch * 0.4);

  // 6. Upper-surface road dust settling on hood/roof
  let upFacing = smoothstep(0.30, 0.90, nLocal.y);
  let topDust = upFacing * (0.28 + 0.45 * blotch + 0.20 * grain) * smoothstep(0.18, 1.0, wear);

  let droplet = smoothstep(0.18, 0.72, splatter * 0.62 + streaks * 0.24 + grain * 0.14);
  let wetRaw = clamp(
    sillBand * (0.58 + 0.52 * droplet) +
    archSpray * 0.92 +
    rearWake * (0.52 + 0.55 * droplet) +
    draftMist * 0.85,
    0.0,
    1.0
  );

  let dirtCoverage = clamp(
    wetRaw * smoothstep(0.02, 0.68, max(wear, wakeSpray * 0.75)) +
    scuffMask * 0.82 +
    topDust * 0.50,
    0.0,
    0.95
  );
  let wetSplatter = clamp(wetRaw * smoothstep(0.04, 0.60, max(wear, wakeSpray * 0.8)) + scuffMask * 0.5, 0.0, 1.0);
  let wearHaze = clamp(
    max(wear, scuff * 0.7) * (0.52 + 0.48 * (1.0 - h * 0.55)) * (0.68 + 0.32 * blotch),
    0.0,
    1.0
  );

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

  // 3D model-space metallic micro-flake platelet sparkle (single cell hash, no UV seams)
  let flakeCell = floor(pLocal * 210.0);
  let h3 = hash3dPaint(flakeCell);
  let flakeNormal = normalize(N + (h3 * 2.0 - vec3<f32>(1.0)) * 0.36);
  let sparkle = pow(clamp(dot(flakeNormal, V), 0.0, 1.0), 18.0) * smoothstep(0.62, 0.96, h3.x);
  let flakeGlow = mix(vec3<f32>(0.92, 0.95, 1.0), flopHue * 1.45, 0.55);
  let cleanFactor = 1.0 - dirtMask.x;
  paintRgb += flakeGlow * sparkle * flakeStrength * cleanFactor * (0.45 + 0.55 * ndotv);

  let coatDepth = 1.0 - clearcoatAmt * (0.12 * (1.0 - ndotv));
  paintRgb *= coatDepth;

  let wetGrimeCol = vec3<f32>(0.082, 0.075, 0.066);
  let dryDustCol = vec3<f32>(0.26, 0.235, 0.195);
  let grimeCol = mix(dryDustCol, wetGrimeCol, dirtMask.y * 0.72);
  paintRgb = mix(paintRgb, grimeCol, dirtMask.x * 0.88);
  paintRgb = mix(paintRgb, paintRgb * 0.74 + dryDustCol * 0.26, dirtMask.z * 0.34);

  return paintRgb;
}

// Standalone std140 UBO + PBR surface evaluator for custom WebGPU engines (matches packCarPaintUniforms & UE5 MPC).
struct CarPaintUniforms {
  invModel: mat4x4<f32>,
  baseColorAndMetal: vec4<f32>,      // rgb = baseColor, a = metalness
  liveryColorAndStyle: vec4<f32>,    // rgb = liveryColor, a = style index
  glowColorAndAmt: vec4<f32>,        // rgb = underglow, a = glowAmt
  coatParams: vec4<f32>,             // x = roughness, y = clearcoat, z = ccRough, w = flopStrength
  wearParams: vec4<f32>,             // x = flakeStrength, y = wear, z = scuff, w = bottomY
  boundsExtra: vec4<f32>,            // x = topY, y = wakeSpray, zw = reserved
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
  camPos: vec3<f32>,
  dirtTex: texture_2d<f32>,
  dirtSampler: sampler
) -> CarPaintSurface {
  let pLocal = (u.invModel * vec4<f32>(worldPos, 1.0)).xyz;
  let nLocal = normalize((u.invModel * vec4<f32>(worldNormal, 0.0)).xyz);
  let vWorld = normalize(camPos - worldPos);
  let bottomY = u.wearParams.w;
  let topY = u.boundsExtra.x;

  let sideUv = vec2<f32>(pLocal.z * 0.55, pLocal.y * 0.85);
  let topUv = vec2<f32>(pLocal.x * 0.65, pLocal.z * 0.45);
  let texSide = textureSample(dirtTex, dirtSampler, sideUv);
  let texTop = textureSample(dirtTex, dirtSampler, topUv);

  let dirtMask = evalCarDirtWearTex(
    pLocal, nLocal, bottomY, topY,
    u.wearParams.y, u.wearParams.z, u.boundsExtra.y,
    texSide, texTop
  );
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
