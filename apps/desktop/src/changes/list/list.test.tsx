// The changes list (workspace-history handoff §3): its rows, the check boxes and what they include,
// the keyboard and the mouse, and every state and banner, on the fake shell.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useToasts } from '../../app/toasts';
import { LIMITS } from '../../ipc';
import { toastTexts } from '../../test/render';
import { mockScrolling } from '../../test/virtual';
import { selectionOf } from '../inclusion';
import { useChangesView } from '../state';
import {
  boxOf,
  callsOf,
  changesList,
  CSC,
  findRow,
  getRow,
  holdRequests,
  includeAll,
  itemPageOffset,
  JOB_WAIT,
  longJob,
  MAT,
  politeText,
  queryRow,
  renderChanges,
  smallWorkspace,
  summarized,
} from '../test/render';

const IMG = 'Personal/Photos/IMG_2031.HEIC';
const NOT_LOCAL = 'Not downloaded yet. Folio can commit it once the file is on this computer.';
const REQUIRED = 'Always in the commit: it goes with a settings change, which every commit records.';

/** A loaded row of `list` at or after `index` whose box can change, once there is one. */
function changeableRow(list: HTMLElement, index: number): Promise<HTMLElement> {
  return waitFor(
    () => {
      const row = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) =>
          Number(option.dataset.index) >= index &&
          !option.hasAttribute('aria-busy') &&
          option.querySelector('.checkbox:not([data-disabled])') !== null,
      );
      if (row === undefined) throw new Error(`no row past ${String(index)} whose box can change yet`);
      return row;
    },
    { timeout: 5000 },
  );
}

/** The selected option's accessible name. */
function selectedName(): string | null {
  return within(changesList())
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true')
    ?.getAttribute('aria-label') ?? null;
}

describe('rows', () => {
  it('lists the items in path order, then the tag and settings changes under their header', async () => {
    renderChanges();
    await findRow('CSC148/a1/run.bat');
    const names = within(changesList())
      .getAllByRole('option')
      .map((option) => option.getAttribute('aria-label'));
    expect(names).toEqual([
      'CSC148/a1/run.bat, Added',
      'CSC148/a1/starter/test_tree.py, Added',
      'CSC148/a1/starter/tree.py, Added',
      'CSC148/labs/lab1/report.docx, Modified',
      'ECO101 微观经济学/Lecture recording week 5.mp4, Added',
      'ECO101 微观经济学/Supply and demand.png, Modified',
      'MAT232/Exams/Midterm/Midterm review.md, Modified, tags changed too',
      'MAT232/Old slides L2.pdf, Deleted',
      'MAT232/Problem sets/ps2 solutions.md, Renamed',
      'MAT223/习题, Renamed, 4 files',
      expect.stringMatching(/IMG_2031\.HEIC, Added$/),
      'PHY131/Kinematics.md, Renamed, 2 changes',
      'MAT232/Exams/Midterm/Midterm 2025.pdf, Tags, Modified',
      'CSC148 course settings, Modified',
      'Tag definitions, Added',
      'Ignore rules, Modified',
    ]);
    // The options count without the header, which only shows.
    expect(getRow('Ignore rules')).toHaveAttribute('aria-posinset', '16');
    expect(getRow('Ignore rules')).toHaveAttribute('aria-setsize', '16');
    const header = within(changesList()).getByText('Tags and settings');
    expect(header.closest('[data-index]')).toHaveAttribute('aria-hidden', 'true');
    expect(within(changesList()).getByTitle(/Tag and settings changes go into every commit/)).toHaveTextContent('Always in the commit');
  });

  it('counts the changes in the header from the workspace, with thousands separators', async () => {
    renderChanges();
    expect(screen.getByRole('img', { name: 'Counting changes' })).toHaveTextContent('…');
    expect(await screen.findByRole('img', { name: '16 changes' })).toHaveTextContent('16');
    expect(screen.getByRole('region', { name: 'Changes' })).toBeInTheDocument();
  });

  it('shows what follows the name: counts, the Tags tag and marks with their tooltips, struck-through deletions', async () => {
    renderChanges();
    expect(within(await findRow('MAT223/习题')).getByText('4 files')).toBeInTheDocument();
    expect(within(getRow('PHY131/Kinematics.md')).getByText('2 changes')).toBeInTheDocument();
    expect(within(getRow('MAT232/Exams/Midterm/Midterm 2025.pdf')).getByText('Tags')).toBeInTheDocument();
    expect(within(getRow('MAT232/Exams/Midterm/Midterm review.md')).getByTitle('Its tags changed too')).toBeInTheDocument();
    expect(getRow('ECO101 微观经济学/Lecture recording').querySelector('[data-mark="unreadable"]')).toHaveAttribute(
      'title',
      "Folio couldn't read it. Close it in other apps, then try again.",
    );
    expect(getRow('MAT232/Old slides L2.pdf').querySelector('.change-row')).toHaveAttribute('data-deleted');
    expect(within(getRow('MAT232/Old slides L2.pdf')).getByRole('img', { name: 'Deleted' })).toBeInTheDocument();
  });

  it('names each row by its whole path, which its tooltip shows too, however narrow the row', async () => {
    renderChanges();
    const row = await findRow('MAT232/Problem sets/ps2 solutions.md');
    expect(row.querySelector('.path-text')).toHaveAttribute('title', 'MAT232/Problem sets/ps2 solutions.md');
    // The course code stays whole apart from the folders, which the ellipsis cuts first.
    expect(row.querySelector('.path-heading__label')).toHaveTextContent('MAT232/');
    expect(row.querySelector('.path-heading__path')).toHaveTextContent('Problem sets/');
  });

  it('selects the first row on load, and the selection follows the keyboard focus', async () => {
    const { user } = renderChanges();
    const first = await findRow('CSC148/a1/run.bat');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveAttribute('tabindex', '0');
    expect(first.querySelector('.selection-indicator')).not.toBeNull();
    act(() => {
      first.focus();
    });
    await user.keyboard('{ArrowDown}');
    expect(getRow('CSC148/a1/starter/test_tree.py')).toHaveFocus();
    expect(selectedName()).toBe('CSC148/a1/starter/test_tree.py, Added');
    await user.keyboard('{End}');
    expect(selectedName()).toBe('Ignore rules, Modified');
    // Up from the first tag change passes the header by.
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(selectedName()).toBe('PHY131/Kinematics.md, Renamed, 2 changes');
    await user.keyboard('{Home}');
    // Type-ahead by the file's name, not its path.
    await user.keyboard('su');
    expect(selectedName()).toBe('ECO101 微观经济学/Supply and demand.png, Modified');
  });

  it('moves the selection to the next row when its item goes', async () => {
    const { user, shell } = renderChanges();
    await user.click(await findRow('CSC148/a1/starter/tree.py'));
    expect(selectedName()).toBe('CSC148/a1/starter/tree.py, Added');
    act(() => {
      shell.deleteFile(`${CSC}/a1/starter/tree.py`);
    });
    await waitFor(() => {
      expect(queryRow('CSC148/a1/starter/tree.py')).toBeNull();
    });
    expect(selectedName()).toBe('CSC148/labs/lab1/report.docx, Modified');
    // And stays with it when other rows come and go.
    act(() => {
      shell.addFile(`${CSC}/a1/starter/zeta.py`);
    });
    await findRow('CSC148/a1/starter/zeta.py');
    expect(selectedName()).toBe('CSC148/labs/lab1/report.docx, Modified');
  });
});

describe('inclusion', () => {
  it('includes every change at first; Space leaves the focused one out and back in', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    expect(report).toHaveAttribute('aria-checked', 'true');
    expect(includeAll()).toBeChecked();
    await user.click(report);
    await user.keyboard(' ');
    expect(report).toHaveAttribute('aria-checked', 'false');
    expect(includeAll()).toBePartiallyChecked();
    expect(useChangesView.getState().selection).toEqual({ kind: 'allExcept', keys: [expect.stringContaining('report.docx'), expect.anything(), expect.anything()] });
    await user.keyboard(' ');
    expect(report).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => {
      expect(includeAll()).toBeChecked();
    });
  });

  it('includes every change with Ctrl+A, and leaves them all out with it again, without loading a page', async () => {
    const { user, shell } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const [first] = await within(list).findAllByRole('option');
    if (first === undefined) throw new Error('no rows');
    expect(screen.getByRole('img', { name: /^50,\d{3} changes$/ })).toHaveTextContent(/^50,\d{3}$/);
    const invoke = vi.spyOn(shell, 'invoke');
    await user.click(first);
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => {
      expect(summarized(invoke).at(-1)).toEqual({ kind: 'only', keys: [] });
    });
    expect(first).toHaveAttribute('aria-checked', 'false');
    expect(includeAll()).not.toBeChecked();
    expect(includeAll()).not.toBePartiallyChecked();
    await user.keyboard('{Control>}a{/Control}');
    // The summary of "every item except" under this fingerprint is cached from the start.
    expect(useChangesView.getState().selection.kind).toBe('allExcept');
    expect(first).toHaveAttribute('aria-checked', 'true');
    // "Every item except" the blocked ones the list showed: no page of the 50,000 was asked for.
    expect(callsOf(invoke, 'list_workspace_items')).toBe(0);
    await waitFor(() => {
      expect(includeAll()).toBeChecked();
    });
  });

  it('includes every change with Ctrl+A when some are left out', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    await user.click(report);
    await user.keyboard(' ');
    await waitFor(() => {
      expect(includeAll()).toBePartiallyChecked();
    });
    await user.keyboard('{Control>}a{/Control}');
    expect(report).toHaveAttribute('aria-checked', 'true');
    expect(useChangesView.getState().selection.kind).toBe('allExcept');
    await waitFor(() => {
      expect(includeAll()).toBeChecked();
    });
  });

  it('reads the header from the summary of boxes that come back to a selection summarized before, so Ctrl+A turns it over', async () => {
    const { user } = renderChanges({
      fixture: smallWorkspace(
        [
          { change: 'modified', path: `${CSC}/a.md` },
          { change: 'modified', path: `${CSC}/b.md` },
        ],
        { metadata: false },
      ),
    });
    await user.click(await findRow('CSC148/a.md'));
    await user.keyboard('{Control>}a{/Control}');
    expect(useChangesView.getState().selection).toEqual({ kind: 'only', keys: [] });
    await user.keyboard(' ');
    await waitFor(() => {
      expect(includeAll()).toBePartiallyChecked();
    });
    await user.keyboard('{ArrowDown} ');
    await waitFor(() => {
      expect(includeAll()).toBeChecked();
    });
    // Off and on again: the same keys as a moment ago, whose summary is cached.
    await user.keyboard(' ');
    await waitFor(() => {
      expect(includeAll()).toBePartiallyChecked();
    });
    await user.keyboard(' ');
    expect(getRow('CSC148/a.md')).toHaveAttribute('aria-checked', 'true');
    expect(getRow('CSC148/b.md')).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => {
      expect(includeAll()).toBeChecked();
    });
    // Every change is in: Ctrl+A leaves them all out (§3.6).
    await user.keyboard('{Control>}a{/Control}');
    expect(useChangesView.getState().selection).toEqual({ kind: 'only', keys: [] });
    expect(includeAll()).not.toBeChecked();
  });

  it('toggles a box with a click without moving the selection; a click elsewhere selects the row', async () => {
    const { user } = renderChanges();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    await user.click(boxOf(report));
    expect(report).toHaveAttribute('aria-checked', 'false');
    expect(report).toHaveAttribute('aria-selected', 'false');
    expect(selectedName()).toBe('CSC148/a1/run.bat, Added');
    await user.click(report);
    expect(report).toHaveAttribute('aria-selected', 'true');
    expect(report).toHaveAttribute('aria-checked', 'false');
  });

  it('turns a Shift+click range of boxes to the state of the box clicked, passing blocked rows by', async () => {
    const { user } = renderChanges();
    const tree = await findRow('CSC148/a1/starter/tree.py');
    await user.click(boxOf(tree));
    expect(tree).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{Shift>}');
    await user.click(boxOf(getRow('ECO101 微观经济学/Supply and demand.png')));
    await user.keyboard('{/Shift}');
    for (const path of ['CSC148/a1/starter/tree.py', 'CSC148/labs/lab1/report.docx', 'ECO101 微观经济学/Supply and demand.png']) {
      expect(getRow(path)).toHaveAttribute('aria-checked', 'false');
    }
    expect(getRow('CSC148/a1/starter/test_tree.py')).toHaveAttribute('aria-checked', 'true');
    expect(getRow('MAT232/Exams/Midterm/Midterm review.md')).toHaveAttribute('aria-checked', 'true');
    // Back on, from the last box clicked up to a box that is off.
    await user.keyboard('{Shift>}');
    await user.click(boxOf(getRow('CSC148/a1/starter/tree.py')));
    await user.keyboard('{/Shift}');
    for (const path of ['CSC148/a1/starter/tree.py', 'CSC148/labs/lab1/report.docx', 'ECO101 微观经济学/Supply and demand.png']) {
      expect(getRow(path)).toHaveAttribute('aria-checked', 'true');
    }
    // The unreadable recording in the range stays off.
    expect(getRow('ECO101 微观经济学/Lecture recording')).toHaveAttribute('aria-checked', 'false');
  });

  it('says so when a page of a Shift+click range fails, and changes no box', async () => {
    mockScrolling();
    const { shell, user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const anchor = await changeableRow(list, 0);
    await user.click(boxOf(anchor));
    expect(useChangesView.getState().inclusion.keys.size).toBe(1);
    // Far down the list: the pages between are not loaded.
    act(() => {
      list.scrollTo({ top: 5000 * 32 });
    });
    const target = await changeableRow(list, 5000);
    shell.setFailure('list_workspace_items', 'Internal');
    await user.keyboard('{Shift>}');
    await user.click(boxOf(target));
    await user.keyboard('{/Shift}');
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't change those check boxes — Something went wrong inside Folio. Restart Folio. If this keeps happening, send the error details to the developer.",
      ]);
    });
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(useChangesView.getState().inclusion.keys.size).toBe(1);
    expect(target).toHaveAttribute('aria-checked', 'true');
  });

  it('refuses a Shift+click range that would leave out more changes than a selection holds, and says why', async () => {
    mockScrolling();
    const { user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const anchor = await changeableRow(list, 0);
    await user.click(boxOf(anchor));
    const kept = useChangesView.getState().inclusion;
    expect(kept.keys.size).toBe(1);
    // 10,500 rows down: leaving them all out would name more than LIMITS.batch (10,000) keys.
    act(() => {
      list.scrollTo({ top: 10_500 * 32 });
    });
    const target = await changeableRow(list, 10_500);
    await user.keyboard('{Shift>}');
    await user.click(boxOf(target));
    await user.keyboard('{/Shift}');
    await waitFor(
      () => {
        expect(toastTexts()).toEqual([
          "Couldn't change those check boxes — You can leave out up to 10,000 changes one by one. To commit only a few, turn off Include all changes, then check the ones you want.",
        ]);
      },
      { timeout: 5000 },
    );
    // Nothing changed, not even part of the range.
    expect(useChangesView.getState().inclusion).toBe(kept);
    expect(target).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps blocked rows off with their box disabled, also once they can be committed, until checked', async () => {
    const { user, shell } = renderChanges();
    const img = await findRow('Photos/IMG_2031.HEIC');
    expect(img).toHaveAttribute('aria-checked', 'false');
    expect(img).toHaveAccessibleDescription(NOT_LOCAL);
    expect(boxOf(img)).toHaveAttribute('data-disabled');
    expect(img.querySelector('[data-mark="notLocal"]')).toHaveAttribute('title', NOT_LOCAL);
    expect(boxOf(img).closest('[title]')).toHaveAttribute('title', NOT_LOCAL);
    await user.click(boxOf(img));
    await user.click(img);
    await user.keyboard(' ');
    expect(img).toHaveAttribute('aria-checked', 'false');
    // It finishes downloading: includable now, and still left out.
    act(() => {
      shell.downloadFile(IMG);
    });
    await waitFor(() => {
      expect(getRow('Photos/IMG_2031.HEIC')).not.toHaveAccessibleDescription(NOT_LOCAL);
    });
    const ready = getRow('Photos/IMG_2031.HEIC');
    expect(ready).toHaveAttribute('aria-checked', 'false');
    expect(boxOf(ready)).not.toHaveAttribute('data-disabled');
    expect(useChangesView.getState().selection.keys).toContainEqual(expect.stringContaining('IMG_2031'));
    // Not every includable change is in now.
    await waitFor(() => {
      expect(includeAll()).toBePartiallyChecked();
    });
    await user.keyboard(' ');
    expect(ready).toHaveAttribute('aria-checked', 'true');
    expect(useChangesView.getState().selection.keys).not.toContainEqual(expect.stringContaining('IMG_2031'));
    await user.keyboard(' ');
    expect(ready).toHaveAttribute('aria-checked', 'false');
    // Select-all includes it with the rest; the recording, still unreadable, stays off.
    await user.click(includeAll());
    expect(ready).toHaveAttribute('aria-checked', 'true');
    expect(getRow('ECO101 微观经济学/Lecture recording')).toHaveAttribute('aria-checked', 'false');
    expect(useChangesView.getState().selection).toEqual({ kind: 'allExcept', keys: [expect.stringContaining('Lecture recording')] });
  });

  it('changes no box when the changes change while a Shift+click range reads its pages, and says so', async () => {
    mockScrolling();
    const { shell, user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, JOB_WAIT);
    const anchor = await changeableRow(list, 0);
    await user.click(boxOf(anchor));
    const kept = [...useChangesView.getState().inclusion.keys.keys()];
    act(() => {
      list.scrollTo({ top: 5000 * 32 });
    });
    const target = await changeableRow(list, 5000);
    // The pages between wait; meanwhile a file is added above them, which moves the rows.
    const { release } = holdRequests(shell, (command, request) => (itemPageOffset(command, request) ?? 0) > 0);
    await user.keyboard('{Shift>}');
    await user.click(boxOf(target));
    await user.keyboard('{/Shift}');
    act(() => {
      shell.addFile(`${CSC}/a1/a new note.md`);
    });
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't change those check boxes — The list changed meanwhile, so the check boxes stay as they were. Check the list, then try again.",
      ]);
    }, JOB_WAIT);
    // Not one box of the range changed.
    expect([...useChangesView.getState().inclusion.keys.keys()]).toEqual(kept);
    expect(target).toHaveAttribute('aria-checked', 'true');
  });

  it('words a refused Shift+click range for the boxes as they were when it was clicked', async () => {
    mockScrolling();
    const { shell, user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, JOB_WAIT);
    await user.click(boxOf(await changeableRow(list, 0)));
    act(() => {
      list.scrollTo({ top: 10_500 * 32 });
    });
    const target = await changeableRow(list, 10_500);
    // Leaving out 10,500 changes passes the limit; while the pages load, the person leaves all out.
    const { release } = holdRequests(shell, (command, request) => (itemPageOffset(command, request) ?? 0) > 0);
    await user.keyboard('{Shift>}');
    await user.click(boxOf(target));
    await user.keyboard('{/Shift}');
    await user.click(includeAll());
    await user.click(includeAll());
    expect(useChangesView.getState().inclusion.mode).toBe('only');
    act(() => {
      release();
    });
    await waitFor(
      () => {
        expect(toastTexts()).toEqual([
          "Couldn't change those check boxes — You can leave out up to 10,000 changes one by one. To commit only a few, turn off Include all changes, then check the ones you want.",
        ]);
      },
      { timeout: 10_000 },
    );
    expect(useChangesView.getState().selection).toEqual({ kind: 'only', keys: [] });
  });

  it('says a single box that would pass the limit is the most a selection holds, leaving out or picking', async () => {
    const { shell, user } = renderChanges({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, JOB_WAIT);
    const row = await changeableRow(list, 0);
    // 10,000 changes further down are kept already, as many keys as a selection holds.
    const far = shell.versioning.items
      .filter((each) => !each.required && (each.readiness === 'ready' || each.readiness === 'hashing'))
      .slice(1000, 1000 + LIMITS.batch);
    const keep = (mode: 'allExcept' | 'only') => {
      act(() => {
        const inclusion = { mode, keys: new Map(far.map((each) => [each.key, each.path])), blocked: useChangesView.getState().inclusion.blocked };
        useChangesView.setState({ inclusion, selection: selectionOf(inclusion) });
      });
    };
    keep('allExcept');
    await user.click(row);
    await user.keyboard(' ');
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "That's the most you can leave out — You can leave out up to 10,000 changes one by one. To commit only a few, turn off Include all changes, then check the ones you want.",
      ]);
    });
    expect(row).toHaveAttribute('aria-checked', 'true');
    // Picking: the row's menu item, with 10,000 changes checked after leaving all out.
    act(() => {
      useToasts.setState({ toasts: [] });
    });
    keep('only');
    expect(row).toHaveAttribute('aria-checked', 'false');
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.click(screen.getByRole('menuitem', { name: /^Include in this commit/ }));
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "That's the most you can pick — You can pick up to 10,000 changes one by one. To commit most of them, turn on Include all changes, then leave out the ones you don't want.",
      ]);
    });
    expect(row).toHaveAttribute('aria-checked', 'false');
  });

  it('takes a change checked after leaving all out out of the selection when it shows not downloaded, and keeps it off once it is', async () => {
    const { user, shell } = renderChanges();
    const invoke = vi.spyOn(shell, 'invoke');
    const report = await findRow('CSC148/labs/lab1/report.docx');
    await user.click(report);
    await user.keyboard('{Control>}a{/Control} ');
    expect(report).toHaveAttribute('aria-checked', 'true');
    expect(useChangesView.getState().selection).toEqual({ kind: 'only', keys: [expect.stringContaining('report.docx')] });
    // Windows takes the file off this computer (cloud storage): the list shows it not downloaded.
    const item = shell.versioning.items.find((each) => each.path === `${CSC}/labs/lab1/report.docx`);
    if (item === undefined) throw new Error('no item for report.docx');
    act(() => {
      item.readiness = 'notLocal';
      shell.downloadFile(IMG);
    });
    await waitFor(() => {
      expect(getRow('CSC148/labs/lab1/report.docx')).toHaveAccessibleDescription(NOT_LOCAL);
    });
    expect(getRow('CSC148/labs/lab1/report.docx')).toHaveAttribute('aria-checked', 'false');
    // The selection names it no more, so the summary and a commit agree with its row.
    expect(useChangesView.getState().selection).toEqual({ kind: 'only', keys: [] });
    await waitFor(() => {
      expect(summarized(invoke).at(-1)).toEqual({ kind: 'only', keys: [] });
    });
    // Downloaded again, it stays off until it is checked.
    act(() => {
      shell.downloadFile(`${CSC}/labs/lab1/report.docx`);
    });
    await waitFor(() => {
      expect(getRow('CSC148/labs/lab1/report.docx')).not.toHaveAccessibleDescription(NOT_LOCAL);
    });
    expect(getRow('CSC148/labs/lab1/report.docx')).toHaveAttribute('aria-checked', 'false');
    expect(useChangesView.getState().selection).toEqual({ kind: 'only', keys: [] });
  });

  it('keeps a required change on with its box disabled, and says why', async () => {
    const { user } = renderChanges({
      fixture: smallWorkspace([
        { change: 'added', path: `${CSC}/notes.md` },
        { change: 'modified', path: `${MAT}/week 2 notes.md`, required: true, parts: 1 },
      ]),
    });
    const required = await findRow('MAT232/week 2 notes.md');
    expect(required).toHaveAttribute('aria-checked', 'true');
    expect(required).toHaveAccessibleDescription(REQUIRED);
    expect(boxOf(required)).toHaveAttribute('data-disabled');
    expect(boxOf(required).closest('[title]')).toHaveAttribute('title', REQUIRED);
    await user.click(required);
    await user.keyboard(' ');
    expect(required).toHaveAttribute('aria-checked', 'true');
    // Leaving everything out leaves it in.
    await user.keyboard('{Control>}a{/Control}');
    expect(getRow('CSC148/notes.md')).toHaveAttribute('aria-checked', 'false');
    expect(required).toHaveAttribute('aria-checked', 'true');
    expect(includeAll()).not.toBeChecked();
  });

  it('gives tag and settings changes no box: Space does nothing, and each says it is in every commit, waiting for its file', async () => {
    const { user } = renderChanges();
    const definitions = await findRow('Tag definitions');
    expect(definitions).not.toHaveAttribute('aria-checked');
    expect(definitions.querySelector('.checkbox')).toBeNull();
    // The header's tooltip says the rule to the mouse alone (the header is no option): each row says it all.
    expect(definitions).toHaveAccessibleDescription(
      'Tags and settings: in every commit, but a change that belongs to a file you leave out waits for that file.',
    );
    const before = useChangesView.getState().inclusion;
    await user.click(definitions);
    await user.keyboard(' ');
    expect(useChangesView.getState().inclusion).toBe(before);
    expect(definitions).toHaveAttribute('aria-selected', 'true');
  });
});

describe('states', () => {
  it('shows skeleton rows only once the changes take longer than 150 ms', async () => {
    renderChanges({ latencyMs: 600 });
    // The list's own skeleton: the selected row's diff, as slow, shows one too once the rows came.
    const panel = screen.getByRole('region', { name: 'Changes' });
    expect(within(panel).queryByRole('status', { name: 'Loading…' })).toBeNull();
    // Waited for, not slept on: under a loaded run the timers come late.
    expect(await within(panel).findByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    expect(await findRow('CSC148/a1/run.bat')).toBeInTheDocument();
    expect(within(panel).queryByRole('status', { name: 'Loading…' })).toBeNull();
  });

  it('says when nothing has changed, with the desk illustration where the diff goes', async () => {
    renderChanges({ fixture: smallWorkspace([], { metadata: false }) });
    expect(await screen.findByRole('heading', { name: 'No changes' })).toBeInTheDocument();
    expect(screen.getByText('Everything is committed. When you add, edit, move or delete files, the changes show up here.')).toBeInTheDocument();
    expect(screen.getByText('Nothing has changed since your last commit')).toBeInTheDocument();
    expect(document.querySelector('.desk-illustration')).not.toBeNull();
    expect(includeAll()).toBeDisabled();
    expect(screen.getByRole('img', { name: '0 changes' })).toBeInTheDocument();
  });

  it('says the changes could not load, with Try again and the details to copy for Transport', async () => {
    const { user, shell, client } = renderChanges();
    await findRow('CSC148/a1/run.bat');
    const invoke = shell.invoke.bind(shell);
    // The real shell refuses the planned workspace commands: the call never reaches a handler.
    shell.invoke = (command, payload) =>
      command === 'list_workspace_items' ? Promise.reject(new Error('list_workspace_items not allowed')) : invoke(command, payload);
    act(() => {
      void client.resetQueries();
    });
    expect(await screen.findByRole('heading', { name: "Couldn't load your changes" })).toBeInTheDocument();
    expect(screen.getByText("This window can't reach the rest of Folio. Restart Folio.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy details' }));
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain('Transport');
    });
    shell.invoke = invoke;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findRow('CSC148/a1/run.bat')).toBeInTheDocument();
  });

  it('keeps the focus on Try again while the changes load again, says when they fail again, then hands it to the rows', async () => {
    const { user, shell } = renderChanges({ fail: [{ command: 'list_workspace_items', code: 'Internal' }] });
    const panel = screen.getByRole('region', { name: 'Changes' });
    const tryAgain = await within(panel).findByRole('button', { name: 'Try again' }, JOB_WAIT);
    act(() => {
      tryAgain.focus();
    });
    // The read waits, past the skeleton's 150 ms: the failure and its button stay, with the focus.
    const { release } = holdRequests(shell, (command) => command === 'list_workspace_items');
    await user.keyboard('{Enter}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(tryAgain).toHaveFocus();
    expect(within(panel).queryByRole('status', { name: 'Loading…' })).toBeNull();
    // It fails again: nothing on screen changes, so the failure is read out again.
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't load your changes");
    });
    expect(tryAgain).toHaveFocus();
    // Then it works: the rows come, and the selected one takes the focus the button had.
    shell.setFailure('list_workspace_items', null);
    await user.keyboard('{Enter}');
    const row = await findRow('CSC148/a1/run.bat');
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
  });

  it('keeps the focus on Try again when a page further down fails, says when it fails again, then hands it to the selected row', async () => {
    mockScrolling();
    const { user, shell } = renderChanges({ scenario: 'workspace-large' });
    const panel = screen.getByRole('region', { name: 'Changes' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, JOB_WAIT);
    await within(list).findAllByRole('option');
    // The first page came; the one of rows 400 to 599 fails when the list scrolls to it.
    shell.setFailure('list_workspace_items', 'Internal');
    act(() => {
      list.scrollTo({ top: 500 * 32 });
    });
    const tryAgain = await within(panel).findByRole('button', { name: 'Try again' }, JOB_WAIT);
    act(() => {
      tryAgain.focus();
    });
    // That page is read again while the first stays loaded: the failure and its button stay, with
    // the focus, and no row comes back meanwhile.
    const { release } = holdRequests(shell, (command) => command === 'list_workspace_items');
    await user.keyboard('{Enter}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(tryAgain).toHaveFocus();
    expect(screen.queryByRole('listbox', { name: 'Changes' })).toBeNull();
    expect(politeText()).toBe('');
    // It fails again: nothing on screen changes, so the failure is read out again.
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't load your changes");
    });
    expect(tryAgain).toHaveFocus();
    // Then it works: the rows come back, and the selected one takes the focus the button had.
    shell.setFailure('list_workspace_items', null);
    await user.keyboard('{Enter}');
    const rows = await screen.findByRole('listbox', { name: 'Changes' }, JOB_WAIT);
    const selected = useChangesView.getState().focus?.index ?? 0;
    await waitFor(() => {
      expect(rows.querySelector(`[data-index="${String(selected)}"]`)).toHaveFocus();
    });
  });

  it('keeps the focus on Try again when the workspace and its items both failed, as on the real shell today', async () => {
    const { user, shell } = renderChanges({
      fail: [
        { command: 'get_workspace', code: 'Internal' },
        { command: 'list_workspace_items', code: 'Internal' },
      ],
    });
    const panel = screen.getByRole('region', { name: 'Changes' });
    const tryAgain = await within(panel).findByRole('button', { name: 'Try again' }, JOB_WAIT);
    act(() => {
      tryAgain.focus();
    });
    // The reads go back to pending one at a time: the failure stays while either is still out.
    const { release } = holdRequests(shell, (command) => command === 'get_workspace' || command === 'list_workspace_items');
    await user.keyboard('{Enter}');
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(tryAgain).toHaveFocus();
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(politeText()).toBe("Couldn't load your changes");
    });
    expect(tryAgain).toHaveFocus();
  });

  it('gives way to the first commit before the history has started', async () => {
    renderChanges({ scenario: 'history-none' });
    const block = await screen.findByRole('heading', { name: 'Starting your history' });
    // The view's one panel holds the block, in place of the list and its header.
    expect(screen.getByRole('region', { name: 'Changes' })).toContainElement(block);
    expect(screen.queryByRole('listbox', { name: 'Changes' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Include all changes' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Commit' })).toBeNull();
  });
});

describe('banners', () => {
  it('says the library is still being checked while the scan runs', async () => {
    const { shell } = renderChanges({ jobStepMs: 60_000 });
    await findRow('CSC148/a1/run.bat');
    act(() => {
      shell.startJob('scan', longJob('scan'));
    });
    expect(await screen.findByText('Still checking your library.')).toBeInTheDocument();
    expect(screen.getByText('More changes may show up.')).toBeInTheDocument();
  });

  it('says the index is being rebuilt, as news', async () => {
    const { shell } = renderChanges({ jobStepMs: 60_000 });
    await findRow('CSC148/a1/run.bat');
    act(() => {
      shell.startJob('rebuild', longJob('rebuild'));
    });
    expect(await screen.findByRole('status')).toHaveTextContent("Rebuilding the search index. You can commit when it's done.");
  });

  it('says a newer Folio wrote the history', async () => {
    renderChanges({ scenario: 'history-read-only' });
    expect(await screen.findByText('History is read-only.')).toBeInTheDocument();
    expect(screen.getByText('A newer version of Folio changed it. Update Folio to commit.')).toBeInTheDocument();
    expect(await findRow('CSC148/a1/run.bat')).toBeInTheDocument();
  });

  it('says Folio cannot read the history, without calling the empty list committed', async () => {
    renderChanges({ scenario: 'history-damaged' });
    expect(await screen.findByText("Folio can't read this library's history.")).toBeInTheDocument();
    expect(screen.getByText("Your files are fine, but you can't commit until it's fixed.")).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No changes' })).toBeNull();
  });
});

describe('another library', () => {
  it('starts afresh: every change included, the first row selected', async () => {
    const { user } = renderChanges();
    await user.click(boxOf(await findRow('CSC148/labs/lab1/report.docx')));
    expect(useChangesView.getState().inclusion.keys.size).toBe(1);
    const { publishReferences } = await import('../../data/references');
    act(() => {
      publishReferences({ kind: 'reset' });
    });
    expect(useChangesView.getState().inclusion.keys.size).toBe(0);
    expect(useChangesView.getState().focus).toBeNull();
  });
});
