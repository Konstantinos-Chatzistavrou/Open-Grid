// Standalone Native WebGPU Meshlet Compute Culler + drawIndexedIndirect Pass (ZERO Three.js imports).
// Drop directly into any custom WebGPU / TypeScript / WASM engine:
//   const pass = GpuMeshletPass.fromParsedMlet(device, parsedMlet);
//   pass.encodeCull(device, commandEncoder, viewProjMat4, camPos);
//   pass.draw(renderPassEncoder); // calls setIndexBuffer + drawIndexedIndirect(indirectBuffer, 0)
import { extractFrustumPlanes, type Mat4Like, type Vec3Tuple } from '../math';
import type { MeshletBatchGpuStats, ParsedMlet } from './mletFormat';
import coreWgsl from './meshlet_cull.wgsl?raw';
import standaloneWgsl from './meshlet_cull_standalone.wgsl?raw';

export interface GpuMeshletUpload {
  indices: Uint32Array;
  spheres: Float32Array;
  cones: Float32Array;
  apices: Float32Array;
  slices: Uint32Array;
  meshletCount: number;
}

const CULL_UBO_BYTES = (6 * 4 + 4 + 4) * 4; // 128 bytes

export class GpuMeshletPass {
  readonly meshletCount: number;
  readonly totalIndices: number;

  readonly uniformBuffer: GPUBuffer;
  readonly spheresBuffer: GPUBuffer;
  readonly conesBuffer: GPUBuffer;
  readonly apicesBuffer: GPUBuffer;
  readonly slicesBuffer: GPUBuffer;
  readonly sourceIndexBuffer: GPUBuffer;
  /** Compacted surviving index buffer (GPUBufferUsage.INDEX | STORAGE). */
  readonly visibleIndexBuffer: GPUBuffer;
  /** 5-word DrawIndexedIndirectArgs buffer (GPUBufferUsage.INDIRECT | STORAGE). */
  readonly indirectBuffer: GPUBuffer;
  readonly statsBuffer: GPUBuffer;

  private readonly resetPipeline: GPUComputePipeline;
  private readonly cullPipeline: GPUComputePipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly uboRaw = new ArrayBuffer(CULL_UBO_BYTES);
  private readonly uboF32 = new Float32Array(this.uboRaw);
  private readonly uboU32 = new Uint32Array(this.uboRaw);
  private readonly planesScratch = new Float32Array(24);

  constructor(device: GPUDevice, data: GpuMeshletUpload) {
    this.meshletCount = data.meshletCount;
    this.totalIndices = data.indices.length;

    const mkBuf = (arr: ArrayBufferView, usage: GPUBufferUsageFlags, label: string) => {
      const size = Math.max(16, (arr.byteLength + 15) & ~15);
      const buf = device.createBuffer({ label, size, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, arr as unknown as GPUAllowSharedBufferSource);
      return buf;
    };

    this.uniformBuffer = device.createBuffer({
      label: 'GpuMeshletPass.uniforms',
      size: CULL_UBO_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.spheresBuffer = mkBuf(data.spheres, GPUBufferUsage.STORAGE, 'GpuMeshletPass.spheres');
    this.conesBuffer = mkBuf(data.cones, GPUBufferUsage.STORAGE, 'GpuMeshletPass.cones');
    this.apicesBuffer = mkBuf(data.apices, GPUBufferUsage.STORAGE, 'GpuMeshletPass.apices');
    this.slicesBuffer = mkBuf(data.slices, GPUBufferUsage.STORAGE, 'GpuMeshletPass.slices');
    this.sourceIndexBuffer = mkBuf(data.indices, GPUBufferUsage.STORAGE, 'GpuMeshletPass.sourceIndices');

    this.visibleIndexBuffer = device.createBuffer({
      label: 'GpuMeshletPass.visibleIndices',
      size: Math.max(16, data.indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.indirectBuffer = device.createBuffer({
      label: 'GpuMeshletPass.indirectArgs',
      size: 20,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.statsBuffer = device.createBuffer({
      label: 'GpuMeshletPass.stats',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bgl = device.createBindGroupLayout({
      label: 'GpuMeshletPass.bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const module = device.createShaderModule({
      label: 'GpuMeshletPass.compute',
      code: `${coreWgsl}\n\n${standaloneWgsl}`,
    });

    this.resetPipeline = device.createComputePipeline({
      label: 'GpuMeshletPass.reset',
      layout,
      compute: { module, entryPoint: 'resetArgs' },
    });
    this.cullPipeline = device.createComputePipeline({
      label: 'GpuMeshletPass.cull',
      layout,
      compute: { module, entryPoint: 'cullAndCompact' },
    });

    this.bindGroup = device.createBindGroup({
      label: 'GpuMeshletPass.bg',
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.spheresBuffer } },
        { binding: 2, resource: { buffer: this.conesBuffer } },
        { binding: 3, resource: { buffer: this.apicesBuffer } },
        { binding: 4, resource: { buffer: this.slicesBuffer } },
        { binding: 5, resource: { buffer: this.sourceIndexBuffer } },
        { binding: 6, resource: { buffer: this.visibleIndexBuffer } },
        { binding: 7, resource: { buffer: this.indirectBuffer } },
        { binding: 8, resource: { buffer: this.statsBuffer } },
      ],
    });
  }

  /** Convenience factory from an offline-compiled `.mlet` container. */
  static fromParsedMlet(device: GPUDevice, mlet: ParsedMlet): GpuMeshletPass {
    return new GpuMeshletPass(device, {
      indices: mlet.indices,
      spheres: mlet.meshletSpheres,
      cones: mlet.meshletCones,
      apices: mlet.meshletApices,
      slices: mlet.meshletSlices,
      meshletCount: mlet.meta.meshletCount,
    });
  }

  /**
   * Upload camera frustum planes (in the mesh's space) and encode both compute passes
   * (reset indirect args + 64-wide frustum/cone cull & index stream compaction).
   */
  encodeCull(
    device: GPUDevice,
    encoder: GPUCommandEncoder,
    mvpMatrix: Mat4Like,
    camPosLocal: Vec3Tuple,
    maxDist = 0,
    depthZeroToOne = true,
  ) {
    extractFrustumPlanes(mvpMatrix, this.planesScratch, depthZeroToOne);
    this.uboF32.set(this.planesScratch, 0);
    this.uboF32[24] = camPosLocal[0];
    this.uboF32[25] = camPosLocal[1];
    this.uboF32[26] = camPosLocal[2];
    this.uboF32[27] = maxDist;
    this.uboU32[28] = this.meshletCount;
    this.uboU32[29] = 0;
    this.uboU32[30] = 0;
    this.uboU32[31] = 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uboRaw);

    const pass = encoder.beginComputePass({ label: 'GpuMeshletPass' });
    pass.setBindGroup(0, this.bindGroup);
    pass.setPipeline(this.resetPipeline);
    pass.dispatchWorkgroups(1);
    if (this.meshletCount > 0) {
      pass.setPipeline(this.cullPipeline);
      pass.dispatchWorkgroups(Math.ceil(this.meshletCount / 64));
    }
    pass.end();
  }

  /** Issue the single GPU-driven `drawIndexedIndirect` call inside any WebGPU render pass. */
  draw(renderPass: GPURenderPassEncoder) {
    renderPass.setIndexBuffer(this.visibleIndexBuffer, 'uint32');
    renderPass.drawIndexedIndirect(this.indirectBuffer, 0);
  }

  /** Async GPU readback of exact culling counters for profiling (never call in hot render loop). */
  async readStats(device: GPUDevice): Promise<MeshletBatchGpuStats> {
    const staging = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.statsBuffer, 0, staging, 0, 16);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const u32 = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return {
      meshletCount: this.meshletCount,
      visibleMeshlets: u32[0] ?? 0,
      frustumCulled: u32[1] ?? 0,
      coneCulled: u32[2] ?? 0,
      visibleIndices: u32[3] ?? 0,
      totalIndices: this.totalIndices,
    };
  }

  destroy() {
    this.uniformBuffer.destroy();
    this.spheresBuffer.destroy();
    this.conesBuffer.destroy();
    this.apicesBuffer.destroy();
    this.slicesBuffer.destroy();
    this.sourceIndexBuffer.destroy();
    this.visibleIndexBuffer.destroy();
    this.indirectBuffer.destroy();
    this.statsBuffer.destroy();
  }
}
