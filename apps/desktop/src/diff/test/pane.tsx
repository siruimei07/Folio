// The diff pane on the fake shell, for the pane's tests: render it for a row the test picks from
// the fake once it is installed, find workspace items, tag and settings changes and commit rows by
// path, and read what the pane shows.
import { act, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, onTestFinished, vi } from 'vitest';

import { Announcer } from '../../app/announcer';
import type { ChangeRow, CommitInfo, Diff, MetadataChange } from '../../ipc';
import { formatDateTime } from '../../lib/format';
import { NOW } from '../../test/data';
import { fakeShell } from '../../test/files';
import { renderApp } from '../../test/render';
import type { Size } from '../../test/virtual';
import { DiffPane } from '../DiffPane';
import type { DiffPaneProps, DiffTarget } from '../types';

export const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
export const LINEAR = 'Fall 2026/线性代数';
export const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
export const ECO = 'Fall 2026/ECO101 微观经济学';
export const PHY = 'Winter 2026/PHY131 Introduction to Physics I';
export const REVIEW = `${MAT}/Exams/Midterm/Midterm review.md`;
/** The first page of a fake shell's list. */
export const PAGE = { offset: 0, limit: 500 };

export interface ShowOptions {
  scenario?: 'small' | 'diffs';
  fail?: { command: 'get_workspace_diff' | 'get_version_diff'; code: 'InUse' | 'Internal' }[];
  latencyMs?: number;
  props?: Partial<DiffPaneProps>;
  /** What the pane sits in: a host's text field beside it, an `<Activity>` around it. */
  wrap?: (pane: ReactElement) => ReactElement;
  /** Every element's `offsetWidth` and `offsetHeight` (800 × 600 by default): the pane's width. */
  layout?: Size;
}

/** The fake shell the test's `renderApp` installed. */
export const fake = fakeShell;

/** Renders the pane for a target the test picks from the fake shell once it is installed. */
export function showDiff(
  pick: () => DiffTarget,
  { scenario = 'small', fail, latencyMs, props = {}, wrap = (pane) => pane, layout }: ShowOptions = {},
) {
  const app = renderApp(<div />, { now: NOW, scenario, fail, latencyMs, layout });
  const target = pick();
  const open = vi.fn();
  const render = (next: DiffTarget, more: Partial<DiffPaneProps> = props, around = wrap) => {
    app.rerender(
      <>
        {around(<DiffPane target={next} actions={{ open }} {...more} />)}
        <Announcer />
      </>,
    );
  };
  render(target);
  const pane = screen.getByRole('group');
  return { ...app, target, open, pane, render };
}

/** The workspace item at `path`. */
export function item(path: string): DiffTarget {
  const found = fake().versioning.itemPage(PAGE).items.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`no workspace item at ${path}`);
  return { kind: 'workspace', item: found };
}

/** The workspace's tag or settings change of a kind. */
export function metadata(kind: MetadataChange['subject']['kind']): DiffTarget {
  const found = fake().versioning.metadataPage(PAGE).items.find((change) => change.subject.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} change in the workspace`);
  return { kind: 'workspaceMetadata', change: found };
}

/** The newest commit with a change at `path`, and that change. */
export function commitRow(path: string): { commit: CommitInfo; row: ChangeRow } {
  const { versioning } = fake();
  for (const entry of versioning.historyPage(PAGE, ['commit']).items) {
    if (entry.kind !== 'commit') continue;
    const row = versioning.changesPage(entry.commit.id, PAGE).items.find((candidate) => candidate.path === path);
    if (row !== undefined) return { commit: entry.commit, row };
  }
  throw new Error(`no commit changes ${path}`);
}

/** The newest commit's row for `path`. */
export function version(path: string): DiffTarget {
  const { commit, row } = commitRow(path);
  return { kind: 'version', commit, row };
}

export function when(ms: string): string {
  return formatDateTime(Number(ms), 'en');
}

export function strip(pane: HTMLElement): HTMLElement {
  const found = pane.querySelector<HTMLElement>('.diff-strip');
  if (found === null) throw new Error('no strip');
  return found;
}

/** The strip's "Change 2 of 5"; `''` without it. */
export function position(pane: HTMLElement): string {
  return pane.querySelector('.diff-strip__position')?.textContent ?? '';
}

/** The event banners' sentences; their icons are hidden from screen readers. */
export function notes(pane: HTMLElement): string[] {
  return within(pane)
    .queryAllByRole('note')
    .map((note) => {
      expect(note.querySelector('.diff-note__icon')).toHaveAttribute('aria-hidden', 'true');
      return note.querySelector('.diff-note__text')?.textContent ?? '';
    });
}

/** What the polite live region says now. */
export function announced(): string {
  return document.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent ?? '';
}

/** Lets timers, frames and answers run for `ms`. */
export async function wait(ms: number) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** The calls of `command` a spy on the fake shell's `invoke` has seen. */
export function calls(invoke: { mock: { calls: unknown[][] } }, command: string): number {
  return invoke.mock.calls.filter(([name]) => name === command).length;
}

/** What the polite live region says from now on, one entry per announcement, the same words too. */
export function recordAnnouncements(): string[] {
  const region = document.querySelector('[aria-live="polite"][aria-atomic="true"]');
  if (region === null) throw new Error('no live region');
  const said: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) said.push(node.textContent ?? '');
  });
  observer.observe(region, { childList: true });
  onTestFinished(() => {
    observer.disconnect();
  });
  return said;
}

/** Stubs the next answers of the workspace or version diff. */
export function stubDiff(shell: { versioning: object }, source: 'workspace' | 'version', diff: Diff) {
  const method = source === 'workspace' ? 'workspaceDiff' : 'versionDiff';
  return vi.spyOn(shell.versioning as Record<typeof method, () => Diff>, method).mockReturnValue(diff);
}
