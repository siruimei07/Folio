// Moving between changes (handoff workspace-history §6.2, §6.3, §6.9, §11): F7 and Shift+F7 from
// anywhere in the view, and the strip's two buttons, move the current change, whose lines carry
// the bar. It starts at the first change and moves only this way, never with scrolling.
//
// - A move names change k (`findChange`, model/changes.ts). When its rows have not loaded, the
//   window that holds them is pinned: the pane asks for it beside the windows the region shows,
//   until it answers. Then the region scrolls the change's first row to the top third, smoothly
//   unless motion is reduced, and the bar moves to it.
// - Then the lines it covers (`changeLines`, which can need one more window) are announced in the
//   polite live region: "Change 2 of 5, lines 12 to 14". The strip's "Change 2 of 5" is not a live
//   region of its own, so one move is read once.
// - Moves add up: pressing F7 three times before the first one lands goes three changes on. At the
//   first and the last change the keys do nothing, as the strip's buttons are disabled there.
// - A window a move needs that fails ends the move: the region shows its failed row with "Try
//   again" and the failure is announced; the current change stays.
// - Pinned windows stay asked for a moment after the move ends, until the region asks for the rows
//   it now shows, so they never flash back to skeleton lines.
// - The shortcuts are registered while the lines show. A view hidden in `<Activity>` has no effects,
//   so its pane does not answer F7.
import type { TFunction } from 'i18next';
import { type RefObject, useEffect, useEffectEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announce } from '../app/announcer';
import { type KeyCombo, useShortcut } from '../app/shortcuts';
import { windowId } from '../data/diff';
import type { DiffWindow } from '../ipc';
import type { DiffLinesHandle } from './lines/DiffLines';
import { changeLines, clampChange, findChange, type LineRange, loadedRows } from './model/changes';
import { type CheckedWindows, textOf } from './model/rows';

/** F7: the next change, from anywhere in the view (handoff §13), also from a text field. */
export const NEXT_CHANGE_KEYS: KeyCombo = { key: 'F7' };

/** Shift+F7: the previous change. */
export const PREVIOUS_CHANGE_KEYS: KeyCombo = { key: 'F7', shift: true };

/**
 * How long the windows a move read stay asked for after it ends: longer than the scroll and the
 * region's settling (100 ms after the last scroll), after which the region asks for what it shows.
 */
export const PIN_HOLD_MS = 1_000;

/** The windows a move asks for beside the region's (the pane keeps them). */
export interface PinnedWindows {
  /** Whether any window is pinned. */
  held: boolean;
  /** Asks for a window until `clear`; asking again for one already pinned does nothing. */
  add: (window: DiffWindow) => void;
  /** Stops asking for the pinned windows. */
  clear: () => void;
}

export interface ChangeNavigationOptions {
  /** `targetId(target)`: another row starts again at its first change. */
  id: string;
  /** The diff's windows, checked against its header (`checkWindows`). */
  checked: CheckedWindows;
  /** The text or Word lines show; otherwise there is nothing to move between. */
  enabled: boolean;
  /** Word text: the announcement counts paragraphs. */
  word: boolean;
  /** The region, which reveals a change's first row. */
  lines: RefObject<DiffLinesHandle | null>;
  pins: PinnedWindows;
}

export interface ChangeNavigation {
  /** The current change, from 0: the first until a move lands. */
  current: number;
  /** Changes in the diff; 0 when there are none, or no lines show. */
  changes: number;
  /** Moves to the previous change; `null` at the first, where its button is disabled. */
  previous: (() => void) | null;
  /** Moves to the next change; `null` at the last. */
  next: (() => void) | null;
}

/** A move under way: the change it goes to, and that change's first row once found. */
interface Move {
  k: number;
  start: number | null;
}

interface State {
  id: string;
  current: number;
  move: Move | null;
}

function fresh(id: string): State {
  return { id, current: 0, move: null };
}

/** The announcement keys: per unit, per side (old: a change that only removes), one or a range. */
const ANNOUNCEMENTS = {
  lines: {
    new: { one: 'navigation.line', range: 'navigation.lines' },
    old: { one: 'navigation.removedLine', range: 'navigation.removedLines' },
  },
  paragraphs: {
    new: { one: 'navigation.paragraph', range: 'navigation.paragraphs' },
    old: { one: 'navigation.removedParagraph', range: 'navigation.removedParagraphs' },
  },
} as const;

/** "Change 2 of 5, lines 12 to 14"; "Change 2 of 5" when the lines are not known. */
export function announcement(
  t: TFunction<'diff'>,
  { k, changes, lines, word }: { k: number; changes: number; lines: LineRange | null; word: boolean },
): string {
  const values = { current: k + 1, total: changes };
  if (lines === null) return t('navigation.position', values);
  const keys = ANNOUNCEMENTS[word ? 'paragraphs' : 'lines'][lines.side];
  return t(lines.from === lines.to ? keys.one : keys.range, { ...values, from: lines.from, to: lines.to });
}

/** F7, Shift+F7 and the strip's buttons over the lines of one diff. */
export function useChangeNavigation({ id, checked, enabled, word, lines, pins }: ChangeNavigationOptions): ChangeNavigation {
  const { t } = useTranslation('diff');
  const text = enabled ? textOf(checked.header) : null;
  const changes = text?.changes ?? 0;
  const [state, setState] = useState<State>(() => fresh(id));
  // Another row starts at its first change, and so does this one when it comes back.
  if (state.id !== id) setState(fresh(id));
  const own = state.id === id ? state : fresh(id);
  const current = clampChange(own.current, changes);
  const { move } = own;
  // Where the next move starts: the change a move under way goes to, else the current one.
  const from = clampChange(move?.k ?? current, changes);

  // A move starts from the change the last one goes to, so presses before it lands add up.
  const go = (step: 1 | -1) => {
    setState((previous) => {
      const mine = previous.id === id ? previous : fresh(id);
      const start = clampChange(mine.move?.k ?? mine.current, changes);
      const k = clampChange(start + step, changes);
      return k === start ? mine : { ...mine, move: { k, start: null } };
    });
  };
  const stepper = (step: 1 | -1, offered: boolean) =>
    offered
      ? () => {
          go(step);
        }
      : null;
  useShortcut(NEXT_CHANGE_KEYS, stepper(1, changes > 0), { inInputs: true });
  useShortcut(PREVIOUS_CHANGE_KEYS, stepper(-1, changes > 0), { inInputs: true });
  // The strip's buttons, disabled at the ends.
  const toPrevious = stepper(-1, from > 0);
  const toNext = stepper(1, from < changes - 1);

  const loaded = useMemo(() => (text === null ? null : loadedRows(text.rows, checked)), [text, checked]);
  // One step of the move under way with the windows that have answered: it waits for a window,
  // or lands (scrolls, and records the change as current), or ends (announces).
  const advance = useEffectEvent(() => {
    if (move === null || loaded === null) return;
    const update = (next: Partial<State>) => {
      setState((previous) => (previous.id === id && previous.move === move ? { ...previous, ...next } : previous));
    };
    const failed = (window: DiffWindow) => checked.failed.has(windowId(window));
    let { start } = move;
    if (start === null) {
      const found = findChange(loaded, changes, move.k);
      if (found.kind === 'none') {
        update({ move: null });
        return;
      }
      if (found.kind === 'load') {
        if (!failed(found.window)) {
          pins.add(found.window);
          return;
        }
        // The window's rows show as one failed row with "Try again": go there and say so.
        if (found.window.kind === 'rows') lines.current?.reveal(found.window.offset);
        announce(t('navigation.failed', { current: move.k + 1, total: changes }));
        update({ move: null });
        return;
      }
      start = found.row;
      lines.current?.reveal(start);
    }
    const range = changeLines(loaded, changes, move.k, start);
    if (range.kind === 'load' && !failed(range.window)) {
      pins.add(range.window);
      // Landed: the bar moves now, the announcement waits for the window.
      if (move.start === null) update({ current: move.k, move: { k: move.k, start } });
      return;
    }
    // Without its lines (a window that failed, other content now), the change is still named.
    announce(announcement(t, { k: move.k, changes, lines: range.kind === 'found' ? range.lines : null, word }));
    update({ current: move.k, move: null });
  });
  useEffect(() => {
    advance();
  }, [move, loaded]);

  // Once no move is under way, the windows it read stop being asked for a little later.
  const { held, clear } = pins;
  useEffect(() => {
    if (move !== null || !held) return undefined;
    const timer = setTimeout(clear, PIN_HOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [move, held, clear]);

  return {
    current,
    changes,
    previous: toPrevious,
    next: toNext,
  };
}
