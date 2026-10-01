// Tags (docs/specs/ipc-m1.md §8): definitions in the user's order with their usage counts, and
// assignments to entries. CatalogChanged refreshes the list when it reports `tags` (names,
// colours, order) or `tagged` entries (usage).
import { useQuery } from '@tanstack/react-query';

import {
  type CreateTag,
  type DeleteTag,
  ipc,
  type ReorderTags,
  type SetEntryTags,
  type UpdateTag,
} from '../ipc';
import { unwrap } from './errors';
import { keys, libraryQuery } from './keys';
import { useBatchMutation, useCommandMutation } from './mutations';
import { useLibraryId } from './session';

/** Every tag, in the user's order. */
export function useTags() {
  return useQuery(libraryQuery(useLibraryId(), keys.tags, () => unwrap(ipc.listTags())));
}

/** A new tag, last in the order; resolves to it. */
export function useCreateTag() {
  return useCommandMutation((request: CreateTag) => ipc.createTag(request));
}

/** Renames or recolours a tag. */
export function useUpdateTag() {
  return useCommandMutation((request: UpdateTag) => ipc.updateTag(request), { tags: true });
}

/** The new order of every tag, each exactly once. */
export function useReorderTags() {
  return useCommandMutation((request: ReorderTags) => ipc.reorderTags(request));
}

/** Deletes a tag and every assignment of it; resolves to how many assignments went. */
export function useDeleteTag() {
  return useCommandMutation((request: DeleteTag) => ipc.deleteTag(request), { tags: true });
}

/**
 * Adds and removes tags on entries. Resolves with every entry that failed: `NotFound`,
 * `InvalidArgument` for a semester or course folder, `ReadOnly`, file-system errors. A tag an
 * entry only gets from a folder above it is the folder's, and removing it there changes nothing.
 */
export function useSetEntryTags() {
  return useBatchMutation((request: SetEntryTags) => ipc.setEntryTags(request));
}
