// Maps container formats to real WebGPU feature/format names and decides
// whether the *actual device* can interpret them. Nothing here assumes a
// compressed format works: the adapter's feature list is the only evidence.

import { FOURCC } from '../src/gtex.js';

export const GPU_FORMAT = {
  [FOURCC.BC1]: 'bc1-rgba-unorm',
  [FOURCC.BC3]: 'bc3-rgba-unorm',
  [FOURCC.RGBA8]: 'rgba8unorm',
};

export const GPU_FORMAT_SRGB = {
  [FOURCC.BC1]: 'bc1-rgba-unorm-srgb',
  [FOURCC.BC3]: 'bc3-rgba-unorm-srgb',
  [FOURCC.RGBA8]: 'rgba8unorm-srgb',
};

// The BC feature gates both BC1 and BC3. RGBA8 needs no optional feature.
export const REQUIRED_FEATURE = {
  [FOURCC.BC1]: 'texture-compression-bc',
  [FOURCC.BC3]: 'texture-compression-bc',
  [FOURCC.RGBA8]: null,
};
