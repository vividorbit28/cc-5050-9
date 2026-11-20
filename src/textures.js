// Procedural test textures. Deliberately cover:
//  - non-block-aligned dimensions (not multiples of 4),
//  - semi-transparent soft edges (premultiplied downscale / bleed stress),
//  - high-frequency patterns (checkerboard + sinusoids, mip stress),
//  - a linear (non-sRGB) data texture with known physical values.

function makeImage(width, height, fn) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      pixels[i] = clamp255(r);
      pixels[i + 1] = clamp255(g);
      pixels[i + 2] = clamp255(b);
      pixels[i + 3] = clamp255(a);
    }
  }
  return { width, height, pixels };
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 33x27: both dimensions violate the 4x4 block boundary.
// Soft radial blob with a feathered alpha edge over a colored gradient.
export function makeSoftBlob() {
  const width = 33;
  const height = 27;
  return makeImage(width, height, (x, y) => {
    const u = (x + 0.5) / width;
    const v = (y + 0.5) / height;
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Feathered alpha: fully opaque inside 0.55, fully transparent outside 0.95.
    const alpha = 255 * (1 - smoothstep(0.55, 0.95, dist));
    const r = 40 + 180 * u;
    const g = 30 + 160 * (1 - v);
    const b = 120 + 100 * Math.sin(u * Math.PI);
    return [r, g, b, alpha];
  });
}

// 50x38: also non-block-aligned, every mip level exercises padding.
// High-frequency checkerboard plus diagonal sinusoid, semi-transparent border.
export function makeHighFreq() {
  const width = 50;
  const height = 38;
  return makeImage(width, height, (x, y) => {
    const cell = ((x >> 1) + (y >> 1)) & 1;
    const base = cell ? 235 : 24;
    const wave = 60 * Math.sin(x * 0.9) * Math.cos(y * 0.7);
    const r = base + wave;
    const g = 60 + 120 * (0.5 + 0.5 * Math.sin((x + y) * 0.35));
    const b = cell ? 40 : 220;
    const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
    const alpha = 255 * smoothstep(-0.5, 3.5, edge);
    return [r, g, b, alpha];
  });
}

// 32x32 block-aligned linear data texture. Values represent physical linear
// quantities (a temperature-like ramp and two constant calibration bands),
// so they must be stored without applying the sRGB transfer function.
export function makeLinearData() {
  const width = 32;
  const height = 32;
  return makeImage(width, height, (x, y) => {
    const v = Math.round((x / (width - 1)) * 255);
    const band = y < 8 ? [200, 30, 30] : y >= 24 ? [30, 30, 200] : [v, v, v];
    return [band[0], band[1], band[2], 255];
  });
}

export function makeAllTestTextures() {
  return [
    { name: 'soft-blob', transfer: 'srgb', image: makeSoftBlob() },
    { name: 'high-freq', transfer: 'srgb', image: makeHighFreq() },
    { name: 'linear-data', transfer: 'linear', image: makeLinearData() },
  ];
}
