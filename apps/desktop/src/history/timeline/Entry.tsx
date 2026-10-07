import type { TFunction } from 'i18next';
import {
  Archive,
  CircleCheck,
  Cloud,
  CloudDownload,
  Flag,
  Laptop,
  type LucideIcon,
  Pencil,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { COMMIT_ACTIONS_HOST, COMMIT_ATTRIBUTE, CommitActionButtons, commitMenuHandlers } from '../../app/CommitActions';
import { useWorkspace } from '../../data/workspace';
import type { CommitInfo } from '../../ipc';
import { SIZE } from '../../tokens/tokens';
import { EntryCard } from '../cards/FileCard';
import { ENTRY_MENU } from '../menus/EntryMenu';
import { dayLabel, timeParts, whenLabel } from '../model/days';
import { type EntryKind, type EntryPlace, type EntrySource, entryText } from '../model/entries';
import type { TimelineRow } from '../model/timelineRows';

/** The 16 px Lucide icon of each kind (§7.2, app-shell §7; decision B3 for prune). */
const ICONS: Record<EntryKind, LucideIcon> = {
  commit: CircleCheck,
  first: Flag,
  import: CloudDownload,
  prune: Archive,
  reword: Pencil,
  uncommit: Undo2,
  restore: RotateCcw,
};

export interface EntryProps {
  /** The entry, and in one file's history what it says of the file. */
  row: TimelineRow;
  place: EntryPlace;
  /** Its position in the whole list, from 1, and the list's length (`-1` while unknown). */
  position: number;
  setSize: number;
  /** The timeline's tab stop. */
  tabStop: boolean;
  /** Today, for the day headers and dates. */
  now: number;
  /** A restore entry that just arrived: the soft background for `FRESH_COMMIT_MS`, after a fade and rise (§7.2, §14). */
  fresh?: boolean;
}

/** The day and time, and where a commit was made: "Today, Oct 14, 5:05 PM, made on G16". */
function describe(source: EntrySource | null, when: string, t: TFunction<'history'>): string {
  if (source === null) return t('entry.describe.plain', { when });
  if (source.kind === 'icloud') return t('entry.describe.icloud', { when });
  return t('entry.describe.device', { when, device: source.name });
}

/**
 * One entry of the timeline (handoff workspace-history §7.2, §7.4, §7.6; the canvas's HistoryPanel):
 * its day header when it starts a day, visual only, then an `article` in three columns: the time
 * (with its date when that is not the day it is grouped under), the icon on the line joining the
 * entries, and the title with the short id, the source and, in one file's history, "Current
 * version", then the body or the first commit's note, then its file card. The article is named by
 * its title and described by its day, time and source, its short id, "Current version" and its
 * whole body. Before a file that came later, the first commit's note says it wasn't there yet.
 * A commit's entry shows Edit message and Undo commit at the right of its title while the pointer is
 * over it or the focus is in it, and has the commit's context menu (§7.3, `CommitActions`).
 */
export function Entry({ row, place, position, setSize, tabStop, now, fresh = false }: EntryProps) {
  const { t, i18n } = useTranslation('history');
  const ids = useId();
  const language = i18n.language;
  const { item } = row;
  const commit = item.kind === 'commit' ? item.commit : null;
  // The commit's context menu; a file card's rows open their own and mark the event handled.
  const menu = commit === null ? undefined : commitMenuHandlers(commit, ENTRY_MENU);
  const text = entryText(item, now, language);
  const note = row.kind === 'before' ? t('file.notYet', { name: row.name }) : text.note;
  const current = row.kind === 'version' && row.current;
  const Icon = ICONS[text.kind];
  const { time, date } = timeParts(text.timeMs, text.effectiveMs, now, language);
  const when = whenLabel(text.timeMs, now, language);
  const describedBy = [
    `${ids}-when`,
    `${ids}-id`,
    current ? `${ids}-current` : null,
    note === null ? null : `${ids}-note`,
    text.body === null ? null : `${ids}-body`,
  ]
    .filter((id) => id !== null)
    .join(' ');

  return (
    <>
      {place.startsDay && (
        <div className="day-header" aria-hidden>
          {dayLabel(text.effectiveMs, now, language)}
        </div>
      )}
      <article
        className={commit === null ? 'entry' : `entry ${COMMIT_ACTIONS_HOST}`}
        {...(commit === null ? undefined : { [COMMIT_ATTRIBUTE]: commit.id })}
        data-entry={place.key}
        data-kind={text.kind}
        data-fresh={fresh || undefined}
        tabIndex={tabStop ? 0 : -1}
        aria-posinset={position}
        aria-setsize={setSize}
        aria-labelledby={`${ids}-title`}
        aria-describedby={describedBy}
        onKeyDown={menu?.onKeyDown}
        onContextMenu={menu?.onContextMenu}
      >
        <div className="entry__time" aria-hidden>
          {date !== null && <span className="entry__date">{date}</span>}
          <span>{time}</span>
        </div>
        <div className="entry__rail" aria-hidden>
          <span className="entry__line" data-hidden={!place.lineAbove || undefined} />
          <span className="entry__icon">
            <Icon size={SIZE.icon} />
          </span>
          <span className="entry__line entry__line--below" data-hidden={!place.lineBelow || undefined} />
        </div>
        <div className="entry__content">
          <div className="entry__top">
            <p className="entry__head">
              <span id={`${ids}-title`} className="entry__title">
                {text.title}
              </span>
              <Gap small />
              <span id={`${ids}-id`} className="entry__id">
                {text.shortId}
              </span>
              {text.source !== null && (
                <>
                  <Gap />
                  <Source source={text.source} />
                </>
              )}
              {current && (
                <>
                  <Gap />
                  <span id={`${ids}-current`} className="entry__pill">
                    {t('file.current')}
                  </span>
                </>
              )}
            </p>
            {commit !== null && <EntryActions commit={commit} />}
          </div>
          {text.body !== null && (
            <p id={`${ids}-body`} className="entry__body" title={text.body}>
              {text.body}
            </p>
          )}
          {note !== null && (
            <p id={`${ids}-note`} className="entry__note">
              {note}
            </p>
          )}
          <EntryCard row={row} />
          <span id={`${ids}-when`} className="visually-hidden">
            {describe(text.source, when, t)}
          </span>
        </div>
      </article>
    </>
  );
}

/** A commit's hover actions, disabled with the reason while the history is read-only or damaged (§7.3, §7.5). */
function EntryActions({ commit }: { commit: CommitInfo }) {
  const historyState = useWorkspace().data?.historyState;
  return <CommitActionButtons commit={commit} historyState={historyState} />;
}

/**
 * The gap before the short id (6 px), the source and the pill (8 px) on the title's line: a space
 * as wide as the gap, which a line that wraps there drops, so what wraps starts at the title's edge
 * as the body and the card do (a margin would stay at the start of the new line).
 */
function Gap({ small = false }: { small?: boolean }) {
  return (
    <span className="entry__gap" data-size={small ? 'small' : undefined}>
      {' '}
    </span>
  );
}

/** Where a commit was made: `laptop` and the device's name, or `cloud` and "iCloud" (app-shell §7). */
function Source({ source }: { source: EntrySource }) {
  const { t } = useTranslation('history');
  const icloud = source.kind === 'icloud';
  const SourceIcon = icloud ? Cloud : Laptop;
  return (
    <span className="entry__source" title={icloud ? t('entry.fromICloud') : t('entry.madeOn', { device: source.name })} aria-hidden>
      <SourceIcon size={SIZE.iconTiny} />
      <span>{icloud ? t('entry.icloud') : source.name}</span>
    </span>
  );
}
