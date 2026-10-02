// The course rows of the first run's step 2 and of "New semester" and "Add courses" (first-run
// handoff §5.1, §8; library-actions handoff §8): rows to type, checked while typing and on blur,
// then created one by one. A row that fails keeps its fields and says why under them; created
// rows turn read-only, so a second press creates only the rest. In app/, so both features use
// one form; each words the messages in its own namespace.
import { useEffect, useId, useState } from 'react';

import type { CourseRow, CourseRowsProps, RowField } from '../components/CourseRows/CourseRows';
import { rowInputId } from '../components/CourseRows/CourseRows';
import { IpcFailure } from '../data/errors';
import { useCreateCourse } from '../data/groups';
import {
  checkCourseCode,
  checkFolderName,
  type FolderCode,
  hasInvalidFolderCharacter,
  nextColor,
  sameFolderName,
} from '../data/names';
import type { Course, EntryRef, IpcError } from '../ipc';

let nextKey = 0;

function newRow(usedColors: readonly (string | null)[]): CourseRow {
  nextKey += 1;
  return {
    key: `course-${String(nextKey)}`,
    code: '',
    name: '',
    color: nextColor(usedColors),
    done: false,
    nameError: null,
    codeError: null,
  };
}

/** A row to create: not created yet, with a name or a code typed. */
function isPendingRow(row: CourseRow): boolean {
  return !row.done && (row.name.trim() !== '' || row.code.trim() !== '');
}

export interface CourseRowsForm {
  /** Rows to create, and how many of them have a name (what the button counts). */
  pending: number;
  named: number;
  /**
   * Checks every pending row and says whether all pass; with `focus`, the first field with a
   * problem takes focus (a page whose own field comes first focuses that instead).
   */
  validate: (focus?: boolean) => boolean;
  /**
   * Creates every pending row in `semester`, in order. Resolves to the courses created and, when
   * some failed, the error to show above the footer (a code that is not about a name).
   */
  create: (semester: EntryRef) => Promise<{ created: Course[]; failed: boolean; banner: IpcError | null }>;
  /** The props of `CourseRows`, except `busy` and `help`. */
  rowsProps: Omit<CourseRowsProps, 'busy' | 'help'>;
}

export interface CourseRowsFormOptions {
  /** The semester the rows go into, for "Another course in Fall 2026 already has this name". */
  semesterName: string;
  /** The courses it holds already, which new names must not repeat. */
  existing: readonly Course[];
  /** Enter where it does not add a row. */
  onSubmit: () => void;
  /** The first row's code takes focus when the form mounts. */
  autoFocus?: boolean;
  /** Waiting for the shell: Enter adds no row. */
  busy?: boolean;
  /**
   * The message under a row's name (`course`) or code (`code`) for a code, or `null` when the
   * code is not about that field; `semester` is the semester's name, or `''` before it has one.
   */
  message: (field: 'course' | 'code', code: IpcError['code'], semester: string) => string | null;
}

export function useCourseRowsForm({
  semesterName,
  existing,
  onSubmit,
  autoFocus = false,
  busy = false,
  message,
}: CourseRowsFormOptions): CourseRowsForm {
  const idPrefix = useId();
  const createCourse = useCreateCourse();
  const [rows, setRows] = useState<CourseRow[]>(() => [newRow(existing.map((course) => course.color))]);
  // Focus moves once the rows it names have rendered; a new object asks again for the same field.
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(() => {
    const first = rows[0];
    return autoFocus && first !== undefined ? { id: rowInputId(idPrefix, first.key, 'code') } : null;
  });
  useEffect(() => {
    if (focusTarget !== null) document.getElementById(focusTarget.id)?.focus();
  }, [focusTarget]);
  const focus = (id: string) => {
    setFocusTarget({ id });
  };
  const semester = semesterName.trim();

  const updateRow = (key: string, change: (row: CourseRow, all: readonly CourseRow[]) => Partial<CourseRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change(row, current) } : row)));
  };

  /** A row's errors (§8): characters while typing; the rest, and names taken, on blur and submit. */
  const checkRow = (row: CourseRow, all: readonly CourseRow[], typing: boolean) => {
    const codeCode = checkCourseCode(row.code);
    let nameCode: FolderCode | null = typing
      ? hasInvalidFolderCharacter(row.name)
        ? 'NameInvalidCharacter'
        : null
      : checkFolderName(row.name, false);
    if (!typing && nameCode === null) {
      const earlier = all.slice(0, all.findIndex((other) => other.key === row.key));
      const taken =
        existing.some((course) => sameFolderName(course.name, row.name)) ||
        earlier.some((other) => other.name.trim() !== '' && sameFolderName(other.name, row.name));
      if (taken) nameCode = 'AlreadyExists';
    }
    return {
      codeError: codeCode === null ? null : message('code', codeCode, semester),
      nameError: nameCode === null ? null : message('course', nameCode, semester),
    };
  };

  const validate = (focusFirst = true) => {
    const checked = rows.map((row) => (isPendingRow(row) ? { ...row, ...checkRow(row, rows, false) } : row));
    setRows(checked);
    const invalid = checked.find((row) => row.codeError !== null || row.nameError !== null);
    if (invalid === undefined) return true;
    if (focusFirst) focus(rowInputId(idPrefix, invalid.key, invalid.codeError !== null ? 'code' : 'name'));
    return false;
  };

  const create: CourseRowsForm['create'] = async (folder) => {
    const created: Course[] = [];
    let firstFailed: string | null = null;
    let banner: IpcError | null = null;
    for (const row of rows.filter(isPendingRow)) {
      try {
        const course = await createCourse.mutateAsync({
          semester: folder,
          name: row.name,
          abbr: null,
          code: row.code.trim() === '' ? null : row.code,
          color: row.color,
        });
        created.push(course);
        updateRow(row.key, () => ({ done: true, nameError: null, codeError: null }));
      } catch (failure: unknown) {
        if (!(failure instanceof IpcFailure)) throw failure;
        const error = failure.error;
        // The code passed its checks, so a name code is about the name (ipc-m1 §16.3).
        const under = message('course', error.code, semester);
        if (under === null) banner = error;
        else updateRow(row.key, () => ({ nameError: under }));
        firstFailed ??= rowInputId(idPrefix, row.key, 'name');
      }
    }
    if (firstFailed !== null) focus(firstFailed);
    return { created, failed: firstFailed !== null, banner };
  };

  const onEnter = (key: string, field: RowField) => {
    const index = rows.findIndex((row) => row.key === key);
    const row = rows[index];
    // Enter in a name with text adds a row below it and moves to its code (first-run §5.1).
    if (field === 'name' && row !== undefined && row.name.trim() !== '' && !busy) {
      const added = newRow([...existing.map((course) => course.color), ...rows.map((other) => other.color)]);
      setRows([...rows.slice(0, index + 1), added, ...rows.slice(index + 1)]);
      focus(rowInputId(idPrefix, added.key, 'code'));
      return;
    }
    onSubmit();
  };

  const pendingRows = rows.filter(isPendingRow);
  return {
    pending: pendingRows.length,
    named: pendingRows.filter((row) => row.name.trim() !== '').length,
    validate,
    create,
    rowsProps: {
      rows,
      mode: 'new',
      idPrefix,
      onChange: (key, change) => {
        // Typing clears the shell's message and flags characters at once (§8).
        updateRow(key, (row, all) => ('color' in change ? change : { ...change, ...checkRow({ ...row, ...change }, all, true) }));
      },
      onBlur: (key, field) => {
        updateRow(key, (row, all) => {
          if (!isPendingRow(row)) return {};
          const checked = checkRow(row, all, false);
          return field === 'code' ? { codeError: checked.codeError } : { nameError: checked.nameError };
        });
      },
      onEnter,
      onRemove: (key) => {
        const index = rows.findIndex((row) => row.key === key);
        const rest = rows.filter((row) => row.key !== key);
        setRows(rest);
        const next = rest[index] ?? rest[index - 1];
        focus(next === undefined ? `${idPrefix}-add` : rowInputId(idPrefix, next.key, 'code'));
      },
      onAdd: () => {
        const added = newRow([...existing.map((course) => course.color), ...rows.map((row) => row.color)]);
        setRows([...rows, added]);
        focus(rowInputId(idPrefix, added.key, 'code'));
      },
    },
  };
}
