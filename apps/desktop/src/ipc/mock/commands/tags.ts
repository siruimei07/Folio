// Tags (docs/specs/ipc-m1.md §8): definitions in the user's order, and assignments to entries.
// A folder's tags apply to everything below it (§8.2); semester and course folders carry none.
import type { EntryChange } from '../../bindings';
import type { GroupHandlers } from '../contract';
import { eachItem, fail } from '../failure';
import type { FakeLibrary } from '../library';
import { displayName, paletteKey } from '../names';
import { randomHex } from '../random';
import type { FakeShell } from '../shell';

function checkName(library: FakeLibrary, raw: string, except?: string): string {
  const name = displayName(raw);
  const lower = name.toLowerCase();
  if (library.tags.some((tag) => tag.id !== except && tag.name.toLowerCase() === lower)) {
    fail('AlreadyExists', `a tag is named "${name}"`);
  }
  return name;
}

function tagOf(library: FakeLibrary, id: string) {
  const tag = library.tags.find((candidate) => candidate.id === id);
  if (tag === undefined) fail('NotFound', `no tag ${id}`);
  return tag;
}

export function tagCommands(
  shell: FakeShell,
): GroupHandlers<
  'list_tags' | 'create_tag' | 'update_tag' | 'reorder_tags' | 'delete_tag' | 'set_entry_tags'
> {
  const tagOut = (id: string) => {
    const tag = shell.library.tagList().find((candidate) => candidate.id === id);
    if (tag === undefined) fail('Internal', `tag ${id} vanished`);
    return tag;
  };

  return {
    list_tags: () => shell.library.tagList(),

    create_tag: (request) => {
      const library = shell.editable();
      const tag = {
        id: randomHex(8),
        name: checkName(library, request.name),
        color: paletteKey(request.color),
      };
      library.tags.push(tag);
      shell.changed([], { tags: true });
      return tagOut(tag.id);
    },

    update_tag: (request) => {
      const library = shell.editable();
      const tag = tagOf(library, request.id);
      tag.name = checkName(library, request.name, tag.id);
      tag.color = paletteKey(request.color);
      shell.changed([], { tags: true });
      return tagOut(tag.id);
    },

    reorder_tags: (request) => {
      const library = shell.editable();
      const ids = new Set(request.tags);
      if (ids.size !== request.tags.length || ids.size !== library.tags.length) {
        fail('InvalidArgument', 'the order must name every tag exactly once');
      }
      library.tags = request.tags.map((id) => {
        const tag = library.tags.find((candidate) => candidate.id === id);
        if (tag === undefined) fail('InvalidArgument', `no tag ${id}`);
        return tag;
      });
      shell.changed([], { tags: true });
      return library.tagList();
    },

    delete_tag: (request) => {
      const library = shell.editable();
      tagOf(library, request.id);
      library.tags = library.tags.filter((tag) => tag.id !== request.id);
      const changes: EntryChange[] = [];
      for (const node of library.walk(library.root)) {
        if (!node.tags.includes(request.id)) continue;
        node.tags = node.tags.filter((tag) => tag !== request.id);
        changes.push({ kind: 'tagged', entry: library.ref(node) });
      }
      shell.changed(changes, { tags: true });
      return { assignments: changes.length };
    },

    set_entry_tags: (request) => {
      const library = shell.writable();
      if (request.add.some((tag) => request.remove.includes(tag))) {
        fail('InvalidArgument', '`add` and `remove` overlap');
      }
      if (request.add.some((id) => !library.tags.some((tag) => tag.id === id))) {
        fail('InvalidArgument', '`add` names a tag that is not defined');
      }
      const changes: EntryChange[] = [];
      const result = eachItem(request.entries, (entry) => {
        const node = library.resolve(entry);
        if (library.isGroup(node)) fail('InvalidArgument', 'semester and course folders carry no tags');
        if (library.info.readOnly) fail('ReadOnly', 'a newer Folio wrote the metadata');
        const tags = [...new Set([...node.tags, ...request.add])].filter(
          (tag) => !request.remove.includes(tag),
        );
        if (tags.length !== node.tags.length || tags.some((tag) => !node.tags.includes(tag))) {
          node.tags = tags;
          changes.push({ kind: 'tagged', entry: library.ref(node) });
        }
      });
      if (changes.length > 0) shell.changed(changes);
      return result;
    },
  };
}
