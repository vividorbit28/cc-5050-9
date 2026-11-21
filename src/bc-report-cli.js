// Command-line view of the purpose-aware optimiser.
//
// The CLI is deliberately a *reader* of the optimiser's decisions: it encodes
// with `encodeWithInspection`, then reports the worst point, the saved candidate
// work, the acceptable solutions the fast path skipped and what those skips
// would have cost on the exported material. It never re-derives the answer by a
// different method, so what it prints is what the encoder did.

import { makeHighFreq, makeSoftBlob, makeLinearData } from '../src/textures.js';
import { normalHighlightFlipFixture, edgeColourLeakFixture, evaluateEdgeLeak } from '../src/bc-fixtures.js';
import { PURPOSE, EDGE_MODE } from '../src/bc-encode.js';
import {
  encodeWithInspection, worstPoint, savedVsExhaustive, readbackInspection,
  eliminationSummary, exportedEdgeLeak,
} from '../src/bc-report.js';

const TEXTURE_BY_NAME = {
  'soft-blob': makeSoftBlob,
  'high-freq': makeHighFreq,
  'linear-data': makeLinearData,
  // Adversarial single-block fixtures, run through the same report path.
  'normal-flip': () => {
    const f = normalHighlightFlipFixture();
    return { width: 4, height: 4, pixels: f.texels };
  },
  'edge-leak': () => {
    const f = edgeColourLeakFixture();
    return { width: 4, height: 4, pixels: f.texels };
  },
};

export function normalizeOptions(argv) {
  const opts = {
    texture: 'high-freq',
    purpose: PURPOSE.COLOR,
    exhaustive: false,
    edgeMode: EDGE_MODE.CLAMP,
    budget: undefined,
    mip: 0,
    halfVector: undefined,
    exponent: undefined,
  };
  // Allow either `--purpose=normal` or `optimize normal ...` (bare token).
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      if (TEXTURE_BY_NAME[arg]) opts.texture = arg;
      else if (Object.values(PURPOSE).includes(arg)) opts.purpose = arg;
      else if (Object.values(EDGE_MODE).includes(arg)) opts.edgeMode = arg;
      continue;
    }
    const [flag, value] = arg.slice(2).split('=');
    switch (flag) {
      case 'purpose': opts.purpose = value; break;
      case 'edge': opts.edgeMode = value; break;
      case 'budget': opts.budget = Number(value); break;
      case 'mip': opts.mip = Number(value); break;
      case 'texture': opts.texture = value; break;
      case 'exhaustive': opts.exhaustive = value === undefined ? true : value !== 'false'; break;
      case 'format': opts.format = value; break;
      case 'hv': opts.halfVector = value.split(',').map(Number); break;
      case 'exponent': opts.exponent = Number(value); break;
      default: break;
    }
  }
  return opts;
}

// Pick the mip level by regenerating the chain the same way the container does,
// so `--mip=N` inspects the level the GPU would sample at N.
export function imageForTexture(name, mip = 0) {
  const make = TEXTURE_BY_NAME[name];
  if (!make) throw new Error(`unknown texture '${name}' (try soft-blob|high-freq|linear-data)`);
  let img = make();
  for (let i = 0; i < mip && (img.width > 1 || img.height > 1); i++) {
    img = halfImage(img);
  }
  return img;
}

function halfImage(img) {
  const w = Math.max(1, img.width >> 1);
  const h = Math.max(1, img.height >> 1);
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const x0 = Math.min(img.width - 1, x * 2);
        const y0 = Math.min(img.height - 1, y * 2);
        const x1 = Math.min(img.width - 1, x * 2 + 1);
        const y1 = Math.min(img.height - 1, y * 2 + 1);
        const v = (img.pixels[(y0 * img.width + x0) * 4 + c] +
          img.pixels[(y0 * img.width + x1) * 4 + c] +
          img.pixels[(y1 * img.width + x0) * 4 + c] +
          img.pixels[(y1 * img.width + x1) * 4 + c]) / 4;
        pixels[(y * w + x) * 4 + c] = Math.round(v);
      }
    }
  }
  return { width: w, height: h, pixels };
}

export function runOptimizerReport(opts) {
  const image = imageForTexture(opts.texture, opts.mip);
  // The normal fixture carries the light direction it was built for; if the
  // caller did not override it, use the fixture's so the highlight test is
  // meaningful without extra flags.
  let halfVector = opts.halfVector;
  let exponent = opts.exponent;
  let neighbour = null;
  if (opts.texture === 'normal-flip' && !halfVector) {
    const f = normalHighlightFlipFixture();
    halfVector = f.halfVector;
    exponent = exponent ?? f.exponent;
  }
  if (opts.texture === 'edge-leak') {
    neighbour = edgeColourLeakFixture().neighbour;
  }
  const fixtureEdge = opts.texture === 'edge-leak' ? evaluateEdgeLeak(edgeColourLeakFixture()) : null;
  const purpose = opts.texture === 'edge-leak' ? PURPOSE.ALPHA
    : opts.texture === 'normal-flip' ? PURPOSE.NORMAL
      : opts.purpose;
  const inspection = encodeWithInspection(image, {
    purpose,
    format: opts.format,
    exhaustive: opts.exhaustive,
    budget: opts.exhaustive ? undefined : opts.budget,
    edgeMode: opts.edgeMode,
    records: true,
    auditBudget: !opts.exhaustive,
    halfVector,
    exponent,
    punchAlpha: opts.texture === 'edge-leak',
  });
  const worst = worstPoint(inspection, opts.mip);
  const saved = opts.exhaustive ? null : savedVsExhaustive(image, {
    purpose, edgeMode: opts.edgeMode, budget: opts.budget,
  });
  const readback = readbackInspection(inspection);
  const eliminations = eliminationSummary(inspection);
  const leak = purpose === PURPOSE.ALPHA ? exportedEdgeLeak(inspection, 1, neighbour) : null;
  return { opts, image, inspection, worst, saved, readback, eliminations, leak, fixtureEdge };
}

export function printOptimizerReport(report) {
  const { opts, image, inspection, worst, saved, readback, eliminations, leak, fixtureEdge } = report;
  console.log(`\n=== optimize: ${opts.texture} mip${opts.mip} (${image.width}x${image.height}) ===`);
  console.log(`  purpose=${inspection.purpose}  format=${opts.format || 'bc1'}  edge=${opts.edgeMode}  search=${opts.exhaustive ? 'EXHAUSTIVE' : (opts.budget ? `budget=${opts.budget}` : 'bound-pruned')}`);
  console.log(`  blocks=${inspection.stats.blocks}  pairs/block=${(inspection.stats.totalPairs / inspection.stats.blocks).toFixed(1)}  ` +
    `evaluated=${inspection.stats.evaluated}  bound-pruned=${inspection.stats.prunedBound}  budget-pruned=${inspection.stats.prunedBudget}`);

  if (saved) {
    const pct = saved.exhaustiveEvaluated ? (saved.evaluationsSaved / saved.exhaustiveEvaluated * 100).toFixed(1) : '0';
    console.log(`  saved vs exhaustive: ${saved.evaluationsSaved} / ${saved.exhaustiveEvaluated} candidate evaluations (${pct}%)`);
    console.log(`  differing blocks: ${saved.differingBlocks}  acceptable misses: ${saved.acceptableMisses}`);
  } else {
    console.log('  exhaustive: every candidate pair evaluated (no bound/budget pruning)');
  }

  if (worst) {
    console.log(`\n  worst point: block (${worst.blockX},${worst.blockY}) at mip${worst.mip}  score=${fmt(worst.score)}`);
    if (worst.chosen) {
      console.log(`    chosen: c0=${worst.chosen.c0} c1=${worst.chosen.c1} colourMSE=${fmt(worst.chosen.colorMse)}` +
        (worst.chosen.normalAngleDeg != null ? ` angle=${fmt(worst.chosen.normalAngleDeg)}° highlightX=${fmt(worst.chosen.highlightX)}` : '') +
        (worst.chosen.coverageLossEdges.length ? ` coverageLost=[${worst.chosen.coverageLossEdges}]` : ''));
    } else {
      console.log('    chosen: (cutout block, reference encoder)');
    }
    console.log(`    decoded block (RGBA, 16 texels):`);
    console.log('      ' + texelRows(worst.decodedTexels).join('\n      '));
    console.log(`    pruned branches: bound=${worst.prunedBound.length} budget=${worst.prunedBudget.length}`);
    for (const p of worst.prunedBound.slice(0, 3)) console.log(`      BOUND  c0=${p.c0} c1=${p.c1}  ${p.detail}`);
    for (const p of worst.prunedBudget.slice(0, 3)) console.log(`      BUDGET c0=${p.c0} c1=${p.c1}  ${p.detail}`);
    console.log(`    eliminated candidates: ${worst.eliminated.length}`);
    const byReason = {};
    for (const e of worst.eliminated) byReason[e.eliminate] = (byReason[e.eliminate] || 0) + 1;
    for (const [reason, n] of Object.entries(byReason)) {
      const ex = worst.eliminated.find((e) => e.eliminate === reason);
      console.log(`      ${reason}: ${n}  e.g. c0=${ex.c0} c1=${ex.c1}  ${ex.detail}`);
    }
    if (worst.missed.length) {
      console.log(`    acceptable solutions missed by the budget: ${worst.missed.length}`);
    }
  }

  if (readback.length) {
    console.log(`\n  exported-material read-back (${readback.length} block(s) where the fast path skipped an acceptable alternative):`);
    for (const r of readback.slice(0, 5)) {
      const d = r.delta;
      const span = r.purpose === PURPOSE.NORMAL
        ? `angle Δ=${fmt(d.meanAngleDeg)}° (exported ${fmt(r.exported.meanAngleDeg)}° vs missed ${fmt(r.missed.meanAngleDeg)}°)`
        : r.purpose === PURPOSE.ALPHA
          ? `alpha Δ=${fmt(d.meanAlphaError)}`
          : `colour MSE Δ=${fmt(d.colorMse)} (exported ${fmt(r.exported.colorMse)} vs missed ${fmt(r.missed.colorMse)})`;
      console.log(`    block (${r.blockX},${r.blockY}) alt c0=${r.alternative.c0} c1=${r.alternative.c1}: ${span}`);
    }
  }

  if (fixtureEdge) {
    console.log('\n  equal-error pair demonstration (the two endpoint pairs the fixture compares):');
    console.log(`    both decode the visible interior identically (equal block colour error),`);
    console.log(`    expected fringe after minification: (${fixtureEdge.expected.map((v) => v.toFixed(0)).join(',')})`);
    console.log(`    low-leak  pair -> fringe (${fixtureEdge.fringeLow.map((v) => v.toFixed(0)).join(',')})  leak=${fmt(fixtureEdge.leakLow)}`);
    console.log(`    high-leak pair -> fringe (${fixtureEdge.fringeHigh.map((v) => v.toFixed(0)).join(',')})  leak=${fmt(fixtureEdge.leakHigh)}`);
    console.log(`    => equal at mip 0, not equivalent once a neighbour filters in (pair divergence=${fmt(fixtureEdge.pairDivergenceRgb)})`);
  }

  if (leak && leak.length) {
    console.log('\n  edge-leak read-out (right edge, filtered with an opaque neighbour):');
    for (const row of leak.slice(0, 6)) {
      console.log(`    block (${row.blockX},${row.blockY}) mip0 visible diff=${fmt(row.mip0VisibleDiff)}  filtered leak=${fmt(row.filteredLeak)}` +
        (row.leaked ? '  <-- becomes visible only when minified' : ''));
    }
  }

  console.log('\n  recorded elimination reasons (all blocks):');
  for (const [reason, n] of Object.entries(eliminations.byReason)) {
    console.log(`    ${reason}: ${n}  e.g. ${eliminations.examples[reason].detail}`);
  }
}

function texelRows(texels) {
  const rows = [];
  for (let y = 0; y < 4; y++) {
    const parts = [];
    for (let x = 0; x < 4; x++) {
      const o = (y * 4 + x) * 4;
      parts.push(`(${texels[o]},${texels[o + 1]},${texels[o + 2]},${texels[o + 3]})`);
    }
    rows.push(parts.join(' '));
  }
  return rows;
}

function fmt(v) {
  return v == null ? 'n/a' : (Number.isFinite(v) ? v.toFixed(2) : String(v));
}
