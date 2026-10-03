import type { FailureItem } from './FailureList';

/** "Copy details" of a result dialog: what failed, then a line per item, its place and why. */
export function failureDetails(title: string, items: readonly FailureItem[]): string {
  return [title, ...items.map((item) => `${item.place}: ${item.reason}`)].join('\n');
}
