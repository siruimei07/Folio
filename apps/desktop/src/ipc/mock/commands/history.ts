// History, diffs of commits and restore (docs/specs/ipc-m2.md §8–§10), on the model in
// `versioning/`. Reword, uncommit and restore answer when done and send HistoryChanged and
// WorkspaceChanged.
import type { GroupHandlers } from '../contract';
import type { FakeShell } from '../shell';

export function historyCommands(
  shell: FakeShell,
): GroupHandlers<
  | 'list_history'
  | 'get_commit'
  | 'list_commit_changes'
  | 'list_commit_metadata'
  | 'list_file_history'
  | 'locate_version'
  | 'reword_commit'
  | 'uncommit'
  | 'get_version_diff'
  | 'plan_restore'
  | 'restore_version'
> {
  return {
    list_history: (request) => shell.versioning.historyPage(request.page, request.types),

    get_commit: (request) => shell.versioning.getCommit(request.commit),

    list_commit_changes: (request) => shell.versioning.changesPage(request.commit, request.page),

    list_commit_metadata: (request) => shell.versioning.commitMetadataPage(request.commit, request.page),

    list_file_history: (request) => shell.versioning.fileHistory(request.file, request.page, request.types),

    locate_version: (request) => shell.versioning.locate(request),

    reword_commit: (request) => {
      shell.writable();
      return shell.versioning.reword(request.commit, request.summary, request.body);
    },

    uncommit: (request) => {
      shell.writable();
      shell.versioning.uncommit(request.commit);
      return null;
    },

    get_version_diff: (request) => shell.versioning.versionDiff(request.commit, request.key, request.window),

    plan_restore: (request) => {
      const { outcome, target, recycle, current } = shell.versioning.planRestore(request);
      return { outcome, target, recycle, current };
    },

    restore_version: (request) => {
      shell.writable();
      return shell.versioning.restore(request);
    },
  };
}
