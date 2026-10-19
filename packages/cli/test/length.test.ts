/** The rendered length against maxDuration (acting stage 5d plan 2). */
import { describe, expect, it } from 'vitest';
import { renderedLengthWarning } from '../src/length.js';

describe('renderedLengthWarning', () => {
  it('warns when the render is over and the estimate was not', () => {
    expect(renderedLengthWarning('shorts', 61.2, 60, false)).toBe(
      '"shorts" is 61.2s as rendered, over its maxDuration 60s',
    );
  });
  it('stays quiet when the lint already warned, when it fits, or without a limit', () => {
    expect(renderedLengthWarning('shorts', 61.2, 60, true)).toBeNull();
    expect(renderedLengthWarning('shorts', 59, 60, false)).toBeNull();
    expect(renderedLengthWarning('youtube', 900, undefined, false)).toBeNull();
  });
});
