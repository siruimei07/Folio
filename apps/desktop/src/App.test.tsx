import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { editMessageOf } from './app/historyCommands';
import { useNavigation } from './app/navigation';
import { resetChangesView } from './changes/state';
import { resetHistoryView } from './history/state';
import changes from './i18n/locales/en/changes.json';
import firstRun from './i18n/locales/en/first-run.json';
import history from './i18n/locales/en/history.json';
import library from './i18n/locales/en/library.json';
import previewStrings from './i18n/locales/en/preview.json';
import shell from './i18n/locales/en/shell.json';
import { renderApp } from './test/render';

beforeEach(() => {
  useNavigation.setState({ view: 'library', dialog: null, revealTarget: null });
});

describe('App', () => {
  it('shows the Library view of the open library, with the semester switcher in the toolbar', async () => {
    renderApp(<App />);

    expect(screen.getByRole('region', { name: library.panel.title })).toBeInTheDocument();
    expect(await screen.findByRole('treeitem', { name: /^MAT232 Calculus of Several Variables, / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Switch semester, current Fall 2026/ })).toBeInTheDocument();
  });

  it('shows the welcome screen, without the Library, before the first run', async () => {
    renderApp(<App />, { scenario: 'first-run' });

    expect(await screen.findByRole('heading', { level: 1, name: firstRun.welcome.title })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: library.panel.title })).toBeNull();
  });

  it('puts the Changes view on the rail with its count, and shows it from the rail and Ctrl+2', async () => {
    resetChangesView();
    const { shell: fake, user } = renderApp(<App />);
    const rail = screen.getByRole('navigation', { name: shell.rail.label });
    const { items, metadata } = fake.versioning.summary();
    const changesButton = await within(rail).findByRole('button', {
      name: `${shell.rail.changes}, ${String(items + metadata)} changes`,
    });
    expect(changesButton.querySelector('.rail__badge')).toHaveTextContent(String(items + metadata));
    // Library, Changes, History, then the gear and the avatar.
    expect(within(rail).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      shell.rail.library,
      `${shell.rail.changes}, ${String(items + metadata)} changes`,
      shell.rail.history,
      shell.rail.librarySettings,
      expect.stringMatching(/^App settings/),
    ]);

    await user.keyboard('{Control>}2{/Control}');
    expect(changesButton).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('listbox', { name: changes.list.label }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: library.panel.title, hidden: true })).not.toBeVisible();

    await user.click(within(rail).getByRole('button', { name: shell.rail.library }));
    expect(screen.getByRole('region', { name: library.panel.title })).toBeVisible();
    await user.click(changesButton);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: changes.list.title })).toBeVisible();
    });
  });

  it('puts History on the rail, shows it from the rail and Ctrl+3, and hosts the Edit message dialog', async () => {
    const { user } = renderApp(<App />);
    const rail = screen.getByRole('navigation', { name: shell.rail.label });
    const historyButton = within(rail).getByRole('button', { name: shell.rail.history });

    await user.keyboard('{Control>}3{/Control}');
    expect(historyButton).toHaveAttribute('aria-current', 'page');
    const feed = await screen.findByRole('feed', { name: history.feed }, { timeout: 5000 });
    expect(screen.getByRole('region', { name: library.panel.title, hidden: true })).not.toBeVisible();

    await user.click(within(rail).getByRole('button', { name: shell.rail.library }));
    expect(screen.getByRole('region', { name: library.panel.title })).toBeVisible();
    await user.click(historyButton);
    await waitFor(() => {
      expect(feed).toBeVisible();
    });

    // A commit's Edit message opens the registered dialog.
    const [edit] = within(feed).getAllByRole('button', { name: history.actions.editMessage });
    if (edit === undefined) throw new Error('no commit entries');
    await user.click(edit);
    expect(await screen.findByRole('dialog', { name: history.editMessage.title })).toBeInTheDocument();
  });

  it('gives the focus to History’s timeline from the Not synced card’s “more in History”, whose view hides', async () => {
    resetChangesView();
    const { user } = renderApp(<App />);
    await user.keyboard('{Control>}2{/Control}');
    const more = await screen.findByRole('button', { name: /more in History$/ }, { timeout: 5000 });
    act(() => {
      more.focus();
    });

    await user.keyboard('{Enter}');

    const feed = await screen.findByRole('feed', { name: history.feed }, { timeout: 5000 });
    await waitFor(() => {
      expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
    });
  });

  // Changes stays mounted once shown, hidden in <Activity>, before History in the page: its Not synced
  // card lists the same commit, which must not take the focus History's entry gets back.
  it('gives the focus back to History’s entry, not the hidden Not synced row of its commit, when Edit message closes unsaved', async () => {
    resetChangesView();
    resetHistoryView();
    const { user } = renderApp(<App />);
    await user.keyboard('{Control>}2{/Control}');
    const notSynced = await screen.findByRole('list', { name: changes.notSynced.commits }, { timeout: 5000 });
    await user.keyboard('{Control>}3{/Control}');
    const feed = await screen.findByRole('feed', { name: history.feed }, { timeout: 5000 });
    const summary = 'MAT232: rewrite the midterm review';
    const entry = await within(feed).findByRole('article', { name: summary });
    expect(notSynced.querySelector(`[data-commit="${entry.dataset.entry?.replace('commit ', '') ?? ''}"]`)).not.toBeNull();
    act(() => {
      entry.focus();
    });

    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: `Actions for “${summary}”` });
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: history.actions.editMessage })).toHaveFocus();
    });
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: history.editMessage.title });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: history.editMessage.summary })).toHaveFocus();
    });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: history.editMessage.title })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  it('gives the focus to the Changes list when Edit message, opened from Not synced, closes after its commit went', async () => {
    resetChangesView();
    resetHistoryView();
    const { shell, user } = renderApp(<App />);
    await user.keyboard('{Control>}2{/Control}');
    const notSynced = await screen.findByRole('list', { name: changes.notSynced.commits }, { timeout: 5000 });
    const top = within(notSynced).getByRole('listitem', { name: 'MAT232: rewrite the midterm review' });
    const head = top.dataset.commit ?? '';
    await user.click(within(top).getByRole('button', { name: history.actions.editMessage }));
    const dialog = await screen.findByRole('dialog', { name: history.editMessage.title });
    await waitFor(() => {
      expect(within(dialog).getByRole('textbox', { name: history.editMessage.summary })).toHaveFocus();
    });
    await act(async () => {
      await shell.invoke('uncommit', { request: { commit: head } });
    });
    await waitFor(() => {
      expect(document.querySelector(`[data-commit="${head}"]`)).toBeNull();
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    const list = screen.getByRole('listbox', { name: changes.list.label });
    await waitFor(() => {
      expect(list).toContainElement(document.activeElement as HTMLElement | null);
    });
  });

  // The toast after a template commit opens Edit message wherever it shows, and the Library lists no
  // commits: when React Aria leaves the focus on the page, the view's rail button takes it.
  it('gives the focus to the Library’s rail button when Edit message, opened there, closes, cancelled or saved', async () => {
    const { shell: fake, user } = renderApp(<App />);
    await screen.findByRole('treeitem', { name: /^MAT232 Calculus of Several Variables, / });
    const rail = screen.getByRole('navigation', { name: shell.rail.label });
    const libraryButton = within(rail).getByRole('button', { name: shell.rail.library });
    const head = fake.versioning.head?.id ?? '';

    const open = async () => {
      act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      act(() => {
        editMessageOf(head);
      });
      const dialog = await screen.findByRole('dialog', { name: history.editMessage.title });
      await waitFor(() => {
        expect(within(dialog).getByRole('textbox', { name: history.editMessage.summary })).toHaveFocus();
      });
      return dialog;
    };

    let dialog = await open();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(libraryButton).toHaveFocus();
    });

    // Saved: the commit's new entry shows in no view showing, so the button takes it at once.
    dialog = await open();
    await user.paste('MAT232: rewrite the review');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(libraryButton).toHaveFocus();
    });
  });

  it('gives the focus to a file’s timeline each time the Library asks for its history, also when it shows already', async () => {
    resetHistoryView();
    const { user } = renderApp(<App />);
    const tree = await screen.findByRole('tree', { name: 'Courses and files in Fall 2026' });
    await user.click(await within(tree).findByRole('treeitem', { name: /^MAT232 / }));
    await user.click(await within(tree).findByRole('treeitem', { name: /^week 2 notes\.md/ }));
    const preview = await screen.findByRole('group', { name: 'Preview of week 2 notes.md' });
    const viewHistory = within(preview).getByRole('button', { name: previewStrings.header.history });
    act(() => {
      viewHistory.focus();
    });
    await user.keyboard('{Enter}');
    const feed = await screen.findByRole('feed', { name: 'History of week 2 notes.md, newest first' }, { timeout: 5000 });
    await waitFor(() => {
      expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
    });

    // Back in the Library, the same button again: History keeps the file's history where it was, and
    // its timeline takes the focus the hidden Library's button had.
    await user.keyboard('{Control>}1{/Control}');
    await waitFor(() => {
      expect(viewHistory).toBeVisible();
    });
    act(() => {
      viewHistory.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(feed).toBeVisible();
    });
    await waitFor(() => {
      expect(feed.querySelector('article[tabindex="0"]')).toHaveFocus();
    });
  });
});
