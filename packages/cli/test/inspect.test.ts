import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTimeline,
  castMemberSchema,
  castsIn,
  DIRECTIVES,
  FRONTMATTER,
  frontmatterSchema,
  KNOWN_DIRECTIVES,
  outputScenes,
  parseScript,
  SPEAKER_ATTRS,
} from '@script2video/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { castOptions } from '../src/cast.js';
import { inspectScript, type InspectResult } from '../src/inspect.js';
import { loadAudioManifest } from '../src/tts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Hashes describe the real voices; the audio keys follow S2V_TTS like tts does.
beforeEach(() => {
  delete process.env.S2V_TTS;
});

const FM = (extra = '') =>
  `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Sohee" }\n${extra}---\n`;

/** Writes a script (and files) into a fresh folder and inspects it. */
function run(script: string, files: Record<string, string | Buffer> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 's2v-inspect-'));
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), data);
  }
  const path = join(dir, 'script.ko.md');
  writeFileSync(path, script);
  return inspectScript(path, ROOT);
}
const ok = (script: string, files?: Record<string, string | Buffer>): InspectResult => {
  const r = run(script, files);
  if ('errors' in r) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r.result;
};
const errorsOf = (script: string) => {
  const r = run(script);
  return 'errors' in r ? r.errors.map((e) => e.message).join('\n') : '';
};

const BODY =
  '# 하나 {#one}\n\na: 첫 문장입니다. 둘째 문장이에요.\n\n::image{src=a.png}\n\nb: 대답합니다.\n';

describe('inspect: closed world', () => {
  it('knows every directive and every frontmatter key', () => {
    expect(Object.keys(DIRECTIVES).sort()).toEqual([...KNOWN_DIRECTIVES].sort());
    // every key of the zod schema (nested) is in the frontmatter table
    const paths: string[] = [];
    const walk = (schema: unknown, path: string) => {
      const def = (schema as { def: Record<string, unknown> }).def;
      switch (def.type) {
        case 'optional':
        case 'default':
        case 'nullable':
          return walk(def.innerType, path);
        case 'union':
          for (const o of def.options as unknown[]) walk(o, path);
          return;
        case 'record':
          return walk(def.valueType, `${path}.*`);
        case 'object':
          for (const [k, v] of Object.entries(def.shape as Record<string, unknown>))
            walk(v, path ? `${path}.${k}` : k);
          return;
        default:
          paths.push(path);
      }
    };
    walk(frontmatterSchema, '');
    // internal keys the CLI fills from character files (scripts writing them get a parser error)
    const leaves = paths.filter(
      (p) => !p.startsWith('cast.*.faceMotions') && !p.startsWith('cast.*.faceSets'),
    );
    for (const p of leaves) expect(FRONTMATTER, p).toHaveProperty([p]);
    expect(castMemberSchema).toBeTruthy();
  });

  it('knows every directive attribute the renderer and core read', () => {
    const read = new Set<string>();
    const scan = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) scan(p);
        else if (/\.tsx?$/.test(f.name))
          for (const m of readFileSync(p, 'utf8').matchAll(/attrs\??\.([a-z]+)\b/g))
            read.add(m[1]!);
      }
    };
    for (const pkg of ['core', 'renderer-remotion']) scan(join(ROOT, 'packages', pkg, 'src'));
    const table = new Set([
      ...Object.values(DIRECTIVES).flatMap((d) =>
        typeof d.attrs === 'string' ? [] : Object.keys(d.attrs),
      ),
      ...Object.keys(SPEAKER_ATTRS),
    ]);
    expect([...read].filter((a) => !table.has(a))).toEqual([]);
  });

  it.each([
    [
      'an unknown directive attribute',
      `${FM()}# s\n\na: 안녕.\n\n::image{src=a.png foo=1}\n`,
      /image has no attribute "foo"/,
    ],
    [
      'an unknown speaker attribute',
      `${FM()}# s\n\na{colour=red}: 안녕.\n`,
      /no attribute "colour"/,
    ],
    [
      'a speaker prefix that is not key=value',
      `${FM()}# s\n\na{face=happy bounce}: 안녕.\n`,
      /is not key=value/,
    ],
    [
      'a gap that is not a number',
      `${FM()}# s\n\na{gap=abc}: 안녕.\n`,
      /gap must be a number from -1\.5 to 3: "abc"/,
    ],
    ['an unknown top-level key', `${FM('colour: red\n')}# s\n\na: 안녕.\n`, /"colour"/],
    [
      'an unknown cast key',
      `${FM()}# s\n\na: 안녕.\n`.replace('qwen:Sohee" }', 'qwen:Sohee", colr: red }'),
      /"cast\.a\.colr"/,
    ],
    [
      'an unknown output key',
      `${FM('outputs:\n  yt: { aspect: "16:9", layot: dialogue }\n')}# s\n\na: 안녕.\n`,
      /"outputs\.yt\.layot"/,
    ],
    [
      'a cue inside emphasis',
      `${FM()}# s\n\na: **:cue[크게]{zoom=2}** 보세요.\n`,
      /not read in this place/,
    ],
    [
      'a directive inside a list',
      `${FM()}# s\n\na: 안녕.\n\n:::bullets\n- :cue[하나]{zoom=2}\n:::\n`,
      /not read in this place/,
    ],
    [
      'a block directive used inline',
      `${FM()}# s\n\na: 안녕 :image{src=a.png} 하세요.\n`,
      /image must be written as ::image/,
    ],
    ['a value on :only', `${FM()}# s\n\na: :only{youtube=x}안녕.\n`, /takes no value/],
    [
      'a cue in a table cell',
      `${FM()}# s\n\na: 안녕.\n\n:::table\n| a | b |\n|---|---|\n| :cue[x]{zoom=2} | 2 |\n:::\n`,
      /table cell/,
    ],
    [
      'a directive in an image caption',
      `${FM()}# s\n\na: 안녕.\n\n:::gallery\n![비율 a:b](x.png)\n![y](y.png)\n:::\n`,
      /image caption/,
    ],
    ['a speaker shorthand with attributes', `${FM()}# s\n\na:Today{y=1} 안녕.\n`, /loses its/],
    ['a heading below level 1', `${FM()}# s\n\na: 안녕.\n\n## 소제목\n`, /heading-depth/],
    ['a list outside a directive', `${FM()}# s\n\na: 안녕.\n\n- 항목\n`, /unsupported-block/],
    [
      'a pipe table outside :::table',
      `${FM()}# s\n\na: 안녕.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`,
      /inside :::table/,
    ],
    [
      'cue attributes that did not parse',
      `${FM()}# s\n\na: :cue[버튼]{x=0.5 mark="circle} 누르세요.\n`,
      /did not parse/,
    ],
    [
      'attributes after a space',
      `${FM()}# s\n\na: :cue[버튼]{x=0.5} {mark=box} 누르세요.\n`,
      /did not parse|not key=value|read aloud/,
    ],
    [
      'a broken block directive',
      `${FM()}# s\n\na: 안녕.\n\n::image{src=a.png kenburns=off }x\n`,
      /block directive/,
    ],
    [
      'a misspelled speaker with attributes',
      `${FM()}# s\n\naa{face=happy}: 안녕.\n`,
      /"aa" is not in cast/,
    ],
    [
      'a speaker prefix with a space before the colon',
      `${FM()}# s\n\na{face=happy} : 안녕.\n`,
      /read aloud/,
    ],
    [
      'a speaker prefix with a space before the brace',
      `${FM()}# s\n\na {face=happy}: 안녕.\n`,
      /read aloud/,
    ],
    [
      'a speaker prefix without its closing brace',
      `${FM()}# s\n\na{face=happy: 안녕.\n`,
      /read aloud/,
    ],
    [
      'a speaker prefix with a full-width colon',
      `${FM()}# s\n\na{face=happy}：안녕.\n`,
      /read aloud/,
    ],
    ['a misspelled speaker', `${FM()}# s\n\nA: 안녕.\n`, /differs from a cast name only in case/],
    ['a one-line pipe table', `${FM()}# s\n\na: 안녕.\n\n| a | b |\n`, /inside :::table/],
    ['an image on its own line', `${FM()}# s\n\na: 안녕.\n\n![x](a.png)\n`, /::image/],
    ['HTML', `${FM()}# s\n\na: 안녕.\n\n<div>x</div>\n`, /HTML/],
    [
      'a quote inside :::markdown',
      `${FM()}# s\n\na: 안녕.\n\n:::markdown\n> 인용\n:::\n`,
      /does not show a blockquote/,
    ],
    [
      'a paragraph inside :::bullets',
      `${FM()}# s\n\na: 안녕.\n\n:::bullets\n설명\n\n- 하나\n:::\n`,
      /does not show a paragraph/,
    ],
    [
      'a hex number attribute',
      `${FM()}# s\n\na: :cue[여기]{x=0x0}보세요.\n`,
      /x=0x0 is not a number/,
    ],
    [
      'a speaker named like a built-in',
      `${FM()}# s\n\nconstructor: 안녕.\n`,
      /"constructor" is not in cast/,
    ],
    [
      'a number attribute that is not a number',
      `${FM()}# s\n\na: 안녕.\n\n::video{src=v.mp4 start=abc}\n`,
      /start=abc is not a number/,
    ],
  ])('refuses %s', (_, script, message) => {
    expect(errorsOf(script)).toMatch(message);
  });

  it('refuses a reaction with no word after it', () => {
    expect(errorsOf(`${FM()}# s\n\na: 안녕. :react{b=happy}\n`)).toMatch(/no word to start from/);
  });

  it('reads quoted code with braces, and names that are only near a cast name', () => {
    expect(errorsOf(`${FM()}# s\n\na: 코드는 \`{x=1}\` 처럼 씁니다.\n`)).toBe('');
    expect(errorsOf(`${FM()}# s\n\nAb: 그냥 문장이에요.\n`)).toBe('');
  });

  it('accepts ordinary narration with braces and colons', () => {
    expect(errorsOf(`${FM()}# s\n\na: 집합 {1, 2} 이고, Note: 괄호 {about} 는 괜찮아요.\n`)).toBe(
      '',
    );
  });

  it('accepts key:value text in table cells', () => {
    expect(
      errorsOf(
        `${FM()}# s\n\na: 안녕.\n\n:::table\n| key | v |\n|---|---|\n| ratio:wide | 2 |\n:::\n`,
      ),
    ).toBe('');
  });
});

// each case runs the CLI several times: slow when the whole suite runs side by side
describe('inspect: hashes', { timeout: 30_000 }, () => {
  const base = ok(FM() + BODY, { 'a.png': 'A' });
  const h = base.hashes;

  it('is deterministic', () => {
    const again = ok(FM() + BODY, { 'a.png': 'A' });
    expect({ ...again, script: '' }).toEqual({ ...base, script: '' });
  });

  it('separates content, voice and presentation', () => {
    // a visual block: content and presentation change, voice does not
    const more = ok(FM() + BODY + '\n::title[끝]\n', { 'a.png': 'A' }).hashes;
    expect(more.voice).toBe(h.voice);
    expect(more.content).not.toBe(h.content);
    expect(more.presentation_by_output.youtube).not.toBe(h.presentation_by_output.youtube);
    // a word: content and voice, not presentation (no cue) — with rhythm off; with rhythm on
    // (the default) the first words of a paragraph seed its gap's jitter, so they move it too
    const off = FM('acting: { rhythm: false }\n');
    const plain = ok(off + BODY, { 'a.png': 'A' }).hashes;
    const word = ok(off + BODY.replace('대답합니다', '답합니다'), { 'a.png': 'A' }).hashes;
    expect(word.content).not.toBe(plain.content);
    expect(word.voice).not.toBe(plain.voice);
    expect(word.presentation_by_output.youtube).toBe(plain.presentation_by_output.youtube);
    // the pronunciation dictionary: voice only
    const said = ok(FM('pronounce:\n  문장: 뮨장\n') + BODY, { 'a.png': 'A' }).hashes;
    expect(said.voice).not.toBe(h.voice);
    expect(said.content).toBe(h.content);
    // an image file: presentation only
    const img = ok(FM() + BODY, { 'a.png': 'B' }).hashes;
    expect(img.presentation_by_output.youtube).not.toBe(h.presentation_by_output.youtube);
    expect([img.content, img.voice]).toEqual([h.content, h.voice]);
  });

  it('hashes power of an emotion line into the voice (it picks a take, stage 3)', () => {
    const v = (line: string) =>
      ok(FM() + BODY.replace('a: 첫 문장입니다.', line), { 'a.png': 'A' }).hashes.voice;
    const sad = v('a{emo=sad}: 첫 문장입니다.');
    expect(v('a{emo=sad power=strong}: 첫 문장입니다.')).not.toBe(sad);
    // no effect on a line that is not an emotion line: no change
    expect(v('a{emo=neutral power=strong}: 첫 문장입니다.')).toBe(
      v('a{emo=neutral}: 첫 문장입니다.'),
    );
  });

  it('keeps hashes when defaults are written out', () => {
    const explicit = ok(
      FM(
        'outputs:\n  youtube: { aspect: "16:9", layout: presenter }\npacing: { sentenceGap: 0.3, maxPause: 0.35 }\ntheme: { base: light }\nsfx: "off"\n',
      ).replace(/qwen:Sohee" }/g, 'qwen:Sohee", speed: 1, face: neutral }') + BODY,
      { 'a.png': 'A' },
    ).hashes;
    expect(explicit.content).toBe(h.content);
    expect(explicit.voice).toBe(h.voice);
    expect(explicit.presentation_by_output).toEqual(h.presentation_by_output);
  });

  it('keeps one output when another is added or changed', () => {
    const two = (shorts: string, img: string) =>
      ok(
        FM(
          `outputs:\n  youtube: { aspect: "16:9", scenes: [one] }\n  shorts: { aspect: "9:16", layout: shorts, scenes: [two] }\n`,
        ) +
          BODY +
          `\n# 둘 {#two}\n\na: 세로입니다.\n\n::image{src=${shorts}}\n`,
        { 'a.png': 'A', 'v.png': img },
      ).hashes.presentation_by_output;
    const a = two('v.png', 'V1');
    expect(two('v.png', 'V2').youtube).toBe(a.youtube);
    expect(two('v.png', 'V2').shorts).not.toBe(a.shorts);
    const one = ok(
      FM(`outputs:\n  youtube: { aspect: "16:9", scenes: [one] }\n`) +
        BODY +
        `\n# 둘 {#two}\n\na: 세로입니다.\n\n::image{src=v.png}\n`,
      { 'a.png': 'A', 'v.png': 'V1' },
    ).hashes.presentation_by_output;
    expect(one.youtube).toBe(a.youtube);
  });

  it('sees a file renamed even when its bytes are the same', () => {
    const renamed = ok(FM() + BODY.replace('a.png', 'b.png'), { 'b.png': 'A' }).hashes;
    expect(renamed.presentation_by_output.youtube).not.toBe(h.presentation_by_output.youtube);
  });

  it('hashes the transition an output really uses', () => {
    const t = (top: string) =>
      ok(
        FM(`transition: ${top}\noutputs:\n  youtube: { aspect: "16:9", transition: none }\n`) +
          BODY,
        {
          'a.png': 'A',
        },
      ).hashes.presentation_by_output.youtube;
    expect(t('fade')).toBe(t('none'));
  });

  it('treats bgm and logo written as a path like the object form', () => {
    const files = { 'a.png': 'A', 'm.mp3': 'M', 'l.png': 'L' };
    const short = ok(FM('bgm: m.mp3\nlogo: l.png\n') + BODY, files).hashes;
    const long = ok(
      FM(
        'bgm: { src: m.mp3, level: -30, duck: true }\nlogo: { src: l.png, position: top-right }\n',
      ) + BODY,
      files,
    ).hashes;
    expect(long.presentation_by_output).toEqual(short.presentation_by_output);
    expect(long.content).toBe(short.content);
  });

  it('puts the thumbnail into 16:9 outputs only', () => {
    const thumb = (bytes: string) =>
      ok(
        FM(`outputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16" }\n`) +
          BODY +
          '\n::thumbnail{src=t.png}\n',
        { 'a.png': 'A', 't.png': bytes },
      ).hashes.presentation_by_output;
    expect(thumb('T2').youtube).not.toBe(thumb('T1').youtube);
    expect(thumb('T2').shorts).toBe(thumb('T1').shorts);
  });

  it('follows the subtitle font an output really uses', () => {
    const fonts = { 'a.png': 'A', 'f.ttf': 'F' };
    const out = (shortsStyle: string) =>
      ok(
        FM(
          `subtitleStyle: { font: f.ttf }\noutputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16"${shortsStyle} }\n`,
        ) + BODY,
        fonts,
      ).hashes.presentation_by_output;
    const reset = out(', subtitleStyle: { font: null }');
    const inherit = out('');
    expect(reset.shorts).not.toBe(inherit.shorts);
    expect(reset.youtube).toBe(inherit.youtube);
  });

  it('sees cast order (default colors and sides follow it)', () => {
    const swapped = ok(
      `---\nlang: ko\ncast:\n  b: { voice: "qwen:Sohee" }\n  a: { voice: "qwen:Sohee" }\n---\n` +
        BODY,
      { 'a.png': 'A' },
    ).hashes;
    expect(swapped.presentation_by_output.youtube).not.toBe(h.presentation_by_output.youtube);
  });

  it('sees markdown structure and block boundaries', () => {
    const md = (body: string) => ok(`${FM()}# s\n\na: 안녕.\n\n${body}`).hashes.content;
    expect(md(':::markdown\n## 제목\n:::\n')).not.toBe(md(':::markdown\n제목\n:::\n'));
    expect(md(':::markdown\n**굵게**\n:::\n')).not.toBe(md(':::markdown\n굵게\n:::\n'));
    const lists = (a: string, b: string) => md(`:::bullets\n${a}\n:::\n\n:::bullets\n${b}\n:::\n`);
    expect(lists('- 하나\n- 둘', '- 셋')).not.toBe(lists('- 하나', '- 둘\n- 셋'));
  });

  it('gives null hashes with reasons instead of guessing', () => {
    const r = ok(`${FM()}# s\n\na: 안녕.\n\n::image{src=gone.png}\n`);
    expect(r.hashes.presentation_by_output.youtube).toBeNull();
    expect(r.reasons['presentation.youtube']!.join()).toMatch(/gone\.png/);
    expect(r.hashes.audio).toBeNull();
    expect(r.reasons.audio!.join()).toMatch(/not synthesized/);
    const persona = ok(
      `---\nlang: ko\ncast:\n  a: { voice: "persona:nobody" }\n---\n# s\n\na: 안녕.\n`,
    );
    expect([persona.hashes.voice, persona.hashes.audio]).toEqual([null, null]);
    expect(persona.reasons.voice!.join()).toMatch(/not found/);
  });

  it('hashes a recording by its bytes', () => {
    const rec = (bytes: string) =>
      ok(`${FM()}# s\n\na: :audio{src=r.wav}안녕.\n`, { 'r.wav': bytes }).hashes.voice;
    expect(rec('one')).not.toBe(rec('two'));
  });

  it('reads CRLF scripts like LF scripts', () => {
    const crlf = ok((FM() + BODY).replace(/\n/g, '\r\n'), { 'a.png': 'A' }).hashes;
    expect(crlf.content).toBe(h.content);
    expect(crlf.presentation_by_output).toEqual(h.presentation_by_output);
  });
});

describe('inspect: committed samples', { timeout: 30_000 }, () => {
  it('keeps the voice hash under S2V_TTS=mock (persona clips still count)', () => {
    const path = join(ROOT, 'videos/sample-dialogue-ko/script.ko.md');
    const real = inspectScript(path, ROOT);
    process.env.S2V_TTS = 'mock';
    const mock = inspectScript(path, ROOT);
    delete process.env.S2V_TTS;
    if ('errors' in real || 'errors' in mock) throw new Error('rejected');
    expect(mock.result.hashes.voice).toBe(real.result.hashes.voice);
    expect(mock.result.files).toEqual(real.result.files);
  });

  it('has no audio hash once a sentence changes, until tts runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-inspect-sample-'));
    cpSync(join(ROOT, 'videos/sample-en'), dir, { recursive: true });
    const path = join(dir, 'script.en.md');
    const before = inspectScript(path, ROOT);
    writeFileSync(path, readFileSync(path, 'utf8').replace('slowest part', 'slowest step'));
    const after = inspectScript(path, ROOT);
    if ('errors' in before || 'errors' in after) throw new Error('rejected');
    expect(before.result.hashes.audio).not.toBeNull();
    expect(after.result.hashes.audio).toBeNull();
    expect(after.result.reasons.audio!.join()).toMatch(/1 sentence\(s\) not synthesized/);
  });

  it('finds the same speakers as the renderer (castOptions)', () => {
    for (const rel of ['videos/sample-ko/script.ko.md', 'videos/sample-dialogue-ko/script.ko.md']) {
      const path = join(ROOT, rel);
      const script = parseScript(readFileSync(path, 'utf8')).script!;
      for (const output of Object.keys(script.meta.outputs)) {
        const { timeline } = buildTimeline(
          script,
          output,
          loadAudioManifest(path, script.meta.lang),
        );
        const speaking = castsIn(outputScenes(script, output));
        expect(castOptions(script, timeline).map((c) => c.key)).toEqual(
          Object.keys(script.meta.cast).filter((k) => speaking.has(k)),
        );
      }
    }
  });

  it('rhythm (5d): off written out keeps the hash; on adds its gaps, emotions included', () => {
    const body = '\n# 하나 {#one}\n\na: 어디 가요?\n\nb: 시장에 가요.\n';
    const out = (extra: string) =>
      ok(FM(`outputs:\n  youtube: { aspect: "16:9"${extra} }\n`) + body).hashes
        .presentation_by_output.youtube;
    // on by default: writing true changes nothing, off drops the gaps
    const on = out('');
    expect(out(', rhythm: true')).toBe(on);
    expect(out(', rhythm: false')).not.toBe(on);
    // factors written out at their defaults change nothing; other factors do
    expect(out(', rhythm: { answer: 0.6, jitter: 0.12 }')).toBe(on);
    expect(out(', rhythm: { answer: 0.8 }')).not.toBe(on);
    const sad = ok(
      FM('outputs:\n  youtube: { aspect: "16:9", rhythm: true }\n') +
        body.replace('b: 시장', 'b{emo=sad}: 시장'),
    ).hashes.presentation_by_output.youtube;
    expect(sad).not.toBe(on);
  });

  it('takes --rhythm only where a timeline is built', () => {
    const cli = join(ROOT, 'packages/cli/dist/main.js');
    const status = (args: string[]) => {
      try {
        execFileSync('node', [cli, ...args], { cwd: ROOT, stdio: 'pipe' });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(status(['lint', 'videos/sample-ko/script.ko.md', '--rhythm', 'on'])).not.toBe(0);
    expect(status(['dev', 'videos/sample-ko/script.ko.md', '--rhythm', 'on'])).not.toBe(0);
    expect(
      status(['inspect', 'videos/sample-ko/script.ko.md', '--json', '--rhythm', 'on']),
    ).not.toBe(0);
    expect(status(['timeline', 'videos/sample-ko/script.ko.md', '--rhythm', 'maybe'])).not.toBe(0);
    expect(status(['timeline', 'videos/sample-ko/script.ko.md', '--rhythm', 'on'])).toBe(0);
  });

  it('exits 2 on usage errors', () => {
    const cli = join(ROOT, 'packages/cli/dist/main.js');
    for (const args of [['--draft=false'], ['-o', 'x'], ['--hash-version'], ['--fps', '30']]) {
      let status = 0;
      try {
        execFileSync('node', [cli, 'inspect', 'videos/sample-ko/script.ko.md', '--json', ...args], {
          cwd: ROOT,
          stdio: 'pipe',
        });
      } catch (e) {
        status = (e as { status: number }).status;
      }
      expect(status, args.join(' ')).toBe(2);
    }
  });

  it('prints the same bytes every time', () => {
    const cli = join(ROOT, 'packages/cli/dist/main.js');
    const runCli = () =>
      execFileSync('node', [cli, 'inspect', 'videos/sample-ko/script.ko.md', '--json'], {
        cwd: ROOT,
        env: { ...process.env, S2V_TTS: '' },
      });
    const a = runCli();
    expect(runCli().equals(a)).toBe(true);
    expect(JSON.parse(a.toString()).script).toBe('videos/sample-ko/script.ko.md');
    // the version a tool pins (S3), and whether this checkout's build is current
    const r = JSON.parse(a.toString()) as InspectResult;
    expect(r.s2v_version).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(typeof r.stale_build).toBe('boolean');
  });

  // Golden values: a change here means the hash formula, the parser or the schema output changed.
  // If that is intended, bump the hash version and update the values.
  const GOLDEN: Record<string, Partial<InspectResult['hashes']>> = {
    'videos/sample-ko/script.ko.md': {
      content: '90d8efa61ebad2a5ccc767df4ad5cecf343b1ee4beaec5acbcebbe7058f64f62',
      voice: '2541d5db1861841aa27970c2c8beab4ca9a9d9df3c5a355e16c6bab11b5f87ff',
      audio: '125d2a1c3ced53be003433775779ad30a9d3a5cb54a6f11ac0d9a185cb9075e0',
      presentation_by_output: {
        youtube: '8731a38d81018f5183ba1a95206ae4b65316fb887a0d26a1fee475af6d6d78e8',
        shorts: '1c6ca858b8699baadc464040fabc65d58c2b5a87ba521c90fba47a554d2dea8e',
      },
    },
    'videos/sample-en/script.en.md': {
      content: 'e841a719c39af0f63382e33e1b63f099c329b89e18547ecf76caf83e38a6685b',
      voice: 'e5bba9ade9e6f6386c76901b72778da91dbf2fa11d18f49f8f864bc281bf93b2',
      audio: 'dd6297569afe8ede11730310b3162c713a6e95c3ddc2fecd6a423601fb810a81',
      presentation_by_output: {
        youtube: '697f6134e35f7542737aa4c9208695109b5e2225d35043b2880ef2adbd000c97',
        shorts: 'ec27d3ba67feb1ac71a739e9f8e035133714cbc240496dac92fa91b2881c01ae',
      },
    },
    'videos/sample-dialogue-ko/script.ko.md': {
      content: '02eb56d5d3c472e9f4a8c4c9c5acfea52112872f8ce903e01d7982e303044c75',
      voice: '5c6cd01ec8e066eddffc2e64ee832e2998a9fd429c61edb9709c09778f02d335',
      audio: 'd26e098ccacc1323c65a6b565049f4a0d8341f326a53f361180e02264f7b8e55',
      // classic characters, hashed since S4b (null before: no approved value to migrate)
      presentation_by_output: {
        youtube: '742b087fde8d834fcdad754c0fc685f67d3c400b11cb1bb3bec125d5f5b1f368',
        shorts: 'e065d5c7b90758c99931095ef0b8bae25d918d125d8b73c4a980cdc27aab25a5',
      },
    },
  };
  it.each(Object.keys(GOLDEN))('%s', (rel) => {
    const r = inspectScript(join(ROOT, rel), ROOT);
    if ('errors' in r) throw new Error(r.errors.map((e) => e.message).join('\n'));
    const { engine: _e, ...hashes } = r.result.hashes;
    expect(hashes).toEqual(GOLDEN[rel]);
  });
});

describe('inspect: acting (stage 2)', () => {
  const S = (line: string, extra = '') => `${FM(extra)}# s\n\n${line}\n`;

  it('reads say markup as text and knows :emo', () => {
    expect(
      errorsOf(S('a{emo=calm say="a :pause[1] *b*"}: 안녕. :emo{emo=sad speed=0.9}그래.')),
    ).toBe('');
    expect(errorsOf(S('a: 안녕. :emo{emo=sad speed=fast}그래.'))).toMatch(/speed/);
    expect(
      errorsOf(
        S('a{emo=sad}: 안녕.', 'acting:\n  emotions:\n    sleepy: { voice: "x", tone: 1 }\n'),
      ),
    ).toMatch(/acting\.emotions\.sleepy\.tone/);
    expect(
      errorsOf(
        S('a{emo=sleepy}: 안녕.', 'acting:\n  emotions:\n    sleepy: { voice: "x", face: calm }\n'),
      ),
    ).toBe('');
  });

  it('accepts a negative gap', () => {
    expect(errorsOf(S('a{gap=-0.2}: 안녕.'))).toBe('');
  });

  it('changes the voice hash with the emotion, not with the face', () => {
    const base = ok(S('a: 안녕하세요.')).hashes;
    const emo = ok(S('a{emo=sad}: 안녕하세요.')).hashes;
    const face = ok(S('a{face=happy}: 안녕하세요.')).hashes;
    const loud = ok(S('a{volume=loud}: 안녕하세요.')).hashes;
    expect(emo.voice).not.toBe(base.voice);
    expect(face.voice).toBe(base.voice);
    expect(loud.voice).not.toBe(base.voice);
    expect(emo.content).toBe(base.content);
  });

  it('reports the acting tables as an engine part', () => {
    const r = ok(S('a: 안녕.'));
    expect(r.engine).toHaveProperty('templates');
    expect(r.hashes.engine).toHaveProperty('templates');
  });
});

describe('inspect: speakers inside a paragraph', () => {
  it('reports a speaker on a later line of the same paragraph', () => {
    expect(errorsOf(`${FM()}# s\n\na{emo=sad}: 하나\nb{emo=happy}: 둘.\n`)).toMatch(
      /"b:" on a later line/,
    );
    expect(errorsOf(`${FM()}# s\n\na: 하나\nNote: 둘.\n`)).toBe('');
  });
});
