// .gtex resource container.
//
// Layout (all integers little-endian, all offsets absolute from file start):
//
//   Header (32 bytes)
//   Payload table: payloadCount * 24 bytes
//   Mip tables: for each payload in order, mipCount * 32 bytes
//   Data blobs (offsets given by the payload/mip tables)
//
// A container always carries the block-compressed encodings that the tool
// supports plus an uncompressed RGBA8 payload. The RGBA8 payload is an
// *explicit* fallback used when the device does not advertise a compression
// feature; it is never silently substituted by a driver.

import {
  blocksX, blocksY, encodeBC1, encodeBC3, decodeBC1, decodeBC3, BLOCK_BYTES,
} from './bc.js';
import { mipLevelCount } from './mip.js';

export const MAGIC = 0x58455447; // 'GTEX'
export const VERSION = 1;

export const FLAG_SRGB = 1 << 0;

export const FOURCC = {
  BC1: makeFourcc('B', 'C', '1', 0),
  BC3: makeFourcc('B', 'C', '3', 0),
  RGBA8: makeFourcc('R', 'G', 'B', 'A'),
};

export const FORMAT_NAME = {
  [FOURCC.BC1]: 'BC1 (BC4_UNORM_BLOCK, 4bpp)',
  [FOURCC.BC3]: 'BC3 (BC7_UNORM_BLOCK, 1 byte/texel)',
  [FOURCC.RGBA8]: 'RGBA8 uncompressed fallback (4 bytes/texel)',
};

function makeFourcc(a, b, c, d) {
  return (a.charCodeAt(0)) | (b.charCodeAt(0) << 8) | (c.charCodeAt(0) << 16) | (d << 24);
}

const HEADER_SIZE = 32;
const PAYLOAD_ENTRY_SIZE = 24;
const MIP_ENTRY_SIZE = 32;

export function padToBlock(v) {
  return Math.max(4, Math.ceil(v / 4) * 4);
}

// Edge-clamp an image to block-aligned dimensions; stores premultiplied-free
// raw RGBA. Padded texels replicate the nearest real edge texel so that a GPU
// sampling inside the padded region never reads garbage.
export function padImage(image, paddedW, paddedH) {
  const out = new Uint8Array(paddedW * paddedH * 4);
  for (let y = 0; y < paddedH; y++) {
    for (let x = 0; x < paddedW; x++) {
      const sx = Math.min(image.width - 1, x);
      const sy = Math.min(image.height - 1, y);
      out.set(
        image.pixels.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4),
        (y * paddedW + x) * 4,
      );
    }
  }
  return out;
}

// Encode every mip level of a chain into one container.
// levels: array of RGBA images (level 0 = full size).
// transfer: 'srgb' | 'linear'
export function writeGtex(levels, transfer = 'srgb') {
  const width = levels[0].width;
  const height = levels[0].height;
  const mipCount = levels.length;
  if (mipCount !== mipLevelCount(width, height)) {
    throw new Error(`mip count ${mipCount} does not match dimensions ${width}x${height}`);
  }

  const formats = [FOURCC.BC1, FOURCC.BC3, FOURCC.RGBA8];
  const payloadCount = formats.length;
  const mipTableSize = payloadCount * mipCount * MIP_ENTRY_SIZE;
  let cursor = HEADER_SIZE + payloadCount * PAYLOAD_ENTRY_SIZE + mipTableSize;

  const payloads = formats.map((format) => {
    const mips = levels.map((level, mip) => {
      const pw = padToBlock(level.width);
      const ph = padToBlock(level.height);
      let bytes;
      if (format === FOURCC.BC1) {
        bytes = encodeBC1(level);
      } else if (format === FOURCC.BC3) {
        bytes = encodeBC3(level);
      } else {
        bytes = padImage(level, pw, ph);
      }
      const entry = {
        width: level.width,
        height: level.height,
        paddedWidth: pw,
        paddedHeight: ph,
        offset: cursor,
        size: bytes.length,
        bytes,
      };
      cursor += bytes.length;
      return entry;
    });
    return { format, mips };
  });

  const total = cursor;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, transfer === 'srgb' ? FLAG_SRGB : 0, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, padToBlock(width), true);
  view.setUint32(20, padToBlock(height), true);
  view.setUint32(24, mipCount, true);
  view.setUint32(28, payloadCount, true);

  let tablePos = HEADER_SIZE;
  for (const payload of payloads) {
    const first = payload.mips[0];
    view.setUint32(tablePos, payload.format, true);
    view.setUint32(tablePos + 4, payload.mips.length, true);
    view.setUint32(tablePos + 8, first.offset, true);
    view.setUint32(tablePos + 12, payload.mips.reduce((n, m) => n + m.size, 0), true);
    view.setUint32(tablePos + 16, 0, true);
    view.setUint32(tablePos + 20, 0, true);
    tablePos += PAYLOAD_ENTRY_SIZE;
  }

  for (const payload of payloads) {
    for (const m of payload.mips) {
      view.setUint32(tablePos, m.width, true);
      view.setUint32(tablePos + 4, m.height, true);
      view.setUint32(tablePos + 8, m.offset, true);
      view.setUint32(tablePos + 12, m.size, true);
      view.setUint32(tablePos + 16, m.paddedWidth, true);
      view.setUint32(tablePos + 20, m.paddedHeight, true);
      view.setUint32(tablePos + 24, 0, true);
      view.setUint32(tablePos + 28, 0, true);
      tablePos += MIP_ENTRY_SIZE;
    }
  }

  for (const payload of payloads) {
    for (const m of payload.mips) u8.set(m.bytes, m.offset);
  }

  return u8;
}

// Parse headers/tables without copying payload bytes.
export function readGtex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < HEADER_SIZE) throw new Error('file smaller than GTEX header');
  if (view.getUint32(0, true) !== MAGIC) throw new Error('bad GTEX magic');
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`unsupported GTEX version ${version}`);
  const flags = view.getUint16(6, true);
  const header = {
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    paddedWidth: view.getUint32(16, true),
    paddedHeight: view.getUint32(20, true),
    mipCount: view.getUint32(24, true),
    payloadCount: view.getUint32(28, true),
    flags,
    transfer: (flags & FLAG_SRGB) ? 'srgb' : 'linear',
  };

  const payloads = [];
  let pos = HEADER_SIZE;
  for (let i = 0; i < header.payloadCount; i++) {
    const format = view.getUint32(pos, true);
    const mipCount = view.getUint32(pos + 4, true);
    const dataOffset = view.getUint32(pos + 8, true);
    const dataSize = view.getUint32(pos + 12, true);
    payloads.push({ format, mipCount, dataOffset, dataSize, mips: [] });
    pos += PAYLOAD_ENTRY_SIZE;
  }
  for (const payload of payloads) {
    for (let m = 0; m < payload.mipCount; m++) {
      payload.mips.push({
        width: view.getUint32(pos, true),
        height: view.getUint32(pos + 4, true),
        offset: view.getUint32(pos + 8, true),
        size: view.getUint32(pos + 12, true),
        paddedWidth: view.getUint32(pos + 16, true),
        paddedHeight: view.getUint32(pos + 20, true),
      });
      pos += MIP_ENTRY_SIZE;
    }
  }
  return { header, payloads, bytes: u8, view };
}

// Structural verification: offsets, block boundaries, mip geometry and blob
// sizes are checked against what the format specification requires.
export function validateGtex(parsed) {
  const errors = [];
  const warnings = [];
  const { header, payloads, bytes } = parsed;
  const fileLen = bytes.byteLength;

  if (header.paddedWidth !== padToBlock(header.width)) errors.push('level-0 paddedWidth is not block aligned');
  if (header.paddedHeight !== padToBlock(header.height)) errors.push('level-0 paddedHeight is not block aligned');
  if (header.mipCount !== mipLevelCount(header.width, header.height)) errors.push('mip count does not match dimensions');

  const intervals = [];
  for (const payload of payloads) {
    if (payload.mipCount !== header.mipCount) errors.push(`payload ${fourccString(payload.format)} has wrong mip count`);
    let expectedTotal = 0;
    payload.mips.forEach((m, level) => {
      const expW = Math.max(1, header.width >> level);
      const expH = Math.max(1, header.height >> level);
      if (m.width !== expW || m.height !== expH) errors.push(`mip ${level} dimensions ${m.width}x${m.height}, expected ${expW}x${expH}`);
      if (m.paddedWidth !== padToBlock(m.width) || m.paddedHeight !== padToBlock(m.height)) {
        errors.push(`mip ${level} padding is not block aligned`);
      }
      let expectedSize;
      if (payload.format === FOURCC.RGBA8) {
        expectedSize = m.paddedWidth * m.paddedHeight * 4;
      } else {
        const bpp = BLOCK_BYTES[payload.format === FOURCC.BC1 ? 'bc1' : 'bc3'];
        expectedSize = blocksX(m.width) * blocksY(m.height) * bpp;
      }
      if (m.size !== expectedSize) errors.push(`mip ${level} of ${fourccString(payload.format)}: blob size ${m.size}, expected ${expectedSize}`);
      expectedTotal += m.size;
      if (m.offset < HEADER_SIZE || m.offset + m.size > fileLen) errors.push(`mip ${level} blob out of file bounds`);
      intervals.push([m.offset, m.offset + m.size, `${fourccString(payload.format)} mip${level}`]);
    });
    if (payload.dataOffset !== payload.mips[0].offset) errors.push('payload dataOffset does not point at first mip blob');
    if (payload.dataSize !== expectedTotal) errors.push(`payload ${fourccString(payload.format)} total size mismatch`);
  }

  intervals.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i][0] < intervals[i - 1][1]) {
      errors.push(`overlapping blobs: ${intervals[i - 1][2]} and ${intervals[i][2]}`);
    }
  }
  if (!payloads.some((p) => p.format === FOURCC.RGBA8)) {
    warnings.push('no RGBA8 fallback payload present');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function fourccString(fourcc) {
  const chars = [fourcc & 0xff, (fourcc >> 8) & 0xff, (fourcc >> 16) & 0xff, (fourcc >> 24) & 0xff];
  return chars.filter((c) => c !== 0).map((c) => String.fromCharCode(c)).join('');
}

// Decode a payload's mip blobs to logical-size RGBA images.
export function decodePayloadMips(parsed, format) {
  const payload = parsed.payloads.find((p) => p.format === format);
  if (!payload) throw new Error(`container has no ${fourccString(format)} payload`);
  return payload.mips.map((m) => {
    const blob = parsed.bytes.subarray(m.offset, m.offset + m.size);
    if (format === FOURCC.RGBA8) {
      const full = new Uint8Array(m.width * m.height * 4);
      for (let y = 0; y < m.height; y++) {
        full.set(blob.subarray(y * m.paddedWidth * 4, y * m.paddedWidth * 4 + m.width * 4), y * m.width * 4);
      }
      return { width: m.width, height: m.height, pixels: full };
    }
    if (format === FOURCC.BC1) {
      return { width: m.width, height: m.height, pixels: decodeBC1(blob, m.width, m.height) };
    }
    return { width: m.width, height: m.height, pixels: decodeBC3(blob, m.width, m.height) };
  });
}
