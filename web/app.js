// Graphics entry point: loads real .gtex resources, creates actual WebGPU
// textures from the compressed blobs, samples them, reads them back and
// compares against the CPU reference decode. All errors and fallbacks are
// surfaced in the page; a fallback path is never mislabeled as a successful
// compressed-format run.

import { readGtex, validateGtex, decodePayloadMips, FOURCC, fourccString } from '../src/gtex.js';
import { psnrFromMse } from '../src/color.js';
import { selectPayload, createGpuTexture, readbackMip } from './gpu-texture.js';
import { REQUIRED_FEATURE } from './gpu-formats.js';
import { PURPOSE, EDGE_MODE, PurposeCache } from '../src/bc-encode.js';
import {
  encodeWithInspection, worstPoint, blockAt, savedVsExhaustive,
  readbackInspection, eliminationSummary, exportedEdgeLeak,
} from '../src/bc-report.js';

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

// Optimiser inspection state. `cache` persists across purpose switches so the
// page can demonstrate that colour-purpose entries are not served for a normal
// pass; invalidating by purpose is what makes the switch safe.
const optState = {
  cache: new PurposeCache(),
  inspection: null,
  selected: { bx: 0, by: 0 },
  purpose: PURPOSE.COLOR,
  edgeMode: EDGE_MODE.CLAMP,
  format: 'bc1',
  budget: 60,
  exhaustive: false,
  halfVector: [0.902, 0.3472, 0.2567],
  exponent: 256,
  saved: null,
  readback: null,
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

  // The reference decode for this mip is ready: refresh the candidate search
  // inspection against it. Kept off the GPU path so a device readback failure
  // still leaves the CPU-side analysis usable.
  try {
    runInspection();
  } catch (err) {
    log('error', `inspection failed: ${err.message}`);
  }
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

// ---------------------------------------------------------------------------
// Candidate-search inspection
// ---------------------------------------------------------------------------
//
// Re-runs the purpose-aware search on the current mip's *reference* decode so
// the page can show, per block, why a candidate lost and how much work the
// bound/budget saved relative to exhaustive search. The numbers come from the
// same `encodeWithInspection` the CLI uses; the page never fabricates them.

function readOptControls() {
  optState.purpose = $('opt-purpose').value;
  optState.edgeMode = $('opt-edge').value;
  optState.budget = Number($('opt-budget').value);
  optState.exhaustive = $('opt-exhaustive').checked;
  optState.format = $('opt-format').value;
  const hv = $('opt-hv').value.split(',').map(Number).filter((n) => Number.isFinite(n));
  if (hv.length === 3) optState.halfVector = hv;
  const exp = Number($('opt-exp').value);
  if (Number.isFinite(exp) && exp > 0) optState.exponent = exp;
}

function runInspection() {
  const ref = state.cpuReference && state.cpuReference[state.mip];
  if (!ref) return;
  readOptControls();

  const prevPurpose = optState.inspection ? optState.inspection.purpose : null;
  const prevEdge = optState.inspection ? optState.inspection.edgeMode : null;

  // Purpose or edge mode changed: the old rankings must not be reused. The
  // cache keys on both, so a stale entry cannot be served anyway, but we also
  // drop the prior purpose's entries explicitly so the page can log the
  // invalidation the way a material switch would.
  if (prevPurpose && prevPurpose !== optState.purpose) {
    const before = optState.cache.stats().entries;
    optState.cache.invalidatePurpose(prevPurpose);
    log('ok', `purpose ${prevPurpose} -> ${optState.purpose}: invalidated ${before - optState.cache.stats().entries} cached rankings (no reuse across purposes)`);
  }
  if (prevEdge && prevEdge !== optState.edgeMode) {
    optState.cache.invalidateEdgeMode(prevEdge);
    log('ok', `edge convention ${prevEdge} -> ${optState.edgeMode}: invalidated edge-scoped entries`);
  }

  const options = {
    purpose: optState.purpose,
    edgeMode: optState.edgeMode,
    format: optState.format,
    exhaustive: optState.exhaustive,
    budget: optState.exhaustive ? undefined : optState.budget,
    records: true,
    auditBudget: !optState.exhaustive,
    halfVector: optState.purpose === PURPOSE.NORMAL ? optState.halfVector : undefined,
    exponent: optState.purpose === PURPOSE.NORMAL ? optState.exponent : undefined,
    cache: optState.cache,
  };

  optState.inspection = encodeWithInspection(ref, options);
  optState.saved = optState.exhaustive ? null : savedVsExhaustive(ref, {
    purpose: optState.purpose, edgeMode: optState.edgeMode, budget: options.budget,
  });
  optState.readback = readbackInspection(optState.inspection);
  optState.leak = optState.purpose === PURPOSE.ALPHA
    ? exportedEdgeLeak(optState.inspection, 1, null)
    : null;

  // Default the selection to the worst point so "the worst point on screen" is
  // immediately readable without hunting for it.
  const worst = worstPoint(optState.inspection, state.mip);
  if (worst) optState.selected = { bx: worst.blockX, by: worst.blockY };

  renderInspection();
}

function renderInspection() {
  const insp = optState.inspection;
  if (!insp) return;
  const { stats } = insp;
  const pairsPerBlock = (stats.totalPairs / Math.max(1, stats.blocks)).toFixed(0);
  $('opt-summary').textContent =
    `purpose=${insp.purpose} format=${insp.format || 'bc1'} edge=${insp.edgeMode} ${insp.exhaustive ? 'EXHAUSTIVE' : `budget=${optState.budget}`} · ` +
    `blocks=${stats.blocks} pairs/block=${pairsPerBlock} evaluated=${stats.evaluated} ` +
    `bound-pruned=${stats.prunedBound} budget-pruned=${stats.prunedBudget} fallback=${stats.fallbackBlocks}`;
  $('opt-summary').className = 'mono';

  renderOptCanvas(insp);
  renderDecision(insp);
  renderReasons(insp);
  renderSavings(insp);
  renderLeak(insp);
  renderReadback(insp);
}

function renderLeak(insp) {
  const box = $('opt-leak');
  if (insp.purpose !== PURPOSE.ALPHA) {
    box.textContent = '仅在“透明边缘”用途下测量。';
    return;
  }
  const rows = (optState.leak || []).filter((r) => r.filteredLeak > 0 || r.leaked);
  const leaking = rows.filter((r) => r.leaked);
  if (!rows.length) {
    box.textContent = '没有检测到缩小后才出现的漏色（所有块的边缘颜色在过滤后仍接近源）。';
    return;
  }
  const top = leaking.sort((a, b) => b.filteredLeak - a.filteredLeak)[0] || rows[0];
  box.innerHTML =
    `共 ${rows.length} 块边缘颜色在过滤后偏离源 · 其中 <b>${leaking.length}</b> 块的漏色在 mip0 最近采样下不可见、缩小后才出现。<br>` +
    `最严重块 (${top.blockX},${top.blockY}): mip0 可见差=${fmt(top.mip0VisibleDiff)} → 过滤后漏色=${fmt(top.filteredLeak)}`;
}

function renderOptCanvas(insp) {
  const canvas = $('opt-canvas');
  const zoom = 6;
  const w = insp.blocksX * 4;
  const h = insp.blocksY * 4;
  canvas.width = w * zoom;
  canvas.height = h * zoom;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const img = ctx.createImageData(w, h);
  for (const block of insp.blocks) {
    for (let ty = 0; ty < 4; ty++) {
      for (let tx = 0; tx < 4; tx++) {
        if (block.bx * 4 + tx >= w || block.by * 4 + ty >= h) continue;
        const so = (ty * 4 + tx) * 4;
        const dx = block.bx * 4 + tx;
        const dy = block.by * 4 + ty;
        const o = (dy * w + dx) * 4;
        img.data[o] = block.decoded[so];
        img.data[o + 1] = block.decoded[so + 1];
        img.data[o + 2] = block.decoded[so + 2];
        img.data[o + 3] = block.decoded[so + 3];
      }
    }
  }
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  small.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);

  // Block grid + worst-point / selection overlay.
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let bx = 0; bx <= insp.blocksX; bx++) {
    ctx.beginPath(); ctx.moveTo(bx * 4 * zoom, 0); ctx.lineTo(bx * 4 * zoom, canvas.height); ctx.stroke();
  }
  for (let by = 0; by <= insp.blocksY; by++) {
    ctx.beginPath(); ctx.moveTo(0, by * 4 * zoom); ctx.lineTo(canvas.width, by * 4 * zoom); ctx.stroke();
  }
  const worst = worstPoint(insp, state.mip);
  if (worst) rect(ctx, worst.blockX, worst.blockY, zoom, '#e05b5b');
  rect(ctx, optState.selected.bx, optState.selected.by, zoom, '#5db0ff');

  canvas.onclick = (e) => {
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * canvas.width;
    const py = (e.clientY - r.top) / r.height * canvas.height;
    optState.selected = {
      bx: Math.max(0, Math.min(insp.blocksX - 1, Math.floor(px / (4 * zoom)))),
      by: Math.max(0, Math.min(insp.blocksY - 1, Math.floor(py / (4 * zoom)))),
    };
    renderOptCanvas(insp);
    renderDecision(insp);
  };
}

function rect(ctx, bx, by, zoom, colour) {
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx * 4 * zoom + 1, by * 4 * zoom + 1, 4 * zoom - 2, 4 * zoom - 2);
}

function renderDecision(insp) {
  const block = blockAt(insp, optState.selected.bx, optState.selected.by, state.mip);
  const decision = $('opt-decision');
  const swatches = $('opt-swatches');
  if (!block) {
    decision.textContent = '未选择块。';
    swatches.innerHTML = '';
    return;
  }
  const d = block.deviation;
  decision.innerHTML = '';
  const lines = [
    ['块', `(${block.blockX},${block.blockY})  mip ${block.mip}`],
    ['用途', block.purpose],
    ['最差点评分', fmt(block.score)],
  ];
  if (block.chosen) {
    lines.push(['选中 c0/c1', `${block.chosen.c0} / ${block.chosen.c1}`]);
    lines.push(['颜色 MSE', fmt(block.chosen.colorMse)]);
    if (block.chosen.normalAngleDeg != null) {
      lines.push(['平均法线偏角', `${fmt(block.chosen.normalAngleDeg)}°`]);
      lines.push(['高光 x', block.chosen.highlightX == null ? 'n/a' : fmt(block.chosen.highlightX) + (block.chosen.highlightFlip ? ' (翻转!)' : '')]);
    }
    if (block.chosen.coverageLossEdges.length) {
      lines.push(['丢失覆盖边', `[${block.chosen.coverageLossEdges.join(',')}]`]);
    }
  } else {
    lines.push(['选中', 'cutout 块，走参考编码器']);
  }
  if (block.fallback) lines.push(['注意', '无候选通过全部门槛，回退为颜色最近候选']);
  lines.push(['算法', `评估 ${block.work.evaluated}/${block.work.total} 剪枝 bound=${block.work.prunedBound} budget=${block.work.prunedBudget}`]);
  for (const [k, v] of lines) {
    const div = document.createElement('div');
    div.className = 'kv';
    div.innerHTML = `<b>${k}:</b> ${v}`;
    decision.appendChild(div);
  }

  swatches.innerHTML = '';
  swatches.appendChild(swatchRow('源', block.sourceTexels));
  swatches.appendChild(swatchRow('解码', block.decodedTexels));
  const dev = document.createElement('div');
  dev.className = 'kv';
  dev.innerHTML = `<b>回读偏差:</b> ` + (d.meanAngleDeg != null
    ? `平均 ${fmt(d.meanAngleDeg)}° 最大 ${fmt(d.maxAngleDeg)}°`
    : d.meanAlphaError != null
      ? `alpha 平均 ${fmt(d.meanAlphaError)} 最大 ${fmt(d.maxAlphaError)}`
      : `颜色 MSE ${fmt(d.colorMse)}`);
  swatches.appendChild(dev);
}

function swatchRow(label, texels) {
  const wrap = document.createElement('div');
  const head = document.createElement('div');
  head.className = 'kv';
  head.innerHTML = `<b>${label}</b>`;
  wrap.appendChild(head);
  const row = document.createElement('div');
  row.className = 'swatch-row';
  for (let t = 0; t < 16; t++) {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = `rgba(${texels[t * 4]},${texels[t * 4 + 1]},${texels[t * 4 + 2]},${(texels[t * 4 + 3] / 255).toFixed(2)})`;
    row.appendChild(s);
  }
  wrap.appendChild(row);
  return wrap;
}

function renderReasons(insp) {
  const block = blockAt(insp, optState.selected.bx, optState.selected.by, state.mip);
  const list = $('opt-reasons');
  list.innerHTML = '';
  if (!block) return;
  const pill = (kind, text) => `<span class="pill pill-${kind}">${text}</span>`;
  for (const p of block.prunedBound.slice(0, 8)) {
    const li = document.createElement('li');
    li.innerHTML = `${pill('bound', 'BOUND')} c0=${p.c0} c1=${p.c1} — ${p.detail}`;
    list.appendChild(li);
  }
  for (const p of block.prunedBudget.slice(0, 8)) {
    const li = document.createElement('li');
    li.innerHTML = `${pill('budget', 'BUDGET')} c0=${p.c0} c1=${p.c1} — ${p.detail}`;
    list.appendChild(li);
  }
  const byReason = {};
  for (const e of block.eliminated) byReason[e.eliminate] = byReason[e.eliminate] || [];
  for (const e of block.eliminated) byReason[e.eliminate].push(e);
  for (const [reason, items] of Object.entries(byReason)) {
    const kind = reason.includes('flip') ? 'flip' : reason.includes('angle') ? 'angle'
      : reason.includes('coverage') ? 'coverage' : 'color';
    const ex = items[0];
    const li = document.createElement('li');
    li.innerHTML = `${pill(kind, reason)} ×${items.length} — 例 c0=${ex.c0} c1=${ex.c1}: ${ex.detail}`;
    list.appendChild(li);
  }
  if (!list.children.length) {
    const li = document.createElement('li');
    li.textContent = '该块没有记录到剪枝或淘汰（全部候选通过）。';
    list.appendChild(li);
  }
}

function renderSavings(insp) {
  const box = $('opt-savings');
  if (insp.exhaustive) {
    box.textContent = '穷举模式：评估全部候选对，无下界/预算剪枝（用于对照）。';
    return;
  }
  const s = optState.saved;
  if (!s) { box.textContent = '—'; return; }
  const pct = s.exhaustiveEvaluated ? (s.evaluationsSaved / s.exhaustiveEvaluated * 100).toFixed(1) : '0';
  box.innerHTML =
    `节约候选算量: <b>${s.evaluationsSaved}</b> / ${s.exhaustiveEvaluated} 次评估 (${pct}%) · ` +
    `相同选择 ${s.sameChoice}/${s.blocks} 块 · 不同选择 ${s.differingBlocks} 块 · 其中可接受 ${s.acceptableMisses} 块`;
}

function renderReadback(insp) {
  const tbody = $('opt-readback').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = optState.readback || [];
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5">没有预算剪枝导致的错失（或运行在穷举模式）。</td>';
    tbody.appendChild(tr);
    return;
  }
  for (const r of rows.slice(0, 20)) {
    const dev = (d) => d.meanAngleDeg != null
      ? `${fmt(d.meanAngleDeg)}°/${fmt(d.maxAngleDeg)}°`
      : d.meanAlphaError != null
        ? `a=${fmt(d.meanAlphaError)}`
        : `MSE ${fmt(d.colorMse)}`;
    const delta = r.purpose === 'normal'
      ? `${fmt(r.delta.meanAngleDeg)}°`
      : r.purpose === 'alpha'
        ? `${fmt(r.delta.meanAlphaError)}`
        : `${fmt(r.delta.colorMse)}`;
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>(${r.blockX},${r.blockY})</td><td>${dev(r.exported)}</td><td>${dev(r.missed)}</td>` +
      `<td>${delta}</td><td>c0=${r.alternative.c0} c1=${r.alternative.c1}</td>`;
    tbody.appendChild(tr);
  }
}

function wireControls() {
  $('texture-select').addEventListener('change', (e) => {
    optState.inspection = null;
    optState.saved = null;
    optState.readback = null;
    optState.cache.clear();
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

  // Optimiser inspection controls.
  $('opt-budget').addEventListener('input', (e) => {
    $('opt-budget-value').textContent = e.target.value;
  });
  $('opt-run').addEventListener('click', () => {
    try {
      runInspection();
    } catch (err) {
      log('error', `inspection failed: ${err.message}`);
    }
  });
  for (const id of ['opt-purpose', 'opt-edge', 'opt-format', 'opt-exhaustive', 'opt-hv', 'opt-exp']) {
    $(id).addEventListener('change', () => {
      try {
        runInspection();
      } catch (err) {
        log('error', `inspection failed: ${err.message}`);
      }
    });
  }
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
