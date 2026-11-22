// Night Run (web build): three.js WebGPU renderer + Rapier rigid bodies + the rs_core physics
// compiled to WebAssembly. WebGPU required. URL options: ?scale=0.75 (pins the render resolution; default adaptive),
// ?quality=max|ultra|high|medium|low|potato (pins the post/render preset; default adaptive), ?webgl=1 (debug only),
// ?bloom=0, ?aa=0, ?shadows=0, ?lights=12 (WebGL 2 light pool size), ?party=CODE (invite: join that multiplayer party, see party.ts),
// ?peer=host:port (own PeerJS server), ?ai=0..5 (race rivals, default 5), ?blackcar=1 (AI cars matte black, lights off: night lighting test),
// ?menu=0 (skip the title and garage: straight into a free run, for the test tools).
// Flow: loading -> title (graphics tuned once behind a cover) -> Play -> game modes: Race (you + 5 AI rivals) / Free Roam (just you) /
// Multiplayer (party lobby). The garage (title -> Garage) is cars, paint and upgrades only: back to the title, or Continue -> game modes.
import * as THREE from 'three/webgpu';
import { ClusteredForwardLighting, PROP_DETAIL_LAYER, Post, PRESETS, PRESET_ORDER, usePotatoOnly, type PresetName } from './post';
import { advancePaintWear, createPaintWearState, resetPaintWear } from './gpu/materials/carPaint';
import { CarProbe } from './fx/carProbe';
import { nightEnvTexture } from './fx/nightEnv';
import { KitSky, kitHdriOn } from './fx/kitHdri';
import { kitMaterialsOn, setKitMaterialsEnabled } from './fx/kitMaterials';
import { ForzaVfxController, type ForzaVfxFrameInput } from './fx/forzaVfx';
import { Garage } from './scene/garage';
import { SHOW_PRESETS, ShowroomPost } from './showroomPost';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CoreCar, CoreRace, OUT, loadCore, type LapInfo, type RawInput } from './physics/core';
import { CarBody, DT, PhysicsWorld, loadRapier, type CarShape } from './physics/world';
import { PhysicsWorkerClient } from './physics/workerClient';
import { CityLighting, loadCity } from './scene/city';
import { NycStreamer, nycCityShim } from './scene/nyc';
import { setGroundCity, setGroundGrid } from './scene/nyc/groundMaterials';
import { setSignCity } from './scene/nyc/signAtlas';
import { setTreeCity } from './scene/nyc/props';
import { CITIES, currentCity, loadExtraCities, saveCity } from './cities';
import { StreetObstacles, type PoleHit } from './scene/nyc/obstacles';
import { setGroundWetness, setMobileFacadeMode } from './scene/nyc';
import { drawEarly, type BreachSpec, type WallHit } from './scene/nyc/breach';
import { CarVisual, type CarVisualConfig } from './scene/car';
import { initLoaders } from './scene/loaders';
import { CameraRig } from './camera';
import { Input } from './input';
import { Hud } from './hud';
import { DamageVisuals, DEBRIS_LAYER } from './scene/damage';
import { GameAudio } from './audio';
import { TouchControls, wantsTouch } from './touch';
import { ForceFeedback } from './ffb';
import { ControlsUi } from './controls-menu';
import { MenuNav } from './menu-nav';
import { fromToggles, loadAssists, saveAssists, toToggles } from './assists';
import { MpCareer, SpCareer } from './career';
import { Cloud } from './cloud';
import { RankedLink } from './ranked';
import { FREE_ROAM_XP_PER_KM, STARTER_CAR, copBustPenalty, raceReward } from './progression';
import { DrivingLine } from './driving-line';
import { Minimap, type Blip } from './minimap';
import { LOAD_TIPS, Loader, steadyFrames } from './loading';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RemoteCars } from './net';
import { Party, cleanCode, type Progress } from './party';
import { Menu, rank, type Gfx, type Screen, type Standing } from './menu';
import { applyMods, customOf, loadSelection, modsOf, paintOf, saveSelection, type CatalogCar, type Mode } from './garage';
import { cleanCustom } from './custom-data';
import { frameStats, sceneTextureStats } from './stats';
import { GRADE } from './fx/grade';
import { HEAT_MAX, Heat } from './heat';
import { skinOf } from './scene/driver';
import RAPIERLib from '@dimforge/rapier3d-compat';
import { AiTraffic, Lane } from './ai';
import { Cops } from './cops';
import { SpontaneousWagers, type NearbyCandidate } from './wagers';
import { CityZones } from './zones';
import { TelemetrySystem } from './telemetry';
import { initLang } from './i18n';
import { applyAccessibility, loadAccessibility, paletteOf, saveAccessibility } from './accessibility';
import { PhotoMode } from './photoMode';
import { CinematicReplay } from './replay';
import { RaceNodes } from './raceNodes';
import { CarMeetHub } from './carMeet';
import { INSURANCE_PREMIUM_XP, conditionOf, loadMaintenance, recordRaceDamage, repairCarCondition, repairCostOf, saveMaintenance, submitModerationReport, towFeeOf } from './maintenance';
import { WorldClock } from './worldClock';
import { AUCTION_LOTS, ENGINE_SWAPS, applyNightRunnersToPhysics, engineOf, loadNightRunners, saveNightRunners, stanceOf, tickEngineAndNos } from './nightRunners';
import { PARTY_BONUS_MUL, advanceChallenge, loadRetention, saveRetention, triggerPrestigeReset } from './retention';
import { VoiceChat } from './voice';
import { ACADEMY_LESSONS, PenaltyTracker, markLessonDone } from './careerEvents';
import { assetUrl, loadGLTF } from './scene/loaders';
import { Identity } from './identity';
import { usernameError } from './username';
import { formatLap } from './hud';
import { autoCap, measureRefresh } from './bench';
import { registerCarMeta } from './brands';
import { CAR_REQ, CAR_VMAX_KMH } from './progression';
import { BASE_CAR_VALUATION } from './auctionMarket';
import { Player2Input, SplitHud, connectedGamepads, type Player2Poll, type SplitLayout } from './splitScreen';
import { ScreenAwake } from './wakeLock';
import { GarageDyno } from './dyno';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
/**
 * The GPU's name as the driver reports it ("Mali-G57 MC2", "Adreno (TM) 610"). WebGPU's adapter info hides it in
 * Chrome; a throwaway WebGL context does not. '' when the browser masks it.
 */
function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch { return ''; }
}
/**
 * Phone GPUs that get potato mode by name: Mali-G57 (Helio G99, Dimensity 700/6020) and everything at or below it -
 * Mali-4xx / T-series, G31, G51, G52, G68, G71, G72; Adreno 3xx-5xx and 60x / 61x; every PowerVR.
 */
const WEAK_GPU = /Mali-(4\d\d|T\d{3}|G31|G51|G52|G57|G68|G71|G72)\b|Adreno \(TM\) ([345]\d\d|6[01]\d)\b|PowerVR/i;
const loading = document.getElementById('loading')!;
/**
 * First screen is a click-for-fullscreen gate, not the loading bar: the game boots behind it, and the click is the
 * user gesture the Fullscreen API needs. Once entered, the normal loading screen (if still loading) or the game shows.
 */
const isFullscreen = () => !!(document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement);
const reqFullscreen = () => {
  try {
    const docEl = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    if (docEl.requestFullscreen) { void Promise.resolve(docEl.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions)).catch(() => { void docEl.requestFullscreen().catch(() => {}); }); }
    else if (docEl.webkitRequestFullscreen) { void Promise.resolve(docEl.webkitRequestFullscreen()).catch(() => {}); }
  } catch { /* iOS Safari / TV browser without Fullscreen API */ }
};
const exitFullscreenSafe = () => {
  try {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
    if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {});
    else if (doc.webkitExitFullscreen) void Promise.resolve(doc.webkitExitFullscreen()).catch(() => {});
  } catch { /* ignore */ }
};

const enterEl = document.getElementById('enter');
let gameReady = false;
const enter = () => {
  const el = enterEl;
  if (!el || !el.isConnected) return;
  el.remove();
  if (!gameReady) loading.hidden = false;
  if (!isFullscreen()) reqFullscreen();
};
enterEl?.addEventListener('click', enter, { once: true });
enterEl?.addEventListener('touchend', enter, { once: true });
// automation gets past the gate (no user gesture to give); ?gate=1 forces it, ?gate=0 skips it everywhere
const auto = navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent) || params.get('gate') === '0';
if (auto && params.get('gate') !== '1') enter();
const loadFill = document.getElementById('load-fill');
const loadMsg = document.getElementById('load-msg');
const loadPct = document.getElementById('load-pct');
const loadTip = document.getElementById('load-tip');
let bootTipIdx = Math.floor(Math.random() * LOAD_TIPS.length);
const rotateBootTip = () => {
  if (!loadTip) return;
  bootTipIdx = (bootTipIdx + 1) % LOAD_TIPS.length;
  loadTip.textContent = 'Tip · ' + LOAD_TIPS[bootTipIdx];
};
rotateBootTip();
const bootTipTimer = window.setInterval(rotateBootTip, 4200);
const say = (s: string, pct?: number) => {
  if (loadMsg) loadMsg.textContent = s; else loading.textContent = s;
  if (pct !== undefined) {
    const p = Math.round(Math.max(4, Math.min(100, pct)));
    if (loadFill) loadFill.style.width = `${p}%`;
    if (loadPct) loadPct.textContent = `${p}%`;
  }
};

/**
 * Load profile: what each stage of the start-up cost (ms since navigation, render pipelines compiled so far).
 * `__loadLog` in the console; Settings shows the total under Graphics.
 */
const loadLog: { stage: string; ms: number; pipelines: number }[] = [];
let pipelineCount = () => 0;
const mark = (stage: string) => { loadLog.push({ stage, ms: Math.round(performance.now()), pipelines: pipelineCount() }); };
(globalThis as { __loadLog?: unknown }).__loadLog = loadLog;

async function main() {
  const refreshP = measureRefresh();   // runs while the renderer and assets load
  // --- renderer -------------------------------------------------------------------------------
  // WebGPU is preferred (clustered lighting, compute). If unavailable OR if WebGPU init fails on any
  // device/browser (Firefox, Safari, Linux without Vulkan, Android, iOS, Smart TVs), we automatically
  // and seamlessly fall back to WebGL 2 — zero dead error screen! ?webgl=1 forces WebGL 2 for testing.
  const isTouch = params.has('touch') ? params.get('touch') !== '0' : wantsTouch();
  let forceWebGL = params.get('webgl') === '1';
  let noWebGPU = forceWebGL;
  if (!forceWebGL) {
    let adapter: GPUAdapter | null = null;
    try {
      adapter = (await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })) ?? null;
    } catch { adapter = null; }
    if (!adapter) {
      const gl2 = !!document.createElement('canvas').getContext('webgl2');
      if (gl2) {
        forceWebGL = true;
        noWebGPU = true;
      } else {
        loading.innerHTML = `<div style="max-width:560px;text-align:left;letter-spacing:0;text-transform:none;line-height:1.6">
          <b style="color:#f4f1ea">Neither WebGPU nor WebGL 2 is enabled in this browser.</b><br>
          Enable Hardware Acceleration in your browser settings or update your graphics driver to play OpenGrid.</div>`;
        if (import.meta.env.DEV) fetch('/__telemetry', { method: 'POST', body: 'NO WEBGPU OR WEBGL2 - stopped' }).catch(() => {});
        return;
      }
    }
  }
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  let renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  // The canvas always runs at baseRatio; `scale` is the RENDER scale of the scene and the passes
  // before the sharpening upscale (post.ts). It used to be the canvas pixel ratio, which the browser
  // then stretched bilinearly (soft) and whose change reconfigured the whole canvas.
  // Graphics: 'auto' tunes resolution + preset behind a cover in the title menu and steps down preset/scale
  // if high-speed driving drops FPS; high/medium/low are fixed. ?scale / ?quality (test tools) pin on top of that.
  // ?touch=1 / ?touch=0 forces the phone path (the headless harness reports a fine pointer, the real phone a coarse one)
  // Phones: the canvas follows the panel (up to 2x CSS px) and `scale` picks the pixels actually rendered, sharpened up to
  // the panel in post.ts. A 1x canvas (915 x 412 on a 2.6x phone) was stretched by the browser: every texture looked unloaded.
  const GFX_KEY = 'nr.gfx.v4';
  let gfx: Gfx = 'auto';
  try { const g = localStorage.getItem(GFX_KEY); if (g === 'max' || g === 'ultra' || g === 'high' || g === 'medium' || g === 'low' || g === 'potato') gfx = g; } catch { /* storage blocked */ }
  /**
   * POTATO: a boot mode for phones a Mali-G57 (Helio G99) class GPU or slower, below `low`. Decided here, before
   * anything is built, because most of what it saves cannot be switched later without recompiling every shader:
   * one tone-mapped pass instead of five post pipelines, no shadow maps, a 1x canvas, short city rings behind thicker
   * fog, 8 street lights, no garage props. It is entered by choice (Settings / ?quality=potato), by the GPU's name,
   * by 3 GB of RAM or less, or by the flag the tuner sets when `low` at its smallest resolution still misses the target.
   */
  const POTATO_KEY = 'nr.potato.v1';
  let potatoFlag = false;
  try { potatoFlag = localStorage.getItem(POTATO_KEY) === '1'; } catch { /* storage blocked */ }
  const gpu = isTouch ? gpuName() : '';
  const weakDevice = isTouch && (WEAK_GPU.test(gpu) || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 3);
  const qParam = params.get('quality');
  let potato = noWebGPU || qParam === 'potato' || (!qParam && (gfx === 'potato' || (gfx === 'auto' && (weakDevice || potatoFlag))));
  if (potato) usePotatoOnly();
  const baseRatio = Math.min(devicePixelRatio, potato ? 1 : isTouch ? 2 : 1);
  const GFX_SCALE = { max: 1, ultra: 1, high: 1, medium: 0.85, low: 0.7, potato: 0.7 } as const;   // phones (their canvas is tuned separately)
  /**
   * Desktop: every preset renders a fixed PIXEL budget, whatever the window size, and the last pass sharpens it up to
   * the canvas (post.ts). Measured on the i3 iGPU the street costs about 6.5 ms + 27 ms per 2 megapixels before any
   * effect, so resolution is the one lever that moves a tier: 0.5 MP is the 45-60 fps picture, 1 MP the 30 fps one.
   * A window smaller than the budget simply renders 1:1.
   */
  const PRESET_MP: Record<PresetName, number> = { max: 0.8e6, ultra: 0.88e6, high: 1.0e6, medium: 0.62e6, low: 0.5e6, potato: isTouch ? 0.22e6 : 0.92e6 };
  let adaptive = gfx === 'auto' && !params.has('scale') && !potato;
  const maxScale = 1;
  const targetPixels = isTouch ? 0.72e6 : 0.9e6;
  const MIN_RENDER = isTouch ? 0.35 : 0.45;   // lowest render scale (a 2x phone canvas at 0.5 was the old 1x picture)
  const guessScale = () => Math.min(maxScale, Math.max(MIN_RENDER, Math.round(Math.sqrt(targetPixels / (innerWidth * innerHeight * baseRatio ** 2)) * 10) / 10));
  let SCALE_KEY = `nr.scale.v5.${innerWidth}x${innerHeight}`;
  let stored = NaN;
  try { stored = Number(localStorage.getItem(SCALE_KEY) ?? NaN); } catch { /* storage blocked */ }
  const presetScale = (p: PresetName) => isTouch && p !== 'potato' ? Math.min(GFX_SCALE[p], guessScale())
    : Math.min(maxScale, Math.max(MIN_RENDER, Math.round(Math.sqrt(PRESET_MP[p] / (innerWidth * innerHeight * baseRatio ** 2)) * 20) / 20));
  const scalePinned = params.has('scale');
  let scale = scalePinned ? num('scale', 1) : potato ? presetScale('potato') : gfx !== 'auto' ? presetScale(gfx) : stored >= MIN_RENDER && stored <= maxScale ? stored : guessScale();
  renderer.setPixelRatio(baseRatio);
  renderer.setSize(innerWidth, innerHeight);
  // Quality preset (post.ts PRESETS), lowered by the adaptive system BEFORE the scale; stored like it.
  const defaultPreset: PresetName = isTouch ? 'medium' : 'ultra';
  let PRESET_KEY = `nr.preset.v5.${innerWidth}x${innerHeight}`;
  let presetPinned = PRESET_ORDER.includes(params.get('quality') as PresetName) || gfx !== 'auto' || potato;
  let storedPreset: string | null = null;
  try { storedPreset = localStorage.getItem(PRESET_KEY); } catch { /* storage blocked */ }
  let presetIdx = Math.max(0, PRESET_ORDER.indexOf((PRESET_ORDER.includes(params.get('quality') as PresetName) ? params.get('quality') : gfx !== 'auto' ? gfx : storedPreset ?? defaultPreset) as PresetName));
  if (!isTouch && !scalePinned) scale = presetScale(PRESET_ORDER[presetIdx]);   // desktop: always the preset's budget (a stored scale is a phone thing)
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = params.get('shadows') !== '0' && !potato;   // potato: no shadow pass, no shadow code in any shader
  renderer.shadowMap.type = THREE.PCFShadowMap;
  try {
    await renderer.init();
  } catch (initErr) {
    if (forceWebGL) throw initErr;
    // WebGPU driver reported an adapter but failed device creation (common on Safari TP / Linux Vulkan / Smart TVs) -> seamless WebGL 2 fallback
    console.warn('[OpenGrid] WebGPU init failed, falling back seamlessly to WebGL 2:', initErr);
    forceWebGL = true;
    noWebGPU = true;
    potato = true;
    usePotatoOnly();
    presetPinned = true;
    adaptive = false;
    presetIdx = 0;
    scale = presetScale('potato');
    renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    await renderer.init();
  }
  pipelineCount = () => (renderer as unknown as { _pipelines?: { caches?: Map<string, unknown> } })._pipelines?.caches?.size ?? 0;
  mark('renderer');
  if (params.has('pipelog')) {
    // ?pipelog=1: which object caused each new render pipeline (`__pipeLog`): the load time of a phone is this list
    const P = (renderer as unknown as { _pipelines: { caches: Map<string, unknown>; getForRender(ro: unknown, p?: unknown): unknown } })._pipelines;
    const log: string[] = ((globalThis as { __pipeLog?: string[] }).__pipeLog = []);
    const orig = P.getForRender.bind(P);
    P.getForRender = (ro: unknown, promises?: unknown) => {
      const n = P.caches.size, out = orig(ro, promises);
      if (P.caches.size > n) {
        const r = ro as { object: THREE.Object3D; material: THREE.Material; context?: { id?: number; sampleCount?: number; renderTarget?: { width: number; height: number; texture?: { type: number; name?: string }; depthTexture?: unknown; samples?: number } | null } };
        const rt = r.context?.renderTarget;
        const path: string[] = [];
        for (let o: THREE.Object3D | null = r.object; o && path.length < 5; o = o.parent) path.unshift(o.name || o.type);
        log.push(`${path.join('/')} | ${r.material.type}${r.material.name ? ':' + r.material.name : ''}${r.material.transparent ? ' transparent' : ''} side${r.material.side} | ctx${r.context?.id} ${rt ? `${rt.width}x${rt.height} type${rt.texture?.type} ${rt.texture?.name ?? ''} depthTex${rt.depthTexture ? 1 : 0}` : 'canvas'} samples${r.context?.sampleCount} @${Math.round(performance.now())}`);
      }
      return out;
    };
  }
  initLoaders(renderer);   // shared glTF decoders (meshopt, KTX2), scene/loaders.ts
  const webgpu = !!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
  const backend = webgpu ? 'WebGPU' : 'WebGL 2';
  if (webgpu) {
    // Clustered Forward+ WGSL compute lighting: clusters BOTH 100+ dynamic streetlights (PointLight) and car headlights (SpotLight)
    renderer.lighting = potato
      ? new ClusteredForwardLighting(128, 12, 7, 12, 16)
      : new ClusteredForwardLighting(512, 24, 14, 16, 32);
  }

  const scene = new THREE.Scene();
  // Night: very dark but never pure black. The hemisphere fill is the floor of the picture
  // (silhouettes barely readable, a matte black car or dark wall all but invisible); headlights are
  // the main light, street lamps leave faint pools. Sky/fog are a hair above black, so distant
  // shapes fade into a deep blue-black instead of a void.
  scene.background = new THREE.Color(0x05060c);
  scene.fog = new THREE.FogExp2(0x05060c, 0.0085);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // placeholder until the city is captured
  scene.environmentIntensity = 0.03;
  scene.add(new THREE.HemisphereLight(0x0a0a14, 0x000000, 0.1));
  const moon = new THREE.DirectionalLight(0x7088c0, 0.04);   // a trace of cold top light on roofs and car bodies
  // rim light: one extra directional from behind-left, very low, so silhouettes separate from the night
  const rimLight = new THREE.DirectionalLight(0x8fb4ff, 0.07);
  rimLight.position.set(-0.45, 0.55, -1);
  scene.add(rimLight, rimLight.target);
  moon.position.set(-60, 120, 40);
  scene.add(moon);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 260);
  camera.layers.enable(DEBRIS_LAYER);       // detached crash parts: main view only
  camera.layers.enable(PROP_DETAIL_LAYER);  // high-poly trees & street clutter: main view + mirror, skipped in planar reflections
  // Resize (window drag, fullscreen): at most once per frame, and never a preset change (that rebuilds pipelines =
  // seconds of shader compiles); the render scale keeps the pixel count the GPU was tuned for (syncToSize).
  let resizeQueued = false;
  let lastSize = `${innerWidth}x${innerHeight}`, lastPixels = innerWidth * innerHeight;
  let syncReady = false;
  addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      if (syncReady) syncToSize();
    });
  });
  // Fullscreen shortcut (KeyF) is handled below once session state is ready so Free Roam can use [F] for headlight flash wagers.

  // --- physics + content (parallel prefetch for fast startup) ---------------------------------
  say('Loading physics & track…', 12);
  const DEFAULT_VISUAL = 'cars/vela_gt.visual.json';
  const visualCfgCache = new Map<string, Promise<CarVisualConfig>>();
  const fetchVisualCfg = (path: string) => {
    let p = visualCfgCache.get(path);
    if (!p) { p = fetch(`/data/${path}`).then((r) => r.json() as Promise<CarVisualConfig>); visualCfgCache.set(path, p); }
    return p;
  };
  const physics: Record<string, unknown> = {};
  const catalogP = fetch('/data/cars/catalog.json').then((r) => r.json() as Promise<{ cars: CatalogCar[] }>).then(async (j) => {
    await Promise.all(j.cars.map((c) => fetch(`/data/${c.physics}`).then((r) => r.json()).then((d) => { physics[c.id] = d; })));
    return j.cars;
  });
  // Merge any extra 1:1 cities ingested via tools/pipeline/ingest_city.py (zero TS edits!)
  await loadExtraCities();
  const useNyc = params.get('city') !== 'old';
  // the real-scale city of this session (cities.ts: New York, London, Paris, Tokyo, Los Angeles); `useNyc` = streamed city tiles
  let cityInfo = currentCity(params);
  setGroundGrid(cityInfo.grid);
  setGroundCity(cityInfo.id);
  setSignCity(cityInfo.id);
  setTreeCity(cityInfo.id);
  const updateCreditsLine = () => {
    const cr = document.getElementById('credits');
    if (cr) cr.innerHTML = cr.innerHTML.replace(/OpenStreetMap contributors<\/a> \(ODbL\)( &amp; NYC Open Data)?/, `OpenStreetMap contributors</a> (ODbL)${cityInfo.id === 'nyc' ? ' &amp; NYC Open Data' : ''}`);
  };
  updateCreditsLine();
  const [catalog, defaultCfg, initRoute] = await Promise.all([
    catalogP,
    fetchVisualCfg(DEFAULT_VISUAL),
    fetch(useNyc ? cityInfo.route : '/data/tracks/city_route.json').then((r) => r.json()),
    loadCore(),
    loadRapier(),
  ]);
  let route = initRoute;
  // Auto-register dynamic brand, engine, progression & Auction valuation metadata for any car added via tools/pipeline/ingest_car.py
  for (const c of catalog as (CatalogCar & { brand?: string; engineVoice?: string; engineLabel?: string; spLevel?: number; mpLevel?: number; vmaxKmh?: number })[]) {
    registerCarMeta(c.id, c.brand, c.engineVoice, c.engineLabel);
    if (!CAR_REQ[c.id]) CAR_REQ[c.id] = { spLevel: c.spLevel ?? 5, mpLevel: c.mpLevel ?? 5, price: c.price ?? 120_000 };
    if (!CAR_VMAX_KMH[c.id]) CAR_VMAX_KMH[c.id] = c.vmaxKmh ?? 310;
    if (!BASE_CAR_VALUATION[c.id]) BASE_CAR_VALUATION[c.id] = c.price ?? 120_000;
  }
  const sel = loadSelection(catalog, params);
  initLang();
  const a11y = loadAccessibility();
  applyAccessibility(a11y);
  const maint = loadMaintenance();
  const nr = loadNightRunners();
  const ret = loadRetention();
  const worldClock = new WorldClock();
  { const w = params.get('weather'); if (w === 'dry' || w === 'rain') worldClock.setWeather(w); }   // screenshots: a fixed sky
  const voice = new VoiceChat();
  // credits, owned cars and upgrades. Dev server tests (?car=..., ?unlockall=1) own everything.
  // careers: single player (XP levels, this device) and online (the server's profile). Dev tests (?car=, ?unlockall=1)
  // unlock the whole single-player career.
  const sp = new SpCareer(import.meta.env.DEV && (params.get('unlockall') === '1' || params.has('car')));
  const cloud = new Cloud();
  const mp = new MpCareer(cloud, catalog);
  // username (unique online, shown in races and on the plates) and friends: identity.ts
  // dev tests (drive.mjs): ?user=NAME skips the first-start username card
  if (import.meta.env.DEV && params.get('user') && !usernameError(params.get('user')!)) sel.name = params.get('user')!;
  const identity = new Identity(sel, cloud);
  const careerOf = () => (sel.career === 'mp' ? mp : sp);
  if (sel.career === 'mp') sel.career = 'sp';   // the game opens on the single-player career; the lobby switches
  // driving assists (Settings): levels of the core's existing aids
  const assistSet = loadAssists();
  const visualPathOf = (id: string) => catalog.find((c) => c.id === id)?.visual ?? DEFAULT_VISUAL;
  const shapeOf = (cfg: CarVisualConfig): CarShape => {
    const cb = cfg.collision_box;
    return { boxSize: cb.size_m, boxCentre: cb.centre_in_model_m, endLift: cb.end_lift_m, endLiftStart: cb.end_lift_start_m };
  };
  let visualPath = visualPathOf(sel.car);
  // Start downloading the player's car GLTF in parallel with the city tiles!
  const carLoadP = (visualPath === DEFAULT_VISUAL ? Promise.resolve(defaultCfg) : fetchVisualCfg(visualPath))
    .then(async (cfg) => ({ cfg, vis: await CarVisual.load(cfg) }));
  /** Spec Class (equal stock car, esports): no upgrades, engine swaps or stance - pure skill. */
  let specClass = false;
  /** the Driving Academy lesson being driven ('' none) and the race's steward time penalties */
  let activeAcademyId = '';
  const penalties = new PenaltyTracker();
  const coreJson = () => specClass ? JSON.stringify(physics[sel.car])
    : JSON.stringify(applyNightRunnersToPhysics(applyMods(physics[sel.car], modsOf(sel)), engineOf(nr, sel.car), stanceOf(nr, sel.car)));
  const carKey = () => specClass ? `${sel.car}|spec` : `${sel.car}|${JSON.stringify(modsOf(sel))}|${JSON.stringify(stanceOf(nr, sel.car))}|${engineOf(nr, sel.car).turbo}|${engineOf(nr, sel.car).manifold}|${engineOf(nr, sel.car).swap}`;
  const turboStageOf = () => {
    if (specClass) return 0;
    const eng = engineOf(nr, sel.car);
    const sw = ENGINE_SWAPS[eng.swap];
    if (eng.turbo === 'twin_turbo' || sel.car === 'tornado_gt3') return 3;
    if (eng.turbo === 'big_single' || sel.car === 'tornado_gt' || sw?.induction === 'turbo') return 2;
    if (eng.turbo === 'twin_scroll') return 1;
    return 0;
  };
  const exhaustStageOf = (): 'stock' | 'sport' | 'race' => {
    if (specClass) return 'stock';
    const eng = engineOf(nr, sel.car);
    const engLvl = modsOf(sel).engine;
    if (eng.manifold === 'titanium_headers' || engLvl >= 3 || /gt3/i.test(sel.car)) return 'race';
    if (eng.manifold === 'equal_length' || engLvl >= 1 || eng.turbo !== 'stock' || customOf(sel).exhaust === 'titanium') return 'sport';
    return 'stock';
  };
  const syncAudioEngine = () => {
    const eng = engineOf(nr, sel.car);
    const sw = specClass ? ENGINE_SWAPS.stock : (ENGINE_SWAPS[eng.swap] ?? ENGINE_SWAPS.stock);
    audio.setCarProfile(sel.car, sw.voice, !specClass && eng.turbo !== 'stock');
    audio.setExhaustStage(exhaustStageOf());
  };
  let builtKey = carKey();
  let core = new CoreCar(coreJson());
  core.setTurboStage(turboStageOf());
  // Optional SharedArrayBuffer + Atomics Web Worker physics prototype (?physworker=1, default OFF).
  const physWorkerRate = Math.max(60, Math.min(1000, Math.round(num('physrate', 240))));
  const physWorker = params.get('physworker') === '1'
    ? await PhysicsWorkerClient.create(coreJson(), physWorkerRate)
    : null;
  let workerAirC = 18, workerTrackC = 22, workerHumidity = 0.48;
  const pw = new PhysicsWorld();
  if (potato) setMobileFacadeMode(true);
  setKitMaterialsEnabled(webgpu && !potato && kitMaterialsOn(params));
  let nyc = useNyc ? new NycStreamer(scene, renderer, pw, camera, {
    base: cityInfo.base,
    surfaces: core.info.surfaces,
    debug: params.get('nycdebug') === '1',
    fogDensity: num('fog', potato ? 0.0045 : 0.0024),
    // Phones: the far ring is skyline only and the fog eats most of it anyway, but every far tile is a draw and the
    // phone is draw-submission bound (docs/performance.md "Where the CPU goes"), so it stops at 560 m there. The
    // near ring is what the player actually drives through. ?far= overrides both for tests.
    // Potato: both rings pulled in (every tile is draws and triangles a Mali-G57 cannot afford) and the fog thickened
    // so the edge is not seen: at 0.0045 the 420 m ring edge is at 3 % visibility.
    farLoad: num('far', potato ? 420 : isTouch ? 560 : 1000),
    farKeep: num('farkeep', potato ? 500 : isTouch ? 660 : 1150),
    ...(potato ? { nearLoad: num('near', 300), nearKeep: num('nearkeep', 380), treeDensity: num('trees', 0.4) } : {}),
    onProgress: (f) => say(`Streaming ${cityInfo.name}… ${Math.round(f * 100)}%`, 20 + f * 55),
  }) : null;
  if (nyc) {
    await nyc.ready();
    // WebGL 2 has no clustered lighting: every light in the scene costs every lit pixel, dark ones too (props.ts limitLights)
    if (!webgpu) nyc.streetProps?.limitLights(num('lights', 12));
    mark('city first ring');
    camera.far = potato ? 560 : 1600;
    camera.updateProjectionMatrix();
  }
  let nycS0 = nyc ? nyc.spawnPoint() : null;
  // Poles, hydrants, bins, shelters, kiosks and tree trunks near the car are solid (obstacles.ts)
  let streetProps = nyc?.streetProps ?? null;
  let obstacles = streetProps && params.get('solidprops') !== '0' ? new StreetObstacles(pw, streetProps) : null;
  const city = nyc ? nycCityShim() : await loadCity(scene, pw, core.info.surfaces, (f) => say(`Loading city… ${Math.round(f * 100)}%`, 20 + f * 55), webgpu && num('bundle', 1) === 1);
  const cityLights = new CityLighting(scene, city.lights, webgpu, num('lights', 12));
  // Kit HDRIs (fx/kitHdri.ts): real captured skies for what the captures reflect. ?hdri=0: the look before the kit.
  const kitSky = webgpu && kitHdriOn(params) ? await KitSky.load(cityInfo.id) : null;
  kitSky?.setWeather(worldClock.weather);
  // Reflections: capture the lit city once from street level (the car isn't in the scene yet).
  {
    const s0 = nycS0 ?? route.samples[0];
    camera.position.set(s0.x, s0.z + 2, -s0.y);
    cityLights.update(1, camera);
    kitSky?.wrapSky(scene);
    // Potato: a generated night environment (fx/nightEnv.ts) instead of the capture, which compiles every city
    // material again for the cube pass (44 pipelines: minutes of a weak phone's load). With the kit: the HDRI itself.
    if (potato) {
      if (kitSky) scene.environment = pmrem.fromEquirectangular(kitSky.night).texture;
      else { const eq = nightEnvTexture(); scene.environment = pmrem.fromEquirectangular(eq).texture; eq.dispose(); }
    } else {
      const cap = () => pmrem.fromScene(scene, 0.02, 0.5, 400, { size: 256, position: camera.position.clone() }).texture;
      scene.environment = kitSky ? kitSky.during(cap) : cap();
    }
    // The capture is for REFLECTIONS (lamps and neon in paint and wet asphalt). At full strength its
    // diffuse part lit every wall like an overcast sky and undid the darkness.
    scene.environmentIntensity = nyc ? 0.65 : 0.5;
  }
  mark('environment capture');
  say('Loading car…', 80);
  // Frame cap: potato & low modes cap cleanly at 60 fps; medium+ on phones cap at 30 fps to prevent thermal throttling;
  // desktop medium+ runs uncapped (native refresh). Explicit ?cap=N always wins.
  const hz = await refreshP;
  const computeCapFps = (p: PresetName): number =>
    params.has('cap') ? num('cap', 0) : (potato || p === 'low' ? 60 : isTouch ? 30 : 0);
  let capFps = computeCapFps(PRESET_ORDER[presetIdx]);
  let capInterval = capFps > 0 ? 1000 / capFps : 0;
  const loadedCar = await carLoadP;
  let visualCfg = loadedCar.cfg;
  let visual = loadedCar.vis;
  visual.setPlate(sel.name);
  drawEarly(visual.model);   // cars stay visible inside a wall breach (breach.ts portal)
  scene.add(visual.root);
  visual.setPaint(paintOf(sel, catalog), sel.finish);
  // Live car reflection probe (src/fx/carProbe.ts): 128 px cube face every 6th drawn frame (motion-gated when parked)
  // gives razor-crisp real-time neon & skyscraper reflections on clearcoat paint with 4x lower pixel/PMREM cost!
  const probeEvery = num('probe', isTouch || potato ? 0 : 6);
  const probeIntensity = num('probei', 1.25);
  const probeSize = num('probesize', isTouch ? 48 : 128);
  const probe = webgpu && probeEvery > 0 ? new CarProbe(renderer, scene, pmrem, probeSize, probeEvery) : null;
  if (probe && kitSky) probe.captureSky = kitSky.capture;
  // The garage: its own scene (scene/garage). Built while the car loads; its cube matches the probe's so the probe
  // can prefilter the room into the texture the car's materials already sample (no material ever changes).
  // Potato has no garage room: the title and the garage menus show the car parked on the street (the showroom camera's
  // street path below). The room is a second scene - 88 more pipelines, 15 textures, a mirror pass - for a backdrop.
  const garageP: Promise<Garage | null> = potato ? Promise.resolve(null) : Garage.create(renderer, pmrem, probe ? probeSize : 128);
  let readyDone = () => {};
  /** resolves when the game is on screen: potato loads the optional car parts after it, not alongside the city */
  const readyP = new Promise<void>((r) => { readyDone = r; });
  const partsGate = potato ? readyP : Promise.resolve();
  // Panels authored in Blender for the Vela GT (cut from its own bumpers and bonnet): loaded once, and fitted to a
  // Vela only. They used to be put on whichever car the game started with, where they sat in the Vela's coordinates.
  const authoredP = partsGate.then(() => Promise.all([
    'vela_front_wide', 'vela_front_track', 'vela_hood_domed', 'vela_rear_wide', 'vela_hood_dome', 'vela_hood_track',
    'vela_hood_vent_auth', 'vela_front_split_auth', 'vela_front_bumper_pro', 'vela_hood_pro',
  ].map((n) => loadGLTF(assetUrl(`cars/v3/${n}.glb`)).then((g) => g.scene).catch(() => null))));
  const fitAuthored = (v: CarVisual, path: string) => {
    if (path !== DEFAULT_VISUAL) return;
    void authoredP.then(([wide, track, domed, rearWide, dome, hoodTrack, vent, split, bumperPro, hoodPro]) => {
      if (wide && track) v.custom.setShells(wide.clone(true), track.clone(true));
      const extra: Record<string, THREE.Object3D> = {};
      for (const [id, g] of [['hood-blender', domed], ['rear-blender', rearWide], ['hood-dome', dome], ['hood-track', hoodTrack],
        ['hood-vent-auth', vent], ['front-split-auth', split], ['front-bumper-pro', bumperPro], ['hood-pro', hoodPro]] as [string, THREE.Object3D | null][]) if (g) extra[id] = g.clone(true);
      v.custom.setExtraParts(extra);
    });
  };
  fitAuthored(visual, visualPath);
  const screenNone = () => menu.screen === 'none';
  // Forza Horizon 6 Real-Time VFX Director: 4-wheel tyre smoke, wet-road rooster-tail spray, bouncing titanium sparks,
  // high-speed rain streaks, physical 4-wheel brake rotor thermals, and curb/landing suspension thump detector.
  const forzaVfx = new ForzaVfxController(scene, { particles: webgpu, lowPower: isTouch || potato });
  const forzaWheelRadii: [number, number, number, number] = [0.34, 0.34, 0.34, 0.34];
  const syncForzaWheelRadii = () => {
    for (let i = 0; i < 4; i++) forzaWheelRadii[i] = visual.wheel(i)?.radius || 0.34;
  };
  syncForzaWheelRadii();
  // Launch control: hold the throttle on the grid, the start clamps wheelspin for ~1.1 s
  let launchArmed = false, launchUntil = 0, lastLaunchText = '';
  /** launch ramp input (reused: no object per 240 Hz tick) */
  const launchIn: RawInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, shiftUp: false, shiftDown: false, device: 0, directGear: -99 };
  const launchEl = document.getElementById('launch');
  // In the garage the car's own lamps are nearly off (no headlight blowout in the room): every emissive "light"
  // material is dimmed and restored for driving. Uniform writes only.
  const dimLamps = (on: boolean) => {
    visual.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) {
        const mat = mm as THREE.MeshStandardMaterial;
        if (!mat || !mat.emissive) continue;
        const u = mat.userData as { showroomSave?: number };
        const name = (mat.name ?? '') + ' ' + (mesh.name ?? '');
        if (!/light|drl|lens|beam|tail/i.test(name)) continue;
        if (on) { if (u.showroomSave === undefined) u.showroomSave = mat.emissiveIntensity ?? 1; mat.emissiveIntensity = (u.showroomSave ?? 1) * 0.025; }
        else if (u.showroomSave !== undefined) { mat.emissiveIntensity = u.showroomSave; u.showroomSave = undefined; }
      }
    });
  };
  probe?.attach(visual.model, probeIntensity);
  let remote: RemoteCars | null = null;   // other players' cars, while a party session runs
  const paintWear = createPaintWearState();
  let pendingScrapeImpulse = 0;
  const wearOverride = params.has('wear') ? Math.max(0, Math.min(1, Number(params.get('wear')))) : null;
  if (wearOverride !== null) visual.custom.setWear(wearOverride, wearOverride * 0.4, wearOverride * 0.5);
  (globalThis as {
    __setWear?: (w: number, scuff?: number, wake?: number) => void;
    __washCar?: () => void;
    __wearState?: () => unknown;
  }).__setWear = (w: number, scuff = w * 0.4, wake = w * 0.5) => {
    paintWear.wear = Math.max(0, Math.min(1, w));
    paintWear.scuff = Math.max(0, Math.min(1, scuff));
    paintWear.wakeSpray = Math.max(0, Math.min(1, wake));
    visual.custom.setWear(paintWear.wear, paintWear.scuff, paintWear.wakeSpray);
  };
  (globalThis as { __washCar?: () => void }).__washCar = () => {
    resetPaintWear(paintWear);
    visual.custom.setWear(0, 0, 0);
  };
  (globalThis as { __wearState?: () => unknown }).__wearState = () => ({ ...paintWear, uniforms: visual.custom.getWear() });
  let party: Party | null = null;         // the multiplayer party we are in (lobby or driving)
  const remoteProg = new Map<string, Progress>();
  let shape = shapeOf(visualCfg);
  visual.renderDt = capInterval ? capInterval / 1000 : 1 / 60;
  let car = new CarBody(pw, core, shape, visual.cg);
  car.usePatchRays = !(isTouch || potato);

  // Rapier only indexes new colliders for queries during a step: step once so the spawn probe
  // below can see the city (without this the first spawn misses the road and drops 3 m).
  pw.world.step();
  const garage = await garageP;
  if (garage && kitSky) garage.setHdri(kitSky.garage ?? kitSky.night, num('garagehdri', 1) * kitSky.garageStrength);   // ?garagehdri=x: x times the measured strength
  const aiCount = Math.max(0, Math.min(5, num('ai', 5)));
  if (aiCount > 0) say('Loading rivals…');
  const ai = await AiTraffic.create(scene, pw, defaultCfg, route.samples, aiCount, params.get('blackcar') === '1', physics.vela_gt ?? physics[catalog[0].id], route.closed !== false);
  ai.onWreck = (name) => { hud.toast('RIVAL OUT', `${name} WRECKED`); };
  if (garage) try {
    const parked: THREE.Object3D[] = [];
    for (const i of [0, 1]) {
      const src = (ai as unknown as { cars?: { model?: THREE.Object3D }[] }).cars?.[i]?.model;
      if (!src) continue;
      const clone = src.clone(true);
      clone.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = Array.isArray(mesh.material) ? mats.map((x) => x.clone()) : (mats[0] as THREE.Material).clone();
        const mm = mesh.material as THREE.MeshStandardMaterial;
        if (mm && mm.color && /paint/i.test(mm.name ?? '')) mm.color.setHex(i ? 0x2a4fd6 : 0xe8e8ea);
        // parked cars are switched off: their headlights at emissive 10 bloom into a huge white orb in the garage
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const st = mat as THREE.MeshStandardMaterial;
          if (st && st.emissive && /light|drl|lens|tail|turn|interior/i.test(st.name ?? '')) st.emissiveIntensity = 0.05;
          else if (st && st.emissive && st.emissiveIntensity > 0.5) st.emissiveIntensity = 0.05;
        }
      });
      parked.push(clone);
    }
    garage.park(parked);
  } catch { /* no parked cars */ }

  // Start line = first route sample (core coords: Z-up) -> three (x, z, -y).
  let s0 = nycS0 ?? route.samples[0];
  let startYaw = Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading));
  /** Grid slot: metres ahead of the start point (ds) and to its right (lat). Free roam: 0, 0. */
  let grid = { ds: 0, lat: 0 };
  const spawn = () => {
    const p = new THREE.Vector3(s0.x, s0.z + 3, -s0.y);
    p.x += Math.sin(startYaw) * grid.ds - Math.cos(startYaw) * grid.lat;
    p.z += Math.cos(startYaw) * grid.ds + Math.sin(startYaw) * grid.lat;
    // on a hill a grid slot 30 m down the road can be metres above or below the start: cast from the ground there
    if (nyc) p.y = Math.max(p.y, nyc.heightAt(p.x, p.z) + 3);
    const hit = pw.raycast(p, p.clone().add(new THREE.Vector3(0, -20, 0)));
    if (hit) p.y -= hit.toi;
    p.y += core.info.cgHeight + 0.02;
    car.place(p, startYaw);
    car.settle();
  };
  spawn();

  // Laps: the core's RaceTracker on the city route (free run: laps counted forever).
  let routeJson = JSON.stringify(route);
  let race = new CoreRace(routeJson, 0);
  let raceCar = race.addCar(car.body.translation());
  let raceT0 = 0, lap: LapInfo | null = null;
  /** AI rivals in the race tracker: their tracker index, last progress, finish time (-1 racing) */
  let aiRace: { idx: number; lap: LapInfo | null; fin: number }[] = [];
  /** Laps of the session's race (0: free roam / free party session; 1 stage for point-to-point routes). */
  const raceLaps = () => {
    const n = sel.mode === 'race' ? sel.laps : sel.mode === 'online' && party?.mode === 'race' ? party.laps : 0;
    return n > 0 && route.closed === false ? 1 : n;
  };
  /** Race rules: full realism (no resets; wrecked / rolled over / stuck = DNF, then spectate) or respawns. A party uses the leader's. */
  const realism = () => raceLaps() > 0 && (sel.mode === 'online' ? party?.realism !== false : sel.realism);
  /** Tactical Police AI runs ONLY in Race Events (never Free Roam); patrolled downtown cities (NYC, London) always enable cops. */
  const copsActiveInRace = () => {
    if (raceLaps() === 0) return false;
    if (params.get('cops') === '0') return false;
    return cityInfo.mandatoryCops || (sel.mode === 'online' ? (party?.copMode ?? true) : sel.copMode);
  };
  /** Out of the race (realism): why, or '' while racing. */
  let myDnf = '';
  let rolledT = 0, stuckT = 0;

  const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
  const input = new Input();
  const rig = new CameraRig(camera, pw, car.body, core.info.redline);
  try { const cam = localStorage.getItem('nr.cam'); if (cam) rig.setMode(cam as never); } catch { /* blocked */ }
  const hud = new Hud();
  hud.cap = capFps > 0 ? Math.round(capFps) : 0;
  /**
   * Wanted heat (docs/design/heat-and-cops.md): a visible 0-5 dial with a real decision behind it. Slice 1 raises it
   * from what the player does (finishing a race, wrecking the car) and cools it over quiet minutes; no cops yet.
   */
  const heat = new Heat();
  const heatEl = document.getElementById('heat')!;
  const renderHeat = () => {
    heatEl.innerHTML = Array.from({ length: HEAT_MAX }, (_, i) => `<i class="${i < heat.level ? 'on' : ''}"></i>`).join('') + `<b>${heat.level}/${HEAT_MAX}</b>`;
    heatEl.classList.toggle('lvl4', heat.level === 4);
    heatEl.classList.toggle('maxed', heat.maxed);
  };
  renderHeat();
  const bumpHeat = (n: number) => { heat.add(n); renderHeat(); menu.heat = heat.level; };
  /**
   * Tactical Physics Police AI (Race Events with Cop Mode ON ONLY — never active in Free Roam).
   * Uses rear-quarter PIT maneuvers (Rapier lateral/yaw impulse), flanking box-in, and physical roadblocks.
   */
  const copsEl = document.getElementById('cops')!;
  let lastCopsText = '';
  // cop line-of-sight ray, reused every frame (Rapier's Ray keeps references to these two objects)
  const copRayO = { x: 0, y: 0, z: 0 }, copRayD = { x: 0, y: 0, z: 1 };
  const copRay = new RAPIERLib.Ray(copRayO, copRayD);
  let copMsg = '';
  let copMsgUntil = 0;
  let escapedCopsThisRace = false;
  const copNote = (t: string, ms = 3500) => { copMsg = t; copMsgUntil = performance.now() + ms; };
  const pitRight = new THREE.Vector3();
  const cops = new Cops(new Lane(route.samples, route.closed !== false), {
    bust: () => {
      // Heavy fine + Pink Slip impound risk at Heat 5 (starter car protected from soft-lock).
      const pen = copBustPenalty(heat.level, heat.level >= 5);
      if (sp.kind === 'sp') sp.penalty(pen.fineXp);
      heat.clear(); renderHeat(); menu.heat = 0;
      const impounded = pen.impoundCar && sel.car !== STARTER_CAR;
      if (impounded) {
        sel.car = STARTER_CAR;
        saveSelection(sel);
      }
      const msg = impounded
        ? `BUSTED · -${pen.fineXp} XP · PINK SLIP IMPOUNDED`
        : `BUSTED · -${pen.fineXp} XP FINE · HEAT RESET`;
      copNote(msg, 5500);
      hud.toast('BUSTED BY PURSUIT SQUAD', impounded ? 'PINK SLIP IMPOUNDED' : `-${pen.fineXp} XP FINE`);
    },
    escaped: () => {
      escapedCopsThisRace = true;
      copNote('ESCAPED PURSUIT · +25% ESCAPE BONUS', 4200);
      hud.toast('PURSUIT EVADED', '+25% ESCAPE BONUS');
    },
    onPitNudge: (latSign, intensity) => {
      // Realistic rear-quarter PIT kick: lateral slip + yaw rotation that skilled counter-steer can catch.
      pitRight.set(1, 0, 0).applyQuaternion(quat).setY(0).normalize();
      const lv = car.body.linvel();
      const av = car.body.angvel();
      const latDv = latSign * intensity * 4.2;
      const yawDw = latSign * intensity * 1.65;
      car.body.setLinvel({ x: lv.x + pitRight.x * latDv, y: lv.y, z: lv.z + pitRight.z * latDv }, true);
      car.body.setAngvel({ x: av.x, y: av.y + yawDw, z: av.z }, true);
      audio.impact(24, false);
      rumbleKj = Math.max(rumbleKj, 24);
    },
    onAlert: (msg) => copNote(msg, 3500),
  });
  // Patrol cruiser prototype: cloned into interceptor + flanker + 2-cruiser tactical roadblock with Rapier colliders,
  // AND 2 parked Friends' Cars in the background bays of the Garage showroom.
  void loadGLTF('/assets/cars/v3/vela_gt_traffic.glb').then((g) => {
    cops.setupVisuals(g.scene, scene, pw);
    if (garage) {
      const baySpecs = [
        { x: -6.2, z: -5.4, yaw: 0.42 },
        { x: 6.4, z: -5.8, yaw: -0.48 },
      ];
      for (const b of baySpecs) {
        const fc = g.scene.clone(true);
        fc.position.set(b.x, 0, b.z);
        fc.rotation.y = b.yaw;
        fc.scale.setScalar(0.98);
        garage.scene.add(fc);
      }
    }
  }).catch(() => { /* pursuit & roadblock logic still runs even without cruiser mesh */ });
  let playerS = 0, copSpawned = false;
  /** test/dev hook: the headless probes set the dial directly */
  const setHeat = (n: number) => { heat.level = Math.max(0, Math.min(HEAT_MAX, n)); heat.lastGain = Date.now(); renderHeat(); menu.heat = heat.level; return heat.level; };
  const audio = new GameAudio();
  audio.lowPower = isTouch || potato;
  audio.prepare();   // the audio device opens now (behind the loading screen), not on the first key press
  let damage = new DamageVisuals(visual, visualCfg, pw, scene);
  let rumbleKj = 0;   // crash energy for the pad's rumble this frame
  let racePaid = false;   // this race's XP is in the career
  let raceImpacts = 0;    // crashes this race (clean-race bonus)
  let ranked: RankedLink | null = null;   // a party race's link to the online race room
  let freeRoamM = 0;      // metres driven in free roam this session (paid on leaving)
  toToggles(assistSet, input.assists);
  input.onAssistKey = () => { fromToggles(assistSet, input.assists); toToggles(assistSet, input.assists); saveAssists(assistSet); };
  const forzaInput: ForzaVfxFrameInput = {
    dt: 0,
    active: false,
    out: car.out,
    carPos: pos,
    carQuat: quat,
    carVel: visual.velocity,
    camera,
    roadWetness: worldClock.wetness,
    asphaltSurfaceId: core.info.surfaces.asphalt,
    handbrake: 0,
    wheelRadii: forzaWheelRadii,
  };
  const wireDamage = () => { damage.onImpact = (kj, glass) => {
    audio.impact(kj, glass); rumbleKj = Math.max(rumbleKj, kj);
    if (kj > 1.8) {
      const lp = damage.last?.lastPoint;
      const sx = lp && (lp[0] !== 0 || lp[1] !== 0 || lp[2] !== 0) ? lp[0] : pos.x;
      const sy = lp && (lp[0] !== 0 || lp[1] !== 0 || lp[2] !== 0) ? lp[1] : pos.y;
      const sz = lp && (lp[0] !== 0 || lp[1] !== 0 || lp[2] !== 0) ? lp[2] : pos.z;
      const sparkInt = Math.min(1.5, 0.45 + kj * 0.045);
      forzaVfx.emitSparks(sx, sy, sz, visual.velocity.x, visual.velocity.y, visual.velocity.z, 8 + kj * 0.85, sparkInt, pos.y - visual.cg.y);
    }
    if (state === 'race' && kj > 3) raceImpacts++;
    // stewards: a heavy hit in a race (ramming / cutting through the wall line) costs +5.0 s
    if (state === 'race' && raceLaps() > 0 && kj > 22 && penalties.addPenalty('Collision / Track Cut', 5.0)) hud.toast('⚠ +5.0s PENALTY', 'Clean racing enforced (GT7 / iRacing rules)');
  }; };
  wireDamage();
  input.onAnyInput = () => audio.unlock();
  audio.muted = true;   // silent in the menus
  // Session state. boot/title/garage/busy: car parked on the start line under the orbit camera;
  // countdown: same, with 3-2-1; race: driving; paused: everything frozen; results: race over, car braked.
  type State = 'boot' | 'title' | 'garage' | 'modes' | 'lobby' | 'busy' | 'countdown' | 'race' | 'paused' | 'spectate' | 'results';
  let state: State = 'boot';
  let pausedFrom: State = 'race';
  let settledShowroom = 0;
  const driving = () => state === 'race' || state === 'countdown' || state === 'paused' || state === 'spectate' || state === 'results';
  const screenAwake = new ScreenAwake();
  const setState = (st: State) => {
    const wasDriving = driving();
    state = st;
    const inDriving = driving();
    if (inDriving && !wasDriving) core.clusterSweep();   // key on: the dash needles sweep to full scale and back
    screenAwake.set(st === 'race' || st === 'countdown' || st === 'spectate');
    const overlayOpen = st === 'paused' || st === 'results';
    if (!inDriving) settledShowroom = 0;
    document.body.classList.toggle('menu', !inDriving);
    document.body.classList.toggle('overlay-menu', overlayOpen);
    if (!inDriving) {
      hud.hide();
      if (st !== 'garage') audio.muted = true;
      else audio.silenceAll();
    } else if (overlayOpen) {
      audio.muted = true;
    }
    if ((!inDriving || overlayOpen) && input.touch) {
      input.touch.state.steer = 0;
      input.touch.state.throttle = 0;
      input.touch.state.brake = 0;
      input.touch.state.handbrake = 0;
    }
    // full realism race: no reset button (R does nothing)
    hud.canRecover = !realism();
    document.body.classList.toggle('noreset', !hud.canRecover);
    document.body.classList.toggle('spectating', st === 'spectate');
    syncHeadlights();
    syncCameraAudioPerspective();
    if (city) city.props.drawScale = inDriving ? DRAW_SCALE[post.preset] : Math.min(0.45, DRAW_SCALE[post.preset]);
  };
  let lastAudioCamPersp: 'chase' | 'hood' | 'cockpit' | 'bumper' | 'garage' | '' = '';
  const syncCameraAudioPerspective = () => {
    const next: 'chase' | 'hood' | 'cockpit' | 'bumper' | 'garage' = (!driving() || state === 'garage')
      ? 'garage'
      : rig.mode === 'hood' ? 'hood'
      : rig.mode === 'bumper' ? 'bumper'
      : 'chase';
    if (next !== lastAudioCamPersp) {
      lastAudioCamPersp = next;
      audio.setCameraPerspective(next);
    }
  };
  syncCameraAudioPerspective();
  // In the showroom (title/garage/busy) the nose spots are nearly off so they never bloom into a white veil over the bumper.
  const syncHeadlights = () => { visual.dim = driving() ? 1 : 0.008; visual.applyHeadlights(); };
  // brake 0.5, not 1: a full brake while stopped engages the pedal reverse
  const IDLE: RawInput = { steer: 0, throttle: 0, brake: 0.5, clutch: 0, handbrake: 1, shiftUp: false, shiftDown: false, device: 0 };
  // Garage dyno (dyno.ts): the car on rollers, same physics as the road; leaving restores the parked car.
  const leaveDyno = () => {
    dyno.exit(core);
    if (garage) garage.holder.position.y = -visual.groundY;
    menu.garageHideUi = false;
    menu.render();
  };
  const dyno: GarageDyno = new GarageDyno(() => leaveDyno());
  let lapTimes: number[] = [], raceFinishedAt = -1;
  const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
  const physPos = new THREE.Vector3(), physQuat = new THREE.Quaternion();
  const readBody = (p: THREE.Vector3, q: THREE.Quaternion) => {
    const t = car.body.translation(), r = car.body.rotation();
    p.set(t.x, t.y, t.z);
    q.set(r.x, r.y, r.z, r.w);
  };
  const syncPose = () => {
    readBody(physPos, physQuat);
    prevPos.copy(physPos);
    prevQuat.copy(physQuat);
    pos.copy(physPos);
    quat.copy(physQuat);
    visual.update(pos, quat, car.out, physPos, physQuat);
    if (physWorker) {
      physWorker.resetPose(physPos, physQuat, car.body.linvel(), car.body.angvel(), 0, 2, false, car.sampleGroundPlanes());
    }
  };
  /** Fresh car on the start line, repaired, traffic back at its grid slots, lap counter at zero. */
  /** the road plane under the car for the wet-road mirror: the terrain's slope there (flat city: horizontal) */
  const roadN: [number, number, number] = [0, 1, 0], roadP: [number, number, number] = [0, 0, 0];
  const roadPlane = (): [[number, number, number] | undefined, [number, number, number] | undefined] => {
    const tr = nyc?.terrain;
    if (!tr) return [undefined, undefined];
    const x = pos.x, z = pos.z, e = 2;
    const hx = (tr.atThree(x + e, z) - tr.atThree(x - e, z)) / (2 * e), hz = (tr.atThree(x, z + e) - tr.atThree(x, z - e)) / (2 * e);
    const l = Math.hypot(hx, 1, hz);
    roadN[0] = -hx / l; roadN[1] = 1 / l; roadN[2] = -hz / l;
    roadP[0] = x; roadP[1] = pos.y - visual.cg.y; roadP[2] = z;
    return [roadN, roadP];
  };
  const resetCar = () => {
    car.body.setEnabled(true);   // paused while spectating (the city streams around the watched car then)
    spawn(); core.repair(); physWorker?.repair(); damage.repair(); forzaVfx.reset(true); input.hold = true; settledShowroom = 0;
    syncPose();
    ai.reset();
    race = new CoreRace(routeJson, raceLaps());
    raceCar = race.addCar(car.body.translation());
    aiRace = ai.mode === 'race' ? ai.cars.map((c) => ({ idx: race.addCar(c.pos), lap: null, fin: -1 })) : [];
    raceT0 = ticks * DT;
    lapTimes = []; raceFinishedAt = -1; lap = null; racePaid = false; raceImpacts = 0; penalties.reset();
    copSpawned = false; escapedCopsThisRace = false; cops.breakOff(); wagers.cancel();
    myDnf = ''; rolledT = stuckT = 0; hud.outWarn = '';
    hud.resetLaps();
    remoteProg.clear();
  };
  /** R in a race or a party: back on the road where you are (nearest route point, facing the right way), repaired. */
  const recover = () => {
    const t = car.body.translation();
    let best = 0, bd = Infinity;
    for (let i = 0; i < route.samples.length; i++) {
      const q = route.samples[i], d = (q.x - t.x) ** 2 + (-q.y - t.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const q = route.samples[best];
    const p = new THREE.Vector3(q.x, t.y + 3, -q.y);
    if (nyc) p.y = Math.max(p.y, nyc.heightAt(p.x, p.z) + 3);   // the route point may be up the hill from where the car ended
    const hit = pw.raycast(p, p.clone().add(new THREE.Vector3(0, -30, 0)), car.body);
    if (hit) p.y -= hit.toi;
    p.y += core.info.cgHeight + 0.02;
    car.place(p, Math.atan2(Math.cos(q.heading), -Math.sin(q.heading)));
    car.settle();
    ranked?.reset();
    core.repair(); physWorker?.repair(); damage.repair(); forzaVfx.reset(false); input.hold = true;
    syncPose();
    remote?.kick();
  };
  input.onReset = () => {
    if (state !== 'race' || realism()) return;   // full realism: no resets in a race
    if (sel.mode === 'free') resetCar(); else recover();
  };
  input.onLights = () => { if (driving()) { visual.lightsOn = !visual.lightsOn; visual.applyHeadlights(); } };
  const enableTouch = () => {
    if (input.touch) return;
    document.body.classList.add('touch');
    input.touch = new TouchControls({
      reset: () => input.onReset(),
      camera: () => rig.toggle(),
      toggleGearbox: () => { input.assists.autoGearbox = !input.assists.autoGearbox; input.onAssistKey(); return input.assists.autoGearbox; },
      unlockAudio: () => audio.unlock(),
      garage: () => { if (driving()) quitSession(party ? 'lobby' : 'title'); },
      recentre: () => input.recentreTilt(),
      tilt: () => input.settings.touchSteering === 'tilt',
    });
  };
  const onTouch = () => { if (driving()) { enableTouch(); removeEventListener('touchstart', onTouch); } };
  // tilt steering chosen earlier: the motion permission (iOS) needs a tap, so ask on the first one
  const tiltAgain = () => { if (input.settings.touchSteering === 'tilt') void input.enableTilt(); removeEventListener('touchend', tiltAgain); };
  addEventListener('touchend', tiltAgain, { passive: true });
  addEventListener('touchstart', onTouch, { passive: true });
  input.onCamera = () => { if (driving()) rig.toggle(); };
  input.onHud = () => { if (driving()) hud.toggle(); };
  input.onGarage = () => { if (driving()) quitSession(party ? 'lobby' : 'title'); };

  // --- post-processing ------------------------------------------------------------------------
  const DRAW_SCALE: Record<PresetName, number> = { max: 1, ultra: 0.9, high: 0.9, medium: 0.78, low: 0.62, potato: 0.42 };
  const post = new Post(renderer, scene, camera, { bloom: params.get('bloom') !== '0', aa: params.get('aa') !== '0', scale, preset: PRESET_ORDER[presetIdx] });
  // The showroom's own pipeline on the garage scene. Phones keep their tuned pixel budget there too.
  const showPost = garage ? new ShowroomPost(renderer, garage.scene, camera, PRESET_ORDER[presetIdx]) : null;
  // ---- rear-view mirror (Settings > Rear mirror; post.ts mirror pass, the #mirror frame in ui.css) -----------------------
  // A camera just behind the tail looks back along the car's heading (yaw only: the picture does not roll with the body).
  // The frame's place on screen is CSS: its rect is copied into post.mirrorRect (re-read twice a second: resize,
  // fullscreen, hidden HUD). It updates every 3rd rendered frame (4th on low / medium) and sees 160 m: the scene is
  // drawn a second time, with its own light clusters (measured: ~10 % of the frame when drawn every 2nd frame at 230 m). Phones and potato start with it off.
  const mirrorEl = document.getElementById('mirror')!;
  let mirrorOn = !isTouch && !potato;
  try { const v = localStorage.getItem('nr.mirror'); if (v !== null) mirrorOn = v === '1'; } catch { /* blocked */ }
  let mirrorRectAt = -1e9, mirrorLaidOut = false;
  post.mirrorCam.far = 135; post.mirrorCam.updateProjectionMatrix();   // crisp rear traffic & city without drawing distant tiles twice
  const mirrorFwd = new THREE.Vector3(), mirrorAt = new THREE.Vector3(), mirrorQ = new THREE.Quaternion();
  const placeMirrorCam = () => {
    const root = visual.root, cam = post.mirrorCam;
    root.getWorldQuaternion(mirrorQ);
    mirrorFwd.set(0, 0, 1).applyQuaternion(mirrorQ).setY(0);
    if (mirrorFwd.lengthSq() < 1e-6) mirrorFwd.set(0, 0, 1);
    mirrorFwd.normalize();
    // the tail in the car's frame (root = the CG): body length from the collision box, 0.25 m past the bumper
    const back = shape.boxSize[2] / 2 - shape.boxCentre[2] + visual.cg.z + 0.25;
    root.getWorldPosition(mirrorAt);
    cam.position.copy(mirrorAt).addScaledVector(mirrorFwd, -back);
    cam.position.y = mirrorAt.y - visual.cg.y + 1.05;
    cam.up.set(0, 1, 0);
    cam.lookAt(cam.position.x - mirrorFwd.x * 20, cam.position.y - 1.1, cam.position.z - mirrorFwd.z * 20);
    cam.updateMatrixWorld();
  };
  const updateMirror = (now: number) => {
    const want = mirrorOn && driving() && state !== 'spectate' && !inGarage && screenNone();   // not under the pause / results menus
    if (mirrorEl.hidden === want) mirrorEl.hidden = !want;
    if (!want) { post.mirror = false; mirrorLaidOut = false; return; }
    if (!mirrorLaidOut || now - mirrorRectAt > 500) {
      mirrorRectAt = now;
      const c = renderer.domElement.getBoundingClientRect(), r = mirrorEl.getBoundingClientRect();
      mirrorLaidOut = c.width > 0 && r.width > 2 && r.height > 2;   // zero size: the HUD is hidden (H)
      if (mirrorLaidOut) {
        post.mirrorRect.value.set((r.left - c.left) / c.width, (r.top - c.top) / c.height, (r.right - c.left) / c.width, (r.bottom - c.top) / c.height);
        const asp = r.width / r.height, cam = post.mirrorCam;
        if (Math.abs(cam.aspect - asp) > 1e-3) { cam.aspect = asp; cam.updateProjectionMatrix(); }
      }
    }
    post.mirror = mirrorLaidOut;
    post.mirrorEvery = (post.preset === 'low' || post.preset === 'medium' || post.preset === 'potato') ? 6 : 4;
    if (mirrorLaidOut) placeMirrorCam();
  };
  const showScale = (p: PresetName) => (isTouch ? Math.min(SHOW_PRESETS[p].scale, Math.max(0.5, guessScale())) : SHOW_PRESETS[p].scale);
  const syncShowPreset = () => {
    if (!garage || !showPost) return;
    const p = post.preset;
    showPost.preset = p;
    if (showPost.scale !== showScale(p)) showPost.setScale(showScale(p));
    garage.floor.setResolution(SHOW_PRESETS[p].mirror * (isTouch ? 0.5 : 1));
  };
  syncShowPreset();
  /**
   * Hero car in the garage or on the street. Only the MODEL moves between the scenes: the car's root (with its
   * headlight spots) stays in the city, so the city's light set - and with it every compiled city shader - never
   * changes. In the garage the car's reflection probe is filled from the room; back on the street it captures the city.
   */
  let inGarage = false;
  const IDENT_Q = new THREE.Quaternion();
  const setGarage = (on: boolean, recapture = true) => {
    if (!garage || on === inGarage) return;
    inGarage = on;
    if (on) {
      visual.model.position.set(0, 0, 0);
      garage.holder.add(visual.model);
      garage.holder.position.set(0, -visual.groundY, 0);
      // Entering the garage washes the car back to showroom gloss (unless pinned by ?wear=).
      if (wearOverride === null) {
        resetPaintWear(paintWear);
        visual.custom.setWear(0, 0, 0);
      }
      if (garage.dirtyEnv) garage.captureEnv();
      probe?.fromCube(garage.cube.texture);
    } else {
      visual.root.add(visual.model);
      visual.model.position.copy(visual.cg).negate();
      if (recapture) { visual.root.updateMatrixWorld(true); probe?.captureAll(pos, visual.root); }
    }
    dimLamps(on);
  };
  const NEAR_TREES: Record<PresetName, number> = { max: 80, ultra: 80, high: 70, medium: 45, low: 28, potato: 14 };   // photoreal tree range, m
  // Street-light reach (clustered point lights): about half the per-pixel cost of the street is these lights, and
  // 0.7 x their authored range gives most of it back; below that nothing more is saved (measured).
  const LIGHT_RANGE: Record<PresetName, number> = { max: 0.9, ultra: 0.8, high: 0.74, medium: 0.7, low: 0.66, potato: 0.55 };
  /** Dynamic streetlights alive simultaneously via Clustered Forward+ WGSL compute pass (100+ on high/ultra/max, ?lights=N overrides) */
  const LIGHT_CAP: Record<PresetName, number> = { max: 128, ultra: 112, high: 100, medium: 76, low: 48, potato: 12 };
  const lightsOverride = params.has('lights') ? Math.max(0, Math.min(256, num('lights', 112))) : null;
  post.onPreset = (p) => {
    city.setBundled(true); city.props.drawScale = driving() ? DRAW_SCALE[p] : Math.min(0.45, DRAW_SCALE[p]);
    const sp = nyc?.streetProps;
    if (sp) { sp.nearR = NEAR_TREES[p]; sp.rangeScale = LIGHT_RANGE[p]; sp.lightCap = lightsOverride ?? LIGHT_CAP[p]; }
  };
  // Rear-view mirror intentionally stays on layer 0 only (skips high-poly PROP_DETAIL_LAYER trees & clutter): ~60% fewer mirror draw calls!
  post.onBeforeScenePass = (cam) => { nyc?.cullMeshlets(cam); };
  if (probe) probe.onBeforeFace = (cam) => { nyc?.cullMeshlets(cam); };
  (globalThis as { __meshlets?: () => unknown; __readMeshletStats?: () => Promise<unknown> }).__meshlets = () => nyc?.meshletReport() ?? null;
  (globalThis as { __readMeshletStats?: () => Promise<unknown> }).__readMeshletStats = () => nyc?.readMeshletStats() ?? Promise.resolve(null);
  post.onPreset(post.preset);
  // Headlight shadow map: only the car bodies cast into it (the city does not cast), re-rendered
  // every Nth frame by preset (stale by one frame = ~1 m of light travel at 130 km/h, invisible:
  // map and light matrix stay paired, so shadows stay anchored to their casters).
  let headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
  for (const sh of headShadows) sh.autoUpdate = false;

  rig.update(1, pos.copy(car.body.translation() as THREE.Vector3), quat.copy(car.body.rotation() as THREE.Quaternion), new THREE.Vector3(), car.out);
  cityLights.update(1, camera);
  city.update(camera, true);
  mark('car, rivals, garage room, post');
  say('Compiling shaders…', 90);
  // Fast unified warm-up behind the loading screen: compile all scene materials once with unculled
  // meshes + props + particle sprites so GPU buffers, bind groups, and pipelines are created in one pass.
  /**
   * Precompile everything visible in a scene FOR THE TARGET IT IS DRAWN INTO. A pipeline belongs to its render target's
   * formats; renderer.compileAsync builds for whatever target happens to be current - at boot that was the environment
   * prefilter's leftover target, so every street material was compiled for a target nothing draws to and then again,
   * synchronously, on the first real frame (measured in potato: 136 of 220 pipelines were never used).
   */
  const compileFor = async (sc: THREE.Scene, target: THREE.RenderTarget) => {
    // Potato skips it: the precompile generates every shader a second time on the main thread (the warm-up frame that
    // follows builds its own copy), which doubled a throttled load (22 s -> 11 s without it, same 88 pipelines). The
    // normal boot keeps it: there it saves pipelines across its five presets (222 with, 260 without).
    if (params.has('precompile') ? params.get('precompile') === '0' : potato) return;
    renderer.setRenderTarget(target);
    try { await renderer.compileAsync(sc, camera); } finally { renderer.setRenderTarget(null); }
  };
  const warm = async () => {
    nyc?.cullMeshlets(camera);
    post.syncRoadReflection(camera, pos.y - visual.cg.y);
    post.planarRoad?.forceNext();
    await compileFor(scene, post.sceneTarget);
    probe?.captureAll(pos, visual.root);
    for (const sh of headShadows) sh.needsUpdate = true;
    post.warmup();
  };
  city.props.warmup(true);
  nyc?.breaches.warmup(true, pos);   // room / rubble / portal materials compiled now, not at the first crash
  damage.warmup(true);
  visual.warmup(true);   // exhaust flames, wheel blur, rotor glow: pipelines now, not at the first backfire / speed / hot brake
  forzaVfx.warmup(true); // 4-wheel smoke, wet spray, titanium sparks, speed rain: pipelines compiled behind loader
  visual.update(pos, quat, car.out);
  if (ai.cars.length && !potato) {   // potato compiles the rivals at the first race start (compileRivals), not here
    const yaw = Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading));
    ai.stage(pos.clone().setY(pos.y - core.info.cgHeight - 0.05), yaw);
    ai.mode = 'race';
    ai.update(1, camera);
  }
  {
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.frustumCulled && (o as THREE.Mesh).isMesh) { o.frustumCulled = false; culled.push(o); } });
    if (mirrorOn) { placeMirrorCam(); post.mirror = true; post.mirrorEvery = 1; }   // its pipelines and buffers now, not at the first race
    await warm();
    mark('compile street');
    // one real frame per likely preset with culling off: GPU buffers/bind groups for every city tile + prop
    // are created now (rendering presets back to back inside one frame skips per-frame node updates)
    await post.warmupFrames();
    post.mirror = false;
    for (const o of culled) o.frustumCulled = true;
  }
  mark('warm presets');
  {
    const dmgInt = damage as unknown as { killLights(n: string[]): void; fireLight: THREE.PointLight };
    visual.lightsOn = false; visual.applyHeadlights();
    dmgInt.killLights([...visualCfg.front_lights, ...visualCfg.rear_lights]);
    dmgInt.fireLight.intensity = 30;
    await compileFor(scene, post.sceneTarget);
    post.render();
    dmgInt.fireLight.intensity = 0;
    damage.repair();
    visual.lightsOn = true; visual.applyHeadlights();
  }
  mark('compile damage states');
  // the garage: car in the room, room into the cube, every showroom preset once
  if (garage && showPost) {
    setGarage(true);
    await compileFor(garage.scene, showPost.sceneTarget);
    garage.captureEnv();
    probe?.fromCube(garage.cube.texture);
    await showPost.warmup();
    setGarage(false, false);
  }
  mark('compile garage');
  if (garage) void garage.loadProps().catch(() => { /* the room works without its dressing */ });
  ai.setMode('off');
  city.props.warmup(false);
  nyc?.breaches.warmup(false);
  nyc?.endWarm();
  damage.warmup(false);
  visual.warmup(false);
  forzaVfx.warmup(false);
  city.update(camera, true);
  if (webgpu) await (renderer.backend as unknown as { device: GPUDevice }).device.queue.onSubmittedWorkDone();
  const pipelinesAtStart =(renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size;
  mark('ready');
  readyDone();
  const setExtra = () => (hud.extra = `${backend} · ${Math.floor(renderer.domElement.width * scale)}×${Math.floor(renderer.domElement.height * scale)}`
    + ` → ${renderer.domElement.width}×${renderer.domElement.height} · scale ${+scale.toFixed(2)}${adaptive ? '' : ' (fixed)'}`
    + ` · ${post.preset}${presetPinned ? ' (fixed)' : ''} · ${cityLights.mode}`
    + (party ? ` · party ${party.code} · ${party.members.length} driver${party.members.length > 1 ? 's' : ''}` : ''));
  setExtra();

  // --- loop: fixed 240 Hz physics, render every frame -----------------------------------------
  let acc = 0, prev = performance.now(), ticks = 0;
  const frameTimes: number[] = [];
  // Graphics tuning. It runs ONLY from the title menu, behind an opaque cover (menu.ts), so no
  // resolution or preset change is ever visible with a car on screen, and nothing changes while
  // driving. Windows of 1 s average the fps of the parked showroom view (a drive costs more, hence
  // the 40 fps bar rather than 30): below it -> cheaper preset first (no hitch), then -0.1 scale
  // (min 0.5); above 55 fps with 90 % of frames < 22 ms -> +0.1 (only if nothing was lowered).
  // The settled scale and preset are stored per window size, so the next visit is one window.
  // The tuner measures with the cap off, so its target is the uncapped rate that still holds the cap: 30 fps needs
  // ~30.6 uncapped, not 36 - that number threw a preset tier away for headroom nobody sees. Phones keep their 48.
  const WINDOW = 650, STEP = 0.1, MIN_SCALE = MIN_RENDER, TUNE_TIMEOUT = 15000;
  /** the target the tuner protects (fps), and the median frame time that still holds it, with a 3 % margin */
  // The quality target is its own number now (?target=), independent of the cap: uncapped rendering must not make the
  // tuner chase 60 and spend the whole quality budget (that was the "tiers do nothing" bug). Default 30.
  const TUNE_TARGET = num('target', 30);
  const FRAME_BUDGET = (1000 / TUNE_TARGET) * 1.03;
  /** resolution gives way before an effect tier does; phones stop at 0.5 (the old 1x picture) before dropping effects */
  const RES_FLOOR = isTouch ? 0.5 : MIN_SCALE;
  let winStart = 0, tuning = false, upSteps = 0, wentDown = false, tuneStart = 0, lowStreak = 0, okStreak = 0, quietWindows = 0;
  /** the last valid windows' median frame times: a single noisy window must not move the scale (title-screen p50 swings 26-39 ms) */
  const p50s: number[] = [];
  const medianP50 = () => (p50s.length ? [...p50s].sort((a, b) => a - b)[p50s.length >> 1] : 0);
  /**
   * The title camera streams the city in for a few seconds. fps while it does is CPU-bound and does not move with
   * render scale (measured: 25.3 fps at 1.0, 0.9, 0.8 and 0.7 - docs/performance.md), so those windows must not
   * decide anything; once the streamer is dry the same screen reads 24.6 / 27.3 / 31.1 fps at scale 1.0 / 0.8 / 0.6.
   */
  const citySettled = () => { const s = nyc?.stats(); return !s || (s.loading === 0 && s.queued === 0); };
  let driveWinTime = 0, driveFrames = 0, lowDrive = 0;
  /**
   * A phone at the resolution floor that still misses the target on `low` - or misses it by 40 % on any preset - needs
   * potato: a different boot (one pipeline, no shadows, short rings), so the flag is stored and the page reloads behind
   * the tuning cover.
   */
  const needsPotato = (fps: number) => isTouch && !potato && !presetPinned && scale <= RES_FLOOR + 1e-6
    // on `low` already, or so far under the target that the effects between here and `low` (bloom, FXAA) cannot close it
    && (presetIdx === PRESET_ORDER.length - 1 || fps < TUNE_TARGET * 0.6);
  /** Seamlessly enter potato mode in-place (zero page reload, keeps fullscreen!). */
  const goPotato = () => {
    try { localStorage.setItem(POTATO_KEY, '1'); } catch { /* ignore */ }
    void applyGfx('potato');
    return true;
  };
  const POTATO_NOTE = noWebGPU ? 'Potato mode on WebGL 2: this browser has no WebGPU, which every other preset needs.'
    : 'Potato mode: lightest graphics, 60 FPS cap. Switch to any preset seamlessly without reloading.';
  const startScale = () => guessScale();
  /** `resize`: also move to the preset's own pixel budget (desktop; a render-target resize, so never while driving). */
  const syncCap = (p: PresetName) => {
    capFps = computeCapFps(p);
    capInterval = capFps > 0 ? 1000 / capFps : 0;
    hud.cap = capFps > 0 ? Math.round(capFps) : 0;
    visual.renderDt = capInterval ? capInterval / 1000 : 1 / 60;
  };
  const setPreset = (i: number, resize = true) => {
    const clamped = Math.max(0, Math.min(PRESET_ORDER.length - 1, i));
    presetIdx = clamped;
    const p = PRESET_ORDER[clamped];
    post.ensurePreset(p);
    post.preset = p;
    if (resize && !isTouch && !scalePinned && scale !== presetScale(p)) applyScale(presetScale(p));
    syncCap(p);
    syncShowPreset();
    try { localStorage.setItem(PRESET_KEY, post.preset); } catch { /* storage blocked */ }
  };
  const applyScale = (x: number) => {
    scale = Math.min(maxScale, Math.max(MIN_SCALE, Math.round(x * 20) / 20));
    post.setScale(scale);   // render targets + cluster grid resize: the hitch the cover hides
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* storage blocked */ }
  };
  /**
   * Window or fullscreen size changed. The PRESET stays (changing it builds new pipelines: seconds of shader compiles,
   * the old 10 s fullscreen freeze). The render scale keeps the pixel count the GPU was tuned for: a 1.0 scale tuned in
   * a 1280x800 window becomes ~0.7 at 1920x1080 fullscreen. A scale stored for the new size wins (tuned there before).
   */
  syncReady = true;
  function syncToSize() {
    const k = `${innerWidth}x${innerHeight}`;
    if (k === lastSize) return;
    const px = innerWidth * innerHeight, ratio = Math.sqrt(lastPixels / Math.max(1, px));
    lastSize = k; lastPixels = px;
    SCALE_KEY = `nr.scale.v5.${k}`; PRESET_KEY = `nr.preset.v5.${k}`;
    try { localStorage.setItem(PRESET_KEY, post.preset); } catch { /* storage blocked */ }
    if (!adaptive && isTouch) return;
    let sc = NaN;
    try { sc = Number(localStorage.getItem(SCALE_KEY) ?? NaN); } catch { /* storage blocked */ }
    stored = sc;
    if (!isTouch) { if (!scalePinned) applyScale(presetScale(post.preset)); setExtra(); return; }
    applyScale(sc >= MIN_SCALE && sc <= maxScale ? sc : scale * ratio);
    setExtra();
  }
  const startTuning = (full: boolean) => {
    if (!full && !Number.isNaN(stored) && storedPreset && PRESET_ORDER.includes(storedPreset as PresetName)) {
      finishTuning();
      return;
    }
    tuning = true; wentDown = false; lowStreak = 0; okStreak = 0; quietWindows = 0; p50s.length = 0; tuneStart = performance.now();
    upSteps = full ? 1 : 0;
    if (full || Number.isNaN(stored)) { setPreset(PRESET_ORDER.indexOf(defaultPreset)); if (isTouch) applyScale(startScale()); }
    frameTimes.length = 0;
    winStart = performance.now() + 450;   // let the cover frame pacing settle briefly
    menu.setTuning(true);
    setExtra();
  };
  const finishTuning = () => {
    tuning = false;
    frameTimes.length = 0;
    menu.setTuning(false, `Graphics tuned for this device: ${post.preset}, ${Math.round(scale * 100)} % resolution`);
    setExtra();
  };
  let gfxBusy = false;
  const applyGfx = async (g: Gfx) => {
    if (gfxBusy) return;
    gfx = g;
    try {
      localStorage.setItem(GFX_KEY, g);
      if (g === 'potato') localStorage.setItem(POTATO_KEY, '1');
      else localStorage.removeItem(POTATO_KEY);
    } catch { /* storage blocked */ }
    if (noWebGPU) { menu.setTuning(false, POTATO_NOTE); return; }   // nothing else can run here
    const prevPreset = post.preset;
    const prevPotato = potato;
    const nextPotato = g === 'potato';
    const orderAll: PresetName[] = ['max', 'ultra', 'high', 'medium', 'low', 'potato'];
    const targetPreset: PresetName = g === 'auto' ? defaultPreset : g;
    const dramatic = prevPotato !== nextPotato || g === 'auto' || Math.abs(orderAll.indexOf(targetPreset) - orderAll.indexOf(prevPreset)) >= 1;

    gfxBusy = true;
    try {
      if (dramatic) {
        await loader.show(`Applying ${g.toUpperCase()} graphics…`, `${g.toUpperCase()} PRESET`, 25);
      }
      // If we booted in potato-only mode and are leaving potato, restore full PRESET_ORDER in-place (zero reload!)
      if (!nextPotato && PRESET_ORDER.length === 1 && PRESET_ORDER[0] === 'potato') {
        PRESET_ORDER.length = 0;
        PRESET_ORDER.push('max', 'ultra', 'high', 'medium', 'low');
      }
      potato = nextPotato;
      setMobileFacadeMode(potato);
      audio.lowPower = isTouch || potato;
      car.usePatchRays = !(isTouch || potato);
      renderer.shadowMap.enabled = !potato && params.get('shadows') !== '0';
      camera.far = potato ? 560 : 1600;
      camera.updateProjectionMatrix();
      nyc?.setQualityMode(potato, isTouch);

      if (dramatic) loader.text('Reconfiguring WebGPU pipelines…', 58);
      if (g === 'auto') {
        adaptive = true;
        presetPinned = false;
        post.ensurePreset(defaultPreset);
        setPreset(PRESET_ORDER.indexOf(defaultPreset));
        if (dramatic) { await steadyFrames(3, 68, 1600); loader.text('Ready!', 100); loader.hide(); }
        startTuning(true);
        return;
      }
      adaptive = false;
      presetPinned = true;
      tuning = false;
      post.ensurePreset(g);
      if (g === 'potato') {
        post.preset = 'potato';
        applyScale(presetScale('potato'));
        syncCap('potato');
        syncShowPreset();
        try { localStorage.setItem(PRESET_KEY, 'potato'); } catch { /* storage blocked */ }
      } else {
        setPreset(PRESET_ORDER.indexOf(g));
        applyScale(presetScale(g));
      }
      menu.setTuning(false, g === 'potato' ? POTATO_NOTE : `Graphics fixed: ${g}`);
      setExtra();
      if (dramatic) {
        loader.text('Stabilizing frame pacing…', 86);
        await steadyFrames(3, 68, 1800);
        loader.text('Ready!', 100);
        loader.hide();
      }
    } finally {
      gfxBusy = false;
    }
  };
  let stepMs = 0;
  const trace: unknown[] = [];
  const g = window as unknown as { __game: object };
  // Hidden tab: requestAnimationFrame stops, so nothing renders; restart the tuning window and the
  // frame clock on return (the hidden time would read as one enormous frame).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { frameTimes.length = 0; if (tuning) winStart = performance.now() + 1000; prev = performance.now(); }
  });
  let frameNo = 0;
  g.__game = { city, nyc, ai, visual, audio, rig, damage, forzaVfx, trace, input, renderer, camera, scene, post, THREE, grade: GRADE, heat, setHeat, cops, worldClock, setGroundWetness, stats: () => frameStats(scene, renderer), texStats: () => sceneTextureStats(scene, 0),
    get car() { return car; }, get core() { return core; }, get state() { return state; }, ticksNow: () => ticks, routeSamples: route.samples, menu: () => menu, sel,
    get party() { return party; }, get remote() { return remote; }, streetProps, obstacles, standings: () => standings(), get lap() { return lap; },
    setPreset: (name: PresetName) => { setPreset(PRESET_ORDER.indexOf(name)); setExtra(); },
    garage, showPost, probe, get inGarage() { return inGarage; },
    setScale: (x: number) => { scale = x; post.setScale(x); setExtra(); },
    presetScale, get scale() { return scale; },
    pipelines: () => ({ atStart: pipelinesAtStart, now: (renderer as unknown as { _pipelines: { caches: Map<string, unknown> } })._pipelines.caches.size }),
    // Rapier cost per step + what it simulates (static city colliders have no body: never integrated)
    physics: () => ({ stepMs, bodies: pw.world.bodies.len(), colliders: pw.world.colliders.len(),
      worker: physWorker ? physWorker.stats() : { active: false, crossOriginIsolated: Boolean(globalThis.crossOriginIsolated) },
      list: pw.world.bodies.getAll().map((b) => `${b === car.body ? 'car' : b.isKinematic() ? 'ai' : 'debris'}:${b.isSleeping() ? 'asleep' : 'awake'}`).join(' ') }),
    info: () => ({ pos: car.body.translation(), speed: car.out[OUT.speed], rpm: car.out[OUT.rpm], gear: car.out[OUT.gear] }) };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // --- front end: title -> garage -> session -------------------------------------------------
  let garagePreloaded = false;
  const preloadGarageCars = () => {
    if (garagePreloaded) return;
    garagePreloaded = true;
    for (const c of catalog) {
      const p = visualPathOf(c.id);
      if (p !== visualPath) void fetchVisualCfg(p);
    }
  };
  const paintInt = () => parseInt(paintOf(sel, catalog).slice(1), 16);
  const meForParty = () => ({ name: sel.name, car: sel.car, paint: paintInt(), skin: sel.skin, look: customOf(sel), city: cityInfo.id });
  /** The garage look (parts, colours) and the driver's skin + avatar gear on the car & Car Meet avatar. */
  let carMeetRef: CarMeetHub | null = null;
  const applyLook = () => {
    visual.custom.apply(customOf(sel), paintOf(sel, catalog));
    visual.driver.setSkin(skinOf(sel.skin), sel.avatarGear);
    const st = stanceOf(nr, sel.car);
    visual.setStance(st.camberFront, st.camberRear);
    syncAudioEngine();
    carMeetRef?.setAvatarGear(sel.avatarGear);
  };
  /** The online account keeps each car's look; a garage click pushes once (debounced) once the profile is known. */
  let lookPush = 0;
  const pushLook = () => {
    if (!mp.profile) return;
    clearTimeout(lookPush);
    lookPush = window.setTimeout(() => { void cloud.saveLook(sel.car, customOf(sel)).catch(() => { /* offline: the look stays local */ }); }, 700);
  };
  const isShowroom = (st: State) => st === 'title' || st === 'garage' || st === 'modes' || st === 'lobby' || st === 'busy';
  const menu: Menu = new Menu(sel, catalog, physics, {
    preview: () => { void (async () => {
      // Seamless car swap (stays in fullscreen, never reloads): sleek determinate loader covers the GLB/shader settle
      const swap = visualPathOf(sel.car) !== visualPath;
      const carLabel = catalog.find((c) => c.id === sel.car)?.name ?? 'Vehicle';
      if (swap) await loader.show(`Loading ${carLabel}…`, carLabel.toUpperCase(), 28);
      await showCar();
      if (swap) loader.text('Applying paint & telemetry…', 82);
      visual.setPaint(paintOf(sel, catalog), sel.finish);
      applyLook();
      party?.updateMe(meForParty());
      if (swap) {
        await steadyFrames(3, 68, 2200);
        loader.text('Ready!', 100);
        loader.hide();
      }
    })(); },
    play: (mode) => { teardownSplitScreen(); void startSession(mode); },
    playSplit: (mode, layout, carId) => void startSplitScreen(mode, layout, carId),
    // Seamless in-place city switching: disposes the previous city streamer & swaps tiles/roads/minimap/landmarks
    // right behind the loading overlay — ZERO page reload, stays in Fullscreen!
    city: (id) => { void switchCity(id); },
    cities: () => ({ list: CITIES, current: cityInfo.id }),
    gfx: (g2) => { void applyGfx(g2); },
    resume: () => resume(),
    restart: () => { menu.show('none'); if (raceLaps() > 0) void beginRace(); else { resetCar(); setState('race'); audio.muted = false; prev = performance.now(); } },
    quit: (to) => quitSession(party ? 'lobby' : to),
    screen: (sc: Screen) => {
      if (sc === 'garage') { orbit.dist = 6.6; orbit.el = 0.17; }   // whole car in frame, just above the belt line
      if (sc === 'title' || sc === 'garage' || sc === 'modes' || sc === 'lobby') setState(sc);
      if (sc === 'garage') preloadGarageCars();
    },
    // garage camera presets are relative to the car: 0 = in front, pi/2 = the driver's (left) side, pi = behind
    cam: (az, el, dist) => {
      if (Number.isNaN(az)) { orbit.holdUntil = 0; orbit.el = 0.17; orbit.dist = 6.8; orbit.drag = false; return; }   // Orbit button: turntable now
      orbit.az = az; orbit.el = el; orbit.dist = dist; orbit.drag = false;   // in the garage the car's nose points down +z
      orbit.holdUntil = performance.now() + 15000;   // the turntable waits while you look at that part
    },
    // ---- multiplayer ----
    partyCreate: () => {
      if (menu.partyBusy) return;
      menu.partyBusy = true; menu.partyNote = ''; menu.render();
      Party.create(meForParty()).then(attachParty, (e: Error) => { menu.partyNote = e.message; })
        .finally(() => { menu.partyBusy = false; if (menu.screen === 'lobby') menu.render(); });
    },
    partyJoin: (code) => {
      code = cleanCode(code);
      if (menu.partyBusy) return;
      if (code.length < 4) { menu.partyNote = 'Type the party code your friend sent you.'; menu.render(); return; }
      menu.partyBusy = true; menu.partyNote = ''; menu.render();
      Party.join(code, meForParty()).then(attachParty, (e: Error) => { menu.partyNote = e.message; })
        .finally(() => { menu.partyBusy = false; if (menu.screen === 'lobby') menu.render(); });
    },
    partyLeave: () => {
      party?.leave();
      detachParty('');
    },
    partyMode: (mode, laps, real, copMode) => party?.setMode(mode, laps, real, copMode),
    partyStart: () => party?.start(),
    partyLobby: () => { if (party?.isHost) party.backToLobby(); quitSession('lobby'); },
    partyRejoin: () => { if (party?.phase === 'driving') void startSession('online', true); },
    partyMe: () => party?.updateMe(meForParty()),
    spectate: () => enterSpectate(),
    assists: () => { toToggles(assistSet, input.assists); saveAssists(assistSet); },
    look: () => { applyLook(); party?.updateMe(meForParty()); pushLook(); },
    // the bank/pay choice: spend reputation to clear the wanted level before the next race
    layLow: () => { if (sp.kind !== 'sp' || sp.xp < 300) return; sp.penalty(300); heat.clear(); renderHeat(); menu.heat = 0; menu.render(); },
    // driving camera chosen in Settings: chase / far / cinematic / hood / bumper (C cycles)
    camMode: (mode) => { try { localStorage.setItem('nr.cam', mode); } catch { /* blocked */ } rig.setMode(mode as never); },
    mirror: (on) => { mirrorOn = on; try { localStorage.setItem('nr.mirror', on ? '1' : '0'); } catch { /* blocked */ } },
    photoMode: () => { if (driving()) { menu.show('none'); if (state === 'paused') setState(pausedFrom); photoMode.enter(pos); audio.muted = true; } },
    replayMode: () => { if (driving() || state === 'results') { menu.show('none'); if (replay.enter()) audio.muted = true; } },
    exportMotec: () => {
      const res = telemetry.exportMotec();
      hud.toast('📊 MoTeC EXPORTED', `${res.samples.toLocaleString()} samples (${(res.bytes / 1024).toFixed(0)} KB .ld + .ldx)`);
    },
    simhubToggle: (on) => {
      telemetry.setSimHubStream(on);
      hud.toast(on ? '📡 SIMHUB UDP STREAM ON' : 'SIMHUB UDP OFF', on ? 'Run: node tools/simhub_udp_bridge.mjs (UDP 20777)' : 'Telemetry stream paused');
    },
    carMeet: () => {
      if (state === 'paused') resume();
      if (raceLaps() === 0) carMeet.togglePanel(true);
    },
    returnFreeRoam: () => { void startSession('free'); },
    accessibility: () => {
      saveAccessibility(a11y);
      applyAccessibility(a11y);
      const pal = paletteOf(a11y);
      drivingLine.setPalette(pal.lineGo, pal.lineCaution, pal.lineBrake);
    },
    language: () => {
      if (cloud.available && mp.profile) void cloud.syncSave({ lang: document.documentElement.lang, a11y }, sel.avatarGear, mp.profile.saveVersion).catch(() => {});
    },
    cloudSync: () => {
      if (!cloud.available) return;
      void cloud.syncSave({ lang: document.documentElement.lang, a11y, car: sel.car, finish: sel.finish }, sel.avatarGear, mp.profile?.saveVersion)
        .then((res) => { mp.profile = res.profile; hud.toast('☁ CLOUD SAVE SYNCED', `v${res.profile.saveVersion ?? 1} · ${res.checksum.slice(0, 8)}`); menu.render(); })
        .catch((e: Error) => { hud.toast('CLOUD SYNC FAILED', e.message); });
    },
    toggleInsurance: (on) => { maint.insured = on; saveMaintenance(maint); },
    repairCar: () => {
      const cond = conditionOf(maint, sel.car);
      const rep = repairCostOf(cond, maint.insured);
      if (rep.pct <= 0) return;
      if (sp.kind === 'sp' && rep.xp > 0) sp.penalty(rep.xp);
      repairCarCondition(maint, sel.car);
      core.repair();
      damage.repair();
      hud.toast('🔧 CAR REPAIRED', `100% Mint${rep.xp ? ` · -${rep.xp} XP${maint.insured ? ' (-50% Insured)' : ''}` : ''}`);
      menu.render();
    },
    reportPlayer: (player, category) => {
      const rid = party?.code ?? `${cityInfo.id}_${Math.floor(Date.now() / 1000)}`;
      void submitModerationReport(cloud, maint, rid, player, category).then((r) => hud.toast('🚩 REPORT SUBMITTED', r.message));
    },
    garageDyno: () => {
      if (dyno.active) { leaveDyno(); return; }
      syncAudioEngine();
      audio.muted = false;
      input.suspended = false;
      if (!garage) return;
      dyno.enter(core, garage.scene, visual.cg);
      menu.garageHideUi = true;
      menu.render();
    },
    garageIgnition: () => {
      syncAudioEngine();
      menu.garageEngineOn = audio.toggleGarageIgnition();
      menu.render();
    },
    garageRevHold: (held) => {
      if (held) syncAudioEngine();
      menu.garageEngineOn = audio.setGarageRev(held);
    },
    garageRev: () => {
      syncAudioEngine();
      audio.pulseGarageRev();
      menu.garageEngineOn = audio.garageEngineOn;
    },
    garageWalk: (on) => {
      garageWalk.active = on;
      if (on) { garageWalk.pos.set(2.4, 1.55, 3.6); garageWalk.yaw = -2.45; }
    },
    nrChanged: () => {
      saveNightRunners(nr);
      const st = stanceOf(nr, sel.car);
      visual.setStance(st.camberFront, st.camberRear);
      syncAudioEngine();
      if (carKey() !== builtKey) { rebuildPlayer(); spawn(); syncPose(); }
    },
    buyAuction: (lotId) => {
      const lot = AUCTION_LOTS.find((x) => x.id === lotId);
      if (!lot || nr.boughtLots.includes(lot.id)) return;
      if (sp.kind === 'sp') sp.penalty(lot.priceXp);
      nr.boughtLots.push(lot.id);
      const eng = engineOf(nr, lot.carId);
      eng.health = lot.startHealth;
      eng.mileageKm = lot.mileageKm;
      eng.tags = [...lot.tags];
      saveNightRunners(nr);
      recordRaceDamage(maint, lot.carId, lot.startDamage, false);
      sel.car = lot.carId;
      saveSelection(sel);
      hud.toast('🔨 AUCTION WON!', `${lot.title} · ${lot.tags[0]}`);
      void showCar();
    },
    prestigeReset: () => {
      const res = triggerPrestigeReset(ret);
      // Annual Season Prestige Reset: resets rank XP while keeping 100% of cars, liveries & garage builds!
      if (sp.kind === 'sp') sp.penalty(sp.xp);
      hud.toast('★ PRESTIGE ACHIEVED', `${res.badge} · Garage & Cars Kept!`);
      menu.render();
    },
    voiceToggle: () => {
      if (voice.enabled) { voice.disable(); menu.voiceOn = false; menu.voiceStatus = voice.status; menu.render(); return; }
      void voice.enable().then((ok) => { menu.voiceOn = ok; menu.voiceStatus = voice.status; menu.render(); });
    },
    voiceMode: (m) => { voice.setMode(m); menu.voiceMode = m; menu.voiceStatus = voice.status; menu.render(); },
    publicMatchmake: () => {
      if (menu.partyBusy) return;
      const pubCode = `PUB${String(new Date().getUTCHours()).padStart(2, '0')}`;
      menu.partyBusy = true; menu.partyNote = `Matching into public lobby ${pubCode}…`; menu.render();
      Party.join(pubCode, meForParty()).then(attachParty, () => Party.create(meForParty()).then(attachParty))
        .catch((e: Error) => { menu.partyNote = e.message; })
        .finally(() => { menu.partyBusy = false; if (menu.screen === 'lobby') menu.render(); });
    },
    voiceMutePeer: (id) => { if (voice.toggleMutePeer(id)) menu.voiceMutedPeers.add(id); else menu.voiceMutedPeers.delete(id); },
    voiceBlockPeer: (id) => { voice.blockPeer(id); menu.voiceMutedPeers.add(id); hud.toast('🚫 PLAYER BLOCKED', 'Voice & chat muted'); },
    musicToggle: (on) => { audio.musicEnabled = on; },
    specClassToggle: (on) => {
      specClass = on;
      if (carKey() !== builtKey) { rebuildPlayer(); spawn(); syncPose(); }
    },
    launchAcademy: (l) => {
      activeAcademyId = l.id;
      specClass = l.specClass; menu.specClass = l.specClass;
      sel.laps = l.laps; sel.copMode = l.cops; saveSelection(sel);
      hud.toast(`🎓 ACADEMY 0${l.num}`, l.goal);
      void startSession('race');
    },
    launchCalendar: (ev) => {
      activeAcademyId = '';
      specClass = ev.specClass; menu.specClass = ev.specClass;
      if (ev.laps > 0) { sel.laps = ev.laps; sel.copMode = ev.cops; saveSelection(sel); void startSession('race'); }
      else void startSession('free');
    },
  });
  menu.a11y = a11y;
  menu.maint = maint;
  menu.nr = nr;
  menu.ret = ret;
  menu.gfx = gfx;
  const loader = new Loader();
  menu.loader = loader;
  menu.sp = sp;
  menu.mp = mp;
  menu.fits = (id) => visual.custom.hasBody(id);
  menu.layLowCost = sp.kind === 'sp' ? 300 : -1;   // reputation is the SP wallet; the online career has no spend path yet
  try { const cam = localStorage.getItem('nr.cam'); if (cam) menu.camMode = cam; } catch { /* blocked */ }
  menu.mirror = mirrorOn;
  const rerender = () => { if (['title', 'shop', 'garage', 'lobby', 'results', 'settings', 'profile'].includes(menu.screen)) menu.render(); };
  let syncedProfile: unknown = null;
  let looksPulled = false;
  mp.onChange = () => {
    if (mp.profile && mp.profile !== syncedProfile) {
      syncedProfile = mp.profile;
      void identity.sync(mp.profile);
      // the account's saved looks arrive once per session; after that local edits are pushed, not pulled over
      if (!looksPulled) {
        looksPulled = true;
        let applied = false;
        for (const [car, look] of Object.entries(mp.profile.looks ?? {})) {
          if (!catalog.some((c) => c.id === car)) continue;
          sel.custom[car] = cleanCustom(look);
          applied = true;
        }
        if (applied) { saveSelection(sel); applyLook(); }
        if (!mp.profile.looks?.[sel.car]) pushLook();   // nothing saved yet: keep the look this device already has
      }
    }
    rerender();
  };
  let mpLoadTried = false;
  identity.onChange = () => {
    party?.updateMe(meForParty()); visual.setPlate(sel.name);
    if (!mpLoadTried && cloud.id && !mp.profile) { mpLoadTried = true; void mp.refresh(); }
    rerender();
  };
  menu.cloud = cloud;
  menu.identity = identity;
  if (cloud.id) void mp.refresh();   // an online account exists on this device: show its level / credits on the title
  else if (cloud.available && !identity.needsPick && !identity.claimed) void identity.pick(sel.name);   // claim the name picked offline
  const presenceBeat = identity.startPresence(() => party?.code ?? null);
  menu.assists = assistSet;
  applyLook();
  const drivingLine = new DrivingLine(scene, ai);
  // GPS minimap: the tiles' road graphs (loaded in the background), the race route, rivals / players & 1:1 city landmarks
  const minimap = new Minimap(document.getElementById('hud')!);
  minimap.setRoute(route.samples, route.closed !== false);
  minimap.setLandmarks(cityInfo.landmarks);
  input.onMap = () => minimap.show(!minimap.visible);
  input.onFullMap = () => { if (driving()) minimap.toggleExpand(); };
  input.onVoicePtt = (down) => voice.setPushToTalk(down);
  // 3D glowing gold GPS Waypoint beacon synced with clicks on the expanded full map
  const waypointBeacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.85, 42, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false }),
  );
  waypointBeacon.visible = false;
  scene.add(waypointBeacon);
  minimap.onWaypoint = (wp) => {
    if (!wp) { waypointBeacon.visible = false; return; }
    waypointBeacon.position.set(wp.x, 21, wp.z);
    waypointBeacon.visible = true;
    hud.toast('📍 GPS WAYPOINT SET', `${Math.round(Math.hypot(wp.x - pos.x, wp.z - pos.z))} m away`);
  };
  const worldClockEl = document.getElementById('world-clock')!;
  const nosBarEl = document.getElementById('nos-bar')!;
  let lastClockText = '', lastNosText = '', lastDensityAt = 0;
  const garageWalk = { active: false, pos: new THREE.Vector3(2.4, 1.55, 3.6), yaw: -2.45 };
  let crashCineT = 0;
  let crashCineWhy = '';
  const completeDaily = (id: string, delta = 1) => {
    const done = advanceChallenge(ret, id, delta);
    if (done) {
      sp.earn(done.xpReward, `daily · ${done.title}`);
      hud.toast(`⚡ DAILY COMPLETE · +${done.xpReward} XP`, `${done.title} · +${done.repReward} REP`);
    }
  };
  if (nyc) void (async () => {
    // one merged street map per city (tools/nyc/build_index.py map.json)
    try {
      const m = await fetch(cityInfo.base + 'map.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (m) minimap.addGraph(m);
    } catch { /* no map: the minimap shows the route only */ }
  })();
  const mmFwd = new THREE.Vector3();
  const flashFwd = new THREE.Vector3();
  const wagerHudEl = document.getElementById('wager-hud')!;
  const zoneHudEl = document.getElementById('zone-hud')!;
  const zoneBoardEl = document.getElementById('zone-board')!;
  let lastWagerHtml = '', lastZoneHtml = '', lastBoardHtml = '';
  const wagers = new SpontaneousWagers(scene, {
    sendNet: (msg) => party?.sendWager(msg),
    onStartAiDrag: (aiIdx, held) => ai.startDrag(aiIdx, held),
    onReleaseAiDrag: () => ai.releaseDrag(),
    onEndAiDrag: () => ai.endDrag(),
    onToast: (title, detail) => hud.toast(title, detail),
    onComplete: (res) => {
      if (res.won) {
        if (res.xpReward > 0) sp.earn(res.xpReward, res.stake === 'pinkslip' ? `pink slip drag vs ${res.opponentName}` : `street drag vs ${res.opponentName}`);
        completeDaily('wager_win', 1);
        hud.toast(
          res.stake === 'pinkslip' ? `🏆 PINK SLIP WON · ${res.timeSec.toFixed(2)}s` : `🏆 $${res.amount.toLocaleString()} WON · ${res.timeSec.toFixed(2)}s`,
          `+${res.xpReward} XP vs ${res.opponentName}`,
        );
      } else {
        hud.toast(
          res.stake === 'pinkslip' ? 'PINK SLIP LOST' : 'DRAG WAGER LOST',
          `${res.opponentName} crossed 400 m first`,
        );
      }
    },
  });
  let zones = new CityZones(scene, cityInfo.id, route.samples, {
    onScore: (z, score, stars, isPB, xp) => {
      if (xp > 0) sp.earn(xp, `${z.kind === 'speed' ? 'speed trap' : 'drift zone'} · ${z.name}`);
      if (z.kind === 'speed' && score >= 180) completeDaily('speed_trap', 1);
      if (z.kind === 'drift' && score >= 3500) completeDaily('drift_pts', 1);
      const unit = z.kind === 'speed' ? 'km/h' : 'PTS';
      const st = '★'.repeat(stars) + '☆'.repeat(3 - stars);
      hud.toast(
        `${z.kind === 'speed' ? '⚡' : '🔥'} ${z.name}${isPB ? ' · NEW PB!' : ''}`,
        `${score.toLocaleString()} ${unit} · ${st}${xp > 0 ? ` · +${xp} XP` : ''}`,
      );
    },
    sendNet: (msg) => party?.sendZoneScore(msg),
  });
  zones.setVisible(false);
  input.onFlash = () => {
    if (state !== 'race' || raceLaps() !== 0) return;
    flashFwd.set(0, 0, 1).applyQuaternion(quat).setY(0).normalize();
    wagers.triggerFlash(pos, flashFwd, party?.selfId ?? 'solo');
    party?.sendFlash();
  };
  input.onStakeToggle = () => { if (state === 'race' && raceLaps() === 0) wagers.toggleStake(); };
  input.onBoard = () => { if (state === 'race' && raceLaps() === 0) zones.boardVisible = !zones.boardVisible; };
  // ---- Sim Racing Telemetry (SimHub UDP + MoTeC .ld/.ldx), Content Creator Suite, Race Nodes & 5-Floor Car Meet ----
  const telemetry = new TelemetrySystem();
  telemetry.reset(sel.name, catalog.find((c) => c.id === sel.car)?.name ?? sel.car, cityInfo.name);
  const photoMode = new PhotoMode(renderer, camera, {
    onRenderFrame: () => { if (inGarage) showPost!.render(); else post.render(); },
    onExit: () => { if (state === 'race' && !replay.active) audio.muted = false; },
    onToast: (title, detail) => hud.toast(title, detail),
  });
  const rpPos = new THREE.Vector3(), rpQuat = new THREE.Quaternion();
  const replay = new CinematicReplay(renderer.domElement, camera, {
    onApplyFrame: (fr) => {
      rpPos.set(fr.px, fr.py, fr.pz);
      rpQuat.set(fr.qx, fr.qy, fr.qz, fr.qw);
      visual.update(rpPos, rpQuat, car.out, rpPos, rpQuat);
      for (let i = 0; i < fr.ai.length && i < ai.cars.length; i++) {
        ai.cars[i].root.position.set(fr.ai[i].x, fr.ai[i].y, fr.ai[i].z);
        ai.cars[i].root.rotation.set(0, fr.ai[i].yaw, 0);
      }
    },
    onOpenPhoto: () => { photoMode.enter(rpPos); },
    onExportMotec: () => {
      const res = telemetry.exportMotec();
      hud.toast('📊 MoTeC EXPORTED', `${res.samples.toLocaleString()} samples (.ld + .ldx)`);
    },
    onExit: () => {
      syncPose();
      if (state === 'race') audio.muted = false;
    },
    onToast: (title, detail) => hud.toast(title, detail),
  });
  let raceNodes = new RaceNodes(scene, cityInfo.id, route.samples, cityInfo.mandatoryCops, {
    onLaunchRace: (node) => {
      sel.laps = node.laps;
      sel.copMode = node.copMode;
      saveSelection(sel);
      void startSession('race');
    },
  });
  raceNodes.setVisible(false);
  const carMeet = new CarMeetHub(scene, {
    onToast: (title, detail) => hud.toast(title, detail),
    onSyncCamera: (cPos, target) => {
      if (photoMode.active || replay.active) return;
      camera.position.lerp(cPos, 0.16);
      camera.lookAt(target);
    },
  });
  carMeetRef = carMeet;
  carMeet.attachToCar(visual.root);
  carMeet.setAvatarGear(sel.avatarGear);
  {
    const pal = paletteOf(a11y);
    drivingLine.setPalette(pal.lineGo, pal.lineCaution, pal.lineBrake);
  }
  input.onPhoto = () => {
    if (photoMode.active) { photoMode.exit(); return; }
    if (driving() && (state === 'race' || replay.active)) {
      if (carMeet.panelOpen) carMeet.togglePanel(false);
      photoMode.enter(replay.active ? rpPos : pos);
      audio.muted = true;
    }
  };
  input.onReplay = () => {
    if (photoMode.active) return;
    if (replay.active) { replay.exit(); return; }
    if (state === 'race') { if (replay.enter()) audio.muted = true; }
  };
  input.onCarMeet = () => {
    if (state === 'race' && raceLaps() === 0 && !photoMode.active && !replay.active) carMeet.togglePanel();
  };
  input.onStepOut = () => {
    if (state === 'race' && raceLaps() === 0 && !photoMode.active && !replay.active) {
      carMeet.toggleStepOut(pos, quat, Math.abs(car.out[OUT.speed]) * 3.6);
    }
  };
  input.onInteract = () => {
    if (state !== 'race' || raceLaps() !== 0 || photoMode.active || replay.active) return;
    const node = raceNodes.nearby;
    if (!node) return;
    if (node.laps === 0) { carMeet.togglePanel(true); return; }
    raceNodes.startMatchmaking(node);
  };
  drivingLine.setCar(applyMods(physics[sel.car], modsOf(sel)));
  // every input device: force feedback (WebHID wheels), the Controls screen, pad / keyboard menu navigation
  const ffb = new ForceFeedback();
  const forwardGears = () => Math.max(1, ((physics[sel.car] as { drivetrain?: { gear_ratios?: number[] } })?.drivetrain?.gear_ratios?.length ?? 8) - 2);
  menu.ctl = new ControlsUi(input, ffb, () => { if (menu.screen === 'controls') menu.render(); }, forwardGears);
  const menuNav = new MenuNav(document.getElementById('menu')!);
  const helpEl = document.getElementById('help');
  input.onDevice = () => { if (helpEl) helpEl.innerHTML = input.helpHtml(); };
  (g.__game as Record<string, unknown>).ffb = ffb;
  (g.__game as Record<string, unknown>).input = input;
  (g.__game as Record<string, unknown>).wagers = wagers;
  (g.__game as Record<string, unknown>).zones = zones;
  (g.__game as Record<string, unknown>).cops = cops;
  (g.__game as Record<string, unknown>).ai = ai;
  (g.__game as Record<string, unknown>).telemetry = telemetry;
  (g.__game as Record<string, unknown>).photoMode = photoMode;
  (g.__game as Record<string, unknown>).replay = replay;
  (g.__game as Record<string, unknown>).raceNodes = raceNodes;
  (g.__game as Record<string, unknown>).carMeet = carMeet;
  (g.__game as Record<string, unknown>).a11y = a11y;
  (g.__game as Record<string, unknown>).maint = maint;
  (g.__game as Record<string, unknown>).worldClock = worldClock;
  (g.__game as Record<string, unknown>).nr = nr;
  (g.__game as Record<string, unknown>).ret = ret;
  (g.__game as Record<string, unknown>).voice = voice;
  (g.__game as Record<string, unknown>).penalties = penalties;
  {
    const inv = cleanCode(params.get('party') ?? '');
    if (inv.length >= 4) menu.invite = inv;
  }

  /** Party session: the leader started (load now), everyone is in (go), back to the lobby, others' cars and progress. */
  let partyGo = false, loadingSession = false;
  function attachParty(p: Party) {
    party = p;
    menu.party = p;
    presenceBeat();   // friends see the party at once
    menu.partyNote = '';
    menu.invite = '';
    if (params.has('party')) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]party=[^&]*/, '').replace(/^&/, '?'));
    if (p.isHost) p.setMode(p.mode, p.laps, sel.realism, sel.copMode);   // the leader's own rules setting is the party default
    p.hooks = {
      changed: () => {
        if (remote) { remote.names = new Map(p.members.map((m) => [m.id, m.name])); remote.looks = new Map(p.members.map((m) => [m.id, { skin: m.skin, look: m.look }])); remote.refreshTags(); }
        if (menu.screen === 'lobby' || menu.screen === 'modes') menu.render();
        setExtra();
      },
      start: () => { partyGo = false; void startSession('online'); },
      go: () => { if (loadingSession) partyGo = true; else if (state === 'busy') void beginRace(); },
      lobby: () => { if (driving() || state === 'busy') quitSession('lobby'); else if (menu.screen === 'lobby') menu.render(); },
      pose: (id, ps, paint) => { if (remote && (driving() || state === 'busy')) remote.receive(id, ps, paint); },
      progress: (id, gp) => { remoteProg.set(id, gp); if (state === 'results') menu.updateResults(standings()); },
      left: (id) => { remote?.remove(id); remoteProg.delete(id); if (state === 'spectate') specRetarget(); },
      gone: (id) => { remote?.remove(id); if (state === 'spectate') specRetarget(); },
      breach: (spec: BreachSpec) => { if (driving()) nyc?.breaches.open(spec); },
      pole: (x, y, vx, vz) => {
        const pl = streetProps?.poleAt(x, y);
        if (pl && driving()) poleHit({ pole: pl, point: { x: pl.x, y: pl.z, z: -pl.y }, impulse: 0, vx, vz }, false);
      },
      flash: (id) => {
        const m = p.members.find((x) => x.id === id);
        if (m && state === 'race' && raceLaps() === 0) hud.toast(`⚡ ${m.name}`, 'FLASHED HIGH-BEAMS');
      },
      wager: (id, w) => {
        const name = p.members.find((x) => x.id === id)?.name ?? 'Driver';
        wagers.onNetWager(id, name, w, p.selfId);
      },
      zoneScore: (_id, z) => { zones.receiveNetScore(z); },
      closed: (reason) => detachParty(reason),
    };
    menu.show('lobby');
    setExtra();
  }
  function detachParty(reason: string) {
    party = null;
    menu.party = null;
    presenceBeat();
    menu.partyNote = reason;
    if (driving() || state === 'busy') quitSession('lobby');
    else if (menu.screen === 'lobby') menu.render();
    else if (reason) menu.show('lobby');
    setExtra();
  }

  /** Everyone in the race, in order: you, the AI rivals (single player) or the party (online). */
  function standings(): Standing[] {
    const L = lap?.routeLength ?? route.length_m;
    const myFin = lap?.finished ? lapTimes.reduce((a, b) => a + b, 0) : -1;
    const list: Standing[] = [{ name: sel.name, you: true, fin: myFin, d: lap?.distance ?? -L, best: lap?.best ?? 0, ai: false, dnf: !!myDnf, why: myDnf }];
    if (sel.mode === 'race') ai.cars.forEach((c, i) => { const r = aiRace[i]; if (r) list.push({ name: c.name, you: false, fin: r.fin, d: r.lap?.distance ?? 0, best: r.lap?.best ?? 0, ai: true }); });
    if (sel.mode === 'online' && party) for (const m of party.members) {
      if (m.id === party.selfId) continue;
      const g = remoteProg.get(m.id);
      list.push({ name: m.name, you: false, fin: g?.fin ?? -1, d: g?.d ?? -L, best: g?.best ?? 0, ai: false, dnf: !!g?.dnf });
    }
    return list;
  }
  // ---- full realism: out of the race, then spectate ------------------------------------------------
  // Same rules as the core's RaceTracker::check_out: totaled, upside down for 5 s, or stuck (< 1 km/h) for 30 s.
  const ROLL_OUT_S = 5, STUCK_OUT_S = 30;
  function checkOut(frame: number) {
    if (!realism() || myDnf || lap?.finished) { hud.outWarn = ''; return; }
    const upY = 1 - 2 * (physQuat.x * physQuat.x + physQuat.z * physQuat.z);   // body up . world up
    rolledT = upY < 0.3 ? rolledT + frame : 0;
    stuckT = Math.abs(car.out[OUT.speed]) < 0.28 ? stuckT + frame : 0;
    const why = damage.last?.totaled ? 'wrecked' : rolledT > ROLL_OUT_S ? 'rolled over' : stuckT > STUCK_OUT_S ? 'stuck' : '';
    hud.outWarn = rolledT > 0.5 ? `ROLLED OVER · OUT IN ${Math.ceil(ROLL_OUT_S - rolledT)} s` : stuckT > STUCK_OUT_S - 10 ? `STUCK · OUT IN ${Math.ceil(STUCK_OUT_S - stuckT)} s` : '';
    if (!why) return;
    myDnf = why;
    hud.outWarn = '';
    ranked?.dnf(why);
    party?.sendProgress({ d: lap?.distance ?? 0, lap: lap?.laps ?? 0, fin: -1, best: lap?.best ?? 0, dnf: 1 });
    if (why === 'wrecked') {
      // Dramatic 2.4-second slow-motion crash wreckage orbit before transitioning to Spectate
      crashCineT = 2.4;
      crashCineWhy = `OUT · ${why.toUpperCase()}`;
      hud.toast('💥 VEHICLE TOTALED', 'Slow-motion wreckage cam…');
      return;
    }
    enterSpectate(`OUT · ${why.toUpperCase()}`);
  }

  /** Cars to watch: the AI rivals (single player) or the other players, best placed first. */
  type SpecTarget = { name: string; body: RAPIER.RigidBody | null; root: THREE.Object3D; ground: boolean; speed: () => number };
  function specTargets(): SpecTarget[] {
    const order = rank(standings()).map((x) => x.name);
    const list: SpecTarget[] = [];
    if (sel.mode === 'race') for (const c of ai.cars) list.push({ name: c.name, body: c.body, root: c.root, ground: true, speed: () => c.v });
    if (remote && party) for (const id of remote.ids()) {
      const r = remote.get(id);
      if (r) list.push({ name: party.members.find((m) => m.id === id)?.name ?? 'Driver', body: r.body, root: r.root, ground: false, speed: () => 0 });
    }
    return list.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  let specIdx = 0, specName = '', specLabel = '', specAt = 0, resAt = 0, resKey = '';
  const specOut = new Float64Array(car.out.length), specPos = new THREE.Vector3(), specQuat = new THREE.Quaternion(), specPrev = new THREE.Vector3();
  const specEl = document.getElementById('spectate')!;
  function enterSpectate(label = specLabel || (lap?.finished ? 'FINISHED' : 'OUT')) {
    specLabel = label;
    setState('spectate');
    menu.show('none');
    audio.muted = true;
    specAt = performance.now();
    specIdx = 0; specName = '';
    specRetarget();
    specEl.hidden = false;
    car.body.setEnabled(false);   // out of the race: parked; its ground may unload while the city follows the watched car
  }
  function hideSpectate() { specEl.hidden = true; }
  function specRetarget() {
    const t = specTargets();
    if (!t.length) { if (state === 'spectate') finishRace(); return; }
    const keep = t.findIndex((x) => x.name === specName);
    specIdx = keep >= 0 ? keep : Math.min(specIdx, t.length - 1);
    const cur = t[specIdx];
    specName = cur.name;
    if (cur.body) rig.setTarget(cur.body, 7000);
    specPrev.copy(cur.root.position);
    rig.snap();
    specEl.innerHTML = `<span class="sp-out">${specLabel}</span><span class="dim">Spectating</span><b></b>
      <button type="button" data-sp="-1" aria-label="Previous car">◀</button><button type="button" data-sp="1" aria-label="Next car">▶</button>
      <button type="button" data-sp="res">Results</button>`;
    specEl.querySelector('b')!.textContent = `${specIdx + 1}. ${cur.name}`;
  }
  function specStep(d: number) { const n = specTargets().length; if (!n) return; specIdx = (specIdx + d + n) % n; specName = ''; specRetarget(); }
  specEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-sp]') as HTMLElement | null;
    if (!b || state !== 'spectate') return;
    if (b.dataset.sp === 'res') finishRace(); else specStep(Number(b.dataset.sp));
  });
  function specCamera(frame: number) {
    const cur = specTargets().find((x) => x.name === specName);
    if (!cur) { specRetarget(); return; }
    specPos.copy(cur.root.position);
    if (cur.ground) specPos.y += 0.5;           // AI roots sit on the road, players' at the body centre
    specQuat.copy(cur.root.quaternion);
    const v = frame > 0 ? specPrev.distanceTo(cur.root.position) / frame : 0;
    specPrev.copy(cur.root.position);
    specOut[OUT.speed] = cur.ground ? cur.speed() : v;
    rig.update(frame, specPos, specQuat, stepAcc.set(0, 0, 0), specOut);
    // esports broadcast pill (~10 Hz): watched car's speed, lateral G, and our steward penalties
    const now = performance.now();
    if (now - specTelAt > 100) {
      const dtT = (now - specTelAt) / 1000;
      specTelAt = now;
      const spd = Math.abs(specOut[OUT.speed]);
      const yaw = specYawVec.set(0, 0, 1).applyQuaternion(specQuat);
      const yawA = Math.atan2(yaw.x, yaw.z);
      let dYaw = yawA - specTelYaw; dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
      specTelYaw = yawA;
      const latG = dtT > 0 && dtT < 1 ? Math.abs(spd * dYaw / dtT) / 9.81 : 0;
      let tel = specEl.querySelector('.sp-tel') as HTMLElement | null;
      if (!tel) { tel = document.createElement('span'); tel.className = 'sp-tel'; specEl.insertBefore(tel, specEl.querySelector('button')); }
      tel.textContent = `${Math.round(spd * 3.6)} km/h · ${latG.toFixed(2)} G${penalties.seconds > 0 ? ` · YOU +${penalties.seconds.toFixed(1)}s` : ''}`;
    }
  }
  let specTelAt = 0, specTelYaw = 0;
  const specYawVec = new THREE.Vector3();

  /** HUD running order: gap to the car in front, in seconds at the current speed (distance-based) or metres. */
  let boardAt = 0, progAt = 0;
  function updateBoard(now: number) {
    if (now - boardAt < 250) return;
    boardAt = now;
    if (raceLaps() === 0) { hud.board(null); return; }
    const ranked = rank(standings());
    if (ranked.length < 2) { hud.board(null); return; }
    hud.board(ranked.map((s, i) => {
      if (i === 0) return { name: s.name, gap: s.fin >= 0 ? 'FIN' : 'LEADER', you: s.you };
      const a = ranked[i - 1];
      const gap = s.dnf ? 'DNF' : s.fin >= 0 ? (a.fin >= 0 ? `+${(s.fin - a.fin).toFixed(1)}s` : 'FIN') : `+${Math.max(0, Math.round(a.d - s.d))} m`;
      return { name: s.name, gap, you: s.you };
    }));
  }
  document.getElementById('hud-garage')?.addEventListener('click', () => { if (driving()) quitSession(party ? 'lobby' : 'title'); });
  const togglePause = () => {
    if (state === 'spectate') { finishRace(); return; }
    if (state === 'race') { pausedFrom = state; setState('paused'); audio.muted = true; menu.show('pause'); }
    else if (state === 'paused') resume();
  };
  document.getElementById('hud-pause')?.addEventListener('click', togglePause);
  input.onPause = togglePause;   // Start / Options / Menu on a pad, the mapped button on a wheel
  document.getElementById('hud-reset')?.addEventListener('click', () => input.onReset());
  document.getElementById('hud-cam')?.addEventListener('click', () => { if (driving()) rig.toggle(); });

  /** A different car or tuning replaces the physics body (and, via showCar, the model). */
  const rebuildPlayer = () => {
    builtKey = carKey();
    pw.world.removeRigidBody(car.body);
    const cj = coreJson();
    core = new CoreCar(cj);
    core.setTurboStage(turboStageOf());
    physWorker?.swapCar(cj);
    car = new CarBody(pw, core, shape, visual.cg);
    car.usePatchRays = !(isTouch || potato);
    rig.setTarget(car.body, core.info.redline);
    drivingLine.setCar(applyMods(physics[sel.car], modsOf(sel)));
  };

  /** The garage car's own model (if its catalog entry has one): swapped in, physics + damage rebuilt. Serialised. */
  let visualQueue: Promise<void> = Promise.resolve();
  let carSwapped = false;
  const showCar = () => (visualQueue = visualQueue.then(async () => {
    const path = visualPathOf(sel.car);
    const needModel = path !== visualPath;
    if (needModel) {
      const cfg = path === DEFAULT_VISUAL ? defaultCfg : await fetchVisualCfg(path);
      const next = await CarVisual.load(cfg, visual.headlights);
      probe?.attach(next.model, probeIntensity);
      const wasInGarage = inGarage;
      setGarage(false, false);
      scene.remove(visual.root);
      damage.dispose();
      visualPath = path; visualCfg = cfg; visual = next; shape = shapeOf(cfg);
      syncForzaWheelRadii();
      fitAuthored(next, path);
      visual.setPlate(sel.name);
      drawEarly(visual.model);
      carSwapped = true;
      visual.renderDt = capInterval ? capInterval / 1000 : 1 / 60;
      syncHeadlights();
      scene.add(visual.root);
      carMeet.attachToCar(visual.root);
      damage = new DamageVisuals(visual, visualCfg, pw, scene);
      wireDamage();
      headShadows = visual.headlights.filter((s) => s.castShadow).map((s) => s.shadow);
      for (const sh of headShadows) sh.autoUpdate = false;
      visual.update(pos, quat, car.out);
      setGarage(wasInGarage);
    }
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    applyLook();
    if (needModel || carKey() !== builtKey) {
      rebuildPlayer();
      spawn();
      settledShowroom = 0;
      syncPose();
      post.carPos.copy(pos);
      if (!inGarage) probe?.captureAll(pos, visual.root);
    }
    Object.assign(g.__game, { visual, damage });   // `car` / `core` are live getters on __game
  }).catch((e) => console.error('car swap failed', e)));

  /** Seamless in-place city transition: swaps streamed tiles, colliders, routes, landmarks, zones & reflections with ZERO page reload and NEVER drops Fullscreen! */
  let citySwitching = false;
  async function switchCity(nextId: string) {
    if (citySwitching || !useNyc) return;
    const nextCity = CITIES.find((c) => c.id === nextId);
    if (!nextCity || nextCity.id === cityInfo.id) return;
    citySwitching = true;
    const wasInGarage = inGarage;
    try {
      await loader.show(`Switching to ${nextCity.name}…`, `${nextCity.name.toUpperCase()} · ${nextCity.district.toUpperCase()}`, 8);
      saveCity(nextCity.id);
      try {
        const u = new URL(location.href);
        u.searchParams.delete('city');
        history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch { /* ignore history errors */ }

      // Tear down old city cleanly so VRAM & Rapier colliders never leak
      cops.breakOff();
      wagers.cancel();
      waypointBeacon.visible = false;
      obstacles?.dispose();
      obstacles = null;
      nyc?.dispose();
      nyc = null;
      streetProps = null;
      zones.dispose();
      raceNodes.dispose();
      minimap.clear();

      cityInfo = nextCity;
      setGroundGrid(cityInfo.grid);
      setGroundCity(cityInfo.id);
      setSignCity(cityInfo.id);
      setTreeCity(cityInfo.id);
      updateCreditsLine();
      minimap.setLandmarks(cityInfo.landmarks);

      loader.text(`Loading ${cityInfo.name} street network…`, 22);
      const [newRoute, newMap] = await Promise.all([
        fetch(cityInfo.route).then((r) => r.json()),
        fetch(cityInfo.base + 'map.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      route = newRoute;
      routeJson = JSON.stringify(route);
      minimap.setRoute(route.samples, route.closed !== false);
      if (newMap) minimap.addGraph(newMap);

      loader.text(`Streaming ${cityInfo.name} 1:1 tiles…`, 32);
      const nextStreamer = new NycStreamer(scene, renderer, pw, camera, {
        base: cityInfo.base,
        surfaces: core.info.surfaces,
        debug: params.get('nycdebug') === '1',
        fogDensity: num('fog', potato ? 0.0045 : 0.0024),
        farLoad: num('far', potato ? 420 : isTouch ? 560 : 1000),
        farKeep: num('farkeep', potato ? 500 : isTouch ? 660 : 1150),
        ...(potato ? { nearLoad: num('near', 300), nearKeep: num('nearkeep', 380), treeDensity: num('trees', 0.4) } : {}),
        onProgress: (f) => loader.text(`Streaming ${cityInfo.name}… ${Math.round(f * 100)}%`, 32 + f * 48),
      });
      nyc = nextStreamer;
      await nextStreamer.ready();
      if (!webgpu) nextStreamer.streetProps?.limitLights(num('lights', 12));   // WebGL 2: see the first city load
      streetProps = nextStreamer.streetProps;
      obstacles = streetProps && params.get('solidprops') !== '0' ? new StreetObstacles(pw, streetProps) : null;
      wireCityImpactCallbacks();
      post.onPreset?.(post.preset);

      nycS0 = nextStreamer.spawnPoint();
      s0 = nycS0 ?? route.samples[0];
      startYaw = Math.atan2(Math.cos(s0.heading), -Math.sin(s0.heading));
      grid = { ds: 0, lat: 0 };

      // Rebind AI, cops, driving line, zones & race nodes to the new city's roads
      loader.text('Syncing traffic, zones & reflections…', 84);
      ai.setRoute(route.samples, route.closed !== false);
      cops.setLane(new Lane(route.samples, route.closed !== false));
      drivingLine.setCar(applyMods(physics[sel.car], modsOf(sel)));
      zones = new CityZones(scene, cityInfo.id, route.samples, {
        onScore: (z, score, stars, isPB, xp) => {
          if (xp > 0) sp.earn(xp, `${z.kind === 'speed' ? 'speed trap' : 'drift zone'} · ${z.name}`);
          if (z.kind === 'speed' && score >= 180) completeDaily('speed_trap', 1);
          if (z.kind === 'drift' && score >= 3500) completeDaily('drift_pts', 1);
          const unit = z.kind === 'speed' ? 'km/h' : 'PTS';
          const st = '★'.repeat(stars) + '☆'.repeat(3 - stars);
          hud.toast(
            `${z.kind === 'speed' ? '⚡' : '🔥'} ${z.name}${isPB ? ' · NEW PB!' : ''}`,
            `${score.toLocaleString()} ${unit} · ${st}${xp > 0 ? ` · +${xp} XP` : ''}`,
          );
        },
        sendNet: (msg) => party?.sendZoneScore(msg),
      });
      zones.setVisible(false);
      raceNodes = new RaceNodes(scene, cityInfo.id, route.samples, cityInfo.mandatoryCops, {
        onLaunchRace: (node) => {
          sel.laps = node.laps;
          sel.copMode = node.copMode;
          saveSelection(sel);
          void startSession('race');
        },
      });
      raceNodes.setVisible(false);

      // Index new road colliders and place the car cleanly on the new city's spawn
      pw.world.step();
      resetCar();

      // Compile every new-city pipeline with the warm-up triangles, then REMOVE them. They copy the raw quantized tile
      // vertex layout without the glTF node transform, so left in the scene they draw as a giant stray wall across the
      // spawn road (the "random wall in the middle of the road" after switching cities).
      await compileFor(scene, post.sceneTarget).catch(() => { /* compiles on first sight instead */ });
      nextStreamer.endWarm();

      // Re-capture city environment reflection map without leaving fullscreen
      if (!potato) {
        const oldEnv = scene.environment;
        const envPos = new THREE.Vector3(s0.x, s0.z + 2, -s0.y);
        kitSky?.wrapSky(scene);
        const cap = () => pmrem.fromScene(scene, 0.02, 0.5, 400, { size: 256, position: envPos }).texture;
        scene.environment = kitSky ? kitSky.during(cap) : cap();
        oldEnv?.dispose();
      }
      probe?.invalidate();
      if (!wasInGarage) probe?.captureAll(pos, visual.root);

      Object.assign(g.__game, { nyc, streetProps, obstacles, zones, raceNodes, routeSamples: route.samples });
      party?.updateMe(meForParty());
      menu.render();
      loader.text(`Welcome to ${cityInfo.name}!`, 96);
      citySwitching = false;
      await steadyFrames(3, 68, 2200);
      loader.text('Ready!', 100);
      loader.hide();
      hud.toast(`🌍 ${cityInfo.name.toUpperCase()}`, `${cityInfo.district} · 1:1 Open World`);
    } catch (e) {
      console.error('Seamless city switch failed', e);
      citySwitching = false;
      loader.hide();
      hud.toast('CITY SWITCH FAILED', e instanceof Error ? e.message : String(e));
    }
  }

  // ---- 2-Player Local Split-Screen (Laptop + Smart TV with 2 Controllers / 1 Controller + Keyboard / Shared Keyboard) ----
  const splitHud = new SplitHud();
  const p2Input = new Player2Input();
  const isKeyDownP1 = (c: string) => input.isKeyDown(c);   // P2 reads the shared keyboard through P1's key state
  let splitActive = false;
  let splitLayout: SplitLayout = 'horizontal';
  let splitP2CarId = catalog[1]?.id ?? catalog[0].id;
  let p2Core: CoreCar | null = null;
  let p2Car: CarBody | null = null;
  let p2Visual: CarVisual | null = null;
  let p2Cam: THREE.PerspectiveCamera | null = null;
  let p2Rig: CameraRig | null = null;
  let p2RaceCar = -1;
  let p2Lap: LapInfo | null = null;
  let p2SourceLabel = 'Arrows';
  let p2NosSec = 6.0;
  const p2Pos = new THREE.Vector3(), p2Quat = new THREE.Quaternion();
  const p2PrevPos = new THREE.Vector3(), p2PrevQuat = new THREE.Quaternion();
  const p2PhysPos = new THREE.Vector3(), p2PhysQuat = new THREE.Quaternion();
  const p2LastVel = new THREE.Vector3(), p2Acc = new THREE.Vector3(), p2StepAcc = new THREE.Vector3();

  const readP2Body = (p: THREE.Vector3, q: THREE.Quaternion) => {
    if (!p2Car) return;
    const t = p2Car.body.translation(), r = p2Car.body.rotation();
    p.set(t.x, t.y, t.z);
    q.set(r.x, r.y, r.z, r.w);
  };

  const placeP2OnRoad = (dsOffset = 0, latOffset = 3.6) => {
    if (!p2Car || !p2Core) return;
    const p = new THREE.Vector3(s0.x, s0.z + 3, -s0.y);
    p.x += Math.sin(startYaw) * (grid.ds + dsOffset) - Math.cos(startYaw) * (grid.lat + latOffset);
    p.z += Math.cos(startYaw) * (grid.ds + dsOffset) + Math.sin(startYaw) * (grid.lat + latOffset);
    const hit = pw.raycast(p, p.clone().add(new THREE.Vector3(0, -20, 0)));
    if (hit) p.y -= hit.toi;
    p.y += p2Core.info.cgHeight + 0.02;
    p2Car.place(p, startYaw);
    p2Car.settle();
    readP2Body(p2PhysPos, p2PhysQuat);
    p2PrevPos.copy(p2PhysPos); p2PrevQuat.copy(p2PhysQuat);
    p2Pos.copy(p2PhysPos); p2Quat.copy(p2PhysQuat);
    p2LastVel.set(0, 0, 0); p2Acc.set(0, 0, 0);
    p2Rig?.snap();
  };

  const teardownSplitScreen = () => {
    splitActive = false;
    input.splitScreen = false;
    splitHud.hide();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
    if (p2Visual) { scene.remove(p2Visual.root); p2Visual = null; }
    if (p2Car) {
      try { pw.world.removeRigidBody(p2Car.body); } catch { /* already removed */ }
      p2Car = null;
    }
    p2Core = null;
    p2Cam = null;
    p2Rig = null;
    p2RaceCar = -1;
    p2Lap = null;
  };

  const setupSplitP2 = async (carId: string) => {
    // Clean any previous P2 vehicle before spawning fresh
    if (p2Visual) { scene.remove(p2Visual.root); p2Visual = null; }
    if (p2Car) { try { pw.world.removeRigidBody(p2Car.body); } catch { /* ignore */ } p2Car = null; }
    p2Core = null;

    const cat = catalog.find((c) => c.id === carId) ?? catalog[1] ?? catalog[0];
    splitP2CarId = cat.id;
    const visPath = cat.visual ?? DEFAULT_VISUAL;
    const cfg = visPath === DEFAULT_VISUAL ? defaultCfg : await fetchVisualCfg(visPath);
    p2Core = new CoreCar(JSON.stringify(physics[cat.id] ?? physics[catalog[0].id]));
    p2Visual = await CarVisual.load(cfg);
    // Give P2 a vibrant contrasting paint coat so both players pop immediately on a Smart TV
    const p2Color = cat.id === sel.car ? '#00d8ff' : (cat.paint || '#00d8ff');
    p2Visual.setPaint(p2Color, 'metallic');
    p2Visual.dim = 1;
    p2Visual.applyHeadlights();
    scene.add(p2Visual.root);

    const p2Shape = shapeOf(cfg);
    p2Car = new CarBody(pw, p2Core, p2Shape, p2Visual.cg);
    p2Car.usePatchRays = false; // keep 2P TV frame times smooth
    p2Cam = new THREE.PerspectiveCamera(62, innerWidth / Math.max(1, innerHeight), 0.1, potato ? 560 : 1200);
    p2Cam.layers.enable(DEBRIS_LAYER);
    p2Cam.layers.enable(PROP_DETAIL_LAYER);
    p2Rig = new CameraRig(p2Cam, pw, p2Car.body, p2Core.info.redline);
    p2NosSec = 6.0;
    placeP2OnRoad(0, 3.6);
    p2Visual.update(p2Pos, p2Quat, p2Car.out);
    p2Rig.update(1, p2Pos, p2Quat, new THREE.Vector3(), p2Car.out);
  };

  async function startSplitScreen(mode: 'race' | 'free', layout: SplitLayout, carId: string) {
    splitLayout = layout;
    splitP2CarId = carId || (catalog[1]?.id ?? catalog[0].id);
    splitActive = true;
    input.splitScreen = true;
    await startSession(mode);
  }

  addEventListener('gamepadconnected', () => {
    const n = connectedGamepads().length;
    hud.toast(`🎮 CONTROLLER ${n} CONNECTED`, n >= 2 ? '2-Player Split-Screen ready for TV couch play!' : 'Controller ready · plug in a 2nd pad for 2P TV');
    if (menu.screen === 'modes' || menu.screen === 'lobby') menu.render();
  });
  addEventListener('gamepaddisconnected', () => {
    const n = connectedGamepads().length;
    hud.toast('🎮 CONTROLLER DISCONNECTED', `${n} controller${n === 1 ? '' : 's'} active`);
    if (menu.screen === 'modes' || menu.screen === 'lobby') menu.render();
  });

  /**
   * Load a session: race (you + AI rivals on a grid), free roam (just you) or a party session
   * (online: the party's rules, other players' cars). A party session waits for the leader's GO
   * unless we rejoin one already driving.
   */
  let rivalsCompiled = false;
  async function startSession(mode: Mode, rejoin = false) {
    if (loadingSession || citySwitching) return;
    loadingSession = true;
    if (mode === 'online' && splitActive) teardownSplitScreen();
    sel.mode = mode;
    setState('busy');
    const modeTitle = splitActive
      ? (mode === 'race' ? `2P SPLIT-SCREEN RACE · ${sel.laps} LAPS` : '2P SPLIT-SCREEN FREE ROAM')
      : mode === 'online' ? 'MULTIPLAYER SESSION' : mode === 'race' ? `RACE · ${sel.laps} LAPS` : sp.testingMode ? 'TESTING FREE ROAM' : 'FREE ROAM';
    await loader.show(mode === 'online' ? 'Syncing party session…' : `Preparing ${cityInfo.name}…`, `${cityInfo.name.toUpperCase()} · ${modeTitle}`, 22);
    menu.show('none');
    if (mode === 'online' && cloud.available) {
      // online: drive only what the online account owns (the race room checks it), from a fresh profile
      await mp.refresh();
      mp.fit(sel);
    }
    loader.text('Staging vehicle & physics…', 48);
    await showCar();
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    if (carKey() !== builtKey) rebuildPlayer();
    // grid: single-player race = P4 of 6 between the rivals; Free Roam = live cruising AI traffic + Speed Traps / Drift Zones (NO COPS);
    // online race = party grid slots (8-12 max).
    const isFreeSession = mode === 'free' || (mode === 'online' && party?.mode === 'free');
    { const w = params.get('weather'); if (w === 'dry' || w === 'rain') worldClock.setWeather(w); else worldClock.rollWeather(!isFreeSession); }
    kitSky?.setWeather(worldClock.weather);
    zones.setVisible(isFreeSession);
    raceNodes.setVisible(isFreeSession);
    crashCineT = 0;
    garageWalk.active = false; menu.garageWalkActive = false;
    telemetry.reset(sel.name, catalog.find((c) => c.id === sel.car)?.name ?? sel.car, cityInfo.name);
    replay.clear();
    if (mode === 'race' && ai.cars.length) {
      grid = { ds: 0, lat: 0 };
      grid = { ds: 0, lat: ai.setGrid(new THREE.Vector3(s0.x, s0.z, -s0.y)) };
      ai.setMode('race');
      if (potato && !rivalsCompiled) {
        // potato skipped the rivals at boot: build their pipelines now, behind "Getting ready…", not as a freeze on the grid
        rivalsCompiled = true;
        ai.update(1, camera);
        const culled: THREE.Object3D[] = [];
        scene.traverse((o) => { if (o.frustumCulled && (o as THREE.Mesh).isMesh) { o.frustumCulled = false; culled.push(o); } });
        await compileFor(scene, post.sceneTarget).catch(() => { /* they compile on first sight instead */ });
        for (const o of culled) o.frustumCulled = true;
      }
    } else if (isFreeSession) {
      // Free Roam social sandbox: cruising AI street traffic (no police!)
      ai.setMode(ai.cars.length ? 'cruise' : 'off');
      const slot = party ? Math.max(0, party.members.findIndex((m) => m.id === party!.selfId)) : 0;
      grid = mode === 'online' ? { ds: -8 * (slot >> 1), lat: slot % 2 ? 2.2 : -2.2 } : { ds: 0, lat: 0 };
    } else {
      ai.setMode('off');
      const slot = party ? Math.max(0, party.members.findIndex((m) => m.id === party!.selfId)) : 0;
      grid = mode === 'online' ? { ds: -8 * (slot >> 1), lat: slot % 2 ? 2.2 : -2.2 } : { ds: 0, lat: 0 };
    }
    // ranked rooms time the New York route only (cloud/): races in the other cities are unranked for now
    if (mode === 'online' && party?.mode === 'race' && !rejoin && cloud.available && cityInfo.id === 'nyc') {
      // ranked: the online race room times this race and pays the online career (it decides whether it counts)
      ranked?.close();
      if (mp.ready) {
        const a = assistSet;
        ranked = new RankedLink(cloud, party.code, { car: sel.car, mods: { ...modsOf(sel) }, host: party.isHost, manual: a.gearbox === 'manual',
          assistsOff: +(a.abs === 'off') + +(a.tc === 0) + +!a.stability + +(a.countersteer === 'off') + +(a.line === 'off') });
        menu.ranked(null);
        ranked.onResult = (r) => {
          if (r.profile && r.you) mp.paid({ xp: r.you.xp, cr: r.you.cr, reason: r.ranked ? `ranked race · P${r.you.pos}` : 'unranked race', parts: r.you.parts }, r.profile);
          menu.ranked(r);
        };
      }
    }
    if (mode === 'online') {
      remote?.clear();
      remote = new RemoteCars(scene, visual, pw, shape);
      if (party) { remote.names = new Map(party.members.map((m) => [m.id, m.name])); remote.looks = new Map(party.members.map((m) => [m.id, { skin: m.skin, look: m.look }])); }
      remote.warmup(true);           // remote car shaders compiled now, not as a hitch when someone joins
      await warm();
      remote.warmup(false);
    } else await sleep(60);          // brief settle for any fullscreen transition
    if (splitActive) {
      loader.text('Staging Player 2 vehicle…', 66);
      await setupSplitP2(splitP2CarId);
      hud.hide();
      splitHud.show(splitLayout);
    } else {
      hud.lapTotal = raceLaps();
      hud.show();
    }
    if (wantsTouch()) enableTouch();
    audio.unlock();
    loadingSession = false;
    if (mode === 'online' && !rejoin) {
      if (!party) { quitSession('lobby'); return; }
      resetCar();
      loader.text('Waiting for the other drivers…', 82);
      party.ready();
      if (partyGo || party.phase === 'driving') { partyGo = false; await beginRace(); }
      return;
    }
    await beginRace();
  }

  /** Respawn and start: 3-2-1 in a race, straight into the car otherwise. */
  async function beginRace() {
    resetCar();
    if (splitActive && p2Car && p2Visual && p2Rig) {
      placeP2OnRoad(0, 3.6);
      p2RaceCar = race.addCar(p2Car.body.translation());
      p2Lap = null;
      p2Visual.update(p2Pos, p2Quat, p2Car.out);
      p2Rig.update(1, p2Pos, p2Quat, new THREE.Vector3(), p2Car.out);
    }
    setGarage(false);
    visual.dim = 1;
    visual.applyHeadlights();
    readBody(physPos, physQuat);
    prevPos.copy(physPos);
    prevQuat.copy(physQuat);
    pos.copy(physPos);
    quat.copy(physQuat);
    if (physWorker) {
      physWorker.resetPose(physPos, physQuat, car.body.linvel(), car.body.angvel(), 0, 2, false, car.sampleGroundPlanes());
    }
    visual.update(pos, quat, car.out);
    rig.snap();
    rig.update(1, pos, quat, new THREE.Vector3(), car.out);
    cityLights.update(1, camera);
    city.update(camera, true);
    // (a swapped car's shaders were compiled by the garage frames; anything left compiles behind the loading screen)
    carSwapped = false;
    for (const sh of headShadows) sh.needsUpdate = true;
    post.render();
    loader.hold = loader.shown;      // a session load: the loading screen stays until the race view renders steadily
    menu.show('none');
    hud.resetFps();
    input.poll();                    // drop key edges pressed in the menus
    audio.muted = false;
    remote?.kick();
    prev = performance.now(); acc = 0; lastRenderAt = 0;
    setState('countdown');           // parked on the grid (no input) while the view warms up
    if (loader.hold) {
      loader.text('Streaming street ahead…', 90);
      await steadyFrames(4, 68, 3500);   // tiles around the start stream in, shaders compile: behind the screen
      loader.text('Ready!', 100);
      loader.hold = false;
      loader.hide();
      await sleep(220);
      if (state !== 'countdown') return;
    }
    if (raceLaps() === 0) { ai.go(); setState('race'); setExtra(); return; }
    for (const t of ['3', '2', '1']) { menu.countdown(t); await sleep(900); if (state !== 'countdown') { menu.countdown(''); return; } }
    menu.countdown('GO');
    if (launchArmed) launchUntil = ticks * DT + 1.1;   // throttle held on the grid: clamp the launch
    launchArmed = false;
    setState('race');
    if (ranked && party?.isHost) ranked.start(raceLaps(), useNyc ? 'nyc' : 'city', realism());   // the room's clock starts
    raceT0 = ticks * DT;
    ai.go();
    setTimeout(() => menu.countdown(''), 700);
  }

  function resume() {
    setState(pausedFrom);
    menu.show('none');
    input.syncPads();
    audio.muted = false;
    prev = performance.now();
  }

  /** End the session: back to the title, the game modes, or (party) the lobby. */
  function quitSession(to: 'title' | 'modes' | 'lobby') {
    loader.hold = false;
    loader.hide();
    if (freeRoamM > 50 && sel.mode === 'free') sp.earn(freeRoamM / 1000 * FREE_ROAM_XP_PER_KM, `free roam · ${(freeRoamM / 1000).toFixed(1)} km`);
    freeRoamM = 0;
    ranked?.close(); ranked = null;
    if (remote) party?.sendGone();
    remote?.clear(); remote = null;
    if (splitActive) teardownSplitScreen();
    hideSpectate();
    rig.setTarget(car.body, core.info.redline);
    hud.hide();
    hud.board(null);
    if (minimap.expanded) minimap.toggleExpand(false);
    cops.breakOff();
    wagers.cancel();
    zones.setVisible(false);
    raceNodes.setVisible(false);
    raceNodes.cancelMatchmaking();
    if (photoMode.active) photoMode.exit();
    if (replay.active) replay.exit();
    if (carMeet.panelOpen) carMeet.togglePanel(false);
    if (lastWagerHtml) { wagerHudEl.innerHTML = lastWagerHtml = ''; }
    if (lastZoneHtml) { zoneHudEl.innerHTML = lastZoneHtml = ''; }
    if (lastBoardHtml) { zoneBoardEl.innerHTML = lastBoardHtml = ''; }
    menu.countdown('');
    audio.muted = true;
    ai.setMode('off');
    grid = { ds: 0, lat: 0 };
    resetCar();
    setState(to);
    menu.show(to);
    visual.setPaint(paintOf(sel, catalog), sel.finish);
    setExtra();
  }

  function finishRace() {
    const copsOn = copsActiveInRace();
    cops.breakOff();
    if (copsOn) {
      bumpHeat(1);   // Heat lives strictly in Cop Race Events (never Free Roam)
      completeDaily('cop_race', 1);
      ret.reputation += 120 + heat.level * 40;
      saveRetention(ret);
    }
    // Persistent Multiplayer / Race Damage + Tow Truck Fee + In-Game Insurance (-50% repairs & tow)
    const finalDmg = core.damage();
    const totaled = !!finalDmg.totaled || myDnf === 'wrecked';
    const sev = Math.min(1, Math.max(finalDmg.severity ?? 0, totaled ? 1 : 0));
    const insured = maint.insured;
    let towFeeXp = 0;
    let repairBillXp = 0;
    let damagePct = 0;
    if (raceLaps() > 0) {
      if (insured && sp.kind === 'sp') sp.penalty(INSURANCE_PREMIUM_XP);
      if (sev > 0.04 || totaled) {
        recordRaceDamage(maint, sel.car, sev, totaled);
        const rep = repairCostOf(conditionOf(maint, sel.car), insured);
        repairBillXp = rep.xp;
        damagePct = rep.pct;
      }
      if (totaled) {
        towFeeXp = towFeeOf(true, insured).xp;
      }
    }
    setState('results');
    audio.muted = true;
    if (raceLaps() > 0 && !myDnf) audio.triggerFinishSwell();
    const penaltySec = raceLaps() > 0 ? penalties.seconds : 0;
    const total = lapTimes.reduce((a, b) => a + b, 0) + penaltySec;
    hideSpectate();
    rig.setTarget(car.body, core.info.redline);
    const st = standings();
    let earned = 0;
    if (!racePaid && sel.mode !== 'online') {
      // single player: XP only (online races are paid by the server's race room)
      racePaid = true;
      const order = rank(st), pos = order.findIndex((x) => x.you) + 1;
      const a = assistSet;
      const reward = raceReward({ pos, laps: raceLaps(), dnf: !!myDnf, gained: ai.cars.length ? Math.max(0, 4 - pos) : 0, clean: raceImpacts === 0,
        assistsOff: +(a.abs === 'off') + +(a.tc === 0) + +!a.stability + +(a.countersteer === 'off') + +(a.line === 'off'),
        manual: a.gearbox === 'manual', realism: sel.realism,
        copsEnabled: copsOn, heatLevel: heat.level, escapedCops: escapedCopsThisRace }, 'sp');
      const partyMul = party && party.members.length > 1 ? PARTY_BONUS_MUL : 1;
      const grossXp = Math.round(reward.xp * partyMul);
      const netXp = Math.max(0, grossXp - towFeeXp);
      if (towFeeXp > grossXp) sp.penalty(towFeeXp - grossXp);
      earned = sp.earn(netXp, myDnf ? 'race · DNF' : `race · P${pos} of ${order.length}${copsOn ? ` · COPS H${Math.max(1, heat.level)}` : ''}${partyMul > 1 ? ' · PARTY +25%' : ''}`, reward.parts).xp;
    } else if (towFeeXp > 0 && sp.kind === 'sp') {
      sp.penalty(towFeeXp);
    }
    // Driving Academy: a finished lesson is marked done once and pays its XP
    if (activeAcademyId && !myDnf && lap?.finished) {
      const lesson = ACADEMY_LESSONS.find((l) => l.id === activeAcademyId);
      if (lesson && !menu.completedLessons.includes(lesson.id)) {
        menu.completedLessons = markLessonDone(lesson.id);
        if (sel.mode !== 'online') earned += sp.earn(lesson.xpReward, `academy · ${lesson.title}`).xp;
        hud.toast(`🎓 LESSON 0${lesson.num} COMPLETE`, `+${lesson.xpReward} XP`);
      }
    }
    activeAcademyId = '';
    menu.showResults({ total, best: lapTimes.length ? Math.min(...lapTimes) : 0, laps: lapTimes, laps_target: raceLaps(), standings: st,
      routeLength: lap?.routeLength ?? route.length_m, online: sel.mode === 'online', earned, towFeeXp, repairBillXp, insured, damagePct, penaltySec });
    if (party) party.sendProgress({ d: lap?.distance ?? 0, lap: lap?.laps ?? 0, fin: lap?.finished ? total : -1, best: lap?.best ?? 0, dnf: myDnf ? 1 : 0 });
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && (e.target as HTMLElement).tagName !== 'INPUT') {
      // In Free Roam, [F] flashes headlights for Spontaneous Wagers; elsewhere [F] toggles fullscreen.
      if (!(driving() && raceLaps() === 0)) {
        if (isFullscreen()) exitFullscreenSafe();
        else reqFullscreen();
      }
      return;
    }
    if (state === 'spectate' && !e.repeat) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyA') specStep(-1);
      else if (e.code === 'ArrowRight' || e.code === 'KeyD') specStep(1);
      else if (e.code === 'Escape') finishRace();
      return;
    }
    if (e.code === 'KeyH' && !e.repeat && photoMode.active) { photoMode.toggleUi(); return; }
    if (e.code !== 'Escape' || e.repeat) return;
    if (photoMode.active) { photoMode.exit(); return; }
    if (replay.active) { replay.exit(); return; }
    if (raceNodes.matchmaking) { raceNodes.cancelMatchmaking(); return; }
    if (carMeet.panelOpen) { carMeet.togglePanel(false); return; }
    if (state === 'race') { pausedFrom = state; setState('paused'); audio.muted = true; menu.telemetrySamples = telemetry.sampleCount; menu.show('pause'); }
    else if (state === 'paused') resume();
  });

  // Showroom camera: slow turntable around the parked car, drag to turn, wheel to zoom.
  const orbit = { az: 2.3, el: 0.17, dist: 7, drag: false, x: 0, y: 0, shift: 0, holdUntil: 0 };
  (g.__game as { orbit?: typeof orbit; nyc?: typeof nyc }).orbit = orbit;
  (g.__game as { orbit?: typeof orbit; nyc?: typeof nyc }).nyc = nyc;
  const dom = renderer.domElement;
  // Interactive AAA free-look camera while driving (mouse OR touch drag on open canvas, wheel zoom, double-tap/right-click recenter)
  const driveLook = { active: false, pid: -1, x: 0, y: 0, downX: 0, downY: 0, lastTapAt: 0 };
  dom.addEventListener('contextmenu', (e) => {
    if (driving() && !photoMode.active && !replay.active) { e.preventDefault(); rig.resetFreeLook(); }
  });
  dom.addEventListener('pointerdown', (e) => {
    partDownX = e.clientX; partDownY = e.clientY;
    if (driving()) {
      if (photoMode.active || replay.active) return;
      if (e.button === 2) { rig.resetFreeLook(); return; }
      driveLook.active = true; driveLook.pid = e.pointerId;
      driveLook.x = driveLook.downX = e.clientX;
      driveLook.y = driveLook.downY = e.clientY;
      rig.beginFreeLook();
      try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      return;
    }
    orbit.drag = true; orbit.x = e.clientX; orbit.y = e.clientY;
    try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  });
  dom.addEventListener('pointermove', (e) => {
    if (driveLook.active && e.pointerId === driveLook.pid) {
      rig.dragFreeLook(e.clientX - driveLook.x, e.clientY - driveLook.y);
      driveLook.x = e.clientX; driveLook.y = e.clientY;
      return;
    }
    if (!orbit.drag) return;
    orbit.az -= (e.clientX - orbit.x) * 0.008;
    orbit.el = Math.min(0.7, Math.max(0.03, orbit.el + (e.clientY - orbit.y) * 0.004));
    orbit.x = e.clientX; orbit.y = e.clientY;
  });
  const endDrag = (e?: PointerEvent) => {
    if (driveLook.active && (!e || e.pointerId === driveLook.pid)) {
      const moved = e ? Math.hypot(e.clientX - driveLook.downX, e.clientY - driveLook.downY) : 99;
      driveLook.active = false; driveLook.pid = -1;
      rig.endFreeLook();
      if (moved < 8) {
        const now = performance.now();
        if (now - driveLook.lastTapAt < 300) { rig.resetFreeLook(); driveLook.lastTapAt = 0; }
        else driveLook.lastTapAt = now;
      }
    }
    orbit.drag = false;
  };
  // Garage: a click (not a drag) on a part of the 3D car opens the matching customization tab
  let partDownX = 0, partDownY = 0;
  const partRay = new THREE.Raycaster(), partNdc = new THREE.Vector2();
  const partTab = (name: string) =>
    /wheel|rim|tire|tyre|caliper|disc/i.test(name) ? 'wheels'
      : /headlight|tail|lamp|light/i.test(name) ? 'lights'
        : /glass|window|windshield|exhaust/i.test(name) ? 'glass'
          : /wing|spoiler|diffuser|splitter|skirt/i.test(name) ? 'aero'
            : /fender/i.test(name) ? 'fenders'
              : /hood|bumper/i.test(name) ? 'body'
                : /driver|helmet/i.test(name) ? 'driver' : 'paint';
  dom.addEventListener('pointerup', (e) => {
    if (state !== 'garage' || !inGarage || menu.screen !== 'garage' || Math.hypot(e.clientX - partDownX, e.clientY - partDownY) >= 6) return;
    const r = dom.getBoundingClientRect();
    partNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    partRay.setFromCamera(partNdc, camera);
    const hit = partRay.intersectObject(visual.model, true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
    if (!hit) return;
    const m = (hit.object as THREE.Mesh).material;
    const matName = Array.isArray(m) ? m.map((x) => x.name).join(' ') : m?.name ?? '';
    let names = `${hit.object.name} ${matName}`;
    for (let p = hit.object.parent; p && p !== visual.model; p = p.parent) names += ` ${p.name}`;
    menu.openGarageTab(partTab(names));
  });
  dom.addEventListener('pointerup', (e) => endDrag(e));
  dom.addEventListener('pointercancel', (e) => endDrag(e));
  dom.addEventListener('wheel', (e) => {
    if (driving()) {
      if (!photoMode.active && !replay.active) rig.zoomFreeLook(e.deltaY);
      return;
    }
    orbit.dist = Math.min(inGarage ? 7.6 : 11, Math.max(inGarage ? 3.6 : 4.5, orbit.dist + e.deltaY * 0.004));
  }, { passive: true });
  const tmpT = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpR = new THREE.Vector3(), tmpD = new THREE.Vector3();
  const envV = new THREE.Vector3(), envFrom = new THREE.Vector3(), envTo = new THREE.Vector3();
  let envAudioAt = 0;
  /**
   * Showroom camera. In the garage it orbits the turntable (car at the origin, nose down +z) and stays inside the
   * room; behind the tuner's cover it orbits the car where it stands on the street (that view is what gets measured).
   */
  const placeShowroom = (dt: number, carPos: THREE.Vector3) => {
    if (!orbit.drag && performance.now() > orbit.holdUntil) orbit.az += dt * (state === 'title' ? 0.16 : 0.08);
    const w = window.innerWidth, h = Math.max(1, window.innerHeight);
    const aspect = w / h;
    const portrait = aspect < 0.92;
    const phoneLandscape = !portrait && (h <= 540 || (w <= 1000 && matchMedia('(pointer: coarse)').matches));
    const compactDesktop = !portrait && !phoneLandscape && w <= 1320;
    const drawerOpen = menu.garageDrawerOpen;
    // Frame the hero car cleanly away from every UI panel (note: lookAt subtracts `orbit.shift * right`,
    // so POSITIVE shift moves the car RIGHT of the left Title rail, and NEGATIVE shift moves the car LEFT
    // away from the right-hand Garage customization drawer!):
    const targetShift = portrait ? 0
      : state === 'title' ? (phoneLandscape ? 1.05 : 1.55)
      : state === 'garage' ? (drawerOpen ? (phoneLandscape ? -1.35 : compactDesktop ? -0.95 : -0.58) : 0)
      : 0;
    orbit.shift += (targetShift - orbit.shift) * (1 - Math.exp(-dt * 4.5));
    // In portrait Garage with bottom drawer open, aim slightly lower so the car sits high in the clear upper window
    const garageY = portrait && drawerOpen ? 0.08 : portrait ? 0.40 : 0.58;
    if (inGarage) tmpT.set(0, garageY, 0); else tmpT.copy(carPos).add(tmpD.set(0, 0.25, 0));
    const baseDist = inGarage ? Math.min(7.6, Math.max(3.2, orbit.dist)) : orbit.dist;
    const dist = portrait ? Math.min(inGarage ? 8.4 : 11.5, baseDist * 1.24)
      : phoneLandscape && state === 'garage' && drawerOpen ? Math.min(8.0, baseDist * 1.12)
      : baseDist;
    const ce = Math.cos(orbit.el);
    tmpP.set(Math.sin(orbit.az) * ce, Math.sin(orbit.el), Math.cos(orbit.az) * ce).multiplyScalar(dist).add(tmpT);
    if (inGarage) garage!.clampCamera(tmpT, tmpP);
    else {
      const hit = pw.raycast(tmpT, tmpP, car.body);   // pull in front of walls (not the car itself)
      if (hit && hit.toi < dist) tmpP.sub(tmpT).setLength(Math.max(2.5, hit.toi - 0.4)).add(tmpT);
    }
    camera.position.copy(tmpP);
    tmpR.subVectors(tmpT, tmpP).cross(tmpD.set(0, 1, 0)).setY(0).normalize();   // camera right
    camera.lookAt(tmpD.copy(tmpT).addScaledVector(tmpR, -orbit.shift));
    const fov = portrait ? (inGarage ? 48 : 52) : (inGarage ? 38 : 42);
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (showPost) showPost.focus.value = tmpP.distanceTo(tmpT);
  };

  if (import.meta.env.DEV) {
    const report = (msg: string) => fetch('/__telemetry', { method: 'POST', body: msg }).catch(() => {});
    report(`started ${backend} | ${navigator.userAgent.match(/Chrome\/[\d.]+|Firefox\/[\d.]+/)?.[0] ?? ''}`);
    setInterval(() => report(`${document.getElementById('perf')!.textContent!.replace('\n', ' | ')} | ${Math.round(Math.abs(car.out[OUT.speed]) * 3.6)} km/h`), 2000);
  }

  const carAcc = new THREE.Vector3(), lastVel = new THREE.Vector3(), stepAcc = new THREE.Vector3();
  /**
   * Car-to-car contact with another player: their body is kinematic (infinitely heavy) here, so the step gave our car
   * the whole velocity change of hitting a wall. Two equal cars share it: keep half. (Their game does the same with us.)
   */
  const preV = new THREE.Vector3(), preW = new THREE.Vector3();
  /**
   * We sheared a pole (obstacles.afterStep already took the speed off): it falls, our front takes the impulse (the
   * collider is gone, so feedCrash can't find the contact point), the others in the party see it fall too.
   */
  let contactId = 900000;
  const poleHit = (h: PoleHit, mine: boolean) => {
    streetProps!.knockDown(h.pole, h.vx, h.vz);
    if (!mine) { obstacles?.release(h.pole); return; }
    core.contact(h.point, h.impulse, ++contactId);
    audio.impact(Math.max(15, h.impulse / 400), false, 'pole');
    forzaVfx.emitSparks(h.point.x, h.point.y, h.point.z, visual.velocity.x, visual.velocity.y, visual.velocity.z, 16, 1.15, pos.y - visual.cg.y);
    party?.sendPole(h.pole.x, h.pole.y, h.vx, h.vz);
  };
  /** We broke through a building wall: the front takes the energy the car lost; the party sees the hole. */
  const wallHit = (w: WallHit) => {
    core.contact(w.point, w.impulse, ++contactId);
    audio.impact(Math.max(60, (w.impulse * w.impulse) / (2 * core.info.mass) / 1000), w.storefront, 'wall');
    forzaVfx.emitSparks(w.point.x, w.point.y, w.point.z, visual.velocity.x, visual.velocity.y, visual.velocity.z, 24, 1.35, pos.y - visual.cg.y);
    party?.sendBreach(w.spec);
  };
  // Wire falling pole & heavy collapsing building rubble impacts to localized car denting, chassis damage, suspension jolt & audio.
  const wireCityImpactCallbacks = () => {
    if (streetProps) {
      // the core's damage reads an impulse on our car: the one that carries this energy (E = J^2 / 2m)
      streetProps.onLand = (x, y, z, energy) => {
        core.contact({ x, y, z }, Math.sqrt(2 * core.info.mass * energy), ++contactId);
        damage.dentFromWorld(new THREE.Vector3(x, y, z), new THREE.Vector3(0, -1, 0), energy, true);
        forzaVfx.emitSparks(x, y, z, visual.velocity.x, 1.5, visual.velocity.z, 14, 1.0, pos.y - visual.cg.y);
        audio.impact(Math.max(10, energy / 1000), true, 'pole');
      };
    }
    if (nyc) {
      nyc.breaches.onRubbleHit = (hit) => {
        // Visibly dent the exact roof/hood/fender spot where the heavy concrete/brick block landed!
        damage.dentFromWorld(hit.point, hit.dir, hit.energyJ, hit.glass);
        core.contact(hit.point, hit.impulse, ++contactId);
        // Real downward suspension thump without ever trapping the chunk in Rapier
        if (car?.body && car.body.isEnabled()) {
          car.body.applyImpulseAtPoint({ x: 0, y: -Math.min(1800, hit.massKg * 9.5), z: 0 }, hit.point, true);
        }
        forzaVfx.emitSparks(hit.point.x, hit.point.y, hit.point.z, visual.velocity.x, 1.2, visual.velocity.z, 16, 1.1, pos.y - visual.cg.y);
        const kj = Math.max(14, hit.energyJ / 450);
        audio.impact(kj, hit.glass, 'wall');
        audio.suspensionThump(Math.min(1, 0.35 + hit.massKg * 0.004));
        rumbleKj = Math.max(rumbleKj, kj);
      };
    }
  };
  wireCityImpactCallbacks();
  const carBox = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), half: [0, 0, 0] as [number, number, number], centre: [0, 0, 0] as [number, number, number] };
  const halveRemoteHits = (tTick: number) => {
    let touching = false;
    for (const c of remote!.colliders) {
      let hit = false;
      pw.world.contactPair(car.collider, c, (m) => { if (m.numContacts() > 0) hit = true; });
      if (hit) { touching = true; remote!.touched(c, tTick); }
    }
    if (!touching) return;
    const lv = car.body.linvel(), av = car.body.angvel();
    car.body.setLinvel({ x: (preV.x + lv.x) / 2, y: (preV.y + lv.y) / 2, z: (preV.z + lv.z) / 2 }, true);
    car.body.setAngvel({ x: (preW.x + av.x) / 2, y: (preW.y + av.y) / 2, z: (preW.z + av.z) / 2 }, true);
  };
  syncPose();
  post.carPos.copy(pos);

  // Boot into the title (or, for the test tools with ?menu=0, straight into a free run).
  gameReady = true;
  clearInterval(bootTipTimer);
  say('Ready!', 100);
  { const l = document.getElementById('loading'); if (l) { l.classList.add('out'); setTimeout(() => l.remove(), 450); } }   // fade, not a cut
  if (params.get('menu') === '0') {
    sel.mode = 'free';
    ai.setMode(ai.cars.length ? 'cruise' : 'off');
    zones.setVisible(true);
    raceNodes.setVisible(true);
    hud.show();
    if (wantsTouch()) enableTouch();
    resetCar();
    ai.go();
    setState('race');
    audio.muted = false;
  } else {
    setState('title');
    menu.show('title');
    if (adaptive) startTuning(false);
    else menu.setTuning(false, potato ? POTATO_NOTE : params.has('scale') || PRESET_ORDER.includes(params.get('quality') as PresetName) ? 'Graphics pinned by the URL' : `Graphics fixed: ${gfx}`);
    visual.setPaint(paintOf(sel, catalog), sel.finish);
  }
  setExtra();

  let lastRenderAt = 0, statsAt = 0, statsLogAt = 0, lastBlipAt = 0;
  const candidatesBuf: NearbyCandidate[] = [];
  const blipsBuf: Blip[] = [];
  /** CPU time per frame section (ms, accumulated): window.__prof. Sections sum to `total`, the whole callback. */
  const prof = { n: 0, total: 0, sim: 0, vis: 0, city: 0, post: 0, hud: 0, audio: 0 };
  (globalThis as { __prof?: unknown }).__prof = prof;
  renderer.setAnimationLoop(() => {
    if (citySwitching) return;
    const now = performance.now();
    const p0 = now;
    const frame = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    const inShowroom = isShowroom(state);
    const frozenByCreator = photoMode.active || replay.active || raceNodes.matchmaking || carMeet.walking;
    const live = state !== 'paused' && !frozenByCreator && (!inShowroom || settledShowroom < 24);
    // Slow-motion 0.22x time scale during totaled Crash Cinematic before entering Spectate
    const simDt = crashCineT > 0 ? frame * 0.22 : frame;
    if (live) acc += simDt; else acc = 0;
    // The street under the car is not built yet (a slow phone or network was outrun by the car, or a reset landed on an
    // unloaded tile): hold the simulation until its colliders exist, instead of letting the car fall through the map.
    let groundHeld = false;
    if (nyc && live && driving() && state !== 'spectate') {
      const cp = car.body.translation();
      const held = !nyc.groundReady(cp.x, cp.z);
      groundHeld = held;
      if (held) acc = 0;
      const warn = held ? 'LOADING THE STREET…' : '';
      if (hud.holdWarn !== warn) hud.holdWarn = warn;
    } else if (hud.holdWarn) hud.holdWarn = '';
    let steps = 0;
    const tSim = performance.now();
    let p2RightX = 0, p2RightY = 0;
    let polled: RawInput | null = null;
    let p2p: Player2Poll | null = null;
    if (physWorker && !inShowroom && !splitActive) {
      // Offloaded rs_core worker path (?physworker=1): main thread traces 12 ground planes once per rendered frame
      // against Rapier, publishes input + ground planes via the SAB SPSC command ring, drains fixed-rate worker
      // snapshots via the SAB SPSC snapshot ring, and syncs the kinematic player proxy in Rapier once per frame.
      const workerLive = live && !groundHeld;
      const script = (g.__game as { script?: ((tick: number) => RawInput) | null }).script;
      let tin = script ? script(ticks) : state === 'race' ? input.poll() : IDLE;
      if (state === 'countdown' && input.raw.throttle > 0.5) launchArmed = true;
      if (state === 'race' && launchUntil > 0 && ticks * DT < launchUntil) {
        const ph = Math.min(1, Math.max(0, (ticks * DT - (launchUntil - 1.1)) / 1.1));
        Object.assign(launchIn, tin);
        launchIn.directGear = tin.directGear ?? -99;
        launchIn.throttle = Math.min(tin.throttle, 0.55 + 0.45 * ph);
        tin = launchIn;
      }
      const groundPlanes = car.sampleGroundPlanes();
      physWorker.sendFrame(workerLive, tin, input.assists, car.nosThrustN, groundPlanes, turboStageOf(), workerAirC, workerTrackC, 15, workerHumidity);
      const drained = physWorker.drain(car.out);
      if (drained > 0) {
        prevPos.copy(physWorker.prevPos);
        prevQuat.copy(physWorker.prevQuat);
        physPos.copy(physWorker.currPos);
        physQuat.copy(physWorker.currQuat);
        const dtSpan = Math.max(1 / physWorker.rateHz, drained / physWorker.rateHz);
        const v = physWorker.currVel;
        const a = stepAcc.set(v.x - lastVel.x, v.y - lastVel.y, v.z - lastVel.z).divideScalar(dtSpan);
        lastVel.set(v.x, v.y, v.z);
        carAcc.lerp(a.clampLength(0, 60), 1 - Math.exp(-dtSpan / 0.025));
        ticks += drained * (240 / physWorker.rateHz);
        steps = drained;
      }
      if (workerLive) {
        const aiDt = Math.min(0.05, simDt);
        ai.tick(aiDt, physPos);
        remote?.tick(now, aiDt);
        const t0 = performance.now();
        pw.world.timestep = aiDt;
        pw.world.step();
        pw.world.timestep = DT;
        stepMs += (performance.now() - t0 - stepMs) * 0.05;
        car.body.setTranslation(physPos, true);
        car.body.setRotation(physQuat, true);
        car.body.setLinvel(physWorker.currVel, true);
        car.body.setAngvel(physWorker.currAngVel, true);
      }
      acc = 0;
    } else while (acc >= DT && steps < 24) {
      prevPos.copy(physPos);
      prevQuat.copy(physQuat);
      if (splitActive && p2Car) {
        p2PrevPos.copy(p2PhysPos);
        p2PrevQuat.copy(p2PhysQuat);
      }
      const script = (g.__game as { script?: ((tick: number) => RawInput) | null }).script;   // dev / replay: inputs by tick
      let tin = script ? script(ticks) : state === 'race' ? (polled ??= input.poll()) : IDLE;
      if (state === 'countdown' && input.raw.throttle > 0.5) launchArmed = true;
      if (state === 'race' && launchUntil > 0 && ticks * DT < launchUntil) {
        const ph = Math.min(1, Math.max(0, (ticks * DT - (launchUntil - 1.1)) / 1.1));
        Object.assign(launchIn, tin);
        launchIn.directGear = tin.directGear ?? -99;
        launchIn.throttle = Math.min(tin.throttle, 0.55 + 0.45 * ph);   // ramp instead of instant full power
        tin = launchIn;
      }
      if (!dyno.active) car.tick(tin, input.assists);   // on the dyno the core car runs on its virtual road (dyno.ts)
      if (polled) { polled.shiftUp = false; polled.shiftDown = false; }   // edges act on the first tick only
      if (splitActive && p2Car && p2Core) {
        const firstP2 = !p2p;
        if (!p2p) p2p = p2Input.poll(isKeyDownP1, state !== 'race');
        else { p2p.raw.shiftUp = false; p2p.raw.shiftDown = false; }
        p2SourceLabel = p2p.sourceLabel;
        p2RightX = p2p.rightStickX;
        p2RightY = p2p.rightStickY;
        if (firstP2 && p2p.camToggle) p2Rig?.toggle();
        if (firstP2 && p2p.resetCar && state === 'race') {
          const rp = p2Pos.clone(); rp.y += 1.6;
          const hit = pw.raycast(rp, rp.clone().add(new THREE.Vector3(0, -14, 0)), p2Car.body);
          if (hit) rp.y -= hit.toi;
          rp.y += p2Core.info.cgHeight + 0.05;
          p2Car.place(rp, startYaw);
          p2Car.settle();
        }
        if (p2p.nos && state === 'race' && p2NosSec > 0) {
          p2NosSec = Math.max(0, p2NosSec - DT);
          p2Car.nosThrustN = 5200;
        } else {
          p2NosSec = Math.min(6.0, p2NosSec + DT * 0.25);
          p2Car.nosThrustN = 0;
        }
        p2Car.tick(state === 'race' ? p2p.raw : IDLE, input.assists);
      }
      if (inShowroom) { car.body.setLinvel({ x: 0, y: Math.min(0, car.body.linvel().y), z: 0 }, true); car.body.setAngvel({ x: 0, y: 0, z: 0 }, true); settledShowroom++; }   // parked for the showroom
      ai.tick(DT, car.body.translation());
      remote?.tick(now - (acc - DT) * 1000, DT);   // other players' bodies at this tick's time
      if (remote?.colliders.size || obstacles || nyc || ai.mode !== 'off') { const lv = car.body.linvel(), av = car.body.angvel(); preV.set(lv.x, lv.y, lv.z); preW.set(av.x, av.y, av.z); }
      const t0 = performance.now();
      pw.world.step();
      if (obstacles) { const h = obstacles.afterStep(car.collider, car.body, core.info.mass, preV, preW); if (h) poleHit(h, true); }
      if (nyc && driving()) { const w = nyc.breaches.check(car.collider, car.body, core.info.mass, preV, preW); if (w) wallHit(w); }
      if (remote?.colliders.size) halveRemoteHits(now - (acc - DT) * 1000);
      if (ai.mode !== 'off') ai.afterStep(car.collider, car.body, preV, preW);   // rivals & cruising traffic take their half of a hit (ai.ts)
      stepMs += (performance.now() - t0 - stepMs) * 0.01;   // Rapier cost per 240 Hz step, smoothed
      readBody(physPos, physQuat);
      if (splitActive && p2Car) {
        readP2Body(p2PhysPos, p2PhysQuat);
        const v2 = p2Car.body.linvel();
        const a2 = p2StepAcc.set(v2.x - p2LastVel.x, v2.y - p2LastVel.y, v2.z - p2LastVel.z).divideScalar(DT);
        p2LastVel.set(v2.x, v2.y, v2.z);
        p2Acc.lerp(a2.clampLength(0, 60), 1 - Math.exp(-DT / 0.025));
      }
      // car acceleration for the camera spring, from the physics (low-passed ~25 ms)
      const v = car.body.linvel();
      const a = stepAcc.set(v.x - lastVel.x, v.y - lastVel.y, v.z - lastVel.z).divideScalar(DT);
      lastVel.set(v.x, v.y, v.z);
      carAcc.lerp(a.clampLength(0, 60), 1 - Math.exp(-DT / 0.025));
      ticks++;   // simulation clock (race timing)
      if (trace.length < 300 && ticks % 4 === 0) {
        const r = car.body.rotation(), t = car.body.translation(), o = car.out;
        trace.push([ticks, +(Math.atan2(2 * (r.w * r.y + r.x * r.z), 1 - 2 * (r.y * r.y + r.x * r.x)) * 57.2958).toFixed(2), +t.y.toFixed(3),
          [0, 1, 2, 3].map((i) => Math.round(o[OUT.wheel(i) + 6])).join('/'), +frame.toFixed(3)]);
      }
      acc -= DT;
      steps++;
    }
    if (launchEl && steps > 0) {
      const lt = state === 'countdown' && launchArmed ? 'LAUNCH READY' : state === 'race' && launchUntil > 0 && ticks * DT < launchUntil ? 'LAUNCH' : '';
      if (lt !== lastLaunchText) launchEl.textContent = lastLaunchText = lt;
    }
    prof.sim += performance.now() - tSim;
    if (!physWorker && steps === 24) acc = 0;   // too slow to keep up: drop time rather than spiral
    const alpha = physWorker && !inShowroom && !splitActive ? physWorker.alpha(now) : Math.min(1, acc / DT);
    pos.lerpVectors(prevPos, physPos, alpha);
    quat.slerpQuaternions(prevQuat, physQuat, alpha);
    if (splitActive && p2Car) {
      p2Pos.lerpVectors(p2PrevPos, p2PhysPos, alpha);
      p2Quat.slerpQuaternions(p2PrevQuat, p2PhysQuat, alpha);
    }
    post.carPos.copy(pos);
    // Tactical Police Pursuit: ONLY active in Race Events with Cop Mode ON (never in Free Roam!).
    const copsOnNow = copsActiveInRace();
    heatEl.hidden = raceLaps() === 0 && driving();
    if (!copsOnNow && cops.active) cops.breakOff();
    playerS = cops.nearest(pos, playerS);
    if (state === 'race' && copsOnNow && !copSpawned && ticks > 360) {
      copSpawned = true;
      cops.spawn(playerS, pos, Math.max(1, heat.level));
    }
    cops.update(frame, playerS, pos, Math.abs(car.out[OUT.speed]) * 3.6);
    if (cops.active) {
      // Line of sight: ray from lead patrol unit to player car; building hits break visual lock.
      const from = cops.world, to = pos;
      const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      copRayO.x = from.x; copRayO.y = from.y + 1.2; copRayO.z = from.z;
      copRayD.x = dx / len; copRayD.y = dy / len; copRayD.z = dz / len;
      const hit = pw.world.castRay(copRay, len - 2, true);
      cops.see(!!hit, frame);
      audio.siren(cops.proximity);
      const ct = `🚨 ${cops.tactic} · ${Math.round(cops.distance)} m`;
      if (ct !== lastCopsText) copsEl.textContent = lastCopsText = ct;
    } else {
      audio.siren(0);
      const ct = performance.now() < copMsgUntil ? copMsg : '';
      if (ct !== lastCopsText) copsEl.textContent = lastCopsText = ct;
    }
    const tVis = performance.now();
    {
      const lv = car.body.linvel();
      visual.velocity.set(lv.x, lv.y, lv.z);
      // Gameplay-driven WGSL paint wear: speed + drift sideslip + wet streets + wall scrapes + crash damage + rival wake spray
      const spd = Math.hypot(lv.x, lv.z);
      if (live) {
        let draftingFactor = 0;
        if (ai.mode === 'race' && spd > 8) {
          const fwdX = 2 * (quat.x * quat.z + quat.w * quat.y);
          const fwdZ = 1 - 2 * (quat.x * quat.x + quat.y * quat.y);
          for (const rival of ai.cars) {
            const dx = rival.pos.x - pos.x, dz = rival.pos.z - pos.z;
            const d = Math.hypot(dx, dz);
            if (d > 2.5 && d < 24) {
              const align = (dx * fwdX + dz * fwdZ) / d;
              if (align > 0.85) draftingFactor = Math.max(draftingFactor, (1 - d / 24) * align);
            }
          }
        }
        // the damage report DamageVisuals reads from the core at 20 Hz (no core call + 4 arrays per frame here)
        const dmg = damage.last;
        const damageLevel = dmg ? Math.min(1, Math.max(dmg.severity ?? 0, (dmg.zone[0] + dmg.zone[1] + dmg.zone[2] + dmg.zone[3]) * 0.3)) : 0;
        advancePaintWear(paintWear, {
          speedMs: spd,
          dtSec: frame,
          sideslipRad: Math.abs(car.out[OUT.sideslip] || 0),
          wetRoad: 1.0,
          scrapeImpulse: pendingScrapeImpulse,
          damageLevel,
          draftingFactor,
        });
        pendingScrapeImpulse = 0;
        if (wearOverride === null) {
          visual.custom.setWear(paintWear.wear, paintWear.scuff, paintWear.wakeSpray);
        }
      }
      if (dyno.active && state !== 'garage') leaveDyno();   // left the garage (Drive, Esc): off the rollers
      if (dyno.active && state === 'garage') {
        // garage dyno: the same core car on its virtual road; the model stands on the platforms
        if (input.isKeyDown('Escape')) leaveDyno();
        else {
          if (input.isKeyDown('KeyR') || dyno.runRequested) { dyno.runRequested = false; dyno.newRun(core); }
          const dOut = dyno.step(core, input.poll(), input.assists, frame);
          if (garage) garage.holder.position.y = -visual.groundY + dyno.lift;   // the model stands on the platforms
          visual.update(pos, quat, dOut, dyno.physPos, dyno.physQuat);
          dyno.frame(core, dOut, frame, now);
        }
      } else visual.update(pos, quat, car.out, prevPos, prevQuat);   // car.out was computed from the pose BEFORE the last step
      // Forza Horizon 6 Real-Time VFX: 4-wheel brake thermals, 4-wheel drift/lockup smoke, wet rooster-tail spray,
      // titanium sparks, high-speed rain streaks, and suspension curb/landing thump detection (zero allocations).
      forzaInput.dt = live ? (simDt > 0 ? simDt : frame) : frame;
      forzaInput.active = live && state === 'race' && !inGarage;
      forzaInput.out = car.out;
      forzaInput.carVel = visual.velocity;
      forzaInput.roadWetness = worldClock.wetness;
      forzaInput.asphaltSurfaceId = core.info.surfaces.asphalt;
      forzaInput.handbrake = state === 'race' ? input.raw.handbrake : 0;
      forzaVfx.update(forzaInput);
      visual.setBrakeGlow(forzaVfx.rotorTempC);
      if (splitActive && p2Visual && p2Car) {
        p2Visual.update(p2Pos, p2Quat, p2Car.out, p2PrevPos, p2PrevQuat);
        p2Visual.setExhaustFlame(p2Car.nosThrustN > 0 ? 1.25 : 0, p2Car.nosThrustN > 0, worldClock.wetness);
      }
      if (!inShowroom || settledShowroom <= 24) {
        ai.update(alpha, camera);
        damage.update(live ? frame : 0, () => core.damage());
      }
    }
    prof.vis += performance.now() - tVis;
    const tAud = performance.now();
    syncCameraAudioPerspective();
    if (driving()) {
      if (audio.garageEngineOn) { audio.stopGarageEngine(); menu.garageEngineOn = false; }
      audio.update(car.out, car.out[OUT.speed]);
      audio.updateBrakes(car.out[OUT.brake] || 0, Math.abs(car.out[OUT.speed] || 0), forzaVfx.peakRotorTempC);
      if (state === 'race' && forzaVfx.suspensionThump > 0.05) {
        audio.suspensionThump(forzaVfx.suspensionThump);
      }
    } else if (state === 'garage' && dyno.active) {
      audio.update(core.buf, core.buf[OUT.speed]);   // the dyno run, heard like the road
    } else if (state === 'garage') {
      audio.updateGarage(frame);
      audio.updateBrakes(0, 0, 40);
    } else if (audio.garageEngineOn) {
      audio.stopGarageEngine();
      menu.garageEngineOn = false;
    }
    // Environment audio (~10 Hz): 3 short rays (left, right, up) pick tunnel / urban-canyon reverb; road wetness and the
    // adaptive music follow the weather, speed, cops and heat
    if (state === 'race' && now - envAudioAt > 100) {
      envAudioAt = now;
      const kmhA = Math.abs(car.out[OUT.speed]) * 3.6;
      const right = envV.set(1, 0, 0).applyQuaternion(quat).setY(0).normalize();
      envFrom.copy(pos).setY(pos.y + 0.6);
      const hitL = pw.raycast(envFrom, envTo.copy(envFrom).addScaledVector(right, -10), car.body);
      const hitR = pw.raycast(envFrom, envTo.copy(envFrom).addScaledVector(right, 10), car.body);
      const hitU = pw.raycast(envFrom, envTo.copy(envFrom).setY(envFrom.y + 14), car.body);
      let rev = 0;
      if (hitU) rev = 0.85;
      else if (hitL && hitR) rev = 0.6 - Math.min(0.35, (hitL.toi + hitR.toi) / 40 * 0.35);
      else if (hitL || hitR) rev = 0.12;
      audio.envReverb += (rev - audio.envReverb) * 0.35;
      audio.roadWetness = worldClock.wetness;
      let rough = 0;   // wheels on a non-asphalt surface (kerbs / pavement): coarse rolling crunch instead of smooth asphalt
      for (let i = 0; i < 4; i++) { const o = OUT.wheel(i); if (car.out[o + 5] > 0.5 && car.out[o + 11] !== core.info.surfaces.asphalt) rough++; }
      audio.onGravel = rough >= 2;
      audio.setMusicContext(kmhA, cops.active, heat.level);
    }
    // force feedback runs every frame (it ramps to zero in the menus); only while the wheel is the driving device
    ffb.update(frame, { driving: state === 'race' && input.device === 'wheel', rackTorque: car.out[OUT.steerTorque], speed: Math.abs(car.out[OUT.speed]),
      wheel: input.wheelPos, wheelVel: input.wheelVel, impactKj: state === 'race' ? rumbleKj : 0 }, input.settings);
    prof.audio += performance.now() - tAud;
    if (state === 'race') { input.rumble(now, car.out, rumbleKj); rumbleKj = 0; }
    if (state === 'paused' && !menu.ctl?.calibrating) input.menuPoll();
    if (ranked && (state === 'race' || state === 'spectate' || state === 'results') && !myDnf) ranked.pos(now, car.body.translation(), Math.abs(car.out[OUT.speed]));
    if (state === 'race' && raceLaps() === 0) freeRoamM += Math.min(Math.abs(car.out[OUT.speed]), 90) * frame;
    // Free Roam social sandbox: Spontaneous Headlight-Flash 1v1 Wagers + City-Wide Speed Traps & Drift Zones
    {
      const inFreeRoam = state === 'race' && raceLaps() === 0;
      const kmhNow = Math.abs(car.out[OUT.speed]) * 3.6;
      candidatesBuf.length = 0;
      if (inFreeRoam) {
        if (remote && party) {
          for (const id of remote.ids()) {
            const r = remote.get(id);
            if (!r) continue;
            const d = Math.hypot(r.root.position.x - pos.x, r.root.position.z - pos.z);
            const name = party.members.find((m) => m.id === id)?.name ?? 'Driver';
            candidatesBuf.push({ id, name, kind: 'peer', aiIdx: -1, dist: d, pos: r.root.position });
          }
        }
        if (ai.mode === 'cruise') {
          for (let i = 0; i < ai.cars.length; i++) {
            const c = ai.cars[i];
            const d = Math.hypot(c.pos.x - pos.x, c.pos.z - pos.z);
            candidatesBuf.push({ id: `ai_${i}`, name: c.name, kind: 'ai', aiIdx: i, dist: d, pos: c.pos });
          }
        }
      }
      const wasFlashing = wagers.flashTimer > 0;
      wagers.update(frame, inFreeRoam, pos, kmhNow, candidatesBuf, now);
      if (wagers.flashTimer > 0) {
        visual.dim = wagers.flashMultiplier;
        visual.applyHeadlights();
      } else if (wasFlashing) {
        visual.dim = driving() ? 1 : 0.008;
        visual.applyHeadlights();
      }
      zones.update(frame, inFreeRoam, pos, kmhNow, car.out[OUT.sideslip] || 0, sel.name, sel.car, now);
      raceNodes.update(frame, inFreeRoam && !photoMode.active && !replay.active, pos);
      carMeet.syncCarPose(pos, quat, kmhNow);
      carMeet.update(frame, inFreeRoam && !photoMode.active && !replay.active, pos, (c) => input.isKeyDown(c));

      // World 1:4 Time-of-Day Clock, Real-Life Season, 1-in-5 Rain & Realistic Traffic Density Curve
      worldClock.update(frame, scene, moon);
      if (driving() && now - lastDensityAt > 2000) {
        lastDensityAt = now;
        const ct = worldClock.hudText();
        if (ct !== lastClockText) { worldClockEl.textContent = lastClockText = ct; }
        if (ai.mode === 'cruise') ai.setCruiseDensity(worldClock.trafficDensity);
        // Sync live climate & asphalt temperature into C++ ISA air density, NA/Turbo engine power & tire road conduction
        const baseAirC = worldClock.season.id === 'winter' ? 4 : worldClock.season.id === 'summer' ? 28 : 16;
        const rainDrop = worldClock.weather === 'rain' ? -4 : 0;
        const nightDrop = (worldClock.hour >= 20 || worldClock.hour < 6) ? -5 : 4;
        const airC = baseAirC + rainDrop + nightDrop;
        const trackC = worldClock.weather === 'rain' ? airC - 2 : airC + (nightDrop > 0 ? 11 : -1);
        const humidity = worldClock.weather === 'rain' ? 0.92 : 0.48;
        workerAirC = airC; workerTrackC = trackC; workerHumidity = humidity;
        core.setAtmosphere(airC, trackC, 15, humidity);
        core.setRoadWater(worldClock.roadWaterMm);
        p2Core?.setRoadWater(worldClock.roadWaterMm);
        setGroundWetness(worldClock.wetness);
      }

      // Engine Health, Temperature, Nitrous Oxide ([X] purge) & Dual-Stage Mach-Diamond Exhaust VFX + Wet-Road Bounce
      if (live && state === 'race') {
        const eng = engineOf(nr, sel.car);
        const nosKey = input.isKeyDown('KeyX');
        const rpmNow = car.out[OUT.rpm] || 800;
        const nrTick = tickEngineAndNos(eng, frame, rpmNow, core.info.redline, Math.abs(car.out[OUT.speed]), nosKey);
        car.nosThrustN = nrTick.nosThrustN;
        const shiftPop = (car.out[OUT.shiftCut] || 0) > 0.5 || (car.out[OUT.bovVenting] || 0) > 0.5;
        const audioFlame = audio.drivingFlameLevel;
        const rpmFrac = Math.max(0, Math.min(1, (rpmNow - 2200) / Math.max(1500, core.info.redline - 2200)));
        const exhaustHeat = Math.min(1, rpmFrac * 0.55 + Math.max(0, (eng.tempC - 82) / 45) * 0.35 + (nrTick.nosActive ? 0.5 : 0));
        if (nrTick.flameBurst || shiftPop || audioFlame > 0.05) {
          const flInt = Math.max(audioFlame, nrTick.nosActive ? 1.3 : shiftPop ? 1.05 : nrTick.flameBurst ? 0.9 : 0);
          visual.setExhaustFlame(flInt, nrTick.nosActive, worldClock.wetness, Math.max(exhaustHeat, flInt * 0.9));
        } else visual.setExhaustFlame(0, false, worldClock.wetness, exhaustHeat);
        const nt = `NOS ${eng.nosLiters.toFixed(1)}L [X] · ${Math.round(eng.tempC)}°C · ENG ${Math.round(eng.health)}%`;
        if (nt !== lastNosText) {
          nosBarEl.textContent = lastNosText = nt;
          nosBarEl.classList.toggle('hot', nrTick.overheated || eng.health <= 20);
        }
        telemetry.tick(frame, true, car.out, core.info, input.raw.throttle, input.raw.brake, input.raw.steer, lap);
        replay.record(frame, pos, quat, car.out[OUT.speed], car.out[OUT.rpm], input.raw.steer, input.raw.brake, ai.cars);   // yaw = root.rotation.y, read at 20 Hz
      } else {
        car.nosThrustN = 0;
        if (state === 'garage') {
          const gFlame = audio.garageFlameLevel;
          const gHeat = audio.garageEngineOn ? Math.min(1, 0.28 + gFlame * 0.85) : 0;
          // Polished garage concrete floor catches subtle warm tailpipe flame bounce reflection when revving!
          visual.setExhaustFlame(gFlame > 0.02 ? gFlame : 0, false, 0.65, gHeat);
        } else {
          visual.setExhaustFlame(0, false, 0, 0);
        }
      }
      const wh = inFreeRoam ? (wagers.hudBanner() || raceNodes.promptHtml()) : '';
      if (wh !== lastWagerHtml) { wagerHudEl.innerHTML = lastWagerHtml = wh; }
      const zh = inFreeRoam ? zones.driftHudHtml() : '';
      if (zh !== lastZoneHtml) { zoneHudEl.innerHTML = lastZoneHtml = zh; }
      const bh = inFreeRoam ? zones.leaderboardHtml() : '';
      if (bh !== lastBoardHtml) { zoneBoardEl.innerHTML = lastBoardHtml = bh; }
    }
    drivingLine.update(assistSet.line, (state === 'race' || state === 'countdown') && !photoMode.active && !replay.active, pos, car.out[OUT.speed]);
    if (driving() && state !== 'paused' && state !== 'busy' && !photoMode.active && !replay.active && now - lastBlipAt >= 62) {
      lastBlipAt = now;
      const watching = state === 'spectate';   // spectating: the map follows the watched car (no GPS directions)
      mmFwd.set(0, 0, 1).applyQuaternion(watching ? specQuat : quat);
      const pal = paletteOf(a11y);
      blipsBuf.length = 0;
      if (ai.mode === 'race') for (const c of ai.cars) blipsBuf.push({ x: c.pos.x, z: c.pos.z, color: pal.rival });
      else if (ai.mode === 'cruise') for (const c of ai.cars) blipsBuf.push({ x: c.pos.x, z: c.pos.z, color: pal.traffic });
      if (remote) for (const id of remote.ids()) { const r = remote.get(id); if (r) blipsBuf.push({ x: r.root.position.x, z: r.root.position.z, color: pal.peer }); }
      if (raceLaps() === 0) {
        for (const zb of zones.minimapBlips()) blipsBuf.push({ x: zb.x, z: zb.z, color: zb.color === '#00e5ff' ? pal.speedTrap : pal.driftZone });
        for (const rb of raceNodes.minimapBlips(pal.raceNode)) blipsBuf.push(rb);
        const fin = wagers.finishWorld;
        if (fin) blipsBuf.push({ x: fin.x, z: fin.z, color: pal.dragFinish });
      } else if (cops.active) {
        for (const u of cops.unitPositions()) blipsBuf.push({ x: u.x, z: u.z, color: pal.cop });
        const rb = cops.roadblockWorld;
        if (rb) blipsBuf.push({ x: rb.x, z: rb.z, color: pal.roadblock });
      }
      const L = lap?.routeLength ?? route.length_m;
      if (watching) minimap.update(now, specPos, mmFwd, specOut[OUT.speed], null, blipsBuf);
      else minimap.update(now, pos, mmFwd, Math.abs(car.out[OUT.speed]), lap ? ((lap.distance % L) + L) % L : null, blipsBuf);
    }
    menuNav.paused = !!menu.ctl?.calibrating;
    menuNav.update(now);
    if (menu.screen === 'controls') menu.ctl?.tick();
    if (remote) {
      remote.update(now, camera);
      if (party && driving()) { const out = remote.outgoing(now, pos, quat, car.body.linvel()); if (out) party.sendPose(out, paintInt()); }
    }
    // The garage is on screen for every showroom state, except behind the tuner's cover
    setGarage(inShowroom && !tuning);
    if (inGarage) {
      visual.custom.sync(garage!.holder.position, IDENT_Q);   // livery mask: the model sits on the turntable, not at the body
      if (garage!.dirtyEnv) { garage!.captureEnv(); probe?.fromCube(garage!.cube.texture); }
    }
    if (!driving() || state === 'busy') {
      if (inGarage && garageWalk.active) {
        // Walkable Garage: WASD walks around the car to inspect Hood, Oil Cap & Storage Locker
        const mf = (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp') ? 1 : 0) - (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown') ? 1 : 0);
        const turn = (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft') ? 1 : 0) - (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight') ? 1 : 0);
        garageWalk.yaw += turn * frame * 2.0;
        garageWalk.pos.x = Math.max(-7.5, Math.min(7.5, garageWalk.pos.x + Math.sin(garageWalk.yaw) * mf * frame * 3.0));
        garageWalk.pos.z = Math.max(-7.5, Math.min(7.5, garageWalk.pos.z + Math.cos(garageWalk.yaw) * mf * frame * 3.0));
        camera.position.copy(garageWalk.pos);
        camera.lookAt(0, 0.72, 0);
      } else {
        placeShowroom(frame, pos);
      }
    }
    else if (crashCineT > 0) {
      // Dramatic slow-motion low-angle orbit around totaled wreckage before transitioning to Spectate
      crashCineT -= frame;
      const ang = (2.4 - crashCineT) * 1.15;
      camera.position.set(pos.x + Math.cos(ang) * 5.2, pos.y + 1.45, pos.z + Math.sin(ang) * 5.2);
      camera.lookAt(pos.x, pos.y + 0.45, pos.z);
      if (crashCineT <= 0) { crashCineT = 0; enterSpectate(crashCineWhy || 'OUT · WRECKED'); }
    }
    else if (photoMode.active) { photoMode.update(frame, (c) => input.isKeyDown(c)); }
    else if (replay.active) { replay.update(frame); }
    else if (carMeet.walking) { /* CarMeetHub updates smooth third-person walk camera */ }
    else {
      if (state === 'spectate') specCamera(frame);
      else if (live) {
        if (Math.abs(input.rightStick.x) > 0.01 || Math.abs(input.rightStick.y) > 0.01) {
          rig.dragFreeLook(input.rightStick.x * frame * 420, input.rightStick.y * frame * 260);
        }
        rig.update(frame, pos, quat, carAcc, car.out);
        if (splitActive && p2Rig && p2Car) {
          if (Math.abs(p2RightX) > 0.01 || Math.abs(p2RightY) > 0.01) {
            p2Rig.dragFreeLook(p2RightX * frame * 420, p2RightY * frame * 260);
          }
          p2Rig.update(frame, p2Pos, p2Quat, p2Acc, p2Car.out);
        }
      }
    }
    const tCity = performance.now();
    if (!inGarage) {
      cityLights.update(frame, camera);   // WebGL 2 pool only (5 Hz); a no-op with clustered lighting
      if (obstacles) obstacles.sync(frame, pos);
      if (streetProps) {
        carBox.pos.copy(physPos); carBox.quat.copy(physQuat);
        const bh = carBox.half, bc = carBox.centre;   // in place: no arrays per frame
        bh[0] = shape.boxSize[0] / 2; bh[1] = shape.boxSize[1] / 2; bh[2] = shape.boxSize[2] / 2;
        bc[0] = shape.boxCentre[0] - visual.cg.x; bc[1] = shape.boxCentre[1] - visual.cg.y; bc[2] = shape.boxCentre[2] - visual.cg.z;
        streetProps.carBox = driving() ? carBox : null;
      }
      nyc?.update(state === 'spectate' ? specPos : pos, frame, driving() && state !== 'spectate' ? visual.velocity : undefined, (impulse, kind) => {   // spectating: detail around the watched car
        pendingScrapeImpulse += impulse;
        const lv = car.body.linvel();
        const s = Math.hypot(lv.x, lv.z);
        if (s > 1) {
          const drag = Math.min(0.28, (impulse / 1800) / Math.max(4, s));
          car.body.setLinvel({ x: lv.x * (1 - drag), y: lv.y, z: lv.z * (1 - drag) }, true);
        }
        audio.impact(Math.max(12, impulse * 0.18), kind === 'shop' || kind === 'wall', kind);
        if (impulse > 40) {
          const sInt = Math.min(1.4, 0.35 + impulse / 4200);
          forzaVfx.emitSparks(pos.x, pos.y - 0.15, pos.z, lv.x, lv.y + 0.8, lv.z, 6 + sInt * 10, sInt, pos.y - visual.cg.y);
        }
        // Wrecking during a Cop Race Event raises Heat (never in Free Roam!).
        if (copsActiveInRace() && impulse > 5000 && Date.now() - heat.lastGain > 20_000) bumpHeat(1);
      });
      city.update(camera);
    }
    prof.city += performance.now() - tCity;
    // Frame cap (default 30 fps: the quality target; ?cap=0 uncapped, ?cap=45 etc.). Simulation, camera and HUD run every
    // display refresh; only the draw is skipped, so the picture holds still between rendered frames. The cap is off while
    // the graphics tuner measures (it needs the uncapped speed), and the slot clock advances by whole intervals so a
    // 60/120/144 Hz display averages exactly the cap instead of rounding down.
    if (capInterval === 0 || tuning || now - lastRenderAt >= capInterval - 2) {
      lastRenderAt = capInterval && now - lastRenderAt < capInterval * 1.5 ? lastRenderAt + capInterval : now;
      const hasCasters = ai.mode !== 'off' || remote !== null || cops.active || damage.debrisCount > 0;
      if (hasCasters && ++frameNo % (params.has('se') ? num('se', 2) : PRESETS[post.preset].shadowEvery) === 0) for (const sh of headShadows) sh.needsUpdate = true;
      const tPost = performance.now();
      if (!inGarage) {
        updateMirror(now);
        post.syncRoadReflection(camera, pos.y - visual.cg.y, ...roadPlane());
      }
      // One scene-graph walk per drawn frame: three walks the WHOLE scene in every render() call (main pass, planar road
      // reflection, mirror, headlight shadow maps, probe face, split-screen views). Everything has moved for this frame by
      // now, and the extra cameras update their own matrices, so the later walks only repeated the first.
      scene.updateMatrixWorld();
      scene.matrixWorldAutoUpdate = false;
      try {
      if (inGarage) showPost!.render();
      else if (splitActive && driving() && p2Cam && p2Car) {
        // Dual-viewport local 2-Player Split-Screen (works identically on WebGPU & WebGL 2 across all browsers/TVs)
        const w = innerWidth, h = innerHeight;
        const horiz = splitLayout === 'horizontal';
        const p1X = 0, p1Y = horiz ? Math.floor(h / 2) : 0;
        const p1W = horiz ? w : Math.floor(w / 2), p1H = horiz ? (h - p1Y) : h;
        const p2X = horiz ? 0 : p1W, p2Y = 0;
        const p2W = horiz ? w : (w - p1W), p2H = horiz ? p1Y : h;

        camera.aspect = p1W / Math.max(1, p1H);
        camera.updateProjectionMatrix();
        p2Cam.aspect = p2W / Math.max(1, p2H);
        p2Cam.updateProjectionMatrix();

        renderer.setScissorTest(true);
        renderer.setViewport(p1X, p1Y, p1W, p1H);
        renderer.setScissor(p1X, p1Y, p1W, p1H);
        renderer.render(scene, camera);

        renderer.setViewport(p2X, p2Y, p2W, p2H);
        renderer.setScissor(p2X, p2Y, p2W, p2H);
        renderer.render(scene, p2Cam);

        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, w, h);
      }
      else post.render();
      prof.post += performance.now() - tPost;
      // never while the garage is up: the probe's cube render rebuilds ShadowNodes and destroys the sun's shadow map
      if (screenNone() && post.preset !== 'low' && post.preset !== 'medium') probe?.update(pos, visual.root);
      } finally { scene.matrixWorldAutoUpdate = true; }   // every other render (loading, warm-up, tools) walks as before
      hud.rendered(now);
      if (now - statsAt > 1000) {   // draw calls are per frame; the texture scan is cached for 10 s
        statsAt = now;
        const s = frameStats(scene, renderer);
        hud.stats = s;
        if (import.meta.env.DEV && now - statsLogAt > 10_000) {
          statsLogAt = now;
          console.log(`[stats] ${s.calls} calls · ${s.textures} textures · ${s.textureMB} MB · ${s.noMips} without mips · ${s.triangles} tris`);
        }
      }
      if (adaptive && state === 'race' && car.out[OUT.speed] > 5 && frame < 0.095) {
        driveWinTime += frame;
        if (++driveFrames >= 60) {
          const dfps = driveFrames / driveWinTime;
          driveWinTime = 0; driveFrames = 0;
          const medIdx = PRESET_ORDER.indexOf('medium');
          if (dfps < (isTouch ? 42 : 27.5) && !presetPinned && presetIdx < medIdx) {
            setPreset(presetIdx + 1, false); setExtra();
          } else if (dfps < 25 && !presetPinned && presetIdx < PRESET_ORDER.length - 1) {
            setPreset(presetIdx + 1, false); setExtra();
          }
          // a phone that cannot hold 22 fps on `low` for three windows in a row starts in potato next time (no reload mid-drive)
          lowDrive = isTouch && !potato && !presetPinned && presetIdx === PRESET_ORDER.length - 1 && dfps < 22 ? lowDrive + 1 : 0;
          if (lowDrive >= 3) { try { localStorage.setItem(POTATO_KEY, '1'); } catch { /* storage blocked */ } }
        }
      } else if (state !== 'race') { driveWinTime = 0; driveFrames = 0; }
    }
    if (state === 'race' || (raceLaps() > 0 && (state === 'spectate' || state === 'results'))) {
      const tRace = ticks * DT - raceT0;
      // our progress only while we race (a wreck being pushed around must not gain places)
      if (state === 'race' && !myDnf) {
        lap = race.update(raceCar, car.body.translation(), tRace);
        if (lap.laps > lapTimes.length) lapTimes.push(lap.last);
      }
      for (const [i, r] of aiRace.entries()) {
        r.lap = race.update(r.idx, ai.cars[i].pos, tRace);
        if (r.lap.finished && r.fin < 0) r.fin = tRace;
      }
      if (raceLaps() > 0 && lap) {
        if (state === 'race') {
          if (lap.finished && raceFinishedAt < 0) raceFinishedAt = now;
          if (raceFinishedAt > 0 && now - raceFinishedAt > 1500) finishRace();
          checkOut(frame);
        }
        updateBoard(now);
        if (party && now - progAt > 250) { progAt = now; party.sendProgress({ d: lap.distance, lap: lap.laps, fin: lap.finished ? lapTimes.reduce((a, b) => a + b, 0) : -1, best: lap.best, dnf: myDnf ? 1 : 0 }); }
        // everyone else done: the race is over (spectating -> results); results on screen follow the field
        if (state === 'spectate' && now - specAt > 2000 && !rank(standings()).some((x) => !x.you && x.fin < 0 && !x.dnf)) finishRace();
        if (state === 'results' && now - resAt > 1000) {
          resAt = now;
          const key = JSON.stringify(standings().map((x) => [x.fin, x.dnf, Math.round(x.d / 50)]));
          if (key !== resKey) { resKey = key; menu.updateResults(standings()); }
        }
      }
    }
    if (driving() && state !== 'paused' && state !== 'spectate') {
      const tHud = performance.now();
      if (splitActive && p2Car && p2Core) {
        if (state === 'race' && p2RaceCar >= 0) {
          p2Lap = race.update(p2RaceCar, p2Car.body.translation(), ticks * DT - raceT0);
        }
        const p1Label = connectedGamepads().length >= 2 ? 'Pad 1' : 'WASD';
        const p1Extra = raceLaps() > 0 && lap ? `LAP ${Math.min(raceLaps(), lap.laps + 1)}/${raceLaps()}` : (catalog.find((c) => c.id === sel.car)?.name ?? sel.car);
        const p2Extra = raceLaps() > 0 && p2Lap ? `LAP ${Math.min(raceLaps(), p2Lap.laps + 1)}/${raceLaps()}` : (catalog.find((c) => c.id === splitP2CarId)?.name ?? splitP2CarId);
        splitHud.update(
          { kmh: Math.abs(car.out[OUT.speed]) * 3.6, gear: Math.round(car.out[OUT.gear] ?? 0), rpmFrac: (car.out[OUT.rpm] || 800) / Math.max(1000, core.info.redline), label: p1Label, extra: p1Extra },
          { kmh: Math.abs(p2Car.out[OUT.speed]) * 3.6, gear: Math.round(p2Car.out[OUT.gear] ?? 0), rpmFrac: (p2Car.out[OUT.rpm] || 800) / Math.max(1000, p2Core.info.redline), label: p2SourceLabel, extra: p2Extra },
        );
      } else {
        hud.update(now, frame, car.out, core.info, input.assists, damage.last, lap);
      }
      prof.hud += performance.now() - tHud;
    }
    // Graphics tuning (title menu only, behind the cover; see startTuning)
    if (tuning && now >= winStart) frameTimes.push(frame * 1000);   // only while tuning (it grew forever after)
    if (tuning && now - winStart >= WINDOW) {
      const fps = (frameTimes.length * 1000) / (now - winStart);
      const sorted = frameTimes.slice().sort((x, y) => x - y);
      const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
      const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
      frameTimes.length = 0;
      winStart = now;
      quietWindows = citySettled() ? quietWindows + 1 : 0;
      const warm = quietWindows < 2;   // one dry window to settle, one to measure from
      // Judge on the median of the last three windows, not one window: the title camera swings p50 by 10 ms between
      // identical windows (26-39 ms at scale 0.7), and a single bad window used to cost a whole scale step.
      if (!warm) { p50s.push(p50); if (p50s.length > 3) p50s.shift(); }
      const p50med = medianP50();
      // Both the median frame and the window's mean must hold the target: a window whose p50 is fine but whose mean
      // is 29 fps still stutters (p90 spikes from streaming and uploads), and "30 fps locked" is about the mean.
      const low = !warm && (p50med > FRAME_BUDGET || fps < TUNE_TARGET * 1.02), high = !warm && p50med < FRAME_BUDGET * 0.65;
      const log = ((globalThis as { __tuneLog?: unknown[] }).__tuneLog ??= []);
      log.push({ fps: +fps.toFixed(1), p50: Math.round(p50), p50med: Math.round(p50med), p90: Math.round(p90), preset: post.preset, scale, warm });
      if (log.length > 40) log.shift();
      // a single bad window (a shader compile, a texture upload) must not cost a quality tier: two in a row do it
      lowStreak = low ? lowStreak + 1 : 0;
      // phones: pixels above the old 1x picture (scale 0.5 of the 2x canvas) go before any effect does
      // Resolution before effects on every device: a slightly softer picture that keeps SSR, bloom and GTAO reads
      // better than a sharp low preset, and it is where the frame is actually lost (the pinned profile in
      // docs/performance.md is fill-bound: 25.6 -> 31.0 fps from scale 1.0 to 0.8).
      if (warm) { tuneStart = now; }   // the timeout clock runs on measurable windows only
      else if (low && lowStreak >= 2 && isTouch && scale > RES_FLOOR + 1e-6) { applyScale(scale - STEP); wentDown = true; lowStreak = 0; p50s.length = 0; }
      else if (low && lowStreak >= 2 && needsPotato(fps) && goPotato()) return;
      else if (low && lowStreak >= 2 && !presetPinned && presetIdx < PRESET_ORDER.length - 1) { setPreset(presetIdx + 1); wentDown = true; lowStreak = 0; p50s.length = 0; }
      else if (low && lowStreak >= 2 && scale > MIN_SCALE + 1e-6) { applyScale(scale - STEP); wentDown = true; lowStreak = 0; }
      else if (high && isTouch && upSteps > 0 && scale < maxScale - 1e-6) { applyScale(scale + STEP); upSteps--; }
      // done when two windows in a row sit in the band (the frame holds the cap) or when time is up
      okStreak = !warm && !low && !high ? okStreak + 1 : 0;
      if (low && now - tuneStart > TUNE_TIMEOUT && !warm && needsPotato(fps) && goPotato()) return;
      if (okStreak >= 2 || (now - tuneStart > TUNE_TIMEOUT && !warm)) finishTuning();
      else { winStart = now + 1000; setExtra(); }   // let the resize hitch pass before measuring again
    }
    if (heat.tick(Date.now())) renderHeat();   // quiet minutes cool one level; the dial is the state
    prof.total += performance.now() - p0;
    prof.n++;
  });
}

main().catch((e) => {
  console.error(e);
  say('Error: ' + (e instanceof Error ? e.message : String(e)));
});
