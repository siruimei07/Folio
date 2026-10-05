// Named starting states for the fake shell, and the URL parameters that pick them in the browser
// pane (docs/specs/ui-architecture.md §11.2):
//
//   ?scenario=small|large|first-run|read-only|unavailable|errors
//            |history-none|history-long|diffs|history-read-only|history-damaged|ai-off   (ipc-m2 §17)
//   ?latency=<ms>                     every answer waits this long (loading states)
//   ?fail=<command>[:<code>],…        these commands fail, with `Internal` unless a code is given
//   ?choice=empty|folders|library|insideLibrary|incomplete   first run: what the chosen folder holds
//   ?sync=iCloud|oneDrive|dropbox|other                     first run: the folder is in a cloud folder
//   ?reason=missing|notALibrary|newerFormat|accessDenied|catalogFailed|unfinishedMove   unavailable: why
//   ?retry=open                        unavailable: "Try again" opens the library
//   ?theme=light|dark&motion=on|off    App settings → Appearance as stored (ipc-m1 §22)
//   ?ai=ok|network|timeout|rejected|rateLimited|unavailable|badResponse|credential|slow
//                                      how the fake AI service answers (ipc-m2 §17)
//   ?commit=fail:<code>[:<file>]       the next commit job fails with that code, naming that file
//   ?restore=<code>|unchanged          restore_version fails with that code
//   ?confirm=allow|cancel              the answer of the confirmation for another AI service
import type { AppError, SyncProvider, Unavailable } from '../bindings';
import type { CommandName } from './contract';
import { type FolderKind, folderScript } from './fixtures/first-run';
import { largeLibrary } from './fixtures/large';
import { sampleImport, smallLibrary } from './fixtures/small';
import type { Fixture } from './fixtures/types';
import { DEFAULT_APP_SETTINGS, type Failure, type FakeShellOptions } from './shell';
import { AI_MODES } from './versioning/ai';
import { MIDTERM_REVIEW, type VersioningScenario, versioningFixture } from './versioning/fixtures';

export const SCENARIOS = [
  'small',
  'large',
  'first-run',
  'read-only',
  'unavailable',
  'errors',
  'history-none',
  'history-long',
  'diffs',
  'history-read-only',
  'history-damaged',
  'ai-off',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface ScenarioOptions {
  /** First run: what the folder the user chooses holds. */
  choice?: FolderKind;
  /** First run: the chosen folder is inside a cloud-sync folder. */
  syncRoot?: SyncProvider | null;
  /** Unavailable: why the library cannot open. */
  reason?: Unavailable;
}

/** Commands the `errors` scenario fails, so every region of the Library view shows its error. */
const READS: CommandName[] = [
  'list_semesters',
  'list_courses',
  'list_tags',
  'list_children',
  'list_files',
  'get_entry',
  'search',
  'list_jobs',
  'list_problems',
  'get_workspace',
  'list_workspace_items',
  'list_metadata_changes',
  'get_workspace_diff',
  'list_history',
  'list_commit_changes',
  'get_version_diff',
];

/** The history each scenario starts with (ipc-m2 §17). */
const VERSIONING: Partial<Record<Scenario, VersioningScenario>> = {
  small: 'small',
  errors: 'small',
  'read-only': 'small',
  unavailable: 'small',
  'history-none': 'none',
  'history-long': 'long',
  diffs: 'diffs',
  'history-read-only': 'readOnly',
  'history-damaged': 'damaged',
  'ai-off': 'aiOff',
};

export function scenarioFixture(
  scenario: Scenario,
  now: number,
  options: ScenarioOptions = {},
): { fixture: Fixture; failures: Failure[] } {
  const failures: Failure[] =
    scenario === 'errors' ? READS.map((command) => ({ command, code: 'Internal' })) : [];
  const fixture = fixtureOf(scenario, now, options);
  const versioning = VERSIONING[scenario];
  if (versioning !== undefined) {
    const { history, ai } = versioningFixture(versioning);
    if (fixture.library !== null) fixture.library.history = history;
    fixture.ai = ai;
  }
  return { fixture, failures };
}

function fixtureOf(scenario: Scenario, now: number, options: ScenarioOptions): Fixture {
  const opened = (library: Fixture['library']): Fixture => ({
    status: { state: 'open' },
    library,
    folderChoices: [folderScript('library', now)],
    importSources: [sampleImport()],
  });
  switch (scenario) {
    case 'small':
    case 'errors':
    case 'history-none':
    case 'history-long':
    case 'diffs':
    case 'history-read-only':
    case 'history-damaged':
    case 'ai-off':
      return opened(smallLibrary(now));
    case 'large':
      return opened(largeLibrary(now));
    case 'read-only':
      return opened({
        ...smallLibrary(now),
        readOnly: true,
        problems: [{ kind: 'metadata', file: '.folio/meta/tags.json', failure: { kind: 'newer' } }],
      });
    case 'first-run':
      return {
        status: { state: 'none' },
        library: null,
        folderChoices: [folderScript(options.choice ?? 'empty', now, options.syncRoot ?? null)],
        importSources: [sampleImport()],
      };
    case 'unavailable':
      return {
        ...opened(smallLibrary(now)),
        status: { state: 'unavailable', reason: options.reason ?? 'missing' },
      };
  }
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

const FOLDER_KINDS = ['empty', 'folders', 'library', 'insideLibrary', 'incomplete'] as const;
const PROVIDERS = ['iCloud', 'oneDrive', 'dropbox', 'other'] as const;
const REASONS = ['missing', 'notALibrary', 'newerFormat', 'accessDenied', 'catalogFailed', 'unfinishedMove'] as const;
const THEMES = ['system', 'light', 'dark'] as const;
const MOTIONS = ['system', 'on', 'off'] as const;

/** Fake shell options from the page's URL parameters; anything unknown falls back to defaults. */
export function optionsFromUrl(search: string, now: number = Date.now()): FakeShellOptions {
  const params = new URLSearchParams(search);
  const scenario = oneOf(params.get('scenario'), SCENARIOS) ?? 'small';
  const { fixture, failures } = scenarioFixture(scenario, now, {
    choice: oneOf(params.get('choice'), FOLDER_KINDS),
    syncRoot: oneOf(params.get('sync'), PROVIDERS) ?? null,
    reason: oneOf(params.get('reason'), REASONS),
  });
  for (const item of (params.get('fail') ?? '').split(',').filter(Boolean)) {
    const [command = '', code = 'Internal'] = item.split(':');
    failures.push({ command: command as CommandName, code: code as AppError['code'] });
  }
  fixture.appSettings = {
    ...DEFAULT_APP_SETTINGS,
    theme: oneOf(params.get('theme'), THEMES) ?? 'system',
    reduceMotion: oneOf(params.get('motion'), MOTIONS) ?? 'system',
  };
  const latency = Number(params.get('latency'));
  const [failCommit = '', commitCode = '', commitFile] = (params.get('commit') ?? '').split(':');
  const restore = params.get('restore');
  if (restore !== null) {
    failures.push({ command: 'restore_version', code: (restore === 'unchanged' ? 'Unchanged' : restore) as AppError['code'] });
  }
  return {
    fixture,
    failures,
    latencyMs: Number.isFinite(latency) && latency > 0 ? latency : 0,
    retry: params.get('retry') === 'open' ? 'open' : 'unavailable',
    aiMode: oneOf(params.get('ai'), AI_MODES) ?? 'ok',
    confirm: params.get('confirm') === 'cancel' ? 'cancel' : 'allow',
    ...(failCommit === 'fail' && commitCode !== ''
      ? {
          commitFailure: {
            code: commitCode as AppError['code'],
            file: commitFile ?? MIDTERM_REVIEW,
          },
        }
      : {}),
  };
}
