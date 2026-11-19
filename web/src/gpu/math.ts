// Zero-dependency 3D math utilities for engine-agnostic WebGPU modules (OpenGrid).
// Convention: right-handed world space, column-major 4x4 matrices (WebGPU / glTF / OpenGL layout).

export type Vec3Tuple = readonly [number, number, number];
export type Mat4Like = ArrayLike<number>;

/** Multiply two column-major 4x4 matrices: out = a * b. Safe if out aliases a or b. */
export function mulMat4(a: Mat4Like, b: Mat4Like, out: Float32Array): Float32Array {
  const a00 = a[0], a01 = a[4], a02 = a[8], a03 = a[12];
  const a10 = a[1], a11 = a[5], a12 = a[9], a13 = a[13];
  const a20 = a[2], a21 = a[6], a22 = a[10], a23 = a[14];
  const a30 = a[3], a31 = a[7], a32 = a[11], a33 = a[15];

  for (let col = 0; col < 4; col++) {
    const o = col * 4;
    const b0 = b[o], b1 = b[o + 1], b2 = b[o + 2], b3 = b[o + 3];
    out[o + 0] = a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3;
    out[o + 1] = a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3;
    out[o + 2] = a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3;
    out[o + 3] = a30 * b0 + a31 * b1 + a32 * b2 + a33 * b3;
  }
  return out;
}

/** Transform a 3D point by a column-major 4x4 affine matrix (w = 1). */
export function transformPointMat4(
  m: Mat4Like,
  x: number,
  y: number,
  z: number,
  out: [number, number, number],
): [number, number, number] {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** Transform a 3D direction vector by the upper-left 3x3 of a column-major 4x4 matrix (normalized). */
export function transformDirMat4(
  m: Mat4Like,
  x: number,
  y: number,
  z: number,
  out: [number, number, number],
): [number, number, number] {
  const tx = m[0] * x + m[4] * y + m[8] * z;
  const ty = m[1] * x + m[5] * y + m[9] * z;
  const tz = m[2] * x + m[6] * y + m[10] * z;
  const len = Math.hypot(tx, ty, tz);
  if (len > 1e-6) {
    out[0] = tx / len;
    out[1] = ty / len;
    out[2] = tz / len;
  } else {
    out[0] = 0;
    out[1] = 0;
    out[2] = -1;
  }
  return out;
}

/** Right-handed view matrix (column-major) from eye -> target with world up. */
export function makeLookAt(
  eyeX: number, eyeY: number, eyeZ: number,
  targetX: number, targetY: number, targetZ: number,
  upX: number, upY: number, upZ: number,
  out: Float32Array,
): Float32Array {
  let zx = eyeX - targetX, zy = eyeY - targetY, zz = eyeZ - targetZ;
  let zLen = Math.hypot(zx, zy, zz);
  if (zLen < 1e-6) { zx = 0; zy = 0; zz = 1; zLen = 1; }
  zx /= zLen; zy /= zLen; zz /= zLen;

  let xx = upY * zz - upZ * zy;
  let xy = upZ * zx - upX * zz;
  let xz = upX * zy - upY * zx;
  let xLen = Math.hypot(xx, xy, xz);
  if (xLen < 1e-6) { xx = 1; xy = 0; xz = 0; xLen = 1; }
  xx /= xLen; xy /= xLen; xz /= xLen;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[4] = xy; out[8] = xz; out[12] = -(xx * eyeX + xy * eyeY + xz * eyeZ);
  out[1] = yx; out[5] = yy; out[9] = yz; out[13] = -(yx * eyeX + yy * eyeY + yz * eyeZ);
  out[2] = zx; out[6] = zy; out[10] = zz; out[14] = -(zx * eyeX + zy * eyeY + zz * eyeZ);
  out[3] = 0;  out[7] = 0;  out[11] = 0;  out[15] = 1;
  return out;
}

/**
 * Right-handed perspective projection matrix (column-major).
 * @param fovYDeg Vertical field of view in degrees
 * @param aspect Width / height
 * @param near Positive near clip distance
 * @param far Positive far clip distance
 * @param depthZeroToOne True for native WebGPU NDC z in [0, 1]; false for OpenGL [-1, 1]
 */
export function makePerspective(
  fovYDeg: number,
  aspect: number,
  near: number,
  far: number,
  depthZeroToOne: boolean,
  out: Float32Array,
): Float32Array {
  const f = 1.0 / Math.tan((fovYDeg * Math.PI) / 360);
  out.fill(0);
  out[0] = f / Math.max(aspect, 1e-4);
  out[5] = f;
  out[11] = -1;
  if (depthZeroToOne) {
    out[10] = far / (near - far);
    out[14] = (far * near) / (near - far);
  } else {
    out[10] = (far + near) / (near - far);
    out[14] = (2 * far * near) / (near - far);
  }
  return out;
}

/**
 * Extract 6 inward-pointing normalized frustum planes (Gribb-Hartmann) from a column-major
 * `projection * view` (or `projection * view * model`) matrix into `out` (24 floats = 6 x vec4(nx, ny, nz, d)).
 * Plane equation: dot(n, p) + d >= 0 is inside the frustum.
 */
export function extractFrustumPlanes(
  vp: Mat4Like,
  out: Float32Array,
  depthZeroToOne = true,
): Float32Array {
  const m0 = vp[0], m1 = vp[1], m2 = vp[2], m3 = vp[3];
  const m4 = vp[4], m5 = vp[5], m6 = vp[6], m7 = vp[7];
  const m8 = vp[8], m9 = vp[9], m10 = vp[10], m11 = vp[11];
  const m12 = vp[12], m13 = vp[13], m14 = vp[14], m15 = vp[15];

  const writePlane = (idx: number, a: number, b: number, c: number, d: number) => {
    const len = Math.hypot(a, b, c) || 1;
    const inv = 1 / len;
    const o = idx * 4;
    out[o + 0] = a * inv;
    out[o + 1] = b * inv;
    out[o + 2] = c * inv;
    out[o + 3] = d * inv;
  };

  // Left:   row3 + row0
  writePlane(0, m3 + m0, m7 + m4, m11 + m8, m15 + m12);
  // Right:  row3 - row0
  writePlane(1, m3 - m0, m7 - m4, m11 - m8, m15 - m12);
  // Bottom: row3 + row1
  writePlane(2, m3 + m1, m7 + m5, m11 + m9, m15 + m13);
  // Top:    row3 - row1
  writePlane(3, m3 - m1, m7 - m5, m11 - m9, m15 - m13);
  // Near:   row2 (WebGPU z in [0,1]) or row3 + row2 (OpenGL z in [-1,1])
  if (depthZeroToOne) {
    writePlane(4, m2, m6, m10, m14);
  } else {
    writePlane(4, m3 + m2, m7 + m6, m11 + m10, m15 + m14);
  }
  // Far:    row3 - row2
  writePlane(5, m3 - m2, m7 - m6, m11 - m10, m15 - m14);

  return out;
}
