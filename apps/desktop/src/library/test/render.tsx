// Library view tests against the fake shell: the view with the toasts, the dialogs it may open
// registered or not, its stores reset, and the small fixture at a fixed time (its current
// semester is Fall 2026, which holds the most recently modified file).
import { screen, within } from '@testing-library/react';

import { type DialogKind, HostedDialogs } from '../../app/navigation';
import { ToastRegion } from '../../app/ToastRegion';
import { useToasts } from '../../app/toasts';
import { NOW } from '../../test/data';
import { renderApp, type RenderAppOptions } from '../../test/render';
import { LibraryView } from '../LibraryView';
import { DEFAULT_SORT, usePreferences } from '../preferences';
import { SemesterControl } from '../SemesterControl';
import { resetLibraryView } from '../state';

export const FALL = 'Fall 2026';
export const MAT = 'Fall 2026/MAT232 Calculus of Several Variables';
export const CSC = 'Fall 2026/CSC148 Introduction to Computer Science';
export const LINEAR = 'Fall 2026/线性代数';

export interface RenderLibraryOptions extends RenderAppOptions {
  /** Dialogs another lane registers, whose buttons and menu items then show. */
  dialogs?: readonly DialogKind[];
  /** Also the toolbar's semester switcher. */
  toolbar?: boolean;
}

export function renderLibrary({ dialogs = [], toolbar = false, ...options }: RenderLibraryOptions = {}) {
  resetLibraryView();
  usePreferences.setState({ panel: 'tree', pane: 'grid', sort: DEFAULT_SORT });
  useToasts.setState({ toasts: [] });
  return renderApp(
    <HostedDialogs value={new Set(dialogs)}>
      {toolbar && <SemesterControl compact={false} />}
      <LibraryView />
      <ToastRegion />
    </HostedDialogs>,
    { now: NOW, ...options },
  );
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The tree of the current semester. */
export function tree(semester = FALL): HTMLElement {
  return screen.getByRole('tree', { name: `Courses and files in ${semester}` });
}

/** A row of the tree whose accessible name starts with `name`, once the tree and the row are there. */
export async function findRow(name: string, semester = FALL): Promise<HTMLElement> {
  const found = await screen.findByRole('tree', { name: `Courses and files in ${semester}` });
  return within(found).findByRole('treeitem', { name: new RegExp(`^${escape(name)}`) });
}

export function getRow(name: string, semester = FALL): HTMLElement {
  return within(tree(semester)).getByRole('treeitem', { name: new RegExp(`^${escape(name)}`) });
}

export function queryRow(name: string, semester = FALL): HTMLElement | null {
  return within(tree(semester)).queryByRole('treeitem', { name: new RegExp(`^${escape(name)}`) });
}

/** The names of the tree's rows in order, as their accessible names begin. */
export function rowNames(semester = FALL): string[] {
  return within(tree(semester))
    .getAllByRole('treeitem')
    .map((row) => row.getAttribute('aria-label') ?? row.textContent);
}

export { libraryFixture, smallLibraryWith } from '../../test/fixtures';
export { toastTexts } from '../../test/render';
