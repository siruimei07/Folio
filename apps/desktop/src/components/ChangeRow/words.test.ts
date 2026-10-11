// The words a change row says (workspace-history handoff §3.2–§3.5, §6.1, §7.2), shared by the
// Changes list, History's file cards and the diff header.
import i18n from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChangeKind, MetadataSubject } from '../../ipc';
import { LINEAR, MAT } from '../../test/courses';
import {
  CHANGE_ROW_TAGS,
  changeRowIcon,
  changeStatusOf,
  joinRowLabel,
  type MetadataTitle,
  metadataTitle,
  rowPath,
  wholePath,
} from './words';

const COURSES = [MAT, LINEAR];

/** A title as the views show it, with `common`'s strings. */
function shown(title: MetadataTitle): string {
  return i18n.t(title.key, title.values ?? {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('changeStatusOf', () => {
  it('shows a move as renamed and every other change as itself', () => {
    const changes: ChangeKind[] = ['added', 'modified', 'deleted', 'moved'];
    expect(changes.map(changeStatusOf)).toEqual(['added', 'modified', 'deleted', 'renamed']);
  });
});

describe('changeRowIcon', () => {
  it("gives a file its type icon by name, whatever the change, and the name is the path's last part", () => {
    expect(changeRowIcon({ kind: 'file', path: 'Fall 2026/MAT232/ps2.pdf', change: 'moved' })).toEqual({ kind: 'file', name: 'ps2.pdf' });
    expect(changeRowIcon({ kind: 'file', path: '笔记/第一章.md', change: 'added' })).toEqual({ kind: 'file', name: '第一章.md' });
  });

  it('opens a moved folder and closes every other', () => {
    expect(changeRowIcon({ kind: 'folder', path: 'Fall 2026/Exams', change: 'moved' })).toEqual({ kind: 'folderOpen' });
    for (const change of ['added', 'modified', 'deleted'] as const) {
      expect(changeRowIcon({ kind: 'folder', path: 'Fall 2026/Exams', change })).toEqual({ kind: 'folder' });
    }
  });
});

// How a folder's code and folders split is headingPrefix's (PathHeading.test.tsx); a row adds the
// name after them.
describe('rowPath and wholePath', () => {
  it("puts the name, kept whole, after its folder's heading prefix", () => {
    const path = rowPath(`${MAT.folder.path}/习题/第一章.md`, COURSES);
    expect(path).toEqual({ label: 'MAT232/', prefix: '习题/', name: '第一章.md' });
    expect(wholePath(path)).toBe('MAT232/习题/第一章.md');
  });

  it('has only the name at the top', () => {
    expect(rowPath('notes.md', COURSES)).toEqual({ label: '', prefix: '', name: 'notes.md' });
    expect(wholePath({ label: '', prefix: '', name: 'Ignore rules' })).toBe('Ignore rules');
  });
});

describe('joinRowLabel', () => {
  it('joins the parts as a short unit list in the given language', () => {
    const spy = vi.spyOn(Intl, 'ListFormat');
    expect(joinRowLabel('en', ['MAT232/ps2.md', 'Added', '2 changes'])).toBe('MAT232/ps2.md, Added, 2 changes');
    expect(spy).toHaveBeenLastCalledWith('en', { type: 'unit', style: 'short' });
    expect(joinRowLabel('de', ['MAT232/ps2.md', 'Added', '2 changes'])).toBe(
      new Intl.ListFormat('de', { type: 'unit', style: 'short' }).format(['MAT232/ps2.md', 'Added', '2 changes']),
    );
    expect(spy).toHaveBeenCalledWith('de', { type: 'unit', style: 'short' });
    expect(joinRowLabel('en', ['线性代数/第一章.md'])).toBe('线性代数/第一章.md');
  });
});

describe('metadataTitle', () => {
  const cases: { subject: Exclude<MetadataSubject, { kind: 'tags' }>; icon: string; key: string; text: string }[] = [
    {
      subject: { kind: 'semester', path: 'Fall 2026', folder: null },
      icon: 'settings',
      key: 'common:changeRow.semesterSettings',
      text: 'Fall 2026 semester settings',
    },
    {
      subject: { kind: 'course', path: MAT.folder.path, folder: null },
      icon: 'settings',
      key: 'common:changeRow.courseSettings',
      text: 'MAT232 course settings',
    },
    { subject: { kind: 'tagDefinitions' }, icon: 'tags', key: 'common:changeRow.tagDefinitions', text: 'Tag definitions' },
    { subject: { kind: 'library' }, icon: 'settings', key: 'common:changeRow.librarySettings', text: 'Library settings' },
    { subject: { kind: 'ignoreRules' }, icon: 'fileCog', key: 'common:changeRow.ignoreRules', text: 'Ignore rules' },
  ];

  it.each(cases)('names a $subject.kind change with its icon and a common key', ({ subject, icon, key, text }) => {
    const { icon: got, title } = metadataTitle(subject, COURSES);
    expect(got).toEqual({ kind: icon });
    expect(title.key).toBe(key);
    expect(shown(title)).toBe(text);
  });

  it('names a listed course folder by its label, and an unlisted one or a folder inside a course by its name', () => {
    expect(metadataTitle({ kind: 'course', path: MAT.folder.path, folder: null }, COURSES).title.values).toEqual({ name: 'MAT232' });
    const unlisted = metadataTitle({ kind: 'course', path: 'Fall 2026/PHL100 Ethics', folder: null }, COURSES).title;
    expect(shown(unlisted)).toBe('PHL100 Ethics course settings');
    const inside = metadataTitle({ kind: 'course', path: `${MAT.folder.path}/Labs`, folder: null }, COURSES).title;
    expect(inside.values).toEqual({ name: 'Labs' });
  });

  it('keeps Chinese names', () => {
    expect(shown(metadataTitle({ kind: 'course', path: LINEAR.folder.path, folder: null }, COURSES).title)).toBe('线性代数 course settings');
    expect(shown(metadataTitle({ kind: 'semester', path: '2026 秋季', folder: null }, COURSES).title)).toBe('2026 秋季 semester settings');
  });

  it('has no values for a title without a name', () => {
    expect(metadataTitle({ kind: 'library' }, COURSES).title).toEqual({ key: 'common:changeRow.librarySettings' });
  });
});

describe('CHANGE_ROW_TAGS', () => {
  it('is the "Tags" tag of common', () => {
    expect(CHANGE_ROW_TAGS).toBe('common:changeRow.tags');
    expect(i18n.t(CHANGE_ROW_TAGS)).toBe('Tags');
  });
});
