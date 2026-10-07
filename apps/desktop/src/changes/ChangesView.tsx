import './ChangesView.css';

import { type KeyboardEvent, useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { takeChangesFocus, usePendingChangesFocus } from '../app/changeTarget';
import { COPY_PATH_KEYS, useFileActions } from '../app/fileActions';
import { isHistoryStarting } from '../app/firstCommit';
import { FirstCommitBlock } from '../app/FirstCommitBlock';
import { DIFF_PANE, type DiffPaneHandle, type DiffTarget } from '../app/panes';
import { handleShortcut, useShortcut } from '../app/shortcuts';
import { useRetriedFailure } from '../app/useRetriedFailure';
import { useFocusKeeper } from '../components/collections/useFocusKeeper';
import type { CollectionHandle, IndexRange } from '../components/collections/useVirtualRows';
import { DeskIllustration } from '../components/DeskIllustration/DeskIllustration';
import { useWorkspace } from '../data/workspace';
import { CommitBar } from './commit/CommitBar';
import { CommitBox } from './commit/CommitBox';
import { type CommitFocusTarget, commitFocusTargetOf, focusInCommitBox } from './commit/parts';
import { COMMIT_KEYS, useCommitBox } from './commit/useCommitBox';
import { ChangesList } from './list/ChangesList';
import { NotSynced } from './NotSynced';
import { type ChangeRowOf, useChangeRows, useSelectedChange } from './list/rows';
import { copyablePath, useDiffMoreItems } from './menus/ChangeMenu';
import { useChangesPreferences } from './preferences';
import { setDiffOpen, setFocus, useChangesView } from './state';
import { useChangeTarget } from './useChangeTarget';
import { useChangesNarrow } from './windowQuery';

/**
 * The diff column with nothing to show (workspace-history handoff §3.8): the desk illustration on
 * the dot grid, and what shows up here. Read in place: it is what the column holds, not news.
 */
function EmptyDiff() {
  const { t } = useTranslation('changes');
  return (
    <div className="changes-view__empty">
      <DeskIllustration />
      <div className="changes-view__empty-words">
        <p className="changes-view__empty-title">{t('states.emptyDiff.title')}</p>
        <p className="changes-view__empty-text">{t('states.emptyDiff.text')}</p>
      </div>
    </div>
  );
}

/** The diff pane's target for a row of the list (src/diff/README.md). */
function targetOf(row: ChangeRowOf): DiffTarget {
  return row.kind === 'item' ? { kind: 'workspace', item: row.item } : { kind: 'workspaceMetadata', change: row.change };
}

/**
 * The parts of the view whose focus outlasts a commit: the list's rows (a row that goes leaves it
 * to the row in its place), the commit box or bar (`useCommitBoxFocus`) and the diff. A part that
 * goes as a whole (the list empties) hands it on through the view's own keeper (`useViewFocus`).
 */
const KEEPS_FOCUS = '.changes-list__rows, .commit-box, .commit-bar, .changes-view__diff, .changes-view__cover';

/**
 * The part of the view that had the focus last, and its element: the commit box or bar (with the
 * control, `data-commit-focus`), the diff pane (beside the list or over it), the list's rows, the
 * list's state block (its load failure, whose "Try again" goes when the rows come), the "Not synced"
 * card (gone in a narrow window), or the first commit's block.
 */
type FocusPart =
  | { kind: 'commit'; element: Element; target: CommitFocusTarget | null }
  | { kind: 'diff' | 'list' | 'listState' | 'notSynced' | 'firstCommit'; element: Element };

const PARTS = [
  ['diff', '.diff'],
  ['list', '.changes-list__rows'],
  ['listState', '.changes-list .state-block'],
  ['notSynced', '.not-synced'],
  ['firstCommit', '.changes-view__first-commit'],
] as const;

function focusPartOf(target: EventTarget | null): FocusPart | null {
  if (!(target instanceof Element)) return null;
  const box = target.closest('.commit-box, .commit-bar');
  if (box !== null) return { kind: 'commit', element: box, target: commitFocusTargetOf(target) };
  for (const [kind, selector] of PARTS) {
    const element = target.closest(selector);
    if (element !== null) return { kind, element };
  }
  return null;
}

/**
 * Keeps the focus in the view when the whole part that had it goes (WCAG 2.4.3; each part keeps
 * its own focus while it stays, `useFocusKeeper`): the window crosses the view's breakpoint, which
 * swaps the commit box for the bar and the diff beside the list for the one over it, and takes the
 * "Not synced" card away; the list empties after a commit, taking its rows and the diff with it; the
 * list's load failure gives way to its rows after "Try again"; the history starts and the first
 * commit's block goes. `restore` gets the part that had it; a callback ref for the view's element.
 */
function useViewFocus(restore: (part: FocusPart, view: HTMLElement) => void): (view: HTMLElement | null) => (() => void) | undefined {
  const last = useRef<FocusPart | null>(null);
  const element = useRef<HTMLElement | null>(null);
  const keep = useFocusKeeper(() => {
    const part = last.current;
    // A part still on the page keeps its own focus.
    if (part !== null && !part.element.isConnected && element.current !== null) restore(part, element.current);
  });
  return useCallback(
    (view: HTMLElement | null) => {
      if (view === null) return undefined;
      element.current = view;
      const note = (event: FocusEvent) => {
        last.current = focusPartOf(event.target);
      };
      view.addEventListener('focusin', note, true);
      const stop = keep(view);
      return () => {
        view.removeEventListener('focusin', note, true);
        stop?.();
      };
    },
    [keep],
  );
}

/**
 * Ctrl+Enter anywhere in the view commits (§3.6), before the focused control sees it: a button
 * would take it as a press and the list as Enter. The registered shortcut decides what it does.
 * A commit it starts from anywhere else (the header's "Include all changes", which a commit
 * disables) puts the focus on the commit button, where it stays through the commit (§4.4).
 */
function commitFirst(event: KeyboardEvent<HTMLElement>): void {
  const { key, ctrlKey, shiftKey, altKey, metaKey } = event;
  if (key !== 'Enter' || !ctrlKey || shiftKey || altKey || metaKey) return;
  const before = useChangesView.getState().run;
  if (!handleShortcut(event.nativeEvent)) return;
  event.preventDefault();
  event.stopPropagation();
  const { target, currentTarget } = event;
  const started = useChangesView.getState().run;
  if (started === before || started.kind === 'idle' || !(target instanceof Element) || target.closest(KEEPS_FOCUS) !== null) return;
  currentTarget.querySelector<HTMLElement>('[data-commit-focus="commit"]')?.focus();
}

/**
 * The Changes view (workspace-history handoff §2, §3, §4, §5). Wide: the changes list, the commit
 * lane with the commit box and "Not synced", and the diff of the selected change, which follows the
 * list's selection (§3.6); Enter in the list moves the focus into the diff. Narrow (§2.2), in a
 * window below the view's own breakpoint (`useChangesNarrow`, 1,000 px, §2.1 as built) while the
 * shell may still be wide: the list takes the width, with the commit bar pinned under it; Enter or
 * a click opens the diff over the list, and Back, Esc or Alt+Left go back to the list as it was,
 * its scroll and selection kept (it stays laid out, hidden, under the diff). The view carries
 * `data-narrow` for its stylesheets. Crossing the breakpoint moves the focus to the counterpart of
 * what had it (`useViewFocus`). Ctrl+Enter commits from anywhere in the view,
 * Ctrl+Shift+C copies the selected change's path from the list or the diff, and "Show in Changes"
 * from another view selects a change, or without one gives the view the focus (`app/changeTarget.ts`).
 * Before the history has started (§10)
 * the view is one panel with the first commit's block, and no commit box.
 */
export function ChangesView() {
  const { t } = useTranslation('changes');
  const narrow = useChangesNarrow();
  const workspace = useWorkspace();
  const summary = workspace.data;
  const empty = summary?.historyState === 'ready' && summary.items + summary.metadata === 0;
  const [range, setRange] = useState<IndexRange | null>(null);
  const grouped = useChangesPreferences((state) => state.layout) === 'grouped';
  const rows = useChangeRows(range, grouped);
  const focus = useChangesView((state) => state.focus);
  const diffOpen = useChangesView((state) => state.diffOpen);
  const selected = useSelectedChange(rows, focus);
  // The list's load failure stays, with its "Try again" and the focus, while a retry reads again:
  // the workspace, or a page the list shows that has no rows yet (a page past the first goes back to
  // pending without its error while the first stays loaded).
  const loadFailure = useRetriedFailure(
    [workspace.error, rows.error],
    summary === undefined || rows.status === 'pending' || rows.loading,
    t('states.loadFailed'),
    () => {
      if (workspace.isError) void workspace.refetch();
      rows.retry();
    },
  );
  // The diff shows while the list shows rows, not over a list that failed to load.
  const failed = loadFailure.shown !== null;
  const shown = failed ? null : selected.row;
  const covered = narrow && diffOpen && shown !== null;
  const files = useFileActions();
  const moreItems = useDiffMoreItems(shown);
  const diffRef = useRef<DiffPaneHandle>(null);
  const listRef = useRef<CollectionHandle>(null);
  // Where the focus goes once the diff has covered the list, or the list shows again.
  const pendingFocus = useRef<'diff' | 'list' | null>(null);
  // Back in a narrow window: the list comes back with the fade and rise.
  const [returned, setReturned] = useState(false);
  const headingId = useId();
  const box = useCommitBox(failed);
  useShortcut(COMMIT_KEYS, box.commit, { inInputs: true });

  const path = shown === null ? null : copyablePath(shown);
  useShortcut(
    COPY_PATH_KEYS,
    path === null
      ? null
      : () => {
          files.copyPaths([path]);
        },
  );

  // "Show in Changes": the row found is selected, and the list shows it, scrolled to and focused.
  useChangeTarget(rows, (index, key) => {
    pendingFocus.current = null;
    flushSync(() => {
      setFocus({ key, index });
      setDiffOpen(false);
    });
    listRef.current?.scrollToIndex(index);
    listRef.current?.focusFocused();
  });

  // "Go to Changes" or "Show in Changes" without a path, from another view whose control went with
  // it (app/changeTarget.ts): once the list has its rows or its state, the diff over the list when
  // a narrow window still has it open (the list under it is hidden), else the list's focused row
  // (once its rows are rendered, `focusFocused`), else the commit button; before the history has
  // started, the first commit's block.
  const viewRef = useRef<HTMLElement | null>(null);
  const focusAsked = usePendingChangesFocus();
  const starting = isHistoryStarting(summary?.historyState);
  const settled = starting || failed || (summary !== undefined && rows.status === 'success');
  const takeFocus = useEffectEvent(() => {
    if (!takeChangesFocus()) return;
    if (covered && diffRef.current !== null) diffRef.current.focus();
    else if (!starting && listRef.current !== null) listRef.current.focusFocused();
    else viewRef.current?.querySelector<HTMLElement>(starting ? '.first-commit' : '[data-commit-focus="commit"]')?.focus();
  });
  useEffect(() => {
    if (focusAsked && settled) takeFocus();
  }, [focusAsked, settled]);

  // A list that empties or fails to load has nothing to cover it with: its state shows, and the
  // diff does not come back over it by itself later.
  const nothing = failed || (rows.status === 'success' && rows.count === 0);
  useEffect(() => {
    if (diffOpen && nothing) setDiffOpen(false);
  }, [diffOpen, nothing]);
  // A wider window shows the diff beside the list, and forgets the one over it: narrowing again
  // covers the list only when the focus was in the diff (`restoreFocus`), never by itself.
  useLayoutEffect(() => {
    if (narrow) return;
    pendingFocus.current = null;
    if (useChangesView.getState().diffOpen) setDiffOpen(false);
  }, [narrow]);
  // Before paint, so the view's keeper finds the focus moved already. A cover that comes while the
  // focus is in the list it hides takes the focus too.
  useLayoutEffect(() => {
    const want = pendingFocus.current;
    const inList = document.activeElement?.closest('.changes-list') != null;
    if (covered && (want === 'diff' || inList)) diffRef.current?.focus();
    else if (want === 'list' && !covered) listRef.current?.focusFocused();
    else return;
    pendingFocus.current = null;
  }, [covered]);

  /**
   * The part that had the focus went as a whole: the counterpart takes it. The commit box's control
   * in the bar, or the bar's in the box; the diff in its new place, over the list when narrow (the
   * person was reading it); with no diff to show, or from the list, its load failure, "Not synced"
   * or the first commit's block, the focused row, or the commit button when no row is left (§4.4).
   */
  const restoreFocus = (part: FocusPart, view: HTMLElement) => {
    if (pendingFocus.current !== null) return;
    const listOrCommit = () => {
      if (listRef.current === null) view.querySelector<HTMLElement>('[data-commit-focus="commit"]')?.focus();
      else listRef.current.focusFocused();
    };
    if (part.kind === 'commit') {
      const counterpart = view.querySelector('.commit-box, .commit-bar');
      if (counterpart !== null) focusInCommitBox(counterpart, part.target, box.run);
    } else if (part.kind !== 'diff') listOrCommit();
    else if (!narrow) {
      if (diffRef.current === null) listOrCommit();
      else diffRef.current.focus();
    } else if (shown !== null && !nothing) {
      pendingFocus.current = 'diff';
      setReturned(false);
      setDiffOpen(true);
    } else listOrCommit();
  };
  const keepViewFocus = useViewFocus(restoreFocus);
  const view = useCallback(
    (element: HTMLElement | null) => {
      viewRef.current = element;
      const stop = keepViewFocus(element);
      return () => {
        viewRef.current = null;
        stop?.();
      };
    },
    [keepViewFocus],
  );

  /**
   * Enter on the row at `index`, and in a narrow window a click on it: that change's diff, over the
   * list when narrow. A place's header shows no change, and a row whose page has not come shows
   * none yet, unless it is the selected row the diff still shows (`useSelectedChange`): they open
   * nothing, and leave nothing to open later.
   */
  const open = (index: number) => {
    const row = rows.rowAt(index);
    const change = row.kind === 'item' || row.kind === 'metadata' || (index === selected.index && shown !== null);
    if (failed || !change) return;
    if (!narrow) {
      diffRef.current?.focus();
      return;
    }
    pendingFocus.current = 'diff';
    setReturned(false);
    setDiffOpen(true);
  };
  const back = () => {
    pendingFocus.current = 'list';
    setReturned(true);
    setDiffOpen(false);
  };

  // Before the history has started, the view is one panel with the first commit's block (§10),
  // named "Changes" like the list's panel, with a heading above the block's.
  if (starting) {
    return (
      <div ref={view} className="changes-view">
        <section className="panel changes-view__first-commit" aria-labelledby={headingId}>
          <h2 id={headingId} className="visually-hidden">
            {t('list.title')}
          </h2>
          <FirstCommitBlock text={t('firstCommit.text')} />
        </section>
      </div>
    );
  }

  const Diff = DIFF_PANE;
  const target = shown === null ? null : targetOf(shown);
  return (
    <div
      ref={view}
      className="changes-view"
      data-narrow={narrow || undefined}
      data-covered={covered || undefined}
      onKeyDownCapture={commitFirst}
    >
      <div
        className="changes-view__main"
        data-returned={returned || undefined}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget && event.animationName === 'rise-in') setReturned(false);
        }}
      >
        <ChangesList
          rows={rows}
          failure={loadFailure}
          range={range}
          selectedIndex={selected.index}
          committing={box.committing ? (box.committingShown ? 'shown' : 'quiet') : null}
          onRangeChange={setRange}
          onEnter={open}
          onRowClick={narrow ? open : undefined}
          listRef={listRef}
        />
        {covered && target !== null && (
          <div className="panel changes-view__cover">
            <Diff
              ref={diffRef}
              target={target}
              actions={{ open: files.open }}
              moreItems={moreItems}
              back={{ label: t('diff.back'), onBack: back }}
            />
          </div>
        )}
      </div>
      {narrow && <CommitBar model={box} />}
      {!narrow && (
        <>
          <div className="changes-view__lane">
            <CommitBox model={box} />
            <NotSynced />
          </div>
          <div className="panel changes-view__diff">
            {target !== null ? (
              <Diff ref={diffRef} target={target} actions={{ open: files.open }} moreItems={moreItems} />
            ) : (
              empty && <EmptyDiff />
            )}
          </div>
        </>
      )}
    </div>
  );
}
