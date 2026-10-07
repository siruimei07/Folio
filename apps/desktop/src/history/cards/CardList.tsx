import { FileCog, Folder, FolderOpen, type LucideIcon, Settings, Tag, Tags } from 'lucide-react';
import { type FocusEvent, type KeyboardEvent, type MouseEvent, type Ref, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CommitRef } from '../../app/panes';
import { ChangeStatusIcon } from '../../components/ChangeStatusIcon/ChangeStatusIcon';
import { keyboardMenuAnchor } from '../../components/collections/rows';
import { FileTypeIcon } from '../../components/FileTypeIcon/FileTypeIcon';
import { isContextMenuKey } from '../../components/Menu/Menu';
import { PathText } from '../../components/PathHeading/PathHeading';
import { SelectionIndicator } from '../../components/SelectionIndicator/SelectionIndicator';
import { useCourses } from '../../data/groups';
import type { Course } from '../../ipc';
import { SIZE } from '../../tokens/tokens';
import { hasFileMenu } from '../menus/FileMenuItems';
import { keyboardMenuOpen, openRowMenu } from '../menus/RowMenu';
import { type CardRow, type CardRowIcon, cardRowId, type CardRowText, describeCardRow } from '../model/rows';
import { CardHostContext } from './host';

const ICONS: Readonly<Record<Exclude<CardRowIcon['kind'], 'file'>, LucideIcon>> = {
  folder: Folder,
  folderOpen: FolderOpen,
  tag: Tag,
  settings: Settings,
  tags: Tags,
  fileCog: FileCog,
};

const NO_COURSES: readonly Course[] = [];

/**
 * A card's row element by its index. Rows carry `data-index`, so the shared keyboard menu anchor
 * (`keyboardMenuAnchor`) finds the row, and its path, before the timeline item around the card.
 */
export function cardOptionAt(list: Element, index: number): HTMLElement | null {
  return list.querySelector<HTMLElement>(`[role="option"][data-index="${String(index)}"]`);
}

/** The index of the card row an event happened in; `null` outside the rows. */
function optionIndex(target: EventTarget): number | null {
  const option = target instanceof Element ? target.closest<HTMLElement>('[role="option"][data-index]') : null;
  return option === null ? null : Number(option.dataset.index);
}

/** A row of a card and the commit of its version: the card's own, or a restore's version. */
export interface CardItem {
  row: CardRow;
  commit: CommitRef;
}

function RowIcon({ icon }: { icon: CardRowIcon }) {
  if (icon.kind === 'file') return <FileTypeIcon name={icon.name} />;
  const Icon = ICONS[icon.kind];
  return <Icon size={SIZE.icon} />;
}

/** What a row shows (app-shell §7): the icon, the path, the "Tags" tag of a tag change, the status. */
function CardRowView({ text, selected }: { text: CardRowText; selected: boolean }) {
  const { t } = useTranslation('history');
  return (
    <>
      {selected && <SelectionIndicator />}
      <span className="card-row__icon" aria-hidden>
        <RowIcon icon={text.icon} />
      </span>
      <PathText {...text.path} title={text.tooltip} />
      {text.tagsTag && <span className="card-row__tag">{t('cards.tags')}</span>}
      <span className="card-row__status">
        <ChangeStatusIcon status={text.status} />
      </span>
    </>
  );
}

export interface CardListProps {
  /** The listbox's name: "Changes in this commit". */
  label: string;
  items: readonly CardItem[];
  /** The id (`cardRowId`) of the row the diff shows, when it is in this card. */
  selectedId: string | null;
  /** Rows in the whole card, of which these are the first: "1 of 6". */
  setSize: number;
  /** Shows a row's version. */
  onSelect: (item: CardItem) => void;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A card's rows as a single-select listbox with roving focus (handoff workspace-history §7.6): one
 * tab stop per card (the row last focused, else the one the diff shows, else the first); Up, Down,
 * Home and End move the focus; Enter, Space or a click shows that version (`aria-selected`), and
 * Enter on the row already shown moves the focus into the diff. Page Up and Page Down go on to the
 * timeline, which moves between entries. Shift+F10, the Menu key and a right-click open the row's
 * menu (§7.3).
 */
export function CardList({ label, items, selectedId, setSize, onSelect, ref }: CardListProps) {
  const { t, i18n } = useTranslation(['history', 'common']);
  const courses = useCourses().data ?? NO_COURSES;
  const host = useContext(CardHostContext);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const ids = items.map((item) => cardRowId(item.row));
  const has = (id: string | null): id is string => id !== null && ids.includes(id);
  const stop = has(focusedId) ? focusedId : has(selectedId) ? selectedId : (ids[0] ?? null);
  const context = { t, language: i18n.language, courses };

  const focusAt = (list: HTMLElement, index: number) => {
    const at = Math.max(0, Math.min(items.length - 1, index));
    cardOptionAt(list, at)?.focus();
  };

  const choose = (index: number, enter: boolean) => {
    const item = items[index];
    if (item === undefined) return;
    if (enter && ids[index] === selectedId) {
      host.focusDiff();
      return;
    }
    onSelect(item);
  };

  const openMenu = (index: number, anchor: { x: number; y: number }, keyboard: boolean) => {
    const item = items[index];
    if (item === undefined || !hasFileMenu(item.row)) return;
    openRowMenu({ anchor, commit: item.commit, row: item.row, keyboard });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const index = optionIndex(event.target);
    if (index === null) return;
    const { key, shiftKey, ctrlKey, altKey, metaKey } = event;
    const list = event.currentTarget;
    if (isContextMenuKey(event)) {
      // Under the row's path, as the Library's and Changes' menus open from the keyboard.
      openMenu(index, keyboardMenuAnchor(event.target), true);
    } else if (shiftKey || ctrlKey || altKey || metaKey) {
      return;
    } else if (key === 'ArrowDown') {
      focusAt(list, index + 1);
    } else if (key === 'ArrowUp') {
      focusAt(list, index - 1);
    } else if (key === 'Home') {
      focusAt(list, 0);
    } else if (key === 'End') {
      focusAt(list, items.length - 1);
    } else if (key === 'Enter' || key === ' ') {
      choose(index, key === 'Enter');
    } else {
      return;
    }
    event.preventDefault();
  };

  // The tab stop follows the focus, however it came: the keys, a click, Tab, the card after "Show more".
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const index = optionIndex(event.target);
    const id = index === null ? undefined : ids[index];
    if (id !== undefined) setFocusedId(id);
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    // Shift+F10 and the Menu key open the menu on keydown; the browser then fires `contextmenu` on
    // the focused row too, which is that menu's echo while it is open.
    if (keyboardMenuOpen()) return;
    // The row takes the focus first, so closing the menu returns it there.
    event.currentTarget.focus();
    openMenu(index, { x: event.clientX, y: event.clientY }, false);
  };

  return (
    <div ref={ref} role="listbox" aria-label={label} className="file-card__rows" onKeyDown={onKeyDown} onFocus={onFocus}>
      {items.map((item, index) => {
        const id = ids[index] ?? '';
        const text = describeCardRow(item.row, context);
        const selected = id === selectedId;
        return (
          <div
            key={id}
            role="option"
            className="card-row"
            data-index={index}
            data-deleted={text.deleted || undefined}
            aria-selected={selected}
            aria-label={text.label}
            aria-posinset={index + 1}
            aria-setsize={setSize}
            tabIndex={id === stop ? 0 : -1}
            onClick={() => {
              choose(index, false);
            }}
            onContextMenu={(event) => {
              onContextMenu(event, index);
            }}
          >
            <CardRowView text={text} selected={selected} />
          </div>
        );
      })}
    </div>
  );
}
