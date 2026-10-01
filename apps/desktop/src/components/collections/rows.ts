// Pointer events of a collection's rows, handled once on the collection: each row carries its
// index in `data-index`, so thousands of rows add no handlers of their own.
import type { MouseEvent, PointerEvent } from 'react';

import { type ClickIntent, clickIntentOf } from './selection';

export interface RowPointerHandlers {
  /** A click, with what its modifier keys ask for. */
  onRowClick?: (index: number, intent: ClickIntent, event: MouseEvent) => void;
  onRowDoubleClick?: (index: number, event: MouseEvent) => void;
  onRowContextMenu?: (index: number, event: MouseEvent) => void;
  onRowPointerDown?: (index: number, event: PointerEvent) => void;
  /** A right-click outside the items. */
  onBackgroundContextMenu?: (event: MouseEvent) => void;
}

/** The index of the item an event happened in, from its `data-index`. */
export function eventIndex(target: EventTarget, container: Element): number | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest('[data-index]');
  if (row === null || !container.contains(row)) return null;
  const index = Number(row.getAttribute('data-index'));
  return Number.isInteger(index) ? index : null;
}

/** The collection element's handlers that pass pointer events on to `handlers` by item. */
export function delegateRowEvents(isItem: (index: number) => boolean, handlers: RowPointerHandlers) {
  const itemOf = (event: MouseEvent | PointerEvent): number | null => {
    const index = eventIndex(event.target, event.currentTarget);
    return index !== null && isItem(index) ? index : null;
  };
  return {
    onClick: (event: MouseEvent) => {
      const index = itemOf(event);
      if (index !== null) handlers.onRowClick?.(index, clickIntentOf(event), event);
    },
    onDoubleClick: (event: MouseEvent) => {
      const index = itemOf(event);
      if (index !== null) handlers.onRowDoubleClick?.(index, event);
    },
    onPointerDown: (event: PointerEvent) => {
      const index = itemOf(event);
      if (index !== null) handlers.onRowPointerDown?.(index, event);
    },
    onContextMenu: (event: MouseEvent) => {
      const index = itemOf(event);
      if (index !== null) handlers.onRowContextMenu?.(index, event);
      else handlers.onBackgroundContextMenu?.(event);
    },
  };
}
