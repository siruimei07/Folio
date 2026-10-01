// References the UI holds (docs/specs/ui-architecture.md §5.5): selections, the previewed entry,
// expanded folders and the reveal target. The stores that hold them subscribe here and follow the
// catalog; the data layer publishes every CatalogChanged and library change to them.
//
//   const stop = followReferences((update) => {
//     if (update.kind === 'changes') previewed = followRef(previewed, update.changes);
//     …
//   });
import { type EntryChange, type EntryRef, ipc } from '../ipc';
import { isBelow, isInside, movePath } from '../lib/paths';

export type ReferenceUpdate =
  /** Entries moved or went away: apply `followRef` / `followPath`. */
  | { kind: 'changes'; changes: readonly EntryChange[] }
  /** Changes too many to list, or a rebuilt catalog with new ids: `recheck` what you hold. */
  | { kind: 'rebuilt' }
  /** Another library, or the library closed: drop every reference. */
  | { kind: 'reset' };

type Follower = (update: ReferenceUpdate) => void;

const followers = new Set<Follower>();

/** Calls `follower` with every update until the returned function runs. */
export function followReferences(follower: Follower): () => void {
  followers.add(follower);
  return () => {
    followers.delete(follower);
  };
}

/** Hands an update to every follower. One follower's bug does not keep the update from others. */
export function publishReferences(update: ReferenceUpdate): void {
  for (const follower of [...followers]) {
    try {
      follower(update);
    } catch (error) {
      // To the window's error handlers, as an uncaught error would go.
      reportError(error);
    }
  }
}

/**
 * The reference after `changes`: the same object when nothing moved it, a new one when it or a
 * folder above it moved, and `null` once it or a folder above it went away.
 */
export function followRef(ref: EntryRef, changes: readonly EntryChange[]): EntryRef | null {
  let current = ref;
  for (const change of changes) {
    if (change.kind === 'moved') {
      const path =
        current.id === change.entry.id
          ? change.entry.path
          : isBelow(current.path, change.from)
            ? movePath(current.path, change.from, change.entry.path)
            : current.path;
      if (path !== current.path) current = { id: current.id, path };
    } else if (change.kind === 'removed') {
      if (current.id === change.entry.id || isBelow(current.path, change.entry.path)) return null;
    }
  }
  return current;
}

/**
 * A path held by path, such as an expanded folder, after `changes`: its new path, or `null` once
 * the entry there or a folder above it went away.
 */
export function followPath(path: string, changes: readonly EntryChange[]): string | null {
  let current = path;
  for (const change of changes) {
    if (change.kind === 'moved') {
      if (isInside(current, change.from)) current = movePath(current, change.from, change.entry.path);
    } else if (change.kind === 'removed') {
      if (isInside(current, change.entry.path)) return null;
    }
  }
  return current;
}

/** Concurrent `get_entry` calls while rechecking. */
const RECHECK_BATCH = 64;

/**
 * After a `rebuilt` update: the references that still name an entry, at the path the catalog now
 * has. Those that answer `NotFound` are dropped (a rebuilt catalog numbers its entries anew, so
 * that is most of them); any other failure keeps the reference, since it says nothing about it.
 */
export async function recheck(refs: readonly EntryRef[]): Promise<EntryRef[]> {
  const kept: EntryRef[] = [];
  for (let start = 0; start < refs.length; start += RECHECK_BATCH) {
    const batch = refs.slice(start, start + RECHECK_BATCH);
    const results = await Promise.all(batch.map((entry) => ipc.getEntry({ entry })));
    batch.forEach((entry, index) => {
      const result = results[index];
      if (result?.status === 'ok') kept.push({ id: result.data.id, path: result.data.path });
      else if (result?.error.code !== 'NotFound') kept.push(entry);
    });
  }
  return kept;
}
