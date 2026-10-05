// AI settings and commit messages (docs/specs/ipc-m2.md §12), on the fake AI service in
// `versioning/ai.ts`. The key goes in and never comes back out: no answer carries it.
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import type { FakeShell } from '../shell';
import { checkRequestId } from '../versioning/ai';

export function aiCommands(
  shell: FakeShell,
): GroupHandlers<
  | 'get_ai_settings'
  | 'update_ai_settings'
  | 'set_ai_key'
  | 'clear_ai_key'
  | 'test_ai'
  | 'generate_commit_message'
  | 'cancel_ai_request'
> {
  return {
    get_ai_settings: () => shell.ai.settings(),

    update_ai_settings: (request) => shell.ai.update(request),

    set_ai_key: (request) => shell.ai.setKey(request.key),

    clear_ai_key: () => shell.ai.clearKey(),

    test_ai: () => shell.ai.test(),

    generate_commit_message: (request) => {
      shell.ai.checkRequest(request.requestId, request.description);
      const versioning = shell.versioning;
      const summary = versioning.summarize(request.selection, request.fingerprint);
      if (summary.items === 0 && summary.metadata === 0) fail('NothingToCommit', 'nothing selected');
      return shell.ai.generate(request.requestId, summary);
    },

    cancel_ai_request: (request) => {
      checkRequestId(request.requestId);
      shell.ai.cancel(request.requestId);
      return null;
    },
  };
}
