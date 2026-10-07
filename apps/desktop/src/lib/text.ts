// Text as it crosses IPC (docs/specs/ipc-m1.md §4.1): the shell counts characters as Unicode
// scalar values. Its JSON parser also refuses a lone surrogate, failing the whole call: use
// `String.prototype.isWellFormed` and `toWellFormed` (ES2024) before sending typed or pasted text.

/** Characters as the shell counts them: Unicode scalar values. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * Well-formed text (lone surrogates become U+FFFD, as `toWellFormed` does) of at most `limit`
 * characters, never cut inside a surrogate pair: what fits a field the shell limits.
 */
export function wellFormedPrefix(text: string, limit: number): string {
  return Array.from(text.toWellFormed()).slice(0, limit).join('');
}
