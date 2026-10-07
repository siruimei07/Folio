// What a timeline entry says (handoff workspace-history §7.2, decision B3): its kind, title, short
// id, source and body, and how the entries fall into days. Pure, so the timeline renders only the
// entries on screen and the tests read the words without rendering.
import i18n from 'i18next';

import { historyItemKey } from '../../data/history';
import { type HistoryItem, shortId } from '../../ipc';
import { formatDate } from '../../lib/format';
import { nameOf } from '../../lib/paths';
import { dayKeyOf } from './days';

/**
 * commit, first (the first commit, "Start history"), import (changes from iCloud, M3), prune
 * (thinning out old Word versions, M3), and the operations reword, uncommit and restore.
 */
export type EntryKind = 'commit' | 'first' | 'import' | 'prune' | 'reword' | 'uncommit' | 'restore';

export function entryKind(item: HistoryItem): EntryKind {
  if (item.kind !== 'commit') return item.kind;
  if (item.commit.first) return 'first';
  return item.commit.kind;
}

/** Where a commit was made: a device by its name, or iCloud for direct edits found in the remote. */
export type EntrySource = { kind: 'device'; name: string } | { kind: 'icloud' };

/** The words of one entry. */
export interface EntryText {
  kind: EntryKind;
  title: string;
  /** "b7c1e20": the commit, the reworded commit's new id, the undone commit, the restored version's commit. */
  shortId: string;
  /** Commits only. */
  source: EntrySource | null;
  /** A commit's body: line breaks kept, three lines shown, the whole of it in its tooltip and description. */
  body: string | null;
  /** Under the first commit's title: "4,210 files were in your library when Folio started keeping history." */
  note: string | null;
  /** Its own time, as its device's clock said. */
  timeMs: number;
  /** The timeline's order and day: the later of its own time and the entry's before it. */
  effectiveMs: number;
}

function nonEmpty(text: string | null): string | null {
  return text === null || text.trim() === '' ? null : text;
}

/** The words of `item`; dates relative to `now` ("Oct 10", "Oct 10, 2025"). */
export function entryText(item: HistoryItem, now: number, language: string): EntryText {
  const kind = entryKind(item);
  switch (item.kind) {
    case 'commit': {
      const { commit } = item;
      const times = { timeMs: Number(commit.timeMs), effectiveMs: Number(commit.effectiveMs) };
      const source: EntrySource = kind === 'import' ? { kind: 'icloud' } : { kind: 'device', name: commit.device.name };
      const base = { kind, shortId: shortId(commit.id), source, body: nonEmpty(commit.body), note: null, ...times };
      if (kind === 'prune') return { ...base, title: i18n.t('history:entry.pruned', { count: commit.pruned }), body: null };
      if (kind === 'first') {
        return {
          ...base,
          title: nonEmpty(commit.summary) ?? i18n.t('history:entry.first'),
          note: i18n.t('history:entry.firstFiles', { count: commit.files }),
        };
      }
      return { ...base, title: nonEmpty(commit.summary) ?? i18n.t('history:entry.noMessage') };
    }
    case 'reword':
    case 'uncommit':
    case 'restore': {
      const base = {
        kind,
        shortId: shortId(item.commit),
        source: null,
        body: null,
        note: null,
        timeMs: Number(item.timeMs),
        effectiveMs: Number(item.effectiveMs),
      };
      if (item.kind === 'reword') return { ...base, title: i18n.t('history:entry.reword') };
      if (item.kind === 'uncommit') return { ...base, title: i18n.t('history:entry.uncommit', { summary: item.summary }) };
      return {
        ...base,
        title: i18n.t('history:entry.restore', {
          name: nameOf(item.path),
          date: formatDate(Number(item.versionMs), language, now),
        }),
      };
    }
  }
}

/** An entry's effective time without its words: the day it is grouped under. */
export function effectiveMsOf(item: HistoryItem): number {
  return Number(item.kind === 'commit' ? item.commit.effectiveMs : item.effectiveMs);
}

/** Where an entry sits among the days. */
export interface EntryPlace {
  key: string;
  /** It starts a day: its day header goes above it. */
  startsDay: boolean;
  /** The joining line meets the entry above it, which is in the same day. */
  lineAbove: boolean;
  /** The joining line goes on to the entry below it, which is in the same day. */
  lineBelow: boolean;
}

/** The entries' keys and days, in the list's order; `indexOf` finds an entry by key. */
export interface TimelineLayout {
  places: readonly EntryPlace[];
  indexOf: (key: string) => number | undefined;
}

/** How `items` (newest first) fall into days of their effective time. */
export function timelineLayout(items: readonly HistoryItem[]): TimelineLayout {
  const days = items.map((item) => dayKeyOf(effectiveMsOf(item)));
  const index = new Map<string, number>();
  const places = items.map((item, at): EntryPlace => {
    const key = historyItemKey(item);
    index.set(key, at);
    const startsDay = at === 0 || days[at - 1] !== days[at];
    const endsDay = at === items.length - 1 || days[at + 1] !== days[at];
    return { key, startsDay, lineAbove: !startsDay, lineBelow: !endsDay };
  });
  return { places, indexOf: (key) => index.get(key) };
}
