/** `s2v inspect`: the character part of presentation (S4b plan 7.2). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline, parseScript, type AudioManifest } from '@script2video/core';
// not package API: the renderer's public-dir step and its face sets, both from its source (S4b)
import { preparePublicDir, usedFaces } from '../../renderer-remotion/src/prepare.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { castOptions } from '../src/cast.js';
import { enrichCast } from '../src/cast-faces.js';
import { inspectScript, type InspectResult } from '../src/inspect.js';
import { outputUsedFaces } from '../src/lint-assets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

beforeEach(() => {
  delete process.env.S2V_TTS;
});

/** A PNG header of a given size, then `tag` so files with the same size differ in bytes. */
function png(tag: string, w = 40, h = 50): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return Buffer.concat([b, Buffer.from(tag)]);
}

const LAYERED = `source: drawn
license: test
views:
  front: { facing: front, pivot: [20, 30] }
  turn: { facing: right, pivot: [20, 30] }
heads:
  front/glance: { facing: right }
expressions:
  neutral: {}
  happy: { motion: bounce }
  surprised: {}
  viewer: {}
faces:
  neutral: { view: front, expression: neutral }
  happy: { view: front, expression: happy }
  surprised: { view: front, expression: surprised }
  front-neutral: { view: front, expression: viewer }
  gasp: { view: turn, expression: neutral }
sets:
  head:
    views: { front: {} }
    heads: { front/glance: { facing: right } }
    faces: [neutral, happy, gasp]
`;

/** Layered `chars/a`, classic `chars/b`, imported `chars/y`. */
function art(): Record<string, string | Buffer> {
  const f: Record<string, string | Buffer> = { 'chars/a/character.yaml': LAYERED };
  const v = 'chars/a/views';
  f[`${v}/front/body/stand.png`] = png('body');
  f[`${v}/turn/body/stand.png`] = png('turn-body');
  for (const e of ['neutral', 'happy', 'surprised', 'viewer'])
    f[`${v}/front/face/base/${e}/head.png`] = png(`head-${e}`);
  f[`${v}/turn/face/base/neutral/head.png`] = png('turn-head');
  f[`${v}/front/face/base/neutral/mouth.png`] = png('mouth');
  f[`${v}/front/face/base/viewer/mouth.png`] = png('mouth-viewer');
  const hs = 'chars/a/sets/head/views/front/face';
  f[`${hs}/base/neutral/head.png`] = png('h-neutral');
  f[`${hs}/base/happy/head.png`] = png('h-happy');
  f[`${hs}/glance/neutral/head.png`] = png('h-glance');
  for (const n of ['neutral', 'neutral-talk', 'happy', 'surprised'])
    f[`chars/b/${n}.png`] = png(`b-${n}`, 8, 8);
  f['chars/y/character.yaml'] =
    'source: imported\nfaces:\n  neutral: { 体: 体_00, 口: 口_00 }\n  happy: { 口: 口_01 }\n';
  for (const n of ['体/体_00', '口/口_00', '口/口_00.0', '口/口_00.1', '口/口_01'])
    f[`chars/y/views/main/${n}.png`] = png(n, 8, 2);
  return f;
}

const FM = (
  cast: string,
  outputs = '  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16" }\n',
) => `---\nlang: ko\ncast:\n${cast}outputs:\n${outputs}---\n`;
const PAIR =
  '  a: { voice: "qwen:Sohee", character: chars/a }\n  b: { voice: "qwen:Sohee", character: chars/b }\n';
const BODY = '# 하나 {#one}\n\na: 첫 문장입니다. 둘째 문장이에요.\n\nb: 대답합니다.\n';

function folder(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 's2v-inspect-ch-'));
  for (const [p, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), data);
  }
  return dir;
}
function inspectIn(dir: string, script: string): InspectResult {
  writeFileSync(join(dir, 'script.ko.md'), script);
  const r = inspectScript(join(dir, 'script.ko.md'), ROOT);
  if ('errors' in r) throw new Error(r.errors.map((e) => e.message).join('\n'));
  return r.result;
}
const ok = (script: string, files: Record<string, string | Buffer> = art()) =>
  inspectIn(folder(files), script);
const pres = (r: InspectResult) => r.hashes.presentation_by_output;
const GOLDEN = {
  youtube: '592209d3c6cd13f929f9cd17b45fc9a39f3c00499570d2c41ce885bf027531f5',
  shorts: '6f2a0e06b0146ec47c5579e1b9ee7de67e5110d75f067a1ba20ba1088566e62f',
};

describe('inspect: characters (S4b)', () => {
  it('hashes character outputs, lists the art and the sides', () => {
    const r = ok(FM(PAIR) + BODY);
    expect(pres(r).youtube).toMatch(/^[0-9a-f]{64}$/);
    expect(pres(r).shorts).toMatch(/^[0-9a-f]{64}$/);
    expect(r.reasons).not.toHaveProperty('presentation.youtube');
    expect(r.files.filter((f) => f.kind === 'character').map((f) => f.path)).toContain(
      'chars/a/views/front/face/base/neutral/head.png',
    );
    expect(r.faces.find((f) => f.cast === 'b')?.side).toBe('right');
    expect(r.faces.find((f) => f.cast === 'a')?.side).toBe('left');
  });

  it('I2: :look alone changes the character output, not content or voice', () => {
    const a = ok(FM(PAIR) + BODY);
    const b = ok(FM(PAIR) + BODY.replace('둘째', ':look{b=viewer}둘째'));
    expect(pres(b).youtube).not.toBe(pres(a).youtube);
    expect([b.hashes.content, b.hashes.voice]).toEqual([a.hashes.content, a.hashes.voice]);
    // the speaker's own look (front-neutral exists): its shown face changes too
    const c = ok(FM(PAIR) + BODY.replace('둘째', ':look{a=viewer}둘째'));
    expect(pres(c).youtube).not.toBe(pres(a).youtube);
  });

  it('I2b: moving a :look inside its sentence changes only presentation', () => {
    const a = ok(FM(PAIR) + BODY.replace('둘째 문장', ':look{b=viewer}둘째 문장'));
    const b = ok(FM(PAIR) + BODY.replace('둘째 문장', '둘째 :look{b=viewer}문장'));
    expect(pres(b).youtube).not.toBe(pres(a).youtube);
    expect([b.hashes.content, b.hashes.voice]).toEqual([a.hashes.content, a.hashes.voice]);
  });

  it('golden: a character fixture (emotions, looks, reactions, close-up)', () => {
    // Speaker faces (acting) and listener look faces (listen) follow from the looks, reactions
    // and art also hashed, so no single edit isolates them: this value guards their presence.
    const r = ok(
      FM(PAIR) +
        '# 하나 {#one}\n\na{emo=happy}: 기뻐요 :look{b=viewer}정말. :look{a=viewer}네.\n\n' +
        'b: :look{a=viewer}어 :react{a=surprised}그 :look{a=glance}래요.\n\n# 둘 {#two}\n\n' +
        '::shot{a=head}\n\na{face=gasp}: 돌아봅니다.\n\nb: 네 :react{a=happy}요.\n',
    );
    expect(pres(r)).toEqual(GOLDEN);
  });

  it('I3: :look in a script without characters changes nothing', () => {
    const cast = '  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Sohee" }\n';
    const a = ok(FM(cast) + BODY, {});
    const b = ok(FM(cast) + BODY.replace('둘째', ':look{b=viewer}둘째'), {});
    expect(pres(b)).toEqual(pres(a));
  });

  it('I4 / I5 / I5b: outputs keep their own hashes, in either order', () => {
    const only = `${BODY}\nb{face=surprised}: :only{shorts}세로에서만.\n`;
    for (const outputs of [
      '  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16" }\n',
      '  shorts: { aspect: "9:16" }\n  youtube: { aspect: "16:9" }\n',
    ]) {
      const dir = folder(art());
      const before = inspectIn(dir, FM(PAIR, outputs) + only);
      writeFileSync(join(dir, 'chars/b/surprised.png'), png('changed', 8, 8));
      const after = inspectIn(dir, FM(PAIR, outputs) + only);
      expect(pres(after).youtube).toBe(pres(before).youtube);
      expect(pres(after).shorts).not.toBe(pres(before).shorts);
    }
    const both = ok(FM(PAIR) + BODY);
    const one = ok(FM(PAIR, '  youtube: { aspect: "16:9" }\n') + BODY);
    expect(pres(one).youtube).toBe(pres(both).youtube);
  });

  it('I5b: a side that differs per output does not leak between outputs', () => {
    const cast = `${PAIR}  c: { voice: "qwen:Sohee", character: chars/b }\n`;
    // shorts has only b (left there), youtube has a and b (b right)
    const script = `${FM(cast)}# 하나 {#one}\n\na: :only{youtube}가로.\n\nb: 둘 다.\n`;
    const dir = folder(art());
    const r1 = inspectIn(dir, script);
    const r2 = inspectIn(
      dir,
      script.replace(
        'youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16" }',
        'shorts: { aspect: "9:16" }\n  youtube: { aspect: "16:9" }',
      ),
    );
    expect(pres(r2)).toEqual(pres(r1));
    expect(r1.faces.filter((f) => f.cast === 'b').map((f) => `${f.output}:${f.side}`)).toEqual(
      expect.arrayContaining(['youtube:right', 'shorts:left']),
    );
  });

  it('I6 / I7: used art counts, unused art does not, optional parts do', () => {
    const dir = folder(art());
    const base = inspectIn(dir, FM(PAIR) + BODY);
    writeFileSync(join(dir, 'chars/a/views/front/face/base/surprised/head.png'), png('x'));
    writeFileSync(join(dir, 'chars/b/happy.png'), png('x', 8, 8));
    expect(pres(inspectIn(dir, FM(PAIR) + BODY))).toEqual(pres(base));
    writeFileSync(join(dir, 'chars/a/views/front/face/base/neutral/head.png'), png('y'));
    const used = inspectIn(dir, FM(PAIR) + BODY);
    expect(pres(used).youtube).not.toBe(pres(base).youtube);
    writeFileSync(join(dir, 'chars/a/views/front/face/base/neutral/mouth.1.png'), png('half'));
    expect(pres(inspectIn(dir, FM(PAIR) + BODY)).youtube).not.toBe(pres(used).youtube);
    const used2 = inspectIn(dir, FM(PAIR) + BODY);
    writeFileSync(join(dir, 'chars/b/neutral-half.png'), png('half', 8, 8));
    expect(pres(inspectIn(dir, FM(PAIR) + BODY)).youtube).not.toBe(pres(used2).youtube);
  });

  it('I8: a missing layer is a null with the file, and the renderer stops on the same file', () => {
    const files = art();
    delete files['chars/a/views/front/face/base/neutral/head.png'];
    const dir = folder(files);
    const r = inspectIn(dir, FM(PAIR) + BODY);
    expect(pres(r).youtube).toBeNull();
    expect(r.reasons['presentation.youtube']!.join()).toContain(
      'character a (chars/a): head image missing: views/front/face/base/neutral/head.png',
    );
    const path = join(dir, 'script.ko.md');
    const script = parseScript(FM(PAIR) + BODY).script!;
    enrichCast(script, dir);
    const timeline = fakeTimeline(script, 'youtube');
    const fonts = join(dir, 'fonts');
    mkdirSync(fonts);
    for (const f of [
      'NotoSansKR-Variable.ttf',
      'NotoSansJP-Variable.ttf',
      'JetBrainsMono-Variable.ttf',
    ])
      writeFileSync(join(fonts, f), '');
    expect(() =>
      preparePublicDir({
        timeline,
        aspect: '16:9',
        assetsRoot: dirname(path),
        fontsDir: fonts,
        workDir: join(dir, 'work'),
        cast: castOptions(script, timeline),
      }),
    ).toThrow(/head image missing: .*views\/front\/face\/base\/neutral\/head\.png/);
  });

  it('I8b: a default face the close-up set lacks names the framing and the side', () => {
    const cast = PAIR.replace('character: chars/a }', 'character: chars/a, face: surprised }');
    const r = ok(FM(cast) + '# 하나 {#one}\n\n::shot{a=head}\n\na: 안녕.\n\nb: 네.\n');
    expect(pres(r).youtube).toBeNull();
    expect(r.reasons['presentation.youtube']!.join()).toContain(
      'character a (chars/a): face "surprised" is not in sets.head.faces (head, left)',
    );
  });

  it('I9: facing counts for classic art only; folder name and sides count', () => {
    const dir = folder(art());
    const base = inspectIn(dir, FM(PAIR) + BODY);
    const facing = (s: string) =>
      s.replace('character: chars/b }', 'character: { dir: chars/b, facing: left } }');
    expect(pres(inspectIn(dir, facing(FM(PAIR)) + BODY)).youtube).not.toBe(pres(base).youtube);
    const layeredFacing = FM(PAIR).replace(
      'character: chars/a }',
      'character: { dir: chars/a, facing: left } }',
    );
    expect(pres(inspectIn(dir, layeredFacing + BODY)).youtube).toBe(pres(base).youtube);
    expect(
      pres(
        inspectIn(
          dir,
          FM(PAIR)
            .replace('chars/a }', 'chars/a, side: right }')
            .replace('chars/b }', 'chars/b, side: left }') + BODY,
        ),
      ).youtube,
    ).not.toBe(pres(base).youtube);
    renameSync(join(dir, 'chars/b'), join(dir, 'chars/b2'));
    expect(
      pres(inspectIn(dir, FM(PAIR).replace('chars/b }', 'chars/b2 }') + BODY)).youtube,
    ).not.toBe(pres(base).youtube);
  });

  it('I9b: a mixed output draws no characters but still needs the art', () => {
    const cast = '  a: { voice: "qwen:Sohee", character: chars/a }\n  b: { voice: "qwen:Sohee" }\n';
    const dir = folder(art());
    const base = inspectIn(dir, FM(cast) + BODY);
    expect(pres(base).youtube).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, 'chars/a/views/front/face/base/neutral/head.png'), png('z'));
    expect(pres(inspectIn(dir, FM(cast) + BODY))).toEqual(pres(base));
    rmSync(join(dir, 'chars/a/views/front/face/base/neutral/head.png'));
    expect(pres(inspectIn(dir, FM(cast) + BODY)).youtube).toBeNull();
  });

  it('I10: the motion of a used face counts, the license does not', () => {
    const dir = folder(art());
    const script = FM(PAIR) + BODY.replace('a: 첫', 'a{face=happy}: 첫');
    const base = inspectIn(dir, script);
    writeFileSync(
      join(dir, 'chars/a/character.yaml'),
      LAYERED.replace('license: test', 'license: other'),
    );
    expect(pres(inspectIn(dir, script))).toEqual(pres(base));
    writeFileSync(
      join(dir, 'chars/a/character.yaml'),
      LAYERED.replace('happy: { motion: bounce }', 'happy: { motion: nod }'),
    );
    expect(pres(inspectIn(dir, script)).youtube).not.toBe(pres(base).youtube);
  });

  it("I10b: a face motion only the speaker's look variant hides still counts (acting)", () => {
    // a{face=happy} with :look{a=viewer} shows front-happy: happy is not drawn, so its motion is
    // not in `motions` and the paragraph has no emotion (no S4a runs) — only acting.runs has it
    const yaml = LAYERED.replace('  viewer: {}\n', '  viewer: {}\n  vhappy: {}\n').replace(
      '  gasp: { view: turn',
      '  front-happy: { view: front, expression: vhappy }\n  gasp: { view: turn',
    );
    const files = art();
    files['chars/a/character.yaml'] = yaml;
    files['chars/a/views/front/face/base/vhappy/head.png'] = png('vhappy');
    files['chars/a/views/front/face/base/vhappy/mouth.png'] = png('vhappy-mouth');
    const dir = folder(files);
    const script = FM(PAIR) + '# 하나 {#one}\n\na{face=happy}: :look{a=viewer}좋아요.\n\nb: 네.\n';
    const base = inspectIn(dir, script);
    expect(base.faces.some((f) => f.cast === 'a' && f.face === 'front-happy')).toBe(true);
    writeFileSync(
      join(dir, 'chars/a/character.yaml'),
      yaml.replace('happy: { motion: bounce }', 'happy: { motion: shake }'),
    );
    expect(pres(inspectIn(dir, script)).youtube).not.toBe(pres(base).youtube);
  });

  it('I11: a turned face in the head close-up hashes the turned head', () => {
    const dir = folder(art());
    const script =
      FM(PAIR) + '# 하나 {#one}\n\n::shot{a=head}\n\na{face=gasp}: 돌아봅니다.\n\nb: 네.\n';
    const base = inspectIn(dir, script);
    expect(pres(base).youtube).not.toBeNull();
    writeFileSync(
      join(dir, 'chars/a/sets/head/views/front/face/glance/neutral/head.png'),
      png('g2'),
    );
    expect(pres(inspectIn(dir, script)).youtube).not.toBe(pres(base).youtube);
  });

  it('I12: imported parts borrowed from neutral count; other framings are null', () => {
    const cast =
      '  a: { voice: "qwen:Sohee", character: chars/y }\n  b: { voice: "qwen:Sohee", character: chars/b }\n';
    const script = FM(cast) + BODY.replace('a: 첫', 'a{face=happy}: 첫');
    const dir = folder(art());
    const base = inspectIn(dir, script);
    expect(pres(base).youtube).not.toBeNull();
    writeFileSync(join(dir, 'chars/y/views/main/体/体_00.png'), png('body2', 8, 2));
    expect(pres(inspectIn(dir, script)).youtube).not.toBe(pres(base).youtube);
    const upper = inspectIn(
      dir,
      script.replace('# 하나 {#one}\n', '# 하나 {#one}\n\n::shot{a=upper}\n'),
    );
    expect(pres(upper).youtube).toBeNull();
    expect(upper.reasons['presentation.youtube']!.join()).toMatch(/only the full framing/);
  });

  it('I13: no ffmpeg needed (only engine.ffmpeg is null)', () => {
    const dir = folder(art());
    writeFileSync(join(dir, 'script.ko.md'), FM(PAIR) + BODY);
    const cli = join(ROOT, 'packages/cli/dist/main.js');
    const run = (env: NodeJS.ProcessEnv) =>
      JSON.parse(
        execFileSync(process.execPath, [cli, 'inspect', join(dir, 'script.ko.md'), '--json'], {
          cwd: ROOT,
          env: { ...env, S2V_TTS: '' },
        }).toString(),
      ) as InspectResult;
    const withFfmpeg = run(process.env);
    const without = run({ ...process.env, PATH: '/nonexistent' });
    expect(without.hashes.presentation_by_output).toEqual(withFfmpeg.hashes.presentation_by_output);
    expect(without.engine.ffmpeg).toBeNull();
  });

  it('I14: inspect faces hold every face the renderer composes', () => {
    const script = parseScript(
      FM(PAIR) +
        '# 하나 {#one}\n\na{emo=happy}: 기뻐요 :look{b=viewer}정말. 네.\n\n' +
        'b: :look{a=viewer}어 :react{a=surprised}그 :look{a=glance}래요.\n\n# 둘 {#two}\n\n::shot{a=head}\n\n' +
        // a reaction without a look, in a scene where the reactor (head) and the speaker
        // (full) are framed differently: only this line shows a's happy face in the head set
        'a{face=gasp}: 돌아봅니다.\n\nb: 네 :react{a=happy}요.\n',
    ).script!;
    enrichCast(script, folder(art()));
    for (const output of Object.keys(script.meta.outputs)) {
      const timeline = fakeTimeline(script, output);
      for (const c of ['a', 'b']) {
        const ours = outputUsedFaces(script, output, c);
        for (const [framing, faces] of usedFaces(timeline, c, script.meta.cast[c]!.face))
          for (const f of faces)
            expect(ours.get(framing)?.has(f), `${output} ${c} ${framing} ${f}`).toBe(true);
      }
    }
  });

  it('I16: prints the same bytes every time', () => {
    const dir = folder(art());
    const a = JSON.stringify(inspectIn(dir, FM(PAIR) + BODY));
    expect(JSON.stringify(inspectIn(dir, FM(PAIR) + BODY))).toBe(a);
  });
});

/** A timeline with every sentence one second long (faces do not depend on the audio files). */
function fakeTimeline(
  script: NonNullable<ReturnType<typeof parseScript>['script']>,
  output: string,
) {
  const manifest: AudioManifest = {};
  for (const scene of script.scenes)
    scene.blocks.forEach((b, bi) => {
      if (b.kind !== 'paragraph') return;
      b.sentences.forEach((s, si) => {
        const chars = [...s.text];
        manifest[`${scene.id}:${bi}:${si}`] = {
          src: 'x.wav',
          duration: 1,
          words: chars.map((ch, i) => ({
            text: ch,
            start: i / chars.length,
            end: (i + 1) / chars.length,
          })),
        };
      });
    });
  return buildTimeline(script, output, manifest).timeline;
}
