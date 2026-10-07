import './FileCard.css';

import { useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import type { IpcFailure } from '../../data/errors';
import { historyItemKey, useCommitChanges, useCommitMetadata, useEntryListsFetching, useVersionChange } from '../../data/history';
import type { HistoryItem } from '../../ipc';
import { CARD_ROWS, type CardRow, cardShape } from '../model/rows';
import { type CardAnchor, commitAnchor, commitAnchorKey, refindRow, selectedRowIn } from '../model/selection';
import type { TimelineRow, VersionRow } from '../model/timelineRows';
import { expandCard, setSelection, useHistoryView } from '../state';
import { type CardItem, CardList, cardOptionAt } from './CardList';
import { CardHostContext } from './host';

type CommitItem = Extract<HistoryItem, { kind: 'commit' }>;
type RestoreItem = Extract<HistoryItem, { kind: 'restore' }>;

/**
 * The selection when it is in this card, and its row found again by path when the card's rows no
 * longer have its id (a change key that moved with a reworded commit's id).
 */
function useCardSelection(item: HistoryItem, rows: readonly CardRow[]): string | null {
  const selection = useHistoryView((state) => state.selection);
  useEffect(() => {
    if (selection === null || selectedRowIn(selection, item) === null) return;
    const row = refindRow(selection, rows);
    if (row !== undefined) setSelection({ ...selection, row });
  }, [selection, item, rows]);
  return selectedRowIn(selection, item);
}

/**
 * "Show all" and "Show more" put the focus on the first row they added, when the button still had
 * it or it had fallen to the page with the button: `mark()` as one is pressed.
 */
function useFocusAddedRows(rowCount: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const from = useRef<number | null>(null);
  // Before the timeline's focus keeper sees the button go, so the focus stays in the card.
  useLayoutEffect(() => {
    const at = from.current;
    if (at === null || rowCount <= at) return;
    from.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== buttonRef.current) return;
    if (listRef.current !== null) cardOptionAt(listRef.current, at)?.focus();
  }, [rowCount]);
  return {
    listRef,
    buttonRef,
    mark: () => {
      from.current = rowCount;
    },
  };
}

/** A failed page of the card's rows (a `NotFound` waits for the timeline's refresh instead). */
function CardFailure({ text, retry }: { text: string; retry: () => void }) {
  const { t } = useTranslation(['history', 'shell']);
  return (
    <div className="file-card__more" role="alert">
      <span className="file-card__failed">{text}</span>
      <Button variant="link" onPress={retry}>
        {t('shell:tryAgain')}
      </Button>
    </div>
  );
}

function visibleFailure(failure: IpcFailure | null): IpcFailure | null {
  // A reword gives the commit a new id: its old id answers `NotFound` until the timeline's refetch
  // replaces this card with the commit's new one (HistoryChanged refreshes both). An undone commit's
  // entry goes with that refetch; a restore entry stays, and its card then shows nothing (RestoreCard).
  return failure === null || failure.error.code === 'NotFound' ? null : failure;
}

/**
 * A commit's file card (handoff workspace-history §7.2, app-shell §7; decision B2): its first four
 * files and folders, or its first four tag and settings changes when it has nothing else; "Show
 * all N files" (or "N changes", counting tag and settings changes) reads the rest
 * (`list_commit_changes` in pages of 200, then `list_commit_metadata`), and "Show more" reads on.
 * A card stays open through a message edit (`commitAnchorKey`).
 */
function CommitCard({ item }: { item: CommitItem }) {
  const { t } = useTranslation('history');
  const host = useContext(CardHostContext);
  const { commit, files } = item;
  const shape = cardShape(item) ?? { rows: 0, total: 0 };
  const changeCount = commit.files + commit.folders;
  const anchorKey = commitAnchorKey(commit);
  const expanded = useHistoryView((state) => state.expanded.has(anchorKey));
  const onlyMetadata = changeCount === 0;
  const paged = expanded && changeCount > files.length;
  const changes = useCommitChanges(commit.id, paged);
  const metadata = useCommitMetadata(commit.id, commit.metadata > 0 && (expanded || onlyMetadata));
  const changesRead = !paged || (changes.status === 'success' && !changes.hasMore);

  const rows = useMemo((): CardRow[] => {
    if (!expanded && onlyMetadata) return metadata.items.slice(0, CARD_ROWS).map((change) => ({ kind: 'metadata', change }));
    const fileRows = paged && changes.items.length > 0 ? changes.items : files;
    const all: CardRow[] = fileRows.map((row) => ({ kind: 'file', row }));
    if (expanded && changesRead) for (const change of metadata.items) all.push({ kind: 'metadata', change });
    return all;
  }, [expanded, onlyMetadata, paged, changes.items, files, changesRead, metadata.items]);
  const selectedId = useCardSelection(item, rows);
  const { listRef, buttonRef, mark } = useFocusAddedRows(rows.length);

  const anchor = useMemo(() => commitAnchor(commit), [commit]);
  const items = useMemo(
    () => rows.map((row): CardItem => ({ row, commit: { id: commit.id, timeMs: commit.timeMs } })),
    [rows, commit.id, commit.timeMs],
  );
  const select = (chosen: CardItem) => {
    host.select({ card: anchor, commit: chosen.commit, row: chosen.row });
  };

  const failure = visibleFailure(changes.error) ?? visibleFailure(metadata.error);
  const loading =
    changes.isLoadingMore ||
    metadata.isLoadingMore ||
    changes.status === 'pending' ||
    (metadata.status === 'pending' && (expanded || rows.length === 0));
  const next = paged && changes.hasMore ? changes : changesRead && metadata.hasMore ? metadata : null;
  const showAll = !expanded && shape.total > shape.rows;

  let more = null;
  if (failure !== null) {
    more = <CardFailure text={t('cards.failed')} retry={changes.error === null ? metadata.retry : changes.retry} />;
  } else if (showAll || next !== null || (expanded && loading)) {
    const label = showAll
      ? commit.metadata > 0
        ? t('cards.showAllChanges', { count: shape.total })
        : t('cards.showAllFiles', { count: shape.total })
      : t('cards.showMore');
    more = (
      <div className="file-card__more">
        <PendingButton
          ref={buttonRef}
          variant="link"
          size="regular"
          pending={loading ? t('cards.loading') : null}
          onPress={() => {
            mark();
            if (showAll) expandCard(anchorKey);
            else next?.loadMore();
          }}
        >
          {label}
        </PendingButton>
      </div>
    );
  }

  return (
    <div className="file-card">
      {rows.length > 0 ? (
        <CardList
          ref={listRef}
          label={t('cards.label')}
          items={items}
          selectedId={selectedId}
          setSize={shape.total}
          onSelect={select}
        />
      ) : (
        <CardPlaceholder rows={shape.rows} />
      )}
      {more}
    </div>
  );
}

/** Rows whose changes are on their way. */
function CardPlaceholder({ rows }: { rows: number }) {
  return (
    <div className="file-card__rows" aria-hidden>
      {Array.from({ length: Math.max(1, rows) }, (_, index) => (
        <div key={index} className="card-row">
          <span className="card-row__placeholder" />
        </div>
      ))}
    </div>
  );
}

/**
 * A restore's card (§7.2): the restored file, at the path it had in the version's commit; selecting
 * it shows that version. Its row is the version's own (`useVersionChange`: the file's history read
 * to that commit), never found among its commit's changes, which may be thousands (decision 11).
 */
function RestoreCard({ item }: { item: RestoreItem }) {
  const { t } = useTranslation('history');
  const host = useContext(CardHostContext);
  const version = useVersionChange({ commit: item.commit, path: item.path });
  const listsFetching = useEntryListsFetching();
  const { isFetching, error, refetch } = version;
  const found = version.data ?? undefined;
  const retry = () => {
    void refetch();
  };

  const rows = useMemo((): CardRow[] => (found === undefined ? [] : [{ kind: 'file', row: found }]), [found]);
  const selectedId = useCardSelection(item, rows);
  const anchor = useMemo(
    (): CardAnchor => ({ kind: 'restore', key: historyItemKey(item), effectiveMs: Number(item.effectiveMs) }),
    [item],
  );
  const items = useMemo(
    () => rows.map((row): CardItem => ({ row, commit: { id: item.commit, timeMs: item.versionMs } })),
    [rows, item.commit, item.versionMs],
  );

  // The version's commit is gone (undone): `NotFound`, and the entries' refresh has settled with the
  // entry still naming it (a message edit's new id would have replaced it). No card, as for a version
  // no longer in its commit, even when its row read before is still at hand.
  if (error?.error.code === 'NotFound' && !isFetching && !listsFetching) return null;
  const failure = visibleFailure(error);
  if (found === undefined) {
    if (failure !== null) {
      return (
        <div className="file-card">
          <CardFailure text={t('cards.restoreFailed')} retry={retry} />
        </div>
      );
    }
    // Read, without its row: the version is no longer in its commit.
    if (version.data === null) return null;
    return (
      <div className="file-card">
        <CardPlaceholder rows={1} />
      </div>
    );
  }
  return (
    <div className="file-card">
      <CardList
        label={t('cards.restored')}
        items={items}
        selectedId={selectedId}
        setSize={1}
        onSelect={(chosen) => {
          host.select({ card: anchor, commit: chosen.commit, row: chosen.row });
        }}
      />
    </div>
  );
}

/**
 * A commit's card in one file's history (§7.4): only the file's row, with the path it had then, and
 * "and 2 other files in this commit" under it. The first commit's card has its row too, so the
 * file's first version can be shown; its note already counts the other files.
 */
function VersionCard({ row }: { row: VersionRow }) {
  const { t } = useTranslation('history');
  const host = useContext(CardHostContext);
  const { item, others } = row;
  const { commit, files } = item;
  const rows = useMemo(() => files.map((change): CardRow => ({ kind: 'file', row: change })), [files]);
  const selectedId = useCardSelection(item, rows);
  const anchor = useMemo(() => commitAnchor(commit), [commit]);
  const items = useMemo(
    () => rows.map((cardRow): CardItem => ({ row: cardRow, commit: { id: commit.id, timeMs: commit.timeMs } })),
    [rows, commit.id, commit.timeMs],
  );
  return (
    <div className="file-card">
      <CardList
        label={t('cards.version')}
        items={items}
        selectedId={selectedId}
        setSize={1}
        onSelect={(chosen) => {
          host.select({ card: anchor, commit: chosen.commit, row: chosen.row });
        }}
      />
      {others > 0 && !commit.first && <p className="file-card__others">{t('cards.others', { count: others })}</p>}
    </div>
  );
}

/**
 * An entry's file card, after its title and body: a commit's or a restore's in the whole history
 * (nothing for an entry without one, `cardShape`), the file's own row in one file's history, and
 * nothing for the first commit before a file that came later.
 */
export function EntryCard({ row }: { row: TimelineRow }) {
  if (row.kind === 'version') return <VersionCard row={row} />;
  if (row.kind === 'before') return null;
  const { item } = row;
  if (cardShape(item) === null) return null;
  if (item.kind === 'commit') return <CommitCard item={item} />;
  if (item.kind === 'restore') return <RestoreCard item={item} />;
  return null;
}
