import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CollectionHandle, IndexRange } from '../../components/collections/useVirtualRows';
import { type TreeRow, VirtualTree } from '../../components/collections/VirtualTree';
import { courseLabel, courseTitle } from '../../lib/courses';
import { DOUBLE_CLICK_MS } from '../../lib/timing';
import { nameOf } from '../../lib/paths';
import { SIZE, SPACE } from '../../tokens/tokens';
import { useActivate } from '../activate';
import { useEntryKeys } from '../commands';
import { useDropRows } from '../drop/useFileDrop';
import { useDragMove } from '../move/useDragMove';
import { useQuickCounts } from '../quick';
import { NewFolderField, RenameField } from '../edit/RenameField';
import { applySelection, focusedIndexOf, refOf } from '../selecting';
import { selectOnly, setExpanded, setOffset, setReveal, startRename, useLibraryView } from '../state';
import { useRowLabel, useTagLookup } from '../TagDots';
import { entryOf, selectableRows, type TreeItem, type TreeModel } from './layout';
import { TreeRowView } from './TreeRowView';

export interface TreeViewProps {
  model: TreeModel;
  /** The tree's accessible name. */
  label: string;
  /** The rows on screen, for the pages they need. */
  onRangeChange?: (range: IndexRange) => void;
}

/**
 * The Library tree (app-shell handoff §5; UI architecture §8.2), browsing or filtered: quick
 * views, courses with their folders and files, then loose files. Clicking a course or folder
 * toggles and shows it; clicking a file shows it; Enter shows the focused row; Ctrl and Shift
 * select several. Menus, inline rename and dragging to move work the same in both.
 */
export function TreeView({ model: layout, label, onRangeChange }: TreeViewProps) {
  const { t } = useTranslation('library');
  const panel = useLibraryView((state) => state.panel);
  const active = useLibraryView((state) => state.active);
  const reveal = useLibraryView((state) => state.reveal);
  const renaming = useLibraryView((state) => state.renaming);
  const [initialOffset] = useState(() => useLibraryView.getState().offsets.panel);
  const tags = useTagLookup();
  const rowLabel = useRowLabel(tags);
  const counts = useQuickCounts();
  const activate = useActivate();
  const handle = useRef<CollectionHandle>(null);
  const slowClick = useRef<number | undefined>(undefined);
  const rows = selectableRows(layout);
  const keys = useEntryKeys('panel', rows, (index) => layout.folderAt(index));
  const drag = useDragMove(layout);
  const fileDrop = useDropRows(layout);
  const refocus = () => {
    handle.current?.focusFocused();
  };

  /** The name field of a row being renamed, or of a new folder. */
  const editor = (item: TreeItem): ReactNode => {
    if (item.kind === 'newFolder') {
      return <NewFolderField parent={item.parent} taken={() => layout.childNames(item.parent.id)} onDone={refocus} />;
    }
    const entry = entryOf(item);
    if (entry === null || renaming?.region !== 'panel' || renaming.id !== entry.id) return undefined;
    return <RenameField entry={entry} region="panel" onDone={refocus} />;
  };

  const focusedIndex = focusedIndexOf(
    panel.focus,
    layout.count,
    (index) => layout.rowAt(index).key,
    (key) => layout.indexOfKey(key),
  );


  const quickSelected = (view: string) =>
    active?.kind === 'quick' && active.view === view && panel.entries.size === 0;

  const treeRow = (index: number): TreeRow => {
    const item = layout.rowAt(index);
    const base = { key: item.key, level: item.level, posinset: item.posinset, setsize: item.setsize };
    switch (item.kind) {
      case 'separator':
        return { ...base, kind: 'separator', focusable: false, selected: false };
      case 'quick': {
        const name = t(`tree.quick.${item.view}`);
        const count = counts[item.view];
        return {
          ...base,
          kind: 'item',
          focusable: true,
          selected: quickSelected(item.view),
          name,
          label: count === undefined ? name : t('tree.quickCount', { name, count }),
        };
      }
      case 'course':
        return {
          ...base,
          kind: 'item',
          focusable: true,
          expanded: item.expanded,
          selected: panel.entries.has(item.course.folder.id),
          name: courseLabel(item.course),
          label: t('tree.course', {
            label: courseTitle(item.course),
            count: item.count ?? item.course.files,
          }),
        };
      case 'entry':
        return {
          ...base,
          kind: 'item',
          focusable: true,
          expanded: item.expanded,
          selected: panel.entries.has(item.row.id),
          name: item.row.name,
          label: rowLabel(item.row),
        };
      case 'empty':
        return { ...base, kind: 'item', focusable: false, selected: false, label: t('tree.empty') };
      case 'failed':
        return { ...base, kind: 'item', focusable: true, selected: false, label: t('tree.failed') };
      case 'newFolder':
        return { ...base, kind: 'item', focusable: true, selected: false, label: t('tree.newFolder') };
      case 'pathFolder':
        return { ...base, kind: 'item', focusable: true, expanded: true, selected: false, name: nameOf(item.path) };
      case 'placeholder':
      case 'loading':
        return { ...base, kind: 'item', focusable: true, selected: false, busy: true, label: t('tree.loading') };
    }
  };

  /** Click or Enter: what the row shows; a click on a course or folder also toggles it. */
  const open = (index: number, toggle: boolean) => {
    const item = layout.rowAt(index);
    switch (item.kind) {
      case 'quick':
        activate({ kind: 'quick', view: item.view });
        break;
      case 'course':
        if (toggle && layout.collapsible) setExpanded(item.course.folder.path, !item.expanded);
        activate({ kind: 'folder', entry: item.course.folder });
        break;
      case 'entry':
        if (item.row.kind === 'folder') {
          if (toggle && layout.collapsible) setExpanded(item.row.path, item.expanded !== true);
          activate({ kind: 'folder', entry: refOf(item.row) });
        } else {
          activate({ kind: 'file', entry: refOf(item.row) });
        }
        break;
      case 'failed':
        item.retry();
        break;
      default:
        break;
    }
  };

  const showRevealed = useEffectEvent((index: number) => {
    open(index, false);
  });
  // A reveal ends once its entry has a row: selected, focused, scrolled to and shown (§8.2).
  useEffect(() => {
    if (reveal === null) return;
    const index = layout.indexOfKey(reveal.id);
    if (index === null) return;
    selectOnly('panel', reveal.id, index, entryOf(layout.rowAt(index)));
    handle.current?.scrollToIndex(index);
    handle.current?.focusFocused();
    setReveal(null);
    showRevealed(index);
  }, [reveal, layout]);

  return (
    <>
      <VirtualTree
        ref={handle}
        label={label}
        className="library-tree"
        count={layout.count}
        rowAt={treeRow}
        rowHeight={(index) => (layout.separators.has(index) ? SIZE.treeSeparator : SIZE.row)}
        sizesKey={[...layout.separators].join(',')}
        padding={SPACE[6]}
        focusedIndex={focusedIndex}
        initialOffset={initialOffset}
        onOffsetChange={(offset) => {
          setOffset('panel', offset);
        }}
        onRangeChange={onRangeChange}
        renderRow={(index, row) => {
          const item = layout.rowAt(index);
          return (
            <TreeRowView
              item={item}
              selected={row.selected}
              count={item.kind === 'quick' ? counts[item.view] : undefined}
              tags={tags}
              editor={editor(item)}
              drop={drag.dropOn(item) ?? fileDrop(item)}
            />
          );
        }}
        onNavigate={(index, move) => {
          applySelection('panel', rows, index, move);
        }}
        onToggle={(index) => {
          applySelection('panel', rows, index, 'toggle');
        }}
        collapsible={layout.collapsible}
        onExpand={(index, expanded) => {
          const entry = entryOf(layout.rowAt(index));
          if (entry !== null) setExpanded(entry.path, expanded);
        }}
        onAction={(index) => {
          applySelection('panel', rows, index, 'replace');
          open(index, false);
        }}
        onRowClick={(index, intent, event) => {
          window.clearTimeout(slowClick.current);
          if (drag.justDragged()) return;
          const entry = entryOf(layout.rowAt(index));
          const { entries } = useLibraryView.getState().panel;
          const onName = event.target instanceof Element && event.target.closest('[data-menu-anchor]') !== null;
          // A slow second click on the name of the one selected file renames it (§7.1); a click on a
          // course or folder toggles it, so theirs rename with F2 or the menu.
          if (intent === 'replace' && onName && entry?.kind === 'file' && entries.size === 1 && entries.has(entry.id)) {
            slowClick.current = window.setTimeout(() => {
              startRename(entry.id, 'panel');
            }, DOUBLE_CLICK_MS);
            return;
          }
          applySelection('panel', rows, index, intent);
          if (intent === 'replace') open(index, true);
        }}
        onRowDoubleClick={(index) => {
          window.clearTimeout(slowClick.current);
          const item = layout.rowAt(index);
          if (item.kind === 'entry' && item.row.kind === 'file') keys.openFile(refOf(item.row));
        }}
        onRowPointerDown={drag.onPointerDown}
        onRowContextMenu={(index, event) => {
          keys.contextMenu(index, event);
        }}
        onBackgroundContextMenu={(event) => {
          keys.backgroundMenu(event);
        }}
        onKeyDown={keys.onKeyDown}
      />
      {drag.chip}
    </>
  );
}
