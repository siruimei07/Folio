// What a file card asks of the History view that hosts the diff: show a row's version, and move the
// focus into the diff. The view provides it; a card rendered alone (a test) selects without moving
// the focus.
import { createContext } from 'react';

import type { HistorySelection } from '../model/selection';
import { selectRow } from '../state';

export interface CardHost {
  /** Shows the row's version (Enter, Space, a click); in a narrow window the diff covers the list. */
  select: (selection: HistorySelection) => void;
  /**
   * Enter on the row the diff shows: the focus goes into the diff (as Enter in the Changes list,
   * §3.6); in a narrow window the diff covers the list again first.
   */
  focusDiff: () => void;
}

export const CardHostContext = createContext<CardHost>({
  select: (selection) => {
    selectRow(selection, false);
  },
  focusDiff: () => undefined,
});
