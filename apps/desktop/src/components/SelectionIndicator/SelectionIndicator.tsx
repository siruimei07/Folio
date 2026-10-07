import './SelectionIndicator.css';

/**
 * Where the bar sits in its item:
 * - `row`: at the left edge, inset `size.selection-bar-inset` top and bottom (the tree, the
 *   Library's list, the folder picker, search results, the changes list, History's file rows);
 * - `edge`: `size.rail-indicator` tall, centred, at the window's left edge (the rail's active view);
 * - `tab`: a tab list's selected tab, like `row` while the list is vertical and along the tab's
 *   bottom edge while it is horizontal (the settings nav, which turns horizontal in a narrow window).
 */
export type SelectionPlacement = 'row' | 'edge' | 'tab';

export interface SelectionIndicatorProps {
  placement?: SelectionPlacement;
}

/**
 * The selection bar (workspace-history handoff §8.6, app-shell §10): 3 px of
 * `color.selection.indicator`, rounded on the side away from the edge it sits on. Render it inside
 * the selected (or active) item, which is positioned; the item's own state (`aria-selected`,
 * `aria-current`) is what assistive technology reads, so the bar is hidden from it. A host whose
 * padding puts the bar too far in moves it out with `--selection-indicator-start`.
 */
export function SelectionIndicator({ placement = 'row' }: SelectionIndicatorProps) {
  return <span className="selection-indicator" data-placement={placement} aria-hidden />;
}
