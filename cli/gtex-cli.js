#!/usr/bin/env node
// Command-line companion for the compressed-texture toolchain.
//
// The Web page (web/index.html) is the graphics entry point and performs the
// real device load/sample/readback verification. This CLI only prepares and
// inspects resource files; it never claims a format is device-supported.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../src/png.js';
import { deflate, inflate } from '../src/node-zlib.js';
import { generateMipChain } from '../src/mip.js';
import {
  writeGtex, readGtex, validateGtex, decodePayloadMips, FOURCC, fourccString,
} from '../src/gtex.js';
import { psnrFromMse } from '../src/color.js';
import { makeAllTestTextures } from '../src/textures.js';
import { normalizeOptions, runOptimizerReport, printOptimizerReport } from '../src/bc-report-cli.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function packOne(name, image, transfer) {
  const levels = generateMipChain(image);
  const gtex = writeGtex(levels, transfer);
  ensureDir(ASSETS);
  const outPath = join(ASSETS, `${name}.gtex`);
  writeFileSync(outPath, gtex);

  const parsed = readGtex(gtex);
  const validation = validateGtex(parsed);
  const stats = buildStats(parsed, levels);
  return { name, transfer, outPath, levels, parsed, validation, stats };
}

function buildStats(parsed, referenceLevels) {
  const result = [];
  for (const payload of parsed.payloads) {
    const decoded = decodePayloadMips(parsed, payload.format);
    const isBc1 = payload.format === FOURCC.BC1;
    const levelStats = decoded.map((img, mip) => {
      const ref = referenceLevels[mip];
      const count = ref.width * ref.height;
      // RGB errors are only counted where the reference texel has coverage:
      // RGB stored under alpha=0 is never sampled by an alpha-blending
      // pipeline, so penalizing it would misreport compression quality.
      const rgbMse = coverageMse(ref.pixels, img.pixels, count, [0, 1, 2]);
      const alphaMse = isBc1
        ? coverageMse(ref.pixels, img.pixels, count, [3], 250)
        : mseChannel(ref.pixels, img.pixels, count, [3]);
      return {
        mip,
        width: ref.width,
        height: ref.height,
        rgbPsnr: psnrFromMse(rgbMse),
        alphaPsnr: psnrFromMse(alphaMse),
      };
    });
    const totalBytes = payload.mips.reduce((n, m) => n + m.size, 0);
    result.push({ format: fourccString(payload.format), totalBytes, levelStats });
  }
  return result;
}

function coverageMse(a, b, pixels, channels, alphaCut = 1) {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < pixels; p++) {
    if (a[p * 4 + 3] < alphaCut) continue;
    for (const c of channels) {
      const d = a[p * 4 + c] - b[p * 4 + c];
      sum += d * d;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function mseChannel(a, b, pixels, channels) {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < pixels; p++) {
    for (const c of channels) {
      const d = a[p * 4 + c] - b[p * 4 + c];
      sum += d * d;
      n++;
    }
  }
  return sum / n;
}

function printReport(reports) {
  for (const r of reports) {
    console.log(`\n=== ${r.name} (${r.transfer}) ===`);
    console.log(`  levels: ${r.levels.length}, level0: ${r.levels[0].width}x${r.levels[0].height}`);
    if (!r.validation.ok) {
      console.log('  CONTAINER INVALID:');
      for (const e of r.validation.errors) console.log(`    - ${e}`);
      continue;
    }
    for (const warn of r.validation.warnings) console.log(`  warning: ${warn}`);
    for (const s of r.stats) {
      const l0 = s.levelStats[0];
      console.log(`  ${s.format.padEnd(5)} bytes=${String(s.totalBytes).padStart(7)}  level0 RGB PSNR=${fmtPsnr(l0.rgbPsnr)} dB  alpha PSNR=${fmtPsnr(l0.alphaPsnr)} dB`);
      console.log(s.levelStats.map((l) => `    mip${l.mip} ${l.width}x${l.height} RGB=${fmtPsnr(l.rgbPsnr)}dB A=${fmtPsnr(l.alphaPsnr)}dB`).join('\n'));
    }
  }
}

function fmtPsnr(v) {
  return v === Infinity ? 'inf' : v.toFixed(2);
}

function cmdPackAll() {
  const reports = makeAllTestTextures().map((t) => packOne(t.name, t.image, t.transfer));
  printReport(reports);
  const failed = reports.filter((r) => !r.validation.ok);
  if (failed.length) {
    console.error('\nFAIL: invalid containers written');
    process.exit(1);
  }
  console.log(`\nWrote ${reports.length} .gtex resources to ${ASSETS}`);
}

function cmdPack(pngPath, name, transfer = 'srgb') {
  const bytes = readFileSync(pngPath);
  const image = decodePng(new Uint8Array(bytes), inflate);
  const report = packOne(name || basename(pngPath, '.png'), image, transfer);
  printReport([report]);
}

function cmdVerify(paths) {
  const targets = paths.length ? paths : readdirSync(ASSETS).filter((f) => f.endsWith('.gtex')).map((f) => join(ASSETS, f));
  let bad = 0;
  for (const p of targets) {
    const parsed = readGtex(new Uint8Array(readFileSync(p)));
    const result = validateGtex(parsed);
    console.log(`${p}: ${result.ok ? 'VALID' : 'INVALID'} (${parsed.header.width}x${parsed.header.height}, ${parsed.header.mipCount} mips, ${parsed.header.transfer})`);
    for (const e of result.errors) { bad++; console.log(`  ERROR ${e}`); }
    for (const w of result.warnings) console.log(`  warn  ${w}`);
    for (const payload of parsed.payloads) {
      console.log(`  payload ${fourccString(payload.format)}: ${payload.mips.length} mips, ${payload.dataSize} bytes`);
    }
  }
  process.exit(bad ? 1 : 0);
}

function cmdDecodePng(pngPath, outPath) {
  const image = decodePng(new Uint8Array(readFileSync(pngPath)), inflate);
  const roundTrip = encodePng(image, deflate);
  writeFileSync(outPath, roundTrip);
  console.log(`re-encoded ${pngPath} -> ${outPath}`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case 'pack-all': cmdPackAll(); break;
  case 'pack': cmdPack(rest[0], rest[1], rest[2]); break;
  case 'verify': cmdVerify(rest); break;
  case 'reencode-png': cmdDecodePng(rest[0], rest[1]); break;
  case 'optimize': cmdOptimize(rest); break;
  default:
    console.log(`usage:
  gtex-cli.js pack-all                       build all test .gtex resources
  gtex-cli.js pack <input.png> <name> [srgb|linear]
  gtex-cli.js verify [file.gtex ...]         structural container verification
  gtex-cli.js reencode-png <in.png> <out.png>
  gtex-cli.js optimize <texture> [options]   purpose-aware search report
      textures: soft-blob | high-freq | linear-data | normal-flip | edge-leak
      --purpose=color|normal|alpha   elimination conditions (default color)
      --exhaustive                   disable bound/budget pruning (full search)
      --edge=clamp|tile              edge convention for border blocks
      --budget=N                     max pairs evaluated per block
      --mip=N                        inspect mip level N (default 0)
      --hv=x,y,z --exponent=S        half-vector / Blinn-Phong exponent (normal)
`);
    process.exit(cmd ? 1 : 0);
}

function cmdOptimize(argv) {
  const opts = normalizeOptions(argv);
  const report = runOptimizerReport(opts);
  printOptimizerReport(report);
}
