// The Changes view store (docs/specs/ui-architecture.md §6.1): which changes the next commit
// includes, the selected row (the focus: selection follows it, workspace-history handoff §3.6),
// the anchor of a Shift range of check boxes, the list's scroll offset, whether the diff covers
// the list in a narrow window (§2.2), and the commit box (§4): its text, what it runs and the
// notes it shows. Server data stays in the query cache. Another library starts afresh: keys,
// jobs and messages belong to the library that was open.
import { create } from 'zustand';

import { followReferences } from '../data/references';
import type { IpcError, Selection, WorkspaceItem } from '../ipc';
import {
  fitsSelection,
  INCLUDE_ALL,
  includeAll,
  type Inclusion,
  leaveAllOut,
  noteBlocked,
  selectionOf,
  withItems,
  withoutKeys,
} from './inclusion';

/** A row of the list: its key (`rowKeyOf`), and its index for when the key cannot be found. */
export interface RowRef {
  key: string;
  index: number;
}

/** The commit box's text (§4.1), kept while another view shows. */
export interface Draft {
  summary: string;
  description: string;
}

/**
 * What the commit box runs (§4.2, §4.4). Each step of a run is its own object, and an answer acts
 * only while the step it belongs to is still the current one: one that arrives after its run was
 * stopped or replaced, or after another library opened, is dropped. The steps of one run share
 * its `id`.
 */
export type CommitRun =
  | { kind: 'idle' }
  /** Generate: the AI service writes the fields (§4.2); Stop and Esc cancel `requestId`. */
  | { kind: 'generating'; id: number; requestId: string }
  /**
   * A commit with both fields empty waits for the AI's message (§4.2, decision 37); "Use template"
   * cancels `requestId` and sets `template`, and the commit goes on with the template.
   */
  | { kind: 'waiting'; id: number; requestId: string; template: boolean }
  /**
   * The commit was sent; `job` once the shell answered with the commit job's id. `fallback`: the
   * AI failed, so it commits the template, and says so when it is done (§4.3).
   */
  | { kind: 'committing'; id: number; job: string | null; fallback: CommitFallback | null }
  /**
   * The commit `head` is done and the fields are clear; the commit button waits for the workspace
   * after it, so it never offers the committed changes again.
   */
  | { kind: 'settling'; id: number; head: string };

/** A commit with empty fields that used the template because the AI failed with `code` (§4.3). */
export interface CommitFallback {
  code: IpcError['code'];
  summary: string;
}

/** Why the last commit failed (§4.5): the danger note above the fields, until the next commit. */
export interface CommitFailure {
  error: IpcError;
  /** The library path of the file it failed on, for "Midterm review.md kept changing…". */
  file: string | null;
}

/**
 * What the AI did to the fields (§4.2, §4.3): it wrote them ("Written by DeepSeek…", until the
 * person edits a field), or Generate failed (the warning note, until the next Generate or fill).
 */
export type AiNote = { kind: 'written' } | { kind: 'failed'; error: IpcError };

const EMPTY_DRAFT: Draft = { summary: '', description: '' };
const IDLE: CommitRun = { kind: 'idle' };

interface ChangesViewState {
  inclusion: Inclusion;
  /** `inclusion` as the shell takes it: a new object only when the inclusion changes. */
  selection: Selection;
  /** The selected row, which holds the focus; `null`: the first row. */
  focus: RowRef | null;
  /** Where a Shift+click range of check boxes starts: the last box changed. */
  anchor: RowRef | null;
  /** The list's scroll offset, kept while another view shows. */
  offset: number;
  /** Narrow window: the selected change's diff covers the list, until Back. */
  diffOpen: boolean;
  draft: Draft;
  /**
   * The text a fill (the AI's message, the template) replaced: Ctrl+Z puts it back while the fields
   * are unedited.
   */
  undo: Draft | null;
  run: CommitRun;
  failure: CommitFailure | null;
  aiNote: AiNote | null;
}

const INITIAL: ChangesViewState = {
  inclusion: INCLUDE_ALL,
  selection: selectionOf(INCLUDE_ALL),
  focus: null,
  anchor: null,
  offset: 0,
  diffOpen: false,
  draft: EMPTY_DRAFT,
  undo: null,
  run: IDLE,
  failure: null,
  aiNote: null,
};

export const useChangesView = create<ChangesViewState>()(() => INITIAL);

/** Back to every change included and nothing selected: another library, or a test. */
export function resetChangesView(): void {
  useChangesView.setState(INITIAL);
}

/** Applies `change` to the inclusion; the selection follows only when it changed. */
function updateInclusion(change: (inclusion: Inclusion) => Inclusion): void {
  useChangesView.setState((state) => {
    const inclusion = change(state.inclusion);
    return inclusion === state.inclusion ? {} : { inclusion, selection: selectionOf(inclusion) };
  });
}

/**
 * Includes or leaves out `items` (Space, a check box, a Shift range, a course header); `anchor`
 * starts the next range. Says whether it could: not when the selection would then name more keys
 * than the shell takes (`fitsSelection`), and then nothing changes.
 */
export function setIncluded(items: readonly WorkspaceItem[], included: boolean, anchor: RowRef | null): boolean {
  const before = useChangesView.getState().inclusion;
  const next = withItems(before, items, included);
  if (!fitsSelection(next, before)) return false;
  if (next !== before) useChangesView.setState({ inclusion: next, selection: selectionOf(next) });
  if (anchor !== null) useChangesView.setState({ anchor });
  return true;
}

/**
 * Select-all and Ctrl+A: every includable change (`true`), or none but the required ones.
 * `includable` says which keys the list now shows ready (`includeAll`).
 */
export function setAllIncluded(included: boolean, includable: (key: string) => boolean): void {
  updateInclusion((inclusion) => (included ? includeAll(inclusion, includable) : leaveAllOut(inclusion)));
}

/** The list showed `items`: the blocked ones among them stay off once they can be committed. */
export function noteShown(items: Iterable<WorkspaceItem>): void {
  updateInclusion((inclusion) => noteBlocked(inclusion, items));
}

/** Drops keys that name no item any more (a selection summary found them). */
export function dropStaleKeys(stale: readonly string[]): void {
  if (stale.length > 0) updateInclusion((inclusion) => withoutKeys(inclusion, stale));
}

export function setFocus(focus: RowRef): void {
  const current = useChangesView.getState().focus;
  if (current?.key !== focus.key || current.index !== focus.index) useChangesView.setState({ focus });
}

export function setOffset(offset: number): void {
  useChangesView.setState({ offset });
}

/** Narrow window: the diff covers the list (`true`), or the list shows again. */
export function setDiffOpen(diffOpen: boolean): void {
  useChangesView.setState({ diffOpen });
}

/** The AI's note once the text is no longer the AI's alone: "Written by…" goes, a failure stays. */
function unwritten(note: AiNote | null): AiNote | null {
  return note?.kind === 'written' ? null : note;
}

/**
 * The person typed in a field: what a fill replaced cannot come back by Ctrl+Z any more, and the
 * text is no longer the AI's alone.
 */
export function editDraft(change: Partial<Draft>): void {
  useChangesView.setState((state) => ({ draft: { ...state.draft, ...change }, undo: null, aiNote: unwritten(state.aiNote) }));
}

/**
 * Writes `draft` into the fields (the AI's message, the template), with `note` ("Written by…")
 * in place of the AI's last note; Ctrl+Z puts the text before it back.
 */
export function fillDraft(draft: Draft, note: AiNote | null = null): void {
  useChangesView.setState((state) => ({ draft, undo: state.draft, aiNote: note }));
}

/** Ctrl+Z after a fill: the text before it, once. Says whether there was one. */
export function undoFill(): boolean {
  const { undo, aiNote } = useChangesView.getState();
  if (undo === null) return false;
  useChangesView.setState({ draft: undo, undo: null, aiNote: unwritten(aiNote) });
  return true;
}

let lastRunId = 0;

/** The id of a new run. */
export function newRunId(): number {
  lastRunId += 1;
  return lastRunId;
}

/**
 * Starts `run`, which replaces the one before. A commit takes the notes away; Generate takes away
 * only the AI's, and the commit's failure stays until the next commit.
 */
export function startRun(run: CommitRun): void {
  useChangesView.setState(run.kind === 'generating' ? { run, aiNote: null } : { run, failure: null, aiNote: null });
}

/** Whether `run` is still the step the commit box runs: not stopped, replaced or reset. */
export function isCurrentRun(run: CommitRun): boolean {
  return useChangesView.getState().run === run;
}

/** Moves `from` on to its next step `to`; says whether `from` was still the current step. */
export function advanceRun(from: CommitRun, to: CommitRun): boolean {
  if (!isCurrentRun(from)) return false;
  useChangesView.setState({ run: to });
  return true;
}

/** `run` ended: back to idle, with the failure note, if any. */
export function endRun(run: CommitRun, failure: CommitFailure | null = null): void {
  if (isCurrentRun(run)) useChangesView.setState({ run: IDLE, failure });
}

/** Generate's `run` ended without a message: stopped, or failed with `note`. */
export function endGenerating(run: CommitRun, note: AiNote | null = null): void {
  if (isCurrentRun(run)) useChangesView.setState({ run: IDLE, aiNote: note });
}

/** `run` made the commit `head`: the fields clear (§4.4) while the workspace catches up. */
export function commitDone(run: CommitRun & { kind: 'committing' }, head: string): void {
  if (!isCurrentRun(run)) return;
  useChangesView.setState({
    run: { kind: 'settling', id: run.id, head },
    failure: null,
    aiNote: null,
    draft: EMPTY_DRAFT,
    undo: null,
  });
}

followReferences((update) => {
  if (update.kind === 'reset') resetChangesView();
});
