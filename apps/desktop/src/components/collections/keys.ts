// The keys the tree, list and grid share (WAI-ARIA Authoring Practices; UI architecture §7.2):
// arrows, Home, End, Page Up, Page Down, Space, Enter, Ctrl+A and type-ahead.
import type { KeyboardEvent } from 'react';

import { type Move, moveOf } from './selection';

export interface KeyContext {
  index: number;
  count: number;
  /** The first focusable item from `from` going `step`, or `null`. */
  next: (from: number, step: 1 | -1) => number | null;
  /** Items Page Up and Page Down move by. */
  page: number;
  /** Items Up and Down move by: 1, or a grid's columns; a grid's Left and Right move by 1. */
  vertical: number;
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
  const { index, count, next, page, vertical, grid = false, navigate } = context;
  const move = moveOf(event);
  const clamp = (target: number) => Math.min(Math.max(target, 0), count - 1);
  switch (event.key) {
    case 'ArrowDown':
      navigate(index + vertical < count ? next(index + vertical, 1) : null, move);
      return true;
    case 'ArrowUp':
      navigate(index - vertical >= 0 ? next(index - vertical, -1) : null, move);
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
      navigate(next(clamp(index + page), -1) ?? next(index, 1), move);
      return true;
    case 'PageUp':
      navigate(next(clamp(index - page), 1) ?? next(index, -1), move);
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
