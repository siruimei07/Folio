import '../tree/Tree.css';

import { Folder } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CollectionHandle, IndexRange } from '../../components/collections/useVirtualRows';
import { type CollectionItem, VirtualList } from '../../components/collections/VirtualList';
import { type GridSection, VirtualGrid } from '../../components/collections/VirtualGrid';
import { FileTypeIcon } from '../../components/FileTypeIcon/FileTypeIcon';
import { useCourses } from '../../data/groups';
import type { LoadingPagedList } from '../../data/paged';
import { type EntryRef, type EntryRow, thumbnailUrl } from '../../ipc';
import { fileTypeOf } from '../../lib/file-types';
import { formatMoment } from '../../lib/format';
import { openPathsTo, parentOf } from '../../lib/paths';
import { SIZE, SPACE } from '../../tokens/tokens';
import { useActivate } from '../activate';
import { useEntryKeys } from '../commands';
import { RenameField } from '../edit/RenameField';
import { prefixOf } from '../places';
import { applySelection, entriesOf, focusedIndexOf, refOf, type SelectableRows, selectAll, selectedOf } from '../selecting';
import { loadedIndexes } from '../tree/layout';
import { expandAll, type Region, setOffset, useLibraryView } from '../state';
import { TagDots, useRowLabel, useTagLookup } from '../TagDots';
import { FolderCard, GroupLabel, useLeadingFolders } from './FolderCard';

const TILE_NAME = 'entry-tile__name';
const CARD_NAME = 'folder-card__name';
const ROW_NAME = 'entry-row__name';

/** File types Windows makes thumbnails of; the others show their icon. */
const THUMBNAILS: ReadonlySet<string> = new Set(['image', 'video', 'pdf', 'word', 'powerpoint', 'excel']);

/** The pane's rows as the selection and the menus read them; one per list, which keeps its identity. */
function paneRows(list: LoadingPagedList<EntryRow>): SelectableRows {
  // The loaded rows' indexes by id, built when first asked for.
  let ids: Map<string, number> | undefined;
  const indexOf = (key: string) => {
    ids ??= loadedIndexes(list, (row) => row.id);
    return ids.get(key) ?? null;
  };
  return {
    keyAt: (index) => list.rowKey(index),
    entryAt: (index) => {
      const row = list.rowAt(index);
      return row === undefined ? null : selectedOf(row);
    },
    indexOfKey: indexOf,
    entriesBetween: (from, to, limit) =>
      entriesOf(
        (function* () {
          for (let index = from; index <= to; index++) {
            const row = list.rowAt(index);
            yield row === undefined ? { list, index } : selectedOf(row);
          }
        })(),
        limit,
      ),
    tagsOf: (id) => {
      const index = indexOf(id);
      const row = index === null ? undefined : list.rowAt(index);
      return row === undefined ? undefined : { tags: row.tags, folderTags: row.folderTags };
    },
  };
}

/** A tile's picture: Windows' thumbnail where it has one, else the file type's icon. */
function Thumbnail({ row }: { row: EntryRow }) {
  const [failed, setFailed] = useState(false);
  const type = fileTypeOf(row.name);
  if (row.kind === 'folder') {
    return (
      <span className="entry-tile__thumbnail" aria-hidden>
        <Folder size={SIZE.iconThumbnail} className="entry-tile__folder" />
      </span>
    );
  }
  return (
    <span className="entry-tile__thumbnail" aria-hidden>
      {THUMBNAILS.has(type) && !failed ? (
        <img
          className="entry-tile__image"
          src={thumbnailUrl(row, 256)}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        <span className="entry-tile__type">
          <FileTypeIcon name={row.name} size="thumbnail" />
        </span>
      )}
    </span>
  );
}

export interface EntriesViewProps {
  /** The grid's or list's accessible name. */
  label: string;
  list: LoadingPagedList<EntryRow>;
  mode: 'grid' | 'list';
  onRangeChange: (range: IndexRange) => void;
  /** The course or folder shown, where a new folder goes; `null` for a quick view. */
  folder: EntryRef | null;
  /** Show where each file is before its name (quick views, the List mode). */
  showPlace: boolean;
  /** The panel's List mode, or the third column. */
  region?: Region;
}

/**
 * The files and folders of the third column (app-shell handoff §5) as a grid of tiles or a list:
 * a selection of their own, the same menus and keys as the tree, Enter to show a file or open a
 * folder, a double-click to open a file with its default app.
 */
export function EntriesView({ label, list, mode, onRangeChange, folder, showPlace, region = 'pane' }: EntriesViewProps) {
  const { t, i18n } = useTranslation('library');
  const selection = useLibraryView((state) => state[region]);
  const renaming = useLibraryView((state) => state.renaming);
  const [initialOffset] = useState(() => useLibraryView.getState().offsets[region]);
  const courses = useCourses().data ?? [];
  const tags = useTagLookup();
  const rowLabel = useRowLabel(tags);
  const activate = useActivate();
  const handle = useRef<CollectionHandle>(null);
  const rows = useMemo(() => paneRows(list), [list]);
  const keys = useEntryKeys(region, rows, (index) => {
    const row = list.rowAt(index);
    return row?.kind === 'folder' ? refOf(row) : folder;
  });
  // Dates read "5:05 PM" today and "Sep 27" before; today as of when the view opened.
  const [now] = useState(() => Date.now());

  const total = list.total ?? 0;
  const focusedIndex = focusedIndexOf(selection.focus, total, list.rowKey, rows.indexOfKey);
  // The grid's folders are cards in a group of their own above the files (35A); the list keeps one
  // kind of row. Both groups are labelled only when both have items.
  const folders = useLeadingFolders(list, mode === 'grid');
  const grouped = folders > 0 && folders < total;
  const sections = useMemo<GridSection[]>(
    () => [
      {
        count: folders,
        minTileWidth: SIZE.folderCardMin,
        tileHeight: SIZE.folderCard,
        gap: SPACE[8],
        label: grouped ? <GroupLabel name={t('cards.folders')} count={folders} /> : undefined,
      },
      {
        count: total - folders,
        minTileWidth: SIZE.gridTileMin,
        tileHeight: SIZE.gridTile,
        gap: SPACE[12],
        label: grouped ? <GroupLabel name={t('cards.files')} count={total - folders} /> : undefined,
      },
    ],
    [folders, total, grouped, t],
  );
  const countIds = useId();
  const countIdOf = (row: EntryRow) => `${countIds}-${row.id}`;

  const itemAt = (index: number): CollectionItem => {
    const row = list.rowAt(index);
    if (row === undefined) return { key: list.rowKey(index), selected: false, busy: true, label: t('tree.loading') };
    const selected = selection.entries.has(row.id);
    if (index < folders) {
      const label = rowLabel({ ...row, name: t('cards.folder', { name: row.name }) });
      return { key: row.id, selected, name: row.name, label, description: countIdOf(row) };
    }
    return { key: row.id, selected, name: row.name, label: rowLabel(row) };
  };

  /** Enter, or a double-click on a folder: a file's preview, a folder's contents. */
  const open = (index: number) => {
    const row = list.rowAt(index);
    if (row === undefined) return;
    const entry = refOf(row);
    if (row.kind === 'file') {
      activate({ kind: 'file', entry });
      return;
    }
    // The tree opens down to the folder as well, so its row is there when focus goes back.
    expandAll(openPathsTo(row.path));
    activate({ kind: 'folder', entry });
  };

  const nameOrField = (row: EntryRow, className: string) =>
    renaming?.region === region && renaming.id === row.id ? (
      <RenameField entry={selectedOf(row)} region={region} onDone={() => handle.current?.focusFocused()} />
    ) : (
      <span className={className} title={row.name} data-menu-anchor>
        {row.name}
      </span>
    );

  const common = {
    ref: handle,
    label,
    count: total,
    itemAt,
    focusedIndex,
    initialOffset,
    onOffsetChange: (offset: number) => {
      setOffset(region, offset);
    },
    onRangeChange,
    onNavigate: (index: number, move: 'replace' | 'extend' | 'focus') => {
      applySelection(region, rows, index, move);
    },
    onToggle: (index: number) => {
      applySelection(region, rows, index, 'toggle');
    },
    onAction: (index: number) => {
      applySelection(region, rows, index, 'replace');
      open(index);
    },
    onSelectAll: () => {
      selectAll(region, rows, total);
    },
    onRowClick: (index: number, intent: 'replace' | 'toggle' | 'extend') => {
      applySelection(region, rows, index, intent);
      // In the panel's list, a click shows the file, as in the tree.
      if (region === 'panel' && intent === 'replace') open(index);
    },
    onRowDoubleClick: (index: number) => {
      const row = list.rowAt(index);
      if (row?.kind === 'file') keys.openFile(refOf(row));
      else open(index);
    },
    onRowContextMenu: keys.contextMenu,
    onKeyDown: keys.onKeyDown,
  };

  if (mode === 'grid') {
    return (
      <VirtualGrid
        {...common}
        className="entry-grid"
        sections={sections}
        labelHeight={SIZE.gridGroupLabel}
        sectionGap={SPACE[12]}
        padding={SPACE[14]}
        renderItem={(index, item) => {
          const row = list.rowAt(index);
          if (row === undefined) return <div className="entry-tile" data-busy aria-hidden />;
          if (index < folders) {
            return <FolderCard row={row} selected={item.selected} name={nameOrField(row, CARD_NAME)} countId={countIdOf(row)} />;
          }
          return (
            <div className="entry-tile" data-selected={item.selected || undefined}>
              <Thumbnail row={row} />
              <span className="entry-tile__caption">
                {row.kind === 'folder' ? (
                  <Folder aria-hidden size={SIZE.icon} className="entry-tile__folder" />
                ) : (
                  <FileTypeIcon name={row.name} />
                )}
                {nameOrField(row, TILE_NAME)}
                <TagDots ids={row.tags} folderIds={row.folderTags} tags={tags} />
              </span>
            </div>
          );
        }}
      />
    );
  }

  return (
    <VirtualList
      {...common}
      className="entry-list"
      itemHeight={SIZE.row}
      padding={SPACE[6]}
      renderItem={(index, item) => {
        const row = list.rowAt(index);
        if (row === undefined) {
          return (
            <div className="entry-row" aria-hidden>
              <span className="tree-row__placeholder" />
            </div>
          );
        }
        const modified = row.modifiedMs === null ? null : Number(row.modifiedMs);
        return (
          <div className="entry-row" data-selected={item.selected || undefined}>
            {item.selected && <span className="tree-row__bar" aria-hidden />}
            {row.kind === 'folder' ? (
              <Folder aria-hidden size={SIZE.icon} className="tree-row__icon" />
            ) : (
              <FileTypeIcon name={row.name} />
            )}
            {showPlace && <span className="entry-row__place">{prefixOf(parentOf(row.path), courses)}</span>}
            {nameOrField(row, ROW_NAME)}
            <TagDots ids={row.tags} folderIds={row.folderTags} tags={tags} />
            {modified !== null && (
              <span className="entry-row__meta">{formatMoment(modified, now, i18n.language)}</span>
            )}
          </div>
        );
      }}
    />
  );
}
