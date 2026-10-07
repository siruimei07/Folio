import '../tree/Tree.css';
import './FolderPicker.css';

import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { type CSSProperties, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { TreeRow } from '../../components/collections/VirtualTree';
import { VirtualTree } from '../../components/collections/VirtualTree';
import { CourseBadge } from '../../components/CourseBadge/CourseBadge';
import { CourseLabel } from '../../components/CourseLabel/CourseLabel';
import { Select } from '../../components/Select/Select';
import { SelectionIndicator } from '../../components/SelectionIndicator/SelectionIndicator';
import { type FolderPages, useFolderChildren } from '../../data/entries';
import { useCourses, useSemesters } from '../../data/groups';
import { LIST_PAGE } from '../../data/paged';
import type { Course, EntryRef } from '../../ipc';
import { courseLabel } from '../../lib/courses';
import { isInside, nameOf, openPathsTo, parentOf } from '../../lib/paths';
import { SIZE, SPACE } from '../../tokens/tokens';
import { refOf } from '../selecting';
import { TREE_SORT } from '../tree/useTreeData';
import { canTake } from './useDragMove';

type PickerRow =
  | { kind: 'course'; key: string; course: Course; level: 1; posinset: number; setsize: number }
  | { kind: 'folder'; key: string; ref: EntryRef; level: number; posinset: number; setsize: number }
  | { kind: 'loading'; key: string; level: number; posinset: number; setsize: number };

export interface FolderPickerProps {
  /** The semester shown first. */
  semester: string | null;
  /** What is being moved: those folders and everything below them cannot be chosen. */
  moving: readonly EntryRef[];
  chosen: EntryRef | null;
  onChoose: (folder: EntryRef) => void;
}

/**
 * The folder picker (library-actions handoff §2.9): a semester select, then that semester's
 * courses with their folders as a tree. The folder the items are in reads "Already here"; a
 * moved folder and everything below it cannot be chosen (`InvalidMove`). Enter, a click or a
 * double-click chooses. Semesters are never targets: a folder moved into one becomes a course.
 */
export function FolderPicker({ semester: initialSemester, moving, chosen, onChoose }: FolderPickerProps) {
  const { t } = useTranslation('library');
  const semesters = useSemesters().data ?? [];
  const [semester, setSemester] = useState(initialSemester ?? semesters[0]?.folder.path ?? null);
  const semesterCourses = useCourses(semester).data;
  const courses = useMemo(() => semesterCourses ?? [], [semesterCourses]);
  // Nothing moves when files are imported (`moving` is empty): no folder is "Already here".
  const here =
    moving.length > 0 && moving.every((entry) => parentOf(entry.path) === parentOf(moving[0]?.path ?? ''))
      ? parentOf(moving[0]?.path ?? '')
      : null;
  // The folders down to where the items are, or to the chosen folder, start open, so it shows.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(openPathsTo(here ?? (chosen === null ? '' : parentOf(chosen.path)))),
  );
  const [focused, setFocused] = useState<number | null>(null);

  // Children of expanded courses and folders; only their folders show, which come first.
  const [pages, setPages] = useState<ReadonlyMap<string, number>>(new Map());
  const refs = useMemo(() => {
    const known = new Map<string, EntryRef>();
    for (const course of courses) known.set(course.folder.path, course.folder);
    return known;
  }, [courses]);
  const [found, setFound] = useState<ReadonlyMap<string, EntryRef>>(new Map());
  const requests = useMemo<FolderPages[]>(() => {
    const out: FolderPages[] = [];
    for (const path of expanded) {
      const ref = refs.get(path) ?? found.get(path);
      if (ref === undefined) continue;
      const last = pages.get(ref.id) ?? 0;
      out.push({ folder: ref, pages: Array.from({ length: last + 1 }, (_, page) => page) });
    }
    return out;
  }, [expanded, refs, found, pages]);
  const lists = useFolderChildren(requests, TREE_SORT);

  const rows = useMemo(() => {
    const out: PickerRow[] = [];
    const listOf = new Map(requests.map(({ folder }, index) => [folder.id, lists[index]]));
    const folders = (ref: EntryRef, level: number) => {
      const list = listOf.get(ref.id);
      if (list?.total === undefined) {
        out.push({ kind: 'loading', key: `loading:${ref.id}`, level, posinset: 1, setsize: 1 });
        return;
      }
      const children: EntryRef[] = [];
      for (let index = 0; index < list.total; index++) {
        const row = list.rowAt(index);
        if (row?.kind !== 'folder') break;
        children.push(refOf(row));
      }
      children.forEach((child, index) => {
        out.push({ kind: 'folder', key: child.id, ref: child, level, posinset: index + 1, setsize: children.length });
        if (expanded.has(child.path)) folders(child, level + 1);
      });
    };
    courses.forEach((course, index) => {
      out.push({ kind: 'course', key: course.folder.id, course, level: 1, posinset: index + 1, setsize: courses.length });
      if (expanded.has(course.folder.path)) folders(course.folder, 2);
    });
    return out;
  }, [courses, expanded, requests, lists]);

  // Learn the ids of folders as they load, and ask for the next page while a page holds only
  // folders: state derived from the last render's pages, adjusted while rendering.
  const learned = new Map(found);
  const more = new Map(pages);
  requests.forEach(({ folder }, index) => {
    const list = lists[index];
    if (list?.total === undefined) return;
    let count = 0;
    for (; count < list.total; count++) {
      const row = list.rowAt(count);
      if (row?.kind !== 'folder') break;
      learned.set(row.path, refOf(row));
    }
    const loadedPages = pages.get(folder.id) ?? 0;
    if (count === (loadedPages + 1) * LIST_PAGE && count < list.total) more.set(folder.id, loadedPages + 1);
  });
  if (learned.size !== found.size) setFound(learned);
  if ([...more].some(([id, page]) => pages.get(id) !== page)) setPages(more);

  const folderOfRow = (row: PickerRow): EntryRef | null =>
    row.kind === 'course' ? row.course.folder : row.kind === 'folder' ? row.ref : null;
  const blocked = (ref: EntryRef) => !canTake(ref, moving);
  const choose = (index: number) => {
    const row = rows[index];
    const ref = row === undefined ? null : folderOfRow(row);
    if (ref !== null && !blocked(ref)) onChoose(ref);
  };
  const toggle = (index: number, open: boolean) => {
    const row = rows[index];
    const ref = row === undefined ? null : folderOfRow(row);
    if (ref === null) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(ref.path);
      else for (const path of current) if (isInside(path, ref.path)) next.delete(path);
      return next;
    });
  };

  const treeRow = (index: number): TreeRow => {
    const row = rows[index];
    if (row === undefined || row.kind === 'loading') {
      return { key: row?.key ?? String(index), kind: 'item', focusable: false, level: row?.level ?? 1, posinset: 1, setsize: 1, selected: false, busy: true };
    }
    const ref = folderOfRow(row) ?? { id: '', path: '' };
    return {
      key: row.key,
      kind: 'item',
      focusable: true,
      disabled: blocked(ref),
      level: row.level,
      posinset: row.posinset,
      setsize: row.setsize,
      expanded: expanded.has(ref.path),
      selected: chosen?.id === ref.id,
      name: row.kind === 'course' ? courseLabel(row.course) : nameOf(row.ref.path),
      label:
        ref.path === here
          ? `${row.kind === 'course' ? courseLabel(row.course) : nameOf(ref.path)}, ${t('move.alreadyHere')}`
          : undefined,
    };
  };

  const semesterName = semesters.find((candidate) => candidate.folder.path === semester)?.name ?? '';
  const options = semesters
    .map((candidate) => ({ id: candidate.folder.path, label: candidate.name }))
    .sort((a, b) => (a.id === initialSemester ? -1 : b.id === initialSemester ? 1 : 0));

  return (
    <div className="folder-picker">
      <Select
        label={t('move.semester')}
        options={options}
        selected={semester}
        onChange={(path) => {
          setSemester(path);
          setFocused(null);
        }}
      />
      {courses.length === 0 ? (
        <p className="folder-picker__empty">{t('move.noCourses', { semester: semesterName })}</p>
      ) : (
        <VirtualTree
          label={t('move.places', { semester: semesterName })}
          multiselectable={false}
          className="folder-picker__tree"
          count={rows.length}
          rowAt={treeRow}
          rowHeight={() => SIZE.row}
          padding={SPACE[4]}
          focusedIndex={focused}
          onNavigate={(index) => {
            setFocused(index);
          }}
          onToggle={choose}
          onExpand={toggle}
          onAction={choose}
          onRowClick={(index) => {
            setFocused(index);
            choose(index);
          }}
          onRowDoubleClick={choose}
          renderRow={(index, row) => {
            const item = rows[index];
            if (item === undefined || item.kind === 'loading') {
              return (
                <div className="tree-row" style={{ '--depth': item?.level === undefined ? 0 : item.level - 1 } as CSSProperties}>
                  <span className="tree-row__placeholder" />
                </div>
              );
            }
            const ref = folderOfRow(item) ?? { id: '', path: '' };
            const Chevron = row.expanded === true ? ChevronDown : ChevronRight;
            const FolderIcon = row.expanded === true ? FolderOpen : Folder;
            return (
              <div
                className="tree-row"
                data-selected={row.selected || undefined}
                data-disabled={row.disabled === true || undefined}
                style={{ '--depth': item.level - 1 } as CSSProperties}
              >
                {row.selected && <SelectionIndicator />}
                <span className="tree-row__chevron" aria-hidden>
                  <Chevron size={SIZE.iconSmall} />
                </span>
                {item.kind === 'course' ? (
                  <>
                    <CourseBadge course={item.course} />
                    <span className="tree-row__name tree-row__name--course">
                      <CourseLabel course={item.course} />
                    </span>
                  </>
                ) : (
                  <>
                    <FolderIcon aria-hidden size={SIZE.icon} className="tree-row__icon" />
                    <span className="tree-row__name">{nameOf(item.ref.path)}</span>
                  </>
                )}
                {ref.path === here && <span className="folder-picker__here">{t('move.alreadyHere')}</span>}
              </div>
            );
          }}
        />
      )}
    </div>
  );
}
