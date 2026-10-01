// The app and window commands (ADR-0001 §4, action item 4b) and `log_ui_error` (ipc-m1 §16.4).
import { LIMITS } from '../../bindings';
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import { charCount } from '../../../lib/text';
import type { FakeShell } from '../shell';

const SOURCE = /^[A-Za-z0-9._-]{1,64}$/;

export function appCommands(
  shell: FakeShell,
): GroupHandlers<'app_info' | 'set_maximize_button_bounds' | 'log_ui_error'> {
  return {
    app_info: () => ({
      appVersion: '0.1.0',
      coreVersion: '0.1.0',
      dataDir: 'C:\\Users\\Student\\AppData\\Local\\Folio (fake shell)',
    }),

    set_maximize_button_bounds: () => null,

    log_ui_error: (request) => {
      const tooLong = (text: string | null) => text !== null && charCount(text) > LIMITS.logChars;
      if (!SOURCE.test(request.source) || tooLong(request.message) || tooLong(request.stack)) {
        fail('InvalidArgument', 'the report breaks the limits of ipc-m1 §16.4');
      }
      shell.log.push({ ...request });
      return null;
    },
  };
}
