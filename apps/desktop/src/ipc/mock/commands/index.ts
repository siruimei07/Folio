// Every command of the bindings, one file per command group. `Handlers` requires all of them, so
// `tsc` fails when the bindings gain a command the fake does not answer.
import type { Handlers } from '../contract';
import type { FakeShell } from '../shell';
import { aiCommands } from './ai';
import { appCommands } from './app';
import { entryCommands } from './entries';
import { fileCommands } from './files';
import { groupCommands } from './groups';
import { historyCommands } from './history';
import { importCommands } from './import';
import { jobCommands } from './jobs';
import { libraryCommands } from './library';
import { searchCommands } from './search';
import { settingsCommands } from './settings';
import { tagCommands } from './tags';
import { workspaceCommands } from './workspace';

export function createHandlers(shell: FakeShell): Handlers {
  return {
    ...appCommands(shell),
    ...libraryCommands(shell),
    ...groupCommands(shell),
    ...tagCommands(shell),
    ...entryCommands(shell),
    ...searchCommands(shell),
    ...fileCommands(shell),
    ...importCommands(shell),
    ...jobCommands(shell),
    ...settingsCommands(shell),
    ...workspaceCommands(shell),
    ...historyCommands(shell),
    ...aiCommands(shell),
  };
}
