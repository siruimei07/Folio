import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { useNavigation } from './app/navigation';
import { resetChangesView } from './changes/state';
import changes from './i18n/locales/en/changes.json';
import firstRun from './i18n/locales/en/first-run.json';
import library from './i18n/locales/en/library.json';
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
    // Library, Changes, then the gear and the avatar.
    expect(within(rail).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      shell.rail.library,
      `${shell.rail.changes}, ${String(items + metadata)} changes`,
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
});
