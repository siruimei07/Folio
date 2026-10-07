// The changes list grouped by course (workspace-history handoff §3.5) on the fake shell: headers at
// each place's rows with check boxes from the selection's summary, toggling a place, the mixed
// state, the remembered layout, the keyboard over headers, and a long list that finds a header on
// a page that arrives late.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceItem } from '../../ipc';
import { toastTexts } from '../../test/render';
import { mockScrolling } from '../../test/virtual';
import { setListLayout, useChangesPreferences } from '../preferences';
import { useChangesView } from '../state';
import {
  boxOf,
  callsOf,
  changesList,
  commitButton,
  CSC,
  findRow,
  getRow,
  holdRequests,
  includeAll,
  itemPageOffset,
  JOB_TEST,
  JOB_WAIT,
  MAT,
  renderChanges,
  smallWorkspace,
  summarized,
} from '../test/render';
import { placeOfItem } from './grouped';

type RenderOptions = Parameters<typeof renderChanges>[0];

/** The Changes view with the list grouped by course. */
function renderGrouped(options?: RenderOptions) {
  const app = renderChanges(options);
  act(() => {
    setListLayout('grouped');
  });
  return app;
}

/** The options of a place's headers, by the start of their accessible name. */
function headers(name: string): HTMLElement[] {
  return within(changesList())
    .getAllByRole('option')
    .filter((option) => option.querySelector('.changes-place-header') !== null && option.getAttribute('aria-label')?.startsWith(name));
}

/** The option of a place's only header, by the start of its accessible name. */
function header(name: string): HTMLElement {
  const found = headers(name);
  const [only] = found;
  if (only === undefined || found.length !== 1) throw new Error(`${String(found.length)} headers named ${name}`);
  return only;
}

function names(): (string | null)[] {
  return within(changesList())
    .getAllByRole('option')
    .map((option) => option.getAttribute('aria-label'));
}

/** The keys the selection lists, by the paths the view keeps them with. */
function keptPaths(): string[] {
  return [...useChangesView.getState().inclusion.keys.values()].sort();
}

describe('grouped by course', JOB_TEST, () => {
  it('puts a header over each place, checked from the summary, and leaves the course out of its rows', async () => {
    renderGrouped();
    // The counts come with the selection's summary, after a cold first render of the list.
    await screen.findByRole('option', { name: 'CSC148 Introduction to Computer Science, 4 changes' }, JOB_WAIT);
    expect(names()).toEqual([
      'CSC148 Introduction to Computer Science, 4 changes',
      'CSC148/a1/run.bat, Added',
      'CSC148/a1/starter/test_tree.py, Added',
      'CSC148/a1/starter/tree.py, Added',
      'CSC148/labs/lab1/report.docx, Modified',
      'ECO101 微观经济学, 2 changes',
      'ECO101 微观经济学/Lecture recording week 5.mp4, Added',
      'ECO101 微观经济学/Supply and demand.png, Modified',
      'MAT232 Calculus of Several Variables, 3 changes',
      'MAT232/Exams/Midterm/Midterm review.md, Modified, tags changed too',
      'MAT232/Old slides L2.pdf, Deleted',
      'MAT232/Problem sets/ps2 solutions.md, Renamed',
      'MAT223 线性代数, 1 change',
      'MAT223/习题, Renamed, 4 files',
      'Photos, 1 change',
      expect.stringMatching(/IMG_2031\.HEIC, Added$/),
      'PHY131 Introduction to Physics I, 1 change',
      'PHY131/Kinematics.md, Renamed, 2 changes',
      'MAT232/Exams/Midterm/Midterm 2025.pdf, Tags, Modified',
      'CSC148 course settings, Modified',
      'Tag definitions, Added',
      'Ignore rules, Modified',
    ]);
    const csc = header('CSC148');
    expect(csc).toHaveAttribute('aria-checked', 'true');
    expect(csc).toHaveAttribute('aria-selected', 'false');
    expect(csc).toHaveAttribute('aria-posinset', '1');
    expect(csc).toHaveAttribute('aria-setsize', '22');
    expect(csc).toHaveAccessibleDescription('Space includes or leaves out every change in it.');
    expect(csc.querySelector('.course-badge')).toHaveTextContent('CSC');
    expect(csc.querySelector('.changes-place-header__code')).toHaveTextContent('CSC148');
    expect(csc.querySelector('.changes-place-header__name')).toHaveTextContent('Introduction to Computer Science');
    expect(csc.querySelector('.changes-place-header__count')).toHaveTextContent('4');
    // The header counts every change; when only some can be committed, its description says how many.
    expect(header('ECO101')).toHaveAccessibleDescription('1 of them can be committed now. Space includes or leaves out every change in it.');
    // Nothing in Photos can be committed yet: its box is off and does nothing.
    const photos = header('Photos');
    expect(photos).toHaveAttribute('aria-checked', 'false');
    expect(photos).toHaveAccessibleDescription('None of its changes can be committed yet.');
    expect(boxOf(photos)).toHaveAttribute('data-disabled');
    // The rows show the folders below their course; the tooltip and the name keep the whole path.
    const row = getRow('CSC148/a1/run.bat');
    expect(row.querySelector('.path-text')).toHaveTextContent(/^a1\/run\.bat$/);
    expect(row.querySelector('.path-text')).toHaveAttribute('title', 'CSC148/a1/run.bat');
    // The first change is selected, not the header above it.
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(row).toHaveAttribute('tabindex', '0');
  });

  it("says how many of a course's changes are always in the commit when the rest can't be committed yet", async () => {
    const ALWAYS_SOME = "1 of them is always in the commit. The rest can't be committed yet.";
    renderGrouped({
      fixture: smallWorkspace(
        [
          { change: 'added', path: `${CSC}/notes.md` },
          { change: 'added', path: `${MAT}/scan.pdf`, readiness: 'notLocal' },
          { change: 'modified', path: `${MAT}/week 2 notes.md`, required: true, parts: 1 },
        ],
        { metadata: false },
      ),
    });
    await waitFor(() => {
      expect(header('MAT232')).toHaveAttribute('aria-label', 'MAT232 Calculus of Several Variables, 2 changes');
    }, JOB_WAIT);
    // Nothing in it is the person's to change: on for the required change, which the blocked one is not with.
    const mat = header('MAT232');
    expect(mat).toHaveAttribute('aria-checked', 'true');
    expect(boxOf(mat)).toHaveAttribute('data-disabled');
    expect(mat).toHaveAccessibleDescription(ALWAYS_SOME);
    expect(boxOf(mat).closest('[title]')).toHaveAttribute('title', ALWAYS_SOME);
  });

  it("groups a semester's and the library's own files under their names, with a header for each run of rows", async () => {
    const { user } = renderGrouped({
      fixture: smallWorkspace(
        [
          { change: 'added', path: 'A note.md' },
          { change: 'added', path: 'Fall 2026/Calendar.pdf' },
          { change: 'modified', path: `${CSC}/notes.md` },
          { change: 'added', path: 'Fall 2026/Timetable.pdf' },
          { change: 'added', path: 'README.md' },
        ],
        { metadata: false },
      ),
    });
    await findRow('A note.md');
    // The counts come with the selection's summary.
    await waitFor(() => {
      expect(header('CSC148')).toHaveAttribute('aria-label', 'CSC148 Introduction to Computer Science, 1 change');
    }, JOB_WAIT);
    expect(names()).toEqual([
      'Library, 2 changes',
      'A note.md, Added',
      'Fall 2026, 2 changes',
      'Fall 2026/Calendar.pdf, Added',
      'CSC148 Introduction to Computer Science, 1 change',
      'CSC148/notes.md, Modified',
      'Fall 2026, 2 changes',
      'Fall 2026/Timetable.pdf, Added',
      'Library, 2 changes',
      'README.md, Added',
    ]);
    expect(getRow('Fall 2026/Calendar.pdf').querySelector('.path-text')).toHaveTextContent(/^Calendar\.pdf$/);
    // The second "Fall 2026" header leaves out the semester's own files on both sides of CSC148.
    const second = headers('Fall 2026')[1];
    if (second === undefined) throw new Error('no second Fall 2026 header');
    await user.click(boxOf(second));
    await waitFor(() => {
      expect(keptPaths()).toEqual(['Fall 2026/Calendar.pdf', 'Fall 2026/Timetable.pdf']);
    });
    expect(headers('Fall 2026').map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    expect(header('CSC148')).toHaveAttribute('aria-checked', 'true');
    expect(getRow('Fall 2026/Calendar.pdf')).toHaveAttribute('aria-checked', 'false');
  });

  it("includes or leaves out a course's changes with Space or its box, and the summary agrees", async () => {
    const { user, shell } = renderGrouped();
    const invoke = vi.spyOn(shell, 'invoke');
    await findRow('CSC148/a1/run.bat');
    const csc = header('CSC148');
    await user.click(csc);
    expect(csc).toHaveFocus();
    await user.keyboard(' ');
    const cscPaths = [`${CSC}/a1/run.bat`, `${CSC}/a1/starter/test_tree.py`, `${CSC}/a1/starter/tree.py`, `${CSC}/labs/lab1/report.docx`];
    await waitFor(() => {
      expect(keptPaths()).toEqual(cscPaths);
    });
    expect(header('CSC148')).toHaveAttribute('aria-checked', 'false');
    for (const path of ['CSC148/a1/run.bat', 'CSC148/labs/lab1/report.docx']) expect(getRow(path)).toHaveAttribute('aria-checked', 'false');
    expect(includeAll()).toBePartiallyChecked();
    // The summary of the new selection leaves the four out, and the header still says so.
    await waitFor(() => {
      const last = summarized(invoke).at(-1);
      expect(last?.kind).toBe('allExcept');
      expect(last?.keys).toHaveLength(4 + 2);
    });
    expect(header('CSC148')).toHaveAttribute('aria-checked', 'false');
    // Its box puts them back.
    await user.click(boxOf(header('CSC148')));
    await waitFor(() => {
      expect(keptPaths()).toEqual([]);
    });
    expect(header('CSC148')).toHaveAttribute('aria-checked', 'true');
    expect(header('CSC148')).toHaveFocus();
  });

  it('shows a course with some changes left out as mixed, and Space includes them all', async () => {
    const { user } = renderGrouped();
    const report = await findRow('CSC148/labs/lab1/report.docx');
    await user.click(report);
    await user.keyboard(' ');
    expect(report).toHaveAttribute('aria-checked', 'false');
    const csc = header('CSC148');
    expect(csc).toHaveAttribute('aria-checked', 'mixed');
    expect(boxOf(csc)).toHaveAttribute('data-indeterminate');
    expect(csc).toHaveAccessibleDescription('Some of its changes are included. Space includes them all.');
    expect(header('ECO101')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp} ');
    expect(csc).toHaveFocus();
    await waitFor(() => {
      expect(report).toHaveAttribute('aria-checked', 'true');
    });
    expect(csc).toHaveAttribute('aria-checked', 'true');
  });

  it('remembers the layout on this computer', async () => {
    const { user } = renderChanges();
    await findRow('CSC148/a1/run.bat');
    expect(screen.queryByText('Introduction to Computer Science')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Group by course' }));
    expect(header('CSC148')).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem('folio.changes.preferences') ?? '{}') as { state?: { layout?: string } };
    expect(stored.state?.layout).toBe('grouped');
    // Read back after a restart.
    act(() => {
      useChangesPreferences.setState({ layout: 'flat' });
    });
    localStorage.setItem('folio.changes.preferences', JSON.stringify(stored));
    await act(async () => {
      await useChangesPreferences.persist.rehydrate();
    });
    expect(useChangesPreferences.getState().layout).toBe('grouped');
  });

  it('moves over the headers with the keys, which take the focus but not the selection; type-ahead passes them by', async () => {
    const { user } = renderGrouped();
    const first = await findRow('CSC148/a1/run.bat');
    act(() => {
      first.focus();
    });
    await user.keyboard('{ArrowUp}');
    const csc = header('CSC148');
    expect(csc).toHaveFocus();
    expect(csc).toHaveAttribute('aria-selected', 'false');
    expect(within(changesList()).queryAllByRole('option', { selected: true })).toEqual([]);
    // No change is selected, so no diff shows; Enter does nothing there.
    expect(screen.queryByRole('group', { name: /run\.bat$/ })).toBeNull();
    await user.keyboard('{Enter}');
    expect(csc).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(header('ECO101')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(getRow('ECO101 微观经济学/Lecture recording')).toHaveFocus();
    expect(getRow('ECO101 微观经济学/Lecture recording')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(getRow('Ignore rules')).toHaveFocus();
    // Up from the first tag change passes "Tags and settings" by, onto PHY131's file.
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(getRow('PHY131/Kinematics.md')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(header('CSC148')).toHaveFocus();
    await user.keyboard('p');
    expect(getRow('MAT232/Problem sets/ps2 solutions.md')).toHaveFocus();
  });

  it('shows a change found from elsewhere at its row under its header', async () => {
    const { showChange } = await import('../../app/changeTarget');
    renderGrouped();
    await findRow('CSC148/a1/run.bat');
    act(() => {
      showChange('Fall 2026/MAT232 Calculus of Several Variables/Old slides L2.pdf');
    });
    await waitFor(() => {
      expect(getRow('MAT232/Old slides L2.pdf')).toHaveFocus();
    });
    expect(getRow('MAT232/Old slides L2.pdf')).toHaveAttribute('aria-selected', 'true');
  });
});

/** The rows' place on screen: where each starts in the list, less how far it is scrolled. */
function screenTop(row: Element, list: HTMLElement): number {
  const match = /translateY\(([-\d.]+)px\)/.exec((row as HTMLElement).style.transform);
  return Number(match?.[1] ?? Number.NaN) - list.scrollTop;
}

describe('grouped by course, a long list', JOB_TEST, () => {
  it('leaves out a course whose rows run past the loaded pages, its box turning at once', async () => {
    const { shell, user } = renderGrouped({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const first = await waitFor(
      () => {
        const option = list.querySelector('[data-index="0"]');
        expect(option?.getAttribute('aria-label')).toMatch(/, [\d,]+ changes$/);
        return option as HTMLElement;
      },
      { timeout: 5000 },
    );
    const items: WorkspaceItem[] = [];
    for (let offset = 0; offset < 2000; offset += 500) items.push(...shell.versioning.itemPage({ offset, limit: 500 }).items);
    const [firstItem] = items;
    if (firstItem === undefined) throw new Error('no items');
    const place = placeOfItem(firstItem).id;
    const course = items.filter((item) => placeOfItem(item).id === place);
    const changeable = course.filter((item) => !item.required && (item.readiness === 'ready' || item.readiness === 'hashing'));
    expect(course.length).toBeGreaterThan(200);
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(course.some((item) => item.required)).toBe(true);
    const before = commitButton().textContent;
    // The summary of the new selection waits, so the header is read before it comes, whatever the
    // machine's load.
    const { release } = holdRequests(shell, (command) => command === 'summarize_selection');
    await user.click(boxOf(first));
    await waitFor(
      () => {
        expect(useChangesView.getState().inclusion.keys.size).toBe(changeable.length);
      },
      { timeout: 5000 },
    );
    // Not every row is loaded and the summary is of the last selection: the header says what was set.
    expect(first).toHaveAttribute('aria-checked', 'false');
    expect(first).toHaveAttribute('aria-label', expect.stringMatching(/, [\d,]+ changes$/));
    act(() => {
      release();
    });
    // Once it comes (the commit button counts it), the header reads `selected - required` of
    // `available - required` (ipc-m2 §6.4): the course's required item, still in, leaves it off.
    await waitFor(
      () => {
        expect(commitButton().textContent).not.toBe(before);
      },
      { timeout: 5000 },
    );
    expect(first).toHaveAttribute('aria-checked', 'false');
    expect(includeAll()).toBePartiallyChecked();
  });

  it('refuses to leave out a course with more changes than a selection holds, as a whole, and says why', async () => {
    const { showChange } = await import('../../app/changeTarget');
    mockScrolling();
    const { user } = renderGrouped({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    await within(list).findAllByRole('option');
    // "Personal/Old scans": 10,658 deleted scans, all of them includable.
    act(() => {
      showChange('Personal/Old scans/Scan 00001.pdf');
    });
    const row = await waitFor(
      () => {
        const focused = document.activeElement;
        if (!(focused instanceof HTMLElement)) throw new Error('nothing has the focus');
        expect(focused.getAttribute('aria-label')).toMatch(/Scan 00001\.pdf, Deleted$/);
        return focused;
      },
      { timeout: 15_000 },
    );
    // The header of the scans' run of rows, right above the first of them.
    const scans = list.querySelector<HTMLElement>(`[data-index="${String(Number(row.dataset.index) - 1)}"]`);
    if (scans === null) throw new Error('no row above the first scan');
    await waitFor(() => {
      expect(scans).toHaveAttribute('aria-label', 'Old scans, 10,658 changes');
    }, JOB_WAIT);
    expect(scans).toHaveAttribute('aria-checked', 'true');
    const kept = useChangesView.getState().inclusion;
    await user.click(boxOf(scans));
    await waitFor(
      () => {
        expect(toastTexts()).toEqual([
          "Couldn't change those check boxes — You can leave out up to 10,000 changes one by one. To commit only a few, turn off Include all changes, then check the ones you want.",
        ]);
      },
      { timeout: 10_000 },
    );
    // None of the scans was left out, so the header stays on and the next press tries again.
    expect(useChangesView.getState().inclusion).toBe(kept);
    expect(scans).toHaveAttribute('aria-checked', 'true');
    expect(row).toHaveAttribute('aria-checked', 'true');
  });

  it('changes no box of a course whose pages come after the changes changed, and says so', async () => {
    const { shell, user } = renderGrouped({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const first = await waitFor(
      () => {
        const option = list.querySelector('[data-index="0"]');
        expect(option?.getAttribute('aria-label')).toMatch(/, [\d,]+ changes$/);
        return option as HTMLElement;
      },
      { timeout: 5000 },
    );
    // The course's pages past the first wait; meanwhile a file is added, which moves the rows, and
    // WorkspaceChanged drops the pages being read (the workspace is asked for again).
    const { invoke, release } = holdRequests(shell, (command, request) => (itemPageOffset(command, request) ?? 0) > 0);
    await user.click(boxOf(first));
    const asked = callsOf(invoke, 'get_workspace');
    act(() => {
      shell.addFile(`${CSC}/a new note.md`);
    });
    await waitFor(() => {
      expect(callsOf(invoke, 'get_workspace')).toBeGreaterThan(asked);
    });
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't change those check boxes — The list changed meanwhile, so the check boxes stay as they were. Check the list, then try again.",
      ]);
    }, JOB_WAIT);
    expect(useChangesView.getState().inclusion.keys.size).toBe(0);
  });

  it('says so when a page of a course past the loaded pages fails, and changes no box', async () => {
    const { shell, user } = renderGrouped({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    const first = await waitFor(
      () => {
        const option = list.querySelector('[data-index="0"]');
        expect(option?.getAttribute('aria-label')).toMatch(/, [\d,]+ changes$/);
        return option as HTMLElement;
      },
      { timeout: 5000 },
    );
    shell.setFailure('list_workspace_items', 'Internal');
    await user.click(boxOf(first));
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        "Couldn't change those check boxes — Something went wrong inside Folio. Restart Folio. If this keeps happening, send the error details to the developer.",
      ]);
    });
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
    expect(useChangesView.getState().inclusion.keys.size).toBe(0);
    expect(first).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the focused row in place when a page that arrives late reveals a header above it', async () => {
    mockScrolling();
    const { shell, user } = renderGrouped({ scenario: 'workspace-large' });
    const list = await screen.findByRole('listbox', { name: 'Changes' }, { timeout: 5000 });
    await within(list).findAllByRole('option');
    // The 50,000 items and the places they change between.
    const items: WorkspaceItem[] = [];
    for (let offset = 0; offset < 50_000; offset += 500) items.push(...shell.versioning.itemPage({ offset, limit: 500 }).items);
    const changesAt = (index: number) => {
      const before = items[index - 1];
      const item = items[index];
      return before !== undefined && item !== undefined && placeOfItem(before).id !== placeOfItem(item).id;
    };
    const startsIn = (from: number, to: number) => Array.from({ length: to - from }, (_, at) => from + at).filter(changesAt).length;
    // A page P with a place change well inside it, and none near the start of the page after it.
    let page = 3;
    while (page < 249 && !(startsIn(page * 200, page * 200 + 150) > 0 && startsIn((page + 1) * 200 - 30, (page + 1) * 200 + 40) === 0)) page += 1;
    expect(page).toBeLessThan(249);
    // Page 0's headers are known from the start: one at item 0, then each change on it.
    const known = 1 + startsIn(1, 200);
    // Page P waits until the test lets it go.
    const { release } = holdRequests(shell, (command, request) => itemPageOffset(command, request) === page * 200);
    // Scroll to a few rows into page P + 1: the rows there load, the end of page P does not.
    const first = (page + 1) * 200 + 4;
    act(() => {
      list.scrollTo({ top: (first + known) * 32 });
    });
    const target = first + 3;
    const row = await waitFor(
      () => {
        const found = list.querySelector(`[data-index="${String(target + known)}"]`);
        expect(found).not.toBeNull();
        expect(found).not.toHaveAttribute('aria-busy');
        return found as HTMLElement;
      },
      { timeout: 5000 },
    );
    const name = row.getAttribute('aria-label');
    await user.click(row);
    expect(row).toHaveFocus();
    const before = screenTop(row, list);
    expect(before).toBe(3 * 32);
    // Page P arrives: its headers go above the rows on screen, which stay where they are.
    act(() => {
      release();
    });
    await waitFor(
      () => {
        expect(Number(row.dataset.index)).toBeGreaterThan(target + known);
      },
      { timeout: 5000 },
    );
    expect(row).toHaveFocus();
    expect(row).toHaveAttribute('aria-label', name);
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(screenTop(row, list)).toBe(before);
  });
});
