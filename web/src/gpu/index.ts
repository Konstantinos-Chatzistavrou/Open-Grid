// Engine-Agnostic WebGPU Rendering Core (OpenGrid).
// ZERO Three.js imports — portable to any custom WebGPU, TypeScript, or Rust/wgpu engine.

export * from './math';

export {
  ClusteredLightPacker,
  DEFAULT_CLUSTERED_CONFIG,
  type ClusterCameraInput,
  type ClusterLightInput,
  type ClusteredForwardStats,
  type ClusteredGridConfig,
} from './clustered/clusteredCpu';
export { ClusteredForwardPass } from './clustered/clusteredPass';

export {
  CAR_PAINT_FINISHES,
  CAR_PAINT_UBO_BYTES,
  CAR_PAINT_UBO_FLOATS,
  advancePaintWear,
  carPaintWgslSource,
  packCarPaintUniforms,
  type CarPaintFinishName,
  type CarPaintFinishSpec,
  type CarPaintUniformData,
  type PaintWearAccumulator,
} from './materials/carPaint';

export {
  computePlanarReflectionCamera,
  createPlanarCameraOutput,
  roadReflectionsWgslSource,
  type PlanarCameraInput,
  type PlanarCameraOutput,
} from './reflections/planarRoad';

export {
  MLET_MAGIC,
  MLET_VERSION,
  parseMletBuffer,
  type MeshletBatchGpuStats,
  type MletGroupMeta,
  type MletMeta,
  type ParsedMlet,
} from './meshlets/mletFormat';
export { GpuMeshletPass, type GpuMeshletUpload } from './meshlets/meshletPass';
