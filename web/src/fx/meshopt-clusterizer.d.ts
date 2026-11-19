declare module 'three/addons/libs/meshopt_clusterizer.module.js' {
  export interface MeshletBuffers {
    meshlets: Uint32Array;
    vertices: Uint32Array;
    triangles: Uint8Array;
    meshletCount: number;
  }

  export interface MeshletBound {
    centerX: number;
    centerY: number;
    centerZ: number;
    radius: number;
    coneApexX: number;
    coneApexY: number;
    coneApexZ: number;
    coneAxisX: number;
    coneAxisY: number;
    coneAxisZ: number;
    coneCutoff: number;
  }

  export const MeshoptClusterizer: {
    readonly ready: Promise<void>;
    readonly supported: boolean;
    buildMeshlets(
      indices: Uint32Array | Uint16Array,
      vertexPositions: Float32Array,
      vertexPositionsStride: number,
      maxVertices: number,
      maxTriangles: number,
      coneWeight?: number,
    ): MeshletBuffers;
    computeMeshletBounds(
      buffers: MeshletBuffers,
      vertexPositions: Float32Array,
      vertexPositionsStride: number,
    ): MeshletBound[];
  };
}
