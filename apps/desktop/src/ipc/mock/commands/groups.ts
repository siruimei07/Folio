// Semesters and courses (docs/specs/ipc-m1.md §7): folders directly in the library and directly
// in a semester, with settings that follow them when they move.
import type { EntryRef } from '../../bindings';
import type { GroupHandlers } from '../contract';
import { fail } from '../failure';
import { type FakeLibrary, type FakeNode, freshFields } from '../library';
import { badge, courseCode, fileName, paletteKey } from '../names';
import type { FakeShell } from '../shell';

function semesterOf(library: FakeLibrary, ref: EntryRef): FakeNode {
  const node = library.resolve(ref);
  if (!library.isSemester(node)) fail('InvalidArgument', `"${node.path}" is not a semester`);
  return node;
}

function courseOf(library: FakeLibrary, ref: EntryRef): FakeNode {
  const node = library.resolve(ref);
  if (!library.isCourse(node)) fail('InvalidArgument', `"${node.path}" is not a course`);
  return node;
}

/** A course's badge, code and colour as the user typed them, checked (§7, §16.3). */
function courseSettings(request: { abbr: string | null; code: string | null; color: string | null }) {
  return {
    abbr: badge(request.abbr),
    code: courseCode(request.code),
    color: request.color === null ? null : paletteKey(request.color),
  };
}

/** The folders of `parent` in the order `refs` gives: each exactly once, or `InvalidArgument`. */
function newOrder(library: FakeLibrary, parent: FakeNode, refs: EntryRef[]): FakeNode[] {
  const nodes = refs.map((ref) => library.resolve(ref));
  const all = library.groupsIn(parent);
  const once = new Set(nodes);
  if (once.size !== nodes.length || nodes.length !== all.length || !all.every((n) => once.has(n))) {
    fail('InvalidArgument', 'the order must name every folder exactly once');
  }
  return nodes;
}

export function groupCommands(
  shell: FakeShell,
): GroupHandlers<
  | 'list_semesters'
  | 'create_semester'
  | 'update_semester'
  | 'reorder_semesters'
  | 'list_courses'
  | 'create_course'
  | 'update_course'
  | 'reorder_courses'
> {
  /** A new semester or course folder, last in its parent's order. */
  const createGroup = (parent: FakeNode, rawName: string): FakeNode => {
    const library = shell.editable();
    const name = fileName(rawName, { atRoot: parent === library.root });
    if (library.clash(parent, name)) fail('AlreadyExists', `"${name}" is taken`);
    const node = library.add(parent, name, freshFields('folder', shell.now()));
    library.reorder([...library.groupsIn(parent).filter((other) => other !== node), node]);
    return node;
  };

  return {
    list_semesters: () => {
      const library = shell.library;
      return library.groupsIn(library.root).map((node) => library.semester(node));
    },

    create_semester: (request) => {
      const node = createGroup(shell.editable().root, request.name);
      shell.changed([{ kind: 'added', entry: shell.library.ref(node) }], { groups: true });
      return shell.library.semester(node);
    },

    update_semester: (request) => {
      const library = shell.editable();
      const node = semesterOf(library, request.semester);
      library.settings(node).archived = request.archived;
      shell.changed([], { groups: true });
      return library.semester(node);
    },

    reorder_semesters: (request) => {
      const library = shell.editable();
      library.reorder(newOrder(library, library.root, request.semesters));
      shell.changed([], { groups: true });
      return library.groupsIn(library.root).map((node) => library.semester(node));
    },

    list_courses: (request) => {
      const library = shell.library;
      const semesters =
        request.semester === null
          ? library.groupsIn(library.root)
          : [semesterOf(library, request.semester)];
      return semesters.flatMap((semester) =>
        library.groupsIn(semester).map((node) => library.course(node)),
      );
    },

    create_course: (request) => {
      const library = shell.editable();
      const semester = semesterOf(library, request.semester);
      const settings = courseSettings(request);
      const node = createGroup(semester, request.name);
      Object.assign(library.settings(node), settings);
      shell.changed([{ kind: 'added', entry: library.ref(node) }], { groups: true });
      return library.course(node);
    },

    update_course: (request) => {
      const library = shell.editable();
      const node = courseOf(library, request.course);
      const settings = courseSettings(request);
      Object.assign(library.settings(node), { ...settings, archived: request.archived });
      shell.changed([], { groups: true });
      return library.course(node);
    },

    reorder_courses: (request) => {
      const library = shell.editable();
      const semester = semesterOf(library, request.semester);
      library.reorder(newOrder(library, semester, request.courses));
      shell.changed([], { groups: true });
      return library.groupsIn(semester).map((node) => library.course(node));
    },
  };
}
