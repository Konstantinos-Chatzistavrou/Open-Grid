// Apache-2.0 — Pure Client-Side ISO/IEC 18004 QR Code SVG Generator (Zero Dependencies, Zero Network Calls).
// Encodes UTF-8 strings in Byte Mode at Error Correction Level M (15% recovery), Versions 1..12 (up to 287 bytes).
// Used for local Authenticator 2FA setup so TOTP secrets NEVER leave the user's browser.

const UTF8 = new TextEncoder();

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

interface VersionSpec {
  version: number;
  dataCodewords: number;
  ecPerBlock: number;
  numBlocks: number;
  alignment: readonly number[];
}

// ISO/IEC 18004 Table 9 (Error Correction Level M) + Table E.1 (Alignment pattern centers), Versions 1..12
const SPECS_M: readonly VersionSpec[] = [
  { version: 1,  dataCodewords: 16,  ecPerBlock: 10, numBlocks: 1, alignment: [] },
  { version: 2,  dataCodewords: 28,  ecPerBlock: 16, numBlocks: 1, alignment: [6, 18] },
  { version: 3,  dataCodewords: 44,  ecPerBlock: 26, numBlocks: 1, alignment: [6, 22] },
  { version: 4,  dataCodewords: 64,  ecPerBlock: 18, numBlocks: 2, alignment: [6, 26] },
  { version: 5,  dataCodewords: 86,  ecPerBlock: 24, numBlocks: 2, alignment: [6, 30] },
  { version: 6,  dataCodewords: 108, ecPerBlock: 16, numBlocks: 4, alignment: [6, 34] },
  { version: 7,  dataCodewords: 124, ecPerBlock: 18, numBlocks: 4, alignment: [6, 22, 38] },
  { version: 8,  dataCodewords: 154, ecPerBlock: 22, numBlocks: 4, alignment: [6, 24, 42] },
  { version: 9,  dataCodewords: 182, ecPerBlock: 22, numBlocks: 5, alignment: [6, 26, 46] },
  { version: 10, dataCodewords: 216, ecPerBlock: 26, numBlocks: 5, alignment: [6, 28, 50] },
  { version: 11, dataCodewords: 254, ecPerBlock: 30, numBlocks: 5, alignment: [6, 30, 54] },
  { version: 12, dataCodewords: 290, ecPerBlock: 22, numBlocks: 8, alignment: [6, 32, 58] },
];

function selectSpec(byteLen: number): VersionSpec {
  for (const s of SPECS_M) {
    const countBits = s.version <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLen * 8;
    if (neededBits <= s.dataCodewords * 8) return s;
  }
  throw new Error(`QR payload too long (${byteLen} bytes, max 287 bytes at EC Level M)`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const capBits = spec.dataCodewords * 8;
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  // Mode indicator: Byte mode (0100)
  pushBits(0b0100, 4);
  // Character count indicator: 8 bits for V1..V9, 16 bits for V10..V26
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

  // Terminator (up to 4 zero bits)
  const term = Math.min(4, capBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(spec.dataCodewords);
  let idx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out[idx++] = b;
  }
  // Pad codewords alternating 0xEC, 0x11
  for (let pad = 0; idx < spec.dataCodewords; pad++) {
    out[idx++] = pad % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

function buildCodewords(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const { numBlocks, ecPerBlock, dataCodewords } = spec;
  const shortLen = Math.floor(dataCodewords / numBlocks);
  const longCount = dataCodewords % numBlocks;
  const shortCount = numBlocks - longCount;

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = i < shortCount ? shortLen : shortLen + 1;
    const slice = data.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(slice);
    ecBlocks.push(rsEncode(slice, ecPerBlock));
  }

  const totalLen = dataCodewords + numBlocks * ecPerBlock;
  const result = new Uint8Array(totalLen);
  let pos = 0;
  const maxDataLen = shortLen + (longCount > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) result[pos++] = dataBlocks[b][i];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      result[pos++] = ecBlocks[b][i];
    }
  }
  return result;
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return ((r + c) & 1) === 0;
    case 1: return (r & 1) === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (((r >> 1) + Math.floor(c / 3)) & 1) === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return ((((r * c) % 2) + ((r * c) % 3)) & 1) === 0;
    case 7: return ((((r + c) % 2) + ((r * c) % 3)) & 1) === 0;
    default: return false;
  }
}

function computeFormatBits(ecIndicator: number, mask: number): number {
  const data5 = (ecIndicator << 3) | (mask & 7);
  let d = data5 << 10;
  for (let i = 4; i >= 0; i--) {
    if (d & (1 << (i + 10))) d ^= 0x537 << i;
  }
  return ((data5 << 10) | d) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let d = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (d & (1 << (i + 12))) d ^= 0x1f25 << i;
  }
  return (version << 12) | d;
}

function penaltyScore(grid: Uint8Array, size: number): number {
  let score = 0;
  const at = (r: number, c: number) => grid[r * size + c];

  // Rule 1: 5+ consecutive same-color modules in rows and columns
  for (let r = 0; r < size; r++) {
    let runColor = at(r, 0), runLen = 1;
    for (let c = 1; c < size; c++) {
      const v = at(r, c);
      if (v === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = v;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = at(0, c), runLen = 1;
    for (let r = 1; r < size; r++) {
      const v = at(r, c);
      if (v === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = v;
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of the same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: 1:1:3:1:1 finder-like patterns with 4 light modules on either side
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      const base = r * size + c;
      if (
        (grid[base] === 1 && grid[base + 1] === 0 && grid[base + 2] === 1 && grid[base + 3] === 1 && grid[base + 4] === 1 &&
          grid[base + 5] === 0 && grid[base + 6] === 1 && grid[base + 7] === 0 && grid[base + 8] === 0 && grid[base + 9] === 0 && grid[base + 10] === 0) ||
        (grid[base] === 0 && grid[base + 1] === 0 && grid[base + 2] === 0 && grid[base + 3] === 0 && grid[base + 4] === 1 &&
          grid[base + 5] === 0 && grid[base + 6] === 1 && grid[base + 7] === 1 && grid[base + 8] === 1 && grid[base + 9] === 0 && grid[base + 10] === 1)
      ) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      if (
        (at(r, c) === 1 && at(r + 1, c) === 0 && at(r + 2, c) === 1 && at(r + 3, c) === 1 && at(r + 4, c) === 1 &&
          at(r + 5, c) === 0 && at(r + 6, c) === 1 && at(r + 7, c) === 0 && at(r + 8, c) === 0 && at(r + 9, c) === 0 && at(r + 10, c) === 0) ||
        (at(r, c) === 0 && at(r + 1, c) === 0 && at(r + 2, c) === 0 && at(r + 3, c) === 0 && at(r + 4, c) === 1 &&
          at(r + 5, c) === 0 && at(r + 6, c) === 1 && at(r + 7, c) === 1 && at(r + 8, c) === 1 && at(r + 9, c) === 0 && at(r + 10, c) === 1)
      ) score += 40;
    }
  }

  // Rule 4: proportion of dark modules relative to 50%
  let dark = 0;
  for (let i = 0; i < grid.length; i++) dark += grid[i];
  const pct = (dark * 100) / grid.length;
  const k = Math.floor(Math.abs(pct - 50) / 5);
  score += k * 10;
  return score;
}

export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  modules: Uint8Array;
}

/** Encode a UTF-8 string into a standard ISO/IEC 18004 QR Code matrix (Byte Mode, EC Level M). */
export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = UTF8.encode(text);
  const spec = selectSpec(bytes.length);
  const size = spec.version * 4 + 17;
  const data = encodeDataCodewords(bytes, spec);
  const codewords = buildCodewords(data, spec);

  const modules = new Uint8Array(size * size);
  const isFunc = new Uint8Array(size * size);
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r * size + c] = dark ? 1 : 0;
    isFunc[r * size + c] = 1;
  };

  // 1. Finder patterns (7x7) + 1-module white separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr, c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const inPattern = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        setFunc(r, c, inPattern && (inBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 2. Timing patterns (row 6 and col 6)
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, (i & 1) === 0);
    setFunc(i, 6, (i & 1) === 0);
  }

  // 3. Alignment patterns (5x5, skipping overlaps with the 3 finder patterns)
  const align = spec.alignment;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const cr = align[i], cc = align[j];
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // 4. Reserve format information strips + fixed dark module
  const drawFormat = (grid: Uint8Array, mask: number, markFunc: boolean) => {
    // EC Level M indicator = 0b00 (0)
    const bits = computeFormatBits(0, mask);
    const put = (r: number, c: number, bitIndex: number) => {
      grid[r * size + c] = (bits >>> bitIndex) & 1;
      if (markFunc) isFunc[r * size + c] = 1;
    };
    // Copy 1 (around top-left finder): bit 14 -> (8,0) ... bit 0 -> (0,8)
    const copy1: [number, number][] = [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8],
      [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    ];
    for (let i = 0; i < 15; i++) put(copy1[i][0], copy1[i][1], i);

    // Copy 2 (around top-right and bottom-left finders): bit 0 -> (8,size-1) ... bit 14 -> (size-1,8)
    for (let i = 0; i < 8; i++) put(8, size - 1 - i, i);
    for (let i = 8; i < 15; i++) put(size - 15 + i, 8, i);

    // Fixed dark module at (4*version + 9, 8) === (size - 8, 8)
    grid[(size - 8) * size + 8] = 1;
    if (markFunc) isFunc[(size - 8) * size + 8] = 1;
  };
  drawFormat(modules, 0, true);

  // 5. Version information blocks (for Version >= 7)
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // 6. Place data + EC bits in standard upward/downward 2-column zig-zag (skipping col 6)
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = right - dx;
        const pos = r * size + c;
        if (isFunc[pos]) continue;
        let dark = 0;
        if (bitIdx < totalBits) {
          dark = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        modules[pos] = dark;
      }
    }
    upward = !upward;
  }

  // 7. Evaluate all 8 standard data masks and select the lowest-penalty matrix
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestGrid = modules;
  for (let mask = 0; mask < 8; mask++) {
    const cand = new Uint8Array(modules);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const pos = r * size + c;
        if (!isFunc[pos] && maskBit(mask, r, c)) cand[pos] ^= 1;
      }
    }
    drawFormat(cand, mask, false);
    const p = penaltyScore(cand, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestGrid = cand;
    }
  }

  return { version: spec.version, size, mask: bestMask, modules: bestGrid };
}

/** Render a crisp, black-on-white scannable SVG QR Code (4-module quiet zone) locally in-browser. */
export function renderQrSvg(text: string, sizePx = 172): string {
  const { size, modules } = encodeQrMatrix(text);
  const quiet = 4;
  const dim = size + quiet * 2;
  const cmds: string[] = [];
  for (let r = 0; r < size; r++) {
    const y = r + quiet;
    let c = 0;
    while (c < size) {
      if (modules[r * size + c]) {
        const start = c;
        while (c < size && modules[r * size + c]) c++;
        cmds.push(`M${start + quiet} ${y}h${c - start}v1h${start - c}z`);
      } else {
        c++;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img" aria-label="Authenticator QR Code"><rect width="${dim}" height="${dim}" fill="#ffffff"/><path d="${cmds.join('')}" fill="#000000"/></svg>`;
}
