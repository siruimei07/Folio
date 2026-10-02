// The welcome screen and step 1 (first-run handoff §3, §4): every folder of §4.2, the cloud
// warning, the name field's messages (§8) and every failure of §4.4.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import copy from '../i18n/locales/en/first-run.json';
import shellCopy from '../i18n/locales/en/shell.json';
import errors from '../i18n/locales/en/errors.json';
import type { AppError } from '../ipc';
import { folderChoice, startFixture } from '../test/fixtures';
import { LIBRARY_VIEW, pageHeading, renderStart, toastTexts } from './test/render';

function footerButtons(): string[] {
  const footer = document.querySelector('.step__footer');
  if (!(footer instanceof HTMLElement)) throw new Error('no footer');
  return within(footer)
    .getAllByRole('button')
    .map((button) => button.textContent);
}

describe('welcome', () => {
  it('shows the title, the two ways to start and the link, with focus on the first card', async () => {
    renderStart({ fixture: startFixture('first-run') });

    expect(pageHeading()).toHaveTextContent(copy.welcome.title);
    const card = screen.getByRole('button', { name: copy.welcome.newLibrary.title });
    expect(card).toHaveAccessibleDescription(copy.welcome.newLibrary.text);
    expect(screen.getByRole('button', { name: copy.welcome.existing.title })).toHaveAccessibleDescription(
      copy.welcome.existing.text,
    );
    expect(screen.getByRole('button', { name: copy.welcome.open })).toBeInTheDocument();
    expect(screen.getByText(copy.welcome.footer)).toBeInTheDocument();
    await waitFor(() => {
      expect(card).toHaveFocus();
    });
    expect(document.title).toBe(copy.documentTitle.welcome);
  });

  it('stays when the folder dialog is cancelled, with focus back on what opened it', async () => {
    const { user } = renderStart({ fixture: startFixture('first-run', { choices: [null] }) });
    const card = screen.getByRole('button', { name: copy.welcome.existing.title });
    await user.click(card);

    await waitFor(() => {
      expect(card).toHaveFocus();
    });
    expect(pageHeading()).toHaveTextContent(copy.welcome.title);
  });

  it('opens a library at once from "Open your library…", without step 1', async () => {
    const { user } = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice('library')] }) });
    await user.click(screen.getByRole('button', { name: copy.welcome.open }));

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
  });

  it('says a folder without a library is not one after "Open your library…", and Back returns', async () => {
    const { user } = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice('empty')] }) });
    await user.click(screen.getByRole('button', { name: copy.welcome.open }));

    expect(await screen.findByRole('heading', { level: 1, name: copy.folder.notALibrary.title })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(copy.errors.notALibrary.title);
    expect(screen.queryByLabelText(copy.name.label)).toBeNull();
    expect(footerButtons()).toEqual([copy.step.back, copy.step.chooseAnother]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: copy.step.chooseAnother })).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: copy.step.back }));
    expect(pageHeading()).toHaveTextContent(copy.welcome.title);
  });

  it('shows step 1 with an error when the library found that way does not open', async () => {
    const { user } = renderStart({
      fixture: startFixture('first-run', { choices: [folderChoice('library')] }),
      fail: [{ command: 'open_library', code: 'NewerFormat' }],
    });
    await user.click(screen.getByRole('button', { name: copy.welcome.open }));

    expect(await screen.findByRole('heading', { level: 1, name: copy.folder.library.title })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(copy.errors.newerFormat.title);
  });

  it('says when the folder does not match the card that was chosen', async () => {
    const first = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice('folders')] }) });
    await first.user.click(screen.getByRole('button', { name: copy.welcome.newLibrary.title }));
    expect(await screen.findByText(copy.folder.notEmpty)).toBeInTheDocument();
    first.unmount();

    const second = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice('empty')] }) });
    await second.user.click(screen.getByRole('button', { name: copy.welcome.existing.title }));
    expect(await screen.findByText(copy.folder.isEmpty)).toBeInTheDocument();
  });

  it('shows an error toast when the folder dialog fails', async () => {
    const { user } = renderStart({
      fixture: startFixture('first-run'),
      fail: [{ command: 'pick_library_folder', code: 'Internal' }],
    });
    await user.click(screen.getByRole('button', { name: copy.welcome.newLibrary.title }));

    await waitFor(() => {
      expect(toastTexts()).toEqual([`${copy.pickFailed} — ${errors.Internal}`]);
    });
    expect(pageHeading()).toHaveTextContent(copy.welcome.title);
  });
});

/** Step 1 for a folder of `kind`, reached from "Start a new library". */
async function stepOne(kind: Parameters<typeof folderChoice>[0], options: Parameters<typeof renderStart>[0] = {}, sync: Parameters<typeof folderChoice>[1] = null) {
  const rendered = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice(kind, sync)] }), ...options });
  await rendered.user.click(screen.getByRole('button', { name: copy.welcome.newLibrary.title }));
  await screen.findByText(copy.step.one);
  return rendered;
}

describe('step 1', () => {
  it('starts a new library in an empty folder, its name selected', async () => {
    const { user } = await stepOne('empty');

    expect(pageHeading()).toHaveTextContent(copy.folder.empty.title);
    expect(screen.getByText(copy.folder.empty.intro)).toBeInTheDocument();
    expect(screen.getByText(copy.folder.empty.meta)).toBeInTheDocument();
    expect(screen.getByText(copy.folder.empty.note)).toBeInTheDocument();
    const name = screen.getByLabelText<HTMLInputElement>(copy.name.label);
    expect(name).toHaveValue('Folio');
    expect(name).toHaveFocus();
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 5]);
    expect(name).toHaveAccessibleDescription(copy.name.help);
    expect(document.title).toBe(`${copy.folder.empty.title} — Folio`);
    expect(footerButtons()).toEqual([copy.step.back, copy.folder.empty.submit]);

    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.courses.title })).toBeInTheDocument();
  });

  it('takes over a folder with content: the map, the top-level files and step 2 to check', async () => {
    const { user } = await stepOne('folders');

    expect(pageHeading()).toHaveTextContent(copy.folder.folders.title);
    expect(screen.getByText('4 folders and 1 file at the top level')).toBeInTheDocument();
    const map = screen.getByRole('figure', { name: copy.folder.map.label });
    expect(within(map).getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'UniversityLibrary · the folder you chose',
      'Fall 2026Semester · each folder at the top',
      'Calculus of Several VariablesCourse · each folder in a semester',
      'Problem setsFolder · anything deeper',
    ]);
    expect(screen.getByText(copy.folder.topFiles_one)).toBeInTheDocument();
    expect(screen.getByText(copy.folder.folders.note)).toBeInTheDocument();
    expect(screen.getByLabelText(copy.name.label)).toHaveValue('University');

    await user.click(screen.getByRole('button', { name: copy.folder.folders.submit }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.review.title })).toBeInTheDocument();
  });

  it('opens a folder that is already a library', async () => {
    const { user } = await stepOne('library');

    expect(pageHeading()).toHaveTextContent(copy.folder.library.title);
    expect(screen.getByText('Folio library “University of Toronto”')).toBeInTheDocument();
    expect(screen.getByText(copy.folder.library.bannerTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.name.label)).toBeNull();
    expect(footerButtons()).toEqual([copy.step.chooseAnother, copy.folder.library.submit]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: copy.folder.library.submit })).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: copy.folder.library.submit }));
    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
  });

  it('refuses a folder inside a library and names that library', async () => {
    await stepOne('insideLibrary');

    expect(pageHeading()).toHaveTextContent(copy.folder.insideLibrary.title);
    expect(screen.getByText(copy.folder.insideLibrary.meta)).toBeInTheDocument();
    expect(
      screen.getByText(
        'E:\\University of Toronto is a Folio library, and a library can\'t hold another one. Choose that folder to open it, or a folder outside it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(copy.name.label)).toBeNull();
    expect(footerButtons()).toEqual([copy.step.back, copy.step.chooseAnother]);
  });

  it('finishes an incomplete library, keeping what it has', async () => {
    const { user } = await stepOne('incomplete');

    expect(pageHeading()).toHaveTextContent(copy.folder.incomplete.title);
    expect(screen.getByText("Setup didn't finish · 4 folders and 1 file at the top level")).toBeInTheDocument();
    expect(screen.getByText(copy.folder.incomplete.bannerTitle)).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: copy.folder.map.label })).toBeInTheDocument();
    expect(screen.getByLabelText(copy.name.label)).toHaveValue('Courses');

    await user.click(screen.getByRole('button', { name: copy.folder.incomplete.submit }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.review.title })).toBeInTheDocument();
  });

  it('warns about a cloud folder, and "Use it anyway" goes on', async () => {
    const { user } = await stepOne('empty', {}, 'iCloud');

    expect(screen.getByText(copy.folder.sync.iCloud)).toBeInTheDocument();
    expect(screen.getByText(copy.folder.sync.text)).toBeInTheDocument();
    expect(footerButtons()).toEqual([copy.step.back, copy.step.useAnyway, copy.step.chooseAnother]);

    await user.click(screen.getByRole('button', { name: copy.step.useAnyway }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.courses.title })).toBeInTheDocument();
  });

  it('names the other cloud folders', async () => {
    for (const provider of ['oneDrive', 'dropbox', 'other'] as const) {
      const { unmount } = await stepOne('folders', {}, provider);
      expect(screen.getByText(copy.folder.sync[provider])).toBeInTheDocument();
      unmount();
    }
  });

  it('"Change…" chooses another folder', async () => {
    const { user } = renderStart({
      fixture: startFixture('first-run', { choices: [folderChoice('empty'), folderChoice('library')] }),
    });
    await user.click(screen.getByRole('button', { name: copy.welcome.newLibrary.title }));
    await user.click(await screen.findByRole('button', { name: copy.step.change }));

    expect(await screen.findByRole('heading', { level: 1, name: copy.folder.library.title })).toBeInTheDocument();
  });

  it('flags the library name: control characters while typing, the rest on blur and submit', async () => {
    const { user } = await stepOne('empty');
    const name = screen.getByLabelText(copy.name.label);

    fireEvent.change(name, { target: { value: 'Bad\u0007name' } });
    expect(screen.getByText(copy.name.errors.NameInvalidCharacter)).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(expect.stringContaining(copy.name.errors.NameInvalidCharacter));

    await user.clear(name);
    await user.tab();
    expect(screen.getByText(copy.name.errors.NameEmpty)).toBeInTheDocument();

    fireEvent.change(name, { target: { value: 'x'.repeat(129) } });
    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));
    expect(screen.getByText(copy.name.errors.NameTooLong)).toBeInTheDocument();
    expect(name).toHaveFocus();
    expect(pageHeading()).toHaveTextContent(copy.folder.empty.title);
  });

  it('shows a name the shell refuses under the field', async () => {
    const { user, shell } = await stepOne('empty');
    shell.setFailure('create_library', 'NameInvalidCharacter');
    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));

    expect(await screen.findByText(copy.name.errors.NameInvalidCharacter)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows "Creating…" while the library is created', async () => {
    const { user, shell } = await stepOne('empty');
    let release: () => void = () => undefined;
    const original = shell.invoke.bind(shell);
    shell.invoke = async (command, payload) => {
      if (command === 'create_library') await new Promise<void>((resolve) => (release = resolve));
      return original(command, payload);
    };
    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));

    expect(await screen.findByRole('button', { name: copy.folder.creating })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    act(() => {
      release();
    });
    expect(await screen.findByRole('heading', { level: 1, name: copy.courses.title })).toBeInTheDocument();
  });

  const FAILURES: [AppError['code'], 'create' | 'open', string, string, string[]][] = [
    ['AlreadyALibrary', 'create', copy.errors.alreadyALibrary.title, copy.errors.alreadyALibrary.text, [copy.step.chooseAnother]],
    ['AccessDenied', 'create', copy.errors.accessDenied.title, copy.errors.accessDenied.text, [copy.step.tryAgain, copy.step.chooseAnother]],
    ['ChoiceExpired', 'create', copy.errors.choiceExpired.title, copy.errors.choiceExpired.text, [copy.step.chooseFolder]],
    ['NotALibrary', 'open', copy.errors.notALibrary.title, copy.errors.notALibrary.text, [copy.step.back, copy.step.chooseAnother]],
    ['NewerFormat', 'open', copy.errors.newerFormat.title, copy.errors.newerFormat.text, [copy.step.chooseAnother]],
    ['DiskFull', 'create', copy.errors.diskFull.title, 'Free up some space on C:, then try again.', [copy.step.back, copy.step.tryAgain]],
    ['FileSystem', 'create', copy.errors.failed.title, copy.errors.failed.text, [copy.step.back, shellCopy.copyDetails.action, copy.step.tryAgain]],
    ['Internal', 'open', copy.errors.failed.title, copy.errors.failed.text, [copy.step.back, shellCopy.copyDetails.action, copy.step.tryAgain]],
  ];

  it.each(FAILURES)('shows %s from the %s command as a banner, with focus on its main button', async (code, command, title, text, buttons) => {
    const { user, shell } = await stepOne(command === 'create' ? 'empty' : 'library');
    shell.setFailure(command === 'create' ? 'create_library' : 'open_library', code);
    const submit = command === 'create' ? copy.folder.empty.submit : copy.folder.library.submit;
    await user.click(screen.getByRole('button', { name: submit }));

    // Danger banners are alerts, the warning a status message (library-actions §2.3).
    const banner = await screen.findByRole(code === 'ChoiceExpired' ? 'status' : 'alert');
    expect(banner).toHaveTextContent(title);
    expect(banner).toHaveTextContent(text);
    expect(footerButtons()).toEqual(buttons);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: buttons.at(-1) })).toHaveFocus();
    });
  });

  it('"Try again" sends the same choice again', async () => {
    const { user, shell } = await stepOne('empty');
    shell.setFailure('create_library', 'AccessDenied');
    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));
    await screen.findByRole('alert');

    shell.setFailure('create_library', null);
    await user.click(screen.getByRole('button', { name: copy.step.tryAgain }));
    expect(await screen.findByRole('heading', { level: 1, name: copy.courses.title })).toBeInTheDocument();
  });

  it('"Choose folder…" after an expired choice asks for the folder again', async () => {
    const { user, shell } = await stepOne('empty');
    shell.setFailure('create_library', 'ChoiceExpired');
    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));
    await user.click(await screen.findByRole('button', { name: copy.step.chooseFolder }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(pageHeading()).toHaveTextContent(copy.folder.empty.title);
  });

  it('"Copy details" copies the code and the detail', async () => {
    const { user, shell } = await stepOne('empty');
    shell.setFailure('create_library', 'FileSystem');
    await user.click(screen.getByRole('button', { name: copy.folder.empty.submit }));
    await user.click(await screen.findByRole('button', { name: shellCopy.copyDetails.action }));

    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toBe(
        `${copy.errors.failed.title}\nFileSystem: create_library set to fail by the fake shell`,
      );
    });
  });
});
