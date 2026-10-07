// Changes view tests against the fake shell: the view with the toasts and the live regions, App
// settings as a dialog it can open, its stores reset, and the small workspace at a fixed time
// (twelve items, then four tag and settings changes).
import { screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';

import { Announcer, clearAnnouncements } from '../../app/announcer';
import { type DialogKind, HostedDialogs, HostedViews, type ViewId } from '../../app/navigation';
import { ToastRegion } from '../../app/ToastRegion';
import { useToasts } from '../../app/toasts';
import type { CommitChanges, Selection } from '../../ipc';
import { NOW } from '../../test/data';
import { politeText, renderApp, type RenderAppOptions } from '../../test/render';
import { ChangesView } from '../ChangesView';
import { useChangesPreferences } from '../preferences';
import { resetChangesView } from '../state';

export const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
export const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
export const ECO = 'Fall 2026/ECO101 微观经济学';

/** The template message of the small workspace with every includable change in it. */
export const TEMPLATE =
  'CSC148: add 3 files, update 1 file, update course settings; ECO101 微观经济学: update 1 file; MAT232: update 1 file, move 1 file, delete 1 file, tag 2 files; and 3 more';

/** A job for `shell.startJob` that keeps running until the test ends: a scan or a rebuild. */
export function longJob(kind: 'scan' | 'rebuild') {
  return {
    cancellable: true,
    total: 1_000_000,
    step: 1,
    finish: () => (kind === 'scan' ? { kind, changes: 0, problems: 0 } : { kind, entries: 0 }) as never,
  };
}

/** The dialogs the view may open: App settings, from "AI settings…". */
const HOSTED = new Set<DialogKind>(['appSettings']);
/** With History on the rail: its Edit message dialog too. */
const HOSTED_WITH_HISTORY = new Set<DialogKind>(['appSettings', 'editMessage']);
const NO_VIEWS = new Set<ViewId>();
const HISTORY_VIEW = new Set<ViewId>(['history']);

export interface RenderChangesOptions extends RenderAppOptions {
  /**
   * History on the rail with its Edit message dialog, as the app hosts them: "View history of this
   * file", "N more in History" and the commits' Edit message show.
   */
  withHistory?: boolean;
}

export function renderChanges({ withHistory = false, ...options }: RenderChangesOptions = {}) {
  resetChangesView();
  useChangesPreferences.setState({ layout: 'flat' });
  useToasts.setState({ toasts: [] });
  // The live regions keep their last words from test to test.
  clearAnnouncements();
  return renderApp(
    <HostedDialogs value={withHistory ? HOSTED_WITH_HISTORY : HOSTED}>
      <HostedViews value={withHistory ? HISTORY_VIEW : NO_VIEWS}>
        <ChangesView />
        <ToastRegion />
        <Announcer />
      </HostedViews>
    </HostedDialogs>,
    { now: NOW, ...options },
  );
}

/** The commit box (wide) or bar (narrow). */
export function commitBox(): HTMLElement {
  return screen.getByRole('region', { name: 'Commit' });
}

/** The commit button, whatever it says. */
export function commitButton(): HTMLElement {
  return within(commitBox()).getByRole('button', { name: /^(Commit|Nothing|Committing|Writing)/ });
}

export function summaryField(): HTMLElement {
  return within(commitBox()).getByRole('textbox', { name: 'Summary' });
}

export function descriptionField(): HTMLElement {
  return within(commitBox()).getByRole('textbox', { name: 'Description' });
}

/** A window `width` px wide: below 1,000 the view lays out narrow (`useChangesNarrow`). */
export function resizeTo(width: number): void {
  window.innerWidth = width;
  window.dispatchEvent(new Event('resize'));
}

export { politeText };
export { settle } from '../../test/render';

/**
 * How long a wait for what a job or a first render brings may take: the commit job runs in timed
 * steps, each with a render, and the first grouped header waits for the list and the selection's
 * summary, so under a loaded test run (other suites beside it, CI) either can pass `waitFor`'s
 * second.
 */
export const JOB_WAIT = { timeout: 5000 };

/** A test with such waits: three of them, and as long again for the rest (vitest's 5 s is not). */
export const JOB_TEST = { timeout: 4 * JOB_WAIT.timeout };

/** Waits until the polite region says a commit is done ("Committed 14 changes: …"). */
export async function committed(said: string | RegExp): Promise<void> {
  await waitFor(() => {
    if (typeof said === 'string') expect(politeText()).toBe(said);
    else expect(politeText()).toMatch(said);
  }, JOB_WAIT);
}

/** The danger note of a failed commit (§4.5), once the commit job or the shell has said why. */
export function findCommitNote(): Promise<HTMLElement> {
  return within(commitBox()).findByRole('alert', {}, JOB_WAIT);
}

type FakeShell = ReturnType<typeof renderApp>['shell'];

/**
 * Holds the fake shell's answers to the requests `holds` picks (by command and request) until
 * `release()`: a page or a summary that comes late. Returns the spy on `invoke`, which records every
 * command; a test that spied on it already gets the same spy.
 */
export function holdRequests(shell: FakeShell, holds: (command: string, request: unknown) => boolean) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = (Object.getPrototypeOf(shell) as FakeShell).invoke.bind(shell);
  const invoke = vi.spyOn(shell, 'invoke').mockImplementation(async (command, payload) => {
    if (holds(command, (payload as { request?: unknown } | undefined)?.request)) await held;
    return answer(command, payload);
  });
  return { invoke, release };
}

/** The offset of the page of changed items `request` asks for; `null` for another command. */
export function itemPageOffset(command: string, request: unknown): number | null {
  if (command !== 'list_workspace_items') return null;
  return (request as { page?: { offset: number } } | undefined)?.page?.offset ?? 0;
}

/** The requests `commit` was sent, oldest first. */
export function commitRequests(invoke: Invoke): CommitChanges[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'commit')
    .map(([, payload]) => (payload as { request: CommitChanges }).request);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The changes list box. */
export function changesList(): HTMLElement {
  return screen.getByRole('listbox', { name: 'Changes' });
}

/** The row whose accessible name starts with `path` (as the row shows it, course code first). */
export function getRow(path: string): HTMLElement {
  return within(changesList()).getByRole('option', { name: new RegExp(`^${escape(path)}`) });
}

export async function findRow(path: string): Promise<HTMLElement> {
  const list = await screen.findByRole('listbox', { name: 'Changes' });
  return within(list).findByRole('option', { name: new RegExp(`^${escape(path)}`) });
}

export function queryRow(path: string): HTMLElement | null {
  return within(changesList()).queryByRole('option', { name: new RegExp(`^${escape(path)}`) });
}

/** "Include all changes" in the header. */
export function includeAll(): HTMLElement {
  return screen.getByRole('checkbox', { name: 'Include all changes' });
}

/** The check box drawn in a row. */
export function boxOf(row: HTMLElement): HTMLElement {
  const box = row.querySelector<HTMLElement>('.checkbox');
  if (box === null) throw new Error(`no check box in ${row.getAttribute('aria-label') ?? ''}`);
  return box;
}

/** `vi.spyOn(shell, 'invoke')`: the commands and payloads the fake shell was sent. */
interface Invoke {
  mock: { calls: readonly (readonly unknown[])[] };
}

/** How often the fake shell was asked `command`. */
export function callsOf(invoke: Invoke, command: string): number {
  return invoke.mock.calls.filter(([name]) => name === command).length;
}

/** The paths of the entries `command` (`open_entry`, `reveal_entry`) was sent, oldest first. */
export function entryPaths(invoke: Invoke, command: string): string[] {
  return invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, payload]) => (payload as { request: { entry: { path: string } } }).request.entry.path);
}

/** The items of the menu open last: each label with its note or shortcut. */
export function menuItems(): (string | null)[] {
  const menu = screen.getAllByRole('menu').at(-1);
  if (menu === undefined) throw new Error('no menu is open');
  return [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent);
}

/** The selections `summarize_selection` was asked about, oldest first. */
export function summarized(invoke: Invoke): Selection[] {
  return invoke.mock.calls
    .filter(([command]) => command === 'summarize_selection')
    .map(([, payload]) => (payload as { request: { selection: Selection } }).request.selection);
}

export { smallWorkspace } from '../../test/fixtures';
