// Files dragged from File Explorer onto the Library (library-actions handoff §3): the shell reports
// where they hover (DropHover) and where they land (FilesDropped, with a choice token). The target
// is the course or folder row under the pointer, a file row's folder, and anywhere else the current
// folder, shown on the preview. A drop opens the import dialog of `feat/ui-import` through the
// navigation store, with the tag filter's tags.
import i18n from 'i18next';
import { useEffect, useEffectEvent, useRef } from 'react';
import { create } from 'zustand';

import { showFailure } from '../../app/feedback';
import { useLayout } from '../../app/layout';
import { openDialog, useNavigation } from '../../app/navigation';
import { showToast } from '../../app/toasts';
import { isModalOpen } from '../../components/Dialog/Dialog';
import { isPopoverOpen } from '../../components/Popover/Popover';
import { useCourses } from '../../data/groups';
import { useDropFailed, useDropHoverEvents, useFilesDropped } from '../../data/import';
import { useJobActive } from '../../data/jobs';
import type { CurrentSemester } from '../../data/semester';
import { type Course, type EntryRef, LIMITS, type Point } from '../../ipc';
import { courseIn } from '../../lib/places';
import { EXPAND_AFTER_MS } from '../../lib/timing';
import { treeIndexAt } from '../tree/hit';
import { entryOf, isCollapsed, keyOf, type TreeItem, type TreeModel } from '../tree/layout';
import { type Active, setExpanded, useLibraryView } from '../state';

/** Where dropped files would go, and where that shows. */
export type DropTarget =
  /** The course or folder row under the pointer, or a file row's folder. */
  | { kind: 'row'; folder: EntryRef }
  /** The current folder, on the preview (or the visible panel of a narrow window); `null`: none. */
  | { kind: 'panel'; folder: EntryRef | null };

/** A row of the tree under a point that can take files. */
interface RowTarget {
  folder: EntryRef;
  /** Set when the row is a collapsed course or folder, which opens after a while. */
  collapsed: string | null;
}

interface FileDropState {
  target: DropTarget | null;
  /** The tree's row under a point, while a tree is on screen (`useDropRows`). */
  rowAt: ((point: Point) => RowTarget | null) | null;
  /** The folder an entry of the tree is in, while its row is loaded. */
  folderOf: ((id: string) => EntryRef | null) | null;
}

export const useFileDropState = create<FileDropState>()(() => ({ target: null, rowAt: null, folderOf: null }));

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.folder?.id === b.folder?.id;
}

/**
 * Lets the drop target find the tree's course and folder rows, and returns the row's drop look:
 * "Add here" on the target row (§3). Only a change of target row re-renders the tree.
 */
export function useDropRows(layout: TreeModel): (item: TreeItem) => 'add' | null {
  // DropHover repeats while the pointer stays on a row: the last row's answer is kept.
  const last = useRef<{ layout: TreeModel; index: number; row: RowTarget | null } | null>(null);
  const rowAt = useEffectEvent(({ x, y }: Point): RowTarget | null => {
    const index = treeIndexAt(x, y, layout.count);
    if (index === null) return null;
    if (last.current?.layout === layout && last.current.index === index) return last.current.row;
    // The course or folder itself, else the folder a file is in; nothing outside courses.
    const folder = layout.folderAt(index);
    const row = folder === null ? null : { folder, collapsed: isCollapsed(layout.rowAt(index)) ? folder.path : null };
    last.current = { layout, index, row };
    return row;
  });
  const folderOf = useEffectEvent((id: string): EntryRef | null => {
    const index = layout.indexOfKey(keyOf.entry(id));
    return index === null ? null : layout.folderAt(index);
  });
  useEffect(() => {
    useFileDropState.setState({ rowAt: (point) => rowAt(point), folderOf: (id) => folderOf(id) });
    return () => {
      useFileDropState.setState({ rowAt: null, folderOf: null });
    };
  }, []);
  const targetRow = useFileDropState((state) => (state.target?.kind === 'row' ? state.target.folder.id : null));
  return (item) => (targetRow !== null && entryOf(item)?.id === targetRow ? 'add' : null);
}

/** Why files cannot be added now, or `null` when they can (§3). */
function blockedBy(rebuilding: boolean): 'dialog' | 'menu' | 'rebuild' | null {
  if (useNavigation.getState().dialog !== null || isModalOpen()) return 'dialog';
  if (useLibraryView.getState().menu !== null || isPopoverOpen()) return 'menu';
  return rebuilding ? 'rebuild' : null;
}

/**
 * The current folder (§3): the course or folder shown, a shown file's folder, else the course
 * last shown while it is still among the semester's courses.
 */
function currentFolder(courses: readonly Course[], last: EntryRef | null): EntryRef | null {
  const active = useLibraryView.getState().active;
  if (active?.kind === 'folder') return active.entry;
  if (active?.kind === 'file') {
    // Its folder from the tree, while its row is loaded; else its course.
    const folder = useFileDropState.getState().folderOf?.(active.entry.id) ?? null;
    return folder ?? courseIn(active.entry.path, courses)?.folder ?? null;
  }
  return last !== null && courses.some((course) => course.folder.id === last.id) ? last : null;
}

/** The toast for a drop that adds nothing, by why (§3). */
const BLOCKED_TOASTS = {
  dialog: 'import:drop.closeDialog',
  menu: 'import:drop.closeMenu',
  rebuild: 'import:drop.rebuilding',
} as const;

/** What stays the same during one drag: nothing opens and the selection stays while Windows drags. */
interface Drag {
  blocked: boolean;
  folder: EntryRef | null;
}

/**
 * The Library's drop target while files are dragged over the window, and the import dialog when
 * they are dropped. Nothing shows, and a drop adds nothing, while a dialog, search or a menu is
 * open or the index is rebuilt; a toast says why. A drop the shell could not take says why too.
 * DropHover arrives many times a second and re-renders nothing: only a new target does.
 */
export function useFileDrop(info: CurrentSemester): void {
  const narrow = useLayout() === 'narrow';
  const rebuilding = useJobActive('rebuild');
  const courses = useCourses(info.semester?.folder.path ?? null).data;
  const lastCourse = useRef<EntryRef | null>(null);
  const drag = useRef<Drag | null>(null);
  /** The collapsed row that opens if it stays the target. */
  const expanding = useRef<{ path: string; timer: number } | null>(null);

  // "The course last selected" for quick views and an empty selection, without re-rendering.
  const remember = useEffectEvent((active: Active) => {
    if (active === null || active.kind === 'quick') return;
    const course = courseIn(active.entry.path, courses ?? []);
    if (course !== undefined) lastCourse.current = course.folder;
  });
  useEffect(() => {
    remember(useLibraryView.getState().active);
    return useLibraryView.subscribe((state, previous) => {
      if (state.active !== previous.active) remember(state.active);
    });
  }, []);

  /** The target at a point, by the rules above, and the collapsed row there. */
  const targetOf = (point: Point, folder: EntryRef | null): { target: DropTarget; collapsed: string | null } => {
    const { rowAt } = useFileDropState.getState();
    // A narrow window drops into the current folder only (§14).
    const row = narrow || rowAt === null ? null : rowAt(point);
    if (row !== null) return { target: { kind: 'row', folder: row.folder }, collapsed: row.collapsed };
    return { target: { kind: 'panel', folder }, collapsed: null };
  };
  const startDrag = (): Drag => ({
    blocked: blockedBy(rebuilding) !== null,
    folder: currentFolder(courses ?? [], lastCourse.current),
  });

  const stopExpanding = () => {
    if (expanding.current !== null) window.clearTimeout(expanding.current.timer);
    expanding.current = null;
  };

  useDropHoverEvents((position) => {
    if (position === null) drag.current = null;
    else drag.current ??= startDrag();
    const current = drag.current;
    const found = position === null || current === null || current.blocked ? null : targetOf(position, current.folder);
    const target = found?.target ?? null;
    if (!sameTarget(useFileDropState.getState().target, target)) useFileDropState.setState({ target });
    // A collapsed course or folder that stays the target opens after a while; moving within it
    // keeps the timer.
    const path = found?.collapsed ?? null;
    if (path === expanding.current?.path) return;
    stopExpanding();
    if (path === null) return;
    expanding.current = {
      path,
      timer: window.setTimeout(() => {
        expanding.current = null;
        setExpanded(path, true);
      }, EXPAND_AFTER_MS),
    };
  });

  // Leaving the Library takes the target away.
  useEffect(
    () => () => {
      stopExpanding();
      useFileDropState.setState({ target: null });
    },
    [],
  );

  useFilesDropped(({ source, position }) => {
    stopExpanding();
    drag.current = null;
    useFileDropState.setState({ target: null });
    const reason = blockedBy(rebuilding);
    // The token is left to expire.
    if (reason !== null) {
      showToast({ tone: 'info', title: i18n.t(BLOCKED_TOASTS[reason]) });
      return;
    }
    const { target } = targetOf(position, startDrag().folder);
    openDialog('import', { source, target: target.folder, tags: useLibraryView.getState().filter });
  });

  useDropFailed(({ error }) => {
    if (error.code === 'NoLibrary') return;
    if (error.code === 'Busy') {
      showToast({ tone: 'info', title: i18n.t('import:drop.rebuilding') });
      return;
    }
    const body =
      error.code === 'InvalidArgument' ? i18n.t('import:drop.tooMany', { limit: LIMITS.batch }) : undefined;
    showFailure(i18n.t('import:drop.failed'), error, 'library.drop', body);
  });
}
