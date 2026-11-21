// Adversarial fixtures that make the *distinctness* of the elimination
// conditions concrete. Each one is a 4x4 source block chosen so that a
// single-number (colour MSE) optimiser would make the wrong choice while a
// purpose-aware one rejects it for a reason that can be stated numerically.
//
// These are exported so the tests, the CLI report and the Web page all exercise
// the exact same block; there is no separate "demonstration" copy that could
// drift from the production code.

import { rgb565Expand } from './bc.js';
import {
  rgbToNormal, highlightCentroid, angleBetweenDeg,
  straightEdgeBlend, filteredEdgeLeak, filteredEdgeDifference, edgeIndices,
} from './metrics.js';

function rgbaBlock(fn) {
  const out = new Uint8Array(64);
  for (let t = 0; t < 16; t++) {
    const [r, g, b, a] = fn(t % 4, t >> 2, t);
    out[t * 4] = r;
    out[t * 4 + 1] = g;
    out[t * 4 + 2] = b;
    out[t * 4 + 3] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normal block: tiny colour MSE, but the colour-optimal candidate moves the
// specular highlight to the other side of the block.
// ---------------------------------------------------------------------------
//
// Two vertical colour clusters (left/right columns). A light comes in from the
// side so that the Blinn-Phong lobe weights the right cluster more strongly.
// The colour-optimal endpoint pair reproduces the *colours* faithfully yet
// compresses the small left/right difference into the two endpoints in a way
// that makes the left cluster brighter under the lobe than the right — the
// highlight centroid crosses the x=2 midline. A slightly worse colour pair
// (well inside any sane colour window) keeps the highlight where it belongs.
export function normalHighlightFlipFixture() {
  const left = [250, 137, 163];
  const right = [226, 201, 163];
  const texels = rgbaBlock((x, y) => ((x < 2 ? left : right).concat(255)));
  const halfVector = [0.902, 0.3472, 0.2567];
  const exponent = 256;
  const srcNormals = new Array(16);
  for (let t = 0; t < 16; t++) {
    srcNormals[t] = rgbToNormal(texels[t * 4], texels[t * 4 + 1], texels[t * 4 + 2]);
  }
  const srcHighlight = highlightCentroid(srcNormals, halfVector, exponent);
  return {
    name: 'normal-highlight-flip',
    texels,
    purposeHint: 'normal',
    halfVector,
    exponent,
    srcNormals,
    srcHighlight,
  };
}

// ---------------------------------------------------------------------------
// Edge block: colour leak that is invisible at mip 0 and only appears once a
// neighbouring block participates in a minified filtering footprint.
// ---------------------------------------------------------------------------
//
// The visible interior (12 texels) is a single colour V; the right edge column
// (4 texels) is transparent (alpha 0) with stored colour E. Two endpoint pairs
// reproduce the interior identically (equal block colour error) but decode the
// hidden edge to very different RGB (0,255,165) vs (255,255,165). Nearest
// sampling never sees the edge, so both look identical at mip 0. A straight
// alpha filter that blends the edge with an opaque neighbour does see the
// stored RGB, so the two candidates produce different fringes — one of them
// "leaks" far more than the other. This is the "leak only visible when
// minified" mechanism, and it is also the counterexample to "equal error =>
// interchangeable candidates".
export function edgeColourLeakFixture(neighbourColour = [255, 255, 255]) {
  const interior = [255, 255, 163];
  const hiddenEdge = [9, 109, 127];
  const texels = rgbaBlock((x) => ((x === 3 ? hiddenEdge : interior).concat(0)));
  // Restore alpha: interior opaque, edge transparent.
  for (let t = 0; t < 16; t++) texels[t * 4 + 3] = (t % 4) === 3 ? 0 : 255;
  const neighbour = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    neighbour[i * 4] = neighbourColour[0];
    neighbour[i * 4 + 1] = neighbourColour[1];
    neighbour[i * 4 + 2] = neighbourColour[2];
    neighbour[i * 4 + 3] = 255;
  }
  return {
    name: 'edge-colour-leak',
    texels,
    purposeHint: 'alpha',
    edge: 1, // right
    neighbour,
    // Two endpoint pairs with identical interior decode, divergent hidden edge.
    // Their *visible* (interior) colour error is exactly equal, so a colour-only
    // optimiser has no reason to prefer one; once the neighbour filters in, one
    // leaks far more colour than the other.
    lowLeakPair: { c0: 0xfff4, c1: 0x07f4 },  // hidden edge -> (0,255,165)
    highLeakPair: { c0: 0xffff, c1: 0xfff4 }, // hidden edge -> (255,255,165)
  };
}

// Measure, for a fixture edge and two candidate palettes, what a straight-alpha
// neighbour-inclusive footprint actually shows. Returns the leak of each and
// flags whether the leakage ranking matches the mip-0 (nearest) ranking.
export function evaluateEdgeLeak(fixture) {
  const edge = fixture.edge;
  const idx = edgeIndices(edge);
  const srcEdge = new Uint8Array(16);
  for (let i = 0; i < 4; i++) srcEdge.set(fixture.texels.subarray(idx[i] * 4, idx[i] * 4 + 4), i * 4);

  const decode = (pair) => {
    const palette = paletteFor(pair.c0, pair.c1);
    return { decoded: nearestEdge(fixture.texels, idx, palette) };
  };
  const low = decode(fixture.lowLeakPair);
  const high = decode(fixture.highLeakPair);
  const leakLow = filteredEdgeLeak(srcEdge, low.decoded, fixture.neighbour);
  const leakHigh = filteredEdgeLeak(srcEdge, high.decoded, fixture.neighbour);
  // The two candidates are interchangeable at mip 0 but not once the neighbour
  // filters in: this is the divergence the fixture is built to expose.
  const pairDivergence = filteredEdgeDifference(low.decoded, high.decoded, fixture.neighbour);
  return {
    leakLow,
    leakHigh,
    pairDivergenceRgb: pairDivergence.dRgb,
    fringeLow: straightEdgeBlend(low.decoded, fixture.neighbour).color,
    fringeHigh: straightEdgeBlend(high.decoded, fixture.neighbour).color,
    expected: straightEdgeBlend(srcEdge, fixture.neighbour).color,
    highLeaksMore: leakHigh > leakLow,
  };
}

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

function nearestEdge(texels, idx, palette) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const t = idx[i];
    const p = [texels[t * 4], texels[t * 4 + 1], texels[t * 4 + 2]];
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const q = palette[k];
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bd) { bd = d; bi = k; }
    }
    const q = palette[bi];
    out[i * 4] = q[0];
    out[i * 4 + 1] = q[1];
    out[i * 4 + 2] = q[2];
    out[i * 4 + 3] = texels[t * 4 + 3];
  }
  return out;
}

// Angle (degrees) between the source normal field and the normal field a
// decoded block produces. Used by the exported-material read-back to state the
// real deviation a missed candidate caused.
export function normalsFromTexels(texels) {
  const out = new Array(16);
  for (let t = 0; t < 16; t++) out[t] = rgbToNormal(texels[t * 4], texels[t * 4 + 1], texels[t * 4 + 2]);
  return out;
}

export function meanAngle(srcNormals, decodedTexels) {
  const cand = normalsFromTexels(decodedTexels);
  let sum = 0;
  for (let t = 0; t < 16; t++) sum += angleBetweenDeg(srcNormals[t], cand[t]);
  return sum / 16;
}
