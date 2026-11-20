// Block-compression codecs for BC1 (BC4_UNORM_BLOCK) and BC3 (BC7_UNORM_BLOCK).
//
// The reference decoders in this file implement the exact DXT1/DXT5 block
// interpolation tables and bit layout from the Khronos Data Format
// Specification. They are used to validate the container contents on CPU and
// to compare against real GPU readback in the Web page.

// ---------------------------------------------------------------------------
// Shared low-level helpers
// ---------------------------------------------------------------------------

export function rgb565Quantize(r, g, b) {
  return (
    (Math.min(31, Math.max(0, Math.round(r * 31 / 255))) << 11) |
    (Math.min(63, Math.max(0, Math.round(g * 63 / 255))) << 5) |
    Math.min(31, Math.max(0, Math.round(b * 31 / 255)))
  );
}

export function rgb565Expand(c565) {
  const r5 = (c565 >> 11) & 31;
  const g6 = (c565 >> 5) & 63;
  const b5 = c565 & 31;
  return [
    (r5 << 3) | (r5 >> 2),
    (g6 << 2) | (g6 >> 4),
    (b5 << 3) | (b5 >> 2),
  ];
}

// BC1 2-bit interpolation weights: 0, 1/3, 2/3, 1 rounded to 8-bit values.
const BC1_WEIGHTS = [0, 0x55, 0xaa, 0xff];

function lerp255(a, b, w) {
  // Reference decoders round half up on (a*(255-w) + b*w + 127) / 255.
  return Math.min(255, Math.max(0, Math.round((a * (255 - w) + b * w) / 255)));
}

function bc1Palette(c0, c1) {
  const e0 = rgb565Expand(c0);
  const e1 = rgb565Expand(c1);
  const pal = [
    [e0[0], e0[1], e0[2]],
    [e1[0], e1[1], e1[2]],
  ];
  if (c0 > c1) {
    // 4-color mode.
    pal.push([
      lerp255(e0[0], e1[0], BC1_WEIGHTS[2]),
      lerp255(e0[1], e1[1], BC1_WEIGHTS[2]),
      lerp255(e0[2], e1[2], BC1_WEIGHTS[2]),
    ]);
    pal.push([
      lerp255(e0[0], e1[0], BC1_WEIGHTS[1]),
      lerp255(e0[1], e1[1], BC1_WEIGHTS[1]),
      lerp255(e0[2], e1[2], BC1_WEIGHTS[1]),
    ]);
  } else {
    // 3-color + punch-through alpha mode.
    pal.push([
      lerp255(e0[0], e1[0], 128),
      lerp255(e0[1], e1[1], 128),
      lerp255(e0[2], e1[2], 128),
    ]);
    pal.push([0, 0, 0]);
  }
  return pal;
}

function nearestIndex(texel, palette, maxIndex) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i <= maxIndex; i++) {
    const p = palette[i];
    const dr = texel[0] - p[0];
    const dg = texel[1] - p[1];
    const db = texel[2] - p[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function colorError(texel, pal, idx) {
  const p = pal[idx];
  const dr = texel[0] - p[0];
  const dg = texel[1] - p[1];
  const db = texel[2] - p[2];
  return dr * dr + dg * dg + db * db;
}

// ---------------------------------------------------------------------------
// BC1 block
// ---------------------------------------------------------------------------

function gatherBlock(src, width, height, bx, by) {
  const block = new Uint8Array(16 * 4);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const sx = Math.min(width - 1, bx * 4 + tx);
      const sy = Math.min(height - 1, by * 4 + ty);
      block.set(src.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (ty * 4 + tx) * 4);
    }
  }
  return block;
}

// options: { punchAlpha: bool }
// Punch-through mode is only selected for cutout-style alpha (values cluster
// near 0 or 255). BC1 cannot represent partial alpha, so soft-alpha blocks use
// the 4-color mode and leave alpha to BC3; forcing punch mode on a soft edge
// would replace feathered pixels with hard black texels.
export function encodeBC1Block(block, options = {}) {
  const texels = [];
  for (let t = 0; t < 16; t++) {
    texels.push([block[t * 4], block[t * 4 + 1], block[t * 4 + 2], block[t * 4 + 3]]);
  }
  const hasCutout = options.punchAlpha && texels.some((t) => t[3] < 128) &&
    texels.every((t) => t[3] <= 24 || t[3] >= 232);

  // Candidate endpoints: every distinct quantized color appearing in the block.
  const candidates = [];
  const seen = new Set();
  for (const t of texels) {
    const q = rgb565Quantize(t[0], t[1], t[2]);
    if (!seen.has(q)) { seen.add(q); candidates.push(q); }
  }
  if (candidates.length === 1) {
    // Need two distinct codes; perturb by one LSB on blue.
    candidates.push(candidates[0] === 0 ? 1 : candidates[0] - 1);
  }

  let bestC0 = candidates[0];
  let bestC1 = candidates[1];
  let bestErr = Infinity;
  let bestIndices = new Array(16);

  if (hasCutout) {
    // Punch-through requires c0 <= c1; choose endpoints by maximum distance.
    let bestDist = -1;
    for (const a of candidates) {
      for (const b of candidates) {
        if (a > b || a === b) continue;
        const ea = rgb565Expand(a);
        const eb = rgb565Expand(b);
        const d = (ea[0] - eb[0]) ** 2 + (ea[1] - eb[1]) ** 2 + (ea[2] - eb[2]) ** 2;
        if (d > bestDist) { bestDist = d; bestC0 = a; bestC1 = b; }
      }
    }
    if (bestDist < 0) {
      // All quantized colors equal: split by flipping a green LSB, keep c0<c1.
      bestC0 = candidates[0];
      bestC1 = candidates[0] < 0xffff ? candidates[0] + 0x20 : candidates[0] - 0x20;
      if (bestC0 > bestC1) { const tmp = bestC0; bestC0 = bestC1; bestC1 = tmp; }
    }
    const pal = bc1Palette(bestC0, bestC1);
    for (let t = 0; t < 16; t++) {
      bestIndices[t] = texels[t][3] < 128 ? 3 : nearestIndex(texels[t], pal, 2);
    }
  } else {
    for (const a of candidates) {
      for (const b of candidates) {
        if (a === b) continue;
        const orderA = a > b ? a : b;
        const orderB = a > b ? b : a;
        const pal = bc1Palette(orderA, orderB);
        let err = 0;
        const indices = new Array(16);
        for (let t = 0; t < 16; t++) {
          const idx = nearestIndex(texels[t], pal, 3);
          indices[t] = idx;
          err += colorError(texels[t], pal, idx);
        }
        if (err < bestErr) {
          bestErr = err;
          bestC0 = orderA;
          bestC1 = orderB;
          bestIndices = indices;
        }
      }
    }
  }

  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, bestC0, true);
  dv.setUint16(2, bestC1, true);
  let bits = 0;
  for (let t = 0; t < 16; t++) bits |= bestIndices[t] << (2 * t);
  dv.setUint32(4, bits >>> 0, true);
  return out;
}

export function decodeBC1Block(block) {
  const dv = block instanceof DataView ? block : new DataView(block.buffer, block.byteOffset, 8);
  const c0 = dv.getUint16(0, true);
  const c1 = dv.getUint16(2, true);
  const bits = dv.getUint32(4, true);
  const pal = bc1Palette(c0, c1);
  const punch = c0 <= c1;
  const out = new Uint8Array(16 * 4);
  for (let t = 0; t < 16; t++) {
    const idx = (bits >> (2 * t)) & 3;
    const p = pal[idx];
    const o = t * 4;
    out[o] = p[0];
    out[o + 1] = p[1];
    out[o + 2] = p[2];
    out[o + 3] = punch && idx === 3 ? 0 : 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BC3 alpha block
// ---------------------------------------------------------------------------

const BC3_ALPHA_W6 = [0, 51, 102, 153, 204, 255, 0, 255];

function alphaTable(a0, a1) {
  const table = new Array(8);
  if (a0 > a1) {
    // 8-alpha mode: entries 0 and 1 are the endpoints, the remaining six are
    // linear interpolation at i/7 between them (Khronon DFS table).
    table[0] = a0;
    table[1] = a1;
    for (let i = 2; i < 8; i++) {
      table[i] = Math.round(((7 - i) * a0 + (i - 1) * a1) / 7);
    }
  } else {
    // 6-alpha mode: six interpolated entries plus explicit 0 and 255.
    for (let i = 0; i < 6; i++) table[i] = BC3_ALPHA_W6[i];
    table[0] = a0;
    table[1] = a1;
    table[6] = 0;
    table[7] = 255;
  }
  return table;
}

function encodeAlphaBlock(block) {
  const alphas = [];
  for (let t = 0; t < 16; t++) alphas.push(block[t * 4 + 3]);
  const distinct = [...new Set(alphas)].sort((x, y) => x - y);

  let best = { err: Infinity, a0: 255, a1: 0, indices: new Array(16).fill(0) };
  // Endpoints are quantized to single bytes; include the full range so a block
  // spanning wide alpha can pick 0/255 even if no texel holds exactly that.
  const endpoints = distinct.length >= 2
    ? [...new Set([...distinct, 0, 16, 32, 64, 128, 192, 255])]
    : [0, 255];

  for (const e0 of endpoints) {
    for (const e1 of endpoints) {
      if (e0 === e1) continue;
      // Both orderings are legal; evaluate whichever fits.
      for (const [a0, a1] of [[e0, e1], [e1, e0]]) {
        const table = alphaTable(a0, a1);
        const maxIdx = a0 > a1 ? 7 : 5;
        let err = 0;
        const indices = new Array(16);
        for (let t = 0; t < 16; t++) {
          let bi = 0;
          let bd = Infinity;
          for (let i = 0; i <= maxIdx; i++) {
            const d = Math.abs(alphas[t] - table[i]);
            if (d < bd) { bd = d; bi = i; }
          }
          indices[t] = bi;
          err += bd * bd;
        }
        if (err < best.err) best = { err, a0, a1, indices };
      }
    }
  }

  const out = new Uint8Array(8);
  out[0] = best.a0;
  out[1] = best.a1;
  // The 16 three-bit indices form a contiguous 48-bit little-endian bitfield
  // starting at bit 16 of the 64-bit block. Gather into low/high 32-bit words
  // so an index spanning a 16-bit boundary is not truncated.
  let lo = 0;
  let hi = 0;
  for (let t = 0; t < 16; t++) {
    const bitStart = 3 * t;
    const val = best.indices[t] & 7;
    if (bitStart < 32) lo |= val << bitStart;
    else hi |= val << (bitStart - 32);
  }
  const dv = new DataView(out.buffer);
  // Alpha byte positions 2..7 hold the 48 bits, little-endian per 16-bit word.
  dv.setUint16(2, lo & 0xffff, true);
  dv.setUint16(4, (lo >>> 16) & 0xffff, true);
  dv.setUint16(6, hi & 0xffff, true);
  return { bytes: out, indices: best.indices };
}

export function decodeAlphaBlock(block) {
  const dv = block instanceof DataView ? block : new DataView(block.buffer, block.byteOffset, 8);
  const a0 = dv.getUint8(0);
  const a1 = dv.getUint8(1);
  // Reconstruct the contiguous 48-bit index field (bits 16..63).
  const lo = dv.getUint16(2, true) | (dv.getUint16(4, true) << 16);
  const hi = dv.getUint16(6, true);
  const table = alphaTable(a0, a1);
  const out = new Uint8Array(16);
  for (let t = 0; t < 16; t++) {
    const bitStart = 3 * t;
    let idx;
    if (bitStart < 32) idx = (lo >>> bitStart) & 7;
    else idx = (hi >>> (bitStart - 32)) & 7;
    out[t] = table[idx];
  }
  return out;
}

export function encodeBC3Block(block) {
  const alpha = encodeAlphaBlock(block);
  const color = encodeBC1Block(block, { punchAlpha: false });
  const out = new Uint8Array(16);
  out.set(alpha.bytes, 0);
  out.set(color, 8);
  return out;
}

export function decodeBC3Block(block) {
  const base = block.byteOffset;
  const view = new DataView(block.buffer, base, 16);
  const alpha = decodeAlphaBlock(view);
  const color = decodeBC1Block(new DataView(block.buffer, base + 8, 8));
  for (let t = 0; t < 16; t++) color[t * 4 + 3] = alpha[t];
  return color;
}

// ---------------------------------------------------------------------------
// Image-level entry points (handle non-block-aligned dimensions by edge clamp)
// ---------------------------------------------------------------------------

export function blocksX(width) { return Math.ceil(width / 4); }
export function blocksY(height) { return Math.ceil(height / 4); }

export function encodeBC1(image) {
  const bx = blocksX(image.width);
  const by = blocksY(image.height);
  const out = new Uint8Array(bx * by * 8);
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const block = gatherBlock(image.pixels, image.width, image.height, x, y);
      out.set(encodeBC1Block(block, { punchAlpha: true }), (y * bx + x) * 8);
    }
  }
  return out;
}

export function encodeBC3(image) {
  const bx = blocksX(image.width);
  const by = blocksY(image.height);
  const out = new Uint8Array(bx * by * 16);
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const block = gatherBlock(image.pixels, image.width, image.height, x, y);
      out.set(encodeBC3Block(block), (y * bx + x) * 16);
    }
  }
  return out;
}

function decodeImage(data, width, height, blockSize, decodeBlock) {
  const bx = blocksX(width);
  const by = blocksY(height);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const blockBytes = data.subarray((y * bx + x) * blockSize, (y * bx + x) * blockSize + blockSize);
      const decoded = decodeBlock(blockBytes);
      for (let ty = 0; ty < 4; ty++) {
        for (let tx = 0; tx < 4; tx++) {
          const dx = x * 4 + tx;
          const dy = y * 4 + ty;
          if (dx >= width || dy >= height) continue;
          out.set(decoded.subarray((ty * 4 + tx) * 4, (ty * 4 + tx) * 4 + 4), (dy * width + dx) * 4);
        }
      }
    }
  }
  return out;
}

export function decodeBC1(data, width, height) {
  return decodeImage(data, width, height, 8, (b) => decodeBC1Block(b));
}

export function decodeBC3(data, width, height) {
  return decodeImage(data, width, height, 16, (b) => decodeBC3Block(b));
}

export const BLOCK_BYTES = { bc1: 8, bc3: 16 };
