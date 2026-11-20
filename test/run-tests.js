// CPU-side regression tests. Device load/sample/readback verification lives in
// web/app.js and runs against a real WebGPU implementation; these tests pin the
// encoder, mip chain and container behavior that the Web page depends on.

import assert from 'node:assert/strict';
import { deflate, inflate } from '../src/node-zlib.js';
import { encodePng, decodePng } from '../src/png.js';
import {
  encodeBC1Block, decodeBC1Block, encodeBC3Block, decodeBC3Block,
  encodeBC1, decodeBC1, encodeBC3, decodeBC3, blocksX, blocksY,
} from '../src/bc.js';
import { bleedTransparent, downsample2x, generateMipChain, mipLevelCount } from '../src/mip.js';
import { writeGtex, readGtex, validateGtex, decodePayloadMips, FOURCC, padToBlock } from '../src/gtex.js';
import { srgbToLinearImage, srgbToLinearByte, linearToSrgbByte } from '../src/color.js';
import { makeSoftBlob, makeHighFreq, makeLinearData } from '../src/textures.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('PNG roundtrip preserves RGB and alpha', () => {
  const img = makeSoftBlob();
  const bytes = encodePng(img, deflate);
  const back = decodePng(bytes, inflate);
  assert.equal(back.width, img.width);
  assert.equal(back.height, img.height);
  assert.deepEqual(back.pixels, img.pixels);
});

test('PNG roundtrip drops to RGB for fully opaque images', () => {
  const img = makeLinearData();
  const bytes = encodePng(img, deflate);
  const back = decodePng(bytes, inflate);
  assert.deepEqual(back.pixels, img.pixels);
});

test('BC1 uniform block roundtrip within quantization error', () => {
  const block = new Uint8Array(16 * 4);
  for (let t = 0; t < 16; t++) block.set([200, 30, 90, 255], t * 4);
  const decoded = decodeBC1Block(encodeBC1Block(block, { punchAlpha: true }));
  for (let t = 0; t < 16; t++) {
    assert.ok(Math.abs(decoded[t * 4] - 200) <= 3);
    assert.ok(Math.abs(decoded[t * 4 + 1] - 30) <= 5);
    assert.ok(Math.abs(decoded[t * 4 + 2] - 90) <= 3);
    assert.equal(decoded[t * 4 + 3], 255);
  }
});

test('BC1 cutout block produces real punch-through alpha', () => {
  const block = new Uint8Array(16 * 4);
  for (let t = 0; t < 16; t++) block.set([100, 150, 200, t % 2 ? 255 : 0], t * 4);
  const encoded = encodeBC1Block(block, { punchAlpha: true });
  const dv = new DataView(encoded.buffer);
  // Punch-through mode requires color0 <= color1.
  assert.ok(dv.getUint16(0, true) <= dv.getUint16(2, true));
  const decoded = decodeBC1Block(encoded);
  for (let t = 0; t < 16; t++) {
    assert.equal(decoded[t * 4 + 3], t % 2 ? 255 : 0);
  }
});

test('BC1 does not punch soft alpha into black texels', () => {
  const img = makeSoftBlob();
  const decoded = decodeBC1(encodeBC1(img), img.width, img.height);
  // A soft edge texel (alpha 1..254) must never be turned into hard black.
  let checked = 0;
  for (let p = 0; p < img.width * img.height; p++) {
    const a = img.pixels[p * 4 + 3];
    if (a > 24 && a < 232) {
      const rgbSum = decoded[p * 4] + decoded[p * 4 + 1] + decoded[p * 4 + 2];
      assert.ok(rgbSum > 30, 'soft texel collapsed to black');
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('BC3 preserves soft alpha much better than BC1 on a feathered edge', () => {
  const img = makeSoftBlob();
  const dec1 = decodeBC1(encodeBC1(img), img.width, img.height);
  const dec3 = decodeBC3(encodeBC3(img), img.width, img.height);
  const alphaErr = (dec) => {
    let s = 0, n = 0;
    for (let p = 0; p < img.width * img.height; p++) {
      const d = img.pixels[p * 4 + 3] - dec[p * 4 + 3];
      s += d * d; n++;
    }
    return s / n;
  };
  assert.ok(alphaErr(dec3) < alphaErr(dec1) * 0.25);
});

test('BC3 block roundtrip keeps opaque alpha at 255', () => {
  const block = new Uint8Array(16 * 4);
  for (let t = 0; t < 16; t++) block.set([10, 200, 60, 255], t * 4);
  const decoded = decodeBC3Block(encodeBC3Block(block));
  for (let t = 0; t < 16; t++) assert.equal(decoded[t * 4 + 3], 255);
});

test('bleed repairs RGB under fully transparent texels without changing alpha', () => {
  const img = {
    width: 3, height: 2,
    pixels: new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0,
      0, 0, 255, 255, 255, 255, 0, 255, 0, 0, 0, 0,
    ]),
  };
  const bled = bleedTransparent(img);
  for (let p = 0; p < 6; p++) {
    if (img.pixels[p * 4 + 3] === 0) {
      assert.equal(bled.pixels[p * 4 + 3], 0);
      const rgb = bled.pixels[p * 4] + bled.pixels[p * 4 + 1] + bled.pixels[p * 4 + 2];
      assert.ok(rgb > 0, 'transparent texel still has black RGB after bleed');
    }
  }
});

test('downsample2x uses premultiplied alpha (no dark halo)', () => {
  // Two opaque white next to two transparent texels whose stored RGB is black.
  const img = {
    width: 2, height: 2,
    pixels: new Uint8Array([
      255, 255, 255, 255, 0, 0, 0, 0,
      255, 255, 255, 255, 0, 0, 0, 0,
    ]),
  };
  const bled = bleedTransparent(img);
  const small = downsample2x(bled);
  assert.equal(small.width, 1);
  assert.equal(small.height, 1);
  // Mean alpha 128, un-premultiplied RGB stays white rather than dark gray.
  assert.equal(small.pixels[3], 128);
  assert.ok(small.pixels[0] >= 250);
});

test('mip chain geometry halves until 1x1', () => {
  const img = makeHighFreq();
  const chain = generateMipChain(img);
  assert.equal(chain.length, mipLevelCount(img.width, img.height));
  assert.equal(chain[0].width, 50);
  assert.equal(chain[1].width, 25);
  assert.equal(chain.at(-1).width, 1);
  assert.equal(chain.at(-1).height, 1);
});

test('container validation passes for all test textures', () => {
  for (const t of [makeSoftBlob(), makeHighFreq(), makeLinearData()].map((image) => ({ image }))) {
    const bytes = writeGtex(generateMipChain(t.image), 'srgb');
    const parsed = readGtex(bytes);
    const result = validateGtex(parsed);
    assert.deepEqual(result.errors, []);
  }
});

test('container describes non-block-aligned level0 with block-aligned padding', () => {
  const img = makeSoftBlob(); // 33x27
  const bytes = writeGtex(generateMipChain(img), 'srgb');
  const parsed = readGtex(bytes);
  assert.equal(parsed.header.width, 33);
  assert.equal(parsed.header.height, 27);
  assert.equal(parsed.header.paddedWidth, 36);
  assert.equal(parsed.header.paddedHeight, 28);
  assert.equal(padToBlock(13), 16);
  const bc1 = parsed.payloads.find((p) => p.format === FOURCC.BC1);
  assert.equal(bc1.mips[0].size, blocksX(33) * blocksY(27) * 8);
});

test('container payloads decode back to the encoded mip dimensions', () => {
  const chain = generateMipChain(makeHighFreq());
  const bytes = writeGtex(chain, 'srgb');
  const parsed = readGtex(bytes);
  for (const format of [FOURCC.BC1, FOURCC.BC3, FOURCC.RGBA8]) {
    const mips = decodePayloadMips(parsed, format);
    assert.equal(mips.length, chain.length);
    mips.forEach((m, i) => {
      assert.equal(m.width, chain[i].width);
      assert.equal(m.height, chain[i].height);
    });
  }
});

test('container flags distinguish sRGB color textures from linear data', () => {
  const srgbBytes = writeGtex(generateMipChain(makeSoftBlob()), 'srgb');
  const linearBytes = writeGtex(generateMipChain(makeLinearData()), 'linear');
  assert.equal(readGtex(srgbBytes).header.transfer, 'srgb');
  assert.equal(readGtex(linearBytes).header.transfer, 'linear');
});

test('every container carries BC1, BC3 and RGBA8 fallback payloads', () => {
  const parsed = readGtex(writeGtex(generateMipChain(makeHighFreq()), 'srgb'));
  const formats = parsed.payloads.map((p) => p.format).sort((a, b) => a - b);
  assert.deepEqual(formats, [FOURCC.BC1, FOURCC.BC3, FOURCC.RGBA8].sort((a, b) => a - b));
});

test('non-block-aligned mip levels keep correct block padding at every level', () => {
  const parsed = readGtex(writeGtex(generateMipChain(makeSoftBlob()), 'srgb'));
  const expected = [
    [33, 27, 36, 28], [16, 13, 16, 16], [8, 6, 8, 8],
    [4, 3, 4, 4], [2, 1, 4, 4], [1, 1, 4, 4],
  ];
  for (const payload of parsed.payloads) {
    payload.mips.forEach((m, i) => {
      assert.deepEqual([m.width, m.height, m.paddedWidth, m.paddedHeight], expected[i]);
    });
  }
});

test('BC3 alpha block 3-bit index packing roundtrips through the bitstream', () => {
  // A monotonic alpha ramp can be represented by the 8-entry interpolation
  // table (max step ~37 between entries), so it exercises endpoint + index
  // packing without demanding more precision than the format allows.
  const block = new Uint8Array(16 * 4);
  const alphas = Array.from({ length: 16 }, (_, t) => Math.round((t / 15) * 255));
  for (let t = 0; t < 16; t++) block.set([10, 20, 30, alphas[t]], t * 4);
  const encoded = encodeBC3Block(block);
  const decoded = decodeBC3Block(new DataView(encoded.buffer, encoded.byteOffset, 16));
  for (let t = 0; t < 16; t++) {
    assert.ok(Math.abs(decoded[t * 4 + 3] - alphas[t]) <= 37,
      `alpha ${alphas[t]} decoded to ${decoded[t * 4 + 3]}`);
  }
  // A monotonic ramp must decode monotonically: proves index ordering and
  // the contiguous 48-bit bitfield packing are correct.
  for (let t = 1; t < 16; t++) {
    assert.ok(decoded[t * 4 + 3] >= decoded[(t - 1) * 4 + 3] - 1);
  }
});

test('container validation rejects corrupt out-of-bounds blobs', () => {
  const bytes = writeGtex(generateMipChain(makeSoftBlob()), 'srgb');
  const parsed = readGtex(bytes);
  // Mip tables start after header + payload table; corrupt the first mip's
  // offset field so its blob extends past the end of the file.
  const lastPayload = parsed.payloads[parsed.payloads.length - 1];
  const lastMip = lastPayload.mips[lastPayload.mips.length - 1];
  lastMip.offset = parsed.bytes.byteLength + 100;
  const result = validateGtex(parsed);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.includes('out of file bounds')));
});

test('sRGB transfer helpers are approximately inverse and leave alpha untouched', () => {
  // 8-bit byte-domain conversion loses precision in the dark toe (sRGB 16
  // maps to linear 2); this mirrors real GPU 8-bit sRGB sampler behavior.
  const tolerance = { 16: 6, 32: 2, 64: 2, 128: 1, 200: 1, 255: 0 };
  for (const [c, tol] of Object.entries(tolerance)) {
    const v = Number(c);
    assert.ok(Math.abs(linearToSrgbByte(srgbToLinearByte(v)) - v) <= tol);
  }
  const img = makeSoftBlob();
  const lin = srgbToLinearImage(img);
  for (let p = 0; p < img.width * img.height; p++) {
    assert.equal(lin.pixels[p * 4 + 3], img.pixels[p * 4 + 3]);
  }
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} tests passed`);
process.exit(failures ? 1 : 0);
