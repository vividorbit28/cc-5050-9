// Builds real GPU textures from a parsed .gtex container.
//
// The texture is allocated at the *block-padded* dimensions stored in the
// container (always multiples of 4). Each mip blob is uploaded through a
// staging buffer whose rows are padded to the 256-byte COPY_BYTTES_PER_ROW
// alignment; copyTextureToTexture then moves aligned data into the texture.
// The logical (non-padded) size is carried separately so rendering can crop
// padding texels instead of sampling them.

import { FOURCC } from '../src/gtex.js';
import { GPU_FORMAT, REQUIRED_FEATURE } from './gpu-formats.js';

const BLOCK_W = 4;
const BLOCK_H = 4;
const BYTES_PER_BLOCK = { [FOURCC.BC1]: 8, [FOURCC.BC3]: 16, [FOURCC.RGBA8]: 16 };

function blockInfo(format) {
  return {
    blockW: BLOCK_W,
    blockH: BLOCK_H,
    bytesPerBlock: BYTES_PER_BLOCK[format],
    isCompressed: format !== FOURCC.RGBA8,
  };
}

export function selectPayload(parsed, requestedFormat, adapter, forceFallback) {
  const wanted = parsed.payloads.find((p) => p.format === requestedFormat);
  if (!wanted) throw new Error('container lacks the requested payload');
  const feature = REQUIRED_FEATURE[requestedFormat];
  const unsupported =
    forceFallback || (feature && !adapter.features.has(feature));
  if (unsupported) {
    const fallback = parsed.payloads.find((p) => p.format === FOURCC.RGBA8);
    return {
      actualFormat: FOURCC.RGBA8,
      requestedFormat,
      payload: fallback,
      usedFallback: true,
      reason: forceFallback
        ? 'fallback forced from the UI'
        : `device missing ${feature}; using explicit RGBA8 fallback payload`,
    };
  }
  return {
    actualFormat: requestedFormat,
    requestedFormat,
    payload: wanted,
    usedFallback: false,
    reason: 'device supports the requested compressed format',
  };
}

export function createGpuTexture(device, parsed, selection, transfer) {
  const { actualFormat, payload } = selection;
  const info = blockInfo(actualFormat);
  payload._fileBytes = parsed.bytes;
  const viewFormat = transfer === 'srgb'
    ? (actualFormat === FOURCC.RGBA8 ? 'rgba8unorm-srgb'
      : actualFormat === FOURCC.BC1 ? 'bc1-rgba-unorm-srgb' : 'bc3-rgba-unorm-srgb')
    : GPU_FORMAT[actualFormat];

  const texture = device.createTexture({
    dimension: '2d',
    size: {
      width: parsed.header.paddedWidth,
      height: parsed.header.paddedHeight,
    },
    format: viewFormat,
    mipLevelCount: parsed.header.mipCount,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  for (let mip = 0; mip < payload.mips.length; mip++) {
    uploadMip(device, texture, payload, mip, actualFormat, info);
  }
  return { texture, viewFormat, info };
}

function uploadMip(device, texture, payload, mip, format, info) {
  const m = payload.mips[mip];
  const { paddedWidth, paddedHeight } = m;
  let bytesPerRow;
  let rowsPerImage;
  let blob;

  if (info.isCompressed) {
    const blocksPerRow = paddedWidth / info.blockW;
    const blockRows = paddedHeight / info.blockH;
    bytesPerRow = alignUp(blocksPerRow * info.bytesPerBlock, 256);
    rowsPerImage = blockRows;
    blob = new Uint8Array(bytesPerRow * rowsPerImage);
    const srcRowBytes = blocksPerRow * info.bytesPerBlock;
    const raw = payloadRaw(payload, m);
    for (let r = 0; r < blockRows; r++) {
      blob.set(raw.subarray(r * srcRowBytes, (r + 1) * srcRowBytes), r * bytesPerRow);
    }
  } else {
    bytesPerRow = alignUp(paddedWidth * 4, 256);
    rowsPerImage = paddedHeight;
    blob = new Uint8Array(bytesPerRow * rowsPerImage);
    const raw = payloadRaw(payload, m);
    const srcRowBytes = paddedWidth * 4;
    for (let r = 0; r < paddedHeight; r++) blob.set(raw.subarray(r * srcRowBytes, (r + 1) * srcRowBytes), r * bytesPerRow);
  }

  const staging = device.createBuffer({
    size: blob.byteLength,
    usage: GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint8Array(staging.getMappedRange()).set(blob);
  staging.unmap();

  const cmd = device.createCommandEncoder();
  cmd.copyBufferToTexture(
    { buffer: staging, bytesPerRow, rowsPerImage },
    { texture, mipLevel: mip },
    { width: paddedWidth, height: paddedHeight },
  );
  device.queue.submit([cmd.finish()]);
  staging.destroy();
}

function payloadRaw(payload, mip) {
  const bytes = payload._fileBytes;
  return bytes.subarray(mip.offset, mip.offset + mip.size);
}

function alignUp(v, a) {
  return Math.ceil(v / a) * a;
}

// Read back one mip from the GPU into a logical-size RGBA image. Compressed
// textures cannot be copied directly to a buffer, so a render pass draws the
// mip into an rgba8unorm texture of the padded size first.
export async function readbackMip(device, texture, mip, logicalW, logicalH, paddedW, paddedH) {
  const dst = device.createTexture({
    size: { width: paddedW, height: paddedH },
    format: 'rgba8unorm',
    mipLevelCount: 1,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const sampler = device.createSampler({
    minFilter: 'nearest',
    magFilter: 'nearest',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  const module = device.createShaderModule({ code: FULLSCREEN_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: dst.createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.draw(3);
  pass.end();

  const bytesPerRow = alignUp(paddedW * 4, 256);
  const staging = device.createBuffer({
    size: bytesPerRow * paddedH,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  encoder.copyTextureToBuffer(
    { texture: dst, mipLevel: 0 },
    { buffer: staging, bytesPerRow },
    { width: paddedW, height: paddedH },
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const full = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();
  dst.destroy();

  const logical = new Uint8Array(logicalW * logicalH * 4);
  for (let y = 0; y < logicalH; y++) {
    logical.set(full.subarray(y * bytesPerRow, y * bytesPerRow + logicalW * 4), y * logicalW * 4);
  }
  return logical;
}

const FULLSCREEN_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(
    vec2f(-1.0, -3.0),
    vec2f(3.0, 1.0),
    vec2f(-1.0, 1.0),
  );
  var out: VsOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = vec2f((p[vi].x + 1.0) * 0.5, 1.0 - (p[vi].y + 1.0) * 0.5);
  return out;
}

@group(0) @binding(0) var texSampler: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  return textureSample(tex, texSampler, in.uv);
}
`;
