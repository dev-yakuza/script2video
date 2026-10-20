/**
 * Every test file gets its own state folder (S8): the machine lock and resident.json of tests
 * never touch ~/.s2v, and no lock is left behind for the next test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { heldHere } from '../src/heavy-lock.js';
import { resetLocksForTests } from '../src/locks-reset.js';

for (const v of ['S2V_HEAVY_LOCK_TOKEN', 'S2V_ACTOR_LOCK_TOKEN'])
  if (process.env[v]) throw new Error(`${v} leaked into the test environment`);

const dir = mkdtempSync(join(tmpdir(), 's2v-state-'));
process.env.S2V_STATE_DIR = dir;

afterEach(() => {
  // before the reset: a token no lock of this process explains leaked out of a test
  const leaked =
    process.env.S2V_ACTOR_LOCK_TOKEN !== undefined
      ? 'S2V_ACTOR_LOCK_TOKEN'
      : process.env.S2V_HEAVY_LOCK_TOKEN !== undefined && !heldHere()
        ? 'S2V_HEAVY_LOCK_TOKEN'
        : null;
  resetLocksForTests();
  if (leaked) throw new Error(`${leaked} was left in the environment by a test`);
});

afterAll(() => {
  resetLocksForTests();
  rmSync(dir, { recursive: true, force: true });
});
