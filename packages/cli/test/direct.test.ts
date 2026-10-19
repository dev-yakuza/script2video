/** `s2v direct` (acting stage 6): the audio it trusts, the page, and the command line. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directPlan, parseScript, type Diagnostic } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { directDiagnostics, directHtml, directManifest } from '../src/direct.js';
import { planSentences } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function setup(body: string, cast = '  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n') {
  const dir = mkdtempSync(join(tmpdir(), 's2v-direct-'));
  mkdirSync(join(dir, 'video'));
  const path = join(dir, 'video', 'script.ko.md');
  const source = `---\nlang: ko\ncast:\n${cast}outputs:\n  youtube: { aspect: "16:9", layout: dialogue }\n  shorts: { aspect: "9:16", layout: shorts, scenes: [u] }\n---\n\n${body}\n`;
  writeFileSync(path, source);
  const script = parseScript(source).script!;
  return { dir, path, script };
}

describe('directManifest', () => {
  /** A lock holding audio for `keys` (id → key), with wav files for `files` of them. */
  function lock(path: string, sentences: Record<string, string>, missing: string[] = []) {
    const lockDir = join(dirname(path), 'audio', 'ko');
    mkdirSync(lockDir, { recursive: true });
    const entries: Record<string, unknown> = {};
    for (const [id, key] of Object.entries(sentences)) {
      const src = `${id.replace(/:/g, '-')}.wav`;
      entries[key] = { src, duration: 1.5, words: [] };
      if (!missing.includes(id)) writeFileSync(join(lockDir, src), '');
    }
    writeFileSync(
      join(lockDir, 'manifest.json'),
      JSON.stringify({ version: 1, lang: 'ko', entries, sentences, env: {} }),
    );
  }

  it('uses the audio of the current keys, also after ids moved', () => {
    const { path, script } = setup('# T {#t}\n\na: 가나다.\n\nb: 라마바.');
    const plan = planSentences(path, script, REPO, { draft: false, mock: true });
    // the lock is from before a paragraph was inserted at the top: same audio, old ids
    lock(path, { 't:5:0': plan.sentences['t:0:0']!, 't:6:0': plan.sentences['t:1:0']! });
    const dm = directManifest(path, script, REPO, true);
    expect(Object.keys(dm.manifest).sort()).toEqual(['t:0:0', 't:1:0']);
    expect(dm.stale).toBe(0);
    expect(dm.current).toBe(false);
    expect(dm.notes.join('\n')).toMatch(/S2V_TTS=mock/);
  });

  it('estimates changed lines, missing wavs and lines that cannot be planned', () => {
    const { path, script } = setup(
      '# T {#t}\n\na: 가나다.\n\nb: 라마바.\n\na: :audio{src=rec/none.wav}사아자.\n\nc{speed=0.8}: 차카타.',
      '  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n  c: { voice: "qwen:Ryan", speed: 0.6 }\n',
    );
    const plan = planSentences(path, script, REPO, { draft: false, mock: true });
    expect(plan.errors.map((e) => e.id)).toEqual(['t:2:0', 't:3:0']);
    lock(path, { 't:0:0': 'old-key', 't:1:0': plan.sentences['t:1:0']!, 't:2:0': 'x' }, ['t:1:0']);
    const dm = directManifest(path, script, REPO, true);
    expect(dm.manifest).toEqual({});
    expect(dm.stale).toBe(2); // t:2:0 cannot be planned: reported as an error, not as changed
    expect(dm.notes.join('\n')).toMatch(/2 lines changed since the last s2v tts/);
    expect(dm.notes).toContain('t:2:0: recording not found: rec/none.wav (estimated)');
    expect(dm.notes.some((n) => n.startsWith('t:3:0: speed') && n.endsWith('(estimated)'))).toBe(
      true,
    );
  });

  it('is current when the lock maps the same ids', () => {
    const { path, script } = setup('# T {#t}\n\na: 가나다.');
    const plan = planSentences(path, script, REPO, { draft: false, mock: true });
    lock(path, plan.sentences);
    const dm = directManifest(path, script, REPO, true);
    expect([dm.current, dm.stale, Object.keys(dm.manifest)]).toEqual([true, 0, ['t:0:0']]);
  });

  it('estimates everything without a lock', () => {
    const { path, script } = setup('# T {#t}\n\na: 가나다.');
    expect(directManifest(path, script, REPO, false)).toEqual({
      manifest: {},
      stale: 0,
      current: true,
      notes: [],
      mock: false,
    });
  });
});

describe('directHtml', () => {
  it("escapes the script's text, ids and colors and is the same for the same input", () => {
    const { script } = setup(
      '# <b>T</b> {#t}\n\na{emo=happy say="x"}: <script>alert(1)</script> 가.\n\nb: 나 \'다\'.',
      '  a: { voice: "qwen:Sohee", color: "red;background:url(x)", name: "<i>A</i>" }\n  b: { voice: "qwen:Ryan", color: "#EA580C" }\n',
    );
    const plan = directPlan(script, 'youtube', {}, { rhythm: false });
    // the parser drops raw HTML from lines; the page must still escape whatever text it gets
    plan.scenes[0]!.rows[0]!.sentences[0]!.text = '<script>alert(1)</script> 가.';
    plan.notes.push({ code: 'long-turn', message: '</script><script>alert(2)</script>' });
    const html = () =>
      directHtml(plan, script, { scriptName: 'script.ko.md', diagnostics: [], notes: [] });
    const page = html();
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('</script><script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<b>T</b>');
    expect(page).not.toContain('<i>A</i>');
    expect(page).not.toContain('url(x)');
    expect(page).toContain('background:#EA580C');
    expect(page).toContain('&#39;다&#39;');
    expect(page).toContain('<html lang="ko">');
    expect(page).not.toMatch(/\/tmp|\/var\/folders|20\d\d-\d\d-\d\d/);
    expect(html()).toBe(page);
  });

  it('lists the notes with a copy button', () => {
    const { script } = setup(
      `# T {#t}\n\n${Array.from({ length: 4 }, (_, i) => `a: 가 ${i}.`).join('\n\n')}\n\nb: 나.`,
    );
    const plan = directPlan(script, 'youtube', {}, { rhythm: false });
    expect(plan.notes.map((n) => n.code)).toEqual(['long-turn']);
    const page = directHtml(plan, script, { scriptName: 's', diagnostics: [], notes: [] });
    expect(page).toContain('id="copy"');
    expect(page).toContain('href="#row-t_580"');
    expect(page).toContain('id="row-t_580"');
  });
});

describe('directDiagnostics', () => {
  it('drops what belongs to another output or to lines this output leaves out', () => {
    const { script } = setup(
      '# T {#t}\n\n::image{src=a.png}\n\na: 가.\n\nb: :only{youtube}나.\n\n# U {#u}\n\na: 다.\n\nb: :only{youtube}라.',
    );
    const plan = directPlan(script, 'shorts', {}, { rhythm: false });
    const lineOf = (scene: number, block: number) =>
      (script.scenes[scene]!.blocks[block] as { line: number }).line;
    const d = (line: number | undefined, message: string, code = 'x'): Diagnostic => ({
      severity: 'warning',
      code,
      message,
      ...(line !== undefined ? { line } : {}),
    });
    const all = [
      d(lineOf(0, 0), 'image in T'),
      d(lineOf(0, 1), 'in T'),
      d(lineOf(1, 0), 'in U'),
      d(lineOf(1, 1), 'only youtube in U'),
      d(lineOf(1, 0), 'a look (output "youtube")'),
      d(lineOf(1, 0), 'jiwoo has exited in output "youtube"'),
      d(lineOf(1, 0), 'in output "shorts" too'),
      d(undefined, '"youtube" is 1:00, over its maxDuration 0:30', 'max-duration'),
      d(undefined, '"shorts" is 1:00, over its maxDuration 0:30', 'max-duration'),
    ];
    expect(directDiagnostics(all, script, plan, true).map((x) => x.message)).toEqual([
      'in U',
      'in output "shorts" too',
      '"shorts" is 1:00, over its maxDuration 0:30',
    ]);
    expect(directDiagnostics(all, script, plan, false).map((x) => x.message)).toEqual([
      'in U',
      'in output "shorts" too',
    ]);
  });
});

describe('s2v direct (command line)', () => {
  const cli = join(REPO, 'packages/cli/dist/main.js');
  const run = (args: string[]) => {
    try {
      execFileSync('node', [cli, ...args], { cwd: REPO, stdio: 'pipe' });
      return { status: 0, err: '' };
    } catch (e) {
      const x = e as { status: number; stderr: Buffer };
      return { status: x.status, err: x.stderr.toString() };
    }
  };

  it('names the outputs when one is unknown (and writes nothing)', () => {
    const r = run(['direct', 'videos/sample-ko/script.ko.md', '--output', 'nope', '--no-open']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/unknown output "nope" \(have: youtube, shorts\)/);
    expect(existsSync(join(REPO, 'out', 'sample-ko', 'direct', 'nope.ko.html'))).toBe(false);
  });

  it('takes --rhythm on|off', () => {
    const on = run([
      'direct',
      'videos/sample-ko/script.ko.md',
      '--output',
      'nope',
      '--rhythm',
      'on',
    ]);
    expect(on.err).toMatch(/unknown output/);
    const bad = run(['direct', 'videos/sample-ko/script.ko.md', '--rhythm', 'maybe']);
    expect(bad.status).not.toBe(0);
    expect(bad.err).toMatch(/--rhythm must be on or off/);
  });
});
