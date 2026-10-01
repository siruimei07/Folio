// How keys and clicks change a collection's focus and selection (docs/specs/ui-architecture.md
// §7.2, WAI-ARIA Authoring Practices for multi-select trees and listboxes). The collections report
// what the user asked for; the view that owns the selection applies it to its rows.

/** What a navigation key does: Shift extends the selection, Ctrl moves focus only. */
export type Move = 'replace' | 'extend' | 'focus';

/** What a click does: Ctrl toggles the row, Shift extends from the anchor, a plain click replaces. */
export type ClickIntent = 'replace' | 'toggle' | 'extend';

interface Modifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export function moveOf(event: Modifiers): Move {
  if (event.shiftKey) return 'extend';
  return event.ctrlKey || event.metaKey ? 'focus' : 'replace';
}

export function clickIntentOf(event: Modifiers): ClickIntent {
  if (event.shiftKey) return 'extend';
  return event.ctrlKey || event.metaKey ? 'toggle' : 'replace';
}

