import { GripVertical } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../../app/announcer';
import { SIZE } from '../../tokens/tokens';

/** How far the pointer moves with the button down before a drag starts (library-actions §7.3). */
const DRAG_THRESHOLD_PX = 4;

export interface ReorderRow {
  /** Moves the row one place up or down; `undefined` at the top or the bottom. */
  moveUp: (() => void) | undefined;
  moveDown: (() => void) | undefined;
}

export interface ReorderListProps<T> {
  /** Names the list, like "Courses in Fall 2026". */
  label: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** The item's name in announcements: "Moved MAT232 to position 2 of 5". */
  nameOf: (item: T) => string;
  /**
   * Saves the new order of every key. The list shows it at once and keeps it until `items`
   * change, or until the promise resolves `false` (the save failed, and said so).
   */
  onReorder: (keys: string[]) => Promise<boolean>;
  /** No grips and no moves: a read-only library. */
  isDisabled?: boolean;
  /** One row's content after the grip; `row` has its place and the moves for its menu. */
  children: (item: T, row: ReorderRow) => ReactNode;
}

interface Drag {
  pointerId: number;
  from: number;
  to: number;
  startY: number;
  /** Past the threshold: the rows show where it would go. */
  moving: boolean;
}

/** Which edge of row `index` shows the line where a dragged row would go, if any. */
function dropSide(drag: Drag | null, index: number): 'before' | 'after' | undefined {
  if (drag?.moving !== true || drag.to !== index || drag.to === drag.from) return undefined;
  return drag.to < drag.from ? 'before' : 'after';
}

/** `keys` with the key at `from` moved to `to`. */
function moved(keys: readonly string[], from: number, to: number): string[] {
  const next = [...keys];
  const [key] = next.splice(from, 1);
  if (key !== undefined) next.splice(to, 0, key);
  return next;
}

/**
 * Rows in the user's order with a grip each (app-shell handoff §9: "Drag to reorder"). Dragging a
 * grip with the pointer moves the row; the page's drag and drop is off while Tauri takes file
 * drops, so this uses pointer events, like moving files in the Library. Keyboard users move rows
 * with the row menu's Move up and Move down. Every move is announced.
 */
export function ReorderList<T>({ label, items, keyOf, nameOf, onReorder, isDisabled = false, children }: ReorderListProps<T>) {
  const { t } = useTranslation('settings');
  // The order shown while a save runs; dropped when the list arrives again.
  const [pending, setPending] = useState<string[] | null>(null);
  // The list's order as it last arrived; a new one (the save's, or another change) replaces the
  // pending order. Compared by keys, since the parent may filter a fresh array every render.
  const order = items.map(keyOf).join('\n');
  const [shown, setShown] = useState(order);
  if (shown !== order) {
    setShown(order);
    setPending(null);
  }
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const keys = pending?.filter((key) => byKey.has(key)) ?? items.map(keyOf);
  const ordered = keys.flatMap((key) => {
    const item = byKey.get(key);
    return item === undefined ? [] : [item];
  });

  const [drag, setDrag] = useState<Drag | null>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= keys.length) return;
    const next = moved(keys, from, to);
    setPending(next);
    const item = ordered[from];
    if (item !== undefined) announce(t('reorder.moved', { name: nameOf(item), position: to + 1, count: keys.length }));
    void onReorder(next).then((saved) => {
      // A failed save puts the order back, unless a later move has replaced it meanwhile.
      if (!saved) setPending((current) => (current === next ? null : current));
    });
  };

  // Esc cancels a drag, as in the Library (library-actions §7.3).
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDrag(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dragging]);

  /** Where a row dropped at `y` would go: before the first row whose middle is below it. */
  const targetAt = (y: number, from: number) => {
    const below = rows.current.findIndex((row) => {
      if (row === null) return false;
      const box = row.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    const before = below < 0 ? keys.length : below;
    return before > from ? before - 1 : before;
  };

  const grip = (index: number) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (isDisabled || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ pointerId: event.pointerId, from: index, to: index, startY: event.clientY, moving: false });
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag?.pointerId !== event.pointerId) return;
      const moving = drag.moving || Math.abs(event.clientY - drag.startY) >= DRAG_THRESHOLD_PX;
      const to = moving ? targetAt(event.clientY, drag.from) : drag.from;
      if (moving !== drag.moving || to !== drag.to) setDrag({ ...drag, moving, to });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag?.pointerId !== event.pointerId) return;
      setDrag(null);
      if (drag.moving) move(drag.from, drag.to);
    },
    onPointerCancel: () => {
      setDrag(null);
    },
  });

  return (
    <ul className="reorder-list" aria-label={label} data-dragging={drag?.moving === true || undefined}>
      {ordered.map((item, index) => {
        const key = keyOf(item);
        const isDragged = drag?.moving === true && drag.from === index;
        const drop = dropSide(drag, index);
        return (
          <li
            key={key}
            ref={(element) => {
              rows.current[index] = element;
            }}
            className="reorder-row"
            data-dragged={isDragged || undefined}
            data-drop={drop}
          >
            {!isDisabled && (
              // Pointer only: the row menu's Move up and Move down are the keyboard's way (§9).
              <span className="reorder-row__grip" aria-hidden {...grip(index)}>
                <GripVertical size={SIZE.iconSmall} />
              </span>
            )}
            {children(item, {
              moveUp: isDisabled || index === 0 ? undefined : () => {
                move(index, index - 1);
              },
              moveDown: isDisabled || index === ordered.length - 1 ? undefined : () => {
                move(index, index + 1);
              },
            })}
          </li>
        );
      })}
    </ul>
  );
}
