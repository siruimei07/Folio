// A commit message as Edit message sends it (ipc-m2 §7.2): the shell's normalizing and its checks
// in its order.
import { describe, expect, it } from 'vitest';

import { checkMessage, isMessageProblem, isSummaryProblem, normalizeMessage, sameMessage } from './message';

describe('normalizeMessage', () => {
  it('trims the summary and normalizes the body as the shell stores it', () => {
    expect(normalizeMessage('  MAT232: add slides \t', '\n\nFirst line\r\nSecond\rThird  \n\n')).toEqual({
      summary: 'MAT232: add slides',
      body: 'First line\nSecond\nThird',
    });
  });

  it('makes an empty body null, and keeps tabs and the text as typed', () => {
    expect(normalizeMessage('x', ' \n \n')).toEqual({ summary: 'x', body: null });
    expect(normalizeMessage('线性代数', '\tindented')).toEqual({ summary: '线性代数', body: '\tindented' });
  });
});

describe('checkMessage', () => {
  it('passes a message within the rules', () => {
    expect(checkMessage({ summary: 'a'.repeat(256), body: `${'b'.repeat(16_383)}\t` })).toBeNull();
    // Characters, not UTF-16 units: 256 emoji are 512 units.
    expect(checkMessage({ summary: '📚'.repeat(256), body: null })).toBeNull();
  });

  it('checks in the shell’s order', () => {
    expect(checkMessage({ summary: '', body: '\u0007' })).toBe('SummaryEmpty');
    expect(checkMessage({ summary: `${'a'.repeat(256)}\u0007`, body: null })).toBe('SummaryTooLong');
    expect(checkMessage({ summary: 'a\tb', body: null })).toBe('SummaryInvalid');
    expect(checkMessage({ summary: 'a\nb', body: null })).toBe('SummaryInvalid');
    expect(checkMessage({ summary: 'a', body: 'b'.repeat(16_385) })).toBe('BodyTooLong');
    expect(checkMessage({ summary: 'a', body: 'bell \u0007' })).toBe('BodyInvalid');
    expect(checkMessage({ summary: 'a', body: 'line\nbreak\tand tab' })).toBeNull();
  });

  it('tells the summary’s problems from the body’s', () => {
    expect(isMessageProblem('SummaryTooLong')).toBe(true);
    expect(isMessageProblem('CannotReword')).toBe(false);
    expect(isSummaryProblem('SummaryInvalid')).toBe(true);
    expect(isSummaryProblem('BodyInvalid')).toBe(false);
  });
});

describe('sameMessage', () => {
  it('compares normalized messages', () => {
    expect(sameMessage(normalizeMessage(' a ', 'b\n'), { summary: 'a', body: 'b' })).toBe(true);
    expect(sameMessage(normalizeMessage('a', ''), { summary: 'a', body: null })).toBe(true);
    expect(sameMessage(normalizeMessage('a', 'c'), { summary: 'a', body: 'b' })).toBe(false);
  });
});
