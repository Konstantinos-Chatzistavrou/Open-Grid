#!/usr/bin/env node
// Apache-2.0 — Generate Unreal Engine 5.8 UDataTable CSVs and Tokyo Night PostProcessVolume config
// from OpenGrid's single-source-of-truth data/ and web/src/ files.
//
// Reads:
//   - data/cars/catalog.json
//   - data/cars/<id>.json & data/cars/<id>.visual.json
//   - web/src/parts-names.ts & web/src/parts-metrics.ts
//   - web/src/brands.ts & web/src/progression.ts (fallback metadata for the 8 original cars)
//   - ue5/Import/<id>/manifest.json or stock_wing.glb (if exported) for HasStockWing
//
// Writes:
//   - data/ue5/car_catalog_dt.csv
//   - data/ue5/parts_catalog_dt.csv
//   - data/ue5/tokyo_night_postprocess.json
//
// Usage:
//   node tools/ue5/generate_ue5_datatables.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DATA_CARS = path.join(REPO, 'data', 'cars');
const UE5_IMPORT = path.join(REPO, 'ue5', 'Import');
const OUT_DIR = path.join(REPO, 'data', 'ue5');

/** RFC 4180 / Unreal UDataTable CSV field escaping. */
function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Extract a JS literal (array or object) assigned to a const in a TS source file. */
function extractTsConstLiteral(source, constName, openChar, closeChar) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${constName}\\b[^=]*=\\s*\\${openChar}`);
  const match = re.exec(source);
  if (!match) {
    throw new Error(`Could not find const ${constName} in TypeScript source`);
  }
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let inStr = null;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const literal = source.slice(start, i + 1);
        // Strip TS `as const` or trailing type assertions inside if any, then evaluate literal safely.
        return Function(`"use strict"; return (${literal});`)();
      }
    }
  }
  throw new Error(`Unterminated literal for const ${constName}`);
}

function rgbFloatToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return '#ffffff';
  const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (
    '#' +
    [rgb[0], rgb[1], rgb[2]]
      .map((v) => toByte(v).toString(16).padStart(2, '0'))
      .join('')
  );
}

function computePeakPowerKw(physics) {
  const curve = physics?.engine?.torque_curve;
  if (!Array.isArray(curve) || !curve.length) return 0;
  let peakKw = 0;
  for (const pt of curve) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [rpm, torqueNm] = pt;
    const kw = (torqueNm * rpm * 2 * Math.PI) / 60000;
    if (kw > peakKw) peakKw = kw;
  }
  return Number(peakKw.toFixed(1));
}

function detectHasStockWing(carId, visual) {
  // Prefer actual UE5 export evidence if available
  const wingGlb = path.join(UE5_IMPORT, carId, 'stock_wing.glb');
  if (fs.existsSync(wingGlb)) return true;

  const manifestPath = path.join(UE5_IMPORT, carId, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest?.files && 'stock_wing' in manifest.files) return true;
      // If the car was exported without a stock_wing.glb, trust the export manifest
      if (manifest?.files && 'body' in manifest.files) return false;
    } catch {
      // fall through to visual.json heuristic
    }
  }

  // Fallback: inspect panels in <id>.visual.json
  const panels = visual?.panels || {};
  for (const list of Object.values(panels)) {
    if (Array.isArray(list) && list.some((n) => /wing|spoiler/i.test(String(n)))) {
      return true;
    }
  }
  return false;
}

function loadLegacyCarFallbacks() {
  const brandsPath = path.join(REPO, 'web', 'src', 'brands.ts');
  const progPath = path.join(REPO, 'web', 'src', 'progression.ts');
  let carBrand = {};
  let carEngine = {};
  let carReq = {};
  let carVmax = {};

  if (fs.existsSync(brandsPath)) {
    const src = fs.readFileSync(brandsPath, 'utf8');
    carBrand = extractTsConstLiteral(src, 'CAR_BRAND', '{', '}');
    carEngine = extractTsConstLiteral(src, 'CAR_STOCK_ENGINE', '{', '}');
  }
  if (fs.existsSync(progPath)) {
    const src = fs.readFileSync(progPath, 'utf8');
    carReq = extractTsConstLiteral(src, 'CAR_REQ', '{', '}');
    carVmax = extractTsConstLiteral(src, 'CAR_VMAX_KMH', '{', '}');
  }
  return { carBrand, carEngine, carReq, carVmax };
}

function generateCarCatalogCsv() {
  const catalogPath = path.join(DATA_CARS, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const { carBrand, carEngine, carReq, carVmax } = loadLegacyCarFallbacks();

  const headers = [
    '---',
    'Name',
    'DisplayName',
    'Brand',
    'Tag',
    'PaintHex',
    'Price',
    'SpLevel',
    'MpLevel',
    'VmaxKmh',
    'EngineVoice',
    'EngineLabel',
    'MassKg',
    'PeakPowerKw',
    'Drivetrain',
    'PhysicsJsonPath',
    'VisualJsonPath',
    'BodyMeshAsset',
    'HasStockWing',
  ];

  const rows = [];
  for (const car of catalog.cars) {
    const id = car.id;
    const physicsRel = car.physics || `cars/${id}.json`;
    const visualRel = car.visual || `cars/${id}.visual.json`;
    const physicsPath = path.join(REPO, 'data', physicsRel);
    const visualPath = path.join(REPO, 'data', visualRel);

    if (!fs.existsSync(physicsPath)) {
      throw new Error(`Missing physics JSON for ${id}: ${physicsPath}`);
    }
    if (!fs.existsSync(visualPath)) {
      throw new Error(`Missing visual JSON for ${id}: ${visualPath}`);
    }

    const physics = JSON.parse(fs.readFileSync(physicsPath, 'utf8'));
    const visual = JSON.parse(fs.readFileSync(visualPath, 'utf8'));

    const brand = car.brand || carBrand[id] || 'valenza';
    const req = carReq[id] || {};
    const eng = carEngine[id] || {};
    const spLevel = car.spLevel ?? req.spLevel ?? 1;
    const mpLevel = car.mpLevel ?? req.mpLevel ?? 1;
    const vmaxKmh = car.vmaxKmh ?? carVmax[id] ?? 300;
    const engineVoice = car.engineVoice || eng.voice || 'v8_crossplane';
    const engineLabel = car.engineLabel || eng.label || '';
    const paintHex = car.paint || rgbFloatToHex(visual.default_paint);
    const massKg = physics?.chassis?.mass_kg ?? 1400;
    const peakPowerKw = computePeakPowerKw(physics);
    const drivetrain = String(physics?.drivetrain?.layout || 'rwd').toUpperCase();
    const bodyMeshAsset = `/Game/OpenGrid/Cars/${id}/body.body`;
    const hasStockWing = detectHasStockWing(id, visual);

    rows.push({
      '---': id,
      Name: id,
      DisplayName: car.name,
      Brand: brand,
      Tag: car.tag || '',
      PaintHex: paintHex,
      Price: car.price ?? req.price ?? 0,
      SpLevel: spLevel,
      MpLevel: mpLevel,
      VmaxKmh: vmaxKmh,
      EngineVoice: engineVoice,
      EngineLabel: engineLabel,
      MassKg: massKg,
      PeakPowerKw: peakPowerKw,
      Drivetrain: drivetrain,
      PhysicsJsonPath: physicsRel,
      VisualJsonPath: visualRel,
      BodyMeshAsset: bodyMeshAsset,
      HasStockWing: hasStockWing ? 'True' : 'False',
    });
  }

  const outPath = path.join(OUT_DIR, 'car_catalog_dt.csv');
  fs.writeFileSync(outPath, toCsv(headers, rows), 'utf8');
  return { outPath, count: rows.length };
}

function socketForPart(category) {
  switch (category) {
    case 'wing':
      return 'SOCKET_Wing';
    case 'splitter':
      return 'SOCKET_Splitter';
    case 'diffuser':
      return 'SOCKET_Diffuser';
    case 'skirt':
      return 'SOCKET_Skirt_L';
    case 'rim':
      return 'SOCKET_Wheel_FL';
    case 'front':
      return 'SOCKET_Splitter';
    case 'rear':
      return 'SOCKET_Diffuser';
    case 'hood':
      return 'Root';
    case 'fender':
      return 'Root';
    default:
      return 'Root';
  }
}

function generatePartsCatalogCsv() {
  const namesSrc = fs.readFileSync(path.join(REPO, 'web', 'src', 'parts-names.ts'), 'utf8');
  const metricsSrc = fs.readFileSync(path.join(REPO, 'web', 'src', 'parts-metrics.ts'), 'utf8');

  const wings = extractTsConstLiteral(namesSrc, 'WING_NAMES', '[', ']');
  const aero = extractTsConstLiteral(namesSrc, 'AERO_NAMES', '[', ']');
  const rims = extractTsConstLiteral(namesSrc, 'RIM_NAMES', '[', ']');
  const body = extractTsConstLiteral(namesSrc, 'BODY_NAMES', '[', ']');
  const metrics = extractTsConstLiteral(metricsSrc, 'PART_METRICS', '{', '}');

  const headers = [
    '---',
    'PartId',
    'DisplayName',
    'Category',
    'Downforce',
    'Drag',
    'MassKg',
    'SocketName',
  ];

  const allParts = [
    ...wings.map((p) => ({ id: p.id, name: p.name, category: 'wing' })),
    ...aero.map((p) => ({ id: p.id, name: p.name, category: p.kind })),
    ...rims.map((p) => ({ id: p.id, name: p.name, category: 'rim' })),
    ...body.map((p) => ({ id: p.id, name: p.name, category: p.kind })),
  ];

  const rows = [];
  let measuredCount = 0;
  for (const part of allParts) {
    const m = metrics[part.id];
    if (m) measuredCount++;
    rows.push({
      '---': part.id,
      PartId: part.id,
      DisplayName: part.name,
      Category: part.category,
      Downforce: m ? m.df : 0,
      Drag: m ? m.drag : 0,
      MassKg: m ? m.kg : 0,
      SocketName: socketForPart(part.category),
    });
  }

  const outPath = path.join(OUT_DIR, 'parts_catalog_dt.csv');
  fs.writeFileSync(outPath, toCsv(headers, rows), 'utf8');
  return { outPath, count: rows.length, measuredCount };
}

function generateTokyoNightPostProcessJson() {
  // 1:1 Unreal Engine 5.8 APostProcessVolume calibration matching docs/art_direction.md
  // ("Tokyo Night Color Grading & Scene Quality (`tokyo_night`, default look)").
  const config = {
    schema: 'opengrid_ue5_postprocess/1',
    name: 'PPV_TokyoNight',
    sourceReference: 'docs/art_direction.md#tokyo-night-color-grading--scene-quality',
    volume: {
      bUnbound: true,
      Priority: 10.0,
      BlendWeight: 1.0,
      bEnabled: true,
    },
    LutAssetPath: '/Game/OpenGrid/PostProcess/TokyoNight_UE5_256x16',
    ColorGradingIntensity: 1.0,
    film: {
      // ACES Filmic Tonemapper
      FilmSlope: 0.91,
      FilmToe: 0.62,
      FilmShoulder: 0.28,
      FilmBlackClip: 0.0,
      FilmWhiteClip: 0.04,
    },
    colorGrading: {
      global: {
        ColorSaturation: [1.18, 1.18, 1.18, 1.0],
        ColorContrast: [1.16, 1.16, 1.16, 1.0],
        ColorGamma: [0.96, 0.96, 0.96, 1.0],
        ColorGain: [1.0, 1.0, 1.0, 1.0],
        ColorOffset: [0.0, 0.0, 0.0, 0.0],
      },
      shadows: {
        ColorCorrectionShadowsMax: 0.24,
        ColorSaturationShadows: [1.0, 1.0, 1.0, 1.0],
        ColorContrastShadows: [1.0, 1.0, 1.0, 1.0],
        ColorGammaShadows: [1.0, 1.0, 1.0, 1.0],
        ColorGainShadows: [0.94, 1.03, 1.12, 1.0],
        ColorOffsetShadows: [-0.008, 0.004, 0.014, 0.0],
      },
      midtones: {
        ColorSaturationMidtones: [1.04, 1.04, 1.04, 1.0],
        ColorContrastMidtones: [1.02, 1.02, 1.02, 1.0],
        ColorGammaMidtones: [0.98, 0.99, 1.01, 1.0],
        ColorGainMidtones: [0.98, 1.0, 1.03, 1.0],
        ColorOffsetMidtones: [0.0, 0.0, 0.0, 0.0],
      },
      highlights: {
        ColorCorrectionHighlightsMin: 0.55,
        ColorSaturationHighlights: [1.04, 1.04, 1.04, 1.0],
        ColorContrastHighlights: [1.0, 1.0, 1.0, 1.0],
        ColorGammaHighlights: [1.0, 1.0, 1.0, 1.0],
        ColorGainHighlights: [1.06, 1.03, 1.01, 1.0],
        ColorOffsetHighlights: [0.0, 0.0, 0.0, 0.0],
      },
    },
    bloom: {
      BloomMethod: 'BM_FFT',
      BloomIntensity: 0.68,
      BloomThreshold: 1.42,
      BloomSizeScale: 5.2,
      BloomConvolutionScatterDispersion: 1.0,
      BloomConvolutionPreFilterMin: 1.42,
      BloomConvolutionPreFilterMax: 120.0,
      BloomConvolutionPreFilterMult: 12.0,
    },
    reflections: {
      DynamicGlobalIlluminationMethod: 'Lumen',
      ReflectionMethod: 'Lumen',
      LumenReflectionQuality: 2.0,
      LumenSceneLightingQuality: 1.5,
      LumenRayLightingMode: 'HitLightingForReflections',
      LumenMaxRoughnessToTraceReflections: 0.45,
      HardwareRayTracing: true,
    },
    exposure: {
      AutoExposureMethod: 'AEM_Histogram',
      AutoExposureBias: 0.15,
      AutoExposureMinBrightness: 0.25,
      AutoExposureMaxBrightness: 1.5,
    },
    lens: {
      VignetteIntensity: 0.28,
      FilmGrainIntensity: 0.008,
      ChromaticAberrationIntensity: 0.12,
    },
    targetLuminancePercentiles: {
      p5: 0.031,
      p25: 0.064,
      p50: 0.142,
      p75: 0.371,
      p95: 0.867,
    },
    webReferenceGrade: {
      exposure: 1.54,
      contrast: 0.28,
      lift: 0.004,
      gamma: 0.96,
      sat: 1.18,
      split: 0.44,
      grain: 0.008,
      shadowTint: [-0.024, 0.075, 0.195],
      highlightTint: [0.18, 0.09, 0.04],
    },
  };

  const outPath = path.join(OUT_DIR, 'tokyo_night_postprocess.json');
  fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { outPath };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const cars = generateCarCatalogCsv();
  const parts = generatePartsCatalogCsv();
  const ppv = generateTokyoNightPostProcessJson();

  console.log(`[UE5 DataTables] Wrote ${path.relative(REPO, cars.outPath)} (${cars.count} cars)`);
  console.log(
    `[UE5 DataTables] Wrote ${path.relative(REPO, parts.outPath)} (${parts.count} parts; ${parts.measuredCount} with measured aero/mass metrics)`
  );
  console.log(`[UE5 DataTables] Wrote ${path.relative(REPO, ppv.outPath)}`);
}

main();
