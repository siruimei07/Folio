import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button/Button';
import { CourseBadge } from '../../components/CourseBadge/CourseBadge';
import { Select } from '../../components/Select/Select';
import { Skeleton } from '../../components/Skeleton/Skeleton';
import { Switch } from '../../components/Switch/Switch';
import { useCourses, useReorderCourses, useUpdateCourse, useUpdateSemester } from '../../data/groups';
import { useLibrary } from '../../data/library';
import { useCurrentSemesterInfo } from '../../data/semester';
import type { Course, EntryRef, IpcError, Semester } from '../../ipc';
import { courseCode, courseNameAfterCode, courseTitle } from '../../lib/courses';
import { ipcErrorOf, LoadFailure, showFailure, useRetryFailed } from '../feedback';
import { Card, Page, Row, Rows } from '../parts/Card';
import { ReadOnlyBanner } from '../parts/ReadOnlyBanner';
import { ReorderList, type ReorderRow } from '../parts/ReorderList';
import { RowMenu, type RowMenuItem } from '../parts/RowMenu';
import { EditCourseDialog } from './EditCourseDialog';

export interface CoursesPageProps {
  onNewSemester: () => void;
  onAddCourses: (semester: EntryRef) => void;
}

/** A course's code column and name (26C): the code in 600, then the name; no code, the name in 600. */
function CourseName({ course }: { course: Course }) {
  const code = courseCode(course);
  return (
    <span className="course-line__label" title={courseTitle(course)}>
      <span className="course-line__code">{code}</span>
      <span className="course-line__name" data-strong={code === null || undefined}>
        {courseNameAfterCode(course)}
      </span>
    </span>
  );
}

/**
 * Library settings → Courses (app-shell handoff §9): the courses of a semester in the user's
 * order, each with its badge, code, name and file count and a menu to edit, move or archive it;
 * "New course"; the archived ones apart; and archiving the semester itself.
 */
export function CoursesPage({ onNewSemester, onAddCourses }: CoursesPageProps) {
  const { t } = useTranslation('settings');
  const library = useLibrary();
  const readOnly = library?.readOnly === true;
  const current = useCurrentSemesterInfo();
  // The page shows the current semester until another is chosen here; the toolbar's stays.
  const [chosen, setChosen] = useState<string | null>(null);
  const semesters = current.semesters ?? [];
  const semester = semesters.find((candidate) => candidate.folder.path === chosen) ?? current.semester;
  const courses = useCourses(semester?.folder.path ?? null);
  const [editing, setEditing] = useState<Course | null>(null);
  const retry = useRetryFailed();

  if (current.status === 'error' && current.error !== null) {
    return (
      <Page>
        <LoadFailure title={t('courses.loadFailed')} error={current.error.error} retry={retry} />
      </Page>
    );
  }
  if (current.status === 'pending') {
    return (
      <Page>
        <Skeleton rows={4} />
      </Page>
    );
  }
  if (semester === null) {
    return (
      <Page>
        <ReadOnlyBanner />
        <Card title={t('courses.noSemesters.title')} description={t('courses.noSemesters.text')}>
          <div className="settings-card__buttons">
            <Button variant="accent" icon={Plus} onPress={onNewSemester} isDisabled={readOnly}>
              {t('semester.new')}
            </Button>
          </div>
        </Card>
      </Page>
    );
  }

  return (
    <Page>
      <ReadOnlyBanner />
      {semesters.length > 1 && (
        <div className="settings-page__bar">
          <Select
            label={t('courses.semesterLabel')}
            options={semesters.map((candidate) => ({
              id: candidate.folder.path,
              label: candidate.archived ? t('semester.archivedOption', { name: candidate.name }) : candidate.name,
            }))}
            selected={semester.folder.path}
            onChange={setChosen}
          />
        </div>
      )}
      <SemesterCourses
        semester={semester}
        courses={courses.data}
        error={courses.error?.error ?? null}
        retry={retry}
        readOnly={readOnly}
        onEdit={setEditing}
        onAdd={() => {
          onAddCourses(semester.folder);
        }}
      />
      <ArchiveSemester semester={semester} readOnly={readOnly} />
      {editing !== null && (
        <EditCourseDialog
          course={editing}
          semester={semester}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Page>
  );
}

interface SemesterCoursesProps {
  semester: Semester;
  courses: readonly Course[] | undefined;
  error: IpcError | null;
  retry: () => void;
  readOnly: boolean;
  onEdit: (course: Course) => void;
  onAdd: () => void;
}

function SemesterCourses({ semester, courses, error, retry, readOnly, onEdit, onAdd }: SemesterCoursesProps) {
  const { t } = useTranslation('settings');
  const update = useUpdateCourse();
  const reorder = useReorderCourses();
  const active = courses?.filter((course) => !course.archived) ?? [];
  const archived = courses?.filter((course) => course.archived) ?? [];

  const setArchived = (course: Course, value: boolean) => {
    update
      .mutateAsync({ course: course.folder, abbr: course.abbr, code: course.code, color: course.color, archived: value })
      .catch((failure: unknown) => {
        const name = courseTitle(course);
        showFailure(
          value ? t('courses.archiveFailed', { name }) : t('courses.restoreFailed', { name }),
          ipcErrorOf(failure),
          'settings.archiveCourse',
        );
      });
  };

  // `reorder_courses` takes every course of the semester: the archived ones keep their places
  // between the active ones, which take the new order.
  const saveOrder = async (keys: string[]): Promise<boolean> => {
    if (courses === undefined) return false;
    const byPath = new Map(courses.map((course) => [course.folder.path, course]));
    const moved = keys.flatMap((key) => byPath.get(key) ?? []);
    let next = 0;
    const order = courses.map((course) => (course.archived ? course : (moved[next++] ?? course)));
    try {
      await reorder.mutateAsync({ semester: semester.folder, courses: order.map((course) => course.folder) });
      return true;
    } catch (failure: unknown) {
      showFailure(t('courses.reorderFailed'), ipcErrorOf(failure), 'settings.reorderCourses');
      return false;
    }
  };

  // A course's menu (§9): Edit…, then Move up, Move down and Archive, or Restore when archived.
  const menu = (course: Course, row?: ReorderRow): RowMenuItem[] => {
    const unlessReadOnly = (action: () => void) => (readOnly ? undefined : action);
    const edit: RowMenuItem = {
      id: 'edit',
      label: t('courses.edit'),
      icon: Pencil,
      onAction: unlessReadOnly(() => {
        onEdit(course);
      }),
    };
    if (row === undefined) {
      const restore = unlessReadOnly(() => {
        setArchived(course, false);
      });
      return [edit, { id: 'restore', label: t('courses.restore'), icon: ArchiveRestore, onAction: restore }];
    }
    const archive = unlessReadOnly(() => {
      setArchived(course, true);
    });
    return [
      edit,
      { id: 'up', label: t('reorder.moveUp'), icon: ArrowUp, onAction: row.moveUp },
      { id: 'down', label: t('reorder.moveDown'), icon: ArrowDown, onAction: row.moveDown },
      { id: 'archive', label: t('courses.archive'), icon: Archive, onAction: archive },
    ];
  };

  const title = t('courses.title', { semester: semester.name });
  return (
    <>
      <Card
        title={title}
        description={readOnly ? t('courses.descriptionReadOnly') : t('courses.description')}
        action={
          <Button icon={Plus} onPress={onAdd} isDisabled={readOnly}>
            {t('courses.new')}
          </Button>
        }
      >
        {error !== null ? (
          <LoadFailure title={t('courses.loadFailed')} error={error} retry={retry} />
        ) : courses === undefined ? (
          <Skeleton rows={4} />
        ) : active.length === 0 ? (
          <p className="settings-card__empty">{t('courses.empty', { semester: semester.name })}</p>
        ) : (
          <ReorderList
            label={title}
            items={active}
            keyOf={(course) => course.folder.path}
            nameOf={courseTitle}
            onReorder={saveOrder}
            isDisabled={readOnly}
          >
            {(course, row) => (
              <>
                <CourseBadge course={course} />
                <CourseName course={course} />
                <span className="settings-list__meta">{t('courses.files', { count: course.files })}</span>
                <RowMenu label={t('courses.more', { course: courseTitle(course) })} items={menu(course, row)} />
              </>
            )}
          </ReorderList>
        )}
      </Card>
      {archived.length > 0 && (
        <Card title={t('courses.archivedTitle')} description={t('courses.archivedDescription')}>
          <ul className="settings-list" aria-label={t('courses.archivedLabel', { semester: semester.name })}>
            {archived.map((course) => (
              <li key={course.folder.path} className="settings-list__row">
                <CourseBadge course={course} />
                <CourseName course={course} />
                <span className="settings-list__meta">{t('courses.files', { count: course.files })}</span>
                <RowMenu label={t('courses.more', { course: courseTitle(course) })} items={menu(course)} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/** "Archive Fall 2026": the switch applies at once (§9); the semester menu lists it apart. */
function ArchiveSemester({ semester, readOnly }: { semester: Semester; readOnly: boolean }) {
  const { t } = useTranslation('settings');
  const update = useUpdateSemester();
  // The switch shows the new state from the press until the semester list has it.
  const [pending, setPending] = useState<boolean | null>(null);
  if (pending !== null && pending === semester.archived) setPending(null);
  const label = t('courses.archiveSemester', { semester: semester.name });
  const toggle = (archived: boolean) => {
    setPending(archived);
    update.mutateAsync({ semester: semester.folder, archived }).catch((failure: unknown) => {
      setPending(null);
      showFailure(
        archived
          ? t('courses.archiveFailed', { name: semester.name })
          : t('courses.restoreFailed', { name: semester.name }),
        ipcErrorOf(failure),
        'settings.archiveSemester',
      );
    });
  };
  return (
    <Rows>
      <Row
        label={label}
        description={t('courses.archiveSemesterDescription')}
        control={({ description }) => (
          <Switch
            label={label}
            aria-describedby={description}
            isSelected={pending ?? semester.archived}
            isDisabled={readOnly || update.isPending}
            onChange={toggle}
          />
        )}
      />
    </Rows>
  );
}
