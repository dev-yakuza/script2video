#!/usr/bin/env node
/**
 * CI: `s2v snapshot --frames` wrote what its index.json lists (S6). Usage:
 * node scripts/check-frames.mjs <frames dir> <expected scene count>
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [dir, scenes] = process.argv.slice(2);
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const files = index.scenes.flatMap((s) => s.frames.map((f) => f.file));
const fail = (m) => {
  console.error(`check-frames: ${m}`);
  process.exit(1);
};
if (index.scenes.length !== Number(scenes))
  fail(`${index.scenes.length} scenes, expected ${scenes}`);
if (files.length === 0) fail('no stills');
for (const f of files)
  if (!existsSync(join(dir, f)) || statSync(join(dir, f)).size === 0) fail(`missing ${f}`);
const pngs = readdirSync(dir).filter((f) => f.endsWith('.png'));
if (pngs.length !== files.length) fail(`${pngs.length} png files, index lists ${files.length}`);
console.log(`check-frames: ${files.length} stills in ${index.scenes.length} scenes`);
