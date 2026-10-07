// Numbers, sizes, dates and times in the UI language (i18n README). Every function takes the
// language, usually `i18n.language`: without one, Windows would choose the locale.

const DAY_MS = 24 * 60 * 60 * 1000;
const UNITS = ['kilobytes', 'megabytes', 'gigabytes', 'terabytes'] as const;

/** A unit of `sizeParts`; its label is `common:size.<unit>` ("{{value}} KB"). */
export type SizeUnit = 'bytes' | (typeof UNITS)[number];

/**
 * Formatters by language and options: building one negotiates the locale and costs far more than
 * formatting with it, and lists format a size and a date on every row.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(language: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${language} ${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (format === undefined) {
    format = new Intl.NumberFormat(language, options);
    numberFormats.set(key, format);
  }
  return format;
}

function dateFormat(language: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${language} ${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(language, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** "4,210". */
export function formatNumber(value: number, language: string): string {
  return numberFormat(language).format(value);
}

/**
 * A size in bytes as Windows counts it (1 KB = 1,024 bytes), split for `common:size.<unit>`:
 * "512 B", "12 KB", "48.2 MB". Bytes and kilobytes are whole numbers; larger units keep one
 * decimal.
 */
export function sizeParts(bytes: number, language: string): { value: string; unit: SizeUnit } {
  const unit = unitOf(bytes);
  return { value: sizeIn(bytes, unit, language), unit };
}

/**
 * Bytes done of a total, both in the total's unit, for "12.4 of 48.0 MB": a job that reads files
 * (`Progress.bytes`). Digits as in `sizeParts`.
 */
export function sizeProgressParts(done: number, total: number, language: string): { done: string; total: string; unit: SizeUnit } {
  const unit = unitOf(total);
  return { done: sizeIn(done, unit, language), total: sizeIn(total, unit, language), unit };
}

/** The unit `bytes` is shown in: the largest in which it is at least 1, bytes below 1 KB. */
function unitOf(bytes: number): SizeUnit {
  if (bytes < 1024) return 'bytes';
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return UNITS[index] ?? 'terabytes';
}

/** `bytes` in `unit`: bytes and kilobytes whole, larger units with one decimal. */
function sizeIn(bytes: number, unit: SizeUnit, language: string): string {
  if (unit === 'bytes') return formatNumber(Math.max(0, Math.round(bytes)), language);
  const digits = unit === 'kilobytes' ? 0 : 1;
  const format = numberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return format.format(bytes / 1024 ** (UNITS.indexOf(unit) + 1));
}

/** "5:05 PM". */
export function formatTime(ms: number, language: string): string {
  return dateFormat(language, { hour: 'numeric', minute: '2-digit' }).format(ms);
}

/** "Sep 27". */
export function formatShortDate(ms: number, language: string): string {
  return dateFormat(language, { month: 'short', day: 'numeric' }).format(ms);
}

/** The time for a moment today, the date for an earlier day: "5:12 PM", "Sep 27". */
export function formatMoment(ms: number, now: number, language: string): string {
  return isSameDay(ms, now) ? formatTime(ms, language) : formatShortDate(ms, language);
}

const DATE_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};
const DATE_TIME_YEAR: Intl.DateTimeFormatOptions = { ...DATE_TIME, year: 'numeric' };

/** A date and time, the year only when it is not this year: "Oct 13, 9:30 PM", "Oct 13, 2025, 9:30 PM". */
export function formatDateTime(ms: number, language: string, now = Date.now()): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return dateFormat(language, sameYear ? DATE_TIME : DATE_TIME_YEAR).format(ms);
}

/** A date, the year only when it is not this year: "Oct 13", "Oct 13, 2025". */
export function formatDate(ms: number, language: string, now = Date.now()): string {
  if (new Date(ms).getFullYear() === new Date(now).getFullYear()) return formatShortDate(ms, language);
  return dateFormat(language, { month: 'short', day: 'numeric', year: 'numeric' }).format(ms);
}

/** Whether two moments fall on the same calendar day here. */
export function isSameDay(a: number, b: number): boolean {
  if (Math.abs(a - b) >= DAY_MS) return false;
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/** A share between 0 and 1 as a whole percentage, never 100 before the work is done. */
export function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  const percent = Math.floor((done / total) * 100);
  return Math.min(Math.max(percent, 0), done >= total ? 100 : 99);
}
