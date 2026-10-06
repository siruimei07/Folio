// "Changes | This version" and the file's preview in the diff pane (handoff workspace-history §6.1,
// §6.7, §6.8, §8.1, §8.4) on the fake shell: the toggle from the row and from the content, back to
// "Changes" for another row, the compact pane's "More", History's Restore and its disabled reason,
// and the preview of event-only files and moves without edits in Changes and History.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installShortcuts } from '../app/shortcuts';
import { MenuItem } from '../components/Menu/Menu';
import { contentUrl, versionUrl } from '../ipc';
import { frameMessages, refOf, serveFiles as serve } from '../test/files';
import { contentDiff, versionSide } from './test/diffs';
import { mockScrolling } from './test/lines';
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
  notes,
  PHY,
  position,
  recordAnnouncements,
  REVIEW,
  showDiff,
  strip,
  stubDiff,
  version,
} from './test/pane';

const NARROW = { width: 500, height: 600 };
const REASON = 'This is the version you have now.';
const LECTURE = `${MAT}/Lectures/Lecture 12.pdf`;

const HOST_ITEMS = (
  <>
    <MenuItem>Show in File Explorer</MenuItem>
    <MenuItem>Copy path</MenuItem>
  </>
);

/** Answers every `folio-file` request with a little text; returns the URLs fetched so far. */
function serveFiles(): () => string[] {
  return serve(() => 'text').fetched;
}

function toggleOf(pane: HTMLElement): HTMLElement | null {
  return within(pane).queryByRole('radiogroup', { name: 'Show' });
}

/** Which segment is pressed. */
function viewOf(pane: HTMLElement): 'changes' | 'version' {
  const changes = within(pane).getByRole('radio', { name: 'Changes' });
  return changes.getAttribute('aria-checked') === 'true' ? 'changes' : 'version';
}

/** The items of the open menu, separators as "—". */
function menuEntries(): string[] {
  const menu = screen.getByRole('menu');
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((entry) =>
    entry.getAttribute('role') === 'separator' ? '—' : (entry.querySelector('.menu-item__label')?.textContent ?? ''),
  );
}

async function openMore(pane: HTMLElement, user: ReturnType<typeof showDiff>['user']) {
  await user.click(within(pane).getByRole('button', { name: 'More' }));
  await screen.findByRole('menu');
}

/** Esc pressed in the preview's frame, as its document sends it (preview/protocol.ts). */
function pressEscapeInFrame() {
  frameMessages().send({ kind: 'shortcut', press: { key: 'Escape', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false } });
}

describe('Changes | This version', () => {
  it('is offered from the row before the diff loads, and shows the file on the disk through the preview', async () => {
    const fetched = serveFiles();
    const { pane, user, target } = showDiff(() => item(REVIEW), { latencyMs: 300 });
    expect(toggleOf(pane)).toBeInTheDocument();
    expect(viewOf(pane)).toBe('changes');
    expect(within(pane).queryByTitle('Preview of Midterm review.md')).toBeNull();
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('lines added');
    });

    await user.click(within(pane).getByRole('radio', { name: 'This version' }));
    expect(await within(pane).findByTitle('Preview of Midterm review.md')).toBeInTheDocument();
    expect(viewOf(pane)).toBe('version');
    // The diff is set aside: no strip or lines while this version shows.
    expect(within(pane).queryByRole('region', { name: 'Changes in Midterm review.md' })).toBeNull();
    expect(strip(pane)).not.toBeVisible();
    const entry = target.kind === 'workspace' ? target.item.entry : null;
    if (entry === null) throw new Error('not a file in Changes');
    await waitFor(() => {
      expect(fetched()).toContain(contentUrl(entry));
    });
    expect(fetched().some((url) => url.includes('/version/'))).toBe(false);

    // Esc in the preview's frame hands the focus to the heading.
    pressEscapeInFrame();
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveFocus();

    await user.click(within(pane).getByRole('radio', { name: 'Changes' }));
    expect(await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' })).toBeVisible();
    expect(within(pane).queryByTitle('Preview of Midterm review.md')).toBeNull();
  });

  it('finds the diff as it was on the way back: the current change stays', async () => {
    mockScrolling();
    onTestFinished(installShortcuts());
    serveFiles();
    const { pane, user } = showDiff(() => item(REVIEW));
    await waitFor(() => {
      expect(position(pane)).toBe('Change 1 of 2');
    });
    await user.keyboard('{F7}');
    await waitFor(() => {
      expect(position(pane)).toBe('Change 2 of 2');
    });
    await user.click(within(pane).getByRole('radio', { name: 'This version' }));
    await within(pane).findByTitle('Preview of Midterm review.md');
    // Shift+F7 belongs to the diff, which is set aside: it moves nothing meanwhile.
    await user.keyboard('{Shift>}{F7}{/Shift}');
    await user.click(within(pane).getByRole('radio', { name: 'Changes' }));
    expect(await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' })).toBeVisible();
    expect(position(pane)).toBe('Change 2 of 2');
  });

  it('shows a version stored in History through the version route', async () => {
    const fetched = serveFiles();
    const { pane, user } = showDiff(() => version(REVIEW));
    const stored = commitRow(REVIEW).row.after;
    if (stored === null) throw new Error('no stored version');
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('This version:');
    });
    await user.click(within(pane).getByRole('radio', { name: 'This version' }));
    expect(await within(pane).findByTitle('Preview of Midterm review.md')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetched()).toContain(versionUrl(stored, 'Midterm review.md'));
    });
    expect(fetched().some((url) => url.includes('/content/'))).toBe(false);
  });

  it('is taken back when the content shows the file cannot be shown', async () => {
    const { pane } = showDiff(() => item(`${CSC}/a1/starter/test_tree.py`), { scenario: 'diffs', latencyMs: 300 });
    expect(toggleOf(pane)).toBeInTheDocument();
    expect(await within(pane).findByRole('heading', { name: "This file isn't text" })).toBeInTheDocument();
    expect(toggleOf(pane)).toBeNull();
  });

  it('is not offered for event-only files, deletions, moves without edits, folders or Word files', async () => {
    const { pane, render } = showDiff(() => item(`${ECO}/Supply and demand.png`));
    const cases: [string, string][] = [
      [`${ECO}/Supply and demand.png`, "Modified: 180 KB → 402 KB. Folio keeps only the latest copy of images, so there's no older version to compare."],
      [`${MAT}/Old slides L2.pdf`, 'Deleted: committing removes it from the library. The file is in the Recycle Bin.'],
      [`${MAT}/Problem sets/ps2 solutions.md`, 'Moved from MAT232/.'],
      [`${LINEAR}/习题`, 'Renamed from Exercises.'],
    ];
    for (const [path, banner] of cases) {
      render(item(path));
      await waitFor(() => {
        expect(notes(pane)).toContain(banner);
      });
      expect(toggleOf(pane)).toBeNull();
    }
    // Word files show as a card until their previews come, so there is no version to look at.
    render(item(`${CSC}/labs/lab1/report.docx`));
    expect(await within(pane).findByRole('region', { name: 'Changes in report.docx' })).toBeInTheDocument();
    expect(toggleOf(pane)).toBeNull();
  });

  it('starts afresh for another row and for this one when it comes back, not when it comes back refreshed', async () => {
    mockScrolling();
    onTestFinished(installShortcuts());
    serveFiles();
    const { pane, user, render, target } = showDiff(() => item(REVIEW));
    await waitFor(() => {
      expect(position(pane)).toBe('Change 1 of 2');
    });
    await user.keyboard('{F7}');
    await waitFor(() => {
      expect(position(pane)).toBe('Change 2 of 2');
    });
    await user.click(within(pane).getByRole('radio', { name: 'This version' }));
    await within(pane).findByTitle('Preview of Midterm review.md');
    if (target.kind !== 'workspace') throw new Error('not a workspace row');
    render({ kind: 'workspace', item: { ...target.item, readiness: 'ready' } });
    expect(viewOf(pane)).toBe('version');
    expect(within(pane).getByTitle('Preview of Midterm review.md')).toBeInTheDocument();

    render(item(`${CSC}/a1/starter/tree.py`));
    expect(viewOf(pane)).toBe('changes');
    expect(await within(pane).findByRole('region', { name: 'Changes in tree.py' })).toBeVisible();
    // Back to the first row: the diff, at its first change.
    render(target);
    expect(viewOf(pane)).toBe('changes');
    expect(await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' })).toBeVisible();
    expect(position(pane)).toBe('Change 1 of 2');
  });

  it('shows this version from the block of a change too big to show, and puts the focus on the heading', async () => {
    serveFiles();
    const { pane, user } = showDiff(() => item(`${PHY}/Kinematics.md`), { scenario: 'diffs' });
    await within(pane).findByRole('heading', { name: 'This change is too big to show here' });
    await user.click(within(pane).getByRole('button', { name: 'Show this version' }));
    expect(await within(pane).findByTitle('Preview of Kinematics.md')).toBeInTheDocument();
    expect(viewOf(pane)).toBe('version');
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveFocus();
  });

  it('gives Word’s formatting block no "Show this version" until Word files preview, nor the line endings block', async () => {
    const { pane, render } = showDiff(() => item(`${LINEAR}/习题/习题 2.docx`), { scenario: 'diffs' });
    await within(pane).findByRole('heading', { name: 'No text changed' });
    expect(within(pane).queryByRole('button', { name: 'Show this version' })).toBeNull();
    expect(toggleOf(pane)).toBeNull();
    // The text is the same: the header offers this version, the block does not point at it.
    render(item(`${MAT}/week 2 notes.md`));
    await within(pane).findByRole('heading', { name: 'Only the line endings changed' });
    expect(toggleOf(pane)).toBeInTheDocument();
    expect(within(pane).queryByRole('button', { name: 'Show this version' })).toBeNull();
  });
});

describe('the compact pane', () => {
  it('puts the toggle and Restore… after the host’s items in More below 600 px', async () => {
    serveFiles();
    const onRestore = vi.fn();
    const { pane, user } = showDiff(() => version(REVIEW), { layout: NARROW, props: { moreItems: HOST_ITEMS, restore: { onRestore } } });
    await waitFor(() => {
      expect(strip(pane)).toHaveTextContent('This version:');
    });
    expect(toggleOf(pane)).toBeNull();
    expect(within(pane).queryByRole('button', { name: 'Restore' })).toBeNull();

    await openMore(pane, user);
    expect(menuEntries()).toEqual(['Show in File Explorer', 'Copy path', '—', 'Show this version', 'Restore…']);
    await user.click(screen.getByRole('menuitem', { name: 'Show this version' }));
    expect(await within(pane).findByTitle('Preview of Midterm review.md')).toBeInTheDocument();

    await openMore(pane, user);
    expect(menuEntries()).toEqual(['Show in File Explorer', 'Copy path', '—', 'Show the changes', 'Restore…']);
    expect(screen.getByRole('menuitem', { name: 'Restore…' }).querySelector('.menu-item__note')).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Restore…' }));
    expect(onRestore).toHaveBeenCalledTimes(1);

    await openMore(pane, user);
    await user.click(screen.getByRole('menuitem', { name: 'Show the changes' }));
    expect(await within(pane).findByRole('region', { name: 'Changes in Midterm review.md' })).toBeVisible();
  });

  it('lists Restore… disabled when it cannot be done, and only the pane’s items without the host’s', async () => {
    const onRestore = vi.fn();
    const { pane, user, render, target } = showDiff(() => version(REVIEW), {
      layout: NARROW,
      props: { restore: { onRestore, disabledReason: REASON } },
    });
    await openMore(pane, user);
    expect(menuEntries()).toEqual(['Show this version', 'Restore…']);
    const restore = screen.getByRole('menuitem', { name: 'Restore…' });
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    // A disabled item has no tooltip: the reason shows on it.
    expect(restore.querySelector('.menu-item__note')).toHaveTextContent(REASON);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });

    // Nothing to put in More: no More.
    render(item(`${MAT}/Old slides L2.pdf`), {});
    await within(pane).findByRole('heading', { name: 'Old slides L2.pdf is in the Recycle Bin' });
    expect(within(pane).queryByRole('button', { name: 'More' })).toBeNull();
    expect(target.kind).toBe('version');
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('follows the pane’s width, and keeps it while the pane is hidden', () => {
    const observed: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    const saved = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observed.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {
        // The test calls the callbacks itself.
      }
      disconnect() {
        this.entry.targets = [];
      }
    };
    onTestFinished(() => {
      globalThis.ResizeObserver = saved;
    });
    const { pane } = showDiff(() => item(REVIEW), { props: { moreItems: HOST_ITEMS } });
    const resize = (width: number) => {
      const own = observed.find((entry) => entry.targets.includes(pane));
      if (own === undefined) throw new Error('the pane is not observed');
      act(() => {
        own.callback([{ target: pane, contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      });
    };
    expect(toggleOf(pane)).toBeInTheDocument();
    // Hidden (no width): the header stays as it was.
    resize(0);
    expect(toggleOf(pane)).toBeInTheDocument();
    resize(599);
    expect(toggleOf(pane)).toBeNull();
    resize(600);
    expect(toggleOf(pane)).toBeInTheDocument();
  });
});

describe('Restore', () => {
  it('is a button in the header that asks the host', async () => {
    const onRestore = vi.fn();
    const { pane, user } = showDiff(() => version(REVIEW), { props: { restore: { onRestore } } });
    await user.click(within(pane).getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('stays in the tab order when it cannot be done, with the reason in its tooltip, and does nothing', async () => {
    const onRestore = vi.fn();
    const { pane, user } = showDiff(() => version(REVIEW), { props: { restore: { onRestore, disabledReason: REASON } } });
    const button = within(pane).getByRole('button', { name: 'Restore' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-disabled');
    act(() => {
      within(pane).getByRole('radio', { name: 'Changes' }).focus();
    });
    await user.tab();
    expect(button).toHaveFocus();
    // Tooltips close on any key, so the tooltip is read before pressing one.
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(REASON);
    expect(button).toHaveAccessibleDescription(REASON);
    await user.keyboard('{Enter}');
    await user.click(button);
    expect(onRestore).not.toHaveBeenCalled();
  });
});

describe('the file’s preview', () => {
  it('shows an event-only file in Changes under its banner', async () => {
    const { pane } = showDiff(() => item(`${ECO}/Supply and demand.png`));
    const image = await within(pane).findByRole('img', { name: 'Supply and demand.png' });
    expect(image).toHaveAttribute('src', contentUrl(refOf(`${ECO}/Supply and demand.png`)));
    expect(notes(pane)).toHaveLength(1);
  });

  it('shows a file moved without edits in Changes as it is on the disk', async () => {
    const fetched = serveFiles();
    const path = `${MAT}/Problem sets/ps2 solutions.md`;
    const { pane } = showDiff(() => item(path));
    expect(await within(pane).findByTitle('Preview of ps2 solutions.md')).toBeInTheDocument();
    expect(notes(pane)).toEqual(['Moved from MAT232/.']);
    await waitFor(() => {
      expect(fetched()).toContain(contentUrl(refOf(path)));
    });
  });

  it('shows the stored version of a History row moved without edits', async () => {
    const fetched = serveFiles();
    const { pane, shell, render } = showDiff(() => item(REVIEW));
    const { commit, row } = commitRow(REVIEW);
    const stored = row.after;
    if (stored === null) throw new Error('no stored version');
    stubDiff(shell, 'version', contentDiff({ kind: 'same' }, { before: versionSide({ hash: stored.hash }), after: versionSide({ hash: stored.hash }) }));
    render({ kind: 'version', commit, row: { ...row, key: 'row:moved', change: 'moved', fromPath: `${MAT}/Midterm review.md`, before: stored } });
    expect(await within(pane).findByTitle('Preview of Midterm review.md')).toBeInTheDocument();
    expect(notes(pane)).toEqual(['Moved from MAT232/.']);
    await waitFor(() => {
      expect(fetched()).toContain(versionUrl(stored, 'Midterm review.md'));
    });
    expect(toggleOf(pane)).toBeNull();
  });

  it('shows a History event-only file as it is now', async () => {
    const fetched = serveFiles();
    const { pane } = showDiff(() => version(LECTURE));
    expect(await within(pane).findByTitle('Preview of Lecture 12.pdf')).toBeInTheDocument();
    expect(notes(pane)).toEqual([
      'This version added the file. Folio keeps only the latest copy of PDFs, so the preview shows the file as it is now.',
    ]);
    await waitFor(() => {
      expect(fetched()).toContain(contentUrl(refOf(LECTURE)));
    });
  });

  it('says when that file has been deleted since', async () => {
    const { pane } = showDiff(() => {
      const target = version(LECTURE);
      fake().deleteFile(LECTURE);
      return target;
    });
    expect(await within(pane).findByRole('heading', { name: 'Nothing to show' })).toBeInTheDocument();
    expect(pane).toHaveTextContent("It has been deleted since, so there's no copy left to show.");
    expect(within(pane).queryByTitle('Preview of Lecture 12.pdf')).toBeNull();
  });

  it('says when the file cannot be looked up as the preview’s failure, and tries again', async () => {
    const { pane, shell, render, user } = showDiff(() => item(REVIEW), { latencyMs: 30 });
    const { commit } = commitRow(LECTURE);
    const invoke = vi.spyOn(shell, 'invoke');
    stubDiff(shell, 'version', contentDiff({ kind: 'notStored' }, { before: null, after: versionSide({ stored: false }) }));
    // No commit holds this path, so the lookup fails.
    const path = `${MAT}/Lectures/Lecture 13.pdf`;
    render({
      kind: 'version',
      commit,
      row: { key: 'row:13', change: 'added', kind: 'file', path, fromPath: null, class: 'other', before: null, after: { hash: `b3:${'e'.repeat(64)}`, size: '10', stored: false, pruned: false } },
    });
    // The change showed (its banner); what failed is the preview of the file as it is now.
    expect(await within(pane).findByRole('heading', { name: "Can't show this file" })).toBeInTheDocument();
    expect(within(pane).queryByText("Couldn't show what changed")).toBeNull();
    expect(announced()).toBe("Can't show this file");
    const asked = () => calls(invoke, 'locate_version');
    const before = asked();
    const said = recordAnnouncements();
    // By keyboard: the block goes while the file is looked up again, and the focus waits on the
    // heading; the lookup fails again, and the block comes back read once.
    const retry = within(pane).getByRole('button', { name: 'Try again' });
    act(() => {
      retry.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(asked()).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(within(pane).getByRole('heading', { level: 2, name: /Lecture 13\.pdf/ })).toHaveFocus();
    });
    await waitFor(() => {
      expect(said).toEqual(["Can't show this file"]);
    });
    expect(within(pane).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(pane).queryByRole('button', { name: 'Open with default app' })).toBeNull();
  });
});
