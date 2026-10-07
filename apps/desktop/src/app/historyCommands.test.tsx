// Which commands a commit takes and why not (ipc-m2 §8.1; handoff workspace-history §5, §7.3, B3),
// and how the shared buttons and menu items show them: a prune commit takes neither, a synced one
// (M3) neither, the first and every commit but the newest no Undo commit, and a read-only or
// damaged history keeps them listed, disabled with the reason.
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { Menu } from '../components/Menu/Menu';
import type { CommitInfo, HistoryState } from '../ipc';
import { CommitActionButtons, CommitMenuItems } from './CommitActions';
import { hidesButton, rewordRefusal, uncommitRefusal } from './historyCommands';
import { HostedDialogs } from './navigation';

function commitOf(fields: Partial<CommitInfo> = {}): CommitInfo {
  return {
    id: `b3:${'1'.repeat(64)}`,
    parent: `b3:${'2'.repeat(64)}`,
    kind: 'commit',
    first: false,
    head: false,
    synced: false,
    timeMs: '1760000000000',
    effectiveMs: '1760000000000',
    summary: 'MAT232: add lecture 6 slides',
    body: null,
    device: { id: 'device', name: 'G16' },
    files: 3,
    folders: 0,
    metadata: 0,
    pruned: 0,
    ...fields,
  };
}

const HEAD = commitOf({ head: true });
const FIRST = commitOf({ first: true, parent: null, summary: 'Start history' });
const PRUNE = commitOf({ kind: 'prune', summary: null, pruned: 12, files: 0 });
const IMPORT = commitOf({ kind: 'import', head: true });
const SYNCED = commitOf({ synced: true, head: true });

describe('the rules', () => {
  it.each([
    ['the newest commit', HEAD, 'ready', null, null],
    ['an older commit', commitOf(), 'ready', null, 'notHead'],
    ['the first commit', FIRST, 'ready', null, 'first'],
    ['the newest import', IMPORT, 'ready', null, null],
    ['a prune commit', PRUNE, 'ready', 'prune', 'prune'],
    ['a synced commit (M3)', SYNCED, 'ready', 'synced', 'synced'],
    ['the newest commit of a read-only history', HEAD, 'readOnly', 'readOnly', 'readOnly'],
    ['an older commit of a damaged history', commitOf(), 'damaged', 'damaged', 'notHead'],
  ] as const)('%s', (_name, commit, state, reword, uncommit) => {
    expect(rewordRefusal(commit, state as HistoryState)).toBe(reword);
    expect(uncommitRefusal(commit, state as HistoryState)).toBe(uncommit);
  });

  it("hides a button for the commit's own refusal, and keeps it for the history's", () => {
    expect(hidesButton(null)).toBe(false);
    expect(hidesButton('notHead')).toBe(true);
    expect(hidesButton('prune')).toBe(true);
    expect(hidesButton('readOnly')).toBe(false);
    expect(hidesButton('damaged')).toBe(false);
  });
});

function Hosted({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <HostedDialogs value={new Set(['editMessage'] as const)}>{children}</HostedDialogs>
    </QueryClientProvider>
  );
}

function menuOf(commit: CommitInfo, state: HistoryState = 'ready'): string[] {
  render(
    <Menu aria-label="Actions">
      <CommitMenuItems commit={commit} historyState={state} />
    </Menu>,
    { wrapper: Hosted },
  );
  return within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
}

describe('the buttons and menu items', () => {
  it('says why a prune commit takes neither, and shows it no buttons (B3)', () => {
    expect(menuOf(PRUNE)).toEqual(['Edit messageNo message', "Undo commitCan't be undone", 'Copy commit ID']);
    const { container } = render(<CommitActionButtons commit={PRUNE} historyState="ready" />, { wrapper: Hosted });
    expect(container).toBeEmptyDOMElement();
  });

  it('says a synced commit keeps its message (M3)', () => {
    expect(menuOf(SYNCED)).toEqual(['Edit messageSynced', 'Undo commitSynced', 'Copy commit ID']);
  });

  it('keeps both buttons of the newest commit, disabled, while the history is damaged', () => {
    render(<CommitActionButtons commit={HEAD} historyState="damaged" />, { wrapper: Hosted });
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Edit message', 'Undo commit']);
    for (const button of buttons) expect(button).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows only Edit message on an older commit', () => {
    render(<CommitActionButtons commit={commitOf()} historyState="ready" />, { wrapper: Hosted });
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Edit message']);
  });
});
