import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import changes from '../../apps/desktop/src/i18n/locales/en/changes.json' with { type: 'json' };
import errors from '../../apps/desktop/src/i18n/locales/en/errors.json' with { type: 'json' };
import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import shell from '../../apps/desktop/src/i18n/locales/en/shell.json' with { type: 'json' };
import { blockingViolations, countCalls, expect, openLibrary, test } from '../fixtures';

// The Changes view on the real shell (workspace-history handoff §2–§5, §10; ipc-m2 §5–§7). The
// workspace commands answer (feat/core-workspace); `start_history`, `commit` and the history
// commands are planned stubs until feat/core-commit-history registers them, so each answers "not
// allowed" (a Transport error). A new library has no history: `get_workspace` says `none`, the rail
// badge stays hidden, Folio starts the first commit by itself, and its refused start shows the first
// commit's block "Couldn't start your history" with Try again and Copy details in place of the list
// and the commit box. The view's flows (the list and its check boxes, the diff beside it, the
// commit box with the template and the AI message, Not synced, the first commit's other states, the
// narrow layout and the view's own 1,000 px breakpoint) run in apps/desktop/src/changes/**/*.test.tsx
// and app/firstCommit.test.tsx on the fake shell. Strings run in the page because this package has
// no DOM types.
//
// For feat/core-commit-history, once `start_history` and `commit` are registered: replace the
// refused start with the real flow over a library with a few changed files: the first commit's
// block while it runs and "Your history has started.", then the rows and the badge's count,
// selection → diff (Enter into it, F7), Space and Ctrl+A on the check boxes, Ctrl+Enter committing
// with the template, the commit in Not synced and the activity button, and the layouts this file
// checked before the workspace answered (git history of this file, e6b7abc9): the commit bar under
// the list in a narrow window without Not synced, the view narrow below 1,000 px while the shell
// stays wide, and the narrow window's Back. With a count on it, the commit button's "Ctrl+Enter"
// hint is 4.12:1 on the accent fill, an accepted exception (handoff decision 36) that axe reports
// as color-contrast: leave `.commit-button__keys` out of that check.

test.use({ libraryFolder: true });

/** A library with one course file, open on the Library. */
async function openWithAFile(page: Page, libraryDir: string | undefined): Promise<void> {
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  await mkdir(path.join(libraryDir, 'Fall 2026', 'MAT232 Calculus'), { recursive: true });
  await writeFile(path.join(libraryDir, 'Fall 2026', 'MAT232 Calculus', 'notes.md'), '# Notes\n');
  await openLibrary(page);
  await expect(page.getByRole('navigation', { name: shell.rail.label })).toBeVisible();
}

interface FocusStop {
  /** The focused element's name: its aria-label, its label's text or its own text. */
  name: string;
  /** Inside the content region (the view), not the title bar, toolbar or rail. */
  inView: boolean;
  /** A focus ring (an outline of at least 1 px) on it, on what it draws, or on the box around it. */
  ring: boolean;
}

/** What has the focus now. */
function focusStop(page: Page): Promise<FocusStop> {
  return page.evaluate<FocusStop>(`(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { name: 'body', inView: false, ring: false };
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    const name = (el.getAttribute('aria-label') ?? '') || labelledBy || (el.labels?.[0]?.textContent ?? '') || el.textContent;
    const ringed = (node) => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1;
    };
    const ring = [el, ...el.querySelectorAll('*'), el.closest('[data-focus-visible]')].some((node) => node && ringed(node));
    return { name: name.trim(), inView: el.closest('main') !== null, ring };
  })()`);
}

/** The first commit's failure, as the refused `start_history` shows it in the view. */
const startFailed = shell.firstCommit.failed.text.replace('{{reason}}', errors.Transport);

test('shows Changes from the rail and Ctrl+2, with the first commit refused, Try again and Copy details, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  const workspaceCalls = countCalls(page, 'get_workspace');
  const startCalls = countCalls(page, 'start_history');
  await openWithAFile(page, libraryDir);
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  const libraryButton = rail.getByRole('button', { name: shell.rail.library, exact: true });
  // The workspace says `none`: the button has no count and its plain name, and Folio starts the
  // first commit by itself (once: counted below, when its failure shows).
  const changesButton = rail.getByRole('button', { name: shell.rail.changes, exact: true });
  await expect(changesButton).toBeVisible();
  await expect.poll(workspaceCalls).toBeGreaterThan(0);
  await expect.poll(startCalls).toBeGreaterThan(0);
  await expect(changesButton.locator('.rail__badge')).toHaveCount(0);
  await expect(libraryButton).toHaveAttribute('aria-current', 'page');

  // Focus opens the rail button's tooltip with its shortcut. Check it before any key: React Aria
  // closes it on every keydown on its trigger.
  await changesButton.focus();
  await expect(page.getByRole('tooltip')).toContainText(shell.rail.changes);
  await expect(page.getByRole('tooltip')).toContainText('Ctrl+2');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();

  // Ctrl+2 shows Changes, Ctrl+1 the Library again, and the rail button Changes.
  await page.keyboard.press('Control+2');
  await expect(changesButton).toHaveAttribute('aria-current', 'page');
  const view = page.getByRole('main');
  const panel = view.getByRole('region', { name: changes.list.title });
  await expect(panel).toBeVisible();
  await page.keyboard.press('Control+1');
  await expect(libraryButton).toHaveAttribute('aria-current', 'page');
  await expect(view.getByRole('region', { name: library.panel.title })).toBeVisible();
  await expect(panel).toBeHidden();
  await changesButton.click();
  await expect(changesButton).toHaveAttribute('aria-current', 'page');
  await expect(panel).toBeVisible();

  // One panel, named like the list's, with the first commit's block: the start was refused
  // (Transport), with Try again and Copy details. No list, commit box or Not synced before the
  // history has started.
  await expect(panel.getByText(shell.firstCommit.failed.title)).toBeVisible();
  await expect(panel.getByText(startFailed)).toBeVisible();
  const tryAgain = panel.getByRole('button', { name: shell.tryAgain });
  const copyDetails = panel.getByRole('button', { name: shell.copyDetails.action });
  await expect(tryAgain).toBeVisible();
  await expect(copyDetails).toBeVisible();
  // The start Folio made by itself has settled (refused), after one call; a second automatic start
  // would show here, or in the counts below.
  expect(startCalls()).toBe(1);
  await expect(view.getByRole('checkbox')).toHaveCount(0);
  await expect(view.getByRole('listbox')).toHaveCount(0);
  await expect(view.getByRole('region', { name: changes.commit.label })).toHaveCount(0);
  await expect(view.getByRole('region', { name: changes.notSynced.title })).toHaveCount(0);
  expect(await blockingViolations(page)).toEqual([]);

  // Try again from the keyboard starts it again; the command is still a stub, so the failure comes
  // back. The start moves the focus to the block, since its button goes while it waits.
  await tryAgain.focus();
  await page.keyboard.press('Enter');
  await expect.poll(startCalls).toBeGreaterThan(1);
  await expect(panel.getByText(startFailed)).toBeVisible();
  await expect(tryAgain).toBeVisible();
  await expect(panel.locator('.first-commit')).toBeFocused();
  // Settled again: the one start Try again asked for, no other.
  expect(startCalls()).toBe(2);

  // Copy details copies what failed and the error; the page's clipboard is replaced here, so the
  // run leaves the machine's clipboard alone.
  await page.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value: async (text) => { window.__copied = text; },
  })`);
  await copyDetails.click();
  await expect(page.getByRole('status').getByText(shell.copyDetails.copied)).toBeVisible();
  const copied = await page.evaluate<string>('window.__copied');
  expect(copied).toContain(shell.firstCommit.failed.title);
  expect(copied).toContain('Transport');
  // Still the two starts, after everything the test did since.
  expect(startCalls()).toBe(2);
});

test('reaches the first commit block from the keyboard, with a visible focus at each stop', async ({ folio }) => {
  const { page, libraryDir } = folio;
  await openWithAFile(page, libraryDir);
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  const changesButton = rail.getByRole('button', { name: shell.rail.changes, exact: true });
  await changesButton.focus();
  await page.keyboard.press('Control+2');
  await expect(changesButton).toBeFocused();
  const panel = page.getByRole('main').getByRole('region', { name: changes.list.title });
  await expect(panel.getByText(startFailed)).toBeVisible();

  // Tab from the rail button through the view, until the focus leaves it again.
  const stops: FocusStop[] = [];
  for (let step = 0; step < 30; step += 1) {
    await page.keyboard.press('Tab');
    const stop = await focusStop(page);
    if (stop.inView) stops.push(stop);
    else if (stops.length > 0) break;
  }
  const names = stops.map(({ name }) => name);
  test.info().annotations.push({ type: 'Tab stops in the view', description: names.join(' | ') });
  // The block's buttons, in that order, and nothing else in the view.
  expect(names).toEqual([shell.tryAgain, shell.copyDetails.action]);
  // Every stop in the view shows where the focus is.
  expect(stops.filter(({ ring }) => !ring).map(({ name }) => name)).toEqual([]);
});

test('shows the first commit block in a narrow window too, and passes axe', async ({ folio }) => {
  const { page, libraryDir } = folio;
  await openWithAFile(page, libraryDir);
  await page.setViewportSize({ width: 600, height: 500 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'narrow');
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  await rail.getByRole('button', { name: shell.rail.changes, exact: true }).click();

  const view = page.getByRole('main');
  const panel = view.getByRole('region', { name: changes.list.title });
  await expect(panel.getByText(startFailed)).toBeVisible();
  await expect(panel.getByRole('button', { name: shell.tryAgain })).toBeVisible();
  await expect(view.getByRole('region', { name: changes.commit.label })).toHaveCount(0);
  await expect(view.getByRole('region', { name: changes.notSynced.title })).toHaveCount(0);
  expect(await blockingViolations(page)).toEqual([]);
});
