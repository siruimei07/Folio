// The keys the tree, list and grid share (WAI-ARIA Authoring Practices; UI architecture §7.2):
// arrows, Home, End, Page Up, Page Down, Space, Enter, Ctrl+A and type-ahead.
import type { KeyboardEvent } from 'react';

import { type Move, moveOf } from './selection';

/**
 * Where Up and Down (`page` false) or Page Up and Page Down (`page` true) go from `index`,
 * `step` -1 up and 1 down; `null` for nowhere.
 */
export type Across = (index: number, step: 1 | -1, page: boolean) => number | null;

/**
 * The first item from `from` going `step` that `focusable` accepts, or `null`: the rows the keys
 * and type-ahead stop on in a tree with separators or a list with header rows.
 */
export function nextFocusable(focusable: (index: number) => boolean, count: number, from: number, step: 1 | -1): number | null {
  for (let index = from; index >= 0 && index < count; index += step) {
    if (focusable(index)) return index;
  }
  return null;
}

/**
 * `Across` for a list or tree: an arrow moves `vertical` items and a page `page` items, both to
 * what `next` finds focusable; a page stops at the ends.
 */
export function acrossItems(count: number, next: KeyContext['next'], vertical: number, page: number): Across {
  return (index, step, paging) => {
    if (paging) return next(Math.min(Math.max(index + step * page, 0), count - 1), step === 1 ? -1 : 1) ?? next(index, step);
    const target = index + step * vertical;
    return target >= 0 && target < count ? next(target, step) : null;
  };
}

export interface KeyContext {
  index: number;
  count: number;
  /** The first focusable item from `from` going `step`, or `null`. */
  next: (from: number, step: 1 | -1) => number | null;
  /** Up, Down, Page Up and Page Down; a grid's Left and Right move by 1. */
  across: Across;
  grid?: boolean;
  navigate: (index: number | null, move: Move) => void;
  onToggle: (index: number) => void;
  onAction: (index: number) => void;
  onSelectAll?: () => void;
  typeahead: (event: KeyboardEvent) => boolean;
}

const MOVES: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Whether a held key acts again: moving and type-ahead do. Space, Enter, Ctrl+A and a view's own
 * keys (Delete, F2, …) act once, however long the key is held.
 */
export function actsWhileHeld(event: KeyboardEvent): boolean {
  if (MOVES.has(event.key)) return true;
  return event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * The start of a collection's key handler: `true` when a held key's repeat is to be ignored. Its
 * default (Space scrolling, say) is ignored too; Tab still moves focus on.
 */
export function ignoreRepeat(event: KeyboardEvent): boolean {
  if (!event.repeat || actsWhileHeld(event)) return false;
  if (event.key !== 'Tab') event.preventDefault();
  return true;
}

/** Handles a key of a collection; says whether it did. */
export function handleCollectionKey(event: KeyboardEvent, context: KeyContext): boolean {
  const { index, count, next, across, grid = false, navigate } = context;
  const move = moveOf(event);
  switch (event.key) {
    case 'ArrowDown':
      navigate(across(index, 1, false), move);
      return true;
    case 'ArrowUp':
      navigate(across(index, -1, false), move);
      return true;
    case 'ArrowRight':
      if (!grid) return false;
      navigate(index + 1 < count ? next(index + 1, 1) : null, move);
      return true;
    case 'ArrowLeft':
      if (!grid) return false;
      navigate(index > 0 ? next(index - 1, -1) : null, move);
      return true;
    case 'Home':
      navigate(next(0, 1), move);
      return true;
    case 'End':
      navigate(next(count - 1, -1), move);
      return true;
    case 'PageDown':
      navigate(across(index, 1, true), move);
      return true;
    case 'PageUp':
      navigate(across(index, -1, true), move);
      return true;
    case 'Enter':
      context.onAction(index);
      return true;
    case ' ':
      if (!context.typeahead(event)) context.onToggle(index);
      return true;
    case 'a':
    case 'A':
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && context.onSelectAll) {
        context.onSelectAll();
        return true;
      }
      return context.typeahead(event);
    default:
      return context.typeahead(event);
  }
}
