// App settings and the library's ignore rules (docs/specs/ipc-m1.md §22). The fake keeps App
// settings in memory and the rules on its library; it marks invalid lines roughly as the real
// matcher does (an unclosed `[` or `{`, a range backwards), and a change starts a scan job, as the
// watcher does in the app, without leaving anything out of the fake library.
import { type AppSettings, type IgnoreRules, LIMITS } from '../../bindings';
import { charCount } from '../../../lib/text';
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import { displayName } from '../names';
import type { FakeShell } from '../shell';

/** Invalid lines listed at most. */
const INVALID_LINES = 100;

export function settingsCommands(
  shell: FakeShell,
): GroupHandlers<'get_app_settings' | 'update_app_settings' | 'get_ignore_rules' | 'set_ignore_rules'> {
  return {
    get_app_settings: () => shell.appSettings,

    update_app_settings: (request) => {
      const current = shell.appSettings;
      const next: AppSettings = {
        deviceName: request.deviceName === null ? current.deviceName : displayName(request.deviceName),
        theme: request.theme ?? current.theme,
        reduceMotion: request.reduceMotion ?? current.reduceMotion,
      };
      shell.saveAppSettings(next);
      return next;
    },

    get_ignore_rules: () => ignoreRules(shell.library.ignoreRules),

    set_ignore_rules: (request) => {
      // The limit counts the rules without their trailing line breaks; read-only and a rebuild
      // do not stop a save.
      const rules = request.text.replace(/[\r\n]+$/, '');
      if (charCount(rules) > LIMITS.ignoreRulesChars) {
        fail('InvalidArgument', 'ignore rules over LIMITS.ignoreRulesChars');
      }
      const library = shell.library;
      const text = rules === '' ? '' : `${rules.replace(/\r\n/g, '\n')}\n`;
      const saved = ignoreRules(text);
      if (text !== library.ignoreRules) shell.saveIgnoreRules(saved);
      return saved;
    },
  };
}

function ignoreRules(text: string): IgnoreRules {
  return { text, invalidLines: invalidLines(text).slice(0, INVALID_LINES) };
}

/** Lines, counted from 1, that the fake thinks are not valid patterns. */
function invalidLines(text: string): number[] {
  const invalid: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (!line.startsWith('#') && !isValidPattern(line)) invalid.push(index + 1);
  });
  return invalid;
}

function isValidPattern(line: string): boolean {
  let open: '[' | '{' | null = null;
  /** The last character inside a `[…]` class, where a `-` makes a range. */
  let previous: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? '';
    if (char === '\\') {
      index++;
      previous = null;
    } else if (open === null) {
      if (char === '[' || char === '{') open = char;
      previous = null;
    } else if (char === (open === '[' ? ']' : '}')) {
      open = null;
    } else if (open === '[' && char === '-' && previous !== null) {
      const end = line[index + 1];
      if (end !== undefined && end !== ']' && end < previous) return false;
    } else {
      previous = open === '[' ? char : null;
    }
  }
  return open === null;
}
