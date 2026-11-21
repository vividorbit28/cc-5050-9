// Purpose- and source-scoped caches for the optimizer.
//
// Two properties matter here and a naive `Map` gets both wrong:
//
//  1. The cache key must include the *source texels* and the *purpose*. If a
//     material is re-authored from a colour map into a normal map, the same
//     block coordinates and endpoint pair now mean something different (the
//     ranking must consider normals, not colour), so an old colour-purpose
//     entry must never be reused. Including the source bytes and purpose in
//     the key makes stale reuse impossible.
//
//  2. The cached value must record the *edge convention* (tile vs clamp) under
//     which it was produced. A block on the right/bottom edge of a non-block-
//     aligned texture is encoded with replicated edge texels; if the same block
//     is later evaluated under clamp-to-edge with a different neighbour, the
//     cached decode/error is not valid. The convention is part of the key, so
//     switching conventions invalidates rather than silently reuses.
//
// The cache is deliberately small and pluggable rather than global: the caller
// owns its lifetime and can drop it wholesale when the source changes.

export const EDGE_MODE = Object.freeze({ CLAMP: 'clamp', TILE: 'tile' });

function fnv1a(bytes, h = 0x811c9dc5) {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Stable, order-sensitive hash of the 16 source RGBA texels.
export function hashTexels(texels) {
  return fnv1a(texels);
}

export class PurposeCache {
  constructor(maxEntries = 4096) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
  }

  // `source` is a Uint8Array of 16 RGBA texels; `purpose` and `edgeMode` are
  // part of the identity. Returns a string key.
  key(source, purpose, edgeMode, extra = '') {
    const h = fnv1a(source);
    return `${purpose}|${edgeMode}|${h.toString(16)}|${source.length}|${extra}`;
  }

  get(source, purpose, edgeMode, extra = '') {
    const k = this.key(source, purpose, edgeMode, extra);
    if (this.map.has(k)) {
      this.hits++;
      return this.map.get(k);
    }
    this.misses++;
    return undefined;
  }

  set(source, purpose, edgeMode, value, extra = '') {
    const k = this.key(source, purpose, edgeMode, extra);
    if (this.map.size >= this.maxEntries) {
      // Simple FIFO eviction; entries are cheap to recompute.
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(k, value);
    return k;
  }

  // Explicitly drop every entry for a purpose (e.g. when the material's
  // semantic changes from colour to normal).
  invalidatePurpose(purpose) {
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(`${purpose}|`)) {
        this.map.delete(k);
        this.invalidations++;
      }
    }
  }

  // Drop every entry produced under an edge convention (e.g. when switching
  // tile <-> clamp on the same texture).
  invalidateEdgeMode(edgeMode) {
    for (const k of [...this.map.keys()]) {
      if (k.split('|')[1] === edgeMode) {
        this.map.delete(k);
        this.invalidations++;
      }
    }
  }

  clear() {
    this.invalidations += this.map.size;
    this.map.clear();
  }

  stats() {
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
    };
  }
}
