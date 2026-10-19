/** Writing results without following a planted link, and without half-written files. */
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Files being written, removed if the run is stopped. */
const writing = new Set<string>();
const dropWriting = () => {
  for (const f of writing) rmSync(f, { force: true });
};
process.on('exit', dropWriting);

/** Write next to `path` under a fresh name (never through a planted link), then rename. */
export function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  writing.add(tmp);
  try {
    const fd = openSync(tmp, 'wx', 0o644);
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    writing.delete(tmp);
  }
}
