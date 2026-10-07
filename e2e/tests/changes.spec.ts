import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import changes from '../../apps/desktop/src/i18n/locales/en/changes.json' with { type: 'json' };
import errors from '../../apps/desktop/src/i18n/locales/en/errors.json' with { type: 'json' };
import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import shell from '../../apps/desktop/src/i18n/locales/en/shell.json' with { type: 'json' };
import { blockingViolations, countCalls, expect, openLibrary, test } from '../fixtures';

// The Changes view on the real shell (workspace-history handoff §2–§5; ipc-m2 §5–§7). The
// workspace, commit and history commands are planned stubs until feat/core-workspace and
// feat/core-commit-history register them, so every one of them answers "not allowed" (a Transport
// error): the rail badge stays hidden, the list shows its load failure with Try again and Copy
// details, and the commit box waits with a pending "Commit". The view's flows (the list and its
// check boxes, the diff beside it, the commit box with the template and the AI message, Not synced,
// the first commit) run in apps/desktop/src/changes/**/*.test.tsx and app/firstCommit.test.tsx on
// the fake shell. Strings run in the page because this package has no DOM types.
//
// For feat/core-workspace and feat/core-commit-history, once the commands are registered: replace
// the load-failure checks with the real flow over a library with a few changed files: the rows and
// the badge's count, selection → diff (Enter into it, F7), Space and Ctrl+A on the check boxes,
// Ctrl+Enter committing with the template, the commit in Not synced and the activity button, the
// first commit's block in a new library, and the narrow window's Back. With a count on it, the
// commit button's "Ctrl+Enter" hint is 4.12:1 on the accent fill, an accepted exception (handoff
// decision 36) that axe reports as color-contrast: leave `.commit-button__keys` out of that check.

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

test('shows Changes from the rail and Ctrl+2, with the load failure, Try again and Copy details, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  const workspaceCalls = countCalls(page, 'get_workspace');
  await openWithAFile(page, libraryDir);
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  const libraryButton = rail.getByRole('button', { name: shell.rail.library, exact: true });
  // The badge's get_workspace is refused, so the button has no count and its plain name.
  const changesButton = rail.getByRole('button', { name: shell.rail.changes, exact: true });
  await expect(changesButton).toBeVisible();
  await expect.poll(workspaceCalls).toBeGreaterThan(0);
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
  const list = view.getByRole('region', { name: changes.list.title });
  await expect(list).toBeVisible();
  await page.keyboard.press('Control+1');
  await expect(libraryButton).toHaveAttribute('aria-current', 'page');
  await expect(view.getByRole('region', { name: library.panel.title })).toBeVisible();
  await expect(list).toBeHidden();
  await changesButton.click();
  await expect(changesButton).toHaveAttribute('aria-current', 'page');
  await expect(list).toBeVisible();

  // The list says it couldn't load, why, and offers Try again and Copy details (Transport).
  await expect(list.getByText(changes.states.loadFailed)).toBeVisible();
  await expect(list.getByText(errors.Transport)).toBeVisible();
  const tryAgain = list.getByRole('button', { name: shell.tryAgain });
  const copyDetails = list.getByRole('button', { name: shell.copyDetails.action });
  await expect(tryAgain).toBeVisible();
  await expect(copyDetails).toBeVisible();
  // The count is unknown, select-all has nothing to include, and nothing shows in the diff column.
  await expect(list.getByRole('checkbox', { name: changes.list.includeAll })).toBeDisabled();
  await expect(list.getByRole('img', { name: changes.list.countUnknown })).toBeVisible();
  await expect(view.getByRole('listbox')).toHaveCount(0);
  // The commit box waits: "Commit" is pending (aria-disabled, still in the tab order), and says why
  // in place of a shortcut that does nothing.
  const commit = view.getByRole('region', { name: changes.commit.label });
  const commitButton = commit.getByRole('button', { name: changes.commit.buttonUnknown, exact: true });
  await expect(commitButton).toHaveAttribute('aria-disabled', 'true');
  await expect(commitButton).toHaveAccessibleDescription(changes.states.loadFailed);
  // Not synced shows its sentence without a lane: the commits are unknown.
  const notSynced = view.getByRole('region', { name: changes.notSynced.title });
  await expect(notSynced.getByText(changes.notSynced.text)).toBeVisible();
  await expect(notSynced.getByRole('list')).toHaveCount(0);
  expect(await blockingViolations(page)).toEqual([]);

  // Try again from the keyboard asks the shell again; the command is still a stub, so the failure
  // comes back. The failure stays on screen while the read runs, so Try again keeps the focus.
  const before = workspaceCalls();
  await tryAgain.focus();
  await page.keyboard.press('Enter');
  await expect.poll(workspaceCalls).toBeGreaterThan(before);
  await expect(list.getByText(changes.states.loadFailed)).toBeVisible();
  await expect(tryAgain).toBeVisible();
  await expect(tryAgain).toBeFocused();

  // Copy details copies what failed and the error; the page's clipboard is replaced here, so the
  // run leaves the machine's clipboard alone.
  await page.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
    configurable: true,
    value: async (text) => { window.__copied = text; },
  })`);
  await copyDetails.click();
  await expect(page.getByRole('status').getByText(shell.copyDetails.copied)).toBeVisible();
  const copied = await page.evaluate<string>('window.__copied');
  expect(copied).toContain(changes.states.loadFailed);
  expect(copied).toContain('Transport');
});

test('reaches the view from the keyboard, with a visible focus at each stop', async ({ folio }) => {
  const { page, libraryDir } = folio;
  await openWithAFile(page, libraryDir);
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  const changesButton = rail.getByRole('button', { name: shell.rail.changes, exact: true });
  await changesButton.focus();
  await page.keyboard.press('Control+2');
  await expect(changesButton).toBeFocused();
  // In the list: the commit button is described by the same words, out of sight.
  const list = page.getByRole('main').getByRole('region', { name: changes.list.title });
  await expect(list.getByText(changes.states.loadFailed)).toBeVisible();

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
  // The layout toggle, the failure's buttons, then the commit box's button, in that order.
  const order = [changes.list.flat, shell.tryAgain, shell.copyDetails.action, changes.commit.buttonUnknown];
  const at = order.map((name) => names.findIndex((stopName) => stopName === name || stopName.startsWith(name)));
  expect(at.every((index) => index >= 0), `stops: ${names.join(' | ')}`).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // Every stop in the view shows where the focus is.
  expect(stops.filter(({ ring }) => !ring).map(({ name }) => name)).toEqual([]);
});

test('puts the commit bar under the list in a narrow window, without Not synced, and passes axe', async ({ folio }) => {
  const { page, libraryDir } = folio;
  await openWithAFile(page, libraryDir);
  await page.setViewportSize({ width: 600, height: 500 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'narrow');
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  await rail.getByRole('button', { name: shell.rail.changes, exact: true }).click();
  // The view's stylesheets read its own attribute, not the shell's.
  await expect(page.locator('.changes-view')).toHaveAttribute('data-narrow', 'true');

  const view = page.getByRole('main');
  const list = view.getByRole('region', { name: changes.list.title });
  await expect(list.getByText(changes.states.loadFailed)).toBeVisible();
  await expect(list.getByRole('button', { name: shell.tryAgain })).toBeVisible();
  const bar = view.getByRole('region', { name: changes.commit.label });
  await expect(bar).toBeVisible();
  const listBox = await list.boundingBox();
  const barBox = await bar.boundingBox();
  if (!listBox || !barBox) throw new Error('The list and the commit bar have no boxes');
  // Full width: the bar starts where the list starts, below it.
  expect(barBox.x).toBeCloseTo(listBox.x, 0);
  expect(barBox.width).toBeCloseTo(listBox.width, 0);
  expect(barBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
  await expect(view.getByRole('region', { name: changes.notSynced.title })).toHaveCount(0);
  expect(await blockingViolations(page)).toEqual([]);
});

// The view's own breakpoint (workspace-history handoff §2.1 as built, 1,000 px) lies above the
// shell's (760 px): between the two the rail and the shell stay wide while the view lays out narrow.
test('lays the view out narrow below 1,000 px while the shell stays wide, and wide above it', async ({ folio }) => {
  const { page, libraryDir } = folio;
  await openWithAFile(page, libraryDir);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  await rail.getByRole('button', { name: shell.rail.changes, exact: true }).click();

  const view = page.getByRole('main');
  const changesView = page.locator('.changes-view');
  const list = view.getByRole('region', { name: changes.list.title });
  const commit = view.getByRole('region', { name: changes.commit.label });
  await expect(list.getByText(changes.states.loadFailed)).toBeVisible();
  // Narrow: the commit bar under the list, the whole width, and no Not synced.
  await expect(changesView).toHaveAttribute('data-narrow', 'true');
  await expect(commit).toHaveClass(/commit-bar/);
  let listBox = await list.boundingBox();
  let commitBox = await commit.boundingBox();
  if (!listBox || !commitBox) throw new Error('The list and the commit bar have no boxes');
  expect(commitBox.x).toBeCloseTo(listBox.x, 0);
  expect(commitBox.width).toBeCloseTo(listBox.width, 0);
  expect(commitBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
  await expect(view.getByRole('region', { name: changes.notSynced.title })).toHaveCount(0);
  expect(await blockingViolations(page)).toEqual([]);

  // Wide: the commit box and Not synced in the lane beside the list.
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'wide');
  await expect(changesView).not.toHaveAttribute('data-narrow', 'true');
  await expect(commit).toHaveClass(/commit-box/);
  await expect(view.getByRole('region', { name: changes.notSynced.title })).toBeVisible();
  listBox = await list.boundingBox();
  commitBox = await commit.boundingBox();
  if (!listBox || !commitBox) throw new Error('The list and the commit box have no boxes');
  expect(commitBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
});
