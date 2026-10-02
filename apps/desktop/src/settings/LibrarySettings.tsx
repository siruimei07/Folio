import './settings.css';

import { BookOpen, FileType2, FolderCog, GraduationCap, Tags } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DialogComponentProps } from '../app/registry';
import type { EntryRef } from '../ipc';
import { AddCoursesDialog } from './courses/AddCoursesDialog';
import { CoursesPage } from './courses/CoursesPage';
import { NewSemesterDialog } from './courses/NewSemesterDialog';
import { FileTypesPage } from './library/FileTypesPage';
import { IgnoreRulesPage } from './library/IgnoreRulesPage';
import { LibraryPage } from './library/LibraryPage';
import { SettingsFrame } from './parts/SettingsFrame';
import { usePageOnOpen } from './parts/usePageOnOpen';
import { TagsPage } from './tags/TagsPage';

const PAGES = ['library', 'courses', 'tags', 'fileTypes', 'ignore'] as const;
type LibraryPageId = (typeof PAGES)[number];

/** The dialogs Library settings opens over itself, in the opening they belong to. */
type Nested = ({ kind: 'newSemester' } | { kind: 'addCourses'; semester: EntryRef }) & { opening: number };

/**
 * Library settings, the gear's dialog (app-shell handoff §9, 25A): the library's folder,
 * semesters, courses, tags, file types and ignore rules. Opens on `params.page` when given, else
 * on the page it showed last.
 */
export function LibrarySettings({ isOpen, params, onClose }: DialogComponentProps<'librarySettings'>) {
  const { t } = useTranslation('settings');
  const { page, setPage, opening } = usePageOnOpen(PAGES, isOpen, params?.page);
  const [opened, setNested] = useState<Nested | null>(null);
  // A dialog left open when Library settings closed does not come back with the next opening.
  const nested = isOpen && opened?.opening === opening ? opened : null;
  const closeNested = () => {
    setNested(null);
  };
  const newSemester = () => {
    setNested({ kind: 'newSemester', opening });
  };

  return (
    <SettingsFrame<LibraryPageId>
        key={opening}
        isOpen={isOpen}
        onClose={onClose}
        title={t('library.title')}
        page={page}
        onPageChange={setPage}
        pages={[
          {
            id: 'library',
            label: t('library.pages.library'),
            icon: BookOpen,
            content: <LibraryPage onClose={onClose} onNewSemester={newSemester} />,
          },
          {
            id: 'courses',
            label: t('library.pages.courses'),
            icon: GraduationCap,
            content: (
              <CoursesPage
                onNewSemester={newSemester}
                onAddCourses={(semester) => {
                  setNested({ kind: 'addCourses', semester, opening });
                }}
              />
            ),
          },
          { id: 'tags', label: t('library.pages.tags'), icon: Tags, content: <TagsPage /> },
          { id: 'fileTypes', label: t('library.pages.fileTypes'), icon: FileType2, content: <FileTypesPage /> },
          { id: 'ignore', label: t('library.pages.ignore'), icon: FolderCog, content: <IgnoreRulesPage />, keepMounted: true },
        ]}
    >
      {nested?.kind === 'newSemester' && <NewSemesterDialog isOpen params={undefined} onClose={closeNested} />}
      {nested?.kind === 'addCourses' && (
        <AddCoursesDialog isOpen params={{ semester: nested.semester }} onClose={closeNested} />
      )}
    </SettingsFrame>
  );
}
