import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from './App';
import firstRun from './i18n/locales/en/first-run.json';
import library from './i18n/locales/en/library.json';
import { renderApp } from './test/render';

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
});
