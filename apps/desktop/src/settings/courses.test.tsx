// Library settings → Courses and its dialogs (app-shell handoff §9; library-actions §8; ipc-m1 §7)
// against the fake shell: the list, moving courses, archiving courses and semesters, editing a
// course, New semester and Add courses, with their checks, failures and the read-only library.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useNavigation } from '../app/navigation';
import { useSession } from '../data/session';
import { toastTexts } from '../test/render';
import { NOW, smallRef } from '../test/data';
import { announced, renderSettings } from './test/render';

const FALL = 'Fall 2026';

/** The names of the courses in the list, in order. */
function listedCourses(name = `Courses in ${FALL}`): string[] {
  return within(screen.getByRole('list', { name }))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('.course-line__label')?.getAttribute('title') ?? '');
}

async function openCourses(options: Parameters<typeof renderSettings>[2] = {}) {
  useSession.setState({ semesters: {} });
  const rendered = renderSettings('librarySettings', { page: 'courses' }, options);
  await screen.findByRole('list', { name: `Courses in ${FALL}` });
  return rendered;
}

describe('Library settings → Courses', () => {
  it('lists the current semester’s courses with their codes and file counts', async () => {
    await openCourses();
    expect(listedCourses()).toEqual([
      'MAT232 Calculus of Several Variables',
      'MAT223 线性代数',
      'CSC148 Introduction to Computer Science',
      'ECO101 微观经济学',
    ]);
    const [mat] = screen.getAllByRole('listitem');
    expect(mat).toHaveTextContent(/\d+ files/);
  });

  it('moves a course down from its menu, says so, and saves the order', async () => {
    const { user, shell } = await openCourses();
    await user.click(screen.getByRole('button', { name: 'More options for MAT232 Calculus of Several Variables' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move down' }));
    expect(listedCourses()[1]).toBe('MAT232 Calculus of Several Variables');
    expect(announced()).toBe('Moved MAT232 Calculus of Several Variables to position 2 of 4');
    await waitFor(() => {
      const fall = shell.library.at(FALL);
      expect(fall && shell.library.groupsIn(fall).map((node) => node.name)[1]).toBe('MAT232 Calculus of Several Variables');
    });
  });

  it('disables Move up on the first course', async () => {
    const { user } = await openCourses();
    await user.click(screen.getByRole('button', { name: 'More options for MAT232 Calculus of Several Variables' }));
    expect(await screen.findByRole('menuitem', { name: 'Move up' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('puts the order back and says why when moving fails', async () => {
    const { user, shell } = await openCourses();
    shell.setFailure('reorder_courses', 'AccessDenied');
    await user.click(screen.getByRole('button', { name: 'More options for MAT223 线性代数' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => {
      expect(toastTexts().some((text) => text.startsWith("Couldn't change the order of the courses"))).toBe(true);
    });
    expect(listedCourses()[0]).toBe('MAT232 Calculus of Several Variables');
  });

  it('archives a course into its own card and restores it', async () => {
    const { user } = await openCourses();
    await user.click(screen.getByRole('button', { name: 'More options for ECO101 微观经济学' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const archived = await screen.findByRole('list', { name: `Archived courses in ${FALL}` });
    expect(within(archived).getByText('ECO101 微观经济学')).toBeInTheDocument();
    expect(listedCourses()).not.toContain('ECO101 微观经济学');
    await user.click(within(archived).getByRole('button', { name: 'More options for ECO101 微观经济学' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => {
      expect(listedCourses()).toContain('ECO101 微观经济学');
    });
  });

  it('archives the semester with its switch', async () => {
    const { user, shell } = await openCourses();
    const archive = screen.getByRole('switch', { name: `Archive ${FALL}` });
    expect(archive).not.toBeChecked();
    expect(archive).toHaveAccessibleDescription(/Archived semesters move to the semester menu/);
    await user.click(archive);
    await waitFor(() => {
      const fall = shell.library.at(FALL);
      expect(fall && shell.library.semester(fall).archived).toBe(true);
    });
    expect(archive).toBeChecked();
  });

  it('shows another semester’s courses from the page’s semester select, without changing the current one', async () => {
    const { user } = await openCourses();
    await user.click(screen.getByRole('button', { name: /Semester/ }));
    await user.click(await screen.findByRole('option', { name: 'Winter 2026' }));
    expect(await screen.findByRole('list', { name: 'Courses in Winter 2026' })).toBeInTheDocument();
    const { libraryId, semesters } = useSession.getState();
    expect(semesters[libraryId ?? '']).toBe(FALL);
  });

  it('offers no grips or edits in a read-only library, and says why', async () => {
    await openCourses({ scenario: 'read-only' });
    expect(screen.getByText('Read-only for now')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New course' })).toBeDisabled();
    expect(document.querySelector('.reorder-row__grip')).toBeNull();
    expect(screen.getByRole('switch', { name: `Archive ${FALL}` })).toBeDisabled();
  });

  it('shows the state block with Try again when the courses cannot be read', async () => {
    useSession.setState({ semesters: {} });
    renderSettings('librarySettings', { page: 'courses' }, { fail: [{ command: 'list_semesters', code: 'Internal' }] });
    expect(await screen.findByRole('heading', { name: "Couldn't load your courses" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('Edit course', () => {
  it('saves the code, badge and colour, and renames the folder', async () => {
    const { user, shell } = await openCourses();
    await user.click(screen.getByRole('button', { name: 'More options for ECO101 微观经济学' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit ECO101 微观经济学' });
    const name = within(dialog).getByRole('textbox', { name: 'Folder name' });
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    await user.clear(name);
    await user.type(name, 'ECO101 Microeconomics');
    await user.type(within(dialog).getByRole('textbox', { name: 'Code (optional)' }), 'ECO101');
    await user.type(within(dialog).getByRole('textbox', { name: 'Badge (optional)' }), 'Mic');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Edit ECO101/ })).toBeNull();
    });
    const course = shell.library.at(`${FALL}/ECO101 Microeconomics`);
    expect(course && shell.library.course(course)).toMatchObject({ code: 'ECO101', abbr: 'Mic' });
  });

  it('flags a badge over three letters before sending, and a taken name from the shell', async () => {
    const { user } = await openCourses();
    await user.click(screen.getByRole('button', { name: 'More options for ECO101 微观经济学' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit ECO101 微观经济学' });
    const badge = within(dialog).getByRole('textbox', { name: 'Badge (optional)' });
    await user.type(badge, 'Econ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(badge).toHaveAccessibleDescription(/Use up to 3 letters\./);
    expect(badge).toHaveFocus();
    await user.clear(badge);
    const name = within(dialog).getByRole('textbox', { name: 'Folder name' });
    await user.clear(name);
    await user.type(name, 'csc148 introduction to computer science');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(`Another course in ${FALL} already has this name.`)).toBeInTheDocument();
  });
});

describe('New semester', () => {
  it('creates the semester and its courses, archives the current one when asked, and shows the new one', async () => {
    const { user, shell } = await openCourses();
    await user.click(screen.getByRole('tab', { name: 'Library' }));
    await user.click(await screen.findByRole('button', { name: 'New semester…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New semester' });
    const name = within(dialog).getByRole('textbox', { name: 'Semester name' });
    expect(name).toHaveValue('Winter 2027');
    await user.clear(name);
    await user.type(name, 'Winter 2027');
    await user.type(within(dialog).getByRole('textbox', { name: 'Course 1 code' }), 'MAT237');
    await user.type(within(dialog).getByRole('textbox', { name: 'Course 1 name' }), 'Multivariable Calculus{Enter}');
    await user.type(within(dialog).getByRole('textbox', { name: 'Course 2 name' }), 'Algorithms');
    await user.click(within(dialog).getByRole('checkbox', { name: `Archive ${FALL}` }));
    await user.click(within(dialog).getByRole('button', { name: 'Create semester and 2 courses' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New semester' })).toBeNull();
    });
    const winter = shell.library.at('Winter 2027');
    expect(winter && shell.library.groupsIn(winter).map((node) => node.name)).toEqual(['Multivariable Calculus', 'Algorithms']);
    const fall = shell.library.at(FALL);
    expect(fall && shell.library.semester(fall).archived).toBe(true);
    const { libraryId, semesters } = useSession.getState();
    expect(semesters[libraryId ?? '']).toBe('Winter 2027');
    expect(toastTexts()).toContain('Created Winter 2027 with 2 courses');
    expect(useNavigation.getState().revealTarget?.path).toBe('Winter 2027/Multivariable Calculus');
  });

  it('flags a semester name that is taken before sending anything', async () => {
    const { user, shell } = renderSettings('newSemester', undefined);
    const dialog = await screen.findByRole('dialog', { name: 'New semester' });
    const name = within(dialog).getByRole('textbox', { name: 'Semester name' });
    await user.clear(name);
    await user.type(name, 'winter 2026');
    await user.click(within(dialog).getByRole('button', { name: 'Create semester' }));
    expect(name).toHaveAccessibleDescription(/There's already a semester called winter 2026\./);
    expect(shell.library.at('winter 2026')).toBeUndefined();
  });

  it('keeps a course that fails with why, and offers the rest again', async () => {
    const { user, shell } = renderSettings('newSemester', undefined);
    const dialog = await screen.findByRole('dialog', { name: 'New semester' });
    const semester = within(dialog).getByRole('textbox', { name: 'Semester name' });
    await user.clear(semester);
    await user.type(semester, 'Summer 2027');
    await user.type(within(dialog).getByRole('textbox', { name: 'Course 1 name' }), 'Algorithms');
    shell.setFailure('create_course', 'PathTooLong');
    await user.click(within(dialog).getByRole('button', { name: 'Create semester and 1 course' }));
    const course = within(dialog).getByRole('textbox', { name: 'Course 1 name' });
    await waitFor(() => {
      expect(course).toHaveAccessibleDescription(/too long for Windows/);
    });
    expect(within(dialog).getByRole('textbox', { name: 'Semester name' })).toHaveAttribute('readonly');
    shell.setFailure('create_course', null);
    await user.click(within(dialog).getByRole('button', { name: 'Create 1 more course' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New semester' })).toBeNull();
    });
  });
});

describe('Add courses', () => {
  it('adds the courses to the semester and flags one that it has already', async () => {
    const { user, shell } = renderSettings('addCourses', { semester: smallRef(FALL) }, { now: NOW });
    await screen.findByRole('dialog', { name: `Add courses to ${FALL}` });
    const dialog = () => screen.getByRole('dialog', { name: `Add courses to ${FALL}` });
    // The rows start again once the semester's courses arrive; then the first code has focus.
    await waitFor(() => {
      expect(within(dialog()).getByRole('textbox', { name: 'Course 1 code' })).toHaveFocus();
    });
    const name = within(dialog()).getByRole('textbox', { name: 'Course 1 name' });
    await user.type(name, '线性代数');
    await user.click(within(dialog()).getByRole('button', { name: 'Add 1 course' }));
    expect(name).toHaveAccessibleDescription(`Another course in ${FALL} already has this name.`);
    await user.clear(name);
    await user.type(name, 'STA247 Probability');
    await user.click(within(dialog()).getByRole('button', { name: 'Add 1 course' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: `Add courses to ${FALL}` })).toBeNull();
    });
    expect(shell.library.at(`${FALL}/STA247 Probability`)).toBeDefined();
    expect(toastTexts()).toContain(`Added 1 course to ${FALL}`);
  });
});
