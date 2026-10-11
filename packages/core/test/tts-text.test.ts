import { describe, expect, it } from 'vitest';
import { toAlignText, toTtsText, ttsRangeToDisplay } from '../src/tts-text.js';

describe('toTtsText', () => {
  const dict = { CLI: '씨엘아이', React: '리액트', 'React Native': '리액트 네이티브' };

  it('applies the dictionary as whole words, case-insensitively, longest key first', () => {
    const t = toTtsText('React Native와 react, 그리고 cli 도구. ReactDOM은 그대로.', dict);
    expect(t.tts).toBe('리액트 네이티브와 리액트, 그리고 씨엘아이 도구. ReactDOM은 그대로.');
  });

  it('leaves text untouched when the dictionary is empty', () => {
    const t = toTtsText('안녕하세요.', {});
    expect(t.tts).toBe('안녕하세요.');
    expect(t.spans).toEqual([
      { displayStart: 0, displayEnd: 6, ttsStart: 0, ttsEnd: 6, replaced: false },
    ]);
  });

  it('maps TTS ranges back to display ranges', () => {
    const t = toTtsText('CLI를 실행합니다', dict);
    expect(t.tts).toBe('씨엘아이를 실행합니다');
    // "씨엘" (inside the replacement) maps to the whole display word "CLI"
    expect(ttsRangeToDisplay(t, 0, 2)).toEqual([0, 3]);
    // "씨엘아이를" maps to "CLI를"
    expect(ttsRangeToDisplay(t, 0, 5)).toEqual([0, 4]);
    // "실행합니다" maps 1:1
    const at = t.tts.indexOf('실행');
    expect(t.display.slice(...ttsRangeToDisplay(t, at, at + 5))).toBe('실행합니다');
  });
});

describe('toAlignText', () => {
  it('spells out Korean numbers and keeps the mapping to the display text', () => {
    const t = toAlignText('CLI로 29점, 1,200개입니다', { CLI: '씨엘아이' }, 'ko');
    expect(t.tts).toBe('씨엘아이로 이십구점, 천이백개입니다');
    const at = t.tts.indexOf('이십구');
    expect(t.display.slice(...ttsRangeToDisplay(t, at, at + 4))).toBe('29점');
  });

  it('leaves other languages unchanged for now', () => {
    expect(toAlignText('790 milliseconds', {}, 'en').tts).toBe('790 milliseconds');
  });
});
