// Per-texel error terms used by the candidate optimizer.
//
// A block compressor normally ranks candidates by one number (mean squared
// colour distance). That collapses several *different* kinds of damage into a
// single scalar, and the optimiser then has no way to notice that a candidate
// which is imperceptibly different in colour has moved a specular highlight to
// the wrong side of the block, or that a candidate which is fine at mip 0
// leaks a colour fringe once the surface is minified and a neighbour
// participates in filtering.
//
// This module deliberately keeps the terms separate so that each one can act
// as its own rejection test. Nothing here combines them into a weighted score
// except where the caller asks for it explicitly; the point is that a caller
// can say "reject if colour MSE is large OR if the highlight centroid crosses
// the midline", not "minimise a weighted sum".

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

// Mean squared error over the RGB channels of a 16-texel decoded block,
// normalised per channel. Matches the historical encoder objective so the
// optimised path is directly comparable to the dense one.
export function blockColorMse(srcTexels, decodedTexels) {
  let sum = 0;
  for (let t = 0; t < 16; t++) {
    for (let c = 0; c < 3; c++) {
      const d = srcTexels[t * 4 + c] - decodedTexels[t * 4 + c];
      sum += d * d;
    }
  }
  return sum / (16 * 3);
}

// ---------------------------------------------------------------------------
// Normal angle
// ---------------------------------------------------------------------------

// Decode an RGB triple (as stored) into a unit tangent-space normal using the
// same convention the shader will use: n = normalize(2 * rgb - 1). An exact
// (128,128,255) maps to +Z.
export function rgbToNormal(r, g, b) {
  let x = r / 255 * 2 - 1;
  let y = g / 255 * 2 - 1;
  let z = b / 255 * 2 - 1;
  const len = Math.hypot(x, y, z);
  if (len < 1e-12) return [0, 0, 1];
  return [x / len, y / len, z / len];
}

export function angleBetweenDeg(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

// ---------------------------------------------------------------------------
// Specular highlight placement
// ---------------------------------------------------------------------------

// Weight of a decoded normal under a Blinn-Phong lobe (half-vector H, exponent
// s). This is an *analysis* function: it is not part of the encoding, it only
// lets the optimiser ask "where would the highlight land for this candidate?".
export function lobeWeight(normal, halfVector, exponent) {
  const d = normal[0] * halfVector[0] + normal[1] * halfVector[1] + normal[2] * halfVector[2];
  return Math.pow(Math.max(0, d), exponent);
}

// Weighted centroid of the lobe over the 4x4 block, in texel coordinates
// (texel centres at 0.5,1.5,2.5,3.5). `weight <= 0` means the candidate has no
// meaningful highlight at this lobe and the centroid is undefined.
export function highlightCentroid(normals, halfVector, exponent) {
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  for (let t = 0; t < 16; t++) {
    const w = lobeWeight(normals[t], halfVector, exponent);
    sx += w * (t % 4 + 0.5);
    sy += w * ((t >> 2) + 0.5);
    wsum += w;
  }
  if (wsum <= 1e-12) return null;
  return { x: sx / wsum, y: sy / wsum, weight: wsum };
}

// Does the highlight centroid lie on the opposite side of the block's vertical
// midline (x = 2) from the source? This is the "moved the specular highlight to
// the other side" test. It is only meaningful when both centroids exist.
export function highlightFlipped(srcCentroid, candCentroid) {
  if (!srcCentroid || !candCentroid) return false;
  return (srcCentroid.x - 2) * (candCentroid.x - 2) < 0;
}

// ---------------------------------------------------------------------------
// Alpha coverage at block edges
// ---------------------------------------------------------------------------

// Fraction of the four texels on one block edge that carry any alpha.
// `edge`: 0=left, 1=right, 2=top, 3=bottom.
export function edgeCoverage(texels, edge) {
  let covered = 0;
  for (let i = 0; i < 4; i++) {
    let t;
    if (edge === 0) t = i * 4;
    else if (edge === 1) t = i * 4 + 3;
    else if (edge === 2) t = i;
    else t = 12 + i;
    if (texels[t * 4 + 3] > 0) covered++;
  }
  return covered / 4;
}

// True when a source block has coverage on an edge but the candidate makes
// that edge fully transparent. That is a dropped edge: when the texture is
// minified and this block shares a footprint with a covered neighbour, the
// missing coverage is what produces a visible fringe ("leak") that is absent
// at full resolution.
export function edgeCoverageLost(srcTexels, decodedTexels, edge) {
  return edgeCoverage(srcTexels, edge) > 0 && edgeCoverage(decodedTexels, edge) === 0;
}

// Read a 4-texel edge strip's alpha out of a flat RGBA block.
export function edgeAlphas(texels, edge) {
  const out = new Array(4);
  for (let i = 0; i < 4; i++) {
    let t;
    if (edge === 0) t = i * 4;
    else if (edge === 1) t = i * 4 + 3;
    else if (edge === 2) t = i;
    else t = 12 + i;
    out[i] = texels[t * 4 + 3];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Neighbour-inclusive filtering
// ---------------------------------------------------------------------------

// One-dimensional edge strip of a 4x4 block: which texel indices lie on the
// given edge, in order.
export function edgeIndices(edge) {
  const out = new Array(4);
  for (let i = 0; i < 4; i++) {
    if (edge === 0) out[i] = i * 4;        // left
    else if (edge === 1) out[i] = i * 4 + 3; // right
    else if (edge === 2) out[i] = i;       // top
    else out[i] = 12 + i;                  // bottom
  }
  return out;
}

// Straight-alpha (non-premultiplied) blend of a 4-texel edge strip with the
// neighbouring strip under an equal-weight 50/50 footprint.
//
// Straight-alpha filtering still averages the stored RGB of a transparent
// texel, whereas premultiplied blending would hide it. That is exactly how a
// block whose edge texels are alpha 0 at full resolution can show a colour
// fringe once the surface is minified and a neighbour enters the footprint —
// the hidden RGB is averaged into the visible result. This function models the
// fringe-producing path.
export function straightEdgeBlend(candEdge, neighbourEdge, weights = null) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let wsum = 0;
  for (let i = 0; i < 4; i++) {
    const w = weights ? weights[i] : 1;
    r += w * (candEdge[i * 4] + neighbourEdge[i * 4]) * 0.5;
    g += w * (candEdge[i * 4 + 1] + neighbourEdge[i * 4 + 1]) * 0.5;
    b += w * (candEdge[i * 4 + 2] + neighbourEdge[i * 4 + 2]) * 0.5;
    a += w * (candEdge[i * 4 + 3] + neighbourEdge[i * 4 + 3]) * 0.5;
    wsum += w;
  }
  if (wsum <= 0) return { color: [0, 0, 0], alpha: 0 };
  return {
    color: [r / wsum, g / wsum, b / wsum],
    alpha: a / wsum,
  };
}

// Colour leak of a candidate edge once it is filtered with a neighbour, measured
// against the same filter applied to the *source* edge. The mip-0 (nearest)
// error of the same texels can be zero while this is large, when the source edge
// is alpha 0: nearest sampling never shows it, filtering does. Returns the
// summed absolute per-channel difference (0 = no leak).
export function filteredEdgeLeak(srcEdge, candEdge, neighbourEdge, weights = null) {
  const want = straightEdgeBlend(srcEdge, neighbourEdge, weights);
  const have = straightEdgeBlend(candEdge, neighbourEdge, weights);
  return Math.abs(want.color[0] - have.color[0]) +
    Math.abs(want.color[1] - have.color[1]) +
    Math.abs(want.color[2] - have.color[2]);
}

// Compare two candidate edge decodes filtered against the same neighbour.
// Returns the per-channel difference of the blended colour (absolute sum) and
// the alpha difference. Two candidates with equal *block* colour MSE can have
// nonzero values here: that is the "no longer equivalent once neighbours are
// filtered in" case.
export function filteredEdgeDifference(candA, candB, neighbourEdge) {
  const a = straightEdgeBlend(candA, neighbourEdge);
  const b = straightEdgeBlend(candB, neighbourEdge);
  const dRgb = Math.abs(a.color[0] - b.color[0]) + Math.abs(a.color[1] - b.color[1]) + Math.abs(a.color[2] - b.color[2]);
  const dAlpha = Math.abs(a.alpha - b.alpha);
  return { dRgb, dAlpha, a, b };
}

// Build a flat RGBA strip (4 texels) from a decoded block's edge.
export function extractedEdge(decodedTexels, edge) {
  const idx = edgeIndices(edge);
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    out.set(decodedTexels.subarray(idx[i] * 4, idx[i] * 4 + 4), i * 4);
  }
  return out;
}
