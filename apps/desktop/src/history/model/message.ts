// A commit message as Edit message sends it (handoff workspace-history §9.1; ipc-m2 §7.2): the
// shell's normalizing, and its checks in its order, so the dialog shows a field error before
// anything is sent. The fields keep what was typed (no filtering), so a pasted control character
// says why it cannot be saved. Pure.
import { LIMITS } from '../../ipc';
import { charCount } from '../../lib/text';

/** The message rules' codes (ipc-m2 §15.1); the shell answers them too. */
export type MessageProblem = 'SummaryEmpty' | 'SummaryTooLong' | 'SummaryInvalid' | 'BodyTooLong' | 'BodyInvalid';

const MESSAGE_PROBLEMS: readonly string[] = ['SummaryEmpty', 'SummaryTooLong', 'SummaryInvalid', 'BodyTooLong', 'BodyInvalid'];

/** Whether an error code is one of a message's rules, shown under its field. */
export function isMessageProblem(code: string): code is MessageProblem {
  return MESSAGE_PROBLEMS.includes(code);
}

/** Whether the problem is the summary's (else the description's). */
export function isSummaryProblem(problem: MessageProblem): boolean {
  return problem.startsWith('Summary');
}

export interface Message {
  summary: string;
  body: string | null;
}

/**
 * The message as the shell stores it (§7.2 rule 1): the summary without white space at its ends;
 * the body with CR LF and CR as LF, without white space at its end or line feeds at its start, and
 * `null` when nothing is left.
 */
export function normalizeMessage(summary: string, description: string): Message {
  const body = description
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/u, '')
    .replace(/^\n+/, '');
  return { summary: summary.trim(), body: body === '' ? null : body };
}

/** A control character (line breaks included), which a summary may not hold. */
const SUMMARY_INVALID = /\p{Cc}/u;
/** A control character other than tab and line feed, which a body may not hold. */
const BODY_INVALID = /[^\P{Cc}\t\n]/u;

/** The first rule a normalized message breaks (§7.2 rule 2, in its order), or `null`. */
export function checkMessage(message: Message): MessageProblem | null {
  const { summary, body } = message;
  if (summary === '') return 'SummaryEmpty';
  if (charCount(summary) > LIMITS.summaryChars) return 'SummaryTooLong';
  if (SUMMARY_INVALID.test(summary)) return 'SummaryInvalid';
  if (body !== null && charCount(body) > LIMITS.bodyChars) return 'BodyTooLong';
  if (body !== null && BODY_INVALID.test(body)) return 'BodyInvalid';
  return null;
}

/** Whether two messages are the same once normalized: saving it would change nothing. */
export function sameMessage(a: Message, b: Message): boolean {
  return a.summary === b.summary && a.body === b.body;
}
