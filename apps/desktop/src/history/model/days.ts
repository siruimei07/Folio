// Days and times of the timeline (handoff workspace-history §7.2, §7.6): entries are grouped by
// the day of their effective time, so a device with a wrong clock never breaks the order, while the
// time column shows an entry's own time, with its date when that falls on another day.
import i18n from 'i18next';

import { formatDate, formatShortDate, formatTime, isSameDay } from '../../lib/format';

/** The calendar day of a moment here, to compare entries by. */
export function dayKeyOf(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`;
}

/** The same time of day on the calendar day before `now`'s. */
function dayBefore(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() - 1);
  return date.getTime();
}

/** A day header: "Today, Oct 14", "Yesterday, Oct 13", "Oct 10", "Oct 10, 2025". */
export function dayLabel(ms: number, now: number, language: string): string {
  if (isSameDay(ms, now)) return i18n.t('history:day.today', { date: formatShortDate(ms, language) });
  if (isSameDay(ms, dayBefore(now))) return i18n.t('history:day.yesterday', { date: formatShortDate(ms, language) });
  return formatDate(ms, language, now);
}

/** What the time column shows: the time, and the date above it when that is not its group's day. */
export interface TimeParts {
  time: string;
  date: string | null;
}

/** An entry's own time (`timeMs`) in the group of its effective time (`groupMs`): "5:05 PM", or "Oct 12" over "4:31 PM". */
export function timeParts(timeMs: number, groupMs: number, now: number, language: string): TimeParts {
  return {
    time: formatTime(timeMs, language),
    date: isSameDay(timeMs, groupMs) ? null : formatDate(timeMs, language, now),
  };
}

/** An entry's own day and time for its description: "Today, Oct 14, 5:05 PM". */
export function whenLabel(timeMs: number, now: number, language: string): string {
  return i18n.t('history:day.when', { day: dayLabel(timeMs, now, language), time: formatTime(timeMs, language) });
}
