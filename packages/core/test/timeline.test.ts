import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  displayWordSpans,
  groupSubtitles,
  parseScript,
  sentenceId,
  type AudioManifest,
  type Script,
} from '../src/index.js';

const SRC = `---
lang: ko
cast:
  host: { voice: "qwen:Sohee" }
outputs:
  youtube: { aspect: "16:9", layout: presenter }
  shorts: { aspect: "9:16", layout: shorts, scenes: [settings] }
pronounce:
  CLI: 씨엘아이
---

# 소개 {#intro}

::title[코드로 영상을]

안녕하세요. CLI를 설치합니다.

:only{youtube} 구독 부탁드려요.

# 설정 {#settings}

::image{src=a.png}

오른쪽 위의 :cue[설정 버튼]{x=0.9 y=0.1 zoom=3}을 누르면 새 화면이 열립니다.
`;

function script(): Script {
  const r = parseScript(SRC);
  expect(r.diagnostics.items).toEqual([]);
  return r.script!;
}

// Words as an aligner would return them for the TTS text (dictionary applied, sub-word tokens).
const MANIFEST: AudioManifest = {
  [sentenceId('intro', 1, 0)]: {
    src: 'intro_0.wav',
    duration: 1.2,
    words: [{ text: '안녕하세요', start: 0.1, end: 1.0 }],
  },
  [sentenceId('intro', 1, 1)]: {
    src: 'intro_1.wav',
    duration: 1.5,
    words: [
      { text: '씨엘', start: 0.05, end: 0.3 },
      { text: '아이', start: 0.3, end: 0.5 },
      { text: '를', start: 0.5, end: 0.6 },
      { text: '설치', start: 0.6, end: 1.0 },
      { text: '합니다', start: 1.0, end: 1.4 },
    ],
  },
  [sentenceId('intro', 2, 0)]: {
    src: 'intro_2.wav',
    duration: 1.0,
    words: [
      { text: '구독', start: 0.0, end: 0.4 },
      { text: '부탁드려요', start: 0.4, end: 0.9 },
    ],
  },
  [sentenceId('settings', 1, 0)]: {
    src: 'settings_0.wav',
    duration: 4.0,
    words: [
      { text: '오른쪽', start: 0.1, end: 0.6 },
      { text: '위의', start: 0.6, end: 0.9 },
      { text: '설정', start: 0.9, end: 1.3 },
      { text: '버튼', start: 1.3, end: 1.6 },
      { text: '을', start: 1.6, end: 1.7 },
      { text: '누르', start: 1.7, end: 2.0 },
      { text: '면', start: 2.0, end: 2.2 },
      { text: '새', start: 2.5, end: 2.7 },
      { text: '화면', start: 2.7, end: 3.0 },
      { text: '이', start: 3.0, end: 3.1 },
      { text: '열립니다', start: 3.1, end: 3.8 },
    ],
  },
};

describe('displayWordSpans', () => {
  it('maps TTS tokens inside a dictionary replacement back to the original word', () => {
    const s = script().scenes[0]!.blocks[1]!;
    if (s.kind !== 'paragraph') throw new Error('expected paragraph');
    const spans = displayWordSpans(s.sentences[1]!, MANIFEST[sentenceId('intro', 1, 1)]!.words, {
      CLI: '씨엘아이',
    });
    const text = s.sentences[1]!.text;
    expect(spans.map((x) => [text.slice(x.start, x.end), x.t0, x.t1])).toEqual([
      ['CLI', 0.05, 0.5],
      ['를', 0.5, 0.6],
      ['설치', 0.6, 1.0],
      ['합니다', 1.0, 1.4],
    ]);
  });
});

describe('displayWordSpans with tokens straddling a replacement', () => {
  it('never returns overlapping display ranges', () => {
    const sentence = { text: 'Lighthouse라는 기능', cues: [] };
    const words = [
      { text: '라이트', start: 0, end: 0.3 },
      { text: '하우스라는', start: 0.3, end: 0.8 },
      { text: '기능', start: 0.9, end: 1.2 },
    ];
    const spans = displayWordSpans(sentence, words, { Lighthouse: '라이트하우스' });
    expect(spans.map((s) => [sentence.text.slice(s.start, s.end), s.t0, s.t1])).toEqual([
      ['Lighthouse라는', 0, 0.8],
      ['기능', 0.9, 1.2],
    ]);
  });
});

describe('groupSubtitles', () => {
  it('never splits a Korean eojeol and breaks after commas', () => {
    const text = '오른쪽 위의 설정 버튼을 누르면, 새 프로젝트를 만들 수 있는 화면이 나타납니다.';
    const words = [
      '오른쪽',
      '위의',
      '설정',
      '버튼',
      '을',
      '누르',
      '면',
      '새',
      '프로젝트',
      '를',
      '만들',
      '수',
      '있는',
      '화면',
      '이',
      '나타납니다',
    ];
    let cursor = 0;
    const spans = words.map((w, i) => {
      const start = text.indexOf(w, cursor);
      cursor = start + w.length;
      return { start, end: cursor, t0: i, t1: i + 1 };
    });
    const groups = groupSubtitles(text, spans, 'ko', 20).map((g) => text.slice(g.start, g.end));
    expect(groups).toEqual([
      '오른쪽 위의 설정 버튼을 누르면,',
      '새 프로젝트를 만들 수 있는',
      '화면이 나타납니다.',
    ]);
  });
});

describe('groupSubtitles with cue phrases', () => {
  it('keeps a cue phrase in one group, starting a new group before it when needed', () => {
    const text = '가장 큰 원인은 렌더링을 막는 리소스였는데요.';
    const words = ['가장', '큰', '원인', '은', '렌더링', '을', '막는', '리소스', '였는데요'];
    let cursor = 0;
    const spans = words.map((w, i) => {
      const start = text.indexOf(w, cursor);
      cursor = start + w.length;
      return { start, end: cursor, t0: i, t1: i + 1 };
    });
    const cue = { start: text.indexOf('렌더링'), end: text.indexOf('였는데요') };
    const plain = groupSubtitles(text, spans, 'ko', 16).map((g) => text.slice(g.start, g.end));
    expect(plain).toEqual(['가장 큰 원인은 렌더링을 막는', '리소스였는데요.']);
    const kept = groupSubtitles(text, spans, 'ko', 16, [cue]).map((g) =>
      text.slice(g.start, g.end),
    );
    expect(kept).toEqual(['가장 큰 원인은', '렌더링을 막는 리소스였는데요.']);
  });
});

/** Spans for the given words, in order; words not in `words` stay unaligned (like the aligner). */
function spansOf(text: string, words: string[]) {
  let cursor = 0;
  return words.map((w, i) => {
    const start = text.indexOf(w, cursor);
    if (start < 0) throw new Error(`no "${w}" in "${text}"`);
    cursor = start + w.length;
    return { start, end: cursor, t0: i, t1: i + 1 };
  });
}
const cut = (
  text: string,
  words: string[],
  lang: 'ko' | 'en' | 'ja',
  max?: number,
  keep: { start: number; end: number }[] = [],
) =>
  groupSubtitles(text, spansOf(text, words), lang, max, keep).map((g) =>
    text.slice(g.start, g.end),
  );
/** The greedy grouping before P18: the oracle for groups whose tail was long enough. */
function greedy(text: string, spans: { start: number; end: number }[], max: number) {
  const out: { first: number; last: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const open = out[out.length - 1];
    if (!open) {
      out.push({ first: i, last: i });
      continue;
    }
    const gap = text.slice(spans[i - 1]!.end, spans[i]!.start);
    const ok = /\s/.test(gap) && !/[\p{L}\p{N}]/u.test(gap);
    const comma = gap.includes(',');
    if (ok && (spans[i]!.end - spans[open.first]!.start > max || comma))
      out.push({ first: i, last: i });
    else open.last = i;
  }
  return out;
}

describe('groupSubtitles: short tails (P18)', () => {
  it('moves a lone predicate back to the group before it', () => {
    const text = '이 단어는 공항 안내 방송에서 자주 들을 수 있으니 꼭 기억해 두면 좋습니다.';
    const words = text.replace('.', '').split(' ');
    // greedy: '… 꼭 기억해 두면' / '좋습니다.' (4 < 7)
    expect(cut(text, words, 'ko')).toEqual([
      '이 단어는 공항 안내 방송에서 자주',
      '들을 수 있으니 꼭 기억해',
      '두면 좋습니다.',
    ]);
    const groups = cut(text, words, 'ko');
    expect(groups.join(' ')).toBe(text);
  });

  it('repairs the tail to the latest boundary and keeps the group count', () => {
    const text = '출국 심사를 마친 뒤에는 면세 구역에서 쇼핑을 씁니다.';
    const words = text.replace('.', '').split(' ');
    // greedy tail '구역에서 쇼핑을 씁니다.' is long enough: unchanged
    expect(cut(text, words, 'ko')).toEqual([
      '출국 심사를 마친 뒤에는 면세',
      '구역에서 쇼핑을 씁니다.',
    ]);
    const text2 = '여권과 탑승권을 함께 보여 주시면 됩니다.';
    // greedy (20): '여권과 탑승권을 함께 보여 주시면' (18) / '됩니다.' (3) → '…함께 보여' / '주시면 됩니다.'
    expect(cut(text2, text2.replace('.', '').split(' '), 'ko')).toEqual([
      '여권과 탑승권을 함께 보여',
      '주시면 됩니다.',
    ]);
  });

  it('leaves the tail when every move would make the group before it short', () => {
    // moving the break before the long word would leave '네' (1 < 7) alone
    expect(
      cut(
        '네 가나다라마바사아자차카타파하파 됩니다.',
        ['네', '가나다라마바사아자차카타파하파', '됩니다'],
        'ko',
      ),
    ).toEqual(['네 가나다라마바사아자차카타파하파', '됩니다.']);
  });

  it('pins each rule of the repair', () => {
    // no break in a gap that holds an unaligned word (it would drop 'Node.js')
    expect(
      cut(
        '설정 화면에서 Node.js 버전을 확인합니다.',
        ['설정', '화면에서', '버전을', '확인합니다'],
        'ko',
        8,
      ),
    ).toEqual(['설정 화면에서 Node.js 버전을', '확인합니다.']);
    // a tail before a comma break is repaired too
    expect(
      cut(
        '이번 영상에서는 설정 화면을 함께 열어 봐요, 그럼 시작합니다.',
        ['이번', '영상에서는', '설정', '화면을', '함께', '열어', '봐요', '그럼', '시작합니다'],
        'ko',
      ),
    ).toEqual(['이번 영상에서는 설정 화면을', '함께 열어 봐요,', '그럼 시작합니다.']);
    // text-mode spans include the period; the length check ignores it (tail '확인해보아요' = 6 < 7)
    const t = '이번 영상에서는 설정 화면을 함께 확인해보아요.';
    const textSpans = [...t.matchAll(/\S+/gu)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      t0: 0,
      t1: 0,
    }));
    expect(groupSubtitles(t, textSpans, 'ko').map((g) => t.slice(g.start, g.end))).toEqual([
      '이번 영상에서는 설정 화면을',
      '함께 확인해보아요.',
    ]);
    // ja: a greedy break after a particle stays, even with a short tail
    expect(
      cut(
        '右上にある歯車ボタンから設定画面を確認します。',
        [
          '右上',
          'に',
          'ある',
          '歯車',
          'ボタン',
          'から',
          '設定',
          '画面',
          'を',
          '確認',
          'し',
          'ます',
        ],
        'ja',
      ),
    ).toEqual(['右上にある歯車ボタンから設定画面を', '確認します。']);
    // ja: a gap of openers only is a repair boundary; 「 starts the tail
    expect(
      cut(
        '新しいバージョンのアプリをインストールしたら「設定」画面を開きます。',
        [
          '新しい',
          'バージョン',
          'の',
          'アプリ',
          'を',
          'インストール',
          'し',
          'たら',
          '設定',
          '画面',
          'を',
          '開き',
          'ます',
        ],
        'ja',
      ),
    ).toEqual(['新しいバージョンのアプリを', 'インストールしたら', '「設定」画面を開きます。']);
  });

  it('does not repair a group after a comma', () => {
    // '네' is short, but its break is the comma: moving it would put the comma mid-group
    expect(
      cut(
        '오늘은 설정 화면을 같이 볼게요, 네.',
        ['오늘은', '설정', '화면을', '같이', '볼게요', '네'],
        'ko',
      ),
    ).toEqual(['오늘은 설정 화면을 같이 볼게요,', '네.']);
  });

  it('never cuts a cue phrase when repairing', () => {
    const text = '여권과 탑승권을 함께 보여 주시면 됩니다.';
    const cue = { start: text.indexOf('보여'), end: text.indexOf('주시면') + 3 };
    // the latest boundary ('주시면') is inside the phrase: the break moves to the phrase start
    expect(cut(text, text.replace('.', '').split(' '), 'ko', 20, [cue])).toEqual([
      '여권과 탑승권을 함께',
      '보여 주시면 됩니다.',
    ]);
  });

  it('keeps words the aligner did not match', () => {
    const text =
      'Node.js makes this easy, and a re-render reuses every finished scene, open localhost:3000.';
    const words = [
      'makes',
      'this',
      'easy',
      'and',
      'a',
      'reuses',
      'every',
      'finished',
      'scene',
      'open',
    ];
    const groups = cut(text, words, 'en', 20);
    const joined = groups.join(' ');
    for (const w of ['Node.js', 're-render', 'localhost:3000.']) expect(joined).toContain(w);
    expect(joined).toBe(text);
  });

  it('keeps quotes with their words', () => {
    const text = '원하는 항목을 고른 다음 "저장"을 눌러요.';
    expect(cut(text, ['원하는', '항목을', '고른', '다음', '저장', '을', '눌러요'], 'ko')).toEqual([
      '원하는 항목을 고른',
      '다음 "저장"을 눌러요.',
    ]);
    const t2 = '화면 오른쪽 위 모서리에 있는 "저장" 버튼을 누릅니다.';
    // a greedy break before ' "저장"': the quote starts the next group (it used to be dropped)
    expect(
      cut(t2, ['화면', '오른쪽', '위', '모서리에', '있는', '저장', '버튼을', '누릅니다'], 'ko', 16),
    ).toEqual(['화면 오른쪽 위 모서리에 있는', '"저장" 버튼을 누릅니다.']);
  });

  it('ja: phrase-start repairs, digits, and 「 with its word', () => {
    const a = 'アプリを開いて上の設定画面を確認します。';
    expect(
      cut(
        a,
        ['アプリ', 'を', '開いて', '上', 'の', '設定', '画面', 'を', '確認', 'します'],
        'ja',
        14,
      ),
    ).toEqual(['アプリを開いて上の設定画面を', '確認します。']);
    const b = 'アプリを入れてからインストールしたら「設定」画面を開きます。';
    const wb = [
      'アプリ',
      'を',
      '入れて',
      'から',
      'インストール',
      'したら',
      '設定',
      '画面',
      'を',
      '開き',
      'ます',
    ];
    expect(cut(b, wb, 'ja')).toEqual([
      'アプリを入れてからインストールしたら',
      '「設定」画面を開きます。',
    ]);
    // greedy tail 'ます' (2 < 6) moves back to the phrase that starts with a digit
    const c = 'まずはアプリの設定を3回押します。';
    const wc = ['まずは', 'アプリ', 'の', '設定', 'を', '3', '回', '押し', 'ます'];
    expect(cut(c, wc, 'ja', 15)).toEqual(['まずはアプリの設定を', '3回押します。']);
  });

  it('property: same count as greedy, tails repaired, nothing dropped, phrases whole', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const syl = '가나다라마바사아자차카타파하';
    const max = 20;
    const tailMin = 7;
    for (let n = 0; n < 3000; n++) {
      const count = 3 + rnd(14);
      const words = Array.from({ length: count }, () =>
        Array.from({ length: 1 + rnd(6) }, () => syl[rnd(syl.length)]).join(''),
      );
      const commaAt = rnd(3) === 0 ? rnd(count - 1) : -1;
      const text = words.map((w, i) => (i === commaAt ? `${w},` : w)).join(' ') + '.';
      // multi-token eojeols (split a word in two spans) and unaligned words (no span), first/last included
      let cursor = 0;
      const spans: { start: number; end: number; t0: number; t1: number }[] = [];
      words.forEach((w, i) => {
        const start = text.indexOf(w, cursor);
        cursor = start + w.length;
        if (rnd(20) === 0) return;
        if (w.length > 2 && rnd(4) === 0) {
          const mid = start + 1 + rnd(w.length - 1);
          spans.push(
            { start, end: mid, t0: i, t1: i + 0.5 },
            { start: mid, end: cursor, t0: i + 0.5, t1: i + 1 },
          );
        } else spans.push({ start, end: cursor, t0: i, t1: i + 1 });
      });
      if (spans.length === 0) continue;
      const a = rnd(spans.length);
      const b = Math.min(spans.length - 1, a + rnd(3));
      const keep = rnd(2) ? [{ start: spans[a]!.start, end: spans[b]!.end }] : [];
      const got = groupSubtitles(text, spans, 'ko', max, keep);
      const texts = got.map((g) => text.slice(g.start, g.end));
      // nothing dropped: the groups joined by spaces are the sentence
      expect(texts.join(' ')).toBe(text);
      for (const r of keep)
        expect(got.some((g) => g.start <= r.start && g.end >= r.end)).toBe(true);
      // no break in a gap that holds a letter (an unaligned word)
      for (let k = 1; k < got.length; k++)
        expect(/[\p{L}\p{N}]/u.test(text.slice(got[k - 1]!.end, got[k]!.start))).toBe(false);
      if (keep.length > 0) continue;
      const old = greedy(text, spans, max);
      expect(got.length).toBe(old.length);
      // aligned-span lengths: no group longer than greedy's longest; a repaired tail is at least T
      const firstSpan = (g: { start: number }) => spans.findIndex((s) => s.start >= g.start);
      const lastSpan = (g: { end: number }) => spans.findLastIndex((s) => s.end <= g.end);
      const alen = (i: number, j: number) =>
        spans[j]!.end -
        /[^\p{L}\p{N}]*$/u.exec(text.slice(spans[j]!.start, spans[j]!.end))![0].length -
        spans[i]!.start;
      const longest = Math.max(...old.map((g) => alen(g.first, g.last)));
      for (const g of got) expect(alen(firstSpan(g), lastSpan(g))).toBeLessThanOrEqual(longest);
      const oldLast = old[old.length - 1]!;
      const newLast = got[got.length - 1]!;
      const before = alen(oldLast.first, oldLast.last);
      const after = alen(firstSpan(newLast), lastSpan(newLast));
      if (before >= tailMin && commaAt < 0) expect(after).toBe(before);
      else if (after !== before) expect(after).toBeGreaterThanOrEqual(tailMin);
    }
  });
});

describe('buildTimeline', () => {
  it('quantizes scenes, places audio with pacing, resolves cues and subtitles', () => {
    // the plain pacing arithmetic: rhythm off (rhythm.test.ts covers the gaps it makes)
    const { timeline, issues } = buildTimeline(script(), 'youtube', MANIFEST, 30, {
      rhythm: false,
    });
    expect(issues).toEqual([]);
    const [intro, settings] = timeline.scenes;
    // lead 1.3s → 39; sentence 1.2s + gap 0.3s → second sentence at 2.8s → 84
    expect(intro!.audio.map((a) => a.startFrame)).toEqual([39, 84, 147]);
    // paragraph gap 0.6s: 2.8 + 1.5 + 0.6 = 4.9s
    expect(intro!.audio[2]!.startFrame).toBe(Math.round((1.3 + 1.2 + 0.3 + 1.5 + 0.6) * 30));
    expect(intro!.visuals[0]).toMatchObject({ startFrame: 39, visual: { type: 'title' } });
    // scene duration: 4.9 + 1.0 audio + sceneGap 0.8 = 6.7s
    expect(intro!.durationFrames).toBe(Math.round(6.7 * 30));
    expect(settings!.startFrame).toBe(intro!.durationFrames);
    // cue fires at the first word of "설정 버튼" (0.9s), last scene ends with tail 3.0s
    expect(settings!.cues).toEqual([
      { frame: 27, phrase: '설정 버튼', attrs: { x: '0.9', y: '0.1', zoom: '3' } },
    ]);
    expect(settings!.durationFrames).toBe(Math.round(7.0 * 30));
    expect(timeline.totalFrames).toBe(intro!.durationFrames + settings!.durationFrames);
    expect(intro!.subtitles.map((s) => s.text)).toEqual([
      '안녕하세요.',
      'CLI를 설치합니다.',
      '구독 부탁드려요.',
    ]);
    // word offsets inside the subtitle text, with frames
    const cli = intro!.subtitles[1]!;
    expect(cli.words.map((w) => [cli.text.slice(w.start, w.end), w.frame])).toEqual([
      ['CLI를', 85], // round((2.8 + 0.05) * 30) with float error; ko highlights whole eojeol
      ['설치합니다', 84 + 18],
    ]);
    // same speaker, 0.3s+ gap bridged → contiguous
    expect(intro!.subtitles[0]!.endFrame).toBe(intro!.subtitles[1]!.startFrame);
  });

  it('applies output scene selection and :only filtering', () => {
    const { timeline } = buildTimeline(script(), 'shorts', MANIFEST, 30);
    expect(timeline.scenes.map((s) => s.id)).toEqual(['settings']);
    // first selected scene gets the lead
    expect(timeline.scenes[0]!.audio[0]!.startFrame).toBe(39);
  });

  it('reports sentences without audio', () => {
    const { issues } = buildTimeline(script(), 'youtube', {}, 30);
    expect(issues.length).toBe(4);
  });
});

describe(':react', () => {
  it('places a listener reaction at its word and holds it to the end of the paragraph', () => {
    const { script } = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n---\n\n# 하나 {#one}\n\na: 안녕하세요 :react{b=surprised}반갑습니다. 두 번째 문장입니다.\n',
    );
    const s = script!.scenes[0]!.blocks[0]!;
    expect(s.kind === 'paragraph' && s.sentences[0]!.reacts).toEqual([
      { at: 6, faces: { b: 'surprised' } },
    ]);
    const words = (text: string, dur: number) =>
      text.split(' ').map((w, i, all) => ({
        text: w,
        start: (i * dur) / all.length,
        end: ((i + 1) * dur) / all.length,
      }));
    const manifest = {
      'one:0:0': { src: 'a.wav', duration: 2, words: words('안녕하세요 반갑습니다.', 2) },
      'one:0:1': { src: 'b.wav', duration: 1, words: words('두 번째 문장입니다.', 1) },
    };
    const { timeline } = buildTimeline(script!, 'youtube', manifest, 10);
    // lead 1.3 s; "반갑습니다" starts 1 s into the sentence; paragraph ends at 1.3 + 2 + 0.3 + 1.
    expect(timeline.scenes[0]!.reactions).toEqual([
      { cast: 'b', face: 'surprised', startFrame: 23, endFrame: 46 },
    ]);
  });

  it('rejects unknown cast members', () => {
    const { diagnostics } = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\n:react{z=happy}안녕하세요.\n',
    );
    expect(diagnostics.items.map((d) => d.code)).toContain('react-cast');
  });
});

describe('character motions', () => {
  const build = (cast: string, body: string) => {
    const { script } = parseScript(
      `---\nlang: ko\ncast:\n${cast}---\n\n# 하나 {#one}\n\n${body}\n`,
    );
    const manifest = Object.fromEntries(
      script!.scenes[0]!.blocks.flatMap((b, bi) =>
        b.kind === 'paragraph'
          ? b.sentences.map((s, si) => [
              `one:${bi}:${si}`,
              { src: 'x.wav', duration: 1, words: [{ text: s.text, start: 0, end: 1 }] },
            ])
          : [],
      ),
    );
    return buildTimeline(script!, 'youtube', manifest, 10).timeline.scenes[0]!.motions;
  };
  const two = '  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n';

  it('adds a face’s motion automatically, for speakers and reactions', () => {
    const m = build(two, 'a{face=surprised}: 와!\n\nb: :react{a=happy}좋아요.');
    expect(m.map((x) => [x.cast, x.motion])).toEqual([
      ['a', 'jump'],
      ['a', 'bounce'],
    ]);
  });

  it('honours motion=none, explicit motions and cast motion: off', () => {
    expect(build(two, 'a{face=surprised motion=none}: 와!')).toEqual([]);
    expect(build(two, 'a{motion=nod}: 네.').map((x) => x.motion)).toEqual(['nod']);
    expect(build(two, 'b: :react{a=surprised+shake}아니요.').map((x) => x.motion)).toEqual([
      'shake',
    ]);
    const off = '  a: { voice: "qwen:Sohee", motion: off }\n  b: { voice: "qwen:Ryan" }\n';
    expect(build(off, 'a{face=surprised}: 와!')).toEqual([]);
    expect(build(off, 'a{face=surprised motion=jump}: 와!').map((x) => x.motion)).toEqual(['jump']);
  });

  it('rejects unknown motions', () => {
    const { diagnostics } = parseScript(
      `---\nlang: ko\ncast:\n${two}---\n\n# 하나 {#one}\n\na{motion=fly}: 와!\n`,
    );
    expect(diagnostics.items.map((d) => d.code)).toContain('motion-name');
  });
});

describe('::shot framings', () => {
  const src = (outputs: string, body: string) =>
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\noutputs:\n${outputs}---\n\n${body}`;
  const manifestOf = (script: Script) =>
    Object.fromEntries(
      script.scenes.flatMap((sc) =>
        sc.blocks.flatMap((b, bi) =>
          b.kind === 'paragraph'
            ? b.sentences.map((s, si) => [
                sentenceId(sc.id, bi, si),
                { src: 'x.wav', duration: 1, words: [{ text: s.text, start: 0, end: 1 }] },
              ])
            : [],
        ),
      ),
    );
  const body =
    '# 하나 {#one}\n\na: 안녕하세요.\n\n# 둘 {#two}\n\n::shot{a=head}\n\na: 반갑습니다.\n\n# 셋 {#three}\n\nb: 그렇군요.\n\n# 넷 {#four}\n\n::shot{a=full b=upper}\n\na: 끝입니다.\n';

  it('sets framings per scene and inherits them into later scenes', () => {
    const { script, diagnostics } = parseScript(src('  youtube: { aspect: "16:9" }\n', body));
    expect(diagnostics.items.filter((d) => d.severity === 'error')).toEqual([]);
    expect(script!.scenes.map((s) => s.shot)).toEqual([
      undefined,
      { a: 'head' },
      undefined,
      { a: 'full', b: 'upper' },
    ]);
    const { timeline } = buildTimeline(script!, 'youtube', manifestOf(script!), 10);
    expect(timeline.scenes.map((s) => s.framing)).toEqual([
      { a: 'full', b: 'full' },
      { a: 'head', b: 'full' },
      { a: 'head', b: 'full' },
      { a: 'full', b: 'upper' },
    ]);
  });

  it('resolves inheritance over the scenes an output plays, and `shot: full` turns it off', () => {
    const outputs =
      '  youtube: { aspect: "16:9" }\n  part: { aspect: "16:9", scenes: [three, four] }\n  plain: { aspect: "16:9", shot: full }\n';
    const { script } = parseScript(src(outputs, body));
    const m = manifestOf(script!);
    // "three" inherits head from "two" in the full video, but `part` starts at "three".
    expect(buildTimeline(script!, 'part', m, 10).timeline.scenes.map((s) => s.framing)).toEqual([
      { a: 'full', b: 'full' },
      { a: 'full', b: 'upper' },
    ]);
    expect(
      buildTimeline(script!, 'plain', m, 10).timeline.scenes.every((s) =>
        Object.values(s.framing).every((f) => f === 'full'),
      ),
    ).toBe(true);
  });

  it('rejects a shot after the first paragraph, unknown cast and unknown framings', () => {
    const codes = (b: string) =>
      parseScript(src('  youtube: { aspect: "16:9" }\n', b)).diagnostics.items.map((d) => d.code);
    expect(codes('# 하나\n\na: 안녕.\n\n::shot{a=head}\n')).toContain('shot-placement');
    expect(codes('# 하나\n\n::shot{z=head}\n\na: 안녕.\n')).toContain('shot-cast');
    expect(codes('# 하나\n\n::shot{a=close}\n\na: 안녕.\n')).toContain('shot-framing');
    expect(codes('# 하나\n\na: 안녕 :shot{a=head} 하세요.\n')).toContain('shot-placement');
  });
});

describe('faceMotions (parts characters)', () => {
  it('replaces the name-based face motions and cannot be written in a script', () => {
    const { script } = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\na{face=gasp}: 안녕하세요.\n\na{face=surprised}: 반갑습니다.\n',
    );
    script!.meta.cast.a!.faceMotions = { gasp: 'head-nod', surprised: 'none' };
    const manifest = {
      'one:0:0': { src: 'x.wav', duration: 1, words: [{ text: '안녕하세요.', start: 0, end: 1 }] },
      'one:1:0': { src: 'x.wav', duration: 1, words: [{ text: '반갑습니다.', start: 0, end: 1 }] },
    };
    const motions = buildTimeline(script!, 'youtube', manifest, 10).timeline.scenes[0]!.motions;
    // `gasp` brings head-nod; `surprised` (yaml motion: none) brings nothing, not even the built-in jump.
    expect(motions.map((m) => m.motion)).toEqual(['head-nod']);
    const { diagnostics } = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", faceMotions: { x: jump } }\n---\n\n# 하나\n\na: 안녕.\n',
    );
    expect(diagnostics.items.map((d) => d.code)).toContain('frontmatter-schema');
  });
});
