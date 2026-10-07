// The commit box (workspace-history handoff §4.1, §4.2, §4.4, §4.5, §4.7) on the fake shell: what
// the commit button says in each state, a commit with a typed or template message and its job,
// Ctrl+Enter from anywhere in the view, the list while a commit runs, each failure's note, the
// reason committing waits, the fields' limits and the narrow window's bar. AI is off here
// (`ai-off`, or a fixture without a key); ai.test.tsx covers the AI message.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { installShortcuts } from '../../app/shortcuts';
import { useJobNotes } from '../../app/activity/notes';
import checkboxSheet from '../../components/Checkbox/Checkbox.css?raw';
import type { AppError } from '../../ipc';
import { toastTexts } from '../../test/render';
import tokensSheet from '../../tokens/tokens.css?raw';
import listSheet from '../list/ChangesList.css?raw';
import { setListLayout } from '../preferences';
import { useChangesView } from '../state';
import {
  boxOf,
  callsOf,
  changesList,
  commitBox,
  committed,
  commitButton,
  commitRequests,
  CSC,
  descriptionField,
  findCommitNote,
  findRow,
  getRow,
  includeAll,
  JOB_TEST,
  JOB_WAIT,
  longJob,
  MAT,
  politeText,
  queryRow,
  renderChanges,
  resizeTo,
  smallWorkspace,
  summaryField,
  TEMPLATE,
} from '../test/render';

const MIDTERM = 'Midterm review.md';
const RECORDING = 'ECO101 微观经济学/Lecture recording week 5.mp4';
/** The keys of the two blocked items, which the list keeps out once it has shown them (§3.4). */
const BLOCKED = ['item:added:Fall 2026/ECO101 微观经济学/Lecture recording week 5.mp4', 'item:added:Personal/Photos/IMG_2031.HEIC'];

/**
 * Puts the check box's and the changes list's stylesheets on the page until the test ends, with the
 * opacity tokens written in: jsdom does not resolve custom properties.
 */
function addListStyles(): void {
  const opacity = new Map([...tokensSheet.matchAll(/--opacity-([\w-]+): ([\d.]+);/g)].map(([, name, value]) => [name, value]));
  const style = document.createElement('style');
  style.textContent = `${checkboxSheet}\n${listSheet}`.replace(
    /var\(--opacity-([\w-]+)\)/g,
    (_match, name: string) => opacity.get(name) ?? 'unset',
  );
  document.head.append(style);
  onTestFinished(() => {
    style.remove();
  });
}

/** The opacity an element is drawn with: its own times its ancestors'. */
function drawnOpacity(element: Element): number {
  let opacity = 1;
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    const own = getComputedStyle(at).opacity;
    if (own !== '') opacity *= Number(own);
  }
  return opacity;
}

async function ready(options: Parameters<typeof renderChanges>[0] = {}) {
  const rendered = renderChanges({ scenario: 'ai-off', ...options });
  const invoke = vi.spyOn(rendered.shell, 'invoke');
  await findRow('CSC148/a1/run.bat');
  await waitFor(() => {
    expect(commitButton()).toHaveAccessibleName('Commit 14 changes');
  });
  return { ...rendered, invoke };
}

describe('the commit button', JOB_TEST, () => {
  it('counts the included items and the tag and settings changes, with the shortcut beside it', async () => {
    await ready();
    const button = commitButton();
    expect(button).toHaveTextContent('Commit 14 changesCtrl+Enter');
    expect(button).toHaveAccessibleDescription('Ctrl+Enter');
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('counts the tag and settings changes when every item is left out', async () => {
    const { user } = await ready();
    await user.click(includeAll());
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Commit 4 changes');
    });
    expect(within(commitBox()).getByRole('button', { name: 'Use template' })).not.toHaveAttribute('aria-disabled');
  });

  it('says "Nothing selected" when nothing is included and nothing else changed; it stays in the tab order', async () => {
    // A fixture of its own keeps the small library's AI on.
    const { user } = renderChanges({ fixture: smallWorkspace([{ change: 'modified', path: `${MAT}/Notes.md` }], { metadata: false }) });
    await findRow('MAT232/Notes.md');
    await user.click(includeAll());
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Nothing selected');
    });
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitButton()).not.toBeDisabled();
    // The message button waits too, and says why: the commit button's words.
    const generate = within(commitBox()).getByRole('button', { name: 'Generate' });
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    expect(generate).toHaveAccessibleDescription('Nothing selected');
  });

  it('says "Nothing to commit" when the workspace is empty', async () => {
    renderChanges({ fixture: smallWorkspace([], { metadata: false }) });
    expect(await screen.findByRole('heading', { name: 'No changes' })).toBeInTheDocument();
    expect(commitButton()).toHaveAccessibleName('Nothing to commit');
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('cannot commit from a list that failed to load, and says why instead of offering Ctrl+Enter', async () => {
    renderChanges({ fail: [{ command: 'list_workspace_items', code: 'Internal' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load your changes" })).toBeInTheDocument();
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitButton()).toHaveAccessibleName('Commit');
    expect(commitButton()).not.toHaveTextContent('Ctrl+Enter');
    expect(commitButton()).toHaveAccessibleDescription("Couldn't load your changes");
    const generate = within(commitBox()).getByRole('button', { name: 'Generate' });
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    expect(generate).toHaveAccessibleDescription("Couldn't load your changes");
  });

  it('says why it cannot commit when the workspace failed to load', async () => {
    renderChanges({ fail: [{ command: 'get_workspace', code: 'Internal' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load your changes" })).toBeInTheDocument();
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitButton()).not.toHaveTextContent('Ctrl+Enter');
    expect(commitButton()).toHaveAccessibleDescription("Couldn't load your changes");
  });
});

describe('committing', JOB_TEST, () => {
  it('commits the typed message with the selection, fingerprint and base, then clears the fields and says so', async () => {
    const { user, shell, invoke } = await ready();
    const before = shell.versioning.summary();
    await user.type(summaryField(), 'Finish the midterm review');
    await user.type(descriptionField(), 'Two more questions.');
    await user.click(commitButton());

    await committed('Committed 14 changes: Finish the midterm review');
    // Until the workspace after the commit is read, the button offers nothing.
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitRequests(invoke)).toEqual([
      {
        selection: { kind: 'allExcept', keys: BLOCKED },
        fingerprint: before.fingerprint,
        base: before.head,
        summary: 'Finish the midterm review',
        body: 'Two more questions.',
      },
    ]);
    expect(summaryField()).toHaveValue('');
    expect(descriptionField()).toHaveValue('');
    // The committed rows leave the list; the blocked ones stay.
    await waitFor(() => {
      expect(queryRow('CSC148/a1/run.bat')).toBeNull();
    });
    expect(getRow(RECORDING)).toBeInTheDocument();
    // It never offers the committed changes again: it waits for the workspace after the commit.
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Nothing selected');
    });
    // The commit button kept the focus, now pending with nothing left to commit.
    expect(commitButton()).toHaveFocus();
    expect(toastTexts()).toEqual([]);
  });

  it('notes the number of changes for the activity popover', async () => {
    const { user, shell } = await ready({ jobStepMs: 60_000 });
    await user.click(commitButton());
    await waitFor(() => {
      expect(shell.jobs().some((job) => job.kind === 'commit')).toBe(true);
    });
    const job = shell.jobs().find((candidate) => candidate.kind === 'commit');
    await waitFor(() => {
      expect(useJobNotes.getState().commits[job?.id ?? '']).toBe(14);
    });
  });

  it('writes the template when both fields are empty', async () => {
    const { user, invoke } = await ready();
    await user.click(commitButton());
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(commitRequests(invoke)[0]).toMatchObject({ summary: TEMPLATE, body: null });
    await committed(`Committed 14 changes: ${TEMPLATE}`);
  });

  it('puts the template before a description typed without a summary', async () => {
    const { user, invoke } = await ready();
    await user.type(descriptionField(), 'Only a description.');
    await user.click(commitButton());
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(commitRequests(invoke)[0]).toMatchObject({ summary: TEMPLATE, body: 'Only a description.' });
  });

  it('commits only the included changes', async () => {
    const { user, shell, invoke } = await ready();
    await user.click(boxOf(getRow('CSC148/a1/run.bat')));
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Commit 13 changes');
    });
    await user.click(commitButton());
    await committed(/^Committed 13 changes: /);
    const runBat = shell.versioning.itemPage({ offset: 0, limit: 50 }).items.find((item) => item.path === `${CSC}/a1/run.bat`);
    const sent = commitRequests(invoke)[0]?.selection;
    expect(sent?.kind).toBe('allExcept');
    expect(sent?.keys.toSorted()).toEqual([...BLOCKED, runBat?.key].toSorted());
    expect(getRow('CSC148/a1/run.bat')).toBeInTheDocument();
  });

  it('commits with Ctrl+Enter from a field, which keeps the focus', async () => {
    onTestFinished(installShortcuts());
    const { user } = await ready();
    await user.type(summaryField(), 'From the field');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(summaryField()).toHaveFocus();
    await committed('Committed 14 changes: From the field');
    expect(summaryField()).toHaveFocus();
  });

  it('commits with Ctrl+Enter from the diff, which keeps the focus', async () => {
    onTestFinished(installShortcuts());
    const { user, invoke } = await ready();
    await user.click(getRow(RECORDING));
    const pane = await screen.findByRole('group', { name: /Lecture recording week 5\.mp4$/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(pane.contains(document.activeElement)).toBe(true);
    });
    const focused = document.activeElement;
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(document.activeElement).toBe(focused);
    await committed(/^Committed 14 changes/);
    // The recording was left out: its row and its diff stay, and so does the focus.
    expect(pane.contains(document.activeElement)).toBe(true);
  });

  it('leaves the focus where it is when Ctrl+Enter starts no commit', async () => {
    onTestFinished(installShortcuts());
    const { user } = renderChanges({ fixture: smallWorkspace([{ change: 'modified', path: `${MAT}/Notes.md` }], { metadata: false }) });
    await findRow('MAT232/Notes.md');
    await user.click(includeAll());
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Nothing selected');
    });
    const flat = screen.getByRole('radio', { name: 'Flat list' });
    act(() => {
      flat.focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(useChangesView.getState().run.kind).toBe('idle');
    expect(flat).toHaveFocus();
  });

  it('commits with Ctrl+Enter from the list, which does not take it as Enter', async () => {
    onTestFinished(installShortcuts());
    const { user, invoke } = await ready();
    act(() => {
      getRow(RECORDING).focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    await committed(/^Committed 14 changes/);
    // Enter would have moved the focus into the diff.
    expect(getRow(RECORDING)).toHaveFocus();
  });

  it('commits with Ctrl+Enter while the focus is on the message button, which it does not press', async () => {
    const { user, invoke } = await ready();
    const template = within(commitBox()).getByRole('button', { name: 'Use template' });
    act(() => {
      template.focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(summaryField()).toHaveValue('');
  });

  it('says "Committing…" when a commit started from a field keeps the focus there', async () => {
    const { user } = await ready({ jobStepMs: 60_000 });
    await user.type(summaryField(), 'From the field');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Committing…');
    });
    expect(summaryField()).toHaveFocus();
    expect(politeText()).toBe('Committing…');
    // The options chevron waits with it, and says why.
    expect(within(commitBox()).getByRole('button', { name: 'Message options' })).toHaveAccessibleDescription('Committing…');
  });

  it('shows "Committing…" after 150 ms, fades the check boxes, and keeps them still while the selection moves', async () => {
    const { user, shell } = await ready({ jobStepMs: 60_000 });
    act(() => {
      getRow('CSC148/a1/run.bat').focus();
    });
    await user.click(commitButton());
    expect(commitButton()).toHaveAccessibleName('Commit 14 changes');
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Committing…');
    });
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitButton().querySelector('.spinner')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Changes' })).toHaveClass('changes-list--committing');
    expect(includeAll()).toBeDisabled();
    expect(summaryField()).toHaveAttribute('readonly');
    expect(descriptionField()).toHaveAttribute('readonly');

    // Space, a click on a box and Ctrl+A change nothing; the selection still moves.
    const row = getRow('CSC148/a1/run.bat');
    act(() => {
      row.focus();
    });
    await user.keyboard(' ');
    await user.click(boxOf(getRow('CSC148/a1/starter/test_tree.py')));
    await user.keyboard('{Control>}a{/Control}');
    expect(useChangesView.getState().selection).toEqual({ kind: 'allExcept', keys: BLOCKED });
    expect(row).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}');
    expect(getRow('CSC148/a1/starter/test_tree.py')).toHaveAttribute('aria-selected', 'true');
    // The context menu's check box item waits too, and says why.
    await user.pointer({ keys: '[MouseRight]', target: getRow('CSC148/labs/lab1/report.docx') });
    const leaveOut = await screen.findByRole('menuitem', { name: /^Leave out of this commit/ });
    expect(leaveOut).toHaveAttribute('aria-disabled', 'true');
    expect(leaveOut).toHaveTextContent('Wait until the commit is done');
    await user.click(leaveOut);
    expect(useChangesView.getState().selection).toEqual({ kind: 'allExcept', keys: BLOCKED });
    // The menu stays open after a click on a disabled item, over the list.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(getRow('CSC148/labs/lab1/report.docx')).toHaveAttribute('aria-checked', 'true');

    act(() => {
      shell.finishJobs();
    });
    await committed(/^Committed 14 changes/);
    expect(screen.getByRole('region', { name: 'Changes' })).not.toHaveClass('changes-list--committing');
  });

  it('fades only the check boxes while a commit runs: rows, selection and course headers keep full contrast (AA)', async () => {
    addListStyles();
    const { user, shell } = await ready({ jobStepMs: 60_000 });
    const row = getRow('CSC148/a1/run.bat');
    act(() => {
      row.focus();
    });
    expect(row).toHaveAttribute('aria-selected', 'true');
    const boxIn = (element: Element) => {
      const box = element.querySelector('.checkbox__box');
      if (box === null) throw new Error('no check box');
      return box;
    };
    const header = screen.getByRole('region', { name: 'Changes' }).querySelector('.panel__header');
    if (header === null) throw new Error('no header');
    expect(drawnOpacity(boxIn(row))).toBe(1);
    expect(drawnOpacity(boxIn(header))).toBe(1);

    await user.click(commitButton());
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Committing…');
    });
    // The row stays operable (the selection moves, the diff shows, the menu opens): its text, icon,
    // status and selection bar keep their contrast; only its box, which does nothing now, fades.
    for (const part of ['.path-text', '.change-row__icon', '.change-row__status', '.selection-indicator']) {
      const element = row.querySelector(part);
      if (element === null) throw new Error(`no ${part}`);
      expect(drawnOpacity(element), part).toBe(1);
    }
    expect(drawnOpacity(boxIn(row))).toBeCloseTo(0.55);
    expect(drawnOpacity(boxIn(header))).toBeCloseTo(0.55);
    // A box that cannot change anyway (not on this computer) keeps its 45 %.
    expect(drawnOpacity(boxIn(getRow(RECORDING)))).toBeCloseTo(0.45);

    act(() => {
      setListLayout('grouped');
    });
    const course = await screen.findByRole('option', { name: /^CSC148 Introduction to Computer Science, / });
    const code = course.querySelector('.changes-place-header__code');
    if (code === null) throw new Error('no course code');
    expect(drawnOpacity(code)).toBe(1);
    expect(drawnOpacity(boxIn(course))).toBeCloseTo(0.55);

    act(() => {
      shell.finishJobs();
    });
    await committed(/^Committed 14 changes/);
  });

  it('commits with Ctrl+Enter from "Include all changes", which a commit disables: the focus goes to the commit button', async () => {
    const { user, invoke } = await ready({ jobStepMs: 60_000 });
    act(() => {
      includeAll().focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(commitButton()).toHaveFocus();
    await waitFor(() => {
      expect(commitRequests(invoke)).toHaveLength(1);
    });
    expect(includeAll()).toBeDisabled();
    expect(commitButton()).toHaveFocus();
  });

  it('keeps the focus in the commit box when Ctrl+Enter from a failure note starts a commit that takes the note away', async () => {
    const { user, shell } = await ready({ fail: [{ command: 'commit', code: 'Internal' }], jobStepMs: 60_000 });
    await user.click(commitButton());
    const note = await findCommitNote();
    act(() => {
      within(note).getByRole('button', { name: 'Copy details' }).focus();
    });
    shell.setFailure('commit', null);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(within(commitBox()).queryByRole('alert')).toBeNull();
    });
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
  });

  it('keeps "Committed …" in the live region when the row the selection moves on to cannot show its diff', async () => {
    const { user } = await ready();
    await user.type(summaryField(), 'Test commit');
    await user.click(commitButton());
    await committed('Committed 14 changes: Test commit');
    // The committed rows went: the selection is on the unreadable recording, whose diff fails at once.
    await waitFor(() => {
      expect(getRow(RECORDING)).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByText("Couldn't show what changed")).toBeInTheDocument();
    expect(politeText()).toBe('Committed 14 changes: Test commit');
    // It is heard after the commit's words, not in their place.
    await waitFor(
      () => {
        expect(politeText()).toBe("Couldn't show what changed");
      },
      { timeout: 2000 },
    );
  });

  it('goes back to idle, message and selection kept, when the commit is cancelled', async () => {
    const { user, shell } = await ready({ jobStepMs: 60_000 });
    await user.type(summaryField(), 'Not yet');
    await user.click(commitButton());
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Committing…');
    });
    const job = shell.jobs().find((candidate) => candidate.kind === 'commit');
    act(() => {
      shell.cancelJob(job?.id ?? '');
      shell.finishJobs();
    });
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Commit 14 changes');
    });
    expect(summaryField()).toHaveValue('Not yet');
    expect(within(commitBox()).queryByRole('alert')).toBeNull();
    expect(politeText()).toBe('');
    expect(useChangesView.getState().selection).toEqual({ kind: 'allExcept', keys: BLOCKED });
  });

  it('leaves a commit that would be refused once more alone while one runs', async () => {
    const { user, invoke } = await ready({ jobStepMs: 60_000 });
    await user.click(commitButton());
    await user.click(commitButton());
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Committing…');
    });
    expect(callsOf(invoke, 'commit')).toBe(1);
  });
});

// §4.4: "Focus stays on the commit button (now disabled if nothing is left) or returns to the list."
describe('the focus after a commit that empties the list', JOB_TEST, () => {
  const EVERYTHING = smallWorkspace(
    [
      { change: 'modified', path: `${MAT}/Notes.md` },
      { change: 'added', path: `${CSC}/a2/plan.md` },
    ],
    { metadata: false },
  );

  async function commitEverythingFrom(start: (user: ReturnType<typeof renderChanges>['user']) => Promise<void>) {
    onTestFinished(installShortcuts());
    const { user } = renderChanges({ fixture: EVERYTHING });
    await findRow('MAT232/Notes.md');
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Commit 2 changes');
    });
    await user.type(summaryField(), 'Everything');
    await start(user);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await committed('Committed 2 changes: Everything');
    expect(await screen.findByRole('heading', { name: 'No changes' }, JOB_WAIT)).toBeInTheDocument();
    await waitFor(() => {
      expect(commitButton()).toHaveFocus();
    });
    // "Committing…" until the workspace after the commit is read.
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Nothing to commit');
    }, JOB_WAIT);
    expect(commitButton()).toHaveFocus();
  }

  it('goes to the commit button when Ctrl+Enter came from a row', async () => {
    await commitEverythingFrom(async (user) => {
      await user.click(getRow('MAT232/Notes.md'));
      expect(getRow('MAT232/Notes.md')).toHaveFocus();
    });
  });

  it('goes to the commit button when Ctrl+Enter came from the diff', async () => {
    await commitEverythingFrom(async (user) => {
      await user.click(getRow('MAT232/Notes.md'));
      const pane = await screen.findByRole('group', { name: /Notes\.md$/ });
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(pane.contains(document.activeElement)).toBe(true);
      });
    });
  });

  it('goes to the commit bar\'s button when Ctrl+Enter came from the diff over the list', async () => {
    resizeTo(680);
    onTestFinished(() => {
      resizeTo(1024);
    });
    await commitEverythingFrom(async (user) => {
      await user.click(getRow('MAT232/Notes.md'));
      const pane = await screen.findByRole('group', { name: /Notes\.md$/ });
      await waitFor(() => {
        expect(pane.contains(document.activeElement)).toBe(true);
      });
    });
    expect(commitBox()).toHaveClass('commit-bar');
  });
});

describe('commit failures', JOB_TEST, () => {
  const JOB_FAILURES: [AppError['code'], string][] = [
    ['FileChanged', `${MIDTERM} kept changing while Folio read it. Save it and close it, then commit again.`],
    ['NotLocal', `${MIDTERM} isn't downloaded yet. Open it so it downloads, then commit again.`],
    ['InUse', `Another app is using ${MIDTERM}. Close it there, then commit again. Your message and choices are kept.`],
    ['AccessDenied', `Windows didn't let Folio read ${MIDTERM}.`],
    ['DiskFull', 'The disk is full. Free up some space, then commit again.'],
    ['HistoryDamaged', "Folio can't read this library's history. Your files are fine."],
  ];

  it.each(JOB_FAILURES)('says why the commit job failed with %s, naming the file, and keeps the message and selection', async (code, text) => {
    const { user } = await ready({ commitFailure: { code, file: `${MAT}/Exams/${MIDTERM}` } });
    await user.click(boxOf(getRow('CSC148/a1/run.bat')));
    await user.type(summaryField(), 'Kept');
    await waitFor(() => {
      expect(commitButton()).toHaveAccessibleName('Commit 13 changes');
    });
    await user.click(commitButton());
    const note = await findCommitNote();
    expect(note).toHaveTextContent(`Couldn't commit${text}`);
    expect(within(note).queryByRole('button', { name: 'Copy details' }) !== null).toBe(code === 'HistoryDamaged');
    expect(summaryField()).toHaveValue('Kept');
    expect(getRow('CSC148/a1/run.bat')).toHaveAttribute('aria-checked', 'false');
    expect(commitButton()).toHaveAccessibleName('Commit 13 changes');
    expect(commitButton()).not.toHaveAttribute('aria-disabled');
  });

  const START_FAILURES: [AppError['code'], string][] = [
    ['NothingToCommit', "There's nothing to commit any more. Another change may have undone it."],
    ['ReadOnly', 'A newer version of Folio changed this library. Update Folio to commit.'],
    ['HistoryReadOnly', 'A newer version of Folio changed this library. Update Folio to commit.'],
    ['Busy', "Folio is rebuilding its search index. Commit again when it's done."],
    ['HistoryBusy', 'Folio is still finishing another commit, message edit, undo or restore. Try again in a moment.'],
    ['Internal', 'Something went wrong inside Folio. Restart Folio. If this keeps happening, send the error details to the developer.'],
  ];

  it.each(START_FAILURES)('says why the shell refused the commit with %s', async (code, text) => {
    const { user } = await ready({ fail: [{ command: 'commit', code }] });
    await user.click(commitButton());
    const note = await findCommitNote();
    expect(note).toHaveTextContent(`Couldn't commit${text}`);
    expect(within(note).queryByRole('button', { name: 'Copy details' }) !== null).toBe(code === 'Internal');
  });

  it('asks for the changes again after WorkspaceChanged', async () => {
    const { user, invoke } = await ready({ fail: [{ command: 'commit', code: 'WorkspaceChanged' }] });
    const asked = callsOf(invoke, 'get_workspace');
    await user.click(commitButton());
    expect(await findCommitNote()).toHaveTextContent(
      "Couldn't commitThe changes changed while you were committing. Check the list, then commit again.",
    );
    await waitFor(() => {
      expect(callsOf(invoke, 'get_workspace')).toBeGreaterThan(asked);
    });
  });

  it('takes the note away when the next commit starts', async () => {
    const { user, shell } = await ready({ commitFailure: { code: 'DiskFull', file: null } });
    await user.click(commitButton());
    expect(await findCommitNote()).toBeInTheDocument();
    expect(shell.takeCommitFailure()).toBeNull();
    await user.click(commitButton());
    await waitFor(() => {
      expect(within(commitBox()).queryByRole('alert')).toBeNull();
    });
    await committed(/^Committed 14 changes/);
  });
});

describe('when committing waits', JOB_TEST, () => {
  it('says the index is being rebuilt, and the button waits', async () => {
    const { shell } = await ready({ jobStepMs: 60_000 });
    act(() => {
      shell.startJob('rebuild', longJob('rebuild'));
    });
    expect(await within(commitBox()).findByText("Folio is rebuilding its search index. You can commit when it's done.")).toBeInTheDocument();
    expect(commitButton()).toHaveAccessibleName('Commit 14 changes');
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    // Why it waits is its description, in place of a shortcut that does nothing now.
    expect(commitButton()).toHaveAccessibleDescription("Folio is rebuilding its search index. You can commit when it's done.");
    expect(commitButton()).not.toHaveTextContent('Ctrl+Enter');
    // The message button still works.
    expect(within(commitBox()).getByRole('button', { name: 'Use template' })).not.toHaveAttribute('aria-disabled');
  });

  it('says a newer Folio wrote the history', async () => {
    renderChanges({ scenario: 'history-read-only' });
    expect(await within(commitBox()).findByText('A newer version of Folio changed this library. Update Folio to commit.')).toBeInTheDocument();
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
    expect(commitButton()).toHaveAccessibleDescription('A newer version of Folio changed this library. Update Folio to commit.');
  });

  it('says a newer Folio wrote the library', async () => {
    renderChanges({ scenario: 'read-only' });
    expect(await within(commitBox()).findByText('A newer version of Folio changed this library. Update Folio to commit.')).toBeInTheDocument();
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('says Folio cannot read the history', async () => {
    renderChanges({ scenario: 'history-damaged' });
    expect(
      await within(commitBox()).findByText("Folio can't read this library's history, so you can't commit until it's fixed."),
    ).toBeInTheDocument();
    expect(commitButton()).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('the fields', JOB_TEST, () => {
  it('fill the summary with the template, which Ctrl+Z takes back once', async () => {
    const { user } = await ready();
    await user.type(summaryField(), 'Mine');
    await user.click(within(commitBox()).getByRole('button', { name: 'Use template' }));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(TEMPLATE);
    });
    // The focus stays on the button: the fill is said.
    expect(politeText()).toBe('Added the template message.');
    act(() => {
      summaryField().focus();
    });
    await user.keyboard('{Control>}z{/Control}');
    expect(summaryField()).toHaveValue('Mine');
  });

  it('say why the template did not come when the selection could not be summarized', async () => {
    const { user, shell } = await ready();
    shell.setFailure('summarize_selection', 'Internal');
    // A selection not summarized yet.
    await user.click(boxOf(getRow('CSC148/a1/run.bat')));
    await user.click(within(commitBox()).getByRole('button', { name: 'Use template' }));
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't write the template message — Something went wrong inside Folio. Restart Folio. If this keeps happening, send the error details to the developer.",
      ]);
    });
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(summaryField()).toHaveValue('');
  });

  it('stay as they were, without a word, when the changes changed while the template was asked for', async () => {
    const { user, shell, invoke } = await ready();
    shell.setFailure('summarize_selection', 'WorkspaceChanged');
    // A selection not summarized yet.
    await user.click(boxOf(getRow('CSC148/a1/run.bat')));
    const asked = callsOf(invoke, 'summarize_selection');
    await user.click(within(commitBox()).getByRole('button', { name: 'Use template' }));
    await waitFor(() => {
      expect(callsOf(invoke, 'summarize_selection')).toBeGreaterThan(asked);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    // A newer workspace is on its way: the person can ask again once it is read.
    expect(toastTexts()).toEqual([]);
    expect(summaryField()).toHaveValue('');
  });

  it('offer the template and AI settings in the options menu', async () => {
    const { user } = await ready();
    await user.click(within(commitBox()).getByRole('button', { name: 'Message options' }));
    const menu = await screen.findByRole('menu', { name: 'Message options' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Use the template', 'AI settings…']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Use the template' }));
    await waitFor(() => {
      expect(summaryField()).toHaveValue(TEMPLATE);
    });
  });

  it('keep the summary to 256 characters and one line, and the description to 16,384 characters', async () => {
    await ready();
    fireEvent.change(summaryField(), { target: { value: `${'a'.repeat(250)}\tb${'😀'.repeat(10)}` } });
    expect(summaryField()).toHaveValue(`${'a'.repeat(250)} b${'😀'.repeat(4)}`);
    fireEvent.change(descriptionField(), { target: { value: `line 1\nline\u00002\r\n\t${'x'.repeat(17_000)}` } });
    const description = (descriptionField() as HTMLTextAreaElement).value;
    expect(Array.from(description)).toHaveLength(16_384);
    // A text area's value has line feeds only.
    expect(description.startsWith('line 1\nline2\n\tx')).toBe(true);
  });
});

describe('the narrow commit bar', JOB_TEST, () => {
  beforeEach(() => {
    resizeTo(680);
  });
  afterEach(() => {
    resizeTo(1024);
  });

  it('pins the summary, the message button and the description toggle above the commit button', async () => {
    const { user, invoke } = await ready();
    const bar = commitBox();
    expect(bar).toHaveClass('commit-bar');
    const toggle = within(bar).getByRole('button', { name: 'Add a description' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(bar).getByRole('button', { name: 'Hide the description' })).toHaveAttribute('aria-expanded', 'true');
    expect(bar.querySelector('.commit-bar__description')).toHaveAttribute('data-open');

    await user.type(summaryField(), 'From the bar');
    await user.click(commitButton());
    await committed('Committed 14 changes: From the bar');
    expect(commitRequests(invoke)[0]?.summary).toBe('From the bar');
  });

  it('opens the description over the list in a short window (§4.7, 500 × 320)', async () => {
    const { user } = await ready();
    const tall = window.innerHeight;
    onTestFinished(() => {
      window.innerHeight = tall;
      window.dispatchEvent(new Event('resize'));
    });
    const description = commitBox().querySelector('.commit-bar__description');
    expect(description).not.toHaveAttribute('data-over');
    act(() => {
      window.innerWidth = 500;
      window.innerHeight = 320;
      window.dispatchEvent(new Event('resize'));
    });
    expect(description).toHaveAttribute('data-over');
    await user.click(within(commitBox()).getByRole('button', { name: 'Add a description' }));
    expect(description).toHaveAttribute('data-open');
    act(() => {
      window.innerHeight = tall;
      window.dispatchEvent(new Event('resize'));
    });
    expect(description).not.toHaveAttribute('data-over');
    expect(description).toHaveAttribute('data-open');
  });

  it('closes the description over the list once the focus moves to the list, so the focused row shows', async () => {
    const { user } = await ready();
    const tall = window.innerHeight;
    onTestFinished(() => {
      window.innerHeight = tall;
      window.dispatchEvent(new Event('resize'));
    });
    act(() => {
      window.innerWidth = 500;
      window.innerHeight = 320;
      window.dispatchEvent(new Event('resize'));
    });
    const description = commitBox().querySelector('.commit-bar__description');
    await user.click(within(commitBox()).getByRole('button', { name: 'Add a description' }));
    await user.type(descriptionField(), 'Why');
    // Within the bar it stays open.
    await user.click(summaryField());
    expect(description).toHaveAttribute('data-open');
    // The list takes the focus: the description, over its lower half, closes; its text stays.
    await user.click(getRow('CSC148/a1/run.bat'));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(description).not.toHaveAttribute('data-open');
    expect(within(commitBox()).getByRole('button', { name: 'Show the description' })).toBeInTheDocument();
    expect(descriptionField()).toHaveValue('Why');
    // In a taller window the description pushes the list up instead, and stays open.
    act(() => {
      window.innerHeight = tall;
      window.dispatchEvent(new Event('resize'));
    });
    await user.click(within(commitBox()).getByRole('button', { name: 'Show the description' }));
    await user.click(getRow('CSC148/a1/run.bat'));
    expect(description).toHaveAttribute('data-open');
  });

  it('puts a failure note between the rows', async () => {
    const { user } = await ready({ commitFailure: { code: 'InUse', file: `${CSC}/a1/run.bat` } });
    await user.click(commitButton());
    const note = await findCommitNote();
    expect(note).toHaveTextContent('Another app is using run.bat.');
    const parts = [...commitBox().children];
    expect(parts.indexOf(note)).toBeGreaterThan(parts.findIndex((part) => part.classList.contains('commit-bar__row')));
    expect(parts.indexOf(note)).toBeLessThan(parts.findIndex((part) => part.classList.contains('commit-button')));
    expect(changesList()).toBeInTheDocument();
  });
});
