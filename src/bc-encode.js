// Purpose-aware BC1/BC3 encoder.
//
// A thin layer over the reference codec and the gated candidate search. For
// each block it decides which elimination conditions apply, runs the search,
// and records everything needed to justify the choice:
//
//   * work accounting: how many endpoint pairs were considered, evaluated, or
//     pruned by the sound lower bound vs the evaluation budget;
//   * per-pair records: why each candidate was eliminated or pruned;
//   * the exhaustive answer, so the report can state what the fast path missed
//     and whether that miss was acceptable;
//   * the edge convention (clamp vs tile) used to build the block.
//
// The encoder is deterministic and side-effect free. An optional PurposeCache
// lets repeated encodes with the same source/purpose/edge-mode reuse work; a
// value cached for one purpose or edge convention is never served for another
// because both are part of the cache key.

import { encodeBC1Block, encodeBC3Block } from './bc.js';
import {
  PURPOSE, PRUNE, ELIMINATE, searchEndpoints, buildCandidates, buildEndpointPairs,
  evaluatePairPunch, auditBudgetPruned,
} from './bc-optimizer.js';
import {
  rgbToNormal, edgeCoverage, highlightCentroid,
} from './metrics.js';
import { EDGE_MODE, PurposeCache } from './bc-cache.js';

export { PURPOSE, PRUNE, ELIMINATE, EDGE_MODE, PurposeCache };

// ---------------------------------------------------------------------------
// Block texel helpers
// ---------------------------------------------------------------------------

export function texelsToColors(texels) {
  const out = new Array(16);
  for (let t = 0; t < 16; t++) out[t] = [texels[t * 4], texels[t * 4 + 1], texels[t * 4 + 2]];
  return out;
}

function colorsToNormal(colors) {
  return colors.map((c) => rgbToNormal(c[0], c[1], c[2]));
}

function decodedToFlat(decoded) {
  const out = new Uint8Array(64);
  for (let t = 0; t < 16; t++) {
    out[t * 4] = decoded[t][0];
    out[t * 4 + 1] = decoded[t][1];
    out[t * 4 + 2] = decoded[t][2];
    out[t * 4 + 3] = 255;
  }
  return out;
}

// Cutout blocks use BC1's punch-through mode (c0 <= c1) and are outside the
// 4-colour search, so they go straight to the reference encoder.
export function isCutoutBlock(texels, punchAlpha) {
  if (!punchAlpha) return false;
  let anyLow = false;
  let allBinary = true;
  for (let t = 0; t < 16; t++) {
    const a = texels[t * 4 + 3];
    if (a < 128) anyLow = true;
    if (!(a <= 24 || a >= 232)) allBinary = false;
  }
  return anyLow && allBinary;
}

// Build the analysis context shared by the gates.
export function buildContext(texels, options) {
  const purpose = options.purpose || PURPOSE.COLOR;
  const ctx = { purpose };
  if (purpose === PURPOSE.NORMAL) {
    ctx.srcNormals = colorsToNormal(texelsToColors(texels));
    ctx.halfVector = options.halfVector || null;
    ctx.exponent = options.exponent || null;
    ctx.srcHighlight = ctx.halfVector && ctx.exponent
      ? highlightCentroid(ctx.srcNormals, ctx.halfVector, ctx.exponent)
      : null;
  }
  if (purpose === PURPOSE.ALPHA) {
    // Source edge coverage and mean alpha per edge. The coverage gate rejects a
    // candidate that drops an edge to (near) zero alpha where the source had
    // coverage; the mean alpha is what the leak report compares against.
    const srcAlpha = new Array(16);
    for (let t = 0; t < 16; t++) srcAlpha[t] = texels[t * 4 + 3];
    ctx.edgeCoverage = {
      src: [0, 1, 2, 3].map((e) => edgeCoverage(texels, e)),
      srcAlphaMean: [0, 1, 2, 3].map((e) => {
        let s = 0;
        for (let i = 0; i < 4; i++) s += edgeAlphaAt(srcAlpha, e, i);
        return s / 4;
      }),
      lossThreshold: options.coverageLossThreshold ?? 0.01,
    };
  }
  return ctx;
}

function edgeAlphaAt(alphas, edge, i) {
  const t = edge === 0 ? i * 4 : edge === 1 ? i * 4 + 3 : edge === 2 ? i : 12 + i;
  return alphas[t];
}

// ---------------------------------------------------------------------------
// Single block
// ---------------------------------------------------------------------------

// options:
//   purpose, gates, exhaustive, budget, lowerBound, records
//   punchAlpha (BC1)
//   halfVector, exponent (NORMAL)
//   cache, cacheEdgeMode, cacheExtra
//   acceptableColourMse, acceptableAngleDeg
export function encodeBC1BlockOptimized(texels, options = {}) {
  const purpose = options.purpose || PURPOSE.COLOR;
  const edgeMode = options.cacheEdgeMode || EDGE_MODE.CLAMP;
  const exhaustive = !!options.exhaustive;
  const cache = options.cache;
  const cacheExtra = options.cacheExtra || '';
  const gates = options.gates || {};
  const cutout = isCutoutBlock(texels, options.punchAlpha);

  // Non-cutout BC1 or BC3 colour: the reference helper for opaque blocks is the
  // 4-colour search below. Cutout blocks normally go straight to the reference
  // encoder, except under the ALPHA purpose where we search punch-through
  // candidates explicitly so edge coverage can be preserved deliberately.
  if (cutout && purpose !== PURPOSE.ALPHA) {
    return {
      bytes: encodeBC1Block(texels, { punchAlpha: true }),
      purpose, exhaustive, reused: false, cutout: true,
      work: { total: 0, evaluated: 0, prunedBound: 0, prunedBudget: 0 },
      best: null, colourBest: null, missed: [], records: [], fallback: false,
      missedAcceptable: null,
    };
  }

  const cacheKeyExtra = `gates=${JSON.stringify(gates)}|ex=${exhaustive ? 1 : 0}|cut=${cutout ? 1 : 0}`;
  if (cache) {
    const hit = cache.get(texels, purpose, edgeMode, `${cacheExtra}|${cacheKeyExtra}`);
    if (hit) return { ...hit, reused: true };
  }

  const srcColors = texelsToColors(texels);
  const srcAlphas = new Array(16);
  for (let t = 0; t < 16; t++) srcAlphas[t] = texels[t * 4 + 3];
  // Cutout blocks use punch-through endpoints (c0 <= c1); opaque blocks use the
  // 4-colour search. The pair list is the same unordered set; only the
  // evaluator and the endpoint ordering differ.
  const candidates = buildCandidates(srcColors);
  const pairs = buildEndpointPairs(candidates);
  const ctx = buildContext(texels, options);
  ctx.cutout = cutout;

  const evaluator = cutout
    ? (c0, c1) => {
      // Punch-through requires c0 <= c1. Evaluate the ordered pair directly.
      const lo = Math.min(c0, c1);
      const hi = Math.max(c0, c1);
      return evaluatePairPunch(srcColors, srcAlphas, lo, hi);
    }
    : null;

  const fast = searchEndpoints(srcColors, pairs, purpose, {
    gates, exhaustive,
    budget: options.budget ?? Infinity,
    lowerBound: options.lowerBound !== false,
    records: !!options.records,
    ctx,
    evaluator,
    boundInclude: cutout ? srcAlphas.map((a) => (a >= 128 ? 1 : 0)) : null,
  });

  // Exhaustive reference (colour objective only) computed lazily: the caller
  // decides whether it needs the "what did the optimiser miss" comparison.
  let colourOnly = null;
  if (options.compareToColourOnly) {
    colourOnly = searchEndpoints(srcColors, pairs, PURPOSE.COLOR, {
      exhaustive: true, records: false, ctx: {},
    });
  }

  const bytes = packChosenOrFallback(fast, texels, cutout);

  // Audit budget-pruned pairs when requested: which acceptable alternatives
  // were skipped purely because the budget ran out, and how much they would
  // have improved the purpose metric.
  let missed = [];
  if (options.auditBudget && !exhaustive && fast.work.prunedBudget > 0 && fast.best) {
    const evaluatedKeys = fast.candidates.map((c) => c.c0 * 65536 + c.c1);
    missed = auditBudgetPruned(srcColors, pairs, fast.best, purpose, {
      gates, ctx, evaluatedPairs: evaluatedKeys, minColorMse: fast.minColorMse,
      evaluator, boundInclude: cutout ? srcAlphas.map((a) => (a >= 128 ? 1 : 0)) : null,
    });
  }

  const result = {
    bytes,
    purpose,
    exhaustive,
    reused: false,
    cutout: false,
    work: fast.work,
    best: fast.best,
    colourBest: colourOnly ? colourOnly.best : null,
    minColorMse: fast.minColorMse,
    fallback: fast.fallback,
    gates: fast.gates,
    records: fast.records,
    missed,
    missedAcceptable: summariseMissed(missed, options),
  };

  if (cache) cache.set(texels, purpose, edgeMode, result, `${cacheExtra}|${cacheKeyExtra}`);
  return result;
}

function summariseMissed(missed, options) {
  if (!missed.length) return null;
  const top = missed[0];
  return {
    count: missed.length,
    bestAlternative: { c0: top.c0, c1: top.c1, colorMse: top.colorMse, normalAngleDeg: top.normalAngleDeg, highlightX: top.highlightX },
    acceptable: (top.normalAngleDeg == null || top.normalAngleDeg <= (options.acceptableAngleDeg ?? Infinity)) &&
      top.colorMse <= (options.acceptableColourMse ?? Infinity),
  };
}

function packBC1Result(cand) {
  const out = new Uint8Array(8);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, cand.c0, true);
  dv.setUint16(2, cand.c1, true);
  let bits = 0;
  for (let t = 0; t < 16; t++) bits |= (cand.indices[t] & 3) << (2 * t);
  dv.setUint32(4, bits >>> 0, true);
  return out;
}

// The search carries only colours/indices; when it produced the choice we pack
// it, and when it fell back (no candidate passed every gate) we still have the
// best colour candidate, which is a valid block.
function packChosenOrFallback(fast, texels, cutout) {
  if (fast.best) return packBC1Result(fast.best);
  return encodeBC1Block(texels, { punchAlpha: cutout });
}

export function encodeBC3BlockOptimized(texels, options = {}) {
  const colour = encodeBC1BlockOptimized(texels, { ...options, punchAlpha: false });
  const alphaBlock = encodeBC3Block(texels).subarray(0, 8);
  const out = new Uint8Array(16);
  out.set(alphaBlock, 0);
  out.set(colour.bytes, 8);
  return { ...colour, bytes: out };
}

// ---------------------------------------------------------------------------
// Image level
// ---------------------------------------------------------------------------

export function encodeBC1Image(image, options = {}) {
  return encodeImage(image, options, 8, encodeBC1BlockOptimized);
}

export function encodeBC3Image(image, options = {}) {
  return encodeImage(image, options, 16, encodeBC3BlockOptimized);
}

function encodeImage(image, options, blockBytes, encodeBlock) {
  const bx = Math.ceil(image.width / 4);
  const by = Math.ceil(image.height / 4);
  const out = new Uint8Array(bx * by * blockBytes);
  const stats = {
    blocks: bx * by,
    totalPairs: 0,
    evaluated: 0,
    prunedBound: 0,
    prunedBudget: 0,
    reused: 0,
    fallbackBlocks: 0,
    missedBlocks: [],
    records: [],
  };
  const cache = options.cache;
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const texels = gatherBlock(image, x, y, options.edgeMode || EDGE_MODE.CLAMP);
      const res = encodeBlock(texels, blockOptions(image, x, y, texels, options));
      out.set(res.bytes, (y * bx + x) * blockBytes);
      stats.totalPairs += res.work.total;
      stats.evaluated += res.work.evaluated;
      stats.prunedBound += res.work.prunedBound;
      stats.prunedBudget += res.work.prunedBudget;
      if (res.reused) stats.reused++;
      if (res.fallback) stats.fallbackBlocks++;
      if (res.missed && res.missed.length) {
        stats.missedBlocks.push({ blockX: x, blockY: y, missed: res.missed, acceptable: res.missedAcceptable });
      }
      if (res.records && res.records.length) {
        stats.records.push({ blockX: x, blockY: y, records: res.records });
      }
    }
  }
  stats.cache = cache ? cache.stats() : null;
  return { bytes: out, stats };
}

function blockOptions(image, bx, by, texels, options) {
  const purpose = options.purpose || PURPOSE.COLOR;
  const edgeMode = options.edgeMode || EDGE_MODE.CLAMP;
  const opts = {
    ...options,
    purpose,
    punchAlpha: options.punchAlpha ?? false,
    cacheEdgeMode: edgeMode,
    cacheExtra: `${bx},${by}`,
  };
  return opts;
}

// Gather a 4x4 block with an explicit edge convention.
//  CLAMP: replicate the nearest in-bounds texel (matches the reference codec).
//  TILE:  wrap to the opposite side (tiling materials).
export function gatherBlock(image, bx, by, edgeMode = EDGE_MODE.CLAMP) {
  const out = new Uint8Array(64);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      let sx = bx * 4 + tx;
      let sy = by * 4 + ty;
      if (edgeMode === EDGE_MODE.TILE) {
        sx = ((sx % image.width) + image.width) % image.width;
        sy = ((sy % image.height) + image.height) % image.height;
      } else {
        sx = Math.min(image.width - 1, sx);
        sy = Math.min(image.height - 1, sy);
      }
      const si = (sy * image.width + sx) * 4;
      out.set(image.pixels.subarray(si, si + 4), (ty * 4 + tx) * 4);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fast vs exhaustive comparison (drives the "exhaustive" UI toggle and report)
// ---------------------------------------------------------------------------

export function compareSearchModes(image, options = {}) {
  const bx = Math.ceil(image.width / 4);
  const by = Math.ceil(image.height / 4);
  let fastWork = 0;
  let exhaustiveWork = 0;
  let sameChoice = 0;
  const differing = [];
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      const texels = gatherBlock(image, x, y, options.edgeMode || EDGE_MODE.CLAMP);
      const base = blockOptions(image, x, y, texels, options);
      const fast = encodeBC1BlockOptimized(texels, { ...base, cache: null });
      const dense = encodeBC1BlockOptimized(texels, { ...base, cache: null, exhaustive: true });
      // The exhaustive search fully evaluates every candidate pair; the fast
      // search evaluates only the pairs its bound/budget let through. The
      // difference is the candidate work actually saved.
      fastWork += fast.work.evaluated;
      exhaustiveWork += dense.work.total;
      const identical = bytesEqual(fast.bytes, dense.bytes);
      if (identical) sameChoice++;
      else {
        differing.push({
          blockX: x, blockY: y,
          fast: { c0: fast.best?.c0, c1: fast.best?.c1, colorMse: fast.best?.colorMse, normalAngleDeg: fast.best?.normalAngleDeg, highlightX: fast.best?.highlightX },
          exhaustive: { c0: dense.best?.c0, c1: dense.best?.c1, colorMse: dense.best?.colorMse, normalAngleDeg: dense.best?.normalAngleDeg, highlightX: dense.best?.highlightX },
        });
      }
    }
  }
  return {
    blocks: bx * by,
    fastEvaluated: fastWork,
    exhaustiveEvaluated: exhaustiveWork,
    evaluationsSaved: exhaustiveWork - fastWork,
    sameChoice,
    differingBlocks: differing.length,
    differing,
  };
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Material-level: colour map -> normal map must not reuse old rankings
// ---------------------------------------------------------------------------

// Encode the same block grid under two purposes, forcing a cache invalidation
// boundary between them. Returns evidence that the colour-purpose cache
// entries were not reused for the normal pass.
export function encodeWithPurposeSwitch(image, options = {}) {
  const cache = options.cache || new PurposeCache();
  const colour = encodeBC1Image(image, { ...options, purpose: PURPOSE.COLOR, cache });
  const colourStats = cache.stats();
  cache.invalidatePurpose(PURPOSE.COLOR);
  const afterInvalidate = cache.stats();
  const normal = encodeBC1Image(image, { ...options, purpose: PURPOSE.NORMAL, cache });
  return {
    colour,
    normal,
    cache: {
      afterColour: colourStats,
      invalidated: afterInvalidate.invalidations,
      afterNormal: cache.stats(),
    },
  };
}
