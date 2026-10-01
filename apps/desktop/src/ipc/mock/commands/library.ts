// Library commands (docs/specs/ipc-m1.md §6; first-run handoff §4, §7).
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import { presetTags } from '../fixtures/build';
import { displayName } from '../names';
import type { FakeShell } from '../shell';

export function libraryCommands(
  shell: FakeShell,
): GroupHandlers<'library_status' | 'pick_library_folder' | 'create_library' | 'open_library'> {
  return {
    library_status: () => {
      // "Try again": an unavailable library is opened again (it may stay unavailable).
      if (shell.status().state === 'unavailable') shell.retryOpen();
      return shell.status();
    },

    pick_library_folder: () => {
      const picked = shell.pickFolder();
      if (picked === null) return null;
      const { path, content, syncRoot } = picked.script;
      return { token: picked.token, path, content, syncRoot };
    },

    create_library: (request) => {
      const name = displayName(request.name);
      const names = {
        notes: displayName(request.presetTags.notes),
        slides: displayName(request.presetTags.slides),
        homework: displayName(request.presetTags.homework),
        exam: displayName(request.presetTags.exam),
        reference: displayName(request.presetTags.reference),
      };
      const { script } = shell.choice(request.folder, 'library', true);
      const { content } = script;
      if (content.kind === 'library' || content.kind === 'insideLibrary') {
        fail('AlreadyALibrary', `${script.path} is, or is inside, a library`);
      }
      const found = script.library?.();
      // An incomplete library keeps what `.folio/` holds, its tags included (ipc-m1 §6).
      const tags =
        content.kind === 'incomplete' && found !== undefined && found.tags.length > 0
          ? found.tags
          : presetTags(names);
      const library = shell.openLibrary({
        name,
        root: script.path,
        readOnly: false,
        recovered: false,
        tags,
        entries: [],
        problems: [],
      });
      // Taken-over content arrives as the scan finds it, with CatalogChanged.
      const scan = shell.startScan(found?.entries ?? []);
      return { library: { ...library.info }, scan };
    },

    open_library: (request) => {
      const { script } = shell.choice(request.folder, 'library', true);
      const seed = script.library?.();
      if (script.content.kind !== 'library' || seed === undefined) {
        fail('NotALibrary', `${script.path} has no .folio/library.json`);
      }
      const library = shell.openLibrary({ ...seed, root: script.path });
      return { library: { ...library.info }, scan: shell.startScan() };
    },
  };
}
