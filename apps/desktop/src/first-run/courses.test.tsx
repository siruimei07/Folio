// Step 2 (first-run handoff §5): the semester and courses of a new library, with row-by-row
// failures (§5.1), and checking the semesters and courses of a folder taken over (§5.2).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useNavigation } from '../app/navigation';
import { useSession } from '../data/session';
import copy from '../i18n/locales/en/first-run.json';
import errors from '../i18n/locales/en/errors.json';
import { folderChoice, libraryFixture, startFixture } from '../test/fixtures';
import { termOf } from './names';
import { LIBRARY_VIEW, pageHeading, renderStart } from './test/render';

type Rendered = ReturnType<typeof renderStart>;

function never(): never {
  throw new Error('the fixture has a library');
}

/** The commands the page sent, in order, with their requests. */
function recordCommands(shell: Rendered['shell']): { command: string; payload: unknown }[] {
  const sent: { command: string; payload: unknown }[] = [];
  const original = shell.invoke.bind(shell);
  shell.invoke = (command, payload) => {
    sent.push({ command, payload });
    return original(command, payload);
  };
  return sent;
}

/** Step 2 of a new library, from an empty folder. */
async function newLibrary(options: Parameters<typeof renderStart>[0] = {}) {
  const rendered = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice('empty')] }), ...options });
  await rendered.user.click(screen.getByRole('button', { name: copy.welcome.newLibrary.title }));
  await rendered.user.click(await screen.findByRole('button', { name: copy.folder.empty.submit }));
  await screen.findByRole('heading', { level: 1, name: copy.courses.title });
  return rendered;
}

function input(label: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: label });
}

const SEMESTER = 'Fall 2026';

describe('step 2, a new library', () => {
  it('starts with the semester of today and one empty course row, focus on the semester', async () => {
    await newLibrary();

    const { term, year } = termOf(new Date());
    const semester = input(copy.courses.semesterLabel);
    expect(semester).toHaveValue(copy.courses.semesterDefault[term].replace('{{year}}', String(year)));
    expect(semester).toHaveFocus();
    expect(screen.getByText(copy.courses.intro)).toBeInTheDocument();
    expect(input('Course 1 code')).toHaveValue('');
    expect(input('Course 1 name')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Course 1 colour: Red' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.courses.submitSemester })).toBeInTheDocument();
    expect(document.title).toBe(`${copy.courses.title} — Folio`);
  });

  it('adds a row with Enter in a name, with the next colour, and counts the courses', async () => {
    const { user } = await newLibrary();
    await user.type(input('Course 1 name'), 'Calculus{Enter}');

    expect(input('Course 2 code')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Course 2 colour: Orange' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create 1 course' })).toBeInTheDocument();
    await user.type(input('Course 2 name'), 'Algebra');
    expect(screen.getByRole('button', { name: 'Create 2 courses' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove course 2' }));
    expect(screen.queryByRole('textbox', { name: 'Course 2 name' })).toBeNull();
    // Focus goes to the next row, else the one before.
    expect(input('Course 1 code')).toHaveFocus();
  });

  it('chooses a colour in the popover: arrows move, Enter closes, focus returns', async () => {
    const { user } = await newLibrary();
    await user.type(input('Course 1 name'), 'Calculus');
    await user.click(screen.getByRole('button', { name: 'Course 1 colour: Red' }));

    const popover = await screen.findByRole('dialog', { name: copy.colour.caption });
    const red = within(popover).getByRole('radio', { name: 'Red' });
    expect(red).toBeChecked();
    await waitFor(() => {
      expect(red).toHaveFocus();
    });
    expect(within(popover).getByText('Red · badge “Cal”')).toBeInTheDocument();
    expect(within(popover).getAllByRole('radio')).toHaveLength(10);

    await user.keyboard('{ArrowRight}');
    expect(within(popover).getByRole('radio', { name: 'Orange' })).toBeChecked();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: copy.colour.caption })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Course 1 colour: Orange' })).toHaveFocus();
    });
  });

  it('a click on a swatch chooses it and closes the popover', async () => {
    const { user } = await newLibrary();
    await user.click(screen.getByRole('button', { name: 'Course 1 colour: Red' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('radio', { name: 'Teal' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Course 1 colour: Teal' })).toBeInTheDocument();

    // The colour already chosen closes it too.
    await user.click(screen.getByRole('button', { name: 'Course 1 colour: Teal' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('radio', { name: 'Teal' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('checks every field before it sends anything, and focuses the first invalid one', async () => {
    const { user, shell } = await newLibrary();
    const sent = recordCommands(shell);

    fireEvent.change(input('Course 1 name'), { target: { value: 'Intro: CS' } });
    expect(screen.getByText(copy.fields.course.NameInvalidCharacter)).toBeInTheDocument();
    fireEvent.change(input('Course 1 name'), { target: { value: 'Algebra' } });
    await user.type(input('Course 1 name'), '{Enter}');
    await user.type(input('Course 2 code'), 'MAT224');
    await user.click(screen.getByRole('button', { name: copy.courses.add }));
    await user.type(input('Course 3 name'), 'algebra');
    await user.clear(input(copy.courses.semesterLabel));
    await user.click(screen.getByRole('button', { name: 'Create 2 courses' }));

    expect(screen.getByText(copy.fields.semester.NameEmpty)).toBeInTheDocument();
    expect(input(copy.courses.semesterLabel)).toHaveFocus();
    expect(screen.getByText(copy.fields.course.NameEmpty)).toBeInTheDocument();
    expect(screen.getByText(copy.fields.course.AlreadyExistsHere)).toBeInTheDocument();
    expect(sent.filter(({ command }) => command.startsWith('create_'))).toEqual([]);

    await user.type(input(copy.courses.semesterLabel), SEMESTER);
    await user.click(screen.getByRole('button', { name: 'Create 2 courses' }));
    expect(input('Course 2 name')).toHaveFocus();
    expect(input('Course 2 name')).toHaveAttribute('aria-invalid', 'true');
    expect(sent.filter(({ command }) => command.startsWith('create_'))).toEqual([]);
  });

  it('creates the semester, then each course; a row that fails keeps its fields and shows why', async () => {
    const { user, shell } = await newLibrary();
    const sent = recordCommands(shell);
    const original = shell.invoke.bind(shell);
    let refuse = true;
    shell.invoke = (command, payload) => {
      const name = (payload as { request?: { name?: string } } | undefined)?.request?.name;
      if (command === 'create_course' && name === 'Linear Algebra' && refuse) {
        // The shell rejects with the error itself, as the fake shell does.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject({ code: 'AlreadyExists', detail: 'taken' });
      }
      return original(command, payload);
    };

    fireEvent.change(input(copy.courses.semesterLabel), { target: { value: SEMESTER } });
    await user.type(input('Course 1 code'), 'MAT232');
    await user.type(input('Course 1 name'), 'Calculus{Enter}');
    await user.type(input('Course 2 name'), 'Linear Algebra{Enter}');
    await user.type(input('Course 3 name'), 'Statistics');
    await user.click(screen.getByRole('button', { name: 'Create 3 courses' }));

    expect(await screen.findByText(`Another course in ${SEMESTER} already has this name.`)).toBeInTheDocument();
    // The refused course never reached the recorder; the one after it was still sent.
    expect(sent.map(({ command }) => command).filter((command) => command.startsWith('create_'))).toEqual([
      'create_semester',
      'create_course',
      'create_course',
    ]);
    expect(sent.find(({ command }) => command === 'create_course')?.payload).toMatchObject({
      request: { semester: { path: SEMESTER }, name: 'Calculus', abbr: null, code: 'MAT232', color: 'red' },
    });
    // Created rows turn read-only with a check; the failed one stays as it was.
    expect(input('Course 1 name')).toHaveAttribute('readonly');
    expect(screen.getByText('Course 1 created')).toBeInTheDocument();
    expect(screen.getByText('Course 3 created')).toBeInTheDocument();
    expect(input('Course 2 name')).not.toHaveAttribute('readonly');
    expect(input('Course 2 name')).toHaveFocus();
    expect(input(copy.courses.semesterLabel)).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Create 1 more course' })).toBeInTheDocument();

    refuse = false;
    await user.clear(input('Course 2 name'));
    await user.type(input('Course 2 name'), 'Linear Algebra I');
    await user.click(screen.getByRole('button', { name: 'Create 1 more course' }));

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
    expect(sent.filter(({ command }) => command === 'create_semester')).toHaveLength(1);
    const libraryId = useSession.getState().libraryId ?? '';
    expect(useSession.getState().semesters[libraryId]).toBe(SEMESTER);
    // The Library opens on the first course (library-actions §8).
    expect(useNavigation.getState().revealTarget).toMatchObject({ path: `${SEMESTER}/Calculus` });
  });

  it('shows a semester the shell refuses under its field and sends no course', async () => {
    const { user, shell } = await newLibrary();
    const sent = recordCommands(shell);
    shell.setFailure('create_semester', 'NameReserved');
    await user.type(input('Course 1 name'), 'Calculus');
    await user.click(screen.getByRole('button', { name: 'Create 1 course' }));

    expect(await screen.findByText(copy.fields.folder.NameReserved)).toBeInTheDocument();
    expect(input(copy.courses.semesterLabel)).toHaveFocus();
    expect(sent.filter(({ command }) => command === 'create_course')).toEqual([]);
  });

  it('shows other failures as a banner above the footer', async () => {
    const { user, shell } = await newLibrary();
    shell.setFailure('create_course', 'DiskFull');
    await user.type(input('Course 1 name'), 'Calculus');
    await user.click(screen.getByRole('button', { name: 'Create 1 course' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(errors.DiskFull);
    expect(screen.getByRole('button', { name: 'Create 1 more course' })).toBeInTheDocument();
  });

  it('shows the semester alone as "Create semester", and "Creating…" while it runs', async () => {
    const { user, shell } = await newLibrary();
    let release: () => void = () => undefined;
    const original = shell.invoke.bind(shell);
    shell.invoke = async (command, payload) => {
      if (command === 'create_semester') await new Promise<void>((resolve) => (release = resolve));
      return original(command, payload);
    };
    await user.click(screen.getByRole('button', { name: copy.courses.submitSemester }));

    expect(await screen.findByRole('button', { name: copy.courses.creatingSemester })).toBeInTheDocument();
    act(() => {
      release();
    });
    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
  });

  it('"Skip for now" opens the Library without a semester', async () => {
    const { user, shell } = await newLibrary();
    const sent = recordCommands(shell);
    await user.click(screen.getByRole('button', { name: copy.courses.skip }));

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
    expect(sent.filter(({ command }) => command.startsWith('create_'))).toEqual([]);
  });

  it('says a taken-over folder with only files has no semester folders yet', async () => {
    const onlyFiles = { ...folderChoice('folders'), content: { kind: 'folders' as const, folders: 0, files: 2 } };
    const { user } = renderStart({ fixture: startFixture('first-run', { choices: [onlyFiles] }) });
    await user.click(screen.getByRole('button', { name: copy.welcome.existing.title }));
    await user.click(await screen.findByRole('button', { name: copy.folder.folders.submit }));

    expect(await screen.findByText(copy.courses.introNoFolders)).toBeInTheDocument();
    expect(pageHeading()).toHaveTextContent(copy.courses.title);
  });
});

/** The scan strip once the scan has ended: with the files it read, unless no progress was seen. */
const SCAN_DONE = /^(Read \d+ files|Folio has read your library)$/;

/** Step 2 after taking over the small library's folders; `scanned`: once the scan has ended. */
async function takeOver(options: Parameters<typeof renderStart>[0] = {}, scanned = false) {
  const rendered = renderStart({ fixture: startFixture('first-run', { choices: [folderChoice('folders')] }), ...options });
  await rendered.user.click(screen.getByRole('button', { name: copy.welcome.existing.title }));
  await rendered.user.click(await screen.findByRole('button', { name: copy.folder.folders.submit }));
  await screen.findByRole('heading', { level: 1, name: copy.review.title });
  if (scanned) {
    act(() => {
      rendered.shell.finishJobs();
    });
    await waitFor(() => {
      expect(document.querySelector('.scan-strip__lead')).toHaveTextContent(SCAN_DONE);
    });
    await screen.findByRole('region', { name: `Courses in ${SEMESTER} · 4` });
  }
  return rendered;
}

describe('step 2, a folder taken over', () => {
  it('shows the scan reading the folder, then what it read', async () => {
    const { shell } = await takeOver({ jobStepMs: 60_000 });

    const strip = document.querySelector('.scan-strip');
    expect(strip).toHaveTextContent(copy.review.reading);
    expect(strip).toHaveTextContent('0 files so far');
    expect(screen.getByText(copy.review.readingHelp)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: copy.review.progress })).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(copy.review.reading);

    act(() => {
      shell.finishJobs();
    });
    await waitFor(() => {
      expect(document.querySelector('.scan-strip__lead')).toHaveTextContent(SCAN_DONE);
    });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(copy.review.readingHelp)).toBeNull();
  });

  it('counts the files once the total is known', async () => {
    await takeOver({ jobStepMs: 40 });

    await waitFor(() => {
      expect(document.querySelector('.scan-strip')).toHaveTextContent(/\d+ of \d+ files/);
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow');
    await waitFor(() => {
      expect(document.querySelector('.scan-strip__lead')).toHaveTextContent(/^Read \d+ files$/);
    });
  });

  it('lists the semesters, shows the one with the newest file, and its courses from the folders', async () => {
    await takeOver({}, true);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Semester to show first/ })).toHaveTextContent(SEMESTER);
    });
    expect(screen.getByText(/^Each folder at the top level is a semester: /)).toHaveTextContent(
      'Each folder at the top level is a semester: Fall 2025, Fall 2026, Personal, and Winter 2026.',
    );
    const courses = await screen.findByRole('region', { name: `Courses in ${SEMESTER} · 4` });
    expect(within(courses).getAllByRole('textbox').map((field) => field.getAttribute('aria-label'))).toEqual([
      'Course 1 code',
      'Course 2 code',
      'Course 3 code',
      'Course 4 code',
    ]);
    expect(within(courses).getByText('MAT232 Calculus of Several Variables')).toBeInTheDocument();
    expect(within(courses).queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(within(courses).queryByRole('button', { name: copy.courses.add })).toBeNull();
    expect(screen.getByText(copy.review.laterNote)).toBeInTheDocument();
  });

  it('focuses the first empty code', async () => {
    await takeOver({}, true);

    await waitFor(() => {
      expect(input('Course 1 code')).toHaveFocus();
    });
  });

  it('says when a semester has no course folders yet', async () => {
    const seed = libraryFixture((builder) => builder.folder('Winter 2027')).library;
    const folder = {
      path: 'D:\\Courses',
      content: { kind: 'folders' as const, folders: 1, files: 0 },
      syncRoot: null,
      library: () => seed ?? never(),
    };
    const { user } = renderStart({ fixture: startFixture('first-run', { choices: [folder] }) });
    await user.click(screen.getByRole('button', { name: copy.welcome.existing.title }));
    await user.click(await screen.findByRole('button', { name: copy.folder.folders.submit }));

    expect(await screen.findByText("Folio hasn't found course folders in Winter 2027 yet.")).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Courses in Winter 2027 · 0' })).toBeInTheDocument();
  });

  it('writes the codes and colours that changed on Finish, and opens that semester', async () => {
    const { user, shell } = await takeOver({}, true);
    await waitFor(() => {
      expect(input('Course 1 code')).toHaveFocus();
    });
    const sent = recordCommands(shell);
    await user.type(input('Course 1 code'), 'CSC148{Enter}');

    expect(await screen.findByText(LIBRARY_VIEW)).toBeInTheDocument();
    const path = `${SEMESTER}/CSC148 Introduction to Computer Science`;
    const update = sent.find(
      ({ command, payload }) =>
        command === 'update_course' && (payload as { request: { course: { path: string } } }).request.course.path === path,
    );
    expect(update?.payload).toMatchObject({ request: { code: 'CSC148', abbr: null, archived: false } });
    const libraryId = useSession.getState().libraryId ?? '';
    expect(useSession.getState().semesters[libraryId]).toBe(SEMESTER);
  });

  it('keeps the page and shows the failure when a course cannot be updated', async () => {
    const { user, shell } = await takeOver({}, true);
    await waitFor(() => {
      expect(input('Course 1 code')).toHaveFocus();
    });
    shell.setFailure('update_course', 'ReadOnly');
    await user.type(input('Course 1 code'), 'CSC148');
    await user.click(screen.getByRole('button', { name: copy.review.finish }));

    expect(await screen.findByRole('alert')).toHaveTextContent(errors.ReadOnly);
    expect(pageHeading()).toHaveTextContent(copy.review.title);
  });

  it('checks the codes before it sends them', async () => {
    const { user, shell } = await takeOver({}, true);
    await waitFor(() => {
      expect(input('Course 1 code')).toHaveFocus();
    });
    const sent = recordCommands(shell);
    fireEvent.change(input('Course 2 code'), { target: { value: 'X'.repeat(33) } });
    expect(screen.getByText(copy.fields.code.NameTooLong)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.review.finish }));

    expect(input('Course 2 code')).toHaveFocus();
    expect(sent.filter(({ command }) => command === 'update_course')).toEqual([]);
  });
});
