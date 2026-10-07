import errors from '../../apps/desktop/src/i18n/locales/en/errors.json' with { type: 'json' };
import history from '../../apps/desktop/src/i18n/locales/en/history.json' with { type: 'json' };
import library from '../../apps/desktop/src/i18n/locales/en/library.json' with { type: 'json' };
import preview from '../../apps/desktop/src/i18n/locales/en/preview.json' with { type: 'json' };
import shell from '../../apps/desktop/src/i18n/locales/en/shell.json' with { type: 'json' };
import {
  blockingViolations,
  countCalls,
  expect,
  FILE_COURSE,
  openLibraryWithAFile,
  rejection,
  test,
  treeRow,
} from '../fixtures';

// The History view on the real shell (workspace-history handoff §7, §10, §12.4; ipc-m2 §8). The
// workspace commands answer (feat/core-workspace); `start_history`, `commit` and the history
// commands (`list_history`, `list_file_history`, `list_commit_changes`, `get_commit`,
// `reword_commit`, `uncommit`, `plan_restore`, `restore_version`) are planned stubs until
// feat/core-commit-history and feat/core-diff-restore register them, so each answers "not allowed"
// (a Transport error). A new library has no history: `get_workspace` says `none`, Folio starts the
// first commit by itself, and its refused start shows the first commit's block "Couldn't start
// your history" with Try again and Copy details in place of the History panel, whatever History was
// asked for: the Library preview's "View history of this file" shows it too, without the file's
// chip, and the block takes the focus the hidden Library's button had. The timeline and its states,
// its cards and diffs, one file's history with its chip and Esc, restore, Edit message and Undo
// commit run on the fake shell in apps/desktop/src/history/**/*.test.tsx. Strings run in the page
// because this package has no DOM types.
//
// For feat/core-commit-history: once `start_history`, `commit` and the history commands answer,
// replace the refused start with the real flow over a committed library: the first commit's entry
// ("Start history"), a commit's entry with its file card, Edit message (the dialog, Ctrl+Enter, the
// toast with the new short id) and Undo commit (the toast, the "Undid commit" entry), Tab from an
// entry reaching its Edit message and Undo commit and Esc in the dialog giving the focus back to
// Edit message (the stylesheet that keeps the unseen buttons focusable applies only here), the Library
// preview's "View history of this file" → the chip → Esc back at the same scroll position, the
// timeline's load failure with Try again and Copy details (a history command refused), and axe over
// the timeline. For feat/core-diff-restore: a version's diff beside the card and Restore with its
// confirmation and toast ("Show in Changes").

test.use({ libraryFolder: true });

/** The first commit's failure, as the refused `start_history` shows it in the view. */
const startFailed = shell.firstCommit.failed.text.replace('{{reason}}', errors.Transport);

test('shows History from the rail and Ctrl+3, with the first commit refused, Try again and Copy details, and passes axe', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  const startCalls = countCalls(page, 'start_history');
  await openLibraryWithAFile(page, libraryDir);
  // The workspace answers: the history's state is known (`none`), so History shows the first
  // commit's block, not the timeline.
  expect(await rejection(page, 'get_workspace')).toBeNull();
  const rail = page.getByRole('navigation', { name: shell.rail.label });
  const libraryButton = rail.getByRole('button', { name: shell.rail.library, exact: true });
  const historyButton = rail.getByRole('button', { name: shell.rail.history, exact: true });
  await expect(historyButton).toBeVisible();
  await expect(libraryButton).toHaveAttribute('aria-current', 'page');

  // Focus opens the rail button's tooltip with its shortcut; check it before any key, which closes it.
  await historyButton.focus();
  await expect(page.getByRole('tooltip')).toContainText(shell.rail.history);
  await expect(page.getByRole('tooltip')).toContainText('Ctrl+3');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();

  // Ctrl+3 shows History, Ctrl+1 the Library again, and the rail button History.
  await page.keyboard.press('Control+3');
  await expect(historyButton).toHaveAttribute('aria-current', 'page');
  const view = page.getByRole('main');
  const title = view.getByRole('heading', { level: 2, name: history.title, exact: true });
  await expect(title).toBeVisible();
  await page.keyboard.press('Control+1');
  await expect(libraryButton).toHaveAttribute('aria-current', 'page');
  await expect(view.getByRole('region', { name: library.panel.title })).toBeVisible();
  await expect(title).toBeHidden();
  await historyButton.click();
  await expect(historyButton).toHaveAttribute('aria-current', 'page');
  await expect(title).toBeVisible();

  // The history has not started and cannot: the first commit's block says why, with Try again and
  // Copy details; no timeline, type filter or diff column before the history has started.
  await expect(view.getByRole('heading', { name: shell.firstCommit.failed.title })).toBeVisible();
  await expect(view.getByText(startFailed)).toBeVisible();
  const tryAgain = view.getByRole('button', { name: shell.tryAgain });
  await expect(tryAgain).toBeVisible();
  await expect(view.getByRole('button', { name: shell.copyDetails.action })).toBeVisible();
  await expect(view.getByRole('feed')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /^Filter by type: / })).toHaveCount(0);
  await expect(view.getByText(history.diff.empty)).toHaveCount(0);
  await expect.poll(startCalls).toBeGreaterThan(0);
  expect(await blockingViolations(page)).toEqual([]);

  // Try again from the keyboard starts it again; the command is still a stub, so the failure comes
  // back. The start moves the focus to the block, since its button goes while it waits.
  const before = startCalls();
  await tryAgain.focus();
  await page.keyboard.press('Enter');
  await expect.poll(startCalls).toBeGreaterThan(before);
  await expect(view.getByText(startFailed)).toBeVisible();
  await expect(tryAgain).toBeVisible();
  await expect(view.locator('.first-commit')).toBeFocused();
});

test("opens History from the Library preview's View history of this file onto the first commit's block, which takes the focus", async ({
  folio,
}) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  await openLibraryWithAFile(page, libraryDir);
  expect(await rejection(page, 'get_workspace')).toBeNull();

  await treeRow(page, FILE_COURSE).click();
  await treeRow(page, 'notes.md').click();
  const pane = page.getByRole('group', { name: preview.label.replace('{{name}}', 'notes.md') });
  await expect(pane).toBeVisible();
  const viewHistory = pane.getByRole('button', { name: preview.header.history });
  await viewHistory.focus();
  await page.keyboard.press('Enter');

  const rail = page.getByRole('navigation', { name: shell.rail.label });
  await expect(rail.getByRole('button', { name: shell.rail.history, exact: true })).toHaveAttribute('aria-current', 'page');
  const view = page.getByRole('main');
  // Before the history has started, History shows the first commit's block whatever it was asked
  // for, without the chip; the block has the focus the Library's button had (WCAG 2.4.3).
  await expect(view.getByRole('heading', { name: shell.firstCommit.failed.title })).toBeVisible();
  await expect(view.getByRole('button', { name: history.file.showWhole })).toHaveCount(0);
  await expect(view.locator('.first-commit')).toBeFocused();
  expect(await blockingViolations(page)).toEqual([]);
});
