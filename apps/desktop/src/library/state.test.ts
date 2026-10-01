// The Library view store follows the catalog (UI architecture §5.5): what it holds moves with
// renames and moves, and goes when its entry goes.
import { afterEach, describe, expect, it } from 'vitest';

import { followChanges, type MenuRequest, resetLibraryView, useLibraryView } from './state';

const NOTES = { id: '5', path: 'Fall/MAT/notes.md', kind: 'file' as const, tags: ['notes'], folderTags: [] };
const PS = { id: '6', path: 'Fall/MAT/ps1.pdf', kind: 'file' as const, tags: [], folderTags: [] };

function openMenuOn(...targets: MenuRequest['targets']) {
  useLibraryView.setState({ menu: { anchor: { x: 0, y: 0 }, region: 'panel', targets, keyboard: false } });
}

describe('an open menu', () => {
  afterEach(() => {
    resetLibraryView();
  });

  it('acts on where its targets are now, keeping what they are', () => {
    openMenuOn(NOTES, PS);
    followChanges([{ kind: 'moved', entry: { id: '5', path: 'Fall/MAT/week 1.md' }, from: NOTES.path }]);
    expect(useLibraryView.getState().menu?.targets).toEqual([{ ...NOTES, path: 'Fall/MAT/week 1.md' }, PS]);
  });

  it('drops a target that is gone, and closes once all are', () => {
    openMenuOn(NOTES, PS);
    followChanges([{ kind: 'removed', entry: { id: '5', path: NOTES.path } }]);
    expect(useLibraryView.getState().menu?.targets).toEqual([PS]);
    followChanges([{ kind: 'removed', entry: { id: '6', path: PS.path } }]);
    expect(useLibraryView.getState().menu).toBeNull();
  });

  it('stays the same request when nothing it names changed', () => {
    openMenuOn(NOTES);
    const before = useLibraryView.getState().menu;
    followChanges([{ kind: 'modified', entry: { id: '9', path: 'Fall/CSC/hw1.py' } }]);
    expect(useLibraryView.getState().menu).toBe(before);
  });
});
