import '../settings.css';

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCourseRowsForm } from '../../app/courseRowsForm';
import { reveal } from '../../app/navigation';
import type { DialogComponentProps } from '../../app/registry';
import { showToast } from '../../app/toasts';
import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { Checkbox } from '../../components/Checkbox/Checkbox';
import { CourseRows } from '../../components/CourseRows/CourseRows';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { Field } from '../../components/Field/Field';
import { useCreateSemester, useUpdateSemester } from '../../data/groups';
import { checkFolderName, hasInvalidFolderCharacter, sameFolderName, type Term, termOf } from '../../data/names';
import { useChooseNewSemester, useCurrentSemesterInfo } from '../../data/semester';
import type { IpcError, Semester } from '../../ipc';
import { ipcErrorOf, showFailure } from '../feedback';
import { useCourseRowMessage, useNameMessage } from '../names';
import { useOpening } from '../parts/usePageOnOpen';

/** The terms of a year in order, and the one after each (first-run handoff §1). */
const TERMS = ['winter', 'summer', 'fall'] as const satisfies readonly Term[];
const NEXT_TERM: Readonly<Record<Term, Term>> = { winter: 'summer', summer: 'fall', fall: 'winter' };

/** This term's name, or the first term after it that no semester has, within two years. */
function freeTermName(semesters: readonly Semester[], nameOf: (term: Term, year: number) => string): string {
  let { term, year } = termOf(new Date());
  for (let tries = 0; tries < TERMS.length * 2; tries++) {
    const candidate = nameOf(term, year);
    if (!semesters.some((other) => sameFolderName(other.name, candidate))) return candidate;
    if (term === 'fall') year += 1;
    term = NEXT_TERM[term];
  }
  return nameOf(term, year);
}

/**
 * "New semester" (library-actions handoff §8): the semester's name, its courses, and archiving the
 * current semester. The semester is created first, then each course; a course that fails keeps
 * its row, and the button offers the rest again. Once everything is created the dialog closes on
 * the new semester with its first course shown. Opened from the semester menu, the Library's empty
 * state and Library settings.
 */
export function NewSemesterDialog({ isOpen, onClose }: DialogComponentProps<'newSemester'>) {
  // Each opening starts afresh.
  const opening = useOpening(isOpen);
  return <NewSemesterForm key={opening} isOpen={isOpen} onClose={onClose} />;
}

function NewSemesterForm({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { t } = useTranslation(['settings', 'errors']);
  const message = useNameMessage();
  const { semesters = [], semester: current } = useCurrentSemesterInfo();
  const createSemester = useCreateSemester();
  const archiveSemester = useUpdateSemester();
  const chooseNewSemester = useChooseNewSemester();
  // What the user typed; until then this term's name, or the first term after it that no semester
  // has yet (first-run handoff §1), worked out from the list as it loads.
  const [typed, setName] = useState<string | null>(null);
  const name = typed ?? freeTermName(semesters, (term, year) => t(`semesterDefault.${term}`, { year }));
  const [nameError, setNameError] = useState<string | null>(null);
  const [archive, setArchive] = useState(false);
  const [created, setCreated] = useState<Semester | null>(null);
  const [banner, setBanner] = useState<IpcError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const shownName = created?.name ?? name;
  const form = useCourseRowsForm({
    semesterName: shownName,
    existing: [],
    onSubmit: () => {
      void submit();
    },
    busy: submitting,
    message: useCourseRowMessage(),
  });
  // The semester the checkbox archives: the current one, unless it is archived already.
  const archivable = current !== null && !current.archived ? current : null;

  const finish = async (semester: Semester, firstCourse: Parameters<typeof reveal>[0] | undefined, count: number) => {
    if (archive && archivable !== null) {
      try {
        await archiveSemester.mutateAsync({ semester: archivable.folder, archived: true });
      } catch (failure: unknown) {
        showFailure(t('newSemester.archiveFailed', { semester: archivable.name }), ipcErrorOf(failure), 'settings.newSemester');
      }
    }
    await chooseNewSemester(semester.folder.path);
    if (firstCourse !== undefined) reveal(firstCourse);
    showToast({
      tone: 'success',
      title:
        count === 0
          ? t('newSemester.done', { semester: semester.name })
          : t('newSemester.doneWithCourses', { semester: semester.name, count }),
    });
    onClose();
  };

  const submit = async () => {
    if (submitting) return;
    let semesterProblem: string | null = null;
    if (created === null) {
      const code =
        checkFolderName(name, true) ??
        (semesters.some((other) => sameFolderName(other.name, name)) ? ('AlreadyExists' as const) : null);
      semesterProblem = code === null ? null : message('semester', code, { name: name.trim() });
      setNameError(semesterProblem);
    }
    // The semester's name comes first: it takes focus when both have a problem.
    const rowsValid = form.validate(semesterProblem === null);
    if (semesterProblem !== null) {
      nameInput.current?.focus();
      return;
    }
    if (!rowsValid) return;

    setBanner(null);
    setSubmitting(true);
    try {
      let semester = created;
      if (semester === null) {
        try {
          semester = await createSemester.mutateAsync({ name });
          setCreated(semester);
        } catch (failure: unknown) {
          const error = ipcErrorOf(failure);
          const under = message('semester', error.code, { name: name.trim() });
          if (under === null) setBanner(error);
          else {
            setNameError(under);
            nameInput.current?.focus();
          }
          return;
        }
      }
      const result = await form.create(semester.folder);
      if (result.banner !== null) setBanner(result.banner);
      if (!result.failed) await finish(semester, result.created[0]?.folder, result.created.length);
    } finally {
      setSubmitting(false);
    }
  };

  const primary =
    created !== null
      ? t('newSemester.submitMore', { count: form.named })
      : form.named === 0
        ? t('newSemester.submitSemester')
        : t('newSemester.submit', { count: form.named });

  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
      size="medium"
      title={t('newSemester.title')}
      footer={
        <>
          <Button size="dialog" onPress={onClose} isDisabled={submitting}>
            {created === null ? t('cancel') : t('newSemester.close')}
          </Button>
          <PendingButton
            variant="accent"
            pending={submitting ? t('newSemester.creating') : null}
            isDisabled={created !== null && form.pending === 0}
            onPress={() => {
              void submit();
            }}
          >
            {primary}
          </PendingButton>
        </>
      }
    >
      <Field
        label={t('newSemester.name')}
        value={shownName}
        onChange={(value) => {
          setName(value);
          setNameError(hasInvalidFolderCharacter(value) ? message('semester', 'NameInvalidCharacter') : null);
        }}
        error={nameError}
        help={t('newSemester.nameHelp')}
        readOnly={submitting || created !== null}
        inputRef={nameInput}
        autoFocus
        onEnter={() => {
          void submit();
        }}
      />
      <section className="settings-dialog-section" aria-labelledby={`${form.rowsProps.idPrefix}-heading`}>
        <h3 id={`${form.rowsProps.idPrefix}-heading`} className="settings-dialog-section__title">
          {t('newSemester.courses')}
        </h3>
        <CourseRows {...form.rowsProps} busy={submitting} help={t('newSemester.rowsHelp')} />
      </section>
      {archivable !== null && created === null && (
        <Checkbox isSelected={archive} onChange={setArchive} isDisabled={submitting}>
          {t('newSemester.archive', { semester: archivable.name })}
        </Checkbox>
      )}
      {banner !== null && <Banner tone="danger" size="block" announce title={t(`errors:${banner.code}`)} />}
    </DialogFrame>
  );
}
