// Semesters and courses against the fake shell (ipc-m1 §7): lists in the user's order, the
// selections views read, the mutations, and the CatalogChanged that refreshes them.
import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ipc } from '../ipc';
import { NOW, smallRef } from '../test/data';
import { renderAppHook } from '../test/render';
import { useDeleteEntries, useRenameEntry } from './entries';
import { unwrap } from './errors';
import {
  useCourseOf,
  useCourses,
  useCreateCourse,
  useCreateSemester,
  useReorderCourses,
  useReorderSemesters,
  useSemesters,
  useUpdateCourse,
  useUpdateSemester,
} from './groups';
import { keys } from './keys';
import { useSession } from './session';

const FALL = 'Fall 2026';
const MAT = `${FALL}/MAT232 Calculus of Several Variables`;
const LINEAR = `${FALL}/线性代数`;
const CSC = `${FALL}/CSC148 Introduction to Computer Science`;
const ECO = `${FALL}/ECO101 微观经济学`;

describe('lists', () => {
  it('lists the semesters in the user’s order, and every course by semester', async () => {
    const { result } = renderAppHook(
      () => ({ semesters: useSemesters().data, courses: useCourses().data }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.semesters?.map((semester) => semester.name)).toEqual([
        'Fall 2025',
        'Winter 2026',
        FALL,
        'Personal',
      ]);
    });
    expect(result.current.semesters?.[0]).toEqual({ folder: smallRef('Fall 2025'), name: 'Fall 2025', archived: true });
    await waitFor(() => {
      expect(result.current.courses?.map((course) => course.code)).toEqual([
        'CSC108',
        'PHY131',
        null,
        'MAT232',
        'MAT223',
        'CSC148',
        null,
        // Folders directly in any top-level folder are courses, those in "Personal" too.
        null,
        null,
      ]);
    });
  });

  it('selects one semester’s courses, and the course a path is in, from one list', async () => {
    const { result, client } = renderAppHook(
      () => ({
        fall: useCourses(FALL).data,
        inCourse: useCourseOf(`${MAT}/Lectures/Lecture 01.pdf`),
        course: useCourseOf(MAT),
        outside: useCourseOf('Personal/Todo.txt'),
        none: useCourseOf(null),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.fall?.map((course) => course.folder.path)).toEqual([MAT, LINEAR, CSC, ECO]);
    });
    expect(result.current.inCourse).toMatchObject({ code: 'MAT232', abbr: 'MAT', color: 'blue', files: 27 });
    expect(result.current.course?.folder).toEqual(smallRef(MAT));
    expect(result.current.outside).toBeUndefined();
    expect(result.current.none).toBeUndefined();
    // Every semester's courses, cached once, whatever the selection.
    const libraryId = useSession.getState().libraryId ?? '';
    expect(client.getQueryCache().findAll({ queryKey: keys.courses(libraryId) })).toHaveLength(1);
  });

  it('follows course file counts as files come and go', async () => {
    const { result } = renderAppHook(
      () => ({ course: useCourseOf(ECO), remove: useDeleteEntries() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.course?.files).toBe(4);
    });

    await result.current.remove.mutateAsync({ entries: [smallRef(`${ECO}/Problem set 1.docx`)] });

    await waitFor(() => {
      expect(result.current.course?.files).toBe(3);
    });
  });

  it('follows a rename of a course folder, which keeps its settings', async () => {
    const { result } = renderAppHook(
      () => ({ courses: useCourses(FALL).data, rename: useRenameEntry() }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.courses).toHaveLength(4);
    });

    await result.current.rename.mutateAsync({ entry: smallRef(MAT), name: 'MAT232 Calculus III' });

    await waitFor(() => {
      expect(result.current.courses?.[0]).toMatchObject({
        name: 'MAT232 Calculus III',
        folder: { id: smallRef(MAT).id, path: `${FALL}/MAT232 Calculus III` },
        code: 'MAT232',
      });
    });
  });
});

describe('semester mutations', () => {
  it('creates a semester last, archives it and reorders the semesters', async () => {
    const { result } = renderAppHook(
      () => ({
        semesters: useSemesters().data,
        create: useCreateSemester(),
        update: useUpdateSemester(),
        reorder: useReorderSemesters(),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.semesters).toHaveLength(4);
    });

    const winter = await result.current.create.mutateAsync({ name: '  Winter 2027 ' });
    expect(winter).toMatchObject({ name: 'Winter 2027', archived: false });
    await waitFor(() => {
      expect(result.current.semesters?.at(-1)).toEqual(winter);
    });

    await result.current.update.mutateAsync({ semester: winter.folder, archived: true });
    await waitFor(() => {
      expect(result.current.semesters?.at(-1)?.archived).toBe(true);
    });

    const order = [...(result.current.semesters ?? [])].reverse().map((semester) => semester.folder);
    await result.current.reorder.mutateAsync({ semesters: order });
    await waitFor(() => {
      expect(result.current.semesters?.map((semester) => semester.folder)).toEqual(order);
    });
  });

  it('keeps errors typed: a taken name, an order that misses a semester, a read-only library', async () => {
    const { result } = renderAppHook(
      () => ({ create: useCreateSemester(), reorder: useReorderSemesters() }),
      { now: NOW },
    );
    await expect(result.current.create.mutateAsync({ name: 'fall 2026' })).rejects.toMatchObject({
      error: { code: 'AlreadyExists' },
    });
    await expect(result.current.create.mutateAsync({ name: 'a/b' })).rejects.toMatchObject({
      error: { code: 'NameInvalidCharacter' },
    });
    await expect(
      result.current.reorder.mutateAsync({ semesters: [smallRef(FALL)] }),
    ).rejects.toMatchObject({ error: { code: 'InvalidArgument' } });

    const readOnly = renderAppHook(() => useCreateSemester(), { now: NOW, scenario: 'read-only' });
    await expect(readOnly.result.current.mutateAsync({ name: 'Summer 2027' })).rejects.toMatchObject({
      error: { code: 'ReadOnly' },
    });
  });

  it('refreshes the lists at once when a semester it names has gone, before the event', async () => {
    const { result, shell } = renderAppHook(
      () => ({ semesters: useSemesters().data, update: useUpdateSemester() }),
      // The rename's CatalogChanged does not arrive during the test.
      { now: NOW, eventDelayMs: 60_000 },
    );
    await waitFor(() => {
      expect(result.current.semesters).toHaveLength(4);
    });
    await unwrap(ipc.renameEntry({ entry: smallRef(FALL), name: 'Autumn 2026' }));
    const invoke = vi.spyOn(shell, 'invoke');

    await expect(
      result.current.update.mutateAsync({ semester: smallRef(FALL), archived: true }),
    ).rejects.toMatchObject({ error: { code: 'NotFound' } });

    await waitFor(() => {
      expect(result.current.semesters?.[2]?.name).toBe('Autumn 2026');
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'list_semesters')).toHaveLength(1);
  });
});

describe('course mutations', () => {
  it('creates a course last in its semester, updates it and reorders the courses', async () => {
    const { result } = renderAppHook(
      () => ({
        courses: useCourses(FALL).data,
        create: useCreateCourse(),
        update: useUpdateCourse(),
        reorder: useReorderCourses(),
      }),
      { now: NOW },
    );
    await waitFor(() => {
      expect(result.current.courses).toHaveLength(4);
    });

    const course = await result.current.create.mutateAsync({
      semester: smallRef(FALL),
      name: 'STA247 Probability',
      abbr: null,
      code: 'STA247',
      color: 'amber',
    });
    expect(course).toMatchObject({ name: 'STA247 Probability', abbr: null, code: 'STA247', files: 0 });
    await waitFor(() => {
      expect(result.current.courses?.at(-1)).toEqual(course);
    });

    await result.current.update.mutateAsync({
      course: course.folder,
      abbr: 'STA',
      code: 'STA247',
      color: null,
      archived: true,
    });
    await waitFor(() => {
      expect(result.current.courses?.at(-1)).toMatchObject({ abbr: 'STA', color: null, archived: true });
    });

    const order = [...(result.current.courses ?? [])].reverse().map((item) => item.folder);
    await result.current.reorder.mutateAsync({ semester: smallRef(FALL), courses: order });
    await waitFor(() => {
      expect(result.current.courses?.map((item) => item.folder)).toEqual(order);
    });
  });

  it('keeps errors typed: a badge too long, a course that has gone', async () => {
    const { result, shell } = renderAppHook(() => useUpdateCourse(), {
      now: NOW,
      eventDelayMs: 60_000,
    });
    const settings = { abbr: 'MATH', code: 'MAT232', color: 'blue', archived: false };
    await expect(result.current.mutateAsync({ course: smallRef(MAT), ...settings })).rejects.toMatchObject({
      error: { code: 'NameTooLong' },
    });

    await unwrap(ipc.deleteEntries({ entries: [smallRef(MAT)] }));
    const invoke = vi.spyOn(shell, 'invoke');
    await expect(
      result.current.mutateAsync({ course: smallRef(MAT), ...settings, abbr: 'MAT' }),
    ).rejects.toMatchObject({ error: { code: 'NotFound' } });
    // Nothing shows the course list, so the refresh asks for nothing.
    expect(invoke.mock.calls.filter(([command]) => command === 'list_courses')).toHaveLength(0);
  });
});
