// What testing the AI key says (ipc-m2 §12.4): one status line, its first sentence adapted from
// workspace-history handoff §4.3's titles, its second saying what to do in these settings.
import type { TFunction } from 'i18next';

import type { AiService } from '../../../data/ai';
import type { IpcError } from '../../../ipc';

/** `t` of `useTranslation(['settings', 'errors'])`. */
export type SettingsT = TFunction<['settings', 'errors']>;

/** How the last test ended: the service answered, or the shell's error. */
export type TestResult = { ok: true } | { ok: false; error: IpcError };

/** The status line for a result: its tone icon and its text. */
export interface TestLine {
  tone: 'success' | 'warning';
  text: string;
}

/** The codes the line words itself (`ai.test.failed.<code>`); any other reads the errors text. */
const WORDED = [
  'AiNetwork',
  'AiTimeout',
  'AiRejected',
  'AiRateLimited',
  'AiUnavailable',
  'AiBadResponse',
  'AiCredential',
  'AiNotConfigured',
] as const;
type Worded = (typeof WORDED)[number];

function isWorded(code: string): code is Worded {
  return (WORDED as readonly string[]).includes(code);
}

/**
 * The line for `result`, naming the service as the settings do ("DeepSeek" for the default
 * endpoint, "The AI service" for any other). A bad answer from another service points at its
 * address as well as the model, since DeepSeek's address is fixed.
 */
export function testLine(t: SettingsT, service: AiService, result: TestResult): TestLine {
  const name = t(`ai.test.service.${service}`);
  if (result.ok) return { tone: 'success', text: t('ai.test.ok', { service: name }) };
  const { code } = result.error;
  if (code === 'AiBadResponse' && service === 'other') {
    return { tone: 'warning', text: t('ai.test.failed.AiBadResponseOther', { service: name }) };
  }
  if (isWorded(code)) return { tone: 'warning', text: t(`ai.test.failed.${code}`, { service: name }) };
  return { tone: 'warning', text: t('ai.test.failed.other', { message: t(`errors:${code}`) }) };
}
