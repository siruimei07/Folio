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
    case 'jobs':
    case 'problems':
      // JobChanged and ProblemsChanged keep these current (§5.6).
      return false;
    case 'unknown':
      return true;
  }
}

/**
 * Whether an event touches a query. `complete: false` touches everything (the event lists only
 * part of what changed, or the catalog was rebuilt).
 */
export function isTouched(query: LibraryQuery, event: CatalogChanged): boolean {
  if (!event.complete) return true;
  if (event.tags && query.kind === 'tags') return true;
  if (event.groups && (query.kind === 'semesters' || query.kind === 'courses')) return true;
  return event.entries.some((change) => touches(query, change));
}
