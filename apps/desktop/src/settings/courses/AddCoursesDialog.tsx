import '../settings.css';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCourseRowsForm } from '../../app/courseRowsForm';
import { reveal } from '../../app/navigation';
import type { DialogComponentProps } from '../../app/registry';
import { showToast } from '../../app/toasts';
import { Banner } from '../../components/Banner/Banner';
import { Button } from '../../components/Button/Button';
import { PendingButton } from '../../components/Button/PendingButton';
import { CourseRows } from '../../components/CourseRows/CourseRows';
import { DialogFrame } from '../../components/Dialog/Dialog';
import { useCourses, useSemesters } from '../../data/groups';
import type { Course, EntryRef, IpcError } from '../../ipc';
import { useCourseRowMessage } from '../names';
import { useOpening } from '../parts/usePageOnOpen';

/**
 * "Add courses to Winter 2027" (library-actions handoff §8): only the course rows; each is created
 * in turn, and one that fails keeps its row. Opened from the Library's empty semester and from
 * Library settings → Courses ("New course").
 */
export function AddCoursesDialog({ isOpen, params, onClose }: DialogComponentProps<'addCourses'>) {
  // Each opening starts afresh.
  const opening = useOpening(isOpen);
  const semesters = useSemesters();
  const courses = useCourses(params.semester.path);
  const semester = semesters.data?.find((candidate) => candidate.folder.id === params.semester.id);
  return (
    <AddCoursesForm
      // Starts again once the semester's courses arrive, so the first row's colour and the
      // taken names count them (an opening right after start-up can come before they load).
      key={`${String(opening)}-${courses.data === undefined ? 'loading' : 'loaded'}`}
      isOpen={isOpen}
      onClose={onClose}
      semester={params.semester}
      semesterName={semester?.name ?? params.semester.path}
      existing={courses.data ?? []}
    />
  );
}

interface AddCoursesFormProps {
  isOpen: boolean;
  onClose: () => void;
  semester: EntryRef;
  semesterName: string;
  existing: readonly Course[];
}

function AddCoursesForm({ isOpen, onClose, semester, semesterName, existing }: AddCoursesFormProps) {
  const { t } = useTranslation(['settings', 'errors']);
  const [banner, setBanner] = useState<IpcError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [added, setAdded] = useState<Course[]>([]);
  const form = useCourseRowsForm({
    semesterName,
    existing,
    onSubmit: () => {
      void submit();
    },
    autoFocus: true,
    busy: submitting,
    message: useCourseRowMessage(),
  });

  const submit = async () => {
    if (submitting || form.pending === 0 || !form.validate()) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const result = await form.create(semester);
      const all = [...added, ...result.created];
      setAdded(all);
      if (result.banner !== null) setBanner(result.banner);
      if (result.failed) return;
      const [first] = all;
      if (first !== undefined) reveal(first.folder);
      showToast({ tone: 'success', title: t('addCourses.done', { semester: semesterName, count: all.length }) });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
      size="medium"
      title={t('addCourses.title', { semester: semesterName })}
      footer={
        <>
          <Button size="dialog" onPress={onClose} isDisabled={submitting}>
            {added.length === 0 ? t('cancel') : t('newSemester.close')}
          </Button>
          <PendingButton
            variant="accent"
            pending={submitting ? t('addCourses.adding') : null}
            isDisabled={form.pending === 0}
            onPress={() => {
              void submit();
            }}
          >
            {t('addCourses.submit', { count: form.named })}
          </PendingButton>
        </>
      }
    >
      <CourseRows {...form.rowsProps} busy={submitting} help={t('newSemester.rowsHelp')} />
      {banner !== null && <Banner tone="danger" size="block" announce title={t(`errors:${banner.code}`)} />}
    </DialogFrame>
  );
}
