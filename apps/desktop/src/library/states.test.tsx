// Every empty and error state of the Library view (library-actions handoff §8, §9), its banners
// (§9.1), the semester switcher (app-shell §3), what shows once another lane registers its dialog,
// the narrow window (§2, library-actions §14) and dragging rows onto a folder (§7.3).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { useNavigation } from '../app/navigation';
import { installShortcuts } from '../app/shortcuts';
import { useSession } from '../data/session';
import { useLibraryView } from './state';
import { FALL, findRow, getRow, libraryFixture, MAT, renderLibrary, toastTexts } from './test/render';

/** A job that keeps running until the test ends. */
function longJob(kind: 'scan' | 'rebuild') {
  return {
    cancellable: true,
    total: 1_000_000,
    step: 1,
    finish: () => (kind === 'scan' ? { kind, changes: 0, problems: 0 } : { kind, entries: 0 }) as never,
  };
}

describe('empty states', () => {
  it('says there are no semesters yet, and offers a new one once its dialog is registered', async () => {
    const fixture = libraryFixture(() => undefined);
    const { unmount } = renderLibrary({ fixture });
    expect(await screen.findByRole('heading', { name: 'No semesters yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New semester' })).toBeNull();
    expect(screen.getByText('Add courses to get started')).toBeInTheDocument();
    unmount();

    const { user } = renderLibrary({ fixture, dialogs: ['newSemester'] });
    await user.click(await screen.findByRole('button', { name: 'New semester' }));
    expect(useNavigation.getState().dialog).toEqual({ kind: 'newSemester', params: undefined });
  });

  it('says a semester has no courses, and offers to add them once that dialog is registered', async () => {
    const fixture = libraryFixture((builder) => builder.folder('Winter 2027', { group: { order: 1 } }));
    const { user } = renderLibrary({ fixture, dialogs: ['addCourses'] });
    expect(await screen.findByRole('heading', { name: 'No courses in Winter 2027' })).toBeInTheDocument();
    expect(screen.getByText('Or switch semesters in the menu above.')).toBeInTheDocument();
    // The quick views and the tag filter bar hide.
    expect(screen.queryByRole('group', { name: 'Filter by tag' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add courses' }));
    expect(useNavigation.getState().dialog).toMatchObject({ kind: 'addCourses', params: { semester: { path: 'Winter 2027' } } });
  });

  it('says Folio is reading the library while the first scan has found no course', async () => {
    const fixture = libraryFixture((builder) => builder.folder('Winter 2027', { group: { order: 1 } }));
    const { shell } = renderLibrary({ fixture, jobStepMs: 60_000 });
    act(() => {
      shell.startJob('scan', longJob('scan'));
    });
    expect(await screen.findByRole('heading', { name: 'Reading your library…' })).toBeInTheDocument();
  });

  it('says Folio is reading the library while the first scan has not found a semester yet', async () => {
    const { shell } = renderLibrary({ fixture: libraryFixture(() => undefined), jobStepMs: 60_000 });
    act(() => {
      shell.startJob('scan', longJob('scan'));
    });
    expect(await screen.findByRole('heading', { name: 'Reading your library…' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No semesters yet' })).toBeNull();
  });

  it('says so in the List mode when no file matches the filter', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    const bar = screen.getByRole('group', { name: 'Filter by tag' });
    await user.click(within(bar).getByRole('button', { name: 'Reference' }));
    await user.click(within(bar).getByRole('button', { name: 'Notes' }));
    await user.click(screen.getByRole('radio', { name: 'List' }));
    expect(await screen.findByRole('heading', { name: 'No files match' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('listbox', { name: 'Files in Fall 2026' })).toBeInTheDocument();
  });

  it('says a course has no files yet in the third column, with Add files once importing is registered', async () => {
    const fixture = libraryFixture((builder) => {
      builder.folder('Winter 2027/MAT237 Multivariable Calculus', { group: { order: 1, code: 'MAT237' } });
    });
    const { user } = renderLibrary({ fixture, dialogs: ['import'] });
    await user.click(await findRow('MAT237', 'Winter 2027'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    expect(within(pane).getByRole('heading', { name: 'MAT237 has no files yet' })).toBeInTheDocument();
    expect(within(pane).getByRole('heading', { level: 2 })).toHaveTextContent('MAT237Multivariable Calculus· 0 files');
    expect(within(pane).getByRole('button', { name: 'Add files' })).toBeInTheDocument();
  });

  it('says when nothing was added in the last 7 days, and when every file has a tag', async () => {
    const fixture = libraryFixture((builder) => {
      builder.folder('Fall 2026/CSC148', { group: { order: 1 } });
      builder.file('Fall 2026/CSC148/hw1.py', { added: 30, tags: ['homework'] });
    });
    const { user } = renderLibrary({ fixture });
    await user.click(await findRow('Recently added'));
    expect(await screen.findByRole('heading', { name: 'Nothing added to Fall 2026 in the last 7 days' })).toBeInTheDocument();
    await user.click(getRow('Untagged'));
    expect(await screen.findByRole('heading', { name: 'Every file in Fall 2026 has a tag' })).toBeInTheDocument();
  });

  it('shows the empty preview while nothing is selected', async () => {
    renderLibrary();
    await findRow('MAT232');
    expect(screen.getByText('Select a file to preview')).toBeInTheDocument();
    expect(screen.getByText('Or drop files here to add them to the current course')).toBeInTheDocument();
  });
});

describe('error states', () => {
  it('says the courses could not load, with Try again and Copy details', async () => {
    const { user, shell } = renderLibrary({ scenario: 'errors' });
    expect(await screen.findByRole('heading', { name: "Couldn't load your courses" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();

    shell.setFailure('list_semesters', null);
    shell.setFailure('list_courses', null);
    shell.setFailure('list_files', null);
    shell.setFailure('list_children', null);
    shell.setFailure('list_tags', null);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await findRow('MAT232')).toBeInTheDocument();
  });

  it('shows a folder whose files failed as a row that tries again, and the grid as an error', async () => {
    const { user, shell } = renderLibrary();
    await findRow('MAT232');
    shell.setFailure('list_children', 'FileSystem');
    await user.click(getRow('MAT232'));
    const failed = await findRow("Couldn't load these files");
    const pane = screen.getByRole('region', { name: 'Preview' });
    expect(await within(pane).findByRole('heading', { name: "Couldn't load MAT232" })).toBeInTheDocument();

    shell.setFailure('list_children', null);
    await user.click(failed);
    expect(await findRow('Exams')).toBeInTheDocument();
  });

  it('shows the tags that could not load as a line with Try again', async () => {
    renderLibrary({ fail: [{ command: 'list_tags', code: 'Internal' }] });
    await findRow('MAT232');
    expect(await screen.findByText("Couldn't load your tags.")).toBeInTheDocument();
  });

  it('says an item moved or went away when the shell no longer finds it', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    shell.setFailure('delete_entries', 'NotFound');
    await user.keyboard('{Delete}');
    await waitFor(() => {
      expect(toastTexts()).toContain('This item isn\'t here anymore. It may have just been moved, renamed or deleted.');
    });
  });
});

describe('banners', () => {
  it('says a read-only library can be browsed but not changed', async () => {
    renderLibrary({ scenario: 'read-only' });
    expect(await screen.findByText('Read-only for now.')).toBeInTheDocument();
  });

  it('says the index is being rebuilt while the rebuild runs', async () => {
    const { shell } = renderLibrary({ jobStepMs: 60_000 });
    await findRow('MAT232');
    act(() => {
      shell.startJob('rebuild', longJob('rebuild'));
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Rebuilding the search index. Some files may be missing from search until it finishes. Changes are paused.',
    );
  });

  it('says the index was rebuilt when the library opened, until closed', async () => {
    const fixture = libraryFixture((builder) => builder.folder('Fall 2026/CSC148', { group: { order: 1 } }), { recovered: true });
    const { user, shell } = renderLibrary({ fixture, jobStepMs: 60_000 });
    act(() => {
      shell.startJob('scan', longJob('scan'));
    });
    expect(await screen.findByText('Folio rebuilt its index for this library.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Folio rebuilt its index for this library.')).toBeNull();
  });
});

describe('the semester switcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switches semesters, with archived ones in a submenu, and asks before deleting one', async () => {
    const { user } = renderLibrary({ toolbar: true });
    await findRow('MAT232');
    await user.click(await screen.findByRole('button', { name: 'Switch semester, current Fall 2026' }));
    // React Aria names the menu after its button.
    const menu = await screen.findByRole('menu', { name: 'Switch semester, current Fall 2026' });
    expect(within(menu).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Winter 2026',
      'Fall 2026',
      'Personal',
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'Fall 2026' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Archived semesters' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Winter 2026' }));
    expect(await findRow('PHY131', 'Winter 2026')).toBeInTheDocument();
    expect(Object.values(useSession.getState().semesters)).toEqual(['Winter 2026']);

    await user.click(screen.getByRole('button', { name: 'Switch semester, current Winter 2026' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete Winter 2026…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Winter 2026?' });
    expect(within(dialog).getByText(/The semester folder and its 2 courses with 5 files go to the Recycle Bin/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('leaves nothing of the semester before selected or shown, so Delete cannot reach it', async () => {
    const { user } = renderLibrary({ toolbar: true });
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    expect(useLibraryView.getState().active).toMatchObject({ kind: 'file' });
    await user.click(screen.getByRole('button', { name: 'Switch semester, current Fall 2026' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Winter 2026' }));
    await findRow('PHY131', 'Winter 2026');
    const view = useLibraryView.getState();
    expect(view.panel.entries.size).toBe(0);
    expect(view.active).toBeNull();
    // The tree's first row takes focus and Delete has nothing to act on.
    getRow('Recently added', 'Winter 2026').focus();
    await user.keyboard('{Delete}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toastTexts()).toEqual([]);
  });
});

describe('dialogs other lanes register', () => {
  it('adds files from the header and Ctrl+O once importing is registered', async () => {
    onTestFinished(installShortcuts());
    const { user } = renderLibrary({ dialogs: ['import'] });
    await user.click(await findRow('MAT232'));
    await user.click(screen.getByRole('button', { name: 'Add files' }));
    await waitFor(() => {
      expect(useNavigation.getState().dialog).toMatchObject({ kind: 'import', params: { target: { path: MAT } } });
    });
    act(() => {
      useNavigation.setState({ dialog: null });
    });

    await user.keyboard('{Control>}o{/Control}');
    await waitFor(() => {
      expect(useNavigation.getState().dialog).toMatchObject({ kind: 'import' });
    });
  });

  it('offers neither while importing is not registered', async () => {
    renderLibrary();
    await findRow('MAT232');
    expect(screen.queryByRole('button', { name: 'Add files' })).toBeNull();
  });
});

describe('the narrow window', () => {
  afterEach(() => {
    window.innerWidth = 1024;
    window.dispatchEvent(new Event('resize'));
  });

  it('hides the tag filter bar, and a quick view covers the list until Back', async () => {
    window.innerWidth = 600;
    window.dispatchEvent(new Event('resize'));
    const { user } = renderLibrary();
    await findRow('MAT232');
    expect(screen.queryByRole('group', { name: 'Filter by tag' })).toBeNull();

    await user.click(getRow('Recently added'));
    expect(useLibraryView.getState().covered).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(useLibraryView.getState().covered).toBe(false);
  });

  it('covers the list with a file’s preview, which has Back', async () => {
    window.innerWidth = 600;
    window.dispatchEvent(new Event('resize'));
    const { user } = renderLibrary();
    await user.click(await findRow('Recently added'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const [file] = await within(pane).findAllByRole('gridcell');
    if (file === undefined) throw new Error('Recently added shows files');
    await user.click(file);
    await user.keyboard('{Enter}');
    const preview = await within(pane).findByRole('group', { name: /^Preview of / });
    expect(document.querySelector('.library-view')).toHaveAttribute('data-covered');
    await user.click(within(preview).getByRole('button', { name: 'Back' }));
    await waitFor(() => {
      expect(document.querySelector('.library-view')).not.toHaveAttribute('data-covered');
    });
  });

  it('shows the whole tree while the filter bar is hidden, and the filter again when the window widens', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    await user.click(within(screen.getByRole('group', { name: 'Filter by tag' })).getByRole('button', { name: 'Reference' }));
    await user.click(within(screen.getByRole('group', { name: 'Filter by tag' })).getByRole('button', { name: 'Notes' }));
    expect(await screen.findByRole('heading', { name: 'No files match' })).toBeInTheDocument();
    act(() => {
      window.innerWidth = 600;
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'No files match' })).toBeNull();
    });
    expect(getRow('MAT232')).toHaveAccessibleName('MAT232 Calculus of Several Variables, 27 files');
    act(() => {
      window.innerWidth = 1024;
      window.dispatchEvent(new Event('resize'));
    });
    expect(await screen.findByRole('heading', { name: 'No files match' })).toBeInTheDocument();
  });
});

describe('dragging rows', () => {
  /** jsdom has no layout, so the row under the pointer is the one a test names. */
  function pointAt(element: () => Element) {
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(element) });
  }
  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('moves the dragged file onto the folder under the pointer, which reads "Move here"', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const file = await findRow('week 2 notes.md');
    const folder = getRow('Exams');
    pointAt(() => folder);

    fireEvent.pointerDown(file, { button: 0, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 160 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 120 });
    expect(await within(folder).findByText('Move here')).toBeInTheDocument();
    expect(document.querySelector('.drag-chip')).toHaveTextContent('week 2 notes.md');

    fireEvent.pointerUp(window, { clientX: 40, clientY: 120 });
    await waitFor(() => {
      const course = shell.library.root.children.get(FALL)?.children.get('MAT232 Calculus of Several Variables');
      expect(course?.children.get('Exams')?.children.has('week 2 notes.md')).toBe(true);
    });
    expect(document.querySelector('.drag-chip')).toBeNull();
  });

  it('moves nothing when Esc cancels the drag', async () => {
    const { user, shell } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const file = await findRow('week 2 notes.md');
    pointAt(() => getRow('Exams'));
    fireEvent.pointerDown(file, { button: 0, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 120 });
    await screen.findByText('Move here');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { clientX: 40, clientY: 120 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const course = shell.library.root.children.get(FALL)?.children.get('MAT232 Calculus of Several Variables');
    expect(course?.children.has('week 2 notes.md')).toBe(true);
  });
});
