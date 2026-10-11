import { describe, expect, it } from 'vitest';
import { koreanInteger, normalizeForCer, readKoreanNumbers, roundTripCer } from '../src/cer.js';

describe('Korean number reading', () => {
  it.each([
    ['0', '영'],
    ['1', '일'],
    ['10', '십'],
    ['35', '삼십오'],
    ['1200', '천이백'],
    ['10000', '만'],
    ['12345', '만이천삼백사십오'],
    ['200000000', '이억'],
  ])('%s → %s', (n, ko) => expect(koreanInteger(n)).toBe(ko));

  it('reads numbers inside text, including separators and versions', () => {
    expect(readKoreanNumbers('초당 1,200개, 버전 2.5.1')).toBe('초당 천이백개, 버전 이점오점일');
  });
});

describe('roundTripCer', () => {
  it('is zero when ASR spells numbers differently from the script', () => {
    expect(roundTripCer('평균 35밀리초입니다.', '평균 삼십오 밀리초입니다', 'ko')).toBe(0);
  });

  it('accepts either spelling of a pronunciation-dictionary entry', () => {
    const dict = { React: '리액트', CLI: '씨엘아이' };
    expect(roundTripCer('React와 CLI를 씁니다.', '리액트와 CLI를 씁니다', 'ko', dict)).toBe(0);
    expect(roundTripCer('React와 CLI를 씁니다.', 'React와 씨엘아이를 씁니다', 'ko', dict)).toBe(0);
  });

  it('detects a skipped phrase', () => {
    const cer = roundTripCer(
      '오른쪽 위의 설정 버튼을 누르면 새 화면이 열립니다.',
      '오른쪽 위의 설정 버튼을 누르면',
      'ko',
    );
    expect(cer).toBeGreaterThan(0.3);
  });
});

describe('ja / en normalization', () => {
  it('reads Japanese kanji numerals as digits, but not words like 一緒', () => {
    expect(normalizeForCer('二十九点です', 'ja')).toBe(normalizeForCer('29点です', 'ja'));
    expect(normalizeForCer('三万五千円', 'ja')).toBe('35000円');
    expect(normalizeForCer('二〇二六年', 'ja')).toBe('2026年');
    expect(normalizeForCer('一緒に', 'ja')).toBe('一緒に');
  });

  it('reads English number words as digits and expands contractions', () => {
    expect(normalizeForCer('It scored twenty-nine points.', 'en')).toBe(
      normalizeForCer('it scored 29 points', 'en'),
    );
    expect(normalizeForCer('two hundred and five', 'en')).toBe('205');
    expect(normalizeForCer("It's fast and we don't wait.", 'en')).toBe(
      normalizeForCer('it is fast and we do not wait', 'en'),
    );
    expect(normalizeForCer("the browser's cache", 'en')).toBe('thebrowserscache');
  });
});
