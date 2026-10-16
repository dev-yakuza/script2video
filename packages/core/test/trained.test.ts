/** A persona's trained speaker in the script (acting stage 4 plan 2). */
import { describe, expect, it } from 'vitest';
import {
  CLOSE,
  emotionSentence,
  engineOf,
  gainFor,
  instructFor,
  lintActing,
  parseScript,
  STRONG_TEMPLATES_V1,
  TEMPLATES_V1,
  type Paragraph,
} from '../src/index.js';

const fm = (cast: string, body: string, extra = '') => `---
lang: ko
cast:
${cast}
${extra}---

# s

${body}`;

const TRAINED = '  guest: { voice: "persona:guest", personaModel: trained, style: "또렷하게" }';
const CLONE = '  guest: { voice: "persona:guest" }';

const codes = (src: string, severity: 'error' | 'other') =>
  parseScript(src)
    .diagnostics.items.filter((d) => (severity === 'error') === (d.severity === 'error'))
    .map((d) => d.code);

describe('trained persona speaker', () => {
  it('is its own engine, which acts emotions', () => {
    const s = parseScript(fm(TRAINED, 'guest{emo=sad}: 안녕하세요.')).script!;
    const member = s.meta.cast.guest!;
    expect(engineOf(member)).toBe('trained');
    expect(engineOf({ ...member, personaModel: 'clone' })).toBe('persona');
    expect(emotionSentence('trained', { emo: 'sad' })).toBe(true);
    expect(emotionSentence('persona', { emo: 'sad' })).toBe(false);
    expect(emotionSentence('trained', { emo: 'neutral' })).toBe(false);
  });

  it('takes style and say, which stay errors for a clone', () => {
    expect(codes(fm(TRAINED, 'guest{say="천천히"}: 안녕하세요.'), 'error')).toEqual([]);
    const clone = fm(
      '  guest: { voice: "persona:guest", style: "또렷하게" }',
      'guest{say="천천히"}: 안녕하세요.',
    );
    expect(codes(clone, 'error')).toEqual(['style-unsupported', 'say-unsupported']);
  });

  it('refuses personaModel on a voice that is not a persona', () => {
    const src = fm('  host: { voice: "qwen:Sohee", personaModel: trained }', 'host: 안녕하세요.');
    expect(codes(src, 'error')).toContain('persona-model');
  });

  it('says strong as "Sound very …" on a trained speaker only', () => {
    for (const [emo, t] of Object.entries(STRONG_TEMPLATES_V1)) {
      if (emo === 'neutral') expect(t).toBe(TEMPLATES_V1.neutral);
      else {
        expect(t.startsWith('Sound very ')).toBe(true);
        expect(t.replace('Sound very ', 'Sound ')).toBe(TEMPLATES_V1[emo as 'sad']);
      }
    }
    const meta = parseScript(fm(TRAINED, 'guest: 안녕하세요.')).script!.meta;
    const strong = { emo: 'sad', power: 'strong' as const };
    expect(instructFor(meta, undefined, strong, 'trained').instruct).toBe(
      STRONG_TEMPLATES_V1.sad + CLOSE,
    );
    // the presets choose a stronger take instead
    expect(instructFor(meta, undefined, strong, 'qwen').instruct).toBe(TEMPLATES_V1.sad + CLOSE);
    expect(instructFor(meta, undefined, { emo: 'sad' }, 'trained').instruct).toBe(
      TEMPLATES_V1.sad + CLOSE,
    );
    // neutral is no emotion line: no strong wording
    expect(
      instructFor(meta, undefined, { emo: 'neutral', power: 'strong' }, 'trained').instruct,
    ).toBe(TEMPLATES_V1.neutral + CLOSE);
  });

  it('says strong as "Very strongly:" for a user emotion', () => {
    const meta = parseScript(
      fm(TRAINED, 'guest: 안녕.', 'acting:\n  emotions:\n    sleepy: { voice: "Sound drowsy." }\n'),
    ).script!.meta;
    expect(
      instructFor(meta, undefined, { emo: 'sleepy', power: 'strong' }, 'trained').instruct,
    ).toBe(`Very strongly: Sound drowsy.${CLOSE}`);
  });

  it('gets no power gain (it picks a take), a clone does', () => {
    const p = (cast: string) => {
      const s = parseScript(fm(cast, 'guest{emo=sad power=strong}: 안녕하세요.')).script!;
      const b = s.scenes[0]!.blocks[0] as Paragraph;
      return gainFor(s.meta, b, b.sentences[0]!);
    };
    expect(p(TRAINED)).toBe(0);
    expect(p(CLONE)).not.toBe(0);
  });

  it('lints a clone with emo toward training, and not a trained speaker', () => {
    const lint = (cast: string, body: string) =>
      lintActing(parseScript(fm(cast, body)).script!).map((d) => `${d.code}: ${d.message}`);
    expect(lint(CLONE, 'guest{emo=sad}: 안녕하세요.').join('\n')).toMatch(
      /cannot act emotions as a clone.*s2v voice train.*personaModel: trained/,
    );
    expect(lint(TRAINED, 'guest{emo=sad}: 안녕하세요.')).toEqual([]);
    expect(lint(TRAINED, 'guest{emo=neutral power=strong}: 안녕하세요.').join('\n')).toMatch(
      /acting-power/,
    );
  });
});
