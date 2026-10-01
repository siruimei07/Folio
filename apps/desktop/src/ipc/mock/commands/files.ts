// Opening files (docs/specs/ipc-m1.md §11.1). Nothing opens: the fake answers as the shell would.
// Programs and shortcuts are `Blocked`; scripts open in their editor; the rest open normally.
// The `folio-file` scheme is not reproduced: previews of media show their error state.
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import { extensionOf } from '../../../lib/file-types';
import type { FakeShell } from '../shell';

const PROGRAMS = new Set(
  (
    'exe com scr pif cpl msi msp msix appx application appref-ms lnk url website hta jar reg scf ' +
    'xll wll xla xlam xlm ppa ppam ppkg vsto xbap'
  ).split(' '),
);
const SCRIPTS = new Set(['bat', 'cmd', 'ps1', 'vbs', 'js', 'wsf', 'py', 'sh']);

export function fileCommands(shell: FakeShell): GroupHandlers<'open_entry' | 'reveal_entry'> {
  return {
    open_entry: (request) => {
      const library = shell.library;
      const node = library.resolve(request.entry);
      if (node.kind === 'folder') return { mode: 'default' };
      const extension = extensionOf(node.name);
      if (PROGRAMS.has(extension)) fail('Blocked', `.${extension} runs code and has no editor`);
      return { mode: SCRIPTS.has(extension) ? 'editor' : 'default' };
    },

    reveal_entry: (request) => {
      shell.library.resolve(request.entry);
      return null;
    },
  };
}
