// Color space helpers. All values operate on 8-bit channel values (0..255).
// sRGB transfer function (IEC 61966-2-1) is applied per channel; alpha is linear.

export function srgbToLinearByte(c) {
  if (c === 0) return 0;
  const cs = c / 255;
  const lin = cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  // Ceil keeps dark but nonzero sRGB values from collapsing to linear 0 under
  // 8-bit quantization, preserving the invertibility needed for data textures.
  return Math.max(1, Math.ceil(lin * 255));
}

export function linearToSrgbByte(c) {
  const cl = c / 255;
  const s = cl <= 0.0031308 ? cl * 12.92 : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

export function srgbToLinearImage(image) {
  const out = new Uint8Array(image.pixels.length);
  for (let p = 0; p < image.width * image.height; p++) {
    const i = p * 4;
    out[i] = srgbToLinearByte(image.pixels[i]);
    out[i + 1] = srgbToLinearByte(image.pixels[i + 1]);
    out[i + 2] = srgbToLinearByte(image.pixels[i + 2]);
    out[i + 3] = image.pixels[i + 3];
  }
  return { width: image.width, height: image.height, pixels: out };
}

export function linearToSrgbImage(image) {
  const out = new Uint8Array(image.pixels.length);
  for (let p = 0; p < image.width * image.height; p++) {
    const i = p * 4;
    out[i] = linearToSrgbByte(image.pixels[i]);
    out[i + 1] = linearToSrgbByte(image.pixels[i + 1]);
    out[i + 2] = linearToSrgbByte(image.pixels[i + 2]);
    out[i + 3] = image.pixels[i + 3];
  }
  return { width: image.width, height: image.height, pixels: out };
}

export function mse(a, b, count) {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum / count;
}

export function psnrFromMse(mseValue, maxVal = 255) {
  if (mseValue <= 1e-10) return Infinity;
  return 10 * Math.log10((maxVal * maxVal) / mseValue);
}

// Per-texel squared error summed over the given channel count.
export function errorImage(reference, candidate, width, height, channels = 4) {
  const err = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    let s = 0;
    const i = p * 4;
    for (let c = 0; c < channels; c++) {
      const d = reference[i + c] - candidate[i + c];
      s += d * d;
    }
    err[p] = s / channels;
  }
  return err;
}
