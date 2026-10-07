// The commit message as typed (workspace-history handoff §4.1, ipc-m2 §7.2): the fields keep only
// what the shell accepts, so a paste never makes a commit fail later, and the message sent is what
// was typed, the template, or the AI's.
import { LIMITS } from '../../ipc';
import { charCount, wellFormedPrefix } from '../../lib/text';
import type { Draft } from '../state';

/** `text` cut to `limit` characters, as `maxLength` would if it counted characters. */
function limited(text: string, limit: number): string {
  return charCount(text) > limit ? wellFormedPrefix(text, limit) : text;
}

/**
 * The summary field's text: at most `LIMITS.summaryChars` characters, control characters (a pasted
 * tab or line break) as spaces, which `SummaryInvalid` would refuse.
 */
export function summaryText(text: string): string {
  return limited(text.replace(/\p{Cc}/gu, ' '), LIMITS.summaryChars);
}

/**
 * The description field's text: at most `LIMITS.bodyChars` characters, without control characters
 * other than tab and line breaks, which `BodyInvalid` would refuse.
 */
export function descriptionText(text: string): string {
  return limited(
    text.replace(/\p{Cc}/gu, (character) => (character === '\t' || character === '\n' || character === '\r' ? character : '')),
    LIMITS.bodyChars,
  );
}

/** Whether both fields are empty: the message is then written for the person (§4.2). */
export function isBlank(draft: Draft): boolean {
  return draft.summary.trim() === '' && draft.description.trim() === '';
}

/**
 * The message a commit sends: the typed summary, or `fallback` (the template, or the AI's) when
 * none was typed; the description as its body, or none. Well-formed, so the shell's JSON parser
 * takes it.
 */
export function messageOf(draft: Draft, fallback: () => string): { summary: string; body: string | null } {
  const typed = draft.summary.trim();
  const body = draft.description.trim() === '' ? null : draft.description.toWellFormed();
  return { summary: (typed === '' ? fallback() : typed).toWellFormed(), body };
}
