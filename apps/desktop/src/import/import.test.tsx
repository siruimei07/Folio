// The import dialog, its toasts and its result (library-actions handoff §4, §5) against the fake
// shell: every state of the dialog, the clash policy, the originals, the single-use selection, the
// errors that keep the dialog open, progress, cancelling, and "Details".
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useJobNotes } from '../app/activity/notes';
import { openDialog } from '../app/navigation';
import type { Job } from '../ipc';
import { toastTexts } from '../test/render';
import { CSC, file, MAT, renderImport } from './test/render';

const dialog = () => screen.findByRole('dialog', { name: /^Add files/ });

describe('import dialog', () => {
  it('shows what is added, where and how, adds with the defaults on Enter, and closes for the toast', async () => {
    const { user, open, shell, refAt } = renderImport();
    open(refAt(CSC), { tags: ['notes'] });
    const found = await screen.findByRole('dialog', { name: 'Add files to CSC148' });
    const items = within(found).getByRole('list', { name: 'Items to add' });
    expect(within(items).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Lecture 05 - Gradients.pdf',
      'hw3.py',
      'Lab 2Folder',
    ]);
    expect(await within(found).findByText('4 files in 1 folder · 3.1 MB')).toBeInTheDocument();
    expect(within(found).getByText(/^2 items are left out: your ignore rules skip them/)).toBeInTheDocument();
    expect(within(found).getByRole('button', { name: /^Add to CSC148/ })).toBeInTheDocument();
    expect(within(found).getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(found).getByRole('button', { name: 'Slides' })).toHaveAttribute('aria-pressed', 'false');
    // One name is taken: Keep both is chosen, and says what the copy is called.
    const clashes = within(found).getByRole('group', { name: 'A name is already taken in CSC148.' });
    expect(within(clashes).getByText('hw3.py')).toBeInTheDocument();
    expect(within(clashes).getByRole('radio', { name: 'Keep both' })).toBeChecked();
    expect(within(clashes).getByRole('radio', { name: 'Keep both' })).toHaveAccessibleDescription(
      'The new file gets a number: hw3 (2).py.',
    );
    expect(within(found).getByRole('checkbox', { name: 'Move the originals to the Recycle Bin after copying' })).not.toBeChecked();
    const add = within(found).getByRole('button', { name: 'Add 4 files' });
    await waitFor(() => {
      expect(add).toHaveFocus();
    });

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(toastTexts()).toEqual(['Added 4 files to CSC148 — 1 kept as a copy · 2 skipped']);
    });
    expect(shell.library.at(`${CSC}/hw3 (2).py`)?.tags).toEqual(['notes']);
    expect(Object.values(useJobNotes.getState().imports)).toMatchObject([{ target: refAt(CSC), label: 'CSC148', files: 4 }]);
  });

  it('says "Checking…" and waits with the primary button until the check answers', async () => {
    const { open } = renderImport({ latencyMs: 200 });
    open();
    const found = await dialog();
    expect(within(found).getByText('Checking…')).toBeInTheDocument();
    const add = within(found).getByRole('button', { name: 'Add files' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(await within(found).findByRole('button', { name: 'Add 4 files' })).toBeInTheDocument();
  });

  it('replaces, or skips, every clash with the one choice, and recycles the originals when asked', async () => {
    const { user, open, shell } = renderImport();
    open();
    const found = await dialog();
    await user.click(await within(found).findByRole('radio', { name: 'Replace' }));
    await user.click(within(found).getByRole('checkbox', { name: /^Move the originals/ }));
    await user.click(within(found).getByRole('button', { name: 'Add 4 files' }));
    await waitFor(() => {
      expect(toastTexts()).toEqual([
        'Added 4 files to CSC148 — 1 replaced · 2 skipped · originals moved to the Recycle Bin',
      ]);
    });
    expect(shell.library.at(`${CSC}/hw3 (2).py`)).toBeUndefined();
  });

  it('asks where the files go when there is no target, and checks once one is chosen', async () => {
    const { user, open } = renderImport();
    open(null);
    const found = await dialog();
    expect(found).toHaveAccessibleName('Add files');
    expect(within(found).queryByText(/files in/)).not.toBeInTheDocument();
    expect(within(found).getByRole('button', { name: 'Add files' })).toBeDisabled();
    await user.click(within(found).getByRole('button', { name: /^Add to Choose a course or folder/ }));
    await user.click(await screen.findByRole('button', { name: `Pick ${MAT}` }));
    expect(found).toHaveAccessibleName('Add files to MAT232');
    expect(await within(found).findByText('4 files in 1 folder · 3.1 MB')).toBeInTheDocument();
    expect(within(found).queryByRole('group', { name: /already taken/ })).not.toBeInTheDocument();
    expect(within(found).getByRole('button', { name: 'Add 4 files' })).toBeEnabled();
  });

  it('has nothing to add when everything is left out', async () => {
    const { open } = renderImport();
    open(undefined, {
      script: { names: [{ name: 'node_modules', kind: 'folder' }], items: [{ path: 'node_modules', kind: 'folder', size: '0' }, file('node_modules/x.js')] },
    });
    const found = await dialog();
    expect(await within(found).findByRole('button', { name: 'Nothing to add' })).toBeDisabled();
    expect(within(found).getByText(/^2 items are left out/)).toBeInTheDocument();
  });

  it('lists three items, then the fourth by name or how many more', async () => {
    const { open } = renderImport();
    const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    open(undefined, { script: { names: names.slice(0, 4).map((name) => ({ name, kind: 'file' as const })), items: names.slice(0, 4).map((name) => file(name)) } });
    expect(within(await dialog()).getByText('and d.md')).toBeInTheDocument();
  });

  it('turns tags off in a read-only library, with the reason', async () => {
    const { open } = renderImport({ scenario: 'read-only' });
    open(undefined, { tags: ['notes'] });
    const found = await dialog();
    const notes = await within(found).findByRole('button', { name: 'Notes' });
    expect(notes).toBeDisabled();
    expect(notes).toHaveAttribute('aria-pressed', 'false');
    expect(within(found).getByText("Tags can't be added until you update Folio.")).toBeInTheDocument();
  });
});

describe('import dialog errors', () => {
  it('asks for the files again when the selection expired, and checks the new one', async () => {
    const { user, open, shell } = renderImport();
    const source = open();
    const found = await dialog();
    const add = await within(found).findByRole('button', { name: 'Add 4 files' });
    // Used up meanwhile (it lasts 10 minutes and is single use): Add finds it expired.
    shell.choice(source.token, 'import', true);
    await user.click(add);
    expect(await within(found).findByText('Choose or drop the files again')).toBeInTheDocument();
    // The expired selection is never sent again.
    expect(add).toBeDisabled();
    const choose = within(found).getByRole('button', { name: 'Choose files…' });
    await waitFor(() => {
      expect(choose).toHaveFocus();
    });
    await user.click(choose);
    await waitFor(() => {
      expect(within(found).queryByText('Choose or drop the files again')).not.toBeInTheDocument();
    });
    expect(await within(found).findByRole('button', { name: 'Add 4 files' })).toBeEnabled();
  });

  it('offers another place when the target is gone', async () => {
    const { user, open, refAt } = renderImport();
    open({ ...refAt(CSC), id: '99999' });
    const found = await dialog();
    await user.click(await within(found).findByRole('button', { name: 'Choose a place' }));
    await user.click(await screen.findByRole('button', { name: `Pick ${MAT}` }));
    expect(await within(found).findByRole('button', { name: 'Add 4 files' })).toBeEnabled();
  });

  it('adds without tags after ReadOnly, stays open for Busy, and offers details for a failed check', async () => {
    const { user, open, shell } = renderImport();
    open(undefined, { tags: ['notes'] });
    let found = await dialog();
    shell.setFailure('import_files', 'ReadOnly');
    await user.click(await within(found).findByRole('button', { name: 'Add 4 files' }));
    expect(await within(found).findByText("Tags can't be added right now")).toBeInTheDocument();
    shell.setFailure('import_files', null);
    // The banner's button, before the footer's.
    const [fromBanner] = within(found).getAllByRole('button', { name: 'Add 4 files' });
    if (fromBanner === undefined) throw new Error('No Add button in the banner');
    await user.click(fromBanner);
    await waitFor(() => {
      expect(toastTexts()[0]).toMatch(/^Added 4 files to CSC148/);
    });
    expect(shell.library.at(`${CSC}/Lecture 05 - Gradients.pdf`)?.tags).toEqual([]);

    open();
    found = await dialog();
    shell.setFailure('import_files', 'Busy');
    await user.click(await within(found).findByRole('button', { name: 'Add 4 files' }));
    expect(await within(found).findByText('Folio is rebuilding its index')).toBeInTheDocument();
    await user.click(within(found).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    shell.setFailure('import_files', null);

    shell.setFailure('check_import', 'Internal');
    open();
    found = await dialog();
    expect(await within(found).findByText("Folio couldn't check these files")).toBeInTheDocument();
    expect(within(found).getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
  });
});

describe('import toasts', () => {
  it('shows progress with Cancel, and a cancelled import says how far it got', async () => {
    const { user, open } = renderImport({ jobStepMs: 60 });
    open();
    const found = await dialog();
    await user.click(await within(found).findByRole('button', { name: 'Add 4 files' }));
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      // Running: the shell counted the files.
      expect(toastTexts()[0]).toMatch(/^Adding 4 files to CSC148 — \d of 4/);
    });
    await user.click(await within(toasts).findByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(toastTexts()[0]).toMatch(/^Stopped adding files to CSC148 — \d of 4 (was|were) added before you stopped\.$/);
    });
  });

  it('keeps the job running when its progress is hidden, and still shows the result', async () => {
    const { user, open } = renderImport({ jobStepMs: 60 });
    open();
    await user.click(await within(await dialog()).findByRole('button', { name: 'Add 4 files' }));
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    await user.click(await within(toasts).findByRole('button', { name: 'Hide' }));
    await waitFor(() => {
      expect(toastTexts()).toEqual(['Added 4 files to CSC148 — 1 kept as a copy · 2 skipped']);
    });
  });
});

describe('import result', () => {
  const failure = (name: string, code: string) => ({ name, error: { code, detail: 'test' } }) as const;

  it('lists every file that was not added with why, and says when the shell listed only some', async () => {
    renderImport();
    const job = {
      id: 'job',
      kind: 'import',
      cancellable: true,
      status: {
        state: 'done',
        result: {
          kind: 'import',
          imported: 10,
          replaced: 0,
          renamed: 0,
          skipped: 0,
          originalsDeleted: 0,
          failures: [failure('Week 7/Problem 2.pdf', 'InUse'), failure('notes:v2.md', 'NameInvalidCharacter'), failure('big.zip', 'DiskFull')],
          failureCount: 5,
        },
      },
    } as Job;
    openDialog('importResult', { job, target: 'CSC207' });
    const found = await screen.findByRole('dialog', { name: "5 files weren't added" });
    const list = within(found).getByRole('list', { name: "Files that weren't added" });
    expect(within(list).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Week 7/Problem 2.pdfAnother app is using it.',
      "notes:v2.mdIts name isn't allowed on Windows.",
      'big.zipThe disk is full.',
    ]);
    expect(within(found).getByText('Folio lists the first 3 of 5.')).toBeInTheDocument();
    expect(within(found).getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  it('says why an import failed as a whole', async () => {
    renderImport();
    const job: Job = { id: 'job', kind: 'import', cancellable: false, status: { state: 'failed', error: { code: 'DiskFull', detail: 'full' } } };
    openDialog('importResult', { job, target: 'MAT232' });
    const found = await screen.findByRole('dialog', { name: "Couldn't add files to MAT232" });
    expect(within(found).getByText(/^The disk is full\./)).toBeInTheDocument();
  });
});
