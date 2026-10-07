// Which cached queries a CatalogChanged event touches (docs/specs/ui-architecture.md §5.4). The
// event lists up to 200 changes; a touched query is refetched while something shows it, and
// removed otherwise. Pure functions, so every event kind has a unit test (touch.test.ts).
import type { CatalogChanged, EntryChange, EntryRef } from '../ipc';
import { isBelow, isInside, parentOf } from '../lib/paths';
import type { CountRequest, LibraryQuery } from './keys';

/**
 * Whether a reference in a key no longer names the entry where the key says: the entry moved or
 * went away, or a folder above it did. Its query would answer `NotFound`; the reference
 * followers (`references.ts`) give the holder the new path.
 */
function isStale(ref: EntryRef | null, change: EntryChange): boolean {
  if (ref === null) return false;
  switch (change.kind) {
    case 'moved':
      return ref.id === change.entry.id
        ? ref.path !== change.entry.path
        : isBelow(ref.path, change.from);
    case 'removed':
      return ref.id === change.entry.id || isBelow(ref.path, change.entry.path);
    default:
      return false;
  }
}

/** Whether a list over `scope` (`null`: everything) can hold what `change` changed. */
function touchesScope(scope: EntryRef | null, change: EntryChange): boolean {
  const path = change.entry.path;
  const folder = scope?.path ?? null;
  return (
    isStale(scope, change) ||
    isInside(path, folder) ||
    (change.kind === 'moved' && isInside(change.from, folder)) ||
    // A folder's tags reach every file below it, so lists inside that folder change too.
    (change.kind === 'tagged' && folder !== null && isInside(folder, path))
  );
}

/** Whether the children of `folder` (`null`: the root, `''` to `parentOf`) can have changed. */
function touchesFolder(folder: EntryRef | null, change: EntryChange): boolean {
  const path = folder?.path ?? '';
  return (
    isStale(folder, change) ||
    parentOf(change.entry.path) === path ||
    (change.kind === 'moved' && parentOf(change.from) === path) ||
    // Rows carry `folderTags`, which a tagged folder changes for everything below it.
    (change.kind === 'tagged' && folder !== null && isInside(path, change.entry.path))
  );
}

function touchesCount(request: CountRequest, change: EntryChange): boolean {
  switch (request.of) {
    case 'children':
      return touchesFolder(request.folder, change);
    case 'files':
      return touchesScope(request.scope, change);
    case 'problems':
      // ProblemsChanged carries the new total (§5.6).
      return false;
  }
}

/** Whether one change touches a query. */
export function touches(query: LibraryQuery, change: EntryChange): boolean {
  switch (query.kind) {
    case 'workspace':
      // It waits for the WorkspaceChanged that follows (ipc-m2 §14, `events.ts`), which also
      // brings what the catalog does not hold: hashing, readiness and HEAD.
      return false;
    case 'children':
      return touchesFolder(query.folder, change);
    case 'files':
    case 'search':
      return touchesScope(query.scope, change);
    case 'count':
      return touchesCount(query.request, change);
    case 'entry':
      return (
        isStale(query.entry, change) ||
        query.entry.id === change.entry.id ||
        (change.kind === 'tagged' && isBelow(query.entry.path, change.entry.path))
      );
    case 'semesters':
    case 'courses':
      // Course file counts follow files coming, going and moving.
      return change.kind === 'added' || change.kind === 'removed' || change.kind === 'moved';
    case 'tags':
      // Tag usage counts follow assignments.
      return change.kind === 'tagged';
    case 'resolve':
      // A note names paths anywhere in the library, matched without case: any change may answer
      // one of them, or change the row it answers with.
      return true;
    case 'importCheck':
      // Name clashes are with the names the target folder holds; tags and content do not count.
      return change.kind !== 'tagged' && change.kind !== 'modified' && touchesScope(query.target, change);
    case 'jobs':
    case 'problems':
      // JobChanged and ProblemsChanged keep these current (§5.6).
      return false;
    case 'ignoreRules':
      // Entries never change the rules; IgnoreRulesChanged keeps them current (ipc-m1 §22.2).
      return false;
    case 'diff':
      // A workspace diff waits for the WorkspaceChanged that follows (ipc-m2 §14, `events.ts`);
      // a commit's diff does not change while its id names it.
      return false;
    case 'located':
      // Any change can move or remove the file a version belongs to, or put one at its last
      // committed path, which pairs with it (versioning §6.1).
      return true;
    case 'history':
    case 'commitChanges':
    case 'commitMetadata':
    case 'firstCommit':
    case 'versionChange':
      // Entries change no commit; HistoryChanged keeps these current (`isHistoryQuery`).
      return false;
    case 'fileHistory':
      // An entry's history starts at the row its file pairs with, and a version's ends at the file
      // it belongs to now, which any change can move, remove or replace (as for `located`); both
      // mark the version with the file's content ("Current version", ipc-m2 §8.3). Tags are none
      // of these.
      return (
        change.kind !== 'tagged' &&
        (query.file.kind === 'version' ||
          isStale(query.file.entry, change) ||
          query.file.entry.id === change.entry.id)
      );
    case 'restorePlan':
      // Where the version goes, and whether the file there goes to the Recycle Bin first, follow
      // the files (ipc-m2 §10); tags change neither.
      return change.kind !== 'tagged';
    case 'unknown':
      return true;
  }
}

/**
 * Whether HistoryChanged refreshes a query (ipc-m2 §14): every query of the history. A commit,
 * an uncommit or a restore adds an entry, a reword gives commits new ids, and a prune commit (M3)
 * thins out versions of older commits, whose rows say so.
 */
export function isHistoryQuery(query: LibraryQuery): boolean {
  switch (query.kind) {
    case 'history':
    case 'commitChanges':
    case 'commitMetadata':
    case 'fileHistory':
    case 'firstCommit':
    case 'restorePlan':
    case 'versionChange':
      return true;
    default:
      return false;
  }
}

/**
 * Whether WorkspaceChanged refreshes a query of the history: those that compare versions with the
 * files on the disk, whose hashes arrive with it after CatalogChanged ("Current version", and
 * whether a restore recycles uncommitted changes first).
 */
export function comparesWithFiles(query: LibraryQuery): boolean {
  return query.kind === 'fileHistory' || query.kind === 'restorePlan';
}

/** The reference a query's key holds, if any. */
function keyRef(query: LibraryQuery): EntryRef | null {
  switch (query.kind) {
    case 'children':
      return query.folder;
    case 'files':
    case 'search':
      return query.scope;
    case 'count':
      return query.request.of === 'children'
        ? query.request.folder
        : query.request.of === 'files'
          ? query.request.scope
          : null;
    case 'entry':
      return query.entry;
    case 'resolve':
      return query.base;
    case 'importCheck':
      return query.target;
    case 'fileHistory':
      return query.file.kind === 'entry' ? query.file.entry : null;
    default:
      return null;
  }
}

/**
 * Whether a query shows `entry`, for which the shell answered `NotFound`: what its removal would
 * touch, except queries keyed by it or by something below it. Those would only answer `NotFound`
 * until the event's reference followers give their holders the new path.
 */
export function touchesGone(query: LibraryQuery, entry: EntryRef): boolean {
  const change: EntryChange = { kind: 'removed', entry };
  return !isStale(keyRef(query), change) && touches(query, change);
}

/**
 * Whether an event touches a query. `complete: false` touches everything but diffs and the
 * workspace (the event lists only part of what changed, or the catalog was rebuilt).
 */
export function isTouched(query: LibraryQuery, event: CatalogChanged): boolean {
  // Not even after a rebuild: WorkspaceChanged follows that too, and HistoryChanged keeps the
  // timeline, commit rows and the first commit current (only file histories and restore plans
  // compare versions with the files).
  if (query.kind === 'diff' || query.kind === 'workspace' || (isHistoryQuery(query) && !comparesWithFiles(query))) return false;
  if (!event.complete) return true;
  // Search ranks by tag names too (library core §5.2), so a renamed tag changes its results.
  if (event.tags && (query.kind === 'tags' || query.kind === 'search')) return true;
  if (event.groups && (query.kind === 'semesters' || query.kind === 'courses')) return true;
  return event.entries.some((change) => touches(query, change));
}
