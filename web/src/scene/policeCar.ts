// Real Police Interceptor Visual Builder (OpenGrid).
//
// Transforms any car GLB prototype (e.g. Falcorn Hellhound muscle interceptor or Vela GT fallback)
// into an unmistakable Black & White Police Interceptor with:
//   - Glossy obsidian police-black re-skin with crisp contoured white side door panels,
//     roof unit-ID panel, hood crest, and rear "POLICE · 911" deck decals (CanvasTexture)
//   - Heavy matte-black tubular steel front push-bar / bullbar with wrap-around corner guards (+Z front)
//   - Full-width 6-module Whelen LED roof lightbar (2 Red, 2 White/Amber center, 2 Blue) with smoked housing
//   - Alternating wig-wag headlight strobes, grille red/blue strobes, and rear window deck LEDs
//   - Dual rear trunk whip antennas (-Z rear)
//   - Real dynamic alternating Racing Red / Electric Police Blue PointLight with realistic multi-flash LED strobe cadence
import * as THREE from 'three/webgpu';
import { applyPlate } from './plate';

export interface PoliceLightRig {
  /** 6 roof lightbar LED pods: [0,1]=Red left, [2,3]=White/Amber center, [4,5]=Blue right */
  barPods: THREE.MeshBasicMaterial[];
  /** Left & right alternating wig-wag headlight emitter materials */
  wigWagL: THREE.MeshBasicMaterial;
  wigWagR: THREE.MeshBasicMaterial;
  /** Front grille red/blue strobe pods */
  grilleR: THREE.MeshBasicMaterial;
  grilleB: THREE.MeshBasicMaterial;
  /** Rear window deck red/blue strobe pods */
  rearR: THREE.MeshBasicMaterial;
  rearB: THREE.MeshBasicMaterial;
  /** Optional wet-asphalt additive ground light-wash quad material */
  groundWashMat: THREE.MeshBasicMaterial;
  /** Real dynamic flashing red/blue PointLight (null if withDynamicLights === false) */
  pointLight: THREE.PointLight | null;
  /** Per-unit phase offset so multi-car pursuits strobe organically out of sync */
  phaseOffset: number;
  /** Tracks last active state to keep idle updates zero-cost */
  wasActive: boolean;
}

export interface PoliceInterceptorBuild {
  root: THREE.Group;
  lights: PoliceLightRig;
}

interface BodyMetrics {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  width: number;
  height: number;
  length: number;
  cx: number;
  cz: number;
  /** Outer door surface |x| at mid-door height (excludes wing mirrors) */
  doorHalfWidth: number;
  /** Roof peak Y around the lightbar Z band */
  roofY: number;
  /** Center Z of the roof greenhouse */
  roofZ: number;
  /** Roof half-width at roofY - 0.08 */
  roofHalfWidth: number;
  /** Front bumper nose Z at bumper height */
  frontBumperZ: number;
  /** Front bumper height band center */
  frontBumperY: number;
  /** Hood height around front-mid Z */
  hoodY: number;
  /** Rear deck height near trunk */
  trunkY: number;
  /** Rear window base Y for deck strobes */
  rearDeckY: number;
  rearDeckZ: number;
}

const metricsCache = new WeakMap<THREE.Object3D, BodyMetrics>();
const doorTexCache = new Map<string, { left: THREE.CanvasTexture; right: THREE.CanvasTexture }>();
const roofTexCache = new Map<string, THREE.CanvasTexture>();
let hoodTexCache: THREE.CanvasTexture | null = null;
let rearTexCache: THREE.CanvasTexture | null = null;
let washTexCache: THREE.CanvasTexture | null = null;
let phaseCounter = 0;

// Shared static PBR materials for police hardware (zero duplicate shader compiles)
let pushbarSteelMat: THREE.MeshStandardMaterial | null = null;
let pushbarPadMat: THREE.MeshStandardMaterial | null = null;
let lightbarBaseMat: THREE.MeshStandardMaterial | null = null;
let lightbarLensMat: THREE.MeshPhysicalMaterial | null = null;
let antennaMat: THREE.MeshStandardMaterial | null = null;

function getHardwareMaterials() {
  if (!pushbarSteelMat) {
    pushbarSteelMat = new THREE.MeshStandardMaterial({
      name: 'police_pushbar_steel',
      color: 0x14171e,
      metalness: 0.72,
      roughness: 0.34,
    });
  }
  if (!pushbarPadMat) {
    pushbarPadMat = new THREE.MeshStandardMaterial({
      name: 'police_pushbar_pad',
      color: 0x090a0d,
      metalness: 0.08,
      roughness: 0.88,
    });
  }
  if (!lightbarBaseMat) {
    lightbarBaseMat = new THREE.MeshStandardMaterial({
      name: 'police_lightbar_base',
      color: 0x10131a,
      metalness: 0.65,
      roughness: 0.3,
    });
  }
  if (!lightbarLensMat) {
    lightbarLensMat = new THREE.MeshPhysicalMaterial({
      name: 'police_lightbar_lens',
      color: 0x1a2232,
      transparent: true,
      opacity: 0.28,
      roughness: 0.06,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      depthWrite: false,
    });
  }
  if (!antennaMat) {
    antennaMat = new THREE.MeshStandardMaterial({
      name: 'police_antenna',
      color: 0x1a1e26,
      metalness: 0.85,
      roughness: 0.28,
    });
  }
  return { pushbarSteelMat, pushbarPadMat, lightbarBaseMat, lightbarLensMat, antennaMat };
}

/** Measure exact car body bounds + door/roof/bumper surface slices once per prototype model. */
function measureProto(proto: THREE.Object3D): BodyMetrics {
  const cached = metricsCache.get(proto);
  if (cached) return cached;

  proto.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(proto.matrixWorld).invert();
  const box = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const v = new THREE.Vector3();

  // Pass 1: overall exact vertex bounding box
  const samples: number[] = [];
  proto.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (/shadow|beam|blur|glow/i.test(mesh.name)) return;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) return;
    m4.multiplyMatrices(invRoot, mesh.matrixWorld);
    const step = pos.count > 4000 ? Math.ceil(pos.count / 2500) : 1;
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m4);
      box.expandByPoint(v);
      samples.push(v.x, v.y, v.z);
    }
  });

  if (box.isEmpty()) {
    box.set(new THREE.Vector3(-1.05, 0, -2.5), new THREE.Vector3(1.05, 1.4, 2.5));
  }

  const minX = box.min.x;
  const maxX = box.max.x;
  const minY = box.min.y;
  const maxY = box.max.y;
  const minZ = box.min.z;
  const maxZ = box.max.z;
  const width = Math.max(1.4, maxX - minX);
  const height = Math.max(0.9, maxY - minY);
  const length = Math.max(3.4, maxZ - minZ);
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;

  // Pass 2: sample exact door outer width, roof peak, hood deck, trunk deck, and nose Z
  // Using 96th-percentile door X avoids side mirrors while sitting flush on actual door panels.
  const doorAbsX: number[] = [];
  let roofY = minY + height * 0.96;
  let roofZSum = 0;
  let roofZCnt = 0;
  let roofHalfWidth = width * 0.32;
  let frontBumperZ = maxZ;
  let hoodY = minY + height * 0.63;
  let trunkY = minY + height * 0.68;
  let rearDeckY = minY + height * 0.72;

  let maxRoofY = -Infinity;
  let maxHoodY = -Infinity;
  let maxTrunkY = -Infinity;
  let maxNoseZ = -Infinity;

  for (let i = 0; i < samples.length; i += 3) {
    const x = samples[i];
    const y = samples[i + 1];
    const z = samples[i + 2];
    const ax = Math.abs(x - cx);

    // Door band: mid-height (30%..56% H), mid-length (-16%..+14% L)
    if (y > minY + height * 0.30 && y < minY + height * 0.56 && z > cz - length * 0.16 && z < cz + length * 0.14) {
      doorAbsX.push(ax);
    }

    // Roof centerline band: |x| < 0.25 W, z near center (-22%..+12% L)
    if (ax < width * 0.26 && z > cz - length * 0.22 && z < cz + length * 0.12) {
      if (y > maxRoofY) maxRoofY = y;
      if (y > minY + height * 0.90) {
        roofZSum += z;
        roofZCnt++;
      }
    }

    // Roof width near top
    if (y > minY + height * 0.88 && z > cz - length * 0.16 && z < cz + length * 0.10) {
      if (ax > roofHalfWidth && ax < width * 0.44) roofHalfWidth = ax;
    }

    // Front bumper nose at bumper height (22%..48% H, center half width)
    if (y > minY + height * 0.22 && y < minY + height * 0.48 && ax < width * 0.30 && z > cz + length * 0.35) {
      if (z > maxNoseZ) maxNoseZ = z;
    }

    // Hood deck (front +22%..+38% L, center width)
    if (ax < width * 0.24 && z > cz + length * 0.22 && z < cz + length * 0.38 && y < minY + height * 0.78) {
      if (y > maxHoodY) maxHoodY = y;
    }

    // Trunk deck (rear -45%..-34% L, center width)
    if (ax < width * 0.28 && z < cz - length * 0.34 && z > cz - length * 0.46 && y < minY + height * 0.82) {
      if (y > maxTrunkY) maxTrunkY = y;
    }
  }

  let doorHalfWidth = width * 0.445;
  if (doorAbsX.length > 20) {
    doorAbsX.sort((a, b) => a - b);
    const p96 = doorAbsX[Math.min(doorAbsX.length - 1, Math.floor(doorAbsX.length * 0.96))];
    // Clamp safely so mirrors never pull panels off the body and narrow cabins never sink them
    doorHalfWidth = THREE.MathUtils.clamp(p96, width * 0.40, width * 0.485);
  }
  if (Number.isFinite(maxRoofY) && maxRoofY > minY + height * 0.75) roofY = maxRoofY;
  const roofZ = roofZCnt > 8 ? THREE.MathUtils.clamp(roofZSum / roofZCnt, cz - length * 0.14, cz + length * 0.08) : cz - length * 0.03;
  if (Number.isFinite(maxNoseZ) && maxNoseZ > cz + length * 0.38) frontBumperZ = maxNoseZ;
  if (Number.isFinite(maxHoodY) && maxHoodY > minY + height * 0.45) hoodY = maxHoodY;
  if (Number.isFinite(maxTrunkY) && maxTrunkY > minY + height * 0.45) {
    trunkY = maxTrunkY;
    rearDeckY = Math.min(roofY - 0.14, trunkY + height * 0.12);
  }

  const out: BodyMetrics = {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    width,
    height,
    length,
    cx,
    cz,
    doorHalfWidth,
    roofY,
    roofZ,
    roofHalfWidth: THREE.MathUtils.clamp(roofHalfWidth, width * 0.26, width * 0.38),
    frontBumperZ,
    frontBumperY: minY + height * 0.34,
    hoodY,
    trunkY,
    rearDeckY,
    rearDeckZ: cz - length * 0.30,
  };
  metricsCache.set(proto, out);
  return out;
}

/** Draw a crisp 7-point police interceptor shield emblem onto a 2D canvas context. */
function drawPoliceCrest(g: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  g.save();
  g.translate(cx, cy);
  // Shield outer gold rim
  g.beginPath();
  g.moveTo(0, -r);
  g.quadraticCurveTo(r * 0.85, -r * 0.78, r * 0.82, -r * 0.1);
  g.quadraticCurveTo(r * 0.72, r * 0.62, 0, r);
  g.quadraticCurveTo(-r * 0.72, r * 0.62, -r * 0.82, -r * 0.1);
  g.quadraticCurveTo(-r * 0.85, -r * 0.78, 0, -r);
  g.closePath();
  g.fillStyle = '#d4a63a';
  g.fill();
  g.lineWidth = Math.max(2, r * 0.08);
  g.strokeStyle = '#0d1422';
  g.stroke();

  // Inner dark navy badge field
  g.save();
  g.scale(0.82, 0.82);
  g.fillStyle = '#10264c';
  g.fill();
  g.restore();

  // 5-point gold star inside shield
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r * 0.44 : r * 0.19;
    const px = Math.cos(a) * rr;
    const py = Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fillStyle = '#f3cd66';
  g.fill();
  g.restore();
}

/** Procedural high-contrast Black & White side door panel CanvasTexture ("POLICE · INTERCEPTOR · 911"). */
function getDoorTextures(unitNumber: string): { left: THREE.CanvasTexture; right: THREE.CanvasTexture } {
  const key = unitNumber.toUpperCase();
  const cached = doorTexCache.get(key);
  if (cached) return cached;

  const makeSide = (flipDirection: boolean) => {
    const W = 512;
    const H = 256;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d')!;

    // Glossy police white door panel with subtle vertical automotive gradient
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#f5f8fc');
    bg.addColorStop(0.55, '#e8eef5');
    bg.addColorStop(1, '#cfd7e2');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    // Subtle dark obsidian door seam border
    g.strokeStyle = '#0c0e14';
    g.lineWidth = 10;
    g.strokeRect(5, 5, W - 10, H - 10);

    // Sleek angled navy & gold interceptor body stripe
    g.fillStyle = '#112c5c';
    g.fillRect(10, 146, W - 20, 44);
    g.fillStyle = '#d4a63a';
    g.fillRect(10, 141, W - 20, 5);
    g.fillRect(10, 190, W - 20, 4);

    // Diagonal tactical speed hash at rear end of door
    const rearX = flipDirection ? 24 : W - 96;
    g.fillStyle = '#1c4f9c';
    for (let k = 0; k < 3; k++) {
      const sx = rearX + k * 24;
      g.beginPath();
      g.moveTo(sx, 146);
      g.lineTo(sx + 14, 146);
      g.lineTo(sx + 2, 190);
      g.lineTo(sx - 12, 190);
      g.closePath();
      g.fill();
    }

    // Police shield crest toward the front of the door
    const crestX = flipDirection ? W - 82 : 82;
    drawPoliceCrest(g, crestX, 82, 46);

    // Crisp bold "POLICE" lettering
    const textCenterX = flipDirection ? W * 0.43 : W * 0.57;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#0a0e18';
    g.font = '900 76px "Arial Black", "Impact", "Helvetica Neue", Arial, sans-serif';
    g.fillText('POLICE', textCenterX, 76);

    // "INTERCEPTOR" sub-banner inside navy stripe
    g.fillStyle = '#f4f7fb';
    g.font = '800 24px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    g.fillText('HIGHWAY INTERCEPTOR', W * 0.5, 169);

    // Bottom micro-tags: "EMERGENCY 911" + Unit Number
    g.fillStyle = '#12213c';
    g.font = '900 26px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'left';
    g.fillText('DIAL 911', 26, 222);
    g.textAlign = 'right';
    g.fillStyle = '#b91c2e';
    g.fillText(`UNIT ${key}`, W - 26, 222);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };

  const pair = { left: makeSide(false), right: makeSide(true) };
  doorTexCache.set(key, pair);
  return pair;
}

/** Procedural glossy white roof panel with bold unit ID ("04", "07", etc.) for chase-cam / chopper visibility. */
function getRoofTexture(unitNumber: string): THREE.CanvasTexture {
  const key = unitNumber.toUpperCase();
  const cached = roofTexCache.get(key);
  if (cached) return cached;

  const W = 256;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;

  g.fillStyle = '#eef3f9';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#0c0e14';
  g.lineWidth = 10;
  g.strokeRect(5, 5, W - 10, H - 10);

  // Subtle top/bottom navy accent bars
  g.fillStyle = '#102956';
  g.fillRect(10, 10, W - 20, 20);
  g.fillRect(10, H - 30, W - 20, 20);

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#0a0e18';
  g.font = '900 112px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.fillText(key, W * 0.5, H * 0.46);

  g.fillStyle = '#102956';
  g.font = '800 28px "Helvetica Neue", Arial, sans-serif';
  g.fillText('POLICE', W * 0.5, H * 0.77);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  roofTexCache.set(key, tex);
  return tex;
}

/** Procedural rear trunk "POLICE · 911" reflective white/navy strip. */
function getRearDeckTexture(): THREE.CanvasTexture {
  if (rearTexCache) return rearTexCache;
  const W = 512;
  const H = 128;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;

  g.fillStyle = '#0e131e';
  g.fillRect(0, 0, W, H);
  // Reflective high-visibility chevron borders left & right
  g.fillStyle = '#d4a63a';
  g.fillRect(0, 0, W, 8);
  g.fillRect(0, H - 8, W, 8);

  g.fillStyle = '#f2f6fc';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 66px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.fillText('POLICE', W * 0.44, H * 0.52);

  g.fillStyle = '#ff2845';
  g.font = '900 44px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.fillText('911', W * 0.85, H * 0.52);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  rearTexCache = tex;
  return tex;
}

/** Procedural hood "INTERCEPTOR" crest plate facing forward. */
function getHoodTexture(): THREE.CanvasTexture {
  if (hoodTexCache) return hoodTexCache;
  const W = 512;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;

  g.clearRect(0, 0, W, H);
  drawPoliceCrest(g, W * 0.5, 92, 62);

  g.fillStyle = '#eef4fc';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 50px "Arial Black", "Helvetica Neue", Arial, sans-serif';
  g.fillText('INTERCEPTOR', W * 0.5, 204);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  hoodTexCache = tex;
  return tex;
}

/** Soft radial wet-asphalt strobe reflection wash texture (additive, zero extra GPU lights). */
function getGroundWashTexture(): THREE.CanvasTexture {
  if (washTexCache) return washTexCache;
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = N;
  cv.height = N;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(N * 0.5, N * 0.5, 4, N * 0.5, N * 0.5, N * 0.5);
  grad.addColorStop(0, 'rgba(255,255,255,0.65)');
  grad.addColorStop(0.38, 'rgba(255,255,255,0.28)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  washTexCache = tex;
  return tex;
}

/** Determine whether a material on a cloned car mesh is exterior body paint to re-skin to obsidian police black. */
function isPaintMaterial(mat: THREE.Material, meshName: string): boolean {
  const name = `${mat.name || ''} ${meshName || ''}`;
  // Never re-skin glass, wheels, tyres, brakes, lights, chrome, mirrors, badges, interior, carbon, grille
  if (
    /glass|glace|window|windshield|wheel|rim|tire|tyre|disc|caliper|plaquette|brake|light|lamp|tail|head|drl|beam|signal|lens|chrom|miror|mirror|badge|interior|dash|seat|plate|rubber|carbon|trim|grille|exhaust|mechanical|hardware|metal|black|shadow/i.test(
      name,
    )
  ) {
    return false;
  }
  if (/paint|carosserie|body/i.test(mat.name || '')) return true;

  const std = mat as THREE.MeshStandardMaterial;
  if (std.transparent || (typeof std.opacity === 'number' && std.opacity < 0.95)) return false;
  if (std.emissive && (std.emissive.r > 0.05 || std.emissive.g > 0.05 || std.emissive.b > 0.05)) return false;

  // Catch unnamed/generic body paint slots on Sketchfab-derived cars (e.g. Hellhound Material.009 / Material.012 purple paint)
  if (/^Material\.0(09|12)$/i.test(mat.name || '')) return true;
  if (std.color) {
    const r = std.color.r;
    const g = std.color.g;
    const b = std.color.b;
    // Skip bright red reflectors/tail housings/calipers (high red, near-zero green & blue)
    if (r > 0.45 && g < 0.12 && b < 0.12) return false;
    // Re-skin noticeable non-grey body hues (e.g. purple/blue/green/orange factory paint)
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (maxC > 0.06 && maxC - minC > 0.03) return true;
  }
  return false;
}

/** Build a gently contoured side door panel geometry that follows automotive door curvature. */
function makeDoorPanelGeo(lengthZ: number, heightY: number, sideSign: 1 | -1): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(lengthZ, heightY, 4, 4);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const ny = y / (heightY * 0.5); // -1 bottom .. +1 top
    const nx = x / (lengthZ * 0.5);
    // Slight inward tumblehome at top & gentle wheel-arch tuck at ends so edges never poke out
    const bulgeZ = -0.022 * ny * ny - 0.008 * nx * nx;
    pos.setZ(i, bulgeZ);
  }
  geo.computeVertexNormals();
  // Rotate PlaneGeometry (in XY facing +Z) to face outward along +X (left) or -X (right)
  geo.rotateY(sideSign > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
  return geo;
}

/**
 * Construct a complete Black & White Police Interceptor from any car prototype.
 * Model space convention: +X = left, +Y = up, +Z = forward (front bumper), -Z = rear trunk.
 */
export function buildPoliceInterceptor(
  proto: THREE.Object3D,
  unitNumber: string,
  withDynamicLights: boolean,
): PoliceInterceptorBuild {
  const root = new THREE.Group();
  root.name = `police_interceptor_${unitNumber}`;

  const metrics = measureProto(proto);
  const model = proto.clone(true);

  // Seat tyres cleanly onto y = 0
  const yShift = -metrics.minY;
  model.position.y += yShift;

  // Deep-clone materials per cruiser & re-skin body paint to glossy obsidian police black
  const policeBlackMat = new THREE.MeshPhysicalMaterial({
    name: `police_obsidian_${unitNumber}`,
    color: 0x0c0e14,
    roughness: 0.18,
    metalness: 0.35,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.5,
  });
  const tintedGlassMat = new THREE.MeshPhysicalMaterial({
    name: `police_glass_${unitNumber}`,
    color: 0x04060b,
    transparent: true,
    opacity: 0.78,
    roughness: 0.025,
    metalness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.8,
    depthWrite: false,
  });

  const clonedMats = new Map<THREE.Material, THREE.Material>();
  const mapMat = (m: THREE.Material, meshName: string): THREE.Material => {
    if (isPaintMaterial(m, meshName)) return policeBlackMat;
    if (/glass|glace/i.test(m.name || '')) return tintedGlassMat;
    let c = clonedMats.get(m);
    if (!c) {
      c = m.clone();
      clonedMats.set(m, c);
    }
    return c;
  };

  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => mapMat(m, mesh.name))
      : mapMat(mesh.material, mesh.name);
  });

  // Put "POLICE" on model license plate if the model has a plate quad
  try {
    applyPlate(model, 'POLICE');
  } catch {
    /* optional */
  }

  root.add(model);

  const hw = getHardwareMaterials();
  const W = metrics.width;
  const H = metrics.height;
  const L = metrics.length;
  const cx = metrics.cx;
  const cz = metrics.cz;
  const roofY = metrics.roofY + yShift;
  const roofZ = metrics.roofZ;
  const frontZ = metrics.frontBumperZ;
  const rearZ = metrics.minZ;
  const hoodY = metrics.hoodY + yShift;
  const trunkY = metrics.trunkY + yShift;
  const rearDeckY = metrics.rearDeckY + yShift;

  // =========================================================================
  // 1. BLACK & WHITE INTERCEPTOR LIVERY PANELS (Doors, Roof ID, Hood, Rear)
  // =========================================================================
  const doorTex = getDoorTextures(unitNumber);
  const doorLen = L * 0.30;
  const doorH = H * 0.255;
  const doorY = H * 0.43;
  const doorZ = cz - L * 0.015;
  const doorX = metrics.doorHalfWidth + 0.012;

  const doorMatL = new THREE.MeshPhysicalMaterial({
    map: doorTex.left,
    roughness: 0.22,
    metalness: 0.12,
    clearcoat: 0.9,
    clearcoatRoughness: 0.06,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const doorMatR = new THREE.MeshPhysicalMaterial({
    map: doorTex.right,
    roughness: 0.22,
    metalness: 0.12,
    clearcoat: 0.9,
    clearcoatRoughness: 0.06,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const doorL = new THREE.Mesh(makeDoorPanelGeo(doorLen, doorH, 1), doorMatL);
  doorL.position.set(cx + doorX, doorY, doorZ);
  const doorR = new THREE.Mesh(makeDoorPanelGeo(doorLen, doorH, -1), doorMatR);
  doorR.position.set(cx - doorX, doorY, doorZ);
  root.add(doorL, doorR);

  // White Roof Accent Plate + Unit Number ID (mounted flush on roof just behind lightbar)
  const roofPlateW = Math.min(W * 0.58, metrics.roofHalfWidth * 1.72);
  const roofPlateL = L * 0.18;
  const roofPlateGeo = new THREE.PlaneGeometry(roofPlateW, roofPlateL);
  roofPlateGeo.rotateX(-Math.PI * 0.5);
  roofPlateGeo.rotateY(Math.PI);
  const roofPlateMat = new THREE.MeshPhysicalMaterial({
    map: getRoofTexture(unitNumber),
    roughness: 0.24,
    metalness: 0.1,
    clearcoat: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const roofPlate = new THREE.Mesh(roofPlateGeo, roofPlateMat);
  roofPlate.position.set(cx, roofY + 0.008, roofZ - L * 0.095);
  root.add(roofPlate);

  // Hood Interceptor Crest Decal (facing up/forward on hood, upright from chase camera)
  const hoodDecalGeo = new THREE.PlaneGeometry(W * 0.44, L * 0.14);
  hoodDecalGeo.rotateX(-Math.PI * 0.5);
  hoodDecalGeo.rotateY(Math.PI);
  const hoodDecalMat = new THREE.MeshPhysicalMaterial({
    map: getHoodTexture(),
    transparent: true,
    roughness: 0.22,
    metalness: 0.15,
    clearcoat: 0.9,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const hoodDecal = new THREE.Mesh(hoodDecalGeo, hoodDecalMat);
  hoodDecal.position.set(cx, hoodY + 0.012, cz + L * 0.29);
  hoodDecal.rotation.x = 0.07; // slight forward hood slope
  root.add(hoodDecal);

  // Rear Trunk "POLICE · 911" Reflective Strip (clearly visible when cruiser is ahead of player!)
  const rearStripGeo = new THREE.PlaneGeometry(W * 0.48, H * 0.11);
  rearStripGeo.rotateY(Math.PI); // face -Z (rearward)
  const rearStripMat = new THREE.MeshStandardMaterial({
    map: getRearDeckTexture(),
    roughness: 0.28,
    metalness: 0.2,
    emissive: new THREE.Color(0x283244),
    emissiveMap: getRearDeckTexture(),
    emissiveIntensity: 0.45,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const rearStrip = new THREE.Mesh(rearStripGeo, rearStripMat);
  rearStrip.position.set(cx, Math.max(H * 0.44, trunkY - H * 0.10), rearZ - 0.018);
  root.add(rearStrip);

  // =========================================================================
  // 2. HEAVY STEEL FRONT PUSH-BAR / BULLBAR (at +Z = frontZ!)
  // =========================================================================
  const pushbar = new THREE.Group();
  pushbar.name = 'police_pushbar';
  const pbZ = frontZ + 0.07;
  const pbBaseY = H * 0.17;
  const pbTopY = H * 0.55;
  const pbH = pbTopY - pbBaseY;
  const pbHalfSpan = W * 0.21;

  // Heavy angled vertical ram uprights + rubber-padded push faces
  const uprightGeo = new THREE.BoxGeometry(0.075, pbH, 0.13);
  const padGeo = new THREE.BoxGeometry(0.082, pbH * 0.92, 0.045);
  for (const s of [-1, 1] as const) {
    const up = new THREE.Mesh(uprightGeo, hw.pushbarSteelMat);
    up.position.set(cx + s * pbHalfSpan, pbBaseY + pbH * 0.5, pbZ);
    up.rotation.x = -0.14;
    pushbar.add(up);

    const pad = new THREE.Mesh(padGeo, hw.pushbarPadMat);
    pad.position.set(cx + s * pbHalfSpan, pbBaseY + pbH * 0.5, pbZ + 0.068);
    pad.rotation.x = -0.14;
    pushbar.add(pad);

    // Lower mounting bracket tying back into front bumper beam
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.24), hw.pushbarSteelMat);
    brace.position.set(cx + s * pbHalfSpan, pbBaseY + 0.05, pbZ - 0.11);
    pushbar.add(brace);
  }

  // Twin horizontal bash tubes connecting uprights
  const tubeGeo = new THREE.CylinderGeometry(0.028, 0.028, pbHalfSpan * 2 + 0.06, 8);
  tubeGeo.rotateZ(Math.PI * 0.5);
  const topBar = new THREE.Mesh(tubeGeo, hw.pushbarSteelMat);
  topBar.position.set(cx, pbTopY - 0.05, pbZ - 0.01);
  const midBar = new THREE.Mesh(tubeGeo, hw.pushbarSteelMat);
  midBar.position.set(cx, pbBaseY + pbH * 0.45, pbZ + 0.015);
  const botBar = new THREE.Mesh(tubeGeo, hw.pushbarSteelMat);
  botBar.position.set(cx, pbBaseY + 0.05, pbZ + 0.02);
  pushbar.add(topBar, midBar, botBar);

  // Wrap-around tubular steel headlight / corner guards
  const wrapWidth = W * 0.23;
  const wrapGeo = new THREE.CylinderGeometry(0.022, 0.022, wrapWidth, 8);
  wrapGeo.rotateZ(Math.PI * 0.5);
  const cornerVertGeo = new THREE.CylinderGeometry(0.022, 0.022, pbH * 0.56, 8);
  for (const s of [-1, 1] as const) {
    const outerX = cx + s * (pbHalfSpan + wrapWidth * 0.92);
    const midX = cx + s * (pbHalfSpan + wrapWidth * 0.46);
    for (const wy of [pbTopY - 0.08, pbBaseY + pbH * 0.34]) {
      const wing = new THREE.Mesh(wrapGeo, hw.pushbarSteelMat);
      wing.position.set(midX, wy, pbZ - 0.05);
      wing.rotation.y = s * -0.22; // sweep backward around bumper corners
      pushbar.add(wing);
    }
    const post = new THREE.Mesh(cornerVertGeo, hw.pushbarSteelMat);
    post.position.set(outerX, pbBaseY + pbH * 0.62, pbZ - 0.105);
    pushbar.add(post);
  }
  root.add(pushbar);

  // =========================================================================
  // 3. FULL-WIDTH 6-MODULE WHELEN LED ROOF LIGHTBAR
  // =========================================================================
  const lightbar = new THREE.Group();
  lightbar.name = 'police_lightbar';
  const barW = Math.min(W * 0.66, metrics.roofHalfWidth * 1.92);
  const barY = roofY + 0.045;
  const barZ = roofZ + L * 0.03;

  // Low-profile anodized mounting feet
  const footGeo = new THREE.BoxGeometry(0.11, 0.045, 0.22);
  for (const s of [-1, 1] as const) {
    const foot = new THREE.Mesh(footGeo, hw.lightbarBaseMat);
    foot.position.set(cx + s * (barW * 0.40), barY - 0.032, barZ);
    lightbar.add(foot);
  }

  // Aerodynamic aluminum base chassis
  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(barW, 0.036, 0.26), hw.lightbarBaseMat);
  basePlate.position.set(cx, barY - 0.01, barZ);
  lightbar.add(basePlate);

  // Center black divider cap
  const centerCap = new THREE.Mesh(new THREE.BoxGeometry(barW * 0.06, 0.092, 0.25), hw.lightbarBaseMat);
  centerCap.position.set(cx, barY + 0.032, barZ);
  lightbar.add(centerCap);

  // 6 Distinct High-Intensity Emissive LED Pods: [0,1]=Red left, [2,3]=White/Amber center, [4,5]=Blue right
  const podW = (barW * 0.90) / 6;
  const podGeo = new THREE.BoxGeometry(podW * 0.84, 0.072, 0.21);
  const barPods: THREE.MeshBasicMaterial[] = [];
  const podInitHex = [0x220408, 0x220408, 0x161820, 0x161820, 0x040b24, 0x040b24];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: podInitHex[i] });
    const pod = new THREE.Mesh(podGeo, mat);
    const px = cx - barW * 0.45 + (i + 0.5) * podW;
    pod.position.set(px, barY + 0.036, barZ);
    lightbar.add(pod);
    barPods.push(mat);
  }

  // Smoked clear aerodynamic polycarbonate lens shell wrapping the pods
  const lensShell = new THREE.Mesh(new THREE.BoxGeometry(barW + 0.03, 0.105, 0.285), hw.lightbarLensMat);
  lensShell.position.set(cx, barY + 0.038, barZ);
  lightbar.add(lensShell);
  root.add(lightbar);

  // =========================================================================
  // 4. WIG-WAG HEADLIGHTS + GRILLE STROBES + REAR WINDOW DECK LEDs
  // =========================================================================
  // Alternating Wig-Wag Headlight LED overlays at front headlight pockets
  const wigGeo = new THREE.BoxGeometry(W * 0.13, H * 0.065, 0.045);
  const wigWagL = new THREE.MeshBasicMaterial({ color: 0x20242c });
  const wigWagR = new THREE.MeshBasicMaterial({ color: 0x20242c });
  const hlY = H * 0.46;
  const hlX = W * 0.335;
  const hlZ = frontZ - 0.01;
  const hlMeshL = new THREE.Mesh(wigGeo, wigWagL);
  hlMeshL.position.set(cx + hlX, hlY, hlZ);
  const hlMeshR = new THREE.Mesh(wigGeo, wigWagR);
  hlMeshR.position.set(cx - hlX, hlY, hlZ);
  root.add(hlMeshL, hlMeshR);

  // Two Red/Blue Grille Strobes tucked cleanly between pushbar uprights
  const grilleGeo = new THREE.BoxGeometry(0.16, 0.055, 0.045);
  const grilleR = new THREE.MeshBasicMaterial({ color: 0x220408 });
  const grilleB = new THREE.MeshBasicMaterial({ color: 0x040b24 });
  const gStrobeL = new THREE.Mesh(grilleGeo, grilleR);
  gStrobeL.position.set(cx + W * 0.105, pbBaseY + pbH * 0.64, pbZ + 0.01);
  const gStrobeR = new THREE.Mesh(grilleGeo, grilleB);
  gStrobeR.position.set(cx - W * 0.105, pbBaseY + pbH * 0.64, pbZ + 0.01);
  root.add(gStrobeL, gStrobeR);

  // Rear Window Deck Red/Blue Strobe Bars (facing rearward -Z, unmistakably bright from behind!)
  const rearStrobeGeo = new THREE.BoxGeometry(W * 0.17, 0.055, 0.06);
  const rearR = new THREE.MeshBasicMaterial({ color: 0x220408 });
  const rearB = new THREE.MeshBasicMaterial({ color: 0x040b24 });
  const rStrobeL = new THREE.Mesh(rearStrobeGeo, rearR);
  rStrobeL.position.set(cx + W * 0.15, rearDeckY, metrics.rearDeckZ);
  const rStrobeR = new THREE.Mesh(rearStrobeGeo, rearB);
  rStrobeR.position.set(cx - W * 0.15, rearDeckY, metrics.rearDeckZ);
  root.add(rStrobeL, rStrobeR);

  // =========================================================================
  // 5. DUAL REAR WHIP ANTENNAS (on rear trunk deck, -Z rear!)
  // =========================================================================
  const antLen = 0.64;
  const antGeo = new THREE.CylinderGeometry(0.004, 0.0085, antLen, 5);
  const antBaseGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.03, 6);
  const antZ = rearZ + L * 0.10;
  for (const s of [-1, 1] as const) {
    const ax = cx + s * W * 0.23;
    const base = new THREE.Mesh(antBaseGeo, hw.antennaMat);
    base.position.set(ax, trunkY + 0.015, antZ);
    const whip = new THREE.Mesh(antGeo, hw.antennaMat);
    whip.position.set(ax, trunkY + antLen * 0.5 + 0.01, antZ - 0.025);
    whip.rotation.x = -0.09; // angled slightly rearward into the slipstream
    root.add(base, whip);
  }

  // =========================================================================
  // 6. WET-ASPHALT ADDITIVE GROUND STROBE WASH + REAL DYNAMIC POINTLIGHT
  // =========================================================================
  const washGeo = new THREE.PlaneGeometry(W * 3.4, L * 2.1);
  washGeo.rotateX(-Math.PI * 0.5);
  const groundWashMat = new THREE.MeshBasicMaterial({
    map: getGroundWashTexture(),
    color: 0x000000,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const groundWash = new THREE.Mesh(washGeo, groundWashMat);
  groundWash.position.set(cx, 0.035, cz);
  groundWash.renderOrder = 2;
  root.add(groundWash);

  let pointLight: THREE.PointLight | null = null;
  if (withDynamicLights) {
    // Single alternating Red/Blue PointLight on roof bar: casts intense real light pools onto wet street,
    // buildings & player car; intensity = 0 when idle so Clustered Forward+ skips it at zero GPU cost!
    pointLight = new THREE.PointLight(0xff1838, 0, 26, 1.5);
    pointLight.position.set(cx, barY + 0.34, barZ);
    pointLight.castShadow = false;
    root.add(pointLight);
  }

  const phaseOffset = (phaseCounter++ * 0.23) % 1.0;

  return {
    root,
    lights: {
      barPods,
      wigWagL,
      wigWagR,
      grilleR,
      grilleB,
      rearR,
      rearB,
      groundWashMat,
      pointLight,
      phaseOffset,
      wasActive: false,
    },
  };
}

// HDR-boosted linear emissive colors so bloom makes LEDs pop dramatically at night
const RED_OFF = 0x220408;
const BLUE_OFF = 0x040b24;
const WHITE_OFF = 0x161820;
const HL_IDLE = 0x3a3e48;

/**
 * Update a Police Interceptor's multi-module Whelen LED lightbar, wig-wag headlights,
 * grille & rear deck strobes, wet-road wash, and real dynamic red/blue PointLight.
 *
 * Uses a realistic rapid triple-flash LED strobe pattern (red-red-red -> white flash -> blue-blue-blue -> amber/white)
 * rather than a slow 50/50 blink. Zero GPU cost when active === false (PointLight intensity = 0).
 */
export function updatePoliceLights(rig: PoliceLightRig, tSec: number, active: boolean): void {
  if (!active) {
    if (!rig.wasActive) return;
    rig.wasActive = false;
    rig.barPods[0].color.setHex(RED_OFF);
    rig.barPods[1].color.setHex(RED_OFF);
    rig.barPods[2].color.setHex(WHITE_OFF);
    rig.barPods[3].color.setHex(WHITE_OFF);
    rig.barPods[4].color.setHex(BLUE_OFF);
    rig.barPods[5].color.setHex(BLUE_OFF);
    rig.wigWagL.color.setHex(HL_IDLE);
    rig.wigWagR.color.setHex(HL_IDLE);
    rig.grilleR.color.setHex(RED_OFF);
    rig.grilleB.color.setHex(BLUE_OFF);
    rig.rearR.color.setHex(RED_OFF);
    rig.rearB.color.setHex(BLUE_OFF);
    rig.groundWashMat.opacity = 0;
    if (rig.pointLight) rig.pointLight.intensity = 0;
    return;
  }

  rig.wasActive = true;

  // 0.88 s authentic Whelen quad/triple-strobe cycle with per-unit phase offset
  const cycle = 0.88;
  const p = (((tSec + rig.phaseOffset * cycle) % cycle) + cycle) % cycle;
  const f = p / cycle; // 0..1

  // Triple-flash burst helper: produces 3 crisp rapid flashes inside a [0..0.40] window
  const triplePulse = (u: number): boolean => {
    if (u < 0 || u > 0.40) return false;
    const step = Math.floor((u / 0.40) * 6); // 0=ON, 1=OFF, 2=ON, 3=OFF, 4=ON, 5=OFF
    return step % 2 === 0;
  };

  const redBurst = triplePulse(f);
  const whiteSnap = f >= 0.40 && f < 0.48;
  const blueBurst = triplePulse(f - 0.50);
  const amberSnap = f >= 0.90 && f < 0.98;

  // Inner pods slightly cross-alternate for rich multi-module Whelen sweep
  const redOuterOn = redBurst;
  const redInnerOn = redBurst || (amberSnap && Math.floor(tSec * 22) % 2 === 0);
  const blueOuterOn = blueBurst;
  const blueInnerOn = blueBurst || (whiteSnap && Math.floor(tSec * 22) % 2 === 1);

  // Set HDR-boosted emissive colors on roof pods
  if (redOuterOn) rig.barPods[0].color.setRGB(4.2, 0.12, 0.28);
  else rig.barPods[0].color.setHex(RED_OFF);

  if (redInnerOn) rig.barPods[1].color.setRGB(3.8, 0.14, 0.30);
  else rig.barPods[1].color.setHex(RED_OFF);

  if (whiteSnap) {
    rig.barPods[2].color.setRGB(4.0, 4.0, 4.4);
    rig.barPods[3].color.setRGB(4.0, 4.0, 4.4);
  } else if (amberSnap) {
    rig.barPods[2].color.setRGB(3.6, 1.8, 0.12);
    rig.barPods[3].color.setRGB(3.6, 1.8, 0.12);
  } else {
    rig.barPods[2].color.setHex(WHITE_OFF);
    rig.barPods[3].color.setHex(WHITE_OFF);
  }

  if (blueInnerOn) rig.barPods[4].color.setRGB(0.18, 1.35, 4.4);
  else rig.barPods[4].color.setHex(BLUE_OFF);

  if (blueOuterOn) rig.barPods[5].color.setRGB(0.16, 1.45, 4.8);
  else rig.barPods[5].color.setHex(BLUE_OFF);

  // Grille & rear window deck strobes counter-flash with roof bar for continuous visual impact
  if (redBurst || amberSnap) rig.grilleR.color.setRGB(3.8, 0.14, 0.28);
  else rig.grilleR.color.setHex(RED_OFF);

  if (blueBurst || whiteSnap) rig.grilleB.color.setRGB(0.18, 1.4, 4.6);
  else rig.grilleB.color.setHex(BLUE_OFF);

  if (blueBurst) rig.rearR.color.setRGB(3.6, 0.14, 0.28);
  else if (redBurst) rig.rearR.color.setRGB(2.0, 0.08, 0.18);
  else rig.rearR.color.setHex(RED_OFF);

  if (redBurst) rig.rearB.color.setRGB(0.18, 1.35, 4.4);
  else if (blueBurst) rig.rearB.color.setRGB(0.10, 0.8, 2.4);
  else rig.rearB.color.setHex(BLUE_OFF);

  // Classic alternating wig-wag high-beam headlight flash (~2.8 Hz)
  const wigLeft = Math.floor((tSec + rig.phaseOffset) * 2.8) % 2 === 0;
  if (wigLeft) {
    rig.wigWagL.color.setRGB(3.4, 3.6, 4.2);
    rig.wigWagR.color.setRGB(0.55, 0.58, 0.65);
  } else {
    rig.wigWagL.color.setRGB(0.55, 0.58, 0.65);
    rig.wigWagR.color.setRGB(3.4, 3.6, 4.2);
  }

  // Real dynamic PointLight + additive wet-asphalt reflection wash
  if (redBurst) {
    rig.groundWashMat.color.setHex(0xff1838);
    rig.groundWashMat.opacity = 0.52;
    if (rig.pointLight) {
      rig.pointLight.color.setHex(0xff1838);
      rig.pointLight.intensity = 58;
    }
  } else if (blueBurst) {
    rig.groundWashMat.color.setHex(0x1b7cff);
    rig.groundWashMat.opacity = 0.56;
    if (rig.pointLight) {
      rig.pointLight.color.setHex(0x1b7cff);
      rig.pointLight.intensity = 62;
    }
  } else if (whiteSnap) {
    rig.groundWashMat.color.setHex(0xdcebff);
    rig.groundWashMat.opacity = 0.42;
    if (rig.pointLight) {
      rig.pointLight.color.setHex(0xe8f2ff);
      rig.pointLight.intensity = 46;
    }
  } else if (amberSnap) {
    rig.groundWashMat.color.setHex(0xff981a);
    rig.groundWashMat.opacity = 0.34;
    if (rig.pointLight) {
      rig.pointLight.color.setHex(0xff8c18);
      rig.pointLight.intensity = 34;
    }
  } else {
    // Brief inter-strobe dark trough (keeps strobe snappy & unmistakably LED-like!)
    rig.groundWashMat.opacity = 0.08;
    if (rig.pointLight) {
      rig.pointLight.intensity = 6;
    }
  }
}
