// The workspace (docs/specs/ipc-m2.md §6, §7, §8.1, §12.4) for the Changes view, its rail badge
// and History's first-commit block: the summary, the items and metadata changes as paged lists, a
// selection's summary, the commit and the first commit, AI messages, and the newest commits.
//
// Freshness (`events.ts`, `touch.ts`): the summary and the lists wait for WorkspaceChanged, which
// follows the CatalogChanged of the same change and also reports hashing, readiness and HEAD;
// CatalogChanged touches no part, not even after a rebuild. Two parts are keyed by what they were
// read along instead, so a change makes a new key rather than refetching the old one: a
// selection's summary by the workspace's fingerprint and catalog revision (an old fingerprint
// would only answer `WorkspaceChanged`; the revision brings renamed courses), and the newest
// commits ("Not synced") by HEAD, which a commit, a first commit, a reword and an uncommit move.
// LibraryStateChanged drops every part with the library's other queries: keys, fingerprints and
// commit ids belong to the library that was open (§14).
//
// Stale keys (§5.1): the UI keeps the keys of the items it left out (or, after "leave all out",
// those it included). When such an item goes, the workspace's fingerprint changes, and under the
// new one the shell answers `InvalidArgument` for its key. A selection's summary, a commit and an
// AI message then find the keys that name nothing by bisection (each half of the keys asked alone
// with `summarize_selection`, about 2·k·log₂ n calls for k stale keys of n) and are sent again
// without them; the summary reports them, so the view drops them too.
import { CancelledError, keepPreviousData, type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import {
  type CommitChanges,
  type CommitInfo,
  type CommitMessage,
  type HistoryItem,
  ipc,
  LIMITS,
  type MetadataChange,
  type Page,
  type Selection,
  type SelectionSummary,
  type WorkspaceItem,
  type WorkspaceSummary,
} from '../ipc';
import { wellFormedPrefix } from '../lib/text';
import { PAGE_GC_TIME } from './client';
import { IpcFailure, type IpcResult, unwrap } from './errors';
import { refresh } from './events';
import { keys, libraryQuery, readKey } from './keys';
import { useCommandMutation } from './mutations';
import { type PagedListOptions, type RowId, type RowRange, usePagedRows, useSettled } from './paged';
import { useLibraryId } from './session';

/** What each part of the workspace asks, besides its name: the rest of its key (`keys.workspace`). */
const SUMMARY = { part: 'summary' } as const;
const ITEMS = { part: 'items' } as const;
const METADATA = { part: 'metadata' } as const;

interface SummarizeQuery {
  part: 'summarize';
  selection: Selection;
  fingerprint: string;
  revision: number;
}

interface NotSyncedQuery {
  part: 'notSynced';
  head: string | null;
}

/** Workspace items and metadata changes: by `key`, which names the change while it exists. */
const byKey: RowId<{ key: string }> = (row) => row.key;

/** The commits "Not synced" lists (§8.1, decision 1: every commit is unsynced in M2). */
export const NOT_SYNCED_SHOWN = 3;

// ---- the summary and the lists

/**
 * The workspace's summary (§6.1): the history's state, HEAD, the fingerprint to send back with a
 * selection, and the totals (the badge and the header count `items + metadata`).
 */
export function useWorkspace() {
  return useQuery(
    libraryQuery(
      useLibraryId(),
      (libraryId) => keys.workspace(libraryId, SUMMARY),
      () => unwrap(ipc.getWorkspace()),
    ),
  );
}

/** The workspace's items in path order, a page at a time (§6.2), keyed by `key`. */
export function useWorkspaceItems(range: RowRange | null, options?: PagedListOptions) {
  return usePagedRows<WorkspaceItem>(
    (libraryId) => keys.workspace(libraryId, ITEMS),
    (page) => ipc.listWorkspaceItems({ page }),
    range,
    byKey,
    options,
  );
}

/** The tag and settings changes no item carries (§6.3), a page at a time, keyed by `key`. */
export function useMetadataChanges(range: RowRange | null, options?: PagedListOptions) {
  return usePagedRows<MetadataChange>(
    (libraryId) => keys.workspace(libraryId, METADATA),
    (page) => ipc.listMetadataChanges({ page }),
    range,
    byKey,
    options,
  );
}

/**
 * Whether a page read with a list's `loadPage` failed because WorkspaceChanged dropped it: the
 * refresh cancels the pages being read and removes those no list shows, as their rows may move.
 */
export function isDroppedRead(error: unknown): boolean {
  return error instanceof CancelledError;
}

/**
 * The workspace's summary as the shell has it now, past the cache: an action that read pages one
 * after another compares it with the one it began under, since a page can answer before the
 * WorkspaceChanged of a change it already shows. Rejects with an `IpcFailure`.
 */
export function readWorkspaceNow(): Promise<WorkspaceSummary> {
  return unwrap(ipc.getWorkspace());
}

// ---- selections and stale keys

/** A selection's summary, and the keys of it that name no item any more. */
export interface PrunedSelection {
  /** The summary of `selection`. */
  summary: SelectionSummary;
  /** The selection without its stale keys: the one asked for when none was stale. */
  selection: Selection;
  /** Keys that name no item under the fingerprint: left out of the summary; drop them. */
  stale: string[];
  /**
   * The workspace's fingerprint it was read under: the summary still on screen while a newer one
   * is asked for (`useSelectionSummary`) belongs to an older one.
   */
  fingerprint: string;
}

function without(selection: Selection, stale: readonly string[]): Selection {
  if (stale.length === 0) return selection;
  const gone = new Set(stale);
  return { kind: selection.kind, keys: selection.keys.filter((key) => !gone.has(key)) };
}

/** Whether the shell knows every key of `keys` under `fingerprint`; any other failure rejects. */
async function knowsAll(kind: Selection['kind'], keys: string[], fingerprint: string): Promise<boolean> {
  try {
    await unwrap(ipc.summarizeSelection({ selection: { kind, keys }, fingerprint }));
    return true;
  } catch (failure) {
    if (failure instanceof IpcFailure && failure.error.code === 'InvalidArgument') return false;
    throw failure;
  }
}

/** The keys of `keys`, a set the shell refused, that name no item: each half asked alone. */
async function staleOf(kind: Selection['kind'], keys: string[], fingerprint: string): Promise<string[]> {
  if (keys.length <= 1) return keys;
  const middle = Math.ceil(keys.length / 2);
  const halves = await Promise.all(
    [keys.slice(0, middle), keys.slice(middle)].map(async (half) =>
      (await knowsAll(kind, half, fingerprint)) ? [] : staleOf(kind, half, fingerprint),
    ),
  );
  return halves.flat();
}

/**
 * Sends a command that takes `selection` (§5.1). When the shell refuses a key under a current
 * fingerprint (`InvalidArgument`), the keys that name no item are left out and it is sent once
 * more; when none of them is stale, the refusal stands (a limit, or another field).
 */
async function sendKnown<T>(
  selection: Selection,
  fingerprint: string,
  send: (selection: Selection) => Promise<IpcResult<T>>,
): Promise<{ data: T; selection: Selection; stale: string[] }> {
  try {
    return { data: await unwrap(send(selection)), selection, stale: [] };
  } catch (failure) {
    if (!(failure instanceof IpcFailure) || failure.error.code !== 'InvalidArgument') throw failure;
    // The refusal may be another field's: the keys are asked alone first.
    const { kind, keys: sent } = selection;
    const stale = (await knowsAll(kind, sent, fingerprint)) ? [] : await staleOf(kind, sent, fingerprint);
    if (stale.length === 0) throw failure;
    const kept = without(selection, stale);
    return { data: await unwrap(send(kept)), selection: kept, stale };
  }
}

/**
 * Summarizes `selection` under `fingerprint` (§6.4), leaving out the keys that name no item any
 * more. Rejects with an `IpcFailure`: `WorkspaceChanged` when the fingerprint is not current.
 */
export async function pruneStaleKeys(selection: Selection, fingerprint: string): Promise<PrunedSelection> {
  const sent = await sendKnown(selection, fingerprint, (asked) =>
    ipc.summarizeSelection({ selection: asked, fingerprint }),
  );
  return { summary: sent.data, selection: sent.selection, stale: sent.stale, fingerprint };
}

/** Distinct objects told apart without reading them: a selection holds up to `LIMITS.batch` keys. */
const identities = new WeakMap<object, number>();
let lastIdentity = 0;

function identityOf(value: object): number {
  let identity = identities.get(value);
  if (identity === undefined) {
    lastIdentity += 1;
    identity = lastIdentity;
    identities.set(value, identity);
  }
  return identity;
}

/** The key of a summary that asks for nothing. */
const NO_SUMMARY: SummarizeQuery = { part: 'summarize', selection: { kind: 'only', keys: [] }, fingerprint: '', revision: 0 };

/**
 * A selection's summary (§6.4) for the commit button, the template and grouped mode, with the keys
 * that turned out stale (`PrunedSelection`), read under `workspace`'s fingerprint. Asked again
 * when the selection or the workspace changes, at most once every `RANGE_SETTLE_MS`, with the
 * last answer kept on screen meanwhile (`isPlaceholderData`). A `WorkspaceChanged` error means a
 * newer summary is on its way: keep showing the last answer.
 *
 * Pass a selection that keeps its identity while it is unchanged: it is told apart by identity,
 * not read. `null`, or no workspace yet, asks for nothing.
 */
export function useSelectionSummary(
  selection: Selection | null,
  workspace: Pick<WorkspaceSummary, 'fingerprint' | 'revision'> | undefined,
) {
  const libraryId = useLibraryId();
  const asked: SummarizeQuery | null =
    selection === null || workspace === undefined
      ? null
      : { part: 'summarize', selection, fingerprint: workspace.fingerprint, revision: workspace.revision };
  const settled = useSettled(
    asked,
    asked === null ? '' : `${String(identityOf(asked.selection))} ${asked.fingerprint} ${String(asked.revision)}`,
  );
  const query = settled ?? NO_SUMMARY;
  return useQuery({
    ...libraryQuery(
      settled === null ? null : libraryId,
      (library) => keys.workspace(library, query),
      () => pruneStaleKeys(query.selection, query.fingerprint),
    ),
    // A summary per selection and workspace: those nobody shows go, like a list's pages.
    gcTime: PAGE_GC_TIME,
    placeholderData: keepPreviousData,
  });
}

/**
 * The summary of a selection now, for a commit or a template the person asked for: the one
 * `useSelectionSummary` has cached for this selection and workspace, else asked at once (no
 * pause). Rejects like `pruneStaleKeys`.
 */
export function useSummarizeNow() {
  const client = useQueryClient();
  const libraryId = useLibraryId();
  return useCallback(
    (selection: Selection, workspace: Pick<WorkspaceSummary, 'fingerprint' | 'revision'>): Promise<PrunedSelection> => {
      if (libraryId === null) return pruneStaleKeys(selection, workspace.fingerprint);
      const { fingerprint, revision } = workspace;
      const query: SummarizeQuery = { part: 'summarize', selection, fingerprint, revision };
      return client.query({
        queryKey: keys.workspace(libraryId, query),
        queryFn: () => pruneStaleKeys(selection, fingerprint),
        gcTime: PAGE_GC_TIME,
      });
    },
    [client, libraryId],
  );
}

// ---- commits

/** Asks the workspace's summary and lists again: a command found them out of date. */
function refreshWorkspace(client: QueryClient, libraryId: string | null): void {
  if (libraryId === null) return;
  refresh(client, libraryId, (query) => {
    const read = readKey(query.queryKey);
    return read.kind === 'workspace' && (read.part === 'summary' || read.part === 'items' || read.part === 'metadata');
  });
}

/**
 * Commits a selection (§7.1) and resolves to the commit job's id; its progress and result arrive
 * as JobChanged. Stale keys are left out first (`sendKnown`). Rejects with an `IpcFailure`
 * (`WorkspaceChanged`, `NothingToCommit`, a message code, `HistoryBusy`, …); the job itself may
 * still fail or be cancelled. `WorkspaceChanged` asks the summary and the lists again, whether or
 * not the event that says so has arrived.
 */
export function useCommit() {
  const client = useQueryClient();
  const libraryId = useLibraryId();
  return useMutation({
    mutationFn: async (request: CommitChanges) =>
      (
        await sendKnown(request.selection, request.fingerprint, (selection) =>
          ipc.commit({ ...request, selection }),
        )
      ).data,
    onError: (failure) => {
      if (failure instanceof IpcFailure && failure.error.code === 'WorkspaceChanged') refreshWorkspace(client, libraryId);
    },
  });
}

/**
 * Starts the history (§7.1, versioning §7.7) with `summary`, "Start history" from the caller's
 * strings, and resolves to the `firstCommit` job's id. The shell queues it until the first scan
 * and hashing finish; `HistoryExists` once it has started, so a second call is safe.
 */
export function useStartHistory() {
  return useCommandMutation((summary: string) => ipc.startHistory({ summary }));
}

// ---- AI messages (§12.4)

/** What an AI message is written from. */
export interface CommitMessageRequest {
  /** From `newRequestId()`: Stop sends it to `cancelAiRequest`. */
  requestId: string;
  selection: Selection;
  fingerprint: string;
  /** What the user typed in the description; only its first `LIMITS.descriptionChars` are sent. */
  description: string;
}

/** An id for an AI request the UI may stop (§4: letters, digits and `-`). */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Asks the AI service for a commit message for a selection. Resolves to the message, valid as it
 * is (§7.2), or `null` when the request was stopped (`cancelAiRequest`, or a newer request).
 * Plain call, not a mutation: what the user typed stays out of the mutation cache. Rejects with
 * an `IpcFailure`: `AiNotConfigured`, an AI failure code, `WorkspaceChanged`, `NothingToCommit`, ….
 */
export async function generateCommitMessage(request: CommitMessageRequest): Promise<CommitMessage | null> {
  const description = wellFormedPrefix(request.description, LIMITS.descriptionChars);
  const sent = await sendKnown(request.selection, request.fingerprint, (selection) =>
    ipc.generateCommitMessage({ requestId: request.requestId, selection, fingerprint: request.fingerprint, description }),
  );
  return sent.data;
}

/**
 * Stops the AI request `requestId`, which then resolves to `null`. One that already ended changes
 * nothing: Stop and an answer can cross (§12.4).
 */
export async function cancelAiRequest(requestId: string): Promise<void> {
  await unwrap(ipc.cancelAiRequest({ requestId }));
}

// ---- the newest commits

/** "Not synced" (§8.1): the newest commits and how many there are. */
export interface NotSynced {
  /** The newest `NOT_SYNCED_SHOWN` commits, newest first. */
  commits: CommitInfo[];
  /** Every commit: none is synced in M2. */
  total: number;
}

function notSyncedOf(page: Page<HistoryItem>): NotSynced {
  return { commits: page.items.flatMap((item) => (item.kind === 'commit' ? [item.commit] : [])), total: page.total };
}

/**
 * The newest commits for "Not synced" (§8.1), read along `head` (`WorkspaceSummary.head`): a new
 * HEAD is a new key, and nothing else changes them in M2. While a new HEAD's commits load, the
 * last HEAD's stay (of the same library only), so the card does not empty for a moment after each
 * commit. `undefined` (the summary has not arrived) asks for nothing.
 */
export function useNotSynced(head: string | null | undefined) {
  const libraryId = useLibraryId();
  const query: NotSyncedQuery = { part: 'notSynced', head: head ?? null };
  return useQuery({
    ...libraryQuery(
      head === undefined ? null : libraryId,
      (library) => keys.workspace(library, query),
      () => unwrap(ipc.listHistory({ page: { offset: 0, limit: NOT_SYNCED_SHOWN }, types: ['commit'] })),
    ),
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === libraryId ? previous : undefined),
    select: notSyncedOf,
  });
}
