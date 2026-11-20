// Graphics entry point: loads real .gtex resources, creates actual WebGPU
// textures from the compressed blobs, samples them, reads them back and
// compares against the CPU reference decode. All errors and fallbacks are
// surfaced in the page; a fallback path is never mislabeled as a successful
// compressed-format run.

import { readGtex, validateGtex, decodePayloadMips, FOURCC, fourccString } from '../src/gtex.js';
import { psnrFromMse } from '../src/color.js';
import { selectPayload, createGpuTexture, readbackMip } from './gpu-texture.js';
import { REQUIRED_FEATURE } from './gpu-formats.js';

const TEXTURES = [
  { file: '../assets/soft-blob.gtex', label: 'soft-blob (33x27, sRGB, feathered alpha)' },
  { file: '../assets/high-freq.gtex', label: 'high-freq (50x38, sRGB, high frequency)' },
  { file: '../assets/linear-data.gtex', label: 'linear-data (32x32, linear data)' },
];

const state = {
  device: null,
  adapter: null,
  parsed: null,
  selection: null,
  texture: null,
  cpuReference: null,
  mip: 0,
  zoom: 8,
  requestedFormat: FOURCC.BC3,
  forceFallback: false,
  showError: true,
  transferOverride: false,
};

const $ = (id) => document.getElementById(id);

function log(level, message) {
  const box = $('log');
  const line = document.createElement('div');
  line.className = `log-${level}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

async function initWebGpu() {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not available in this browser');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no suitable GPU adapter');
  const features = ['texture-compression-bc'].filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({
    requiredFeatures: features,
  });
  device.lost.then((info) => log('error', `device lost: ${info.message}`));
  return { adapter, device };
}

function renderAdapterInfo(adapter) {
  const info = adapter.info || {};
  $('adapter-info').textContent =
    `${info.vendor || 'unknown vendor'} ${info.architecture || ''} ${info.device || ''}`.trim();
  const bc = adapter.features.has('texture-compression-bc');
  $('bc-feature').textContent = bc
    ? 'texture-compression-bc: ADVERTISED'
    : 'texture-compression-bc: NOT ADVERTISED — BC payloads cannot run compressed';
  $('bc-feature').className = bc ? 'badge badge-ok' : 'badge badge-warn';
  return bc;
}

async function loadTexture(index) {
  if (state.texture) {
    state.texture.texture.destroy();
    state.texture = null;
  }
  const response = await fetch(TEXTURES[index].file);
  if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const parsed = readGtex(bytes);
  const validation = validateGtex(parsed);
  if (!validation.ok) {
    for (const e of validation.errors) log('error', `container: ${e}`);
    throw new Error('container failed structural validation');
  }
  for (const w of validation.warnings) log('warn', `container: ${w}`);
  state.parsed = parsed;
  $('container-info').textContent =
    `${parsed.header.width}x${parsed.header.height} logical, ` +
    `${parsed.header.paddedWidth}x${parsed.header.paddedHeight} block-padded, ` +
    `${parsed.header.mipCount} mips, transfer=${parsed.header.transfer}`;
  $('mip-slider').max = parsed.header.mipCount - 1;
  renderOffsetTable(parsed);
  buildCurrent();
}

function renderOffsetTable(parsed) {
  const tbody = $('offset-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const payload of parsed.payloads) {
    payload.mips.forEach((m, level) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${fourccString(payload.format)}</td>` +
        `<td>${level}</td>` +
        `<td>${m.width}x${m.height}</td>` +
        `<td>${m.paddedWidth}x${m.paddedHeight}</td>` +
        `<td>${m.offset}</td>` +
        `<td>${m.size}</td>`;
      tbody.appendChild(tr);
    });
  }
}

function buildCurrent() {
  const { device, adapter, parsed } = state;
  if (state.texture) state.texture.texture.destroy();

  const selection = selectPayload(parsed, state.requestedFormat, adapter, state.forceFallback);
  state.selection = selection;

  const requestedName = fourccString(state.requestedFormat);
  const actualName = fourccString(selection.actualFormat);
  if (selection.usedFallback) {
    log('warn', `${requestedName} not usable (${selection.reason}); loaded RGBA8 fallback instead`);
    $('format-status').className = 'badge badge-warn';
    $('format-status').textContent = `FALLBACK: requested ${requestedName}, actual ${actualName}`;
  } else {
    const feature = REQUIRED_FEATURE[state.requestedFormat];
    log('ok', `loaded real ${actualName} texture (${selection.reason}${feature ? `, feature=${feature}` : ''})`);
    $('format-status').className = 'badge badge-ok';
    $('format-status').textContent = `REAL ${actualName} on device`;
  }

  const effectiveTransfer = state.transferOverride && parsed.header.transfer === 'linear'
    ? 'srgb'
    : parsed.header.transfer;
  if (effectiveTransfer !== parsed.header.transfer) {
    log('warn', 'transfer override ON: a linear data texture is being sampled through an sRGB view — dark values will be lifted; this is the incorrect interpretation');
  }

  const built = createGpuTexture(device, parsed, selection, effectiveTransfer);
  state.texture = built;
  state.cpuReference = decodePayloadMips(parsed, selection.actualFormat);

  $('mip-slider').value = Math.min(state.mip, parsed.header.mipCount - 1);
  state.mip = Number($('mip-slider').value);
  refresh();
}

async function refresh() {
  const mip = state.mip;
  const ref = state.cpuReference[mip];
  const mipEntry = state.selection.payload.mips[mip];

  let gpuPixels;
  try {
    gpuPixels = await readbackMip(
      state.device,
      state.texture.texture,
      mip,
      mipEntry.width,
      mipEntry.height,
      mipEntry.paddedWidth,
      mipEntry.paddedHeight,
    );
  } catch (err) {
    log('error', `GPU readback failed: ${err.message}`);
    return;
  }

  const rgbMse = coverageMse(ref.pixels, gpuPixels, ref.width * ref.height, [0, 1, 2]);
  const alphaMse = coverageMse(ref.pixels, gpuPixels, ref.width * ref.height, [3]);
  const rgbPsnr = psnrFromMse(rgbMse);
  const alphaPsnr = psnrFromMse(alphaMse);
  const mismatch = maxAbsDiff(ref.pixels, gpuPixels);

  // CPU reference vs GPU readback: a correct block-compressed implementation
  // must agree within hardware rounding tolerance. A large diff means either
  // the device silently substituted something or the blob layout is wrong.
  $('gpu-cpu-psnr').textContent =
    `mip${mip} GPU vs CPU-decoded: RGB PSNR ${fmt(rgbPsnr)} dB, alpha PSNR ${fmt(alphaPsnr)} dB, max |Δ|=${mismatch}`;
  if (mismatch > 4) {
    log('error', `GPU readback disagrees with the spec decoder (max |Δ|=${mismatch}); the device result cannot be trusted as ${fourccString(state.selection.actualFormat)}`);
    $('gpu-cpu-psnr').className = 'badge badge-warn';
  } else {
    $('gpu-cpu-psnr').className = 'badge badge-ok';
  }

  drawCanvas($('canvas-original'), ref, state.zoom);
  drawCanvas($('canvas-gpu'), { width: ref.width, height: ref.height, pixels: gpuPixels }, state.zoom);
  if (state.showError) {
    drawError($('canvas-error'), ref.pixels, gpuPixels, ref.width, ref.height, state.zoom);
  }
  drawMipChain();
}

function drawCanvas(canvas, image, zoom) {
  canvas.width = image.width * zoom;
  canvas.height = image.height * zoom;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const small = document.createElement('canvas');
  small.width = image.width;
  small.height = image.height;
  small.getContext('2d').putImageData(
    new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height),
    0, 0,
  );
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
}

function drawError(canvas, ref, gpu, width, height, zoom) {
  canvas.width = width * zoom;
  canvas.height = height * zoom;
  const err = new Uint8ClampedArray(width * height * 4);
  let maxSq = 0;
  for (let p = 0; p < width * height; p++) {
    let s = 0;
    for (let c = 0; c < 4; c++) {
      const d = ref[p * 4 + c] - gpu[p * 4 + c];
      s += d * d;
    }
    maxSq = Math.max(maxSq, s);
    err[p * 4 + 3] = 255;
  }
  // Normalized heat map: blue=0, red=worst. Computed from real per-texel diffs.
  for (let p = 0; p < width * height; p++) {
    let s = 0;
    for (let c = 0; c < 4; c++) {
      const d = ref[p * 4 + c] - gpu[p * 4 + c];
      s += d * d;
    }
    const t = maxSq ? Math.sqrt(s / maxSq) : 0;
    err[p * 4] = Math.round(255 * t);
    err[p * 4 + 1] = Math.round(80 * (1 - Math.abs(t - 0.5) * 2));
    err[p * 4 + 2] = Math.round(255 * (1 - t));
  }
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const small = document.createElement('canvas');
  small.width = width;
  small.height = height;
  small.getContext('2d').putImageData(new ImageData(err, width, height), 0, 0);
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
}

function drawMipChain() {
  const wrap = $('mip-chain');
  wrap.innerHTML = '';
  for (let m = 0; m < state.cpuReference.length; m++) {
    const img = state.cpuReference[m];
    const cell = document.createElement('div');
    cell.className = 'mip-cell';
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.pixels), img.width, img.height), 0, 0);
    const label = document.createElement('div');
    label.textContent = `mip${m} ${img.width}x${img.height}`;
    cell.append(cv, label);
    wrap.appendChild(cell);
  }
}

function coverageMse(a, b, pixels, channels) {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < pixels; p++) {
    if (a[p * 4 + 3] < 1) continue;
    for (const c of channels) {
      const d = a[p * 4 + c] - b[p * 4 + c];
      sum += d * d;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function fmt(v) {
  return v === Infinity ? 'inf' : v.toFixed(2);
}

function wireControls() {
  $('texture-select').addEventListener('change', (e) => {
    loadTexture(Number(e.target.value)).catch((err) => log('error', err.message));
  });
  $('format-select').addEventListener('change', (e) => {
    state.requestedFormat = Number(e.target.value);
    buildCurrent();
  });
  $('mip-slider').addEventListener('input', (e) => {
    state.mip = Number(e.target.value);
    refresh();
  });
  $('zoom-slider').addEventListener('input', (e) => {
    state.zoom = Number(e.target.value);
    $('zoom-value').textContent = `${state.zoom}x`;
    refresh();
  });
  $('force-fallback').addEventListener('change', (e) => {
    state.forceFallback = e.target.checked;
    buildCurrent();
  });
  $('show-error').addEventListener('change', (e) => {
    state.showError = e.target.checked;
    $('canvas-error').style.display = state.showError ? 'block' : 'none';
    refresh();
  });
  $('transfer-override').addEventListener('change', (e) => {
    state.transferOverride = e.target.checked;
    buildCurrent();
  });
}

async function main() {
  wireControls();
  try {
    const { adapter, device } = await initWebGpu();
    state.adapter = adapter;
    state.device = device;
    renderAdapterInfo(adapter);
    log('ok', 'WebGPU device initialized');
    await loadTexture(0);
  } catch (err) {
    log('error', err.message);
    document.getElementById('fatal').classList.remove('hidden');
    document.getElementById('fatal').textContent =
      `无法初始化 WebGPU：${err.message}。压缩纹理界面需要支持 WebGPU 与 texture-compression-bc 的浏览器。`;
  }
}

main();
