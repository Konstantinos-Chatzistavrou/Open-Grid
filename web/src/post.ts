// Post-processing (TSL, WebGPU): scene (HDR, at the RENDER scale) -> + bloom -> tone map (AgX) ->
// anti-aliasing -> contrast-adaptive sharpening upscale to the full canvas.
// Kept deliberately small: a filmic stack (TRAA, motion blur, grading, chromatic aberration,
// vignette) was tried and removed - on the laptop iGPU it cost ~25 % of the frame and, at full
// screen, pushed frames past the 33 ms budget (stutter), and the user didn't want the look.
//
// Resolution model (2026-10-18, after docs/threejspunk_notes.md): the CANVAS always runs at the
// full (capped) pixel ratio; only the scene pass and the post passes before the upscale render at
// `scale` x the canvas. The last pass samples that image with 5 bilinear taps one source texel
// apart and applies RCAS-style sharpening (AMD FidelityFX CAS/RCAS limiter, ported from three's
// SharpenNode), so a 0.7 render is upscaled ONCE, in the shader, instead of being stretched
// bilinearly by the browser compositor (soft, the old path). Every expensive pass has its own
// resolution: bloom at 0.25 of the render (it is a blur), AA at the render size.
//
// Quality presets (the adaptive system lowers these BEFORE the resolution): each preset is its own
// RenderPipeline built and compiled at load; they share the one scene pass. Switching preset only
// changes which pipeline renders: no material, light set or pipeline changes, no recompiles, no
// render-target resizes of the scene. Measured: switching costs no frame over the normal budget.
import * as THREE from 'three/webgpu';
import { Fn, clamp, float, int, log, max, min, mix, pass, positionView, rtt, screenUV, step, textureSize, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import * as SMAAModule from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { CURVES, GRADE, LOOKS, applyLook, filmGrain, toneGrade, type CurveName } from './fx/grade';
import { DepthFx } from './fx/depthFx';
import { PROP_DETAIL_LAYER, PlanarRoadReflector } from './fx/roadReflections';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
export { ClusteredForwardLighting, type ClusteredForwardStats } from './fx/clusteredForward';
export { PROP_DETAIL_LAYER };

export type PresetName = 'max' | 'ultra' | 'high' | 'medium' | 'low' | 'potato';
export interface Preset {
  aa: 'smaa' | 'fxaa' | 'traa' | 'none';
  /** half-resolution GTAO (ultra only; uses its own MRT scene pass, see fx/gtaoTraa.ts) */
  ao?: boolean;
  /** bloom resolution relative to the RENDER size; 0 = no bloom */
  bloom: number;
  /** headlight shadow map re-rendered every Nth frame (see main.ts) */
  shadowEvery: number;
  /** fx/grade.ts: 'full' = contrast/saturation/split tone, 'tone' = tone curve only */
  grade: 'full' | 'tone';
  /** animated film grain in the final pass */
  grain: boolean;
  /** screen-space reflections on wet road / glass (fx/ssr.ts); rides on the ultra MRT pass (needs `ao`) */
  ssr?: boolean;
  /** optional bloom overrides (defaults in BLOOM): a preset is where the halo is biased toward emitters */
  bloomStrength?: number; bloomRadius?: number; bloomThreshold?: number; bloomKnee?: number;
  /** no intermediate targets: tone curve in the output pass, bilinear upscale (potato) */
  direct?: boolean;
}
// Ordered best -> cheapest. The GPU cost differences are small but real on the iGPU (measured with
// timestamp queries, see docs/web_port.md): SMAA = 3 passes, FXAA = 1, bloom = ~11 small passes.
export const PRESETS: Record<PresetName, Preset> = {
  // The bloom numbers are per preset and bias the halo to emitters (see BLOOM): the better the preset, the more
  // the signs are allowed to bloom and the less the car body washes out.
  max: { aa: 'smaa', ao: true, ssr: true, bloom: 0.25, shadowEvery: 2, grade: 'full', grain: true, bloomStrength: 0.72, bloomRadius: 0.62, bloomThreshold: 1.45 },
  ultra: { aa: 'smaa', ssr: true, bloom: 0.25, shadowEvery: 2, grade: 'full', grain: true, bloomStrength: 0.52, bloomRadius: 0.56, bloomThreshold: 1.52 },
  high: { aa: 'smaa', bloom: 0.25, shadowEvery: 3, grade: 'full', grain: true, bloomStrength: 0.38, bloomRadius: 0.52, bloomThreshold: 1.50 },
  medium: { aa: 'fxaa', bloom: 0.25, shadowEvery: 3, grade: 'full', grain: false, bloomStrength: 0.32, bloomRadius: 0.5, bloomThreshold: 1.40 },
  low: { aa: 'none', bloom: 0, shadowEvery: 4, grade: 'tone', grain: false },
  // Weak phones (Mali-G57 class): the scene pass is tone-mapped straight to the canvas, one fullscreen pass in all.
  // Everything else that makes it cheap is decided at boot in main.ts (no shadows, short rings, 1x canvas).
  potato: { aa: 'none', bloom: 0, shadowEvery: 4, grade: 'tone', grain: false, direct: true },
};
/** final-image look defaults (fx/grade.ts); ?tm=agx|aces|neutral|uchimura, ?grade=0 for A/B */
const DEFAULT_CURVE: CurveName = 'neutral';
// Emitter-biased bloom (docs/art_direction.md). The old threshold of 1.0 bloomed everything bright, which washed
// the car's paint into a haze. 1.45 keeps the car body's diffuse and most speculars under the threshold while neon
// signs, lamp bulbs, headlights and tail lights (emissive >= 1.5) still bloom; strength and radius go up so the
// remaining halo reads bigger, the way Underground's signs bleed. Trade-off: the car loses its soft overall glow -
// if the signs feel dim, lower ?bt= (or raise the signs' emissive in the city materials). Presets tune the numbers
// above; ?bs= ?br= ?bt= ?bk= override all of them for an A/B.
const BLOOM = { strength: 0.62, radius: 0.58, threshold: 1.45, knee: 0.55 };
/**
 * The presets THIS session builds pipelines for, best -> cheapest. Normally the five below; a potato boot (main.ts)
 * replaces the list with ['potato'] before anything is built, so a weak phone compiles one small pipeline instead of
 * five (GTAO, SSR, SMAA and bloom never reach its shader compiler). Leaving potato needs a reload.
 */
export const PRESET_ORDER: PresetName[] = ['max', 'ultra', 'high', 'medium', 'low'];
export const ALL_PRESETS: PresetName[] = ['max', 'ultra', 'high', 'medium', 'low', 'potato'];
export function usePotatoOnly() { PRESET_ORDER.length = 0; PRESET_ORDER.push('potato'); }

export interface PostOptions { bloom: boolean; aa: boolean; scale: number; preset: PresetName }

type BloomNode = ReturnType<typeof bloom>;
interface BloomParams { strength: number; radius: number; threshold: number; knee: number }
type BloomUniforms = { strength: { value: number }; radius: { value: number }; threshold: { value: number }; smoothWidth: { value: number } };
// The JS module default-exports the class; @types/three declares a named export.
type SMAALike = THREE.TempNode<'vec4'> & { setSize(w: number, h: number): void; getTextureNode(): THREE.TextureNode };
const SMAANode = (SMAAModule as unknown as { default: new (t: THREE.Node) => SMAALike }).default;

/** SMAA that sizes its targets from the render scale (stock SMAANode uses the full drawing buffer). */
export class ScaledSMAA extends SMAANode {
  scale = 1;
  constructor(t: THREE.Node) {
    super(t);
    // display-referred 0..1 data (as in the SMAA reference): 8 bit, half the bandwidth of half-float
    const self = this as unknown as Record<string, THREE.RenderTarget>;
    for (const k of ['_renderTargetEdges', '_renderTargetWeights', '_renderTargetBlend']) self[k].texture.type = THREE.UnsignedByteType;
  }
  setSize(width: number, height: number) { super.setSize(Math.max(1, Math.floor(width * this.scale)), Math.max(1, Math.floor(height * this.scale))); }
}

/**
 * Clustered lighting that works at any render scale WITHOUT rebuilding. The stock node bakes the
 * grid size (from the drawing buffer) into every lit material's fragment shader and finds a
 * fragment's tile from its PIXEL coordinate / 32: a scaled scene pass would look lights up in the
 * wrong tiles, and resizing the grid recompiled every lit material (measured 1.0-1.9 s freeze per
 * scale step - most of what the old setPixelRatio "resize hitch" was). Here the grid stays at the
 * full canvas size and the fragment finds its tile from screenUV (0..1, resolution independent),
 * which also matches the compute pass's tile -> NDC mapping exactly.
 */
const FIXED_GRID = [1920, 1088] as const;   // drawing-buffer size the cluster grid is built for (multiple of the 32 px tile)

export class ScaledClusteredLighting extends ClusteredLighting {
  private plain = new WeakMap<object, THREE.LightsNode>();
  /**
   * `grid`: the drawing-buffer size the clusters are laid out for (tiles of `tileSize` px). The compute pass that
   * sorts lights into clusters costs per cluster, every frame, whatever the picture: 60 x 34 x 24 clusters by default
   * (1.2-1.8 ms on the i3 iGPU). Potato passes a 30 x 17 x 12 grid: an eighth of that, with coarser light lists.
   */
  constructor(maxLights = 1024, tileSize = 32, zSlices = 24, maxLightsPerCluster = 64, private grid: readonly [number, number] = FIXED_GRID) {
    super(maxLights, tileSize, zSlices, maxLightsPerCluster);
  }
  /**
   * A scene flagged `userData.plainLights` (the garage) gets an ordinary forward LightsNode: it has two lights, and
   * clusters are built for one camera - its mirror and cube renders would look lights up in the wrong tiles.
   */
  getNode(scene: THREE.Scene) {
    if ((scene as { isScene?: boolean }).isScene && scene.userData?.plainLights) {
      let n = this.plain.get(scene);
      if (!n) { n = new THREE.LightsNode(); this.plain.set(scene, n); }
      return n as unknown as ReturnType<ClusteredLighting['getNode']>;
    }
    return super.getNode(scene);
  }
  createNode(lights: THREE.Light[] = []) {
    type CL = {
      create(w: number, h: number): void; tileSize: number; zSlices: number; _bufferSize: unknown;
      updateProgram(r: unknown): void; setSize(w: number, h: number): unknown;
      _screenClusterIndex: THREE.Node; _cameraNear: THREE.Node<'float'>; _cameraFar: THREE.Node<'float'>;
    };
    const node = super.createNode(lights) as unknown as CL;
    const create = node.create.bind(node);
    node.create = (w: number, h: number) => {
      create(w, h);
      const NX = Math.floor(w / node.tileSize), NY = Math.floor(h / node.tileSize), NZ = node.zSlices;
      node._screenClusterIndex = Fn(() => {
        const tile = screenUV.mul(vec2(NX, NY)).floor().min(vec2(NX - 1, NY - 1));
        const viewDepth = positionView.z.negate();
        const invLog = float(1).div(log(node._cameraFar.div(node._cameraNear)));
        const zSlice = clamp(log(viewDepth.div(node._cameraNear)).mul(invLog).mul(NZ).floor(), 0, NZ - 1);
        return int(tile.x).add(int(tile.y).mul(NX)).add(int(zSlice).mul(NX * NY));
      })().toVar();
    };
    // One grid for every canvas size: tiles are found from screenUV, so the grid need not follow the drawing buffer,
    // and rebuilding it recompiles every lit material (measured: 4 s frozen when going fullscreen). 60 x 34 tiles
    // (a 1080p layout; tiles stretch a little on other aspects and sizes, the light lists stay exact).
    node.updateProgram = () => { if (node._bufferSize === null || node._bufferSize === undefined) node.create(this.grid[0], this.grid[1]); };
    node.setSize = () => node;
    return node as unknown as ReturnType<ClusteredLighting['createNode']>;
  }
}

/**
 * Single-pass upscale + RCAS sharpening. src: a display-referred (tone-mapped, sRGB) texture at
 * the render size; evaluated per CANVAS pixel. The 5 taps are bilinear and one SOURCE texel apart,
 * so at scale 1 it is plain RCAS and at 0.7 it reconstructs and sharpens in one go (no extra
 * render target). sharpness: 0 = strongest, 2 = none (RCAS convention).
 */
export function casUpscale(src: THREE.TextureNode, sharpness: THREE.UniformNode<'float', number>, grain: boolean, finish?: (rgb: THREE.Node<'vec3'>) => THREE.Node<'vec3'>) {
  return Fn(() => {
    const t = vec2(1).div(vec2(textureSize(src) as unknown as THREE.Node<'ivec2'>));
    const p = uv();
    const e = src.sample(p), b = src.sample(p.sub(vec2(0, t.y))), h = src.sample(p.add(vec2(0, t.y)));
    const d = src.sample(p.sub(vec2(t.x, 0))), f = src.sample(p.add(vec2(t.x, 0)));
    const mn4 = min(min(b.rgb, d.rgb), min(f.rgb, h.rgb)).toConst();
    const mx4 = max(max(b.rgb, d.rgb), max(f.rgb, h.rgb)).toConst();
    // RCAS limiter: the negative lobe is as strong as the local contrast allows without clipping
    const hitMin = min(mn4, e.rgb).div(mx4.mul(4).max(1e-4)).toConst();
    const hitMax = vec3(1).sub(max(mx4, e.rgb)).div(mn4.mul(4).sub(4).min(-1e-4)).toConst();
    const lobeRGB = max(hitMin.negate(), hitMax).toConst();
    const lobe = max(float(-(0.25 - 1 / 16)), min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0)).mul(sharpness.negate().exp2()).toConst();
    const rgb = b.rgb.add(d.rgb).add(f.rgb).add(h.rgb).mul(lobe).add(e.rgb).div(lobe.mul(4).add(1));
    const done = finish ? finish(rgb as unknown as THREE.Node<'vec3'>) : (rgb as unknown as THREE.Node<'vec3'>);
    return vec4(grain ? filmGrain(done) : done, 1);
  })();
}

/** Render-to-texture in 8 bit: everything after the tone map is display-referred (0..1, sRGB). */
export const rtt8 = (n: THREE.Node) => rtt(n, null, null, { type: THREE.UnsignedByteType }) as unknown as THREE.RTTNode;

export class Post {
  private scenePass: THREE.PassNode;
  private pipelines = new Map<PresetName, THREE.RenderPipeline>();
  private blooms: { node: BloomNode; res: number }[] = [];
  /** Presets drawn with the shared bloom node -> the uniforms render() sets before drawing them. */
  private bloomFor = new Map<PresetName, { node: BloomNode; p: BloomParams }>();
  private bloomApplied: PresetName | null = null;
  private scaled: { setResolutionScale(s: number): unknown }[] = [];
  private smaas: ScaledSMAA[] = [];
  private maxFx: DepthFx | null = null;
  private depthFx: DepthFx | null = null;
  /** Real-time planar wet-road reflection pass (hybridized with DepthFx SSR on max/ultra). */
  readonly planarRoad: PlanarRoadReflector | null = null;
  /** Shared world position of the player car (mutated in-place by main.ts so DepthFx masks car roof ripples & underbody SSR). */
  readonly carPos = new THREE.Vector3(0, -100, 0);
  private sharpness = uniform(0.5);
  private _scale = 1;
  preset: PresetName;
  /**
   * Rear-view mirror: a second scene pass from a camera at the car's tail (main.ts places it every frame), drawn into
   * a strip of the final image. `mirrorRect` is that strip in screen UV (x0, y0, x1, y1; y down from the top) - main.ts
   * copies it from the #mirror element, so CSS decides where the mirror is. The pass has the main pass's target
   * formats, so it compiles no pipeline of its own; it renders only while `mirror` is on, every `mirrorEvery`-th frame.
   */
  readonly mirrorCam = new THREE.PerspectiveCamera(28, 3.4, 0.25, 230);
  readonly mirrorRect = uniform(new THREE.Vector4(0.37, 0.03, 0.63, 0.17));
  mirrorEvery = 1;
  private mirrorMix = uniform(0);
  private mirrorPass!: THREE.PassNode;
  private mirrorTick = 0;
  get mirror() { return this.mirrorMix.value > 0; }
  set mirror(on: boolean) { this.mirrorMix.value = on ? 1 : 0; }

  /** Optional hook called immediately before any scene pass (main, planar road reflection, rear-view mirror) renders. */
  onBeforeScenePass: ((cam: THREE.Camera) => void) | null = null;

  private buildPipelineFn: (name: PresetName) => THREE.RenderPipeline;

  constructor(private renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, private opts: PostOptions) {
    this.scenePass = pass(scene, camera);
    {
      const sp = this.scenePass as unknown as { updateBefore(f: unknown): unknown };
      const origScene = sp.updateBefore.bind(sp);
      sp.updateBefore = (f) => {
        this.onBeforeScenePass?.(camera);
        return origScene(f);
      };
    }
    const color = this.scenePass.getTextureNode('output');
    const q = new URLSearchParams(location.search);
    const curve: CurveName = (CURVES as string[]).includes(q.get('tm') ?? '') ? (q.get('tm') as CurveName) : DEFAULT_CURVE;
    const grading = q.get('grade') !== '0';
    // ?look=underground applies the named grade (fx/grade.ts) first, so the individual ?contrast= etc. still win
    const look = q.get('look');
    if (look && look in LOOKS) applyLook(look as keyof typeof LOOKS);
    for (const k of ['contrast', 'sat', 'split', 'grain', 'lift', 'exposure'] as const) if (q.has(k)) (GRADE[k] as { value: number }).value = Number(q.get(k));
    const bloomStrength = Number(q.get('bs') ?? BLOOM.strength), bloomRadius = Number(q.get('br') ?? BLOOM.radius);
    const bloomThreshold = Number(q.get('bt') ?? BLOOM.threshold), bloomKnee = Number(q.get('bk') ?? BLOOM.knee);
    // Presets whose bloom input is the plain scene colour (high, medium) share ONE BloomNode and, for grade 'full', one
    // tone-mapped target: their bloom numbers differ only in uniforms (strength, radius, threshold, knee), which
    // render() sets for the preset being drawn. Saves a bloom chain (11 targets) and a render-size RGBA8 target of VRAM
    // and their warm-up; no shader differs, so switching between them compiles nothing. max/ultra bloom their own
    // reflection-lit colour (a different input node), so they keep their own BloomNode.
    let sharedBloom: BloomNode | null = null;
    let sharedBloomRes = 0;
    let sharedTonedFull: THREE.RTTNode | null = null;
    const ssrOn = q.get('ssr') !== '0';
    const planarOn = q.get('planar') !== '0' && ssrOn && PRESET_ORDER.some((n) => PRESETS[n].ssr);
    const aoOn = q.get('ao') !== '0';
    if (planarOn) {
      this.planarRoad = new PlanarRoadReflector(scene, { resScale: 0.32, every: 2 });
      this.planarRoad.onBeforeRender = (cam) => this.onBeforeScenePass?.(cam);
    }
    // the mirror: its own small pass, composited last (after the upscale: it is drawn at its own resolution)
    this.mirrorPass = pass(scene, this.mirrorCam);
    {
      const mp = this.mirrorPass as unknown as { updateBefore(f: unknown): unknown };
      const render = mp.updateBefore.bind(mp);
      mp.updateBefore = (f) => {
        if (this.mirrorMix.value > 0 && this.mirrorTick++ % Math.max(1, this.mirrorEvery) === 0) {
          this.onBeforeScenePass?.(this.mirrorCam);
          return render(f);
        }
        return undefined;
      };
    }
    const mr = this.mirrorRect, su = screenUV;
    // a mirror: left and right swapped
    const mUv = vec2(float(1).sub(su.x.sub(mr.x).div(mr.z.sub(mr.x))), su.y.sub(mr.y).div(mr.w.sub(mr.y)));
    const mImg = toneGrade(this.mirrorPass.getTextureNode('output').sample(mUv), curve, false);
    const mIn = step(mr.x, su.x).mul(step(su.x, mr.z)).mul(step(mr.y, su.y)).mul(step(su.y, mr.w)).mul(this.mirrorMix);
    const withMirror = (base: THREE.Node) => mix(base as THREE.Node<'vec4'>, vec4(mImg.rgb.mul(0.94), 1), mIn);
    const buildOne = (name: PresetName): THREE.RenderPipeline => {
      const existing = this.pipelines.get(name);
      if (existing) return existing;
      const pr = PRESETS[name];
      const p = new THREE.RenderPipeline(renderer);
      if (pr.direct) {
        p.outputColorTransform = false;
        p.outputNode = withMirror(toneGrade(color, curve, false));
        this.pipelines.set(name, p);
        return p;
      }
      const fx = pr.ao && pr.ssr && ssrOn
        ? (this.maxFx ??= new DepthFx(this.scenePass, camera, { resScale: 0.75, quality: 0.3, maxDistance: 85, intensity: 0.72, withAo: aoOn, carPos: this.carPos, planar: this.planarRoad, planarIntensity: 0.56 }))
        : null;
      const lite = !fx && pr.ssr && ssrOn
        ? (this.depthFx ??= new DepthFx(this.scenePass, camera, { resScale: 0.5, quality: 0.16, maxDistance: 55, intensity: 0.6, carPos: this.carPos, planar: this.planarRoad, planarIntensity: 0.44 }))
        : null;
      let lit: THREE.Node<'vec4'> = fx ? fx.color : lite ? lite.color : color;
      const bp: BloomParams = {
        strength: pr.bloomStrength ?? bloomStrength, radius: pr.bloomRadius ?? bloomRadius,
        threshold: pr.bloomThreshold ?? bloomThreshold, knee: pr.bloomKnee ?? bloomKnee,
      };
      const plainInput = !fx && !lite;
      let onSharedBloom = false;
      if (opts.bloom && pr.bloom > 0) {
        if (plainInput && sharedBloom && sharedBloomRes === pr.bloom) {
          lit = lit.add(sharedBloom);
          this.bloomFor.set(name, { node: sharedBloom, p: bp });
          onSharedBloom = true;
        } else {
          const b = bloom(lit, bp.strength, bp.radius, bp.threshold);
          (b as unknown as { smoothWidth: { value: number } }).smoothWidth.value = bp.knee;
          this.blooms.push({ node: b, res: pr.bloom });
          if (plainInput) {
            sharedBloom = b; sharedBloomRes = pr.bloom; onSharedBloom = true;
            this.bloomFor.set(name, { node: b, p: bp });
          }
          lit = lit.add(b);
        }
      }
      let toned: THREE.RTTNode;
      if (onSharedBloom && pr.grade === 'full' && sharedTonedFull) {
        toned = sharedTonedFull;   // same graph: colour + the shared bloom, full grade
      } else {
        toned = rtt8(toneGrade(lit, curve, pr.grade === 'full' && grading));
        this.scaled.push(toned);
        if (onSharedBloom && pr.grade === 'full') sharedTonedFull = toned;
      }
      let src: THREE.TextureNode = toned;
      const aa = opts.aa ? pr.aa : 'none';
      if (aa === 'smaa' || aa === 'traa') {
        const s = new ScaledSMAA(toned);
        this.smaas.push(s);
        src = s.getTextureNode();
      } else if (aa === 'fxaa') {
        const fxNode = rtt8(fxaa(toned));
        this.scaled.push(fxNode);
        src = fxNode;
      }
      p.outputColorTransform = false;
      p.outputNode = withMirror(casUpscale(src, this.sharpness, pr.grain && grading));
      this.pipelines.set(name, p);
      return p;
    };
    this.buildPipelineFn = buildOne;
    for (const name of PRESET_ORDER) buildOne(name);
    // Always pre-build the ultra-lightweight 'potato' direct pass so switching into potato NEVER needs a page reload!
    if (!this.pipelines.has('potato')) buildOne('potato');
    this.preset = opts.preset;
    this.setScale(opts.scale);
  }

  /** Lazily ensure any graphics preset pipeline (including switching into/out of potato) is built without reloading! */
  ensurePreset(name: PresetName) {
    if (!this.pipelines.has(name)) {
      this.buildPipelineFn(name);
      this.setScale(this._scale);
    }
  }

  /**
   * The render target the street is really drawn into. Pipelines are keyed by their target's formats, so a precompile
   * (renderer.compileAsync) must run with THIS target set or it builds pipelines nothing ever uses (main.ts compileFor).
   */
  get sceneTarget(): THREE.RenderTarget { return this.scenePass.renderTarget as THREE.RenderTarget; }

  get scale() { return this._scale; }

  /** Render scale of everything before the upscale. Resizes render targets: only at the allowed points. */
  setScale(s: number) {
    this._scale = s;
    this.scenePass.setResolutionScale(s);
    // Match the actual top-center mirror strip (~22% screen width): ~3.5x less pixel fill with crisp car/road visibility!
    this.mirrorPass.setResolutionScale(Math.min(0.24, 0.08 + 0.16 * s));
    this.maxFx?.setScale(s);
    this.depthFx?.setScale(s);
    this.planarRoad?.setScale(s);
    for (const r of this.scaled) r.setResolutionScale(s);
    for (const m of this.smaas) m.scale = s;
    for (const b of this.blooms) b.node.setResolutionScale(b.res * s);
    // full-resolution image: a light touch only (RCAS at 1:1 sharpens texture noise); reduced: stronger
    this.sharpness.value = s >= 0.99 ? 1.0 : 0.5;
  }

  /** Sync real-time planar road reflection camera to the current main camera & road height. */
  syncRoadReflection(camera: THREE.PerspectiveCamera, roadY: number, normal?: [number, number, number], point?: [number, number, number]) {
    if (!this.planarRoad) return;
    const pr = PRESETS[this.preset];
    const active = !!pr.ssr;
    this.planarRoad.setEnabled(active);
    this.planarRoad.every = this.preset === 'max' ? 1 : 2;
    if (active) this.planarRoad.sync(camera, roadY, normal, point);
  }

  /** called with the preset before every render */
  onPreset: ((p: PresetName) => void) | null = null;
  render() {
    this.onPreset?.(this.preset);
    this.ensurePreset(this.preset);
    if (this.bloomApplied !== this.preset) {
      // the shared bloom node carries the numbers of whichever preset drew last: switch them with the preset (uniforms only)
      const e = this.bloomFor.get(this.preset);
      if (e) {
        const u = e.node as unknown as BloomUniforms;
        u.strength.value = e.p.strength; u.radius.value = e.p.radius; u.threshold.value = e.p.threshold; u.smoothWidth.value = e.p.knee;
      }
      this.bloomApplied = this.preset;
    }
    this.pipelines.get(this.preset)!.render();
  }

  /** Renders active/fallback presets once (shader warm-up behind the loading screen). */
  warmup() {
    const keep = this.preset;
    for (const name of PRESET_ORDER) { this.preset = name; this.render(); }
    this.preset = keep;
  }

  /** Same, one preset per real frame so per-frame nodes initialize without redundant loops. */
  async warmupFrames() {
    const keep = this.preset;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    // every preset: the in-race fallback (phones: medium -> low) must never build pipelines with a car on screen (6.5 s measured)
    for (const name of PRESET_ORDER) { this.preset = name; this.render(); await frame(); }
    this.preset = keep;
  }
}
