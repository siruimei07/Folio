// Tags against the fake shell (ipc-m1 §8): the list with usage counts, the definition mutations,
// assignments as a batch that keeps every failed item, and the CatalogChanged that follows.
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ipc } from '../ipc';
import { IMPORTANT, TO_REVIEW } from '../ipc/mock/fixtures/build';
import { BY_NAME, FIRST_ROWS, NOW, smallRef } from '../test/data';
import { renderAppHook } from '../test/render';
import { useChildren } from './entries';
import { unwrap } from './errors';
import { useSearch } from './search';
import {
  useCreateTag,
  useDeleteTag,
  useReorderTags,
  useSetEntryTags,
  useTags,
  useUpdateTag,
} from './tags';

const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';

describe('the tag list', () => {
  it('lists every tag in the user’s order, with how many entries carry it themselves', async () => {
    const { result } = renderAppHook(() => useTags().data, { now: NOW });
    await waitFor(() => {
      expect(result.current?.map((tag) => tag.id)).toEqual([
        'notes',
        'slides',
        'homework',
        'exam',
        'reference',
        IMPORTANT.id,
        TO_REVIEW.id,
      ]);
    });
    expect(result.current?.find((tag) => tag.id === TO_REVIEW.id)).toEqual({ ...TO_REVIEW, usage: 2 });
  });
});

describe('tag definitions', () => {
  it('creates a tag last, renames it, reorders the tags and deletes it', async () => {
    const { result } = renderAppHook(
      () => ({
        tags: useTags().data,
        create: useCreateTag(),
        update: useUpdateTag(),
        reorder: useReorderTags(),
        remove: useDeleteTag(),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.tags).toHaveLength(7);
    });

    const lab = await result.current.create.mutateAsync({ name: ' Lab ', color: 'teal' });
    expect(lab).toMatchObject({ name: 'Lab', color: 'teal', usage: 0 });
    await waitFor(() => {
      expect(result.current.tags?.at(-1)).toEqual(lab);
    });

    await result.current.update.mutateAsync({ id: lab.id, name: 'Labs', color: 'green' });
    await waitFor(() => {
      expect(result.current.tags?.at(-1)).toMatchObject({ name: 'Labs', color: 'green' });
    });

    const order = (result.current.tags ?? []).map((tag) => tag.id).reverse();
    await result.current.reorder.mutateAsync({ tags: order });
    await waitFor(() => {
      expect(result.current.tags?.map((tag) => tag.id)).toEqual(order);
    });

    await expect(result.current.remove.mutateAsync({ id: lab.id })).resolves.toEqual({ assignments: 0 });
    await waitFor(() => {
      expect(result.current.tags).toHaveLength(7);
    });
  });

  it('deletes a tag with its assignments: rows and usage counts follow', async () => {
    const { result } = renderAppHook(
      () => ({ rows: useChildren(smallRef(`${CSC}/a1/starter`), BY_NAME, FIRST_ROWS), remove: useDeleteTag() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.rows.rowAt(1)?.tags).toEqual([TO_REVIEW.id]);
    });

    await expect(result.current.remove.mutateAsync({ id: TO_REVIEW.id })).resolves.toEqual({
      assignments: 2,
    });

    await waitFor(() => {
      expect(result.current.rows.rowAt(1)?.tags).toEqual([]);
    });
  });

  it('a renamed tag refreshes searches, which match tag names', async () => {
    const { result } = renderAppHook(
      () => ({ search: useSearch('revisit', null), update: useUpdateTag() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.search.status).toBe('success');
    });
    expect(result.current.search.hits).toEqual([]);

    await result.current.update.mutateAsync({ id: TO_REVIEW.id, name: 'Revisit', color: 'amber' });

    await waitFor(() => {
      expect(result.current.search.hits.map((hit) => hit.entry.name).sort()).toEqual([
        'ps2 solutions.md',
        'tree.py',
      ]);
    });
  });

  it('keeps errors typed, and refreshes the list when a tag it names is gone', async () => {
    const { result, shell } = renderAppHook(
      () => ({ tags: useTags().data, create: useCreateTag(), remove: useDeleteTag() }),
      { now: NOW, eventDelayMs: 60_000 },
    );
    await waitFor(() => {
      expect(result.current.tags).toHaveLength(7);
    });
    await expect(result.current.create.mutateAsync({ name: 'NOTES', color: 'blue' })).rejects.toMatchObject({
      error: { code: 'AlreadyExists' },
    });

    // Deleted elsewhere; its CatalogChanged has not arrived.
    await unwrap(ipc.deleteTag({ id: IMPORTANT.id }));
    const invoke = vi.spyOn(shell, 'invoke');
    await expect(result.current.remove.mutateAsync({ id: IMPORTANT.id })).rejects.toMatchObject({
      error: { code: 'NotFound' },
    });

    await waitFor(() => {
      expect(result.current.tags).toHaveLength(6);
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'list_tags')).toHaveLength(1);
  });
});

describe('set_entry_tags', () => {
  it('adds and removes tags; the rows and usage counts follow', async () => {
    const hw1 = smallRef(`${CSC}/hw1.py`);
    const { result } = renderAppHook(
      () => ({
        rows: useChildren(smallRef(CSC), BY_NAME, FIRST_ROWS),
        tags: useTags().data,
        set: useSetEntryTags(),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.rows.rowAt(2)).toMatchObject({ id: hw1.id, tags: ['homework'] });
    });

    await expect(
      result.current.set.mutateAsync({ entries: [hw1], add: [IMPORTANT.id], remove: ['homework'] }),
    ).resolves.toEqual({ done: 1, failed: [] });

    await waitFor(() => {
      expect(result.current.rows.rowAt(2)?.tags).toEqual([IMPORTANT.id]);
    });
    await waitFor(() => {
      expect(result.current.tags?.find((tag) => tag.id === IMPORTANT.id)?.usage).toBe(4);
    });
  });

  it('resolves with every item that failed, each with its typed error, in order', async () => {
    const stale = smallRef(`${MAT}/week 2 notes.md`);
    const { result, shell } = renderAppHook(
      () => ({ rows: useChildren(smallRef(MAT), BY_NAME, FIRST_ROWS), set: useSetEntryTags() }),
      { now: NOW, eventDelayMs: 60_000 },
    );
    await waitFor(() => {
      expect(result.current.rows.status).toBe('success');
    });
    await unwrap(ipc.renameEntry({ entry: stale, name: 'Week 2 notes.md' }));
    const invoke = vi.spyOn(shell, 'invoke');

    const outcome = await result.current.set.mutateAsync({
      entries: [smallRef(`${MAT}/Lectures`), smallRef(MAT), stale, smallRef(`${MAT}/第3章 偏导数.md`)],
      add: [TO_REVIEW.id],
      remove: [],
    });

    expect(outcome.done).toBe(2);
    expect(outcome.failed).toEqual([
      { entry: smallRef(MAT), error: { code: 'InvalidArgument', detail: expect.any(String) as string } },
      { entry: stale, error: { code: 'NotFound', detail: expect.any(String) as string } },
    ]);
    // The list that showed the stale entry is asked again at once.
    await waitFor(() => {
      expect(invoke.mock.calls.some(([command]) => command === 'list_children')).toBe(true);
    });
  });

  it('fails as a whole for a request the shell refuses: a tag in both lists', async () => {
    const { result } = renderAppHook(() => useSetEntryTags(), { now: NOW });
    await expect(
      result.current.mutateAsync({ entries: [smallRef(`${CSC}/hw1.py`)], add: ['notes'], remove: ['notes'] }),
    ).rejects.toMatchObject({ error: { code: 'InvalidArgument' } });
  });
});
