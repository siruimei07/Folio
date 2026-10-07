// The restore store (handoff workspace-history §7.2, §14): which entry is the new restore, and how
// long it stays highlighted, on fake timers. The highlight lasts FRESH_COMMIT_MS whatever the motion
// setting: reduced motion only makes the fade and rise instant (duration tokens), never this.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryItem, RestoreEntry } from '../../ipc';
import { FRESH_COMMIT_MS } from '../../lib/timing';
import {
  askRestore,
  closeRestore,
  dropFresh,
  freshEntryKey,
  resetRestore,
  restoreKeys,
  seeFresh,
  settleFresh,
  startFresh,
  useRestore,
} from './state';

const VERSION = { commit: 'b3:aa', path: 'Fall 2026/MAT232/week 2 notes.md' };

function restoreItem(id: string, version = VERSION): HistoryItem {
  const entry: RestoreEntry = {
    id,
    timeMs: '0',
    effectiveMs: '0',
    commit: version.commit,
    path: version.path,
    versionMs: '0',
    target: version.path,
    recycled: false,
  };
  return { kind: 'restore', ...entry };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRestore();
});

afterEach(() => {
  resetRestore();
  vi.useRealTimers();
});

describe('the new restore entry', () => {
  it('is the first restore of the version that was not listed before', () => {
    const old = restoreItem('old');
    const other = restoreItem('other', { commit: 'b3:bb', path: VERSION.path });
    startFresh(VERSION, restoreKeys([old]));
    const fresh = useRestore.getState().fresh;
    expect(freshEntryKey([old], fresh)).toBeNull();
    expect(freshEntryKey([other, old], fresh)).toBeNull();
    expect(freshEntryKey([restoreItem('new'), other, old], fresh)).toBe('restore new');
  });

  it('stays highlighted for FRESH_COMMIT_MS from when a timeline lists it', () => {
    startFresh(VERSION, new Set());
    vi.advanceTimersByTime(5000);
    expect(useRestore.getState().fresh).not.toBeNull();
    seeFresh('restore new');
    expect(useRestore.getState().fresh?.key).toBe('restore new');
    // Listed again (a refresh): the same highlight, its time not started again.
    vi.advanceTimersByTime(FRESH_COMMIT_MS - 1);
    seeFresh('restore new');
    expect(freshEntryKey([], useRestore.getState().fresh)).toBe('restore new');
    vi.advanceTimersByTime(1);
    expect(useRestore.getState().fresh).toBeNull();
  });

  it('is not waited for past FRESH_COMMIT_MS after the restore when no timeline lists it', () => {
    startFresh(VERSION, new Set());
    settleFresh();
    vi.advanceTimersByTime(FRESH_COMMIT_MS - 1);
    expect(useRestore.getState().fresh).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useRestore.getState().fresh).toBeNull();
  });

  it('keeps its highlight when the restore settles after the timeline listed it', () => {
    startFresh(VERSION, new Set());
    seeFresh('restore new');
    vi.advanceTimersByTime(1000);
    settleFresh();
    vi.advanceTimersByTime(FRESH_COMMIT_MS - 1000 - 1);
    expect(useRestore.getState().fresh?.key).toBe('restore new');
    vi.advanceTimersByTime(1);
    expect(useRestore.getState().fresh).toBeNull();
  });

  it('is dropped when the restore failed, and a timer of an earlier one clears nothing later', () => {
    startFresh(VERSION, new Set());
    seeFresh('restore first');
    dropFresh();
    expect(useRestore.getState().fresh).toBeNull();
    startFresh(VERSION, new Set());
    vi.advanceTimersByTime(FRESH_COMMIT_MS * 2);
    expect(useRestore.getState().fresh).not.toBeNull();
  });
});

describe('the confirmation asked for', () => {
  it('closes only the one asked for, and a new one starts afresh', () => {
    const refocus = vi.fn();
    askRestore({ version: VERSION, versionMs: 0, refocus });
    const first = useRestore.getState().asked;
    if (first === null) throw new Error('asked');
    askRestore({ version: VERSION, versionMs: 0, refocus });
    const second = useRestore.getState().asked;
    expect(second?.serial).not.toBe(first.serial);
    closeRestore(first.serial);
    expect(useRestore.getState().asked?.open).toBe(true);
    if (second === null) throw new Error('asked');
    closeRestore(second.serial);
    expect(useRestore.getState().asked).toMatchObject({ serial: second.serial, open: false });
  });
});
