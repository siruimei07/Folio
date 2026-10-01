// Jobs and problems (docs/specs/ipc-m1.md §13, §14; library-state.md "Jobs, commits and problems").
import type { GroupHandlers } from '../contract';
import { checkPage } from '../library';
import type { FakeShell } from '../shell';

export function jobCommands(
  shell: FakeShell,
): GroupHandlers<'list_jobs' | 'cancel_job' | 'rebuild_catalog' | 'list_problems'> {
  return {
    list_jobs: () => shell.jobs(),

    cancel_job: (request) => {
      shell.cancelJob(request.job);
      return null;
    },

    rebuild_catalog: () => {
      const library = shell.writable(); // `Busy` while a rebuild runs
      return shell.startJob('rebuild', {
        cancellable: true,
        total: Math.max(1, library.byId.size),
        step: Math.max(1, Math.ceil(library.byId.size / 10)),
        finish: () => {
          // New ids for everything: every reference the UI holds goes stale (ipc-m1 §13).
          const entries = library.renumber();
          shell.changedEverything();
          return { kind: 'rebuild', entries };
        },
      });
    },

    list_problems: (request) => {
      const library = shell.library;
      checkPage(request.page);
      return {
        items: library.problems.slice(request.page.offset, request.page.offset + request.page.limit),
        offset: request.page.offset,
        total: library.problems.length,
        revision: library.revision,
      };
    },
  };
}
