// Real-Time Planar Wet-Road Reflections for WebGPU (OpenGrid).
//
// Uses a right-handed virtual reflection camera mirrored vertically across the road plane (y = roadY):
//   - det(viewMatrix) = +1 -> standard front-face winding, ZERO extra render pipelines;
//   - the single-sided upward-facing road surface is naturally back-face culled from underneath;
//   - projecting any wet road pixel `wPos` through `planarViewProj` hits the exact reflected skyscraper,
//     neon billboard, or overhead streetlamp even when it lies outside the main camera's screen frustum;
//   - combined with DepthFx SSR (near-field contact reflections) in a single hybrid wet-road composite.
import * as THREE from 'three/webgpu';
import { pass, uniform } from 'three/tsl';

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _mirrorPos = new THREE.Vector3();
const _mirrorLook = new THREE.Vector3();

export interface PlanarRoadOptions {
  /** Resolution scale relative to the canvas (default 0.32; blurred by asphalt/puddle roughness). */
  resScale?: number;
  /** Render the planar reflection every Nth frame (default 2). */
  every?: number;
}

export class PlanarRoadReflector {
  readonly camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.35, 320);
  readonly passNode: THREE.PassNode;
  readonly viewProj = uniform(new THREE.Matrix4());
  readonly enabled = uniform(1);
  every: number;
  /** Optional hook invoked right before the planar reflection pass renders (e.g. GPU meshlet culling). */
  onBeforeRender: ((cam: THREE.Camera) => void) | null = null;
  private resScale: number;
  private tick = 0;
  private active = true;
  private roadY = 0;

  constructor(scene: THREE.Scene, opts: PlanarRoadOptions = {}) {
    this.resScale = opts.resScale ?? 0.32;
    this.every = opts.every ?? 2;
    this.passNode = pass(scene, this.camera);
    this.passNode.setResolutionScale(this.resScale);

    // Throttle planar pass execution via the same pattern as Post.mirrorPass: no extra draw when inactive.
    const mp = this.passNode as unknown as { updateBefore(f: unknown): unknown };
    const orig = mp.updateBefore.bind(mp);
    mp.updateBefore = (f: unknown) => {
      if (!this.active || this.enabled.value <= 0.001) return undefined;
      if (this.tick++ % Math.max(1, this.every) !== 0) return undefined;
      this.onBeforeRender?.(this.camera);
      return orig(f);
    };
  }

  get textureNode() {
    return this.passNode.getTextureNode('output');
  }

  setEnabled(on: boolean) {
    this.active = on;
    this.enabled.value = on ? 1 : 0;
  }

  setScale(renderScale: number) {
    this.passNode.setResolutionScale(Math.max(0.15, this.resScale * renderScale));
  }

  /**
   * Synchronize the reflected virtual camera to `mainCam` across the horizontal road plane `y = roadY`.
   * Call once per frame before `post.render()`.
   */
  sync(mainCam: THREE.PerspectiveCamera, roadY: number) {
    if (!this.active) return;
    this.roadY = roadY;
    mainCam.updateMatrixWorld();
    _camPos.setFromMatrixPosition(mainCam.matrixWorld);
    mainCam.getWorldDirection(_camDir);
    _lookAt.copy(_camPos).addScaledVector(_camDir, 40);

    // Keep camera strictly above the road plane so the mirror camera stays below it
    const camY = Math.max(_camPos.y, roadY + 0.35);
    _mirrorPos.set(_camPos.x, 2 * roadY - camY, _camPos.z);
    _mirrorLook.set(_lookAt.x, 2 * roadY - _lookAt.y, _lookAt.z);

    this.camera.fov = mainCam.fov;
    this.camera.aspect = mainCam.aspect;
    this.camera.near = Math.max(0.3, Math.min(2.0, (camY - roadY) * 0.45));
    this.camera.far = Math.min(360, mainCam.far);
    this.camera.position.copy(_mirrorPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(_mirrorLook);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this.viewProj.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
  }

  /** Force an immediate planar capture on the next rendered frame (used during warm-up). */
  forceNext() {
    this.tick = 0;
  }

  get planeY() {
    return this.roadY;
  }
}
