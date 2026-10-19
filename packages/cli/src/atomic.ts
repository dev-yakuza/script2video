/** Write a file whole (S11): other s2v processes may read it meanwhile. */
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** Write beside, then rename into place; a failed write leaves no temporary file. */
export function atomicWrite(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
