// Minimal PNG codec: 8-bit grayscale(0)/RGB(2)/RGBA(6), no interlace.
// Inflate/deflate are injected so the same code runs under Node (zlib) and
// other runtimes without pulling a second copy of a DEFLATE implementation.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readChunks(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== SIG[i]) throw new Error('not a PNG file (bad signature)');
  }
  const chunks = [];
  let p = 8;
  while (p < u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset + p, 8);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const data = u8.subarray(p + 8, p + 8 + len);
    const crc = new DataView(u8.buffer, u8.byteOffset + p + 8 + len, 4).getUint32(0);
    if (crc32(u8, p + 4, p + 8 + len) !== crc) throw new Error(`PNG CRC failure in ${type}`);
    chunks.push({ type, data });
    p += 12 + len;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const rowStart = pos;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos++];
      const a = x >= bpp ? out[outStart + x - bpp] : 0;
      const b = y > 0 ? out[outStart - stride + x] : 0;
      const c = y > 0 && x >= bpp ? out[outStart - stride + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = (cur + a) & 0xff; break;
        case 2: v = (cur + b) & 0xff; break;
        case 3: v = (cur + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (cur + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[outStart + x] = v;
    }
  }
  return out;
}

// inflate: (Uint8Array) -> Uint8Array
export function decodePng(bytes, inflate) {
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG missing IHDR');
  const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.length);
  const width = dv.getUint32(0);
  const height = dv.getUint32(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const idat = chunks.filter((c) => c.type === 'IDAT');
  const concat = new Uint8Array(idat.reduce((n, c) => n + c.data.length, 0));
  let off = 0;
  for (const c of idat) { concat.set(c.data, off); off += c.data.length; }
  const raw = inflate(concat);
  const filtered = unfilter(raw, width, height, channels);

  const pixels = new Uint8Array(width * height * 4);
  if (channels === 1) {
    for (let p = 0; p < width * height; p++) {
      const v = filtered[p];
      const d = p * 4;
      pixels[d] = pixels[d + 1] = pixels[d + 2] = v;
      pixels[d + 3] = 255;
    }
  } else if (channels === 3) {
    for (let p = 0; p < width * height; p++) {
      pixels[p * 4] = filtered[p * 3];
      pixels[p * 4 + 1] = filtered[p * 3 + 1];
      pixels[p * 4 + 2] = filtered[p * 3 + 2];
      pixels[p * 4 + 3] = 255;
    }
  } else {
    pixels.set(filtered);
  }
  return { width, height, pixels };
}

function writeChunk(type, data) {
  const len = 4 + data.length + 4;
  const out = new Uint8Array(len + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function applyFilters(rgba, width, height, channels, dropAlpha) {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  const src = new Uint8Array(stride);
  // Reconstructed rows. Predictor a (left) is the current row's already
  // reconstructed byte; b (up) and c (up-left) come from the previous row.
  const prevRow = new Uint8Array(stride);
  const curRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) src[x * channels + c] = rgba[(y * width + x) * 4 + c];
    }
    const hasPrev = y > 0;
    const filterBytes = [
      filterNone(src, stride),
      filterSub(src, curRow, stride, channels),
      filterUp(src, prevRow, stride, hasPrev),
      filterAverage(src, curRow, prevRow, stride, channels, hasPrev),
      filterPaeth(src, curRow, prevRow, stride, channels, hasPrev),
    ];
    let bestType = 0;
    let bestSum = sumAbs(filterBytes[0]);
    for (let k = 1; k < filterBytes.length; k++) {
      const s = sumAbs(filterBytes[k]);
      if (s < bestSum) { bestType = k; bestSum = s; }
    }
    const chosen = filterBytes[bestType];
    const rowOut = y * (stride + 1);
    raw[rowOut] = bestType;
    raw.set(chosen, rowOut + 1);
    // Reconstruct the current row left-to-right so each predictor sees the
    // exact bytes the decoder will produce.
    for (let x = 0; x < stride; x++) {
      const f = chosen[x];
      const a = x >= channels ? curRow[x - channels] : 0;
      const b = hasPrev ? prevRow[x] : 0;
      const c = hasPrev && x >= channels ? prevRow[x - channels] : 0;
      let v;
      switch (bestType) {
        case 0: v = f; break;
        case 1: v = (f + a) & 0xff; break;
        case 2: v = (f + b) & 0xff; break;
        case 3: v = (f + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (f + paeth(a, b, c)) & 0xff; break;
      }
      curRow[x] = v;
    }
    prevRow.set(curRow);
  }
  return raw;
}

function filterNone(src, stride) {
  return src.slice(0, stride);
}

function sumAbs(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] < 128 ? a[i] : 256 - a[i];
  return s;
}

function filterSub(src, curRow, stride, bpp) {
  const out = new Uint8Array(stride);
  // At encode time curRow holds the current row reconstructed left-to-right;
  // callers compute all five filters before reconstructing, so here it still
  // contains the previous row — therefore the source left neighbor is used.
  for (let x = 0; x < stride; x++) out[x] = (src[x] - (x >= bpp ? src[x - bpp] : 0)) & 0xff;
  return out;
}

function filterUp(src, prevRow, stride, hasPrev) {
  const out = new Uint8Array(stride);
  for (let x = 0; x < stride; x++) out[x] = (src[x] - (hasPrev ? prevRow[x] : 0)) & 0xff;
  return out;
}

function filterAverage(src, curRow, prevRow, stride, bpp, hasPrev) {
  const out = new Uint8Array(stride);
  for (let x = 0; x < stride; x++) {
    // During filter selection curRow is the previous row; Sub's true left
    // neighbor is within src, so average uses src for the left predictor.
    const a = x >= bpp ? src[x - bpp] : 0;
    const b = hasPrev ? prevRow[x] : 0;
    out[x] = (src[x] - ((a + b) >> 1)) & 0xff;
  }
  return out;
}

function filterPaeth(src, curRow, prevRow, stride, bpp, hasPrev) {
  const out = new Uint8Array(stride);
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? src[x - bpp] : 0;
    const b = hasPrev ? prevRow[x] : 0;
    const c = hasPrev && x >= bpp ? prevRow[x - bpp] : 0;
    out[x] = (src[x] - paeth(a, b, c)) & 0xff;
  }
  return out;
}

// deflate: (Uint8Array) -> Uint8Array (zlib stream)
export function encodePng(image, deflate) {
  const { width, height, pixels } = image;
  let opaque = true;
  for (let p = 3; p < pixels.length; p += 4) {
    if (pixels[p] !== 255) { opaque = false; break; }
  }
  const bpp = 4;
  const channels = opaque ? 3 : 4;
  const colorType = opaque ? 2 : 6;
  const raw = applyFilters(pixels, width, height, channels, opaque);
  const compressed = deflate(raw);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [new Uint8Array(SIG), writeChunk('IHDR', ihdr), writeChunk('IDAT', compressed), writeChunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) { out.set(part, off); off += part.length; }
  void channels;
  return out;
}
