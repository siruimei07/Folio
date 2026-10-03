import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import firstRun from '../../apps/desktop/src/i18n/locales/en/first-run.json' with { type: 'json' };
import type { Job } from '../../apps/desktop/src/ipc/bindings';
import { blockingViolations, createLibrary, expect, invoke, test } from '../fixtures';

// "Discard move" on the real shell (first-run handoff §7, ipc-m1 §6): a library that a move
// stopped halfway in opens to the unavailable screen; the alert dialog asks first, Cancel and Esc
// change nothing, and discarding opens the library without touching the user's file. The
// journal is the one the shell's own tests leave behind (folio-app `library/tests.rs`): a move
// of `s/a.md` that the catalog no longer knows, so Folio can neither finish nor undo it.

test.use({ libraryFolder: true });

const UNFINISHED_MOVE = JSON.stringify({
  format_version: 3,
  id: 'interrupted',
  before: [],
  after: [],
  intent: {
    from: 's/a.md',
    to: 's/b.md',
    entries: [
      {
        id: 999999,
        from: 's/a.md',
        to: 's/b.md',
        kind: 'file',
        class: 'text',
        size: 0,
        mtime_ns: null,
        file_id: null,
        hash: null,
        added_ns: 1,
        disk: { size: 0, modified_ns: null, created_ns: null, file_id: null },
      },
    ],
  },
});

const USER_FILE = "the user's file";

test('discards a move that did not finish, after asking, and opens the library', async ({ folio }) => {
  test.setTimeout(120_000);
  const { page, libraryDir } = folio;
  if (!libraryDir) throw new Error('This test requires the isolated library-folder fixture');
  const userFile = path.join(libraryDir, 's', 'a.md');
  await mkdir(path.dirname(userFile), { recursive: true });
  await writeFile(userFile, USER_FILE);
  const { scan } = await createLibrary(page);
  // Every job has finished (the scan and the hashing after it), so nothing journals over the move.
  await expect
    .poll(async () => {
      const jobs = await invoke<Job[]>(page, 'list_jobs');
      return jobs.some((job) => job.id === scan) && jobs.every((job) => job.status.state === 'done');
    })
    .toBe(true);

  const journal = path.join(libraryDir, '.folio', 'local', 'journal', 'scan.json');
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, UNFINISHED_MOVE);
  const restarted = await folio.restart();

  // The status may answer `open` first; the reason follows as LibraryStateChanged (ipc-m1 §6).
  const title = restarted.getByRole('heading', { level: 1, name: firstRun.unavailable.unfinishedMove.title });
  await expect(title).toBeFocused();
  const discard = restarted.getByRole('button', { name: firstRun.unavailable.discard.action });
  await expect(discard).toHaveAttribute('data-variant', 'accent');
  expect(await blockingViolations(restarted)).toEqual([]);

  // The alert dialog: named by its title, described by what goes and what stays, Cancel focused.
  await discard.click();
  const dialog = restarted.getByRole('alertdialog', { name: firstRun.unavailable.discard.title });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(firstRun.unavailable.discard.text);
  await expect(dialog.getByRole('button', { name: firstRun.unavailable.discard.cancel })).toBeFocused();
  expect(await blockingViolations(restarted)).toEqual([]);

  // Esc changes nothing, and focus goes back to the button.
  await restarted.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(discard).toBeFocused();
  expect(await readFile(journal, 'utf8')).toBe(UNFINISHED_MOVE);

  // With reduced motion, the dialog and its scrim appear at once.
  await restarted.emulateMedia({ reducedMotion: 'reduce' });
  await restarted.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  const timing = await restarted.evaluate<string[]>(`[
    getComputedStyle(document.querySelector('.modal')).animationDuration,
    getComputedStyle(document.querySelector('.modal-overlay')).animationDuration,
  ]`);
  expect(timing.every((value) => value.split(', ').every((part) => part === '0s'))).toBe(true);
  await restarted.emulateMedia({ reducedMotion: null });

  await dialog.getByRole('button', { name: firstRun.unavailable.discard.confirm }).click();
  await expect(restarted.getByRole('navigation')).toBeVisible();
  // The record of the move went (the start-up scan may keep a journal of its own there), and the
  // user's file is where it was, as it was.
  await expect.poll(async () => (await readFile(journal, 'utf8').catch(() => '')).includes('interrupted')).toBe(false);
  expect(await readFile(userFile, 'utf8')).toBe(USER_FILE);
});
