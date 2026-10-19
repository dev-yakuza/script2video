#!/usr/bin/env node
/**
 * CI: the PROXY band is where it should be (S13). Compares the mean V (red) of a region in a
 * marked and an unmarked picture: `node scripts/check-band.mjs <marked> <unmarked> <w:h:x:y> <far w:h:x:y>`.
 * The band region must be much redder; the far region about the same.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [marked, plain, band, far] = process.argv.slice(2);
const meanV = (file, crop) => {
  const txt = join(mkdtempSync(join(tmpdir(), 'band-')), 'v.txt');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    ...(file.endsWith('.png') ? [] : ['-ss', '1']),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=${crop},signalstats,metadata=mode=print:key=lavfi.signalstats.VAVG:file=${txt}`,
    '-f',
    'null',
    '-',
  ]);
  return Number(/VAVG=([\d.]+)/.exec(readFileSync(txt, 'utf8'))[1]);
};
const d = meanV(marked, band) - meanV(plain, band);
const e = Math.abs(meanV(marked, far) - meanV(plain, far));
console.log(`check-band: band +${d.toFixed(1)}, far ${e.toFixed(1)}`);
if (!(d > 20 && e < 3)) process.exit(1);
