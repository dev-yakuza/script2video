/** Pictures the renderer cannot read are lint errors (S12 plan). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTimeline,
  logoOf,
  parseScript,
  sentenceId,
  toAlignText,
  type AudioManifest,
  type Script,
} from '@script2video/core';
import { referencedImages, VIDEO_EXT } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { castOptions } from '../src/cast.js';
import {
  lintAssets,
  lintBgm,
  lintCast,
  lintImageFormats,
  renderedImages,
} from '../src/lint-assets.js';
import { mockTokens } from '../src/mock-tts.js';

/** Just enough bytes for the format sniffing. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 48, 8, 6, 0, 0, 0]),
]);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0,
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00');

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 's2v-img-'));
  const files: Record<string, Buffer> = {
    'ok.png': PNG,
    'ok.jpg': JPEG,
    'pic.webp': WEBP,
    'anim.gif': GIF,
    'fake.png': WEBP, // a WebP named .png
    'clip.mp4': Buffer.from('not checked'),
    'CLIP.MP4': Buffer.from('not checked'),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  return dir;
}

const script = (frontmatter: string, body: string): Script => {
  const r = parseScript(`---\nlang: ko\n${frontmatter}---\n\n${body}\n`);
  expect(r.diagnostics.items.filter((d) => d.severity === 'error')).toEqual([]);
  return r.script!;
};
const CAST = 'cast:\n  host: { voice: "qwen:Sohee" }\n';
const formats = (s: Script, dir: string) =>
  lintImageFormats(s, dir).map((d) => `${d.code} ${d.message}${d.line ? ` @${d.line}` : ''}`);

describe('picture formats', () => {
  it('every picture place takes only PNG or JPEG, by its bytes', () => {
    const dir = folder();
    for (const [body, place] of [
      ['::image{src=pic.webp}\n\nhost: 하나.', '::image'],
      ['::image{src=fake.png}\n\nhost: 하나.', '::image'],
      ['::image{src=clip.mp4}\n\nhost: 하나.', '::image'],
      ['::title{label="제목"}\n\nhost: 하나 :cue{show=anim.gif}둘.', 'show='],
      [':::gallery\n![](ok.png)\n![](pic.webp)\n:::\n\nhost: 하나.', ':::gallery'],
      [':::split\n![](fake.png)\n\n본문\n:::\n\nhost: 하나.', ':::split'],
    ] as const) {
      const out = formats(script(CAST, `# 장면 {#a}\n\n${body}`), dir);
      expect(out, body).toHaveLength(1);
      expect(out[0]!.startsWith(`asset-format ${place} `), out[0]).toBe(true);
      expect(out[0], body).toMatch(/must be a PNG or JPEG image: .* @\d+$/);
    }
    const fine = script(
      CAST,
      `# 장면 {#a}\n\n::image{src=ok.png}\n\nhost: 하나 :cue{show=ok.jpg}둘.\n\n::video{src=clip.mp4}\n\nhost: 셋.\n\n::video{src=CLIP.MP4}\n\nhost: 넷.`,
    );
    expect(formats(fine, dir)).toEqual([]);
  });

  it('avatars of the casts on stage and the logo too; ::video needs a video file', () => {
    const dir = folder();
    const s = script(
      'cast:\n  host: { voice: "qwen:Sohee", avatar: pic.webp }\n  quiet: { voice: "qwen:Ryan", avatar: anim.gif }\nlogo: { src: fake.png }\n',
      '# 장면 {#a}\n\n::video{src=anim.gif}\n\nhost: 하나.',
    );
    expect(formats(s, dir)).toEqual([
      'asset-format ::video needs .mp4, .webm, .mov or .m4v: anim.gif @11',
      'asset-format cast.host.avatar must be a PNG or JPEG image: pic.webp',
      'asset-format logo must be a PNG or JPEG image: fake.png',
    ]);
  });

  it('one error per file; a missing show= after a title is reported once', () => {
    const dir = folder();
    const s = script(
      CAST,
      '# 장면 {#a}\n\n::image{src=pic.webp}\n\nhost: 하나.\n\n:::gallery\n![](ok.png)\n![](pic.webp)\n:::\n\nhost: 둘.\n\n# 둘 {#b}\n\n::title{label="x"}\n\nhost: 셋 :cue{show=gone.png}넷.',
    );
    expect(formats(s, dir)).toEqual([
      'asset-format ::image must be a PNG or JPEG image: pic.webp @9',
      'asset-missing image not found: gone.png @24',
    ]);
  });

  it('a file used as a picture and as a clip is checked as both', () => {
    const dir = folder();
    const a = script(
      CAST,
      '# 장면 {#a}\n\n::video{src=clip.mp4}\n\nhost: 하나.\n\n::image{src=clip.mp4}\n\nhost: 둘.',
    );
    expect(formats(a, dir)).toEqual([
      'asset-format ::image must be a PNG or JPEG image: clip.mp4 @13',
    ]);
    const b = script(
      CAST,
      '# 장면 {#a}\n\n::image{src=ok.png}\n\nhost: 하나.\n\n::video{src=ok.png}\n\nhost: 둘.',
    );
    expect(formats(b, dir)).toEqual([
      'asset-format ::video needs .mp4, .webm, .mov or .m4v: ok.png @13',
    ]);
  });

  it('a missing file is reported once by all the asset checks together', () => {
    const dir = folder();
    const all = (s: Script) =>
      [...lintAssets(s, dir), ...lintImageFormats(s, dir)]
        .filter((d) => d.code === 'asset-missing')
        .map((d) => d.message);
    // a show= after a title and the same after an image; a show= before the image it names
    const s = script(
      CAST,
      '# 하나 {#a}\n\n::title{label="x"}\n\nhost: 하나 :cue[하나]{show=gone.png}.\n\n::image{src=ok.png}\n\nhost: 둘 :cue[둘]{show=gone.png}.\n\n# 둘 {#b}\n\n::title{label="y"}\n\nhost: 셋 :cue[셋]{show=late.png}.\n\n::image{src=late.png}\n\nhost: 넷.\n\n# 셋 {#c}\n\n::image{src=nowhere.png}\n\nhost: 다섯.',
    );
    expect(all(s).sort()).toEqual([
      'image not found: gone.png',
      'image not found: late.png',
      'image not found: nowhere.png',
    ]);
  });

  it('the first line in the file, whatever order the outputs come in', () => {
    const dir = folder();
    const s = script(
      `${CAST}outputs:\n  shorts: { aspect: "9:16", layout: shorts, scenes: [b] }\n  youtube: { aspect: "16:9" }\n`,
      '# 하나 {#a}\n\n::image{src=pic.webp}\n\nhost: 하나.\n\n# 둘 {#b}\n\n::image{src=pic.webp}\n\nhost: 둘.',
    );
    expect(formats(s, dir)).toEqual([
      'asset-format ::image must be a PNG or JPEG image: pic.webp @12',
    ]);
  });

  it('a missing avatar or logo is reported once', () => {
    const dir = folder();
    const s = script(
      'cast:\n  host: { voice: "qwen:Sohee", avatar: none.png }\nlogo: { src: nologo.png }\n',
      '# 하나 {#a}\n\nhost: 하나.',
    );
    const missing = [...lintCast(s, dir), ...lintBgm(s, dir), ...lintImageFormats(s, dir)].filter(
      (d) => d.code === 'asset-missing',
    );
    expect(missing).toHaveLength(2);
  });

  it('skips what no render reads: scenes no output picks, lines an output leaves out', () => {
    const dir = folder();
    // youtube shows scene a without the shorts-only line; shorts shows only scene b
    const s = script(
      `${CAST}outputs:\n  youtube: { aspect: "16:9", scenes: [a] }\n  shorts: { aspect: "9:16", layout: shorts, scenes: [b] }\n`,
      '# 장면 {#a}\n\nhost: 하나.\n\nhost: :only{shorts}둘 :cue[둘]{show=pic.webp}.\n\n# 둘 {#b}\n\nhost: 셋.\n\n# 빠짐 {#c}\n\n::image{src=pic.webp}\n\nhost: 넷.',
    );
    expect(formats(s, dir)).toEqual([]);
  });

  it('a character file that is not an image is a diagnostic, not a crash', () => {
    const dir = folder();
    const char = join(dir, 'chars', 'host');
    mkdirSync(char, { recursive: true });
    writeFileSync(join(char, 'neutral.png'), PNG);
    writeFileSync(join(char, 'neutral-talk.png'), WEBP);
    const s = script(
      'cast:\n  host: { voice: "qwen:Sohee", character: chars/host }\n',
      '# 장면 {#a}\n\nhost: 하나.',
    );
    const out = lintCast(s, dir);
    expect(out.map((d) => `${d.code} ${d.message}`)).toContain(
      'asset-format character chars/host: neutral-talk.png must be a PNG or JPEG image',
    );
  });
});

describe('the lint list is what the renderer reads', () => {
  it('the same files as every output’s timeline, avatars and logo', () => {
    const s = script(
      `cast:\n  host: { voice: "qwen:Sohee", avatar: host.png }\n  guest: { voice: "qwen:Ryan", avatar: guest.png }\n  only: { voice: "qwen:Ryan", avatar: only.png }\n` +
        `logo: { src: logo.png }\noutputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16", layout: shorts, scenes: [b] }\n`,
      [
        '# 하나 {#a}',
        '::image{src=a.png}',
        'host: 하나 :cue[둘]{show=a2.png}.',
        '::video{src=v.mp4}',
        'guest: 셋.',
        ':::gallery\n![](g1.png)\n![](g2.png)\n:::',
        'host: 넷.',
        '# 둘 {#b}',
        '::title{label="x"}',
        'host: 다섯 :cue[여섯]{show=b2.png}.',
        ':::split\n![](s1.png)\n\n본문\n:::',
        'only: :only{shorts}일곱.',
      ].join('\n\n'),
    );
    const fromRenderer = new Set<string>();
    for (const output of Object.keys(s.meta.outputs)) {
      const manifest: AudioManifest = {};
      for (const scene of s.scenes)
        scene.blocks.forEach((b, bi) => {
          if (b.kind !== 'paragraph') return;
          b.sentences.forEach((sen, si) => {
            let t = 0;
            const words = mockTokens(toAlignText(sen.text, {}, 'ko').tts, 'ko').map((text) => {
              const w = { text, start: t, end: t + 0.3 };
              t += 0.35;
              return w;
            });
            manifest[sentenceId(scene.id, bi, si)] = { src: 'x', duration: t + 0.2, words };
          });
        });
      const { timeline } = buildTimeline(s, output, manifest, 30);
      // the cues made it into the timeline (else both lists would miss show=)
      const shows = timeline.scenes.flatMap((sc) => sc.cues.map((c) => c.attrs.show));
      expect(shows.filter(Boolean).length).toBeGreaterThan(0);
      for (const f of referencedImages(timeline)) if (!VIDEO_EXT.test(f)) fromRenderer.add(f);
      for (const c of castOptions(s, timeline)) if (c.avatar) fromRenderer.add(c.avatar);
      const logo = logoOf(s.meta);
      if (logo) fromRenderer.add(logo.src);
    }
    const fromLint = new Set(
      renderedImages(s)
        .filter((f) => !f.video)
        .map((f) => f.src),
    );
    expect([...fromLint].sort()).toEqual([...fromRenderer].sort());
    expect(fromLint.has('only.png')).toBe(true); // a speaker of one output only
    expect(fromLint.has('b2.png')).toBe(true);
  });
});
