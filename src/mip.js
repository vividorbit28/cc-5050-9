// Mip chain generation.
//
// Two correctness points that a naive box filter gets wrong:
//  1. Semi-transparent texels must be averaged in premultiplied-alpha space,
//     otherwise shrinking a soft edge blends toward the RGB stored under
//     transparent texels (typically black) and produces an unexplained dark
//     halo. Colors are un-premultiplied before storage.
//  2. Fully transparent texels may contain arbitrary RGB ("garbage alpha").
//     A dilation (bleed) pass spreads neighboring opaque colors into them so
//     that later mip levels and block-compression endpoints never sample black.

export function bleedTransparent(image) {
  const { width, height, pixels } = image;
  const work = new Uint8Array(pixels);
  const alpha = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) alpha[p] = pixels[p * 4 + 3];

  const hasHole = alpha.some((a) => a === 0);
  if (!hasHole) return { width, height, pixels: work };

  let changed = true;
  let guard = 0;
  const maxPasses = Math.ceil(Math.max(width, height));
  while (changed && guard++ < maxPasses) {
    changed = false;
    const snapshot = new Uint8Array(work);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (snapshot[idx + 3] !== 0) continue;
        let ar = 0, ag = 0, ab = 0, weight = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = (ny * width + nx) * 4;
            const na = snapshot[ni + 3];
            if (na === 0) continue;
            const w = na;
            ar += snapshot[ni] * w;
            ag += snapshot[ni + 1] * w;
            ab += snapshot[ni + 2] * w;
            weight += w;
          }
        }
        if (weight > 0) {
          work[idx] = Math.round(ar / weight);
          work[idx + 1] = Math.round(ag / weight);
          work[idx + 2] = Math.round(ab / weight);
          // Alpha stays 0: only the RGB under the transparent texel is repaired.
          changed = true;
        }
      }
    }
  }
  return { width, height, pixels: work };
}

export function downsample2x(image) {
  const { width, height, pixels } = image;
  const nw = Math.max(1, width >> 1);
  const nh = Math.max(1, height >> 1);
  const out = new Uint8Array(nw * nh * 4);
  const at = (x, y) => {
    const cx = Math.min(width - 1, x);
    const cy = Math.min(height - 1, y);
    return (cy * width + cx) * 4;
  };

  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = x * 2;
      const sy = y * 2;
      let pr = 0, pg = 0, pb = 0, pa = 0;
      let samples = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (sx + dx >= width || sy + dy >= height) continue;
          const i = at(sx + dx, sy + dy);
          const a = pixels[i + 3];
          // Premultiply before accumulation.
          pr += (pixels[i] * a) / 255;
          pg += (pixels[i + 1] * a) / 255;
          pb += (pixels[i + 2] * a) / 255;
          pa += a;
          samples++;
        }
      }
      const o = (y * nw + x) * 4;
      const outA = Math.round(pa / samples);
      out[o + 3] = outA;
      if (outA === 0) {
        // No coverage in this footprint: preserve RGB from the nearest source
        // texel instead of writing 0,0,0.
        const i = at(sx, sy);
        out[o] = pixels[i];
        out[o + 1] = pixels[i + 1];
        out[o + 2] = pixels[i + 2];
      } else {
        const meanPmR = pr / samples;
        const meanPmG = pg / samples;
        const meanPmB = pb / samples;
        const meanA = outA / 255;
        out[o] = Math.min(255, Math.round(meanPmR / meanA));
        out[o + 1] = Math.min(255, Math.round(meanPmG / meanA));
        out[o + 2] = Math.min(255, Math.round(meanPmB / meanA));
      }
    }
  }
  return { width: nw, height: nh, pixels: out };
}

export function generateMipChain(image) {
  const levels = [bleedTransparent(image)];
  let cur = levels[0];
  while (cur.width > 1 || cur.height > 1) {
    cur = downsample2x(cur);
    levels.push(cur);
  }
  return levels;
}

export function mipLevelCount(width, height) {
  return 1 + Math.floor(Math.log2(Math.max(width, height)));
}
