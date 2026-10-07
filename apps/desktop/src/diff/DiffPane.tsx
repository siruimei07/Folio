import './DiffPane.css';

import type { TFunction } from 'i18next';
import {
  Activity,
  type KeyboardEvent,
  useCallback,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

import { PREVIEW_FILE, type PreviewFileSource, previewShowsVersion } from '../app/previewFile';
import { useFocusKeeper } from '../components/collections/useFocusKeeper';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { settledOf, useDiffWindows, useLocatedVersion, windowId } from '../data/diff';
import type { IpcFailure } from '../data/errors';
import { useCourses } from '../data/groups';
import type { DiffWindow, EntryRef } from '../ipc';
import { nameOf } from '../lib/paths';
import { SIZE } from '../tokens/tokens';
import { DiffHeader, type DiffView } from './DiffHeader';
import {
  DiffDeletedSince,
  DiffFailed,
  DiffLoading,
  DiffRefreshFailed,
  DiffState,
  isStateBody,
  type StateActions,
} from './DiffStates';
import { DiffStrip } from './DiffStrip';
import { EventNote } from './EventNote';
import { DiffLines, type DiffLinesHandle } from './lines/DiffLines';
import { SettingsList, TagDefinitionsList, TagsBlock } from './MetadataDetail';
import { type DiffBody, type DiffDescription, describe, type PreviewSource, renderMessage } from './model/describe';
import { checkWindows } from './model/rows';
import { type DiffTarget, sourceOf, targetId, versionOf } from './model/target';
import type { DiffActions, DiffPaneProps } from './types';
import { type PinnedWindows, useChangeNavigation } from './useChangeNavigation';
import { useRetry } from './useRetry';

/** The windows past the first one: none until the lines ask for theirs. */
const NO_WINDOWS: readonly DiffWindow[] = [];

/** Skeleton rows while the file a version belongs to is looked up, as the preview's own. */
const PREVIEW_SKELETON_ROWS = 8;

/**
 * The windows one target asks for: those the lines show and those a move between changes needs
 * (`pinned`); another target's are not asked.
 */
interface AskedWindows {
  id: string;
  windows: readonly DiffWindow[];
  pinned: readonly DiffWindow[];
}

/** Esc, or Alt+Left, without other modifiers: "Back" in a narrow window (handoff §2.2). */
function isBackKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.shiftKey || event.metaKey || event.nativeEvent.isComposing) return false;
  return event.altKey ? event.key === 'ArrowLeft' : event.key === 'Escape';
}

/** Bodies with "Open with default app": the file must be found to offer it. */
const OPENS = new Set<DiffBody['kind']>(['unreadable', 'notLocal', 'tooLarge', 'overLimit']);

/**
 * Whether the pane is narrower than `size.diff-compact-pane` (handoff §6.1, §8.4), followed with a
 * `ResizeObserver` on the element the returned callback ref gets. A width of 0 (the view hidden in
 * `<Activity>`) keeps the last answer, so showing the view again does not flash the other header.
 */
function useCompactPane(): [compact: boolean, ref: (node: HTMLDivElement | null) => (() => void) | undefined] {
  const [compact, setCompact] = useState(false);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return undefined;
    const measure = (width: number) => {
      if (width > 0) setCompact(width < SIZE.diffCompactPane);
    };
    measure(node.offsetWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [compact, ref];
}

/**
 * The file a row shows at its version: the file on the disk in Changes (its entry), the stored
 * version in History. `null` when there is none (a deletion, a tag or settings change).
 */
function ownFile(target: DiffTarget): PreviewFileSource | null {
  if (target.kind === 'workspace') {
    return target.item.entry === null ? null : { kind: 'entry', entry: target.item.entry };
  }
  if (target.kind === 'version' && target.row.after !== null) {
    return { kind: 'version', version: versionOf(target), side: target.row.after };
  }
  return null;
}

/**
 * The file "Open with default app" opens: the item's entry in Changes; in History the file the
 * version belongs to now, looked up only when a state offers the button. `undefined` while it is
 * looked up, `null` when there is none.
 */
function useOpenable(target: DiffTarget, wanted: boolean): EntryRef | null | undefined {
  const version = target.kind === 'version' && wanted ? versionOf(target) : null;
  const located = useLocatedVersion(version);
  if (!wanted) return null;
  switch (target.kind) {
    case 'workspace':
      return target.item.kind === 'file' ? target.item.entry : null;
    case 'version': {
      const row = located.data;
      if (row === undefined || row === null) return row;
      return { id: row.id, path: row.path };
    }
    case 'workspaceMetadata':
    case 'versionMetadata':
      return null;
  }
}

/** The name of the lines' region: "Changes in Midterm review.md". */
function regionLabel(t: TFunction<['diff', 'common']>, target: DiffTarget, description: DiffDescription): string {
  if ((target.kind === 'workspaceMetadata' || target.kind === 'versionMetadata') && target.change.subject.kind === 'ignoreRules') {
    return t('lines.regionIgnoreRules');
  }
  const { heading } = description;
  return t('lines.region', { name: heading.kind === 'path' ? nameOf(heading.path) : renderMessage(t, heading.title) });
}

/** A file's preview filling what is left of the body (`PREVIEW_FILE`). */
function PreviewArea({ file, actions, onEscape }: { file: PreviewFileSource; actions: DiffActions; onEscape: () => void }) {
  const Preview = PREVIEW_FILE;
  return (
    <div className="diff-preview">
      <Preview source={file} actions={actions} onEscape={onEscape} />
    </div>
  );
}

/**
 * The file's preview under the banners of a file whose versions Folio does not keep, or that moved
 * without edits (§6.8): the file on the disk in Changes; in History the stored version when there
 * is one, else the file the version belongs to now, or a note that it has been deleted since. When
 * that file cannot be looked up, the preview's own failure says so: the change above it did show.
 * `focusHeading` is Esc in the preview.
 */
function FilePreview({
  target,
  source,
  actions,
  focusHeading,
}: {
  target: DiffTarget;
  source: PreviewSource;
  actions: DiffActions;
  focusHeading: () => void;
}) {
  const { t } = useTranslation('diff');
  const locating = source === 'located' && target.kind === 'version';
  const located = useLocatedVersion(locating ? versionOf(target) : null);
  const row = located.data;
  const { refetch } = located;
  const lookUp = useCallback(() => {
    void refetch();
  }, [refetch]);
  const lookup = useRetry(
    targetId(target),
    { settled: settledOf(located), fetching: located.isFetching, failing: row === undefined && located.error !== null },
    lookUp,
  );
  if (!locating) {
    const file = ownFile(target);
    return file === null ? null : <PreviewArea file={file} actions={actions} onEscape={focusHeading} />;
  }
  if (row === undefined && located.error !== null) {
    return (
      <DiffFailed
        title={t('failed.previewTitle')}
        error={located.error.error}
        onRetry={lookup.retry}
        onOpen={null}
        failedAgain={lookup.failedAgain}
      />
    );
  }
  if (row === undefined) {
    return (
      <div className="diff-preview">
        <Skeleton rows={PREVIEW_SKELETON_ROWS} />
      </div>
    );
  }
  if (row === null) return <DiffDeletedSince />;
  return <PreviewArea file={{ kind: 'entry', entry: { id: row.id, path: row.path } }} actions={actions} onEscape={focusHeading} />;
}

/** Below the banners: the body, then the tags of an entry whose tags changed with its content. */
function Body({
  target,
  description,
  failure,
  actions,
  stateActions,
  focusHeading,
}: {
  target: DiffTarget;
  description: DiffDescription;
  failure: IpcFailure | null;
  actions: DiffActions;
  stateActions: StateActions;
  focusHeading: () => void;
}) {
  const { body, tags } = description;
  if (failure !== null) {
    return (
      <DiffFailed
        error={failure.error}
        onRetry={stateActions.onRetry}
        onOpen={stateActions.onOpen}
        failedAgain={stateActions.failedAgain}
      />
    );
  }
  let content = null;
  // Text and Word lines have their own region (`DiffLines`).
  if (body.kind === 'loading') content = <DiffLoading />;
  else if (isStateBody(body)) content = <DiffState body={body} actions={stateActions} />;
  else if (body.kind === 'preview') {
    content = <FilePreview target={target} source={body.source} actions={actions} focusHeading={focusHeading} />;
  } else if (body.kind === 'tags') {
    const intro = body.history ? (body.folder ? 'historyFolder' : 'historyFile') : body.folder ? 'folder' : 'file';
    content = <TagsBlock tags={body.tags} intro={intro} />;
  } else if (body.kind === 'settings') content = <SettingsList changes={body.changes} />;
  else if (body.kind === 'tagDefinitions') content = <TagDefinitionsList changes={body.changes} />;
  return (
    <>
      {content}
      {tags !== null && body.kind !== 'loading' && <TagsBlock tags={tags} intro="withContent" />}
    </>
  );
}

/**
 * The diff of one change (handoff workspace-history §6), shared by the Changes and History views
 * through `app/panes.ts` (API: `README.md`). The header comes from the row at once; the strip, the
 * banners and the body follow when the diff's first window answers, with a skeleton after 150 ms
 * meanwhile. F7 and Shift+F7 move between the changes of text and Word lines
 * (`useChangeNavigation`). "Changes | This version" shows the file at this version through the
 * preview instead (§6.7), keeping the diff as it was (its folds, the current change) for the way
 * back; in a pane narrower than `size.diff-compact-pane` it and "Restore" move into "More".
 */
export function DiffPane({ target, actions, moreItems, back, restore, ref }: DiffPaneProps) {
  const { t, i18n } = useTranslation(['diff', 'common']);
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const linesRef = useRef<DiffLinesHandle>(null);
  const [compact, paneRef] = useCompactPane();
  const courses = useCourses().data;
  const id = targetId(target);
  // The lines ask for the windows they show, moves between changes for those they need; a
  // refreshed row with the same key keeps its queries.
  const [asked, setAsked] = useState<AskedWindows>({ id, windows: NO_WINDOWS, pinned: NO_WINDOWS });
  if (asked.id !== id) setAsked({ id, windows: NO_WINDOWS, pinned: NO_WINDOWS });
  const onWindows = useCallback(
    (windows: readonly DiffWindow[]) => {
      setAsked((previous) => ({ id, windows, pinned: previous.id === id ? previous.pinned : NO_WINDOWS }));
    },
    [id],
  );
  const pin = useCallback(
    (window: DiffWindow) => {
      setAsked((previous) => {
        const own = previous.id === id ? previous : { id, windows: NO_WINDOWS, pinned: NO_WINDOWS };
        const added = windowId(window);
        return own.pinned.some((pinned) => windowId(pinned) === added) ? own : { ...own, pinned: [...own.pinned, window] };
      });
    },
    [id],
  );
  const unpin = useCallback(() => {
    setAsked((previous) => (previous.id === id && previous.pinned.length > 0 ? { ...previous, pinned: NO_WINDOWS } : previous));
  }, [id]);
  const own = asked.id === id ? asked : null;
  const windows = useMemo(
    () => (own === null ? NO_WINDOWS : own.pinned.length === 0 ? own.windows : [...own.windows, ...own.pinned]),
    [own],
  );
  const read = useDiffWindows(sourceOf(target), windows);
  const checked = useMemo(() => checkWindows(read.windows), [read.windows]);
  const header = read.windows[0]?.diff;
  // Only the year of a date depends on it ("Oct 13, 2025, 9:30 PM").
  const [now] = useState(() => Date.now());
  const description = describe(target, header, {
    language: i18n.language,
    now,
    courses: courses ?? [],
    showsVersion: previewShowsVersion,
  });
  // "Changes | This version", back to "Changes" for every other row, and for this one when it comes
  // back; the content can still take the offer back (a file that turns out binary), and then the
  // diff shows.
  const [chosen, setChosen] = useState<{ id: string; view: DiffView }>({ id, view: 'changes' });
  if (chosen.id !== id) setChosen({ id, view: 'changes' });
  const versionFile = description.toggle ? ownFile(target) : null;
  const view: DiffView = versionFile !== null && chosen.id === id ? chosen.view : 'changes';
  const showView = useCallback(
    (next: DiffView) => {
      setChosen({ id, view: next });
    },
    [id],
  );
  const focusHeading = useCallback(() => {
    headingRef.current?.focus();
  }, []);
  // Into the diff: the lines, else the heading. Enter in the host's list (handoff §3.6), and where
  // the focus goes when what had it goes (ui-architecture §8.3): a "Try again" whose block or banner
  // goes as the diff is read again, the lines' region when a refresh turns them into a state block.
  const focusDiff = useCallback(() => {
    if (linesRef.current === null) headingRef.current?.focus();
    else linesRef.current.focus();
  }, []);
  const keepFocus = useFocusKeeper(focusDiff);
  // Without an earlier answer a failure takes the body; with one, the last answer stays under a
  // banner (`checked.refreshFailed`), except for NotFound: the change is gone and the host drops it.
  const failure = header === undefined && read.status === 'error' ? read.error : null;
  const refreshFailed = failure === null ? checked.refreshFailed : null;
  // "Try again" in the failed block, the unreadable file's block and the refresh banner reads the
  // whole diff again; the button keeps the focus while it runs, and a failure that stays is read
  // again (`useRetry`).
  const { retry, failedAgain } = useRetry(
    id,
    {
      settled: read.windows[0]?.settled ?? '',
      fetching: read.windows.some((answer) => answer.fetching),
      failing: failure !== null || refreshFailed !== null || description.body.kind === 'unreadable',
    },
    read.reload,
  );
  const opens = failure !== null || OPENS.has(description.body.kind);
  const openable = useOpenable(target, opens);
  const stateActions: StateActions = {
    onOpen:
      openable === null || openable === undefined
        ? null
        : () => {
            actions.open(openable);
          },
    // A failed read and a file that could not be read both read the whole diff again.
    onRetry: retry,
    failedAgain,
    refreshFailed: refreshFailed !== null,
    // The block's button goes with the diff, so the focus goes to the heading.
    onShowVersion:
      versionFile === null
        ? undefined
        : () => {
            showView('version');
            focusHeading();
          },
    versionOffered: versionFile !== null,
  };
  const busy = failure === null && description.body.kind === 'loading';
  const lines = failure === null && description.body.kind === 'lines' ? description.body : null;
  const banners = description.banners.map((banner, index) => (
    <EventNote key={index} banner={banner} text={renderMessage(t, banner.message)} />
  ));

  const pins: PinnedWindows = useMemo(
    () => ({ held: (own?.pinned.length ?? 0) > 0, add: pin, clear: unpin }),
    [own, pin, unpin],
  );
  const navigation = useChangeNavigation({
    id,
    checked,
    enabled: lines !== null && view === 'changes',
    word: lines?.word ?? false,
    lines: linesRef,
    pins,
  });

  // Enter in the host's list moves the focus here (handoff §3.6).
  useImperativeHandle(ref, () => ({ focus: focusDiff }), [focusDiff]);
  // Esc and Alt+Left go back in a narrow window; a menu or tooltip that Esc closes keeps it.
  const onKeyDown =
    back === undefined
      ? undefined
      : (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.defaultPrevented || !isBackKey(event)) return;
          event.preventDefault();
          back.onBack();
        };

  return (
    <div ref={paneRef} className="diff" role="group" aria-labelledby={headingId} onKeyDown={onKeyDown}>
      <DiffHeader
        icon={description.icon}
        heading={description.heading}
        status={description.status}
        courses={courses ?? []}
        back={back}
        moreItems={moreItems}
        toggle={versionFile === null ? null : { view, onChange: showView }}
        restore={restore}
        compact={compact}
        headingId={headingId}
        headingRef={headingRef}
      />
      {/* Keyed by the target, so another change starts afresh: its skeleton waits 150 ms again. */}
      <div key={id} ref={keepFocus} className="diff-content">
        {/* Hidden, not unmounted, while this version shows: the way back finds the diff as it was. */}
        <Activity mode={view === 'version' ? 'hidden' : 'visible'}>
          {description.strip !== null && failure === null && (
            <DiffStrip strip={description.strip} navigation={lines === null ? null : navigation} />
          )}
          {refreshFailed !== null && (
            <DiffRefreshFailed error={refreshFailed.error} onRetry={retry} failedAgain={failedAgain} />
          )}
          {lines === null ? (
            <div className="diff-scroll" aria-busy={busy || undefined}>
              {banners}
              <Body
                target={target}
                description={description}
                failure={failure}
                actions={actions}
                stateActions={stateActions}
                focusHeading={focusHeading}
              />
            </div>
          ) : (
            <DiffLines
              ref={linesRef}
              read={read}
              checked={checked}
              word={lines.word}
              label={regionLabel(t, target, description)}
              banners={banners}
              tags={description.tags}
              current={navigation.changes > 0 ? navigation.current : null}
              onWindows={onWindows}
            />
          )}
        </Activity>
        {view === 'version' && versionFile !== null && (
          <PreviewArea file={versionFile} actions={actions} onEscape={focusHeading} />
        )}
      </div>
    </div>
  );
}
