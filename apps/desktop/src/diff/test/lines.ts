// The lines' region in the pane's tests: what its lines show, scrolling it as jsdom cannot, the
// windows asked of the fake shell, and stubbed diffs of any shape answered window by window.
import type { Query, QueryClient } from '@tanstack/react-query';
import { act, fireEvent, within } from '@testing-library/react';
import { vi } from 'vitest';

import type { Diff, DiffRow, DiffWindow } from '../../ipc';
import { textDiff } from './diffs';
import { maxScroll } from '../../test/virtual';
import { fake, item, PHY, REVIEW } from './pane';

// Scrolling as jsdom cannot, shared with the other virtualised views' tests.
export { maxScroll, mockScrolling } from '../../test/virtual';

/** The estimates jsdom keeps: a line, a fold or failed window, the lead's gap. */
export const LINE = 22;
export const BAR = 32;
export const LEAD = 4;

/** What a line shows, read from its columns. */
export interface ShownLine {
  old: string;
  new: string;
  sign: string;
  /** The visually hidden "Added line" / "Removed line", without the space after it. */
  label: string | null;
  /** The text without the label. */
  text: string;
  marks: string[];
}

export function shownLines(region: HTMLElement): ShownLine[] {
  return [...region.querySelectorAll<HTMLElement>('.diff-line')].map((line) => {
    const [old, next] = line.querySelectorAll('.diff-line__number');
    const label = line.querySelector('.diff-line__label');
    const text = line.querySelector('.diff-line__text');
    return {
      old: old?.textContent ?? '',
      new: next?.textContent ?? '',
      sign: line.querySelector('.diff-line__sign')?.textContent ?? '',
      label: label?.textContent.trimEnd() ?? null,
      text: [...(text?.childNodes ?? [])]
        .filter((node) => node !== label)
        .map((node) => node.textContent)
        .join(''),
      marks: [...line.querySelectorAll('.diff-line__mark')].map((mark) => mark.textContent),
    };
  });
}

export function texts(region: HTMLElement): string[] {
  return shownLines(region).map((line) => line.text);
}

export function findRegion(pane: HTMLElement, name: string | RegExp = /^Changes in /) {
  return within(pane).findByRole('region', { name });
}

/** Scrolls the region as a person would: the offset moves, within the content, then the scroll event. */
export function scrollRegion(region: HTMLElement, top: number) {
  act(() => {
    region.scrollTop = Math.min(top, maxScroll(region));
    fireEvent.scroll(region);
  });
}

/** The display index (the item's, minus the lead) of the row at the top of the region. */
export function topRow(region: HTMLElement): number {
  const items = [...region.querySelectorAll<HTMLElement>('.diff-lines__item')]
    .map((element) => ({ index: Number(element.dataset.index), start: itemStart(element) }))
    .sort((a, b) => a.index - b.index);
  const top = items.filter((entry) => entry.start <= region.scrollTop).at(-1);
  if (top === undefined) throw new Error('no row at the top');
  return top.index - 1;
}

/** Where the virtualiser put an item of the region: its offset from the top of the content. */
export function itemStart(item: HTMLElement): number {
  return Number(/-?[\d.]+/.exec(item.style.transform)?.[0]);
}

/** The cached queries of diff windows: those of the `rows` window from row `offset` when it is given. */
export function diffQueries(client: QueryClient, offset?: number): Query[] {
  return client
    .getQueryCache()
    .getAll()
    .filter((query) => {
      if (query.queryKey[2] !== 'diff') return false;
      if (offset === undefined) return true;
      const window = query.queryKey[4] as { kind?: string; offset?: number } | undefined;
      return window?.kind === 'rows' && window.offset === offset;
    });
}

/** The `rows` windows asked of `spy` since it was set up, by offset. */
export function rowsAsked(spy: { mock: { calls: unknown[][] } }): number[] {
  return spy.mock.calls.flatMap(([, window]) => ((window as DiffWindow).kind === 'rows' ? [(window as { offset: number }).offset] : []));
}

/** How `stubRows` answers. */
export interface StubOptions {
  word?: boolean;
  approximate?: boolean;
  /** Throws for the windows it names, which the page sees as a failed call. */
  fail?: (window: DiffWindow) => boolean;
  /** Holds the answer for a window until the promise it gives settles; `null` answers at once. */
  hold?: (window: DiffWindow) => Promise<void> | null;
}

/** Answers the workspace diff from `rows` as the shell would, window by window. */
export function stubRows(rows: readonly DiffRow[], options: StubOptions = {}) {
  const { versioning } = fake();
  const answer = (window: DiffWindow): Diff => {
    if (options.fail?.(window) === true) throw new Error('the window could not be read');
    return textDiff(rows, window, { word: options.word, text: { approximate: options.approximate === true } });
  };
  // The fake shell awaits what its model gives, so a held answer can be a promise.
  return vi.spyOn(versioning, 'workspaceDiff').mockImplementation(((_key: string, window: DiffWindow) => {
    const held = options.hold?.(window) ?? null;
    return held === null ? answer(window) : held.then(() => answer(window));
  }) as unknown as typeof versioning.workspaceDiff);
}

/** A workspace text item that `stubRows` answers for. */
export function stubbedItem(path = `${PHY}/Stubbed.md`) {
  const target = item(REVIEW);
  if (target.kind !== 'workspace') throw new Error('not a workspace row');
  return { kind: 'workspace', item: { ...target.item, key: 'item:stubbed', path, class: path.endsWith('.docx') ? 'word' : 'text' } } as const;
}

