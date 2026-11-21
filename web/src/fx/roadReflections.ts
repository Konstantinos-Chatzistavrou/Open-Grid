// Thin Three.js WebGPU adapter for the engine-agnostic Planar Wet-Road Reflection math (`web/src/gpu/reflections/`).
import * as THREE from 'three/webgpu';
import { pass, uniform } from 'three/tsl';
import { computePlanarReflectionCamera, createPlanarCameraOutput } from '../gpu/reflections/planarRoad';

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();

export interface PlanarRoadOptions {
  /** Resolution scale relative to the canvas (default 0.32; blurred by asphalt/puddle roughness). */
  resScale?: number;
  /** Render the planar reflection every Nth frame (default 2). */
  every?: number;
}

export const PROP_DETAIL_LAYER = 2;

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
  private readonly planarOut = createPlanarCameraOutput();

  constructor(scene: THREE.Scene, opts: PlanarRoadOptions = {}) {
    this.resScale = opts.resScale ?? 0.32;
    this.every = opts.every ?? 2;
    // Render ONLY Layer 0 (skyscrapers, facades, neon signs, streetlamps, traffic signals, cars):
    // skips Layer 1 (debris) and Layer 2 (high-poly trees, small props, steam, sparks, pools) for ~40-50% cheaper reflections.
    this.camera.layers.set(0);
    this.passNode = pass(scene, this.camera);
    this.passNode.setResolutionScale(this.resScale);

    const mp = this.passNode as unknown as { updateBefore(f: unknown): unknown };
    const orig = mp.updateBefore.bind(mp);
    mp.updateBefore = (f) => {
      if (!this.active || this.enabled.value <= 0.001) return undefined;
      if (this.tick++ % Math.max(1, this.every) !== 0) return undefined;
      this.onBeforeRender?.(this.camera);
      // Note: never toggle renderer.shadowMap.enabled here — sharing the main pass's shadow state
      // keeps 100% render-pipeline cache hits (toggling it recompiled pipelines every planar frame).
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

  sync(mainCam: THREE.PerspectiveCamera, roadY: number, normal?: [number, number, number], point?: [number, number, number]) {
    if (!this.active) return;
    this.roadY = roadY;
    mainCam.updateMatrixWorld();
    _camPos.setFromMatrixPosition(mainCam.matrixWorld);
    mainCam.getWorldDirection(_camDir);

    const p = computePlanarReflectionCamera(
      {
        camPos: [_camPos.x, _camPos.y, _camPos.z],
        camForward: [_camDir.x, _camDir.y, _camDir.z],
        fovYDeg: mainCam.fov,
        aspect: mainCam.aspect,
        far: mainCam.far,
        roadY,
        normal,
        planePoint: point,
        depthZeroToOne: mainCam.coordinateSystem === THREE.WebGPUCoordinateSystem,
      },
      this.planarOut,
    );

    this.camera.fov = p.fovYDeg;
    this.camera.aspect = p.aspect;
    this.camera.near = p.near;
    this.camera.far = p.far;
    this.camera.position.set(p.position[0], p.position[1], p.position[2]);
    if (normal) this.camera.up.set(normal[0], normal[1], normal[2]); else this.camera.up.set(0, 1, 0);
    this.camera.lookAt(p.lookAt[0], p.lookAt[1], p.lookAt[2]);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    this.viewProj.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
  }

  forceNext() {
    this.tick = 0;
  }

  get planeY() {
    return this.roadY;
  }
}
