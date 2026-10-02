import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton } from 'react-aria-components';

import { useCourseRowsForm } from '../app/courseRowsForm';
import { reveal } from '../app/navigation';
import { endFlow } from '../app/startFlow';
import { Banner } from '../components/Banner/Banner';
import { PendingButton } from '../components/Button/PendingButton';
import { CourseRows } from '../components/CourseRows/CourseRows';
import { Field } from '../components/Field/Field';
import { IpcFailure } from '../data/errors';
import { useCreateSemester } from '../data/groups';
import { checkFolderName, type FolderCode, hasInvalidFolderCharacter, isFolderCode, termOf } from '../data/names';
import { setCurrentSemester } from '../data/session';
import type { Course, IpcError, Semester } from '../ipc';
import { Frame } from './Frame';
import { StepHeader } from './Step';

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
  const [banner, setBanner] = useState<IpcError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The semester field takes focus once it has rendered; a new object asks again.
  const [focusSemester, setFocusSemester] = useState<object | null>(null);
  const semesterInput = useRef<HTMLInputElement>(null);
  /** Courses created so far, by every attempt, in order. */
  const createdCourses = useRef<Course[]>([]);
  const createSemester = useCreateSemester();

  useEffect(() => {
    if (focusSemester !== null) semesterInput.current?.focus();
  }, [focusSemester]);

  const shownSemester = semester?.name ?? semesterName;
  const folderMessage = (code: FolderCode, field: 'semester' | 'course', inSemester: string) => {
    switch (code) {
      case 'NameEmpty':
      case 'NameInvalidCharacter':
        return t(`fields.${field}.${code}`);
      case 'AlreadyExists':
        return field === 'semester'
          ? t('fields.semester.AlreadyExists', { name: semesterName.trim() })
          : inSemester === ''
            ? t('fields.course.AlreadyExistsHere')
            : t('fields.course.AlreadyExists', { semester: inSemester });
      default:
        return t(`fields.folder.${code}`);
    }
  };
  const form = useCourseRowsForm({
    semesterName: shownSemester,
    existing: [],
    onSubmit: () => {
      void submit();
    },
    busy: submitting,
    message: (field, code, inSemester) => {
      if (field === 'code') return code === 'NameTooLong' || code === 'NameInvalidCharacter' ? t(`fields.code.${code}`) : null;
      return isFolderCode(code) ? folderMessage(code, 'course', inSemester) : null;
    },
  });
  const semesterTyped = hasInvalidFolderCharacter(semesterName) ? 'NameInvalidCharacter' : null;
  const semesterShown = semester === null ? (semesterTyped ?? semesterCode) : null;

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
    setSemesterCode(semesterProblem);
    const rowsValid = form.validate(semesterProblem === null);
    if (semesterProblem !== null) {
      setFocusSemester({});
      return;
    }
    if (!rowsValid) return;

    // 2. The semester, then each course in order.
    setBanner(null);
    setSubmitting(true);
    try {
      let created = semester;
      if (created === null) {
        try {
          created = await createSemester.mutateAsync({ name: semesterName });
          setSemester(created);
        } catch (error: unknown) {
          if (!(error instanceof IpcFailure)) throw error;
          if (isFolderCode(error.error.code)) {
            setSemesterCode(error.error.code);
            setFocusSemester({});
          } else {
            setBanner(error.error);
          }
          return;
        }
      }
      const result = await form.create(created.folder);
      createdCourses.current.push(...result.created);
      if (result.banner !== null) setBanner(result.banner);
      if (!result.failed) finish(created, createdCourses.current);
    } finally {
      setSubmitting(false);
    }
  };

  const skip = () => {
    if (submitting) return;
    finish(semester, []);
  };

  const running =
    semester === null && form.named === 0 ? t('courses.creatingSemester') : t('courses.creating', { count: form.named });
  const primary =
    semester !== null
      ? form.named === 0
        ? t('review.finish')
        : t('courses.submitMore', { count: form.named })
      : form.named === 0
        ? t('courses.submitSemester')
        : t('courses.submit', { count: form.named });
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
          error={semesterShown === null ? null : folderMessage(semesterShown, 'semester', '')}
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
          <CourseRows {...form.rowsProps} help={t('courses.help')} busy={submitting} />
        </section>
        {banner !== null && <Banner size="block" tone="danger" announce title={t(`errors:${banner.code}`)} />}
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
