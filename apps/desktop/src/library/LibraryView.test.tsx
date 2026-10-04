// The Library view against the fake shell (app-shell handoff §5; UI architecture §8.2): the tree
// with quick views, courses and loose files, its keyboard pattern and selection, the third column,
// the quick views, the List mode and the tag filter.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { nameOf } from '../lib/paths';
import { usePreferences } from './preferences';
import { useLibraryView } from './state';
import { FALL, findRow, getRow, libraryFixture, MAT, queryRow, renderLibrary, rowNames, smallLibraryWith, tree } from './test/render';

describe('the tree', () => {
  it('lists the quick views, then the courses of the current semester in their order', async () => {
    renderLibrary();
    await findRow('MAT232');
    expect(rowNames()).toEqual([
      'Recently added, 7 files',
      'Untagged, 10 files',
      'MAT232 Calculus of Several Variables, 27 files',
      'MAT223 线性代数, 7 files',
      'CSC148 Introduction to Computer Science, 14 files',
      'ECO101 微观经济学, 4 files',
    ]);
    const course = getRow('MAT232');
    expect(course).toHaveAttribute('aria-level', '1');
    expect(course).toHaveAttribute('aria-posinset', '3');
    expect(course).toHaveAttribute('aria-setsize', '6');
    expect(course).toHaveAttribute('aria-expanded', 'false');
    // The code shows once, before the name without it (26C).
    expect(within(course).getByText('Calculus of Several Variables')).toBeInTheDocument();
  });

  it('puts a semester\'s loose files after its courses, under a separator', async () => {
    renderLibrary({ fixture: smallLibraryWith({ path: `${FALL}/Syllabus.pdf` }) });
    await findRow('Syllabus.pdf');
    expect(rowNames().at(-1)).toBe('Syllabus.pdf');
    expect(getRow('Syllabus.pdf')).toHaveAttribute('aria-level', '1');
    expect(getRow('Syllabus.pdf')).toHaveAttribute('aria-posinset', '7');
  });

  it('expands a course on a click, selects it and shows its files in the third column', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));

    expect(getRow('MAT232')).toHaveAttribute('aria-expanded', 'true');
    expect(getRow('MAT232')).toHaveAttribute('aria-selected', 'true');
    expect(await findRow('Exams')).toHaveAttribute('aria-level', '2');
    expect(rowNames().slice(3, 8)).toEqual([
      'Exams',
      'Lectures, tags Slides',
      'Problem sets, tags Homework',
      'week 2 notes.md, tags Notes',
      '第3章 偏导数.md, tags Notes',
    ]);
    const pane = screen.getByRole('region', { name: 'Preview' });
    expect(within(pane).getByRole('heading')).toHaveTextContent('MAT232Calculus of Several Variables· 27 files');
    expect(await within(pane).findByRole('grid', { name: 'Files in MAT232' })).toBeInTheDocument();

    await user.click(getRow('MAT232'));
    expect(getRow('MAT232')).toHaveAttribute('aria-expanded', 'false');
    expect(queryRow('Exams')).toBeNull();
  });

  it('shows "Empty" in an expanded folder with nothing in it', async () => {
    const { user } = renderLibrary({ fixture: smallLibraryWith({ path: `${MAT}/Old`, kind: 'folder', size: '0' }) });
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Old'));
    expect(await within(tree()).findByRole('treeitem', { name: 'Empty' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('follows the tree pattern on the keyboard', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    // The first row holds the tab stop.
    expect(getRow('Recently added')).toHaveAttribute('tabindex', '0');
    act(() => {
      getRow('Recently added').focus();
    });

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(getRow('MAT232')).toHaveFocus();
    expect(getRow('MAT232')).toHaveAttribute('aria-selected', 'true');

    // Right expands, then enters; Left goes to the parent, then collapses.
    await user.keyboard('{ArrowRight}');
    expect(await findRow('Exams')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(getRow('Exams')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(getRow('MAT232')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(queryRow('Exams')).toBeNull();

    await user.keyboard('{End}');
    expect(getRow('ECO101')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(getRow('Recently added')).toHaveFocus();

    // Type-ahead by name: "c" finds CSC148.
    await user.keyboard('c');
    expect(getRow('CSC148')).toHaveFocus();

    // Enter shows the focused row in the third column without toggling it.
    await user.keyboard('{Enter}');
    expect(getRow('CSC148')).toHaveAttribute('aria-expanded', 'false');
    expect(within(screen.getByRole('region', { name: 'Preview' })).getByRole('heading')).toHaveTextContent('CSC148');
  });

  it('ignores type-ahead while an IME composes', async () => {
    renderLibrary();
    const row = await findRow('Recently added');
    row.focus();
    fireEvent.keyDown(row, { key: 'c', isComposing: true });
    expect(row).toHaveFocus();
  });

  it('selects several rows with Ctrl and Shift', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Exams'));
    await user.keyboard('{Control>}');
    await user.click(getRow('Lectures'));
    await user.keyboard('{/Control}');
    expect(getRow('Exams')).toHaveAttribute('aria-selected', 'true');
    expect(getRow('Lectures')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Shift>}');
    await user.click(getRow('week 2 notes.md'));
    await user.keyboard('{/Shift}');
    // A range from the anchor (Lectures) replaces the selection.
    expect([...useLibraryView.getState().panel.entries.values()].map((entry) => entry.path.split('/').at(-1))).toEqual([
      'Lectures',
      'Problem sets',
      'week 2 notes.md',
    ]);
    expect(getRow('Exams')).toHaveAttribute('aria-selected', 'false');
  });

  it('drops the selection inside a folder it collapses, so no action reaches hidden rows', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Exams'));
    await user.keyboard('{Control>}');
    await user.click(await findRow('Midterm'));
    await user.keyboard('{/Control}');
    expect(useLibraryView.getState().panel.entries.size).toBe(2);
    await user.click(getRow('MAT232'));
    expect(queryRow('Exams')).toBeNull();
    expect([...useLibraryView.getState().panel.entries.values()].map((entry) => entry.path)).toEqual([MAT]);
  });

  it('shows a file on a click in the preview pane', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('week 2 notes.md'));
    expect(useLibraryView.getState().active).toMatchObject({ kind: 'file', entry: { path: `${MAT}/week 2 notes.md` } });
    expect(await screen.findByRole('group', { name: 'Preview of week 2 notes.md' })).toBeInTheDocument();
  });

  it('opens a script in an editor on a double-click, and says why', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('CSC148'));
    await user.click(await findRow('a1'));
    await user.dblClick(await findRow('run.bat'));
    expect(await screen.findByRole('status', { name: '' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Opened run.bat in an editor')).toBeInTheDocument();
    });
  });
});

describe('the third column', () => {
  it('shows a course\'s folders as cards in a "Folders" group above its files (35A)', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const grid = await within(pane).findByRole('grid', { name: 'Files in MAT232' });
    // The label rows are for the eye: "Folders 3", "Files 2".
    expect(within(grid).getByText('Folders').parentElement).toHaveTextContent('Folders3');
    expect(within(grid).getByText('Files').parentElement).toHaveTextContent('Files2');
    expect(within(grid).getAllByRole('row')).toHaveLength(2);
    const [cards, tiles] = within(grid).getAllByRole('row');
    if (cards === undefined || tiles === undefined) throw new Error('No rows');
    expect(within(cards).getAllByRole('gridcell').map((cell) => cell.getAttribute('aria-label'))).toEqual([
      'Problem sets, folder, tags Homework',
      'Lectures, folder, tags Slides',
      'Exams, folder',
    ]);
    // Each card says how many files it holds, at any depth.
    const lectures = within(cards).getByRole('gridcell', { name: /^Lectures/ });
    await waitFor(() => {
      expect(lectures).toHaveAccessibleDescription('12 files');
    });
    expect(lectures).toHaveTextContent('Lectures12 files');
    expect(within(tiles).getAllByRole('gridcell')).toHaveLength(2);

    // Arrows treat the cards and the tiles as one grid.
    await user.click(lectures);
    await user.keyboard('{ArrowDown}');
    expect(within(tiles).getAllByRole('gridcell')[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(lectures).toHaveFocus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(within(tiles).getAllByRole('gridcell')[0]).toHaveFocus();

    // A double-click opens the folder, as Enter does.
    await user.dblClick(lectures);
    expect(await within(pane).findByRole('grid', { name: 'Files in Lectures' })).toBeInTheDocument();
  });

  it('says on a folder card when its files could not be counted', async () => {
    // One semester: the current one, without list_files to find the newest file.
    const fixture = libraryFixture((builder) => {
      builder.folder('Fall 2026/CSC148', { group: { order: 1 } });
      builder.file('Fall 2026/CSC148/Lectures/week1.pdf');
    });
    const { user } = renderLibrary({ fixture, fail: [{ command: 'list_files', code: 'Internal' }] });
    await user.click(await findRow('CSC148'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const grid = await within(pane).findByRole('grid', { name: 'Files in CSC148' });
    const lectures = await within(grid).findByRole('gridcell', { name: 'Lectures, folder' });
    await waitFor(() => {
      expect(lectures).toHaveAccessibleDescription("Couldn't count files");
    });
  });

  it('leaves the group labels out when a grid has only folders or only files', async () => {
    const fixture = libraryFixture((builder) => {
      builder.folder('Fall 2026/CSC148', { group: { order: 1 } });
      builder.folder('Fall 2026/CSC148/Labs');
      builder.folder('Fall 2026/CSC148/Labs/Lab 1');
      builder.folder('Fall 2026/CSC148/Labs/Lab 2');
      builder.file('Fall 2026/CSC148/Labs/Lab 1/lab1.py');
    });
    const { user } = renderLibrary({ fixture });
    await user.click(await findRow('CSC148'));
    await user.click(await findRow('Labs'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const folders = await within(pane).findByRole('grid', { name: 'Files in Labs' });
    expect(within(folders).getAllByRole('gridcell').map((cell) => cell.getAttribute('aria-label'))).toEqual([
      'Lab 1, folder',
      'Lab 2, folder',
    ]);
    expect(within(folders).queryByText('Folders')).toBeNull();

    await user.dblClick(within(folders).getByRole('gridcell', { name: 'Lab 1, folder' }));
    const files = await within(pane).findByRole('grid', { name: 'Files in Lab 1' });
    expect(within(files).getByRole('gridcell', { name: 'lab1.py' })).toBeInTheDocument();
    expect(within(files).queryByText('Files')).toBeNull();
  });

  it('switches a course between grid and list, and sorts', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const grid = await within(pane).findByRole('grid', { name: 'Files in MAT232' });
    expect(within(grid).getAllByRole('gridcell')[0]).toHaveAccessibleName(/^Problem sets/);

    await user.click(within(pane).getByRole('radio', { name: 'List' }));
    const list = await within(pane).findByRole('listbox', { name: 'Files in MAT232' });
    expect(usePreferences.getState().pane).toBe('list');

    await user.click(within(pane).getByRole('button', { name: 'Sort by Date modified' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Name' }));
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(within(list).getAllByRole('option')[0]).toHaveAccessibleName(/^Problem sets/);
    });
    expect(usePreferences.getState().sort).toEqual({ key: 'name', descending: true });
  });

  it('shows a quick view\'s files with where each one is', async () => {
    const { user } = renderLibrary();
    usePreferences.setState({ pane: 'list' });
    await user.click(await findRow('Recently added'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    expect(within(pane).getByRole('heading')).toHaveTextContent('Recently added· 7 files');
    const list = await within(pane).findByRole('listbox', { name: 'Recently added' });
    expect(within(list).getByRole('option', { name: /^笔记\.md/ })).toHaveTextContent('MAT223/笔记.md');
    expect(getRow('Recently added')).toHaveAttribute('aria-selected', 'true');
  });

  it('counts and lists the quick views in the current semester only (34A)', async () => {
    const fixture = libraryFixture((builder) => {
      builder.folder('Fall 2026/CSC148', { group: { order: 1 } });
      builder.file('Fall 2026/CSC148/new.md', { added: 1, modified: 0.5 });
      builder.file('Fall 2026/CSC148/tagged.md', { added: 2, tags: ['homework'] });
      builder.file('Fall 2026/CSC148/old.md', { added: 30 });
      builder.folder('Winter 2027/MAT237', { group: { order: 1 } });
      builder.file('Winter 2027/MAT237/winter.md', { added: 3 });
      // Beside the semesters: in no semester, so in no quick view.
      builder.file('loose.md', { added: 1 });
    });
    const { user } = renderLibrary({ fixture, toolbar: true });
    expect(await findRow('Recently added, 2 files')).toBeInTheDocument();
    expect(getRow('Untagged, 2 files')).toBeInTheDocument();

    usePreferences.setState({ pane: 'list' });
    await user.click(getRow('Recently added'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const list = await within(pane).findByRole('listbox', { name: 'Recently added' });
    expect(within(list).getAllByRole('option')).toHaveLength(2);
    expect(within(list).queryByRole('option', { name: /^loose\.md/ })).toBeNull();
    expect(within(list).queryByRole('option', { name: /^winter\.md/ })).toBeNull();

    // Another semester closes the quick view and counts again.
    await user.click(screen.getByRole('button', { name: 'Switch semester, current Fall 2026' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Winter 2027' }));
    expect(await findRow('Recently added, 1 file', 'Winter 2027')).toBeInTheDocument();
    expect(getRow('Untagged, 1 file', 'Winter 2027')).toBeInTheDocument();
    expect(useLibraryView.getState().active).toBeNull();
  });

  it('selects all of a long folder with Ctrl+A or Shift+End, loading the pages nobody shows', async () => {
    const photos = Array.from({ length: 450 }, (_, index) => ({
      path: `${MAT}/Photos/IMG_${String(index).padStart(4, '0')}.jpg`,
    }));
    const { user } = renderLibrary({ fixture: smallLibraryWith({ path: `${MAT}/Photos`, kind: 'folder', size: '0' }, ...photos) });
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Photos'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const grid = await within(pane).findByRole('grid', { name: 'Files in Photos' });
    await user.click(within(grid).getByRole('gridcell', { name: /^IMG_0000/ }));
    await user.keyboard('{Control>}a{/Control}');
    await waitFor(() => {
      expect(useLibraryView.getState().pane.entries.size).toBe(450);
    });

    await user.click(within(grid).getByRole('gridcell', { name: /^IMG_0001/ }));
    expect(useLibraryView.getState().pane.entries.size).toBe(1);
    await user.keyboard('{Shift>}{End}{/Shift}');
    await waitFor(() => {
      expect(useLibraryView.getState().pane.entries.size).toBe(449);
    });

    // A click while a range still loads wins: the range lands on nothing.
    await user.click(within(grid).getByRole('gridcell', { name: /^IMG_0002/ }));
    fireEvent.keyDown(within(grid).getByRole('gridcell', { name: /^IMG_0002/ }), { key: 'End', shiftKey: true });
    fireEvent.click(within(grid).getByRole('gridcell', { name: /^IMG_0003/ }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([...useLibraryView.getState().pane.entries.values()].map((entry) => nameOf(entry.path))).toEqual(['IMG_0003.jpg']);
  });

  it('shows the whole tree for a new folder started in the third column', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Show the library as' })).getByRole('radio', { name: 'List' }));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const grid = await within(pane).findByRole('grid', { name: 'Files in MAT232' });
    await user.click(within(grid).getByRole('gridcell', { name: /^Exams/ }));
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    expect(await screen.findByRole('textbox', { name: 'Name of the new folder' })).toBeInTheDocument();
    expect(usePreferences.getState().panel).toBe('tree');
  });

  it('opens a folder of the grid with Enter, and the tree opens down to it', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    const pane = screen.getByRole('region', { name: 'Preview' });
    const grid = await within(pane).findByRole('grid', { name: 'Files in MAT232' });
    const exams = within(grid).getByRole('gridcell', { name: /^Exams/ });
    await user.click(exams);
    await user.keyboard('{Enter}');
    expect(await within(pane).findByRole('grid', { name: 'Files in Exams' })).toBeInTheDocument();
    expect(getRow('MAT232')).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the List mode and the tag filter', () => {
  it('lists the semester\'s files with their places', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    await user.click(screen.getByRole('radio', { name: 'List' }));
    const list = await screen.findByRole('listbox', { name: `Files in ${FALL}` });
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(5);
    expect(within(list).getByRole('option', { name: /^Midterm review\.md/ })).toHaveTextContent(
      'MAT232/Exams/Midterm/Midterm review.md',
    );
  });

  it('shows only files with every selected tag, their courses and folders expanded', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    const bar = screen.getByRole('group', { name: 'Filter by tag' });
    await user.click(within(bar).getByRole('button', { name: 'Notes' }));
    await waitFor(() => {
      expect(rowNames()).toEqual([
        'Recently added, 7 files',
        'Untagged, 10 files',
        'MAT232 Calculus of Several Variables, 3 files',
        'Exams',
        'Midterm',
        'Midterm review.md, tags Notes, Exams',
        'week 2 notes.md, tags Notes',
        '第3章 偏导数.md, tags Notes',
        'MAT223 线性代数, 1 file',
        '笔记.md, tags Notes, 重要',
      ]);
    });
    expect(within(bar).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');

    // Both Notes and Exams: one file has both.
    await user.click(within(bar).getByRole('button', { name: 'Exams' }));
    await waitFor(() => {
      expect(rowNames().filter((name) => name.endsWith('.md') || name.includes('.md,'))).toEqual([
        'Midterm review.md, tags Notes, Exams',
      ]);
    });

    await user.click(within(bar).getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(getRow('MAT232')).toHaveAccessibleName('MAT232 Calculus of Several Variables, 27 files');
    });
  });

  it('shows every course open in the filtered tree: a click and Left leave the whole tree as it was', async () => {
    const { user } = renderLibrary();
    await user.click(await findRow('MAT232'));
    await user.click(await findRow('Exams'));
    const bar = screen.getByRole('group', { name: 'Filter by tag' });
    await user.click(within(bar).getByRole('button', { name: 'Notes' }));
    const course = await findRow('MAT232');
    await user.click(course);
    await user.keyboard('{ArrowLeft}');
    expect(getRow('MAT232')).toHaveAttribute('aria-expanded', 'true');
    expect(useLibraryView.getState().expanded).toEqual(new Set([MAT, `${MAT}/Exams`]));
  });

  it('turns the filter off for a new folder, whose field only the whole tree shows', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    const bar = screen.getByRole('group', { name: 'Filter by tag' });
    await user.click(within(bar).getByRole('button', { name: 'Notes' }));
    await user.click(await findRow('MAT232'));
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    expect(await screen.findByRole('textbox', { name: 'Name of the new folder' })).toHaveFocus();
    expect(within(bar).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says when no file matches, and Clear filters brings everything back', async () => {
    const { user } = renderLibrary();
    await findRow('MAT232');
    const bar = screen.getByRole('group', { name: 'Filter by tag' });
    await user.click(within(bar).getByRole('button', { name: 'Reference' }));
    await user.click(within(bar).getByRole('button', { name: 'Notes' }));
    expect(await screen.findByRole('heading', { name: 'No files match' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'No file in Fall 2026 has Reference and Notes. A filter with several tags shows files that have all of them.',
      ),
    ).toBeInTheDocument();
    // The quick views stay.
    expect(getRow('Recently added')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await findRow('MAT232')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No files match' })).toBeNull();
  });
});

describe('reveal', () => {
  it('expands to an entry the navigation store asks for, selects it and shows it', async () => {
    renderLibrary();
    await findRow('MAT232');
    const { reveal } = await import('../app/navigation');
    const { refIn, SMALL } = await import('../test/data');
    act(() => {
      reveal(refIn(SMALL, `${MAT}/Exams/Midterm/Midterm review.md`));
    });
    const row = await findRow('Midterm review.md');
    expect(row).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
    expect(useLibraryView.getState().active).toMatchObject({ kind: 'file' });
  });

  it('loads its folder page by page to an entry pages beyond the first, and keeps it', async () => {
    const photos = Array.from({ length: 600 }, (_, index) => ({
      path: `${MAT}/Photos/IMG_${String(index).padStart(4, '0')}.jpg`,
    }));
    const fixture = smallLibraryWith({ path: `${MAT}/Photos`, kind: 'folder', size: '0' }, ...photos);
    renderLibrary({ fixture });
    await findRow('MAT232');
    const { reveal } = await import('../app/navigation');
    const { refIn } = await import('../test/data');
    const library = fixture.library;
    if (library === null) throw new Error('the fixture has a library');
    act(() => {
      reveal(refIn(library, `${MAT}/Photos/IMG_0450.jpg`));
    });
    const row = await findRow('IMG_0450.jpg');
    expect(row).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(row).toHaveFocus();
    });
    expect(useLibraryView.getState().reveal).toBeNull();
  });
});
