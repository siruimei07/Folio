// The diff pane against the fake shell (handoff workspace-history §6.1, §6.2, §6.8): the header and
// strip of Changes and History rows, and every state that is not lines, on the `small` and `diffs`
// scenarios, with stubbed answers for what the fake does not produce.
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MenuItem } from '../components/Menu/Menu';
import { FIRST_WINDOW } from '../data/diff';
import { serveFiles } from '../test/files';
import { changeRow, COMMIT_REF, contentDiff, diskSide, metadataChange, textDiff, versionSide, workspaceItem } from './test/diffs';
import { diffQueries } from './test/lines';
import {
  announced,
  calls,
  commitRow,
  CSC,
  ECO,
  fake,
  item,
  LINEAR,
  MAT,
  metadata,
  notes,
  PAGE,
  PHY,
  recordAnnouncements,
  REVIEW,
  showDiff,
  strip,
  stubDiff,
  version,
  wait,
  when,
} from './test/pane';

/** The codes of the errors that the cached windows of diffs have. */
function diffErrors(client: QueryClient): string[] {
  return diffQueries(client).flatMap((query) => (query.state.error === null ? [] : [query.state.error.error.code]));
}

describe('the header and strip', () => {
  it('shows a Changes row: the path, the status and what is compared', async () => {
    const { pane } = showDiff(() => item(REVIEW));
    const heading = within(pane).getByRole('heading', { level: 2 });
    await waitFor(() => {
      expect(heading).toHaveTextContent('MAT232/Exams/Midterm/Midterm review.md');
    });
    expect(heading).toHaveAttribute('title', 'MAT232/Exams/Midterm/Midterm review.md');
    expect(pane).toHaveAccessibleName('MAT232/Exams/Midterm/Midterm review.md');
    expect(within(pane).getByRole('img', { name: 'Modified' })).toBeInTheDocument();
    // What is compared and the counts, before "Change 1 of 3" and its buttons.
    await waitFor(() => {
      expect(strip(pane).querySelector('.diff-strip__text')).toHaveTextContent(
        /^Compared with the last commit \(.+\) · \d+ lines added, \d+ removed$/,
      );
    });
    expect(within(pane).queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('shows a History row: this version, the one it is compared with, the counts', async () => {
    const { pane } = showDiff(() => version(REVIEW));
    const { commit } = commitRow(REVIEW);
    const history = fake().versioning.historyPage(PAGE, ['commit']);
    // The fake names the parent commit as the earlier side's.
    const parent = history.items.find((entry) => entry.kind === 'commit' && entry.commit.id === commit.parent);
    if (parent?.kind !== 'commit') throw new Error('no earlier version');
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent(
        `This version: ${when(commit.timeMs)} · compared with ${when(parent.commit.timeMs)} · `,
      );
    });
    const text = strip(pane).querySelector('.diff-strip__text');
    expect(text).toHaveTextContent(/· \d+ lines? added(, \d+ removed)?$/);
    expect(text).toHaveAttribute('title', text?.textContent);
  });

  it('shows a first version with its line count', async () => {
    const path = `${PHY}/notes/Kinematics.md`;
    const { pane, target } = showDiff(() => version(path));
    if (target.kind !== 'version') throw new Error('not a version');
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent(`First version: ${when(target.commit.timeMs)} · 1 line`);
    });
    expect(within(pane).getByRole('img', { name: 'Added' })).toBeInTheDocument();
  });

  it('offers Back in a narrow window and the host’s More menu', async () => {
    const onBack = vi.fn();
    const { user, pane } = showDiff(() => item(REVIEW), {
      props: {
        back: { label: 'Back to changes', onBack },
        moreItems: (
          <>
            <MenuItem>Show in File Explorer</MenuItem>
            <MenuItem>Copy path</MenuItem>
          </>
        ),
      },
    });
    const back = within(pane).getByRole('button', { name: 'Back to changes' });
    expect(back).toHaveTextContent('Back');
    await user.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.click(within(pane).getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual(['Show in File Explorer', 'Copy path']);
  });

  it('shows the header at once and the skeleton only after 150 ms, aria-busy', async () => {
    const { pane } = showDiff(() => item(REVIEW), { latencyMs: 600 });
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent('Midterm review.md');
    expect(within(pane).queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument();
    expect(pane.querySelector('.diff-strip__skeleton')).toBeNull();
    const skeleton = await within(pane).findByRole('status', { name: 'Loading…' });
    expect(skeleton.querySelectorAll('.diff-skeleton__line')).toHaveLength(14);
    expect(pane.querySelector('.diff-strip__skeleton')).not.toBeNull();
    expect(pane.querySelector('.diff-scroll')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('Compared with the last commit');
    });
  });

  it('starts afresh for another row, but keeps the diff when the same row comes back refreshed', async () => {
    const { pane, render, target } = showDiff(() => item(REVIEW));
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('lines added');
    });
    if (target.kind !== 'workspace') throw new Error('not a workspace row');
    render({ kind: 'workspace', item: { ...target.item, readiness: 'ready' } });
    expect(strip(pane)).toHaveTextContent('lines added');
    render(item(`${MAT}/Old slides L2.pdf`));
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent('Old slides L2.pdf');
    expect(within(pane).getByRole('img', { name: 'Deleted' })).toBeInTheDocument();
  });
});

const IN_USE = { code: 'InUse', detail: 'test' } as const;

describe('failures', () => {
  it('says the diff could not be read, with Try again and Open with default app', async () => {
    const onBack = vi.fn();
    const { pane, shell, open, user, target } = showDiff(() => item(REVIEW), {
      fail: [{ command: 'get_workspace_diff', code: 'InUse' }],
      latencyMs: 30,
      props: { back: { label: 'Back to changes', onBack } },
    });
    expect(await within(pane).findByRole('heading', { name: "Couldn't show what changed" })).toBeInTheDocument();
    expect(pane).toHaveTextContent('Another app is using this file.');
    expect(pane.querySelector('.diff-strip')).toBeNull();
    expect(announced()).toBe("Couldn't show what changed");
    // InUse points at no bug: no details to copy.
    expect(within(pane).queryByRole('button', { name: 'Copy details' })).toBeNull();
    await user.click(within(pane).getByRole('button', { name: 'Open with default app' }));
    expect(open).toHaveBeenCalledWith(target.kind === 'workspace' ? target.item.entry : null);
    shell.setFailure('get_workspace_diff', null);
    // By keyboard: the block goes as the diff is read again, and the focus waits on the heading.
    const retry = within(pane).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('Compared with the last commit');
    });
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('reads the failure once more when Try again fails again', async () => {
    const { pane, shell, user } = showDiff(() => item(REVIEW), {
      fail: [{ command: 'get_workspace_diff', code: 'InUse' }],
      latencyMs: 30,
    });
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    const invoke = vi.spyOn(shell, 'invoke');
    const said = recordAnnouncements();
    act(() => {
      within(pane).getByRole('button', { name: 'Try again' }).focus();
    });
    await user.keyboard('{Enter}');
    // The block goes while the diff is read again, the focus on the heading; it comes back, read once.
    await waitFor(() => {
      expect(within(pane).getByRole('heading', { level: 2 })).toHaveFocus();
    });
    await waitFor(() => {
      expect(said).toEqual(["Couldn't show what changed"]);
    });
    expect(within(pane).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(calls(invoke, 'get_workspace_diff')).toBe(1);
    await wait(100);
    expect(said).toEqual(["Couldn't show what changed"]);
  });

  it('keeps the focus on an unreadable file’s Try again and reads the failure again while it still cannot be read', async () => {
    const path = `${ECO}/Lecture recording week 5.mp4`;
    const { pane, shell, user } = showDiff(() => item(path), { latencyMs: 30 });
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    const invoke = vi.spyOn(shell, 'invoke');
    const said = recordAnnouncements();
    const retry = within(pane).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    // The file is read again and answers the same: nothing on screen changes, so the title is read.
    await waitFor(() => {
      expect(said).toEqual(["Couldn't show what changed"]);
    });
    expect(calls(invoke, 'get_workspace_diff')).toBe(1);
    expect(retry.isConnected).toBe(true);
    expect(retry).toHaveFocus();
  });

  it('reads a retry that fails over an unreadable file in the refresh banner, not in the block under it', async () => {
    const path = `${ECO}/Lecture recording week 5.mp4`;
    const { pane, shell, user } = showDiff(() => item(path), { latencyMs: 30 });
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    const said = recordAnnouncements();
    shell.setFailure('get_workspace_diff', 'HistoryDamaged');
    const retry = within(pane).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    // The read failed: the banner, an alert, says so; the block of the last answer stays quiet.
    const alert = await within(pane).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update what changed.");
    await wait(100);
    expect(said).toEqual([]);
    // It fails again: the banner's title is read again, not the block's.
    expect(retry).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(said).toEqual(["Couldn't update what changed."]);
    });
    await wait(100);
    expect(said).toEqual(["Couldn't update what changed."]);
    // Read now, the file is still in use: the banner goes, and the block's title is read again.
    shell.setFailure('get_workspace_diff', null);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(within(pane).queryByRole('alert')).toBeNull();
    });
    await waitFor(() => {
      expect(said).toEqual(["Couldn't update what changed.", "Couldn't show what changed"]);
    });
  });

  it('does not read an unreadable file’s failure again when the diff shows again after This version', async () => {
    serveFiles(() => 'text');
    const { pane, user } = showDiff(() => {
      stubDiff(fake(), 'workspace', contentDiff({ kind: 'unreadable', error: IN_USE }));
      return item(REVIEW);
    });
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    const said = recordAnnouncements();
    await user.click(within(pane).getByRole('radio', { name: 'This version' }));
    await waitFor(() => {
      expect(within(pane).queryByRole('heading', { name: "Couldn't show what changed" })).toBeNull();
    });
    await user.click(within(pane).getByRole('radio', { name: 'Changes' }));
    expect(await within(pane).findByRole('heading', { name: "Couldn't show what changed" })).toBeVisible();
    await wait(100);
    expect(said).toEqual([]);
  });

  it('shows the lines of an unreadable file that Try again can read now, the focus in them', async () => {
    let unreadable: ReturnType<typeof stubDiff> | null = null;
    const { pane, user } = showDiff(
      () => {
        unreadable = stubDiff(fake(), 'workspace', contentDiff({ kind: 'unreadable', error: IN_USE }));
        return item(REVIEW);
      },
      { latencyMs: 30 },
    );
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    (unreadable as ReturnType<typeof stubDiff> | null)?.mockRestore();
    act(() => {
      within(pane).getByRole('button', { name: 'Try again' }).focus();
    });
    await user.keyboard('{Enter}');
    const region = await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' });
    await waitFor(() => {
      expect(region).toHaveFocus();
    });
  });

  it.each([
    { kind: 'unreadable', content: { kind: 'unreadable', error: IN_USE }, title: "Couldn't show what changed" },
    { kind: 'binary', content: { kind: 'binary' }, title: "This file isn't text" },
    { kind: 'not local', content: { kind: 'notLocal' }, title: 'Not downloaded yet' },
  ] as const)('moves the focus to the heading when a refresh turns the lines it is in into a $kind block', async ({ content, title }) => {
    const onBack = vi.fn();
    const { pane, shell, user } = showDiff(() => item(REVIEW), { props: { back: { label: 'Back to changes', onBack } } });
    const region = await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' });
    act(() => {
      region.focus();
    });
    stubDiff(shell, 'workspace', contentDiff(content));
    act(() => {
      shell.editFile(REVIEW);
    });
    expect(await within(pane).findByRole('heading', { name: title })).toBeInTheDocument();
    expect(region.isConnected).toBe(false);
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveFocus();
    // The pane's keys still reach it.
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('offers Copy details for an error that points at a bug, in the block and in the banner', async () => {
    // user-event's clipboard stands in for the window's.
    const { pane, shell, user } = showDiff(() => item(REVIEW), { fail: [{ command: 'get_workspace_diff', code: 'Internal' }] });
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    await user.click(within(pane).getByRole('button', { name: 'Copy details' }));
    expect(await navigator.clipboard.readText()).toMatch(/^Couldn't show what changed\nInternal: /);

    shell.setFailure('get_workspace_diff', null);
    await user.click(within(pane).getByRole('button', { name: 'Try again' }));
    await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' });
    shell.setFailure('get_workspace_diff', 'Internal');
    act(() => {
      shell.editFile(REVIEW);
    });
    const alert = await within(pane).findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Copy details' }));
    expect(await navigator.clipboard.readText()).toMatch(/^Couldn't update what changed\.\nInternal: /);
  });

  it('opens the file a version belongs to now from History, once it is found', async () => {
    const { pane, open, user } = showDiff(() => version(REVIEW), {
      fail: [{ command: 'get_version_diff', code: 'Internal' }],
      latencyMs: 200,
    });
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    // Not while the file is looked up.
    expect(within(pane).queryByRole('button', { name: 'Open with default app' })).toBeNull();
    const button = await within(pane).findByRole('button', { name: 'Open with default app' });
    await user.click(button);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: REVIEW }));
  });

  it('offers no Open in History once the file was deleted since', async () => {
    const { pane, client } = showDiff(
      () => {
        const target = version(REVIEW);
        fake().deleteFile(REVIEW);
        return target;
      },
      { fail: [{ command: 'get_version_diff', code: 'Internal' }] },
    );
    await within(pane).findByRole('heading', { name: "Couldn't show what changed" });
    // The lookup has answered: no file has the version's path now.
    await waitFor(() => {
      const located = client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey[2] === 'located' && (query.queryKey[3] as { path?: string } | undefined)?.path === REVIEW);
      expect(located?.state).toMatchObject({ status: 'success', data: null });
    });
    expect(within(pane).queryByRole('button', { name: 'Open with default app' })).toBeNull();
    expect(within(pane).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps the last answer without a word when a refresh finds the change gone', async () => {
    const { pane, shell, client } = showDiff(() => item(REVIEW));
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('lines added');
    });
    shell.setFailure('get_workspace_diff', 'NotFound');
    act(() => {
      shell.editFile(REVIEW);
    });
    // The refresh has failed: the change was committed, and the host drops the row.
    await waitFor(() => {
      expect(diffErrors(client)).toEqual(['NotFound']);
    });
    expect(within(pane).queryByText("Couldn't show what changed")).not.toBeInTheDocument();
    expect(within(pane).queryByRole('alert')).toBeNull();
    expect(strip(pane)).toHaveTextContent('lines added');
  });

  it('keeps the last answer under a banner when a refresh fails for another reason, and tries again', async () => {
    const onBack = vi.fn();
    const { pane, shell, user } = showDiff(() => item(REVIEW), { props: { back: { label: 'Back to changes', onBack } } });
    const region = await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' });
    await waitFor(() => {
      expect(region).toHaveTextContent('Check the boundary too.');
    });
    shell.setFailure('get_workspace_diff', 'HistoryDamaged');
    act(() => {
      shell.editFile(REVIEW);
    });
    const alert = await within(pane).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't update what changed. Folio can't read this library's history.");
    expect(within(alert).queryByRole('button', { name: 'Copy details' })).toBeNull();
    // What it showed stays, under the banner.
    expect(alert.compareDocumentPosition(region)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(region).toHaveTextContent('Check the boundary too.');
    expect(strip(pane)).toHaveTextContent('lines added');

    shell.setFailure('get_workspace_diff', null);
    // By keyboard: the banner goes once the diff is read, and the focus waits in the lines.
    const retry = within(alert).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(within(pane).queryByRole('alert')).toBeNull();
    });
    expect(strip(pane)).toHaveTextContent('lines added');
    expect(region).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('keeps the focus on the banner’s Try again and reads its title again when the refresh fails again', async () => {
    const { pane, shell, user } = showDiff(() => item(REVIEW), { latencyMs: 30 });
    const region = await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' });
    await waitFor(() => {
      expect(region).toHaveTextContent('Check the boundary too.');
    });
    shell.setFailure('get_workspace_diff', 'HistoryDamaged');
    act(() => {
      shell.editFile(REVIEW);
    });
    const alert = await within(pane).findByRole('alert');
    const invoke = vi.spyOn(shell, 'invoke');
    const said = recordAnnouncements();
    const retry = within(alert).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(said).toEqual(["Couldn't update what changed."]);
    });
    expect(calls(invoke, 'get_workspace_diff')).toBeGreaterThan(0);
    // The banner stayed as it was, and so did the focus.
    expect(within(pane).getByRole('alert')).toBe(alert);
    expect(retry).toHaveFocus();

    // Put elsewhere by the person (a click on text), the focus stays there through a refresh, which
    // nobody asked for and which is not read.
    act(() => {
      retry.blur();
    });
    const before = calls(invoke, 'get_workspace_diff');
    act(() => {
      shell.editFile(REVIEW);
    });
    await waitFor(() => {
      expect(calls(invoke, 'get_workspace_diff')).toBeGreaterThan(before);
    });
    await wait(100);
    expect(document.activeElement).toBe(document.body);
    expect(said).toEqual(["Couldn't update what changed."]);
  });

  it('shows an unreadable file as a failure with its reason', async () => {
    const { pane, open, user } = showDiff(() => item(`${ECO}/Lecture recording week 5.mp4`));
    expect(await within(pane).findByRole('heading', { name: "Couldn't show what changed" })).toBeInTheDocument();
    expect(pane).toHaveTextContent('Another app is using this file.');
    await user.click(within(pane).getByRole('button', { name: 'Open with default app' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: `${ECO}/Lecture recording week 5.mp4` }));
    expect(within(pane).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('states of a file', () => {
  it('shows a deleted file in the Recycle Bin, without a strip', async () => {
    const { pane } = showDiff(() => item(`${MAT}/Old slides L2.pdf`));
    expect(await within(pane).findByRole('heading', { name: 'Old slides L2.pdf is in the Recycle Bin' })).toBeInTheDocument();
    expect(notes(pane)).toEqual(['Deleted: committing removes it from the library. The file is in the Recycle Bin.']);
    expect(pane).toHaveTextContent('Restore it from the Recycle Bin before you commit if you still need it.');
    expect(pane.querySelector('.diff-strip')).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Open with default app' })).not.toBeInTheDocument();
  });

  it('shows a deleted folder with its file count', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'workspace', contentDiff({ kind: 'folder' }, { before: null, after: null }));
    render({
      kind: 'workspace',
      item: workspaceItem({ key: 'item:exercises', change: 'deleted', kind: 'folder', path: `${LINEAR}/Exercises`, entry: null, class: 'other', before: null, after: null, files: 3 }),
    });
    expect(await within(pane).findByRole('heading', { name: 'Exercises and its 3 files are in the Recycle Bin' })).toBeInTheDocument();
    expect(notes(pane)).toEqual([
      'Deleted: committing removes it from the library. The folder and its 3 files are in the Recycle Bin.',
    ]);
  });

  it('shows a file that is only in the cloud, with Open with default app', async () => {
    const { pane, open, user } = showDiff(() => item('Personal/Photos/IMG_2031.HEIC'));
    expect(await within(pane).findByRole('heading', { name: 'Not downloaded yet' })).toBeInTheDocument();
    await user.click(within(pane).getByRole('button', { name: 'Open with default app' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: 'Personal/Photos/IMG_2031.HEIC' }));
  });

  it('says a text file with binary data is not text', async () => {
    const { pane } = showDiff(() => item(`${CSC}/a1/starter/test_tree.py`), { scenario: 'diffs' });
    expect(await within(pane).findByRole('heading', { name: "This file isn't text" })).toBeInTheDocument();
    expect(pane.querySelector('.state-block')).toHaveAttribute('data-tone', 'info');
    expect(pane.querySelector('.diff-strip')).toBeNull();
  });

  it('shows a change too big to show, without a line count', async () => {
    const { pane } = showDiff(() => item(`${PHY}/Kinematics.md`), { scenario: 'diffs' });
    expect(await within(pane).findByRole('heading', { name: 'This change is too big to show here' })).toBeInTheDocument();
    expect(pane).toHaveTextContent('Open the file in its own app to read it, or look at this version.');
    expect(within(pane).getByRole('button', { name: 'Open with default app' })).toBeInTheDocument();
    expect(strip(pane)).toHaveTextContent(/^Compared with the last commit \(.+\)$/);
  });

  it('shows how many lines a change too big to show changes', async () => {
    const { pane, shell, render, target } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'workspace', contentDiff({ kind: 'tooLarge', lines: 24_382 }));
    if (target.kind !== 'workspace') throw new Error('not a workspace row');
    render({ kind: 'workspace', item: { ...target.item, key: 'item:big' } });
    expect(await within(pane).findByText(/^It changes 24,382 lines\. /)).toBeInTheDocument();
    expect(strip(pane)).toHaveTextContent(/· 24,382 lines changed$/);
  });

  it('says without "this version" when a deleted text file is too big', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'version', contentDiff({ kind: 'tooLarge', lines: 3 }, { after: null }));
    render({ kind: 'version', commit: COMMIT_REF, row: changeRow({ change: 'deleted', after: null }) });
    expect(await within(pane).findByText('It changes 3 lines. Open the file in its own app to read it.')).toBeInTheDocument();
  });

  it('shows a version Folio no longer keeps', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'version', contentDiff({ kind: 'pruned' }, { before: versionSide({ pruned: true }), after: versionSide({ commit: COMMIT_REF.id }) }));
    render({ kind: 'version', commit: COMMIT_REF, row: changeRow({ class: 'word', path: `${LINEAR}/习题 1.docx` }) });
    expect(await within(pane).findByRole('heading', { name: 'Folio no longer keeps this version' })).toBeInTheDocument();
    expect(pane).toHaveTextContent('Old Word versions are thinned out over time.');
  });

  it('shows a text file over the size limit', async () => {
    const { pane } = showDiff(() => item('Personal/Todo.txt'), { scenario: 'diffs' });
    expect(await within(pane).findByRole('heading', { name: 'No preview for files this large' })).toBeInTheDocument();
    expect(notes(pane)).toEqual([
      "Modified: 14.2 MB → 14.6 MB. Text files over 10 MB keep only the latest copy, so there's no older version to compare.",
    ]);
    expect(within(pane).getByRole('button', { name: 'Open with default app' })).toBeInTheDocument();
  });

  it('says only the formatting of a Word file changed', async () => {
    const { pane } = showDiff(() => item(`${LINEAR}/习题/习题 2.docx`), { scenario: 'diffs' });
    expect(await within(pane).findByRole('heading', { name: 'No text changed' })).toBeInTheDocument();
    expect(pane).toHaveTextContent("Folio compares the text of Word files, so changes to formatting, images or comments don't show here.");
    expect(strip(pane)).toHaveTextContent(/· No text changed$/);
  });

  it('says only the line endings changed', async () => {
    const { pane } = showDiff(() => item(`${MAT}/week 2 notes.md`), { scenario: 'diffs' });
    expect(await within(pane).findByRole('heading', { name: 'Only the line endings changed' })).toBeInTheDocument();
    expect(pane).toHaveTextContent('The file now ends its lines with LF instead of CRLF, which some editors do when they save.');
    expect(strip(pane)).toHaveTextContent(/· Only the line endings changed$/);
  });

  it('says when the line endings turn mixed, or stop being mixed', async () => {
    const { pane, shell, render, target } = showDiff(() => item(REVIEW));
    if (target.kind !== 'workspace') throw new Error('not a workspace row');
    const sameText = (before: 'crlf' | 'mixed', after: 'lf' | 'mixed') =>
      textDiff([], FIRST_WINDOW, { text: { added: 0, removed: 0, changes: 0, lineEndings: { before, after } } });
    const stub = stubDiff(shell, 'workspace', sameText('crlf', 'mixed'));
    render({ kind: 'workspace', item: { ...target.item, key: 'item:to-mixed' } });
    expect(
      await within(pane).findByText(
        'The text is the same. The file now mixes line endings instead of using CRLF throughout, which some editors do when they save.',
      ),
    ).toBeInTheDocument();
    stub.mockReturnValue(sameText('mixed', 'lf'));
    render({ kind: 'workspace', item: { ...target.item, key: 'item:from-mixed' } });
    expect(
      await within(pane).findByText(
        'The text is the same. The file now ends every line with LF instead of mixing line endings, which some editors do when they save.',
      ),
    ).toBeInTheDocument();
  });

  it('says only the encoding changed', async () => {
    const { pane } = showDiff(() => item('Winter 2026/中国近代史纲要/课堂笔记.md'), { scenario: 'diffs' });
    expect(await within(pane).findByRole('heading', { name: 'Only the encoding changed' })).toBeInTheDocument();
    expect(pane).toHaveTextContent('The file is now saved as UTF-8 instead of GB18030');
  });

  it('banners an event-only change, a move and a bound part', async () => {
    const { pane, render } = showDiff(() => item(`${ECO}/Supply and demand.png`));
    await waitFor(() => {
      expect(notes(pane)).toEqual([
        "Modified: 180 KB → 402 KB. Folio keeps only the latest copy of images, so there's no older version to compare.",
      ]);
    });
    expect(pane.querySelector('.diff-strip')).toBeNull();
    render(item(`${PHY}/Kinematics.md`));
    await waitFor(() => {
      expect(notes(pane)).toEqual(['Moved from PHY131/notes/.', 'Replaces a file that was deleted.']);
    });
  });

  it('banners a file a version added and Folio keeps only the latest copy of', async () => {
    const { pane } = showDiff(() => version(`${MAT}/Lectures/Lecture 12.pdf`));
    await waitFor(() => {
      expect(notes(pane)).toEqual([
        'This version added the file. Folio keeps only the latest copy of PDFs, so the preview shows the file as it is now.',
      ]);
    });
  });

  it('shows nothing left of an event-only file a version deleted', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'version', contentDiff({ kind: 'notStored' }, { before: versionSide({ stored: false }), after: null }));
    render({ kind: 'version', commit: COMMIT_REF, row: changeRow({ change: 'deleted', class: 'other', path: `${MAT}/slides.pdf`, after: null }) });
    expect(await within(pane).findByRole('heading', { name: 'Nothing to show' })).toBeInTheDocument();
    expect(notes(pane)).toEqual(['This version deleted the file.']);
  });

  it('lists the tags that changed with the content', async () => {
    const { pane, shell, render, target } = showDiff(() => item(REVIEW));
    stubDiff(
      shell,
      'workspace',
      contentDiff(
        { kind: 'notStored' },
        {
          before: versionSide({ stored: false, path: 'a.png' }),
          after: diskSide({ stored: false, path: 'a.png' }),
          tags: { added: [{ id: 'exam', name: 'Exams', color: 'red' }], removed: [], now: [{ id: 'exam', name: 'Exams', color: 'red' }] },
        },
      ),
    );
    if (target.kind !== 'workspace') throw new Error('not a workspace row');
    render({ kind: 'workspace', item: { ...target.item, key: 'item:a', path: `${MAT}/a.png`, class: 'other', tagsChanged: true } });
    expect(await within(pane).findByText('The tags changed too.')).toBeInTheDocument();
    expect(within(pane).getAllByText('Exams')).toHaveLength(2);
  });
});

describe('folders', () => {
  it('shows a moved folder with the files that moved with it', async () => {
    const { pane } = showDiff(() => item(`${LINEAR}/习题`));
    expect(await within(pane).findByRole('heading', { name: '4 files moved with it' })).toBeInTheDocument();
    expect(pane).toHaveTextContent("Their content didn't change, so there's nothing to compare.");
    expect(notes(pane)).toEqual(['Renamed from Exercises.']);
    expect(within(pane).getByRole('img', { name: 'Renamed' })).toBeInTheDocument();
    expect(pane.querySelector('.diff-strip')).toBeNull();
  });

  it('shows an added empty folder', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'workspace', contentDiff({ kind: 'folder' }, { before: null, after: null }));
    render({
      kind: 'workspace',
      item: workspaceItem({ key: 'item:new', change: 'added', kind: 'folder', path: `${MAT}/Drafts`, class: 'other', before: null, after: null }),
    });
    expect(await within(pane).findByRole('heading', { name: 'Empty folder' })).toBeInTheDocument();
    expect(notes(pane)).toEqual(['Added an empty folder.']);
  });

  it('shows a moved folder with no files in it as empty', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'workspace', contentDiff({ kind: 'folder' }, { before: null, after: null }));
    render({
      kind: 'workspace',
      item: workspaceItem({ key: 'item:moved', change: 'moved', kind: 'folder', path: `${MAT}/Drafts`, fromPath: `${MAT}/Old drafts`, entry: null, class: 'other', before: null, after: null, files: 0 }),
    });
    expect(await within(pane).findByRole('heading', { name: 'Empty folder' })).toBeInTheDocument();
    expect(notes(pane)).toEqual(['Renamed from Old drafts.']);
  });

  it('words History’s moved and deleted folders, whose files it does not count', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'version', contentDiff({ kind: 'folder' }, { before: null, after: null }));
    const folderRow = (change: 'moved' | 'deleted') =>
      changeRow({ key: `row:labs-${change}`, change, kind: 'folder', class: 'other', path: `${MAT}/Labs`, fromPath: change === 'moved' ? `${MAT}/Old labs` : null, before: null, after: null });
    render({ kind: 'version', commit: COMMIT_REF, row: folderRow('moved') });
    expect(await within(pane).findByRole('heading', { name: 'Its files moved with it' })).toBeInTheDocument();
    expect(pane).toHaveTextContent("Their content didn't change, so there's nothing to compare.");
    expect(notes(pane)).toEqual(['Renamed from Old labs.']);

    render({ kind: 'version', commit: COMMIT_REF, row: folderRow('deleted') });
    expect(await within(pane).findByRole('heading', { name: 'Nothing to compare' })).toBeInTheDocument();
    expect(pane).toHaveTextContent('Folders have no content of their own.');
    expect(notes(pane)).toEqual(['This version deleted the folder.']);
  });
});

describe('tags and settings', () => {
  it('shows the tags of a file that changed', async () => {
    const { pane } = showDiff(() => metadata('tags'));
    const heading = within(pane).getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Midterm 2025.pdf · Tags');
    expect(await within(pane).findByText('Only the tags changed. The file itself is the same as in the last commit.')).toBeInTheDocument();
    const rows = within(pane).getAllByRole('term').map((term) => term.textContent);
    expect(rows).toEqual(['Added', 'Now']);
    const [added, now] = within(pane).getAllByRole('definition');
    expect(added).toHaveTextContent('+To review');
    expect(now).toHaveTextContent('重要To review');
  });

  it('words History’s tag change', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'version', contentDiff(
      { kind: 'metadata', detail: { kind: 'tags', added: [], removed: [{ id: 'x', name: null, color: null }], now: [] } },
      { before: null, after: null },
    ));
    render({
      kind: 'versionMetadata',
      commit: COMMIT_REF,
      change: metadataChange({ kind: 'tags', path: `${MAT}/Lectures`, entryKind: 'folder', entry: null }),
    });
    expect(await within(pane).findByText('This version changed only the tags. The folder itself stayed the same.')).toBeInTheDocument();
    const [removed, now] = within(pane).getAllByRole('definition');
    expect(removed).toHaveTextContent('−Unknown tag');
    expect(now).toHaveTextContent('No tags');
  });

  it('lists a course’s changed settings', async () => {
    const { pane } = showDiff(() => metadata('course'));
    expect(await within(pane).findByText('Changed from Teal to Green')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent('CSC148 course settings');
    });
    expect(within(pane).getByText('Changed from CSC 148 to CSC148')).toBeInTheDocument();
    expect(within(pane).getAllByRole('term').map((term) => term.textContent)).toEqual(['Colour', 'Code']);
    expect(within(pane).getAllByRole('definition')[0]).toHaveTextContent('Teal → Green');
  });

  it('lists the library’s settings, with sizes, lists and the order', async () => {
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    stubDiff(shell, 'workspace', contentDiff(
      {
        kind: 'metadata',
        detail: {
          kind: 'settings',
          changes: [
            { field: 'name', before: 'Folio', after: 'School' },
            { field: 'textMaxSize', before: String(10 * 1024 * 1024), after: String(20 * 1024 * 1024) },
            { field: 'textExtensions', added: ['.tex', '.bib'], removed: ['.log'] },
            { field: 'order', before: null, after: 4 },
            { field: 'archived', before: false, after: true },
            { field: 'abbr', before: null, after: 'ToC' },
          ],
        },
      },
      { before: null, after: null },
    ));
    render({ kind: 'workspaceMetadata', change: metadataChange({ kind: 'library' }) });
    expect(await within(pane).findByText('Changed from 10.0 MB to 20.0 MB')).toBeInTheDocument();
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent('Library settings');
    expect(within(pane).getByText('Added .tex, .bib')).toBeInTheDocument();
    expect(within(pane).getByText('Removed .log')).toBeInTheDocument();
    expect(within(pane).getByText('Moved in the list')).toBeInTheDocument();
    expect(within(pane).getByText('Changed from No to Yes')).toBeInTheDocument();
    expect(within(pane).getByText('Changed from None to ToC')).toBeInTheDocument();
  });

  it('lists changed tag definitions', async () => {
    const { pane, shell, render } = showDiff(() => metadata('tagDefinitions'));
    expect(await within(pane).findByRole('term')).toHaveTextContent('New tag');
    expect(within(pane).getByRole('definition')).toHaveTextContent('To review');
    stubDiff(shell, 'version', contentDiff(
      {
        kind: 'metadata',
        detail: {
          kind: 'tagDefinitions',
          changes: [
            { id: 'a', before: { name: 'Exams', color: 'red', order: 1 }, after: { name: 'Tests', color: 'pink', order: 3 } },
            { id: 'b', before: { name: 'Labs', color: 'teal', order: 2 }, after: null },
          ],
        },
      },
      { before: null, after: null },
    ));
    render({ kind: 'versionMetadata', commit: COMMIT_REF, change: metadataChange({ kind: 'tagDefinitions' }) });
    expect(await within(pane).findByText('name changed from Exams to Tests')).toBeInTheDocument();
    expect(within(pane).getByText('colour changed from Red to Pink')).toBeInTheDocument();
    expect(within(pane).getAllByRole('term').map((term) => term.textContent)).toEqual(['Tag “Tests”', 'Deleted tag']);
    expect(within(pane).getAllByRole('definition')[1]).toHaveTextContent('Labs');
  });
});
