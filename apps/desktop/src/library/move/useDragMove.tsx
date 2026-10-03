import './DragChip.css';

import { File, Folder } from 'lucide-react';
import { type PointerEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { EntryRef } from '../../ipc';
import { isInside, nameOf, parentOf } from '../../lib/paths';
import { SIZE } from '../../tokens/tokens';
import { useLibraryCommands } from '../commands';
import { type Selected, selectOnly, setExpanded, useLibraryView } from '../state';
import { EXPAND_AFTER_MS } from '../../lib/timing';
import { treeIndexAt } from '../tree/hit';
import { entryOf, isCollapsed, type TreeItem, type TreeModel } from '../tree/layout';

/** The pointer moves this far with the button down before a drag starts (library-actions §7.3). */
const DRAG_THRESHOLD_PX = 4;
/** A click that ends a drag is not a click on the row. */
const CLICK_AFTER_DRAG_MS = 300;

interface Drag {
  entries: readonly Selected[];
  x: number;
  y: number;
  /** The key of the course or folder row under the pointer that would take them. */
  over: string | null;
}

/** Whether `target` can take `entries`: not one of them, not below a moved folder, not where all are. */
export function canTake(target: EntryRef, entries: readonly EntryRef[]): boolean {
  if (entries.some((entry) => isInside(target.path, entry.path))) return false;
  // Nothing moves (an import's picker): every folder can take it.
  return entries.length === 0 || !entries.every((entry) => parentOf(entry.path) === target.path);
}

/**
 * Dragging rows of the tree onto a course or folder moves them (library-actions handoff §7.3).
 * Tauri's native file drop turns off HTML5 drag and drop in the page, so the drag uses pointer
 * events and Folio draws the chip next to the pointer itself. Esc, or releasing away from a
 * target, moves nothing; keyboard users have "Move to…".
 */
export function useDragMove(layout: TreeModel) {
  const { t } = useTranslation('library');
  const commands = useLibraryCommands();
  const [drag, setDrag] = useState<Drag | null>(null);
  const [armed, setArmed] = useState(false);
  const pressed = useRef<{ x: number; y: number; index: number } | null>(null);
  const current = useRef<Drag | null>(null);
  const endedAt = useRef(-Infinity);
  const chipRef = useRef<HTMLDivElement>(null);

  const update = (next: Drag | null) => {
    current.current = next;
    setDrag(next);
  };

  /** The course or folder row under a point that can take the dragged entries. */
  const targetAt = useEffectEvent((x: number, y: number): TreeItem | null => {
    const dragged = current.current;
    const index = treeIndexAt(x, y, layout.count);
    if (dragged === null || index === null) return null;
    const item = layout.rowAt(index);
    const entry = entryOf(item);
    if (entry === null || entry.kind === 'file' || !canTake(entry, dragged.entries)) return null;
    return item;
  });

  const begin = useEffectEvent((x: number, y: number) => {
    const start = pressed.current;
    if (start === null || start.index >= layout.count) return;
    const item = layout.rowAt(start.index);
    const entry = entryOf(item);
    if (entry === null || entry.kind === 'course') return;
    // The drag takes the selection when it starts on a selected row, else that row alone.
    const selection = useLibraryView.getState().panel.entries;
    let entries: Selected[] = [entry];
    if (selection.has(entry.id)) entries = [...selection.values()].filter((selected) => selected.kind !== 'course');
    else selectOnly('panel', item.key, start.index, entry);
    update({ entries, x, y, over: null });
  });

  const drop = useEffectEvent((x: number, y: number) => {
    const dragged = current.current;
    if (dragged === null) return;
    const target = targetAt(x, y);
    const entry = target === null ? null : entryOf(target);
    if (entry !== null) commands.move(dragged.entries, entry);
  });

  useEffect(() => {
    if (!armed) return undefined;
    let expandTimer: number | undefined;
    let hovered: string | null = null;

    const finish = (timeStamp: number) => {
      window.clearTimeout(expandTimer);
      if (current.current !== null) endedAt.current = timeStamp;
      pressed.current = null;
      update(null);
      setArmed(false);
    };

    const onMove = (event: globalThis.PointerEvent) => {
      if (current.current === null) {
        const start = pressed.current;
        if (start === null || Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
        begin(event.clientX, event.clientY);
      }
      const dragged = current.current;
      if (dragged === null) return;
      const target = targetAt(event.clientX, event.clientY);
      const over = target?.key ?? null;
      if (over !== hovered) {
        hovered = over;
        window.clearTimeout(expandTimer);
        const entry = target === null ? null : entryOf(target);
        if (entry !== null && target !== null && isCollapsed(target)) {
          expandTimer = window.setTimeout(() => {
            setExpanded(entry.path, true);
          }, EXPAND_AFTER_MS);
        }
      }
      const next = { ...dragged, x: event.clientX, y: event.clientY, over };
      if (over !== dragged.over) {
        // A new target re-renders the tree for its outline.
        update(next);
        return;
      }
      // Otherwise only the chip follows the pointer; the tree does not render again.
      current.current = next;
      const chip = chipRef.current;
      if (chip !== null) {
        chip.style.left = `${String(next.x)}px`;
        chip.style.top = `${String(next.y)}px`;
      }
    };
    const onUp = (event: globalThis.PointerEvent) => {
      drop(event.clientX, event.clientY);
      finish(event.timeStamp);
    };
    const onCancel = (event: Event) => {
      finish(event.timeStamp);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || current.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      finish(event.timeStamp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(expandTimer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [armed]);

  let chip: ReactNode = null;
  if (drag !== null) {
    const [only] = drag.entries;
    const Icon = only?.kind === 'file' ? File : Folder;
    const label =
      drag.entries.length === 1 && only !== undefined
        ? nameOf(only.path)
        : t('move.dragSeveral', { count: drag.entries.length });
    chip = createPortal(
      <div ref={chipRef} className="drag-chip" style={{ left: drag.x, top: drag.y }} aria-hidden>
        <Icon size={SIZE.icon} className="drag-chip__icon" />
        <span className="drag-chip__label">{label}</span>
      </div>,
      document.body,
    );
  }

  return {
    chip,
    /** On a row's pointer down: a drag may start from here. */
    onPointerDown: (index: number, event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('.name-field') !== null) return;
      pressed.current = { x: event.clientX, y: event.clientY, index };
      setArmed(true);
    },
    /** "Move here" on the row under the pointer. */
    dropOn: (item: TreeItem): 'move' | null => (drag?.over === item.key ? 'move' : null),
    /** A click right after a drag ended belongs to the drag. */
    justDragged: () => performance.now() - endedAt.current < CLICK_AFTER_DRAG_MS,
  };
}
