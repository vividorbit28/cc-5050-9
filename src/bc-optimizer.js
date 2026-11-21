// Candidate endpoint search for 4-colour BC1 blocks.
//
// The dense ("exhaustive") search evaluates every ordered endpoint pair that
// occurs in the block (plus small perturbations), decodes its palette and
// assigns each texel to the nearest entry.
//
// The optimised search is built from *distinct elimination conditions* rather
// than a single weighted score. Each condition can independently reject a
// candidate, and every rejection is recorded with its reason and numeric basis:
//
//   colour   - mean squared RGB error above (best + window)
//   normal   - decoded-normal angular error above a threshold, or the specular
//              highlight centroid crossing the block midline
//   coverage - the block losing alpha coverage on a border where the source
//              had coverage (the cause of a leak once a neighbour is filtered in)
//
// Which conditions are active depends on the material purpose. A colour map
// only gates on colour; a normal map gates on colour *and* normal geometry; an
// alpha-edged map gates on colour *and* coverage.
//
// Savings come from two pruners, and they are accounted separately because they
// have different guarantees:
//
//   * BOUND  - a sound lower bound on the colour error. Projecting each texel
//              onto the endpoint segment gives a distance no larger than the
//              distance to any palette entry (the palette lies on that
//              segment). If the summed bound exceeds the colour window, the
//              pair cannot satisfy the colour condition for *any* purpose and
//              is skipped. This can never discard an acceptable solution.
//
//   * BUDGET - a cap on the number of pairs fully evaluated per block. When the
//              budget runs out, remaining pairs are skipped with their bound
//              recorded. Unlike BOUND this *can* miss an acceptable solution,
//              so the caller can later replay the budget-pruned pairs against
//              the exhaustive result and report exactly what was missed and the
//              deviation it would have caused. The UI's exhaustive toggle
//              removes the cap.

import { rgb565Quantize, rgb565Expand } from './bc.js';
import { rgbToNormal, angleBetweenDeg, highlightCentroid, highlightFlipped } from './metrics.js';

export const PURPOSE = Object.freeze({
  COLOR: 'color',
  NORMAL: 'normal',
  ALPHA: 'alpha',
});

export const PRUNE = Object.freeze({
  BOUND: 'bound',      // sound, cannot miss an acceptable solution
  BUDGET: 'budget',    // possibly lossy, audited against exhaustive
});

export const ELIMINATE = Object.freeze({
  COLOR: 'colour-error',
  NORMAL_FLIP: 'normal-highlight-flip',
  NORMAL_ANGLE: 'normal-angle',
  COVERAGE: 'alpha-coverage-loss',
  COLOR_FALLBACK: 'fallback-only-colour-candidate',
});

// Default gates per purpose. `colorWindow` is in MSE units (mean squared error
// per channel), matching blockColorMse so the numbers in the report are the
// same numbers the CLI already prints.
export const DEFAULT_GATES = Object.freeze({
  [PURPOSE.COLOR]: { colorWindow: 0 },
  [PURPOSE.NORMAL]: { colorWindow: 4, maxAngleDeg: 5, rejectHighlightFlip: true },
  [PURPOSE.ALPHA]: { colorWindow: 4, rejectCoverageLoss: true },
});

export function gatesFor(purpose, overrides = {}) {
  return { ...DEFAULT_GATES[purpose], ...overrides };
}

// BC1 4-colour palette (c0 > c1).
function paletteFor(c0, c1) {
  const e0 = rgb565Expand(c0);
  const e1 = rgb565Expand(c1);
  const lerp = (a, b, w) => Math.min(255, Math.max(0, Math.round((a * (255 - w) + b * w) / 255)));
  return [
    [e0[0], e0[1], e0[2]],
    [e1[0], e1[1], e1[2]],
    [lerp(e0[0], e1[0], 0xaa), lerp(e0[1], e1[1], 0xaa), lerp(e0[2], e1[2], 0xaa)],
    [lerp(e0[0], e1[0], 0x55), lerp(e0[1], e1[1], 0x55), lerp(e0[2], e1[2], 0x55)],
  ];
}

function pointSegmentDistanceSq(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const apz = p[2] - a[2];
  const denom = abx * abx + aby * aby + abz * abz;
  let t = denom > 0 ? (apx * abx + apy * aby + apz * abz) / denom : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  const dz = apz - abz * t;
  return dx * dx + dy * dy + dz * dz;
}

// Sound lower bound on total squared RGB error for endpoints (c0,c1). Basis:
// every palette entry lies on the segment [expanded(c0), expanded(c1)], so the
// nearest palette entry is at least as far as the nearest point on that
// segment. The per-texel sum therefore lower-bounds the block's total error.
//
// `include` (optional Uint8Array of 16 flags) restricts the sum to texels whose
// RGB participates in the objective. For punch-through blocks the transparent
// texels have alpha 0 and are never blended, so excluding them keeps the bound
// valid while avoiding an overestimate from their arbitrary RGB.
export function colorErrorLowerBound(srcColors, c0, c1, include = null) {
  const e0 = rgb565Expand(c0);
  const e1 = rgb565Expand(c1);
  let bound = 0;
  for (let t = 0; t < 16; t++) {
    if (include && !include[t]) continue;
    bound += pointSegmentDistanceSq(srcColors[t], e0, e1);
  }
  return bound;
}

export function evaluatePair(srcColors, c0, c1) {
  const palette = paletteFor(c0, c1);
  const indices = new Array(16);
  const decoded = new Array(16);
  let error = 0;
  for (let t = 0; t < 16; t++) {
    const p = srcColors[t];
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < 4; i++) {
      const q = palette[i];
      const dr = p[0] - q[0];
      const dg = p[1] - q[1];
      const db = p[2] - q[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; bi = i; }
    }
    indices[t] = bi;
    decoded[t] = palette[bi];
    error += bd;
  }
  return { c0, c1, palette, indices, decoded, error, mode: 'four' };
}

// Punch-through evaluation (c0 <= c1): entry 3 is transparent. A texel whose
// source alpha is below the cutout threshold is forced to index 3 (transparent);
// otherwise it takes the nearest of the three opaque entries. This is the only
// BC1 mode in which a candidate can *drop* alpha coverage, which is what the
// coverage gate needs to be able to detect.
export function evaluatePairPunch(srcColors, srcAlphas, c0, c1, cutout = 128) {
  const palette = paletteForPunch(c0, c1);
  const indices = new Array(16);
  const decoded = new Array(16);
  const alphas = new Array(16);
  let error = 0;
  for (let t = 0; t < 16; t++) {
    const p = srcColors[t];
    if (srcAlphas[t] < cutout) {
      indices[t] = 3;
      decoded[t] = [0, 0, 0];
      alphas[t] = 0;
      // RGB under a transparent texel is not blended, so it does not count.
      continue;
    }
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < 3; i++) {
      const q = palette[i];
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    indices[t] = bi;
    decoded[t] = palette[bi];
    alphas[t] = 255;
    error += bd;
  }
  return { c0, c1, palette, indices, decoded, alphas, error, mode: 'punch' };
}

function paletteForPunch(c0, c1) {
  const e0 = rgb565Expand(c0);
  const e1 = rgb565Expand(c1);
  const lerp = (a, b, w) => Math.min(255, Math.max(0, Math.round((a * (255 - w) + b * w) / 255)));
  return [
    [e0[0], e0[1], e0[2]],
    [e1[0], e1[1], e1[2]],
    [lerp(e0[0], e1[0], 128), lerp(e0[1], e1[1], 128), lerp(e0[2], e1[2], 128)],
  ];
}

// Distinct 565 colours in the block plus one-code perturbations per channel, so
// the search can pick endpoints no source texel quantises to exactly.
export function buildCandidates(srcColors) {
  const seen = new Set();
  const add = (c) => { if (c >= 0 && c <= 0xffff) seen.add(c); };
  for (const p of srcColors) {
    const q = rgb565Quantize(p[0], p[1], p[2]);
    add(q);
    add(perturb(q, 5, 11, 1)); add(perturb(q, 5, 11, -1));
    add(perturb(q, 6, 5, 1)); add(perturb(q, 6, 5, -1));
    add(perturb(q, 5, 0, 1)); add(perturb(q, 5, 0, -1));
  }
  return [...seen];
}

function perturb(code, bits, shift, delta) {
  const mask = (1 << bits) - 1;
  const cur = (code >> shift) & mask;
  const next = Math.max(0, Math.min(mask, cur + delta));
  return (code & ~(mask << shift)) | (next << shift);
}

export function buildEndpointPairs(candidates) {
  const seen = new Set();
  const pairs = [];
  for (const a of candidates) {
    for (const b of candidates) {
      if (a === b) continue;
      const c0 = a > b ? a : b;
      const c1 = a > b ? b : a;
      const key = c0 * 65536 + c1;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([c0, c1]);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Per-candidate analysis
// ---------------------------------------------------------------------------

// Compute every metric the gates need for one evaluated pair.
export function analyzeCandidate(result, ctx) {
  const out = {
    c0: result.c0,
    c1: result.c1,
    colorError: result.error,
    colorMse: result.error / 48,
    indices: result.indices.slice(),
    normalAngleDeg: null,
    highlightX: null,
    highlightFlip: false,
    coverageLossEdges: [],
    edgeAlphaDeviation: 0,
  };
  if (ctx.srcNormals) {
    let sum = 0;
    for (let t = 0; t < 16; t++) {
      const d = result.decoded[t];
      sum += angleBetweenDeg(ctx.srcNormals[t], rgbToNormal(d[0], d[1], d[2]));
    }
    out.normalAngleDeg = sum / 16;
    if (ctx.halfVector && ctx.exponent) {
      const candNormals = new Array(16);
      for (let t = 0; t < 16; t++) {
        const d = result.decoded[t];
        candNormals[t] = rgbToNormal(d[0], d[1], d[2]);
      }
      const c = highlightCentroid(candNormals, ctx.halfVector, ctx.exponent);
      out.highlightX = c ? c.x : null;
      out.highlightFlip = highlightFlipped(ctx.srcHighlight, c);
    }
  }
  if (ctx.edgeCoverage) {
    const candAlpha = decodedEdgeAlpha(result);
    for (let edge = 0; edge < 4; edge++) {
      const srcCov = ctx.edgeCoverage.src[edge];
      if (srcCov <= 0) continue;
      const candCov = edgeCoverageFromAlpha(candAlpha, edge) / 255;
      // Coverage is "lost" when the candidate's edge alpha falls to (near)
      // zero where the source still had coverage. That is the mechanism behind a
      // fringe that only becomes visible when a covered neighbour is filtered
      // in during minification.
      if (candCov <= ctx.edgeCoverage.lossThreshold) out.coverageLossEdges.push(edge);
      out.edgeAlphaDeviation = Math.max(
        out.edgeAlphaDeviation,
        Math.abs(ctx.edgeCoverage.srcAlphaMean[edge] - meanEdgeAlpha(candAlpha, edge)) / 255,
      );
    }
  }
  return out;
}

function decodedEdgeAlpha(result) {
  if (result.alphas) return result.alphas;              // punch-through
  const a = new Array(16).fill(255);                    // 4-colour is fully opaque
  return a;
}

function edgeCoverageFromAlpha(alphas, edge) {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const t = edgeTexel(edge, i);
    if (alphas[t] > 0) sum += 255;
  }
  return sum / 4;
}

function meanEdgeAlpha(alphas, edge) {
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += alphas[edgeTexel(edge, i)];
  return sum / 4;
}

function edgeTexel(edge, i) {
  if (edge === 0) return i * 4;       // left
  if (edge === 1) return i * 4 + 3;   // right
  if (edge === 2) return i;           // top
  return 12 + i;                      // bottom
}

// Apply the purpose's elimination gates. Returns { elimination: null|reason, ... }.
export function applyGates(cand, minColorMse, purpose, gates, ctx) {
  if (cand.colorMse > minColorMse + gates.colorWindow) {
    return { elimination: ELIMINATE.COLOR, basis: `colour MSE ${fmt(cand.colorMse)} > min+window ${fmt(minColorMse + gates.colorWindow)}` };
  }
  if (purpose === PURPOSE.NORMAL) {
    if (gates.rejectHighlightFlip && cand.highlightFlip) {
      return { elimination: ELIMINATE.NORMAL_FLIP, basis: `highlight x=${fmt(cand.highlightX)} crosses midline (source x=${fmt(ctx.srcHighlight ? ctx.srcHighlight.x : null)})` };
    }
    if (cand.normalAngleDeg != null && cand.normalAngleDeg > gates.maxAngleDeg) {
      return { elimination: ELIMINATE.NORMAL_ANGLE, basis: `mean angle ${fmt(cand.normalAngleDeg)}° > ${fmt(gates.maxAngleDeg)}°` };
    }
  }
  if (purpose === PURPOSE.ALPHA && gates.rejectCoverageLoss && cand.coverageLossEdges.length) {
    return { elimination: ELIMINATE.COVERAGE, basis: `drops coverage on edge(s) ${cand.coverageLossEdges.join(',')}` };
  }
  return { elimination: null, basis: null };
}

function purposeRank(purpose, cand) {
  if (purpose === PURPOSE.NORMAL) return -(cand.normalAngleDeg ?? 0);
  if (purpose === PURPOSE.ALPHA) return -(cand.coverageLossEdges.length) * 1e6 - cand.colorMse;
  return -cand.colorMse;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

//   srcColors : 16 [r,g,b] arrays
//   pairs     : [[c0,c1], ...]
//   purpose   : PURPOSE.*
//   options:
//     gates        overrides for the purpose gates
//     exhaustive   ignore bound and budget
//     budget       max pairs to evaluate fully (Infinity when exhaustive)
//     lowerBound   allow the sound bound (default true unless exhaustive)
//     ctx          { srcNormals, halfVector, exponent, srcHighlight, edgeCoverage }
//     records      collect per-pair prune/elimination records
//
// Returns:
//   best, candidates (all evaluated with metrics + elimination), work:
//   { total, evaluated, prunedBound, prunedBudget }, records, minColorMse
export function searchEndpoints(srcColors, pairs, purpose, options = {}) {
  const gates = gatesFor(purpose, options.gates || {});
  const exhaustive = !!options.exhaustive;
  const budget = exhaustive ? Infinity : (options.budget ?? Infinity);
  const useBound = !exhaustive && options.lowerBound !== false;
  const collect = !!options.records;
  const ctx = options.ctx || {};
  const evaluate = options.evaluator || ((c0, c1) => evaluatePair(srcColors, c0, c1));

  // Order pairs from the tightest lower bound upward. This is what makes bound
  // pruning effective: the best colours are evaluated first, so the running
  // minimum tightens early and the remaining high-bound pairs are cheap to
  // reject. It also means the budget (when finite) spends its evaluations on
  // the most promising pairs rather than an arbitrary prefix.
  const include = options.boundInclude || null;
  const work = pairs.map(([c0, c1]) => ({ c0, c1, bound: colorErrorLowerBound(srcColors, c0, c1, include) / 48 }));
  work.sort((a, b) => (a.bound - b.bound) || (a.c0 - b.c0) || (a.c1 - b.c1));

  const candidates = [];
  const records = [];
  let evaluated = 0;
  let prunedBound = 0;
  let prunedBudget = 0;
  let minColorError = Infinity;
  let sawAny = false;

  for (let i = 0; i < work.length; i++) {
    const { c0, c1, bound } = work[i];
    if (evaluated >= budget) {
      prunedBudget = work.length - i;
      if (collect) {
        for (let j = i; j < work.length; j++) {
          records.push({
            c0: work[j].c0, c1: work[j].c1, prune: PRUNE.BUDGET,
            bound: work[j].bound,
            detail: `budget of ${budget} evaluations exhausted`,
          });
        }
      }
      break;
    }
    // Sound bound. The final colour gate compares against the true minimum,
    // which is <= the running minimum; pruning here when bound > runningMin +
    // window is therefore conservative: any pair below the threshold is still
    // evaluated, and any pair above it cannot pass even with the true minimum.
    if (useBound && sawAny && bound > minColorError + gates.colorWindow) {
      prunedBound++;
      if (collect) {
        records.push({
          c0, c1, prune: PRUNE.BOUND,
          bound, threshold: minColorError + gates.colorWindow,
          detail: `bound MSE ${fmt(bound)} > ${fmt(minColorError + gates.colorWindow)}`,
        });
      }
      continue;
    }
    const result = evaluate(c0, c1);
    evaluated++;
    const cand = analyzeCandidate(result, ctx);
    if (cand.colorError < minColorError) minColorError = cand.colorError;
    sawAny = true;
    candidates.push(cand);
  }

  // Final colour gate against the true minimum, then the purpose gates.
  const minColorMse = minColorError / 48;
  const eligible = [];
  for (const cand of candidates) {
    const gate = applyGates(cand, minColorMse, purpose, gates, ctx);
    cand.elimination = gate.elimination;
    cand.eliminationBasis = gate.basis;
    if (!gate.elimination) eligible.push(cand);
    else if (collect) {
      records.push({ c0: cand.c0, c1: cand.c1, eliminate: gate.elimination, detail: gate.basis });
    }
  }

  let best = null;
  let fallback = false;
  if (eligible.length) {
    best = eligible.reduce((a, b) => (purposeRank(purpose, b) > purposeRank(purpose, a) ? b : a));
  } else if (candidates.length) {
    // No candidate satisfies every gate. Return the closest colour match and
    // mark it so the caller can report that the acceptable set was empty.
    best = candidates.reduce((a, b) => (a.colorError <= b.colorError ? a : b));
    best.elimination = ELIMINATE.COLOR_FALLBACK;
    fallback = true;
  }

  return {
    best,
    candidates,
    minColorMse,
    fallback,
    work: {
      total: pairs.length,
      evaluated,
      prunedBound,
      prunedBudget,
    },
    records,
    gates,
    exhaustive,
  };
}

// Re-evaluate the pairs the budget skipped and report which of them would have
// been acceptable (passed every gate) and out-ranked the chosen candidate.
// Only used for auditing; never on the hot path.
export function auditBudgetPruned(srcColors, pairs, chosen, purpose, options = {}) {
  const gates = gatesFor(purpose, options.gates || {});
  const ctx = options.ctx || {};
  const evaluatedKeys = new Set(options.evaluatedPairs || []);
  const evaluate = options.evaluator || ((c0, c1) => evaluatePair(srcColors, c0, c1));
  const missed = [];
  for (const [c0, c1] of pairs) {
    if (evaluatedKeys.has(c0 * 65536 + c1)) continue;
    const result = evaluate(c0, c1);
    const cand = analyzeCandidate(result, ctx);
    // Acceptable requires passing every gate *and* actually improving on the
    // chosen candidate under the purpose ranking.
    const gate = applyGates(cand, options.minColorMse, purpose, gates, ctx);
    if (gate.elimination) continue;
    if (chosen && purposeRank(purpose, cand) <= purposeRank(purpose, chosen)) continue;
    missed.push({ ...cand, reason: 'budget-pruned acceptable alternative' });
  }
  missed.sort((a, b) => purposeRank(purpose, b) - purposeRank(purpose, a));
  return missed;
}

function fmt(v) {
  return Number.isFinite(v) ? v.toFixed(3) : String(v);
}
