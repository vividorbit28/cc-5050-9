#!/usr/bin/env node
// Emit the source PNGs for inspection alongside the packed .gtex resources.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../src/png.js';
import { deflate } from '../src/node-zlib.js';
import { makeAllTestTextures } from '../src/textures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
mkdirSync(ASSETS, { recursive: true });

for (const t of makeAllTestTextures()) {
  const png = encodePng(t.image, deflate);
  const path = join(ASSETS, `${t.name}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${t.image.width}x${t.image.height}, ${t.transfer})`);
}
