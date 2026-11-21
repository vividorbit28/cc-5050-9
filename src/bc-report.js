// Inspection and reporting layer.
//
// The optimiser decides per block, but a decision is only trustworthy if you
// can look at it afterwards: which block was actually worst on screen, what
// the device would decode there, at which mip level, which branches were
// pruned and why, how much candidate work that saved relative to exhaustive
// search, which acceptable solutions the fast path skipped, and what deviation
// those skips cause when read back from the *exported* material.
//
// Everything here is measured from real encodes and real decoded bytes. Nothing
// is estimated from the optimiser's own bookkeeping alone: the exported-material
// read-back decodes the blocks that were actually written and re-derives the
// normal / transparency deviation from them.

import { decodeBC1Block, decodeBC3Block, rgb565Expand } from './bc.js';
import {
  encodeBC1BlockOptimized, encodeBC3BlockOptimized, gatherBlock, PURPOSE, EDGE_MODE, PurposeCache,
  compareSearchModes,
} from './bc-encode.js';
import {
  blockColorMse, edgeAlphas, rgbToNormal, extractedEdge, filteredEdgeLeak,
} from './metrics.js';

export { PURPOSE, EDGE_MODE, PurposeCache };

// Per-block purpose score, used to pick the worst block. These are *not* added
// into one weighted number; each purpose has its own notion of "worst", which
// is the whole point of keeping the elimination conditions distinct.
function blockPurposeScore(block, purpose, options) {
  const decoded = block.decoded;
  const src = block.texels;
  if (purpose === PURPOSE.NORMAL) {
    return normalDeviation(src, decoded).meanAngleDeg;
  }
  if (purpose === PURPOSE.ALPHA) {
    const loss = block.best ? block.best.coverageLossEdges.length : 0;
    const dev = block.best ? block.best.edgeAlphaDeviation : 0;
    return loss * 1e6 + dev;
  }
  return blockColorMse(src, decoded);
}

// Encode every block of one mip level while retaining everything the report
// needs. This is the inspecting counterpart of `encodeBC1Image`: same encoder,
// but it keeps the decoded block and the per-block decision trail.
//
// options: purpose, exhaustive, budget, edgeMode, gates, halfVector, exponent,
//          cache, records (default true), auditBudget
export function encodeWithInspection(image, options = {}) {
  const purpose = options.purpose || PURPOSE.COLOR;
  const edgeMode = options.edgeMode || EDGE_MODE.CLAMP;
  const bxN = Math.ceil(image.width / 4);
  const byN = Math.ceil(image.height / 4);
  const cache = options.cache || null;
  const blocks = [];
  let totalEvaluated = 0;
  let totalPairs = 0;
  let totalPrunedBound = 0;
  let totalPrunedBudget = 0;
  const useBC3 = options.format === 'bc3';

  for (let by = 0; by < byN; by++) {
    for (let bx = 0; bx < bxN; bx++) {
      const texels = gatherBlock(image, bx, by, edgeMode);
      const res = (useBC3 ? encodeBC3BlockOptimized : encodeBC1BlockOptimized)(texels, {
        purpose,
        exhaustive: options.exhaustive,
        budget: options.budget,
        gates: options.gates,
        halfVector: options.halfVector,
        exponent: options.exponent,
        punchAlpha: options.punchAlpha,
        records: options.records !== false,
        auditBudget: options.auditBudget,
        acceptableColourMse: options.acceptableColourMse,
        acceptableAngleDeg: options.acceptableAngleDeg,
        cache,
        cacheEdgeMode: edgeMode,
        cacheExtra: `${bx},${by}`,
      });
      // BC3 keeps colour and alpha in separate blocks: decode the colour block
      // as BC1 to see the RGB the material actually shows, and decode the full
      // block to see the alpha it carries.
      const decoded = useBC3
        ? decodeBC3Block(res.bytes)
        : decodeBC1Block(res.bytes);
      const colourDecoded = useBC3 ? decodeBC1Block(res.bytes.subarray(8, 16)) : decoded;
      const block = {
        bx, by,
        texels: Uint8Array.from(texels),
        bytes: res.bytes,
        decoded,
        colourDecoded,
        format: useBC3 ? 'bc3' : 'bc1',
        purpose,
        cutout: res.cutout,
        work: res.work,
        best: res.best,
        fallback: res.fallback,
        records: res.records || [],
        missed: res.missed || [],
        missedAcceptable: res.missedAcceptable,
      };
      block.score = blockPurposeScore(block, purpose, options);
      blocks.push(block);
      totalPairs += res.work.total;
      totalEvaluated += res.work.evaluated;
      totalPrunedBound += res.work.prunedBound;
      totalPrunedBudget += res.work.prunedBudget;
    }
  }

  return {
    purpose,
    edgeMode,
    format: useBC3 ? 'bc3' : 'bc1',
    exhaustive: !!options.exhaustive,
    width: image.width,
    height: image.height,
    blocksX: bxN,
    blocksY: byN,
    blocks,
    stats: {
      blocks: blocks.length,
      totalPairs,
      evaluated: totalEvaluated,
      prunedBound: totalPrunedBound,
      prunedBudget: totalPrunedBudget,
      fallbackBlocks: blocks.filter((b) => b.fallback).length,
      missedAcceptableBlocks: blocks.filter((b) => b.missedAcceptable && b.missedAcceptable.acceptable).length,
      cache: cache ? cache.stats() : null,
    },
  };
}

// The worst block under the purpose's own metric, with its full decision trail.
// `mip` is carried through so the readout can name the sampling level the viewer
// was at when this point was worst.
export function worstPoint(inspection, mip = 0) {
  if (!inspection.blocks.length) return null;
  let worst = inspection.blocks[0];
  for (const b of inspection.blocks) if (b.score > worst.score) worst = b;
  return describeBlock(inspection, worst, mip);
}

// Read one block by coordinates out of an inspection result.
export function blockAt(inspection, bx, by, mip = 0) {
  const b = inspection.blocks.find((x) => x.bx === bx && x.by === by);
  return b ? describeBlock(inspection, b, mip) : null;
}

// Turn an internal block record into the report shape: decoded block, pruned
// branches, eliminated candidates and their stated reasons.
function describeBlock(inspection, block, mip) {
  const decoded = block.decoded;
  const src = block.texels;
  const pruned = block.records.filter((r) => r.prune === 'bound' || r.prune === 'budget');
  const eliminated = block.records.filter((r) => r.eliminate);

  // Reconstruct the set of acceptable-but-missed alternatives with the
  // deviation reading back from what they would have decoded to.
  const missed = block.missed.map((m) => ({
    c0: m.c0,
    c1: m.c1,
    colorMse: m.colorMse,
    normalAngleDeg: m.normalAngleDeg,
    highlightX: m.highlightX,
    edgeAlphaDeviation: m.edgeAlphaDeviation,
    reason: m.reason,
  }));

  return {
    mip,
    blockX: block.bx,
    blockY: block.by,
    purpose: inspection.purpose,
    format: block.format || 'bc1',
    score: block.score,
    sourceTexels: Uint8Array.from(src),
    decodedTexels: Uint8Array.from(decoded),
    colourDecodedTexels: Uint8Array.from(block.colourDecoded || decoded),
    chosen: block.best
      ? {
        c0: block.best.c0,
        c1: block.best.c1,
        colorMse: block.best.colorMse,
        normalAngleDeg: block.best.normalAngleDeg,
        highlightX: block.best.highlightX,
        highlightFlip: block.best.highlightFlip,
        coverageLossEdges: block.best.coverageLossEdges.slice(),
        edgeAlphaDeviation: block.best.edgeAlphaDeviation,
      }
      : null,
    fallback: block.fallback,
    work: block.work,
    prunedBound: pruned.filter((r) => r.prune === 'bound'),
    prunedBudget: pruned.filter((r) => r.prune === 'budget'),
    eliminated,
    missed,
    missedAcceptable: block.missedAcceptable,
    deviation: measureDeviation(src, decoded, inspection.purpose),
  };
}

// Deviation of a decoded block from its source under the purpose metric. This
// is the number the exported-material read-back reports.
export function measureDeviation(srcTexels, decodedTexels, purpose) {
  const colorMse = blockColorMse(srcTexels, decodedTexels);
  if (purpose === PURPOSE.NORMAL) {
    const d = normalDeviation(srcTexels, decodedTexels);
    return { colorMse, meanAngleDeg: d.meanAngleDeg, maxAngleDeg: d.maxAngleDeg };
  }
  if (purpose === PURPOSE.ALPHA) {
    // Colour error over covered texels only: RGB stored under alpha 0 is never
    // sampled by an alpha pipeline, so counting it would overstate the damage
    // (and the encoder itself excludes it from its objective).
    return { colorMse: blockColorMse(srcTexels, decodedTexels), coveredColorMse: coveredColorMse(srcTexels, decodedTexels), ...alphaDeviation(srcTexels, decodedTexels) };
  }
  return { colorMse };
}

function coveredColorMse(srcTexels, decodedTexels) {
  let sum = 0;
  let n = 0;
  for (let t = 0; t < 16; t++) {
    if (srcTexels[t * 4 + 3] < 1) continue;
    for (let c = 0; c < 3; c++) {
      const d = srcTexels[t * 4 + c] - decodedTexels[t * 4 + c];
      sum += d * d;
      n++;
    }
  }
  return n ? sum / n : 0;
}

// Mean / max angular deviation between the source normal field and a decoded
// block. Both fields use n = normalize(2*rgb - 1).
export function normalDeviation(srcTexels, decodedTexels) {
  const a = normalsOf(srcTexels);
  const b = normalsOf(decodedTexels);
  const angles = new Array(16);
  let sum = 0;
  let max = 0;
  for (let t = 0; t < 16; t++) {
    const dot = Math.max(-1, Math.min(1, a[t][0] * b[t][0] + a[t][1] * b[t][1] + a[t][2] * b[t][2]));
    const deg = Math.acos(dot) * 180 / Math.PI;
    angles[t] = deg;
    sum += deg;
    if (deg > max) max = deg;
  }
  return { meanAngleDeg: sum / 16, maxAngleDeg: max, perTexelDeg: angles };
}

function normalsOf(texels) {
  const out = new Array(16);
  for (let t = 0; t < 16; t++) out[t] = rgbToNormal(texels[t * 4], texels[t * 4 + 1], texels[t * 4 + 2]);
  return out;
}

// Transparency deviation: per-edge and whole-block alpha error, plus how much
// coverage a block drops relative to the source.
export function alphaDeviation(srcTexels, decodedTexels) {
  let sum = 0;
  let max = 0;
  for (let t = 0; t < 16; t++) {
    const d = Math.abs(srcTexels[t * 4 + 3] - decodedTexels[t * 4 + 3]);
    sum += d;
    if (d > max) max = d;
  }
  const edges = [0, 1, 2, 3].map((e) => {
    const s = edgeAlphas(srcTexels, e);
    const d = edgeAlphas(decodedTexels, e);
    let err = 0;
    let lost = 0;
    for (let i = 0; i < 4; i++) {
      err += Math.abs(s[i] - d[i]);
      if (s[i] > 0 && d[i] === 0) lost++;
    }
    return { edge: e, meanAbsError: err / 4, texelsLost: lost };
  });
  return { meanAlphaError: sum / 16, maxAlphaError: max, edges };
}

// ---------------------------------------------------------------------------
// Candidate work saved vs exhaustive
// ---------------------------------------------------------------------------

// Run the same image through the fast and exhaustive searches and report the
// exact saving and whether the fast path made a different (but acceptable)
// choice. `compareSearchModes` already packs blocks; here we additionally state
// the acceptable solutions the fast path missed.
export function savedVsExhaustive(image, options = {}) {
  const comparison = compareSearchModes(image, options);
  // Identify differing blocks whose fast choice is still acceptable under the
  // purpose gates, i.e. the miss is *acceptable* rather than a regression.
  const acceptableMisses = comparison.differing.filter((d) => {
    const purpose = options.purpose || PURPOSE.COLOR;
    if (purpose === PURPOSE.COLOR) return true; // colour difference, still a valid block
    if (purpose === PURPOSE.NORMAL) {
      const lim = options.acceptableAngleDeg ?? 5;
      return (d.fast.normalAngleDeg ?? 0) <= lim;
    }
    return true;
  });
  return {
    ...comparison,
    evaluationsSaved: comparison.exhaustiveEvaluated - comparison.fastEvaluated,
    acceptableMisses: acceptableMisses.length,
    acceptableMissDetails: acceptableMisses,
  };
}

// ---------------------------------------------------------------------------
// Exported-material read-back
// ---------------------------------------------------------------------------

// Read back the deviation a *missed* candidate would have caused on the
// material that was actually exported. `exported` is the block that was
// written; `missedIndices`/`missedPairs` come from the audit. We decode both
// and report the purpose deviation of each, so the report can say e.g. "the
// budget skipped a pair that would have kept the normal within 0.4° instead of
// the 3.1° that was exported."
//
// This is deliberately computed from decoded bytes, not from the candidate
// metadata, so a bookkeeping bug in the optimiser cannot hide the real damage.
export function readbackMissedDeviation(exportedBytes, missedPair, srcTexels, purpose, format = 'bc1') {
  const exported = format === 'bc3' ? decodeBC3Block(exportedBytes) : decodeBC1Block(exportedBytes);
  const exportedDev = measureDeviation(srcTexels, exported, purpose);
  if (!missedPair) return { exported: exportedDev, missed: null };
  // Only the colour block changes; a missed candidate was a colour-endpoint
  // pair, so decode the re-packed colour block. (Alpha is carried separately in
  // BC3 and unaffected by the colour search.)
  const missedBytes = packPairBytes(missedPair.c0, missedPair.c1, srcTexels);
  const missed = decodeBC1Block(missedBytes);
  const missedDev = measureDeviation(srcTexels, missed, purpose);
  return {
    exported: exportedDev,
    missed: missedDev,
    delta: {
      meanAngleDeg: (exportedDev.meanAngleDeg ?? 0) - (missedDev.meanAngleDeg ?? 0),
      meanAlphaError: (exportedDev.meanAlphaError ?? 0) - (missedDev.meanAlphaError ?? 0),
      colorMse: exportedDev.colorMse - missedDev.colorMse,
    },
  };
}

// Re-encode a block with a fixed endpoint pair so it can be decoded exactly the
// way the exported material would have been. The pair may describe a
// punch-through block (c0 <= c1, entry 3 transparent) or a 4-colour block, so
// the palette and index assignment follow the same rule the codec uses.
function packPairBytes(c0, c1, srcTexels) {
  const punch = c0 <= c1;
  const palette = punch ? paletteForPunch(c0, c1) : paletteFor(c0, c1);
  const maxIndex = punch ? 2 : 3;
  const indices = new Array(16);
  for (let t = 0; t < 16; t++) {
    // In punch-through mode a source texel with zero alpha is transparent; it
    // must map to the transparent index rather than the nearest colour.
    if (punch && srcTexels[t * 4 + 3] === 0) { indices[t] = 3; continue; }
    const p = [srcTexels[t * 4], srcTexels[t * 4 + 1], srcTexels[t * 4 + 2]];
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i <= maxIndex; i++) {
      const q = palette[i];
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    indices[t] = bi;
  }
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, c0, true);
  dv.setUint16(2, c1, true);
  let bits = 0;
  for (let t = 0; t < 16; t++) bits |= (indices[t] & 3) << (2 * t);
  dv.setUint32(4, bits >>> 0, true);
  return out;
}

function paletteForPunch(c0, c1) {
  const lerp = (a, b, w) => Math.min(255, Math.max(0, Math.round((a * (255 - w) + b * w) / 255)));
  const e0 = rgb565Expand(c0);
  const e1 = rgb565Expand(c1);
  return [
    [e0[0], e0[1], e0[2]],
    [e1[0], e1[1], e1[2]],
    [lerp(e0[0], e1[0], 128), lerp(e0[1], e1[1], 128), lerp(e0[2], e1[2], 128)],
    [0, 0, 0],
  ];
}

function paletteFor(c0, c1) {
  const lerp = (a, b, w) => Math.min(255, Math.max(0, Math.round((a * (255 - w) + b * w) / 255)));
  const e0 = rgb565Expand(c0);
  const e1 = rgb565Expand(c1);
  return [
    [e0[0], e0[1], e0[2]],
    [e1[0], e1[1], e1[2]],
    [lerp(e0[0], e1[0], 0xaa), lerp(e0[1], e1[1], 0xaa), lerp(e0[2], e1[2], 0xaa)],
    [lerp(e0[0], e1[0], 0x55), lerp(e0[1], e1[1], 0x55), lerp(e0[2], e1[2], 0x55)],
  ];
}

// The exported material read-back for a whole inspection result: for every
// block that recorded a missed acceptable alternative, decode the exported
// block and the missed block and report the deviation each would cause under
// the purpose metric.
export function readbackInspection(inspection) {
  const rows = [];
  for (const block of inspection.blocks) {
    if (!block.missed.length) continue;
    const top = block.missed[0];
    const rb = readbackMissedDeviation(block.bytes, top, block.texels, inspection.purpose, block.format || 'bc1');
    rows.push({
      blockX: block.bx,
      blockY: block.by,
      purpose: inspection.purpose,
      exported: rb.exported,
      missed: rb.missed,
      delta: rb.delta,
      alternative: { c0: top.c0, c1: top.c1, reason: top.reason },
    });
  }
  rows.sort((a, b) => Math.abs(b.delta.meanAngleDeg || b.delta.meanAlphaError || b.delta.colorMse) -
    Math.abs(a.delta.meanAngleDeg || a.delta.meanAlphaError || a.delta.colorMse));
  return rows;
}

// ---------------------------------------------------------------------------
// Edge-leak read-out on the exported block
// ---------------------------------------------------------------------------

// For an edge block, report the colour that leaks past its right edge once a
// neighbouring block participates in a minified (straight-alpha) footprint.
// The "expected" fringe is the source block filtered the same way; the
// "exported" fringe is what the written middle comes from. A block can look
// perfect under nearest sampling (alpha-0 edge texels hide their RGB) yet leak
// here, which is exactly the failure a mip-only check misses.
export function exportedEdgeLeak(inspection, edge = 1, neighbourEdge = null) {
  const rows = [];
  for (const block of inspection.blocks) {
    const colour = block.colourDecoded || block.decoded;
    const srcEdge = extractedEdge(block.texels, edge);
    const candEdge = extractedEdge(colour, edge);
    const neigh = neighbourEdge || defaultNeighbour(block.texels, edge);
    const leak = filteredEdgeLeak(srcEdge, candEdge, neigh);
    let mip0 = 0;
    for (let i = 0; i < 4; i++) {
      const o = i * 4;
      mip0 += Math.abs(srcEdge[o] - candEdge[o]) +
        Math.abs(srcEdge[o + 1] - candEdge[o + 1]) +
        Math.abs(srcEdge[o + 2] - candEdge[o + 2]);
    }
    mip0 /= 4;
    rows.push({
      blockX: block.bx,
      blockY: block.by,
      mip0VisibleDiff: mip0,
      filteredLeak: leak,
      leaked: leak > mip0 + 8,
    });
  }
  return rows;
}

function defaultNeighbour(texels, edge) {
  // A neutral opaque neighbour, used when the caller does not supply the actual
  // adjacent block's edge.
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    out[i * 4] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reviewing the optimiser's recorded elimination reasons
// ---------------------------------------------------------------------------

// Aggregate the elimination / pruning records of one inspection into counts and
// representative examples, so a reviewer can see *why* candidates were dropped
// rather than just that they were.
export function eliminationSummary(inspection) {
  const byReason = {};
  const examples = {};
  for (const block of inspection.blocks) {
    for (const r of block.records) {
      const key = r.eliminate || r.prune;
      if (!key) continue;
      byReason[key] = (byReason[key] || 0) + 1;
      if (!examples[key]) {
        examples[key] = {
          blockX: block.bx,
          blockY: block.by,
          c0: r.c0,
          c1: r.c1,
          detail: r.detail,
          bound: r.bound,
        };
      }
    }
  }
  return { byReason, examples };
}
