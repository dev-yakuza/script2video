/** `s2v capture` (S5 plan 1): flags in, files out, exit code. */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UsageError } from '../args.js';
import { allowHostOf, HostError, pinHosts, targetOf } from './address.js';
import { capture, DEFAULT_VIEWPORT, type CaptureOptions } from './capture.js';
import { emptyJson } from './extract.js';
import { writeAtomic } from './files.js';

const intFlag = (name: string, value: string | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > max)
    throw new UsageError(`--${name} must be a whole number from 1 to ${max}, not "${value}"`);
  return n;
};

export interface CaptureFlags {
  out?: string;
  text?: string;
  'assets-dir'?: string;
  width?: string;
  height?: string;
  selector?: string;
  'allow-host'?: string[];
  timeout?: string;
}

/** Runs the command; returns the exit code (usage mistakes throw UsageError). */
export async function runCapture(
  input: string | undefined,
  flags: CaptureFlags,
  browserPath: () => Promise<string>,
  log: (m: string) => void,
): Promise<number> {
  if (!input) throw new UsageError('s2v capture: which URL?');
  const url = targetOf(input);
  if (!flags.out) throw new UsageError('s2v capture: --out <png> is required');
  const out = resolve(flags.out);
  const text = flags.text === undefined ? undefined : resolve(flags.text);
  if (text === out) throw new UsageError('--out and --text must be different files');
  const allow = [url.hostname, ...(flags['allow-host'] ?? []).map(allowHostOf)];
  const width = intFlag('width', flags.width, DEFAULT_VIEWPORT.width, 4096);
  const height = intFlag('height', flags.height, DEFAULT_VIEWPORT.height, 4096);
  const timeoutSec = intFlag('timeout', flags.timeout, 30, 600);
  if (flags.selector === '') throw new UsageError('--selector is empty');
  for (const f of [out, text])
    if (f && statSync(f, { throwIfNoEntry: false })?.isDirectory())
      throw new UsageError(`${f} is a folder; give a file name`);

  // a failed run leaves no result from an earlier one
  for (const f of [out, text]) if (f) rmSync(f, { force: true });
  mkdirSync(dirname(out), { recursive: true });
  if (text) mkdirSync(dirname(text), { recursive: true });
  const writeJson = (json: unknown) => {
    if (text) writeAtomic(text, JSON.stringify(json, null, 2) + '\n');
  };

  let pinned: Map<string, string>;
  try {
    pinned = await pinHosts([...new Set(allow)]);
  } catch (e) {
    if (!(e instanceof HostError)) throw e;
    log(e.message);
    writeJson(emptyJson(url.href));
    return 1;
  }
  // whatever goes wrong from here, exit 1 still writes what is known
  try {
    return await captureTo(
      url,
      pinned,
      flags,
      { width, height, timeoutSec, out, browserPath, log },
      writeJson,
    );
  } catch (e) {
    log(e instanceof Error ? e.message : String(e));
    writeJson(emptyJson(url.href));
    return 1;
  }
}

async function captureTo(
  url: URL,
  pinned: Map<string, string>,
  flags: CaptureFlags,
  c: {
    width: number;
    height: number;
    timeoutSec: number;
    out: string;
    browserPath: () => Promise<string>;
    log: (m: string) => void;
  },
  writeJson: (json: unknown) => void,
): Promise<number> {
  const { width, height, timeoutSec, out, browserPath, log } = c;
  // a folder that cannot be made fails here, before the browser starts
  if (flags['assets-dir']) mkdirSync(resolve(flags['assets-dir']), { recursive: true });
  const opts: CaptureOptions = {
    url,
    pinned,
    width,
    height,
    ...(flags.selector !== undefined ? { selector: flags.selector } : {}),
    timeoutMs: timeoutSec * 1000,
    ...(flags['assets-dir'] ? { assetsDir: resolve(flags['assets-dir']) } : {}),
    browserPath: await browserPath(),
    // containers that cannot give the browser its sandbox say so on purpose
    sandbox: process.env.S2V_CAPTURE_NO_SANDBOX !== '1',
    log,
  };
  const r = await capture(opts);
  writeJson(r.json);
  if (r.error !== null || !r.png) {
    log(r.error ?? 'no picture');
    return 1;
  }
  writeAtomic(out, r.png);
  return 0;
}
