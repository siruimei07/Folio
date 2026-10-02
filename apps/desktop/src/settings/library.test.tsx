// Library settings → the frame, Library, File types and Ignore rules pages (app-shell handoff §9;
// ipc-m1 §13, §22.2) against the fake shell: pages and focus, the folder with Change…, the
// semester, rebuilding the index, and saving ignore rules with their validation and failures.
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useNavigation } from '../app/navigation';
import { useFirstRun } from '../app/startFlow';
import { useSession } from '../data/session';
import { LIMITS } from '../ipc';
import { folderChoice, smallLibraryWith } from '../test/fixtures';
import { toastTexts } from '../test/render';
import { renderSettings, settingsDialog } from './test/render';

describe('Library settings', () => {
  it('opens on the Library page with focus on its item, moves between pages with the arrows, and closes with Esc', async () => {
    const { user } = renderSettings('librarySettings', undefined);
    const dialog = await screen.findByRole('dialog', { name: 'Library settings' });
    const library = within(dialog).getByRole('tab', { name: 'Library' });
    await waitFor(() => {
      expect(library).toHaveFocus();
    });
    expect(library).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(within(dialog).getByRole('tab', { name: 'Courses' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(useNavigation.getState().dialog).toBeNull();
  });

  it('opens on the page it is asked for', async () => {
    renderSettings('librarySettings', { page: 'tags' });
    const dialog = await screen.findByRole('dialog', { name: 'Library settings' });
    expect(within(dialog).getByRole('tab', { name: 'Tags' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(dialog).findByRole('heading', { name: 'Tags', level: 4 })).toBeInTheDocument();
  });

  it('shows the library folder read-only, and Change… hands the chosen folder to the first run', async () => {
    const fixture = { ...smallLibraryWith(), folderChoices: [folderChoice('library')] };
    const { user } = renderSettings('librarySettings', undefined, { fixture });
    const field = await screen.findByRole('textbox', { name: 'Library folder' });
    expect(field).toHaveValue('E:\\University of Toronto');
    expect(field).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Change…' }));
    await waitFor(() => {
      expect(useFirstRun.getState().flow).toMatchObject({ page: 'folder', intent: 'change' });
    });
    expect(useNavigation.getState().dialog).toBeNull();
    act(() => {
      useFirstRun.setState({ flow: null });
    });
  });

  it('keeps the dialog when the folder dialog is cancelled, and says so when it fails', async () => {
    const { user, shell } = renderSettings('librarySettings', undefined);
    const change = await screen.findByRole('button', { name: 'Change…' });
    shell.setFailure('pick_library_folder', 'Internal');
    await user.click(change);
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't open the folder dialog — "))).toBe(true);
    });
    expect(useFirstRun.getState().flow).toBeNull();
    expect(settingsDialog('Library settings')).toBeInTheDocument();
  });

  it('makes the chosen semester the current one', async () => {
    const { user } = renderSettings('librarySettings', undefined);
    const semester = await screen.findByRole('button', { name: /Semester/ });
    await user.click(semester);
    await user.click(await screen.findByRole('option', { name: 'Winter 2026' }));
    const { libraryId, semesters } = useSession.getState();
    expect(semesters[libraryId ?? '']).toBe('Winter 2026');
    expect(screen.getByRole('option', { hidden: true, name: 'Fall 2025 (archived)' })).toBeInTheDocument();
  });

  it('rebuilds the search index, says it runs, then how it ended', async () => {
    const { user } = renderSettings('librarySettings', undefined);
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    expect(await screen.findByText(/Rebuilding the search index/)).toBeInTheDocument();
    expect(await screen.findByText(/Rebuilt the search index with \d+ items\./, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeEnabled();
  });

  it('says why a rebuild could not start', async () => {
    const { user, shell } = renderSettings('librarySettings', undefined);
    shell.setFailure('rebuild_catalog', 'NoLibrary');
    await user.click(await screen.findByRole('button', { name: 'Rebuild' }));
    expect(await screen.findByText(/Couldn't start the rebuild\./)).toBeInTheDocument();
  });

  it('says where deleted files go', async () => {
    renderSettings('librarySettings', undefined);
    expect(await screen.findByText('Move to the Recycle Bin')).toBeInTheDocument();
  });
});

describe('Library settings → File types', () => {
  it('shows examples of each kind and the 10 MB rule, read-only', async () => {
    renderSettings('librarySettings', { page: 'fileTypes' });
    const full = await screen.findByRole('list', { name: 'Examples of files with full versions' });
    expect(within(full).getByText('.docx')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Examples of files with the latest copy only' })).getByText('.pdf')).toBeInTheDocument();
    expect(screen.getByText(/Text files larger than 10 MB/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add type/ })).toBeNull();
  });
});

describe('Library settings → Ignore rules', () => {
  it('saves new rules, says Folio checks the library again, and keeps them', async () => {
    const { user, shell } = renderSettings('librarySettings', { page: 'ignore' });
    const field = await screen.findByRole('textbox', { name: 'Patterns' });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(field, '*.log{Enter}build/');
    expect(screen.getByText('Not saved yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved. Folio is checking your library again.')).toBeInTheDocument();
    expect(shell.library.ignoreRules).toBe('*.log\nbuild/\n');
    expect(field).toHaveValue('*.log\nbuild/\n');
  });

  it('names the lines scans skip', async () => {
    const { user } = renderSettings('librarySettings', { page: 'ignore' });
    const field = await screen.findByRole('textbox', { name: 'Patterns' });
    await user.type(field, '*.log{Enter}[[z-a]');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Line 2 isn't a valid pattern, so Folio skips it.")).toBeInTheDocument();
    expect(field).toHaveAccessibleDescription(/Line 2/);
  });

  it('flags rules over the limit and sends nothing', async () => {
    const { user, shell } = renderSettings('librarySettings', { page: 'ignore' });
    const field = await screen.findByRole('textbox', { name: 'Patterns' });
    await user.click(field);
    await user.paste('x'.repeat(LIMITS.ignoreRulesChars + 3));
    expect(screen.getByText(/Ignore rules can be up to 65,536 characters\. Remove 3\./)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(shell.library.ignoreRules).toBe('');
  });

  it('keeps the text and says why when a save fails, and Undo changes puts the saved rules back', async () => {
    const { user, shell } = renderSettings('librarySettings', { page: 'ignore' });
    const field = await screen.findByRole('textbox', { name: 'Patterns' });
    shell.setFailure('set_ignore_rules', 'AccessDenied');
    await user.type(field, '*.tmp');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the ignore rules");
    expect(field).toHaveValue('*.tmp');
    await user.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(field).toHaveValue('');
  });

  it('keeps what was typed while another page shows', async () => {
    const { user } = renderSettings('librarySettings', { page: 'ignore' });
    await user.type(await screen.findByRole('textbox', { name: 'Patterns' }), '*.bak');
    await user.click(screen.getByRole('tab', { name: 'Tags' }));
    await user.click(screen.getByRole('tab', { name: 'Ignore rules' }));
    expect(screen.getByRole('textbox', { name: 'Patterns' })).toHaveValue('*.bak');
  });

  it('shows the state block with Try again when the rules cannot be read', async () => {
    renderSettings('librarySettings', { page: 'ignore' }, { fail: [{ command: 'get_ignore_rules', code: 'FileSystem' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load the ignore rules" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument();
  });

  it('shows what Folio leaves out by default', async () => {
    const { user } = renderSettings('librarySettings', { page: 'ignore' });
    await user.click(await screen.findByText('What Folio leaves out by default'));
    expect(screen.getByLabelText("Folio's default ignore rules")).toHaveTextContent('node_modules/');
  });
});
