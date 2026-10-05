// The workspace and commits (docs/specs/ipc-m2.md §6, §7, §9). The model in `versioning/` holds the
// items; a commit runs as a job (kind `commit`, or `firstCommit` for `start_history`) with progress
// in files and bytes, and ends with HistoryChanged and WorkspaceChanged.
import type { GroupHandlers } from '../contract';
import { appError, ShellFailure } from '../failure';
import type { FakeShell } from '../shell';
import type { CommitPlan } from '../versioning/model';

export function workspaceCommands(
  shell: FakeShell,
): GroupHandlers<
  | 'get_workspace'
  | 'list_workspace_items'
  | 'list_metadata_changes'
  | 'summarize_selection'
  | 'commit'
  | 'start_history'
  | 'get_workspace_diff'
> {
  return {
    get_workspace: () => shell.versioning.summary(),

    list_workspace_items: (request) => shell.versioning.itemPage(request.page),

    list_metadata_changes: (request) => shell.versioning.metadataPage(request.page),

    summarize_selection: (request) => shell.versioning.summarize(request.selection, request.fingerprint),

    commit: (request) => {
      shell.editable(); // `Busy` while a rebuild runs, `ReadOnly` for newer metadata
      return startCommitJob(shell, shell.versioning.beginCommit(request));
    },

    start_history: (request) => {
      shell.editable();
      return startCommitJob(shell, shell.versioning.beginFirstCommit(request.summary));
    },

    get_workspace_diff: (request) => shell.versioning.workspaceDiff(request.key, request.window),
  };
}

/** Runs a commit as a job: reading the files in steps, then the switch (ipc-m2 §7.1, §13). */
function startCommitJob(shell: FakeShell, plan: CommitPlan): string {
  const versioning = shell.versioning;
  const failure = shell.takeCommitFailure() ?? plan.blocked;
  return shell.startJob(plan.first ? 'firstCommit' : 'commit', {
    cancellable: true,
    total: Math.max(1, plan.reads.length),
    step: Math.max(1, Math.ceil(plan.reads.length / 8)),
    bytes: plan.bytes,
    finalStep: true,
    ...(plan.first ? { waitFor: ['scan' as const, 'hash' as const] } : {}),
    current: (done) => plan.reads[done] ?? null,
    finish: () => {
      if (failure !== null) {
        const detail = `${failure.file ?? 'the commit'} failed (fake shell)`;
        throw new ShellFailure(appError(failure.code, detail), failure.file);
      }
      const commit = versioning.recordCommit(plan);
      return plan.first
        ? {
            kind: 'firstCommit',
            commit: commit.id,
            files: commit.changes.filter((entry) => entry.kind === 'file').length,
            left: plan.left.length,
          }
        : {
            kind: 'commit',
            commit: commit.id,
            summary: plan.summary,
            changes: plan.items.length + plan.metadata.length,
          };
    },
    onEnd: (status) => {
      if (status.state !== 'done') versioning.abortCommit(plan);
    },
  });
}
