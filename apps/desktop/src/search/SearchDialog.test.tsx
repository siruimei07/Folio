// The search dialog against the fake shell (app-shell handoff §8, UI architecture §9 and §15):
// grouped results with highlights as text, the keyboard, reveal through the navigation store, and
// the hint, empty, too-long and error states.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Announcer } from '../app/announcer';
import { DialogHost } from '../app/DialogHost';
import { openDialog, useNavigation } from '../app/navigation';
import { LIMITS, type SearchHit } from '../ipc';
import { NOW, smallRef } from '../test/data';
import { libraryFixture } from '../test/fixtures';
import { renderApp } from '../test/render';
import { Highlighted } from './Highlighted';
import { groupHits } from './hits';
import { SearchDialog } from './SearchDialog';

// The list's "load more" sentinel watches with an IntersectionObserver (a no-op in jsdom's setup):
// this one remembers its callbacks, and `reachEnd` tells every sentinel it came into view, as
// scrolling to the end of the list would.
const sentinels = new Set<IntersectionObserverCallback>();
vi.stubGlobal(
  'IntersectionObserver',
  class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe() {
      sentinels.add(this.callback);
    }
    unobserve = vi.fn();
    disconnect() {
      sentinels.delete(this.callback);
    }
  },
);

function reachEnd(): void {
  act(() => {
    for (const callback of [...sentinels]) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

function renderSearch(options: Parameters<typeof renderApp>[1] = {}) {
  // The dialog as the shell hosts it, with the live regions it announces in.
  const rendered = renderApp(
    <>
      <Announcer />
      <DialogHost dialogs={{ search: SearchDialog }} />
    </>,
    { now: NOW, ...options },
  );
  act(() => {
    openDialog('search');
  });
  return { ...rendered, field: screen.getByRole('textbox', { name: 'Search' }) };
}

/** A library with `count` files whose names match "gradient". */
function gradientLibrary(count: number) {
  return libraryFixture((b) => {
    b.folder('Fall 2026', { group: { order: 1 } });
    b.folder('Fall 2026/MAT232', { group: { order: 1, code: 'MAT232' } });
    for (let n = 1; n <= count; n++) b.file(`Fall 2026/MAT232/gradient ${String(n)}.md`, { size: 10 });
  });
}

/** The dialog's footer: the keys and the count. */
function footer(): HTMLElement {
  const element = screen.getByRole('dialog').querySelector('footer');
  if (element === null) throw new Error('no footer');
  return element;
}

function politeRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[data-live-announcer] [aria-live="polite"]');
  if (region === null) throw new Error('no polite live region');
  return region;
}

beforeEach(() => {
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
});

describe('groupHits', () => {
  const hit = (name: string, matched: boolean): SearchHit => ({
    entry: { ...SMALL_ROW, id: name, path: name, name },
    name: [{ text: name, matched }],
    snippet: matched ? null : [{ text: 'body', matched: true }],
  });
  const SMALL_ROW: SearchHit['entry'] = {
    id: '',
    path: '',
    name: '',
    kind: 'file',
    class: 'text',
    size: '1',
    modifiedMs: null,
    addedMs: '0',
    tags: [],
    folderTags: [],
  };

  it('puts hits with a matched name first under File names, the rest under Contents, in rank order', () => {
    const groups = groupHits([hit('a', false), hit('b', true), hit('c', false), hit('d', true)]);
    expect(groups.names.map((h) => h.entry.id)).toEqual(['b', 'd']);
    expect(groups.contents.map((h) => h.entry.id)).toEqual(['a', 'c']);
  });
});

describe('Highlighted', () => {
  it('renders spans as text, matched ones in <mark>, never as HTML', () => {
    const { container } = render(
      <p>
        <Highlighted
          spans={[
            { text: '<img src=x onerror=alert(1)>', matched: false },
            { text: '<b>midterm</b>', matched: true },
          ]}
        />
      </p>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('mark')).toHaveTextContent('<b>midterm</b>');
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)><b>midterm</b>');
  });
});

describe('SearchDialog', () => {
  it('opens on an empty field with a hint, and asks nothing until there is text', () => {
    const { shell, field } = renderSearch();
    const invoke = vi.spyOn(shell, 'invoke');
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');
    expect(screen.getByText('Find a file by its name, or by a word inside it.')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows grouped results with highlights, places and snippets as you type', async () => {
    const { user, field } = renderSearch();
    await user.type(field, 'midterm');

    const results = await screen.findByRole('listbox', { name: 'Search results' });
    const [names, contents] = within(results).getAllByRole('group');
    if (names === undefined || contents === undefined) throw new Error('expected two groups');
    expect(within(names).getByText('File names')).toBeInTheDocument();
    expect(within(contents).getByText('Contents')).toBeInTheDocument();

    const pdf = within(names).getByRole('option', { name: 'Midterm 2025.pdf' });
    // The place shows once the courses have arrived, with the course's code (27B).
    await waitFor(() => {
      expect(pdf).toHaveAccessibleDescription('MAT232 / Exams / Midterm');
    });
    expect(pdf.querySelector('mark')).toHaveTextContent('Midterm');
    expect(within(names).getByRole('option', { name: 'Midterm review.md' })).toBeInTheDocument();

    const todo = within(contents).getByRole('option', { name: 'Todo.txt' });
    expect(todo.querySelector('mark')).toHaveTextContent('midterm');
    expect(todo).toHaveAccessibleDescription(/Personal.*midterm regrade/);

    expect(footer()).toHaveTextContent('3 results');
    await waitFor(() => {
      expect(politeRegion()).toHaveTextContent('3 results');
    });
  });

  it('waits for a pause in typing, and for an IME to finish composing', async () => {
    const { shell, field } = renderSearch();
    const invoke = vi.spyOn(shell, 'invoke');
    const searches = () => invoke.mock.calls.filter(([command]) => command === 'search');

    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: '拉格朗日' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(searches()).toHaveLength(0);

    fireEvent.compositionEnd(field);
    expect(await screen.findByRole('option', { name: 'Midterm review.md' })).toBeInTheDocument();
    expect(searches()).toHaveLength(1);
    expect(searches()[0]?.[1]).toMatchObject({ request: { text: '拉格朗日' } });
  });

  it('moves through the results with the arrow keys while the field keeps focus', async () => {
    const { user, field } = renderSearch();
    await user.type(field, 'midterm');
    const first = await screen.findByRole('option', { name: 'Midterm 2025.pdf' });
    const second = screen.getByRole('option', { name: 'Midterm review.md' });
    const third = screen.getByRole('option', { name: 'Todo.txt' });

    await waitFor(() => {
      expect(field).toHaveAttribute('aria-activedescendant', first.id);
    });
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', second.id);
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', third.id);
    expect(third).toHaveAttribute('data-focused');
    await user.keyboard('{ArrowUp}');
    expect(field).toHaveAttribute('aria-activedescendant', second.id);
    expect(field).toHaveFocus();
  });

  it('Enter closes the dialog and reveals the file in the Library, through the navigation store', async () => {
    const { user, field } = renderSearch();
    useNavigation.setState({ view: 'history' });
    await user.type(field, 'midterm');
    await screen.findByRole('option', { name: 'Midterm review.md' });
    await user.keyboard('{ArrowDown}{Enter}');

    expect(useNavigation.getState()).toMatchObject({
      view: 'library',
      dialog: null,
      revealTarget: smallRef('Fall 2026/MAT232 Calculus of Several Variables/Exams/Midterm/Midterm review.md'),
    });
  });

  it('a click on a result does the same', async () => {
    const { user, field } = renderSearch();
    await user.type(field, 'todo');
    await user.click(await screen.findByRole('option', { name: 'Todo.txt' }));
    expect(useNavigation.getState().dialog).toBeNull();
    expect(useNavigation.getState().revealTarget?.path).toBe('Personal/Todo.txt');
  });

  it('Esc closes it, with results and without', async () => {
    const { user, field } = renderSearch();
    await user.type(field, 'midterm');
    await screen.findByRole('option', { name: 'Midterm 2025.pdf' });
    await user.keyboard('{Escape}');
    expect(useNavigation.getState()).toMatchObject({ dialog: null, revealTarget: null });

    act(() => {
      openDialog('search');
    });
    const reopened = await screen.findByRole('textbox', { name: 'Search' });
    expect(reopened).toHaveValue('');
    await user.type(reopened, 'zzqx');
    await screen.findByRole('heading', { name: 'No matches for “zzqx”' });
    await user.keyboard('{Escape}');
    expect(useNavigation.getState().dialog).toBeNull();
  });

  it('says when nothing matches', async () => {
    const { user, field } = renderSearch();
    await user.type(field, 'zzqx');
    expect(await screen.findByRole('heading', { name: 'No matches for “zzqx”' })).toBeInTheDocument();
    expect(screen.getByText('Check the spelling, or search for a word from inside the file.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    await waitFor(() => {
      expect(politeRegion()).toHaveTextContent('No matches for “zzqx”');
    });
  });

  it('says a search is too long without asking the shell', async () => {
    const { shell, field } = renderSearch();
    const invoke = vi.spyOn(shell, 'invoke');
    fireEvent.change(field, { target: { value: 'a'.repeat(LIMITS.queryChars + 1) } });
    expect(await screen.findByRole('heading', { name: 'This search is too long' })).toBeInTheDocument();
    expect(screen.getByText('Search with up to 256 characters. This one has 257.')).toBeInTheDocument();
    expect(invoke.mock.calls.filter(([command]) => command === 'search')).toHaveLength(0);
  });

  it('shows a failed search with its reason, and Try again asks again', async () => {
    const { user, shell, field } = renderSearch({ fail: [{ command: 'search', code: 'Internal' }] });
    await user.type(field, 'midterm');
    expect(await screen.findByRole('heading', { name: "Search didn't work" })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText(/Something went wrong inside Folio/)).toBeInTheDocument();
    await waitFor(() => {
      expect(politeRegion()).toHaveTextContent("Search didn't work. Something went wrong inside Folio");
    });

    shell.setFailure('search', null);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: 'Midterm 2025.pdf' })).toBeInTheDocument();
    // The button went with the error: the field has focus again and the keys drive the list.
    expect(field).toHaveFocus();
    await waitFor(() => {
      expect(politeRegion()).toHaveTextContent('3 results');
    });
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Midterm review.md' }).id);
  });

  it('loads the next page at the end of the list, within one group', async () => {
    const { user, field } = renderSearch({ fixture: gradientLibrary(70) });
    await user.type(field, 'gradient');
    await screen.findByRole('option', { name: 'gradient 1.md' });
    expect(screen.getAllByRole('option')).toHaveLength(50);
    expect(footer()).toHaveTextContent('50+ results');

    reachEnd();
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(70);
    });
    expect(footer()).toHaveTextContent('70 results');
    expect(within(screen.getByRole('listbox')).getAllByRole('group')).toHaveLength(1);
  });
});
