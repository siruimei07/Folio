import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton } from 'react-aria-components';

import { reveal } from '../app/navigation';
import { Banner } from '../components/Banner/Banner';
import { IpcFailure } from '../data/errors';
import { useCreateCourse, useCreateSemester } from '../data/groups';
import { setCurrentSemester } from '../data/session';
import type { Course, IpcError, Semester } from '../ipc';
import { type CourseRow, CourseRows, type RowField, rowInputId } from './CourseRows';
import { Field } from './Field';
import { Frame } from './Frame';
import {
  checkCourseCode,
  checkFolderName,
  type FolderCode,
  hasInvalidFolderCharacter,
  isFolderCode,
  nextColor,
  sameFolderName,
  termOf,
} from './names';
import { endFlow } from './state';
import { PendingButton, StepHeader } from './Step';

let nextKey = 0;

function newRow(used: readonly CourseRow[]): CourseRow {
  nextKey += 1;
  return {
    key: `new-${String(nextKey)}`,
    code: '',
    name: '',
    color: nextColor(used.map((row) => row.color)),
    done: false,
    nameError: null,
    codeError: null,
  };
}

/** A row the page sends: not created yet, and with a name or a code typed. */
function isPending(row: CourseRow): boolean {
  return !row.done && (row.name.trim() !== '' || row.code.trim() !== '');
}

/**
 * Step 2 for a new library (first-run handoff §5.1): the semester and its courses. The semester is
 * created first, then each course in order; a course that fails keeps its fields and shows why,
 * the created ones turn read-only, and the button offers the rest again.
 */
export function CoursesStep({ noFolders }: { noFolders: boolean }) {
  const { t } = useTranslation(['first-run', 'errors']);
  const idPrefix = useId();
  const [semesterName, setSemesterName] = useState(() => {
    const { term, year } = termOf(new Date());
    return t(`courses.semesterDefault.${term}`, { year });
  });
  const [semesterCode, setSemesterCode] = useState<FolderCode | null>(null);
  const [semester, setSemester] = useState<Semester | null>(null);
  const [rows, setRows] = useState<CourseRow[]>(() => [newRow([])]);
  const [banner, setBanner] = useState<IpcError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Focus moves once the rows it names have rendered; a new object asks again for the same field.
  const [focusTarget, setFocusTarget] = useState<{ id: string } | null>(null);
  const focusOn = (id: string) => {
    setFocusTarget({ id });
  };
  const semesterInput = useRef<HTMLInputElement>(null);
  /** Courses created so far, by every attempt, in order. */
  const createdCourses = useRef<Course[]>([]);
  const createSemester = useCreateSemester();
  const createCourse = useCreateCourse();

  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget.id === 'semester') semesterInput.current?.focus();
    else document.getElementById(focusTarget.id)?.focus();
  }, [focusTarget]);

  const shownSemester = semester?.name ?? semesterName;
  const folderMessage = (code: FolderCode, field: 'semester' | 'course') => {
    switch (code) {
      case 'NameEmpty':
      case 'NameInvalidCharacter':
        return t(`fields.${field}.${code}`);
      case 'AlreadyExists':
        return field === 'semester'
          ? t('fields.semester.AlreadyExists', { name: semesterName.trim() })
          : shownSemester.trim() === ''
            ? t('fields.course.AlreadyExistsHere')
            : t('fields.course.AlreadyExists', { semester: shownSemester.trim() });
      default:
        return t(`fields.folder.${code}`);
    }
  };
  const semesterTyped = hasInvalidFolderCharacter(semesterName) ? 'NameInvalidCharacter' : null;
  const semesterShown = semester === null ? (semesterTyped ?? semesterCode) : null;

  /** Changes the row `key`, from what it holds and the other rows. */
  const updateRow = (key: string, change: (row: CourseRow, all: readonly CourseRow[]) => Partial<CourseRow>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change(row, current) } : row)));
  };

  /**
   * A row's own errors (§8): characters while typing, the rest on blur and submit. A name that an
   * earlier row already has is the duplicate.
   */
  const checkRow = (row: CourseRow, all: readonly CourseRow[], typing: boolean) => {
    const codeCode = checkCourseCode(row.code);
    let nameCode: FolderCode | null;
    if (typing) nameCode = hasInvalidFolderCharacter(row.name) ? 'NameInvalidCharacter' : null;
    else {
      nameCode = checkFolderName(row.name, false);
      const earlier = all.slice(0, all.findIndex((other) => other.key === row.key));
      if (nameCode === null && earlier.some((other) => other.name.trim() !== '' && sameFolderName(other.name, row.name))) {
        nameCode = 'AlreadyExists';
      }
    }
    return {
      codeError: codeCode === null ? null : t(`fields.code.${codeCode}`),
      nameError: nameCode === null ? null : folderMessage(nameCode, 'course'),
    };
  };

  const pending = rows.filter(isPending);
  const named = pending.filter((row) => row.name.trim() !== '').length;

  const finish = (created: Semester | null, courses: readonly Course[]) => {
    if (created !== null) setCurrentSemester(created.folder.path);
    // The Library opens on the new semester with its first course selected (§5.1 step 4).
    const [first] = courses;
    if (first !== undefined) reveal(first.folder);
    endFlow();
  };

  const submit = async () => {
    if (submitting) return;
    // 1. Checks first: the first invalid field takes focus, and nothing is sent.
    const semesterProblem = semester === null ? checkFolderName(semesterName, true) : null;
    const checked = rows.map((row) => (isPending(row) ? { ...row, ...checkRow(row, rows, false) } : row));
    setSemesterCode(semesterProblem);
    setRows(checked);
    if (semesterProblem !== null) {
      focusOn('semester');
      return;
    }
    const invalid = checked.find((row) => row.codeError !== null || row.nameError !== null);
    if (invalid !== undefined) {
      focusOn(rowInputId(idPrefix, invalid.key, invalid.codeError !== null ? 'code' : 'name'));
      return;
    }

    // 2. The semester, then each course in order.
    setBanner(null);
    setSubmitting(true);
    let outcome: Awaited<ReturnType<typeof send>>;
    try {
      outcome = await send(checked);
    } finally {
      setSubmitting(false);
    }
    if (outcome === null) return;
    if (outcome.firstFailed === null) finish(outcome.created, createdCourses.current);
    else focusOn(outcome.firstFailed);
  };

  /**
   * Creates the semester unless an earlier attempt did, then every pending course. `null` when the
   * semester failed (its message is shown); otherwise the semester and the first row that failed.
   */
  const send = async (checked: readonly CourseRow[]) => {
    let created = semester;
    if (created === null) {
      try {
        created = await createSemester.mutateAsync({ name: semesterName });
        setSemester(created);
      } catch (error: unknown) {
        if (!(error instanceof IpcFailure)) throw error;
        if (isFolderCode(error.error.code)) {
          setSemesterCode(error.error.code);
          focusOn('semester');
        } else {
          setBanner(error.error);
        }
        return null;
      }
    }
    let firstFailed: string | null = null;
    for (const row of checked.filter(isPending)) {
      try {
        const course = await createCourse.mutateAsync({
          semester: created.folder,
          name: row.name,
          abbr: null,
          code: row.code.trim() === '' ? null : row.code,
          color: row.color,
        });
        createdCourses.current.push(course);
        updateRow(row.key, () => ({ done: true, nameError: null, codeError: null }));
      } catch (error: unknown) {
        if (!(error instanceof IpcFailure)) throw error;
        // The code passed its checks, so a name code is about the name (ipc-m1 §16.3).
        const { code } = error.error;
        if (isFolderCode(code)) {
          updateRow(row.key, () => ({ nameError: folderMessage(code, 'course') }));
        } else {
          setBanner(error.error);
        }
        firstFailed ??= rowInputId(idPrefix, row.key, 'name');
      }
    }
    return { created, firstFailed };
  };

  const skip = () => {
    if (submitting) return;
    finish(semester, []);
  };

  const onEnter = (key: string, field: RowField) => {
    const index = rows.findIndex((row) => row.key === key);
    const row = rows[index];
    // Enter in a name with text adds a row below it and moves to its code (§5.1).
    if (field === 'name' && row !== undefined && row.name.trim() !== '' && !submitting) {
      const added = newRow(rows);
      setRows([...rows.slice(0, index + 1), added, ...rows.slice(index + 1)]);
      focusOn(rowInputId(idPrefix, added.key, 'code'));
      return;
    }
    void submit();
  };

  const running = semester === null && named === 0 ? t('courses.creatingSemester') : t('courses.creating', { count: named });
  const primary =
    semester !== null
      ? named === 0
        ? t('review.finish')
        : t('courses.submitMore', { count: named })
      : named === 0
        ? t('courses.submitSemester')
        : t('courses.submit', { count: named });
  const title = t('courses.title');

  return (
    <Frame windowTitle={t('documentTitle.page', { page: title })} layout="step" busy={submitting} focus={semesterInput}>
      <div className="step" data-tall>
        <StepHeader
          step={t('step.two')}
          title={title}
          intro={noFolders ? t('courses.introNoFolders') : t('courses.intro')}
        />
        <Field
          label={t('courses.semesterLabel')}
          value={shownSemester}
          onChange={(value) => {
            setSemesterName(value);
            setSemesterCode(null);
          }}
          error={semesterShown === null ? null : folderMessage(semesterShown, 'semester')}
          help={t('courses.semesterHelp')}
          width="short"
          readOnly={submitting || semester !== null}
          inputRef={semesterInput}
          onBlur={() => {
            if (semester === null) setSemesterCode(checkFolderName(semesterName, true));
          }}
          onEnter={() => {
            void submit();
          }}
        />
        <section className="step__section" aria-labelledby={`${idPrefix}-courses`}>
          <h2 id={`${idPrefix}-courses`} className="step__label">
            {t('courses.label')}
          </h2>
          <CourseRows
            rows={rows}
            mode="new"
            idPrefix={idPrefix}
            busy={submitting}
            onChange={(key, change) => {
              // Typing clears the shell's message and flags characters at once (§8).
              updateRow(key, (row, all) =>
                'color' in change ? change : { ...change, ...checkRow({ ...row, ...change }, all, true) },
              );
            }}
            onBlur={(key, field) => {
              updateRow(key, (row, all) => {
                if (!isPending(row)) return {};
                const checked = checkRow(row, all, false);
                return field === 'code' ? { codeError: checked.codeError } : { nameError: checked.nameError };
              });
            }}
            onEnter={onEnter}
            onRemove={(key) => {
              const index = rows.findIndex((row) => row.key === key);
              const rest = rows.filter((row) => row.key !== key);
              setRows(rest);
              const next = rest[index] ?? rest[index - 1];
              focusOn(next === undefined ? `${idPrefix}-add` : rowInputId(idPrefix, next.key, 'code'));
            }}
            onAdd={() => {
              const added = newRow(rows);
              setRows([...rows, added]);
              focusOn(rowInputId(idPrefix, added.key, 'code'));
            }}
          />
        </section>
        {banner !== null && (
          <Banner size="block" tone="danger" announce title={t(`errors:${banner.code}`)} />
        )}
        <div className="step__footer">
          <div className="step__footer-start">
            <AriaButton className="ghost-button" onPress={skip}>
              {t('courses.skip')}
            </AriaButton>
          </div>
          <div className="step__footer-end">
            <PendingButton
              variant="accent"
              pending={submitting ? running : null}
              onPress={() => {
                void submit();
              }}
            >
              {primary}
            </PendingButton>
          </div>
        </div>
      </div>
    </Frame>
  );
}
