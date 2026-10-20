/**
 * The GitHub workflows (final review 2, 3, 14): CI runs for every change a test or check reads,
 * a release runs the whole CI first, and each workflow asks only for the permissions it needs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const read = (name: string): Doc =>
  parse(readFileSync(join(REPO, '.github/workflows', name), 'utf8')) as Doc;

const ci = read('ci.yml');
const release = read('release.yml');
const TAG_PUSH = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')";

describe('ci.yml', () => {
  it('filters pushes and pull requests alike, leaving out only files nothing reads', () => {
    const { push, pull_request: pr } = ci.on;
    expect(push.paths).toBeUndefined();
    expect(pr.paths).toBeUndefined();
    expect(push['paths-ignore']).toEqual(pr['paths-ignore']);
    for (const p of push['paths-ignore'])
      expect(['LICENSE', 'Dockerfile', '.dockerignore', '.gitignore']).toContain(p);
  });

  it('can be called by the release, reads only, and cancels only pull request runs', () => {
    expect(ci.on).toHaveProperty('workflow_call');
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(ci.concurrency.group).toBe('${{ github.workflow }}-${{ github.ref }}');
    expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it('checks the formatting', () => {
    const runs = ci.jobs.node.steps.map((s: Doc) => s.run);
    expect(runs).toContain('yarn format:check');
  });
});

describe('release.yml', () => {
  it('runs the whole CI after the version check, and releases only for a pushed tag', () => {
    expect(release.on).toHaveProperty('workflow_dispatch');
    expect(release.permissions).toEqual({ contents: 'read' });
    const { version, ci: called, release: rel } = release.jobs;
    // the version job always runs (a dispatch still reaches ci); its check only on a tag
    expect(version.if).toBeUndefined();
    const check = version.steps.find((s: Doc) => String(s.run).includes('GITHUB_REF_NAME'));
    expect(check.if).toBe(TAG_PUSH);
    expect(called.uses).toBe('./.github/workflows/ci.yml');
    expect(called.needs).toBe('version');
    expect(called).not.toHaveProperty('secrets');
    expect(rel.needs).toEqual(expect.arrayContaining(['version', 'ci']));
    expect(rel.if).toBe(TAG_PUSH);
    expect(rel.permissions).toEqual({ contents: 'write' });
    // the checks live in ci.yml only
    const runs = rel.steps.map((s: Doc) => String(s.run ?? ''));
    expect(runs.some((r: string) => r.includes('yarn test'))).toBe(false);
  });
});
