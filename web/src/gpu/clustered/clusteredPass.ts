// Standalone Native WebGPU Clustered Forward+ Compute Pass (ZERO Three.js imports).
// Drop directly into any custom WebGPU / TypeScript / WASM engine:
//   const pass = new ClusteredForwardPass(device, { maxLights: 512 });
//   pass.upload(device, camera, lights.length, (i, out) => ...);
//   pass.encode(commandEncoder);
//   // Bind `pass.fragmentBuffers` in your PBR fragment bind group.
import {
  ClusteredLightPacker,
  type ClusterCameraInput,
  type ClusterLightInput,
  type ClusteredGridConfig,
} from './clusteredCpu';
import coreWgsl from './clustered_forward.wgsl?raw';
import computeWgsl from './clustered_compute_standalone.wgsl?raw';

export class ClusteredForwardPass {
  readonly packer: ClusteredLightPacker;
  readonly paramsBuffer: GPUBuffer;
  readonly posRangeBuffer: GPUBuffer;
  readonly colorDecayBuffer: GPUBuffer;
  readonly spotDirCosBuffer: GPUBuffer;
  readonly cullSpheresBuffer: GPUBuffer;
  readonly spotPenumbraBuffer: GPUBuffer;
  readonly zSliceRangesBuffer: GPUBuffer;
  readonly clusterIndexBuffer: GPUBuffer;

  private readonly pipeline: GPUComputePipeline;
  private readonly computeBindGroup: GPUBindGroup;
  private readonly paramsData = new ArrayBuffer(32);
  private readonly paramsU32 = new Uint32Array(this.paramsData, 0, 4);
  private readonly paramsF32 = new Float32Array(this.paramsData, 16, 4);

  constructor(device: GPUDevice, config: Partial<ClusteredGridConfig> = {}) {
    this.packer = new ClusteredLightPacker(config);
    const { maxLights, tilesX, tilesY, zSlices, maxLightsPerCluster } = this.packer.cfg;
    const totalClusters = tilesX * tilesY * zSlices;
    const chunks = this.packer.chunksPerCluster;

    const mkStorage = (byteSize: number, label: string, writeOnlyGpu = false) =>
      device.createBuffer({
        label,
        size: Math.max(16, byteSize),
        usage: writeOnlyGpu
          ? GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
          : GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

    this.paramsBuffer = device.createBuffer({
      label: 'ClusteredForward.params',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.posRangeBuffer = mkStorage(maxLights * 16, 'ClusteredForward.posRange');
    this.colorDecayBuffer = mkStorage(maxLights * 16, 'ClusteredForward.colorDecay');
    this.spotDirCosBuffer = mkStorage(maxLights * 16, 'ClusteredForward.spotDirCos');
    this.cullSpheresBuffer = mkStorage(maxLights * 16, 'ClusteredForward.cullSpheres');
    this.spotPenumbraBuffer = mkStorage(maxLights * 4, 'ClusteredForward.spotPenumbra');
    this.zSliceRangesBuffer = mkStorage(zSlices * 16, 'ClusteredForward.zSliceRanges');
    this.clusterIndexBuffer = mkStorage(totalClusters * chunks * 16, 'ClusteredForward.clusterIndices', true);

    const module = device.createShaderModule({
      label: 'ClusteredForward.compute',
      code: `${coreWgsl}\n\n${computeWgsl}`,
    });

    this.pipeline = device.createComputePipeline({
      label: 'ClusteredForward.pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    this.computeBindGroup = device.createBindGroup({
      label: 'ClusteredForward.computeBG',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.cullSpheresBuffer } },
        { binding: 2, resource: { buffer: this.zSliceRangesBuffer } },
        { binding: 3, resource: { buffer: this.clusterIndexBuffer } },
      ],
    });

    this.paramsU32[0] = tilesX;
    this.paramsU32[1] = tilesY;
    this.paramsU32[2] = zSlices;
    this.paramsU32[3] = maxLightsPerCluster;
  }

  /** Upload camera frustum uniforms and active dynamic lights to the GPU. */
  upload(
    device: GPUDevice,
    camera: ClusterCameraInput,
    lightCount: number,
    readLight: (index: number, out: ClusterLightInput) => boolean,
  ): number {
    const active = this.packer.pack(camera, lightCount, readLight);
    const proj = camera.projectionMatrix;
    this.paramsF32[0] = Math.max(camera.near, 0.01);
    this.paramsF32[1] = Math.max(camera.far, this.paramsF32[0] + 1);
    this.paramsF32[2] = proj[0] !== 0 ? 1.0 / proj[0] : 1.0;
    this.paramsF32[3] = proj[5] !== 0 ? 1.0 / proj[5] : 1.0;

    device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsData);
    device.queue.writeBuffer(this.zSliceRangesBuffer, 0, this.packer.zSliceRanges as unknown as GPUAllowSharedBufferSource);
    if (active > 0) {
      device.queue.writeBuffer(this.posRangeBuffer, 0, this.packer.posRange.subarray(0, active * 4) as unknown as GPUAllowSharedBufferSource);
      device.queue.writeBuffer(this.colorDecayBuffer, 0, this.packer.colorDecay.subarray(0, active * 4) as unknown as GPUAllowSharedBufferSource);
      device.queue.writeBuffer(this.spotDirCosBuffer, 0, this.packer.spotDirCos.subarray(0, active * 4) as unknown as GPUAllowSharedBufferSource);
      device.queue.writeBuffer(this.cullSpheresBuffer, 0, this.packer.cullSpheres.subarray(0, active * 4) as unknown as GPUAllowSharedBufferSource);
      device.queue.writeBuffer(this.spotPenumbraBuffer, 0, this.packer.spotPenumbra.subarray(0, active) as unknown as GPUAllowSharedBufferSource);
    }
    return active;
  }

  /** Encode the Clustered Forward+ compute dispatch into any WebGPU command encoder. */
  encode(encoder: GPUCommandEncoder) {
    const total = this.packer.stats.totalClusters;
    const pass = encoder.beginComputePass({ label: 'ClusteredForwardPlusCull' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(total / 64));
    pass.end();
  }

  /** Buffers required by a PBR fragment shader to shade clustered lights. */
  get fragmentBuffers() {
    return {
      params: this.paramsBuffer,
      clusterIndices: this.clusterIndexBuffer,
      posRange: this.posRangeBuffer,
      colorDecay: this.colorDecayBuffer,
      spotDirCos: this.spotDirCosBuffer,
      spotPenumbra: this.spotPenumbraBuffer,
    };
  }

  destroy() {
    this.paramsBuffer.destroy();
    this.posRangeBuffer.destroy();
    this.colorDecayBuffer.destroy();
    this.spotDirCosBuffer.destroy();
    this.cullSpheresBuffer.destroy();
    this.spotPenumbraBuffer.destroy();
    this.zSliceRangesBuffer.destroy();
    this.clusterIndexBuffer.destroy();
  }
}
