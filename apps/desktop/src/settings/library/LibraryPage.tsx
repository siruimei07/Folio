import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { showFolder } from '../../app/startFlow';
import { Button } from '../../components/Button/Button';
import { Field } from '../../components/Field/Field';
import { Select } from '../../components/Select/Select';
import { useLibrary, usePickLibraryFolder } from '../../data/library';
import { useCurrentSemesterInfo } from '../../data/semester';
import { setCurrentSemester } from '../../data/session';
import { ipcErrorOf, showFailure } from '../feedback';
import { Card, Page, Row, Rows } from '../parts/Card';
import { RebuildCard } from './RebuildCard';

/** Where a failed folder dialog goes in the log. */
const PICK_SOURCE = 'settings.pickFolder';

export interface LibraryPageProps {
  /** Closes Library settings, before the first run's step 1 takes the window. */
  onClose: () => void;
  onNewSemester: () => void;
}

/**
 * Library settings → Library (app-shell handoff §9): the library folder with "Change…", the
 * current semester with "New semester…", where deleted files go, and "Rebuild search index".
 */
export function LibraryPage({ onClose, onNewSemester }: LibraryPageProps) {
  const { t } = useTranslation('settings');
  const library = useLibrary();
  const { semesters = [], semester } = useCurrentSemesterInfo();
  const pick = usePickLibraryFolder();
  const change = useRef<HTMLButtonElement>(null);
  const semesterHelp = useId();

  // "Change…": the folder dialog, then the first run's step 1 for the folder it answers with,
  // which opens a library there, starts a new one or takes the folder over (first-run handoff §4).
  const chooseFolder = async () => {
    let choice;
    try {
      choice = await pick.mutateAsync();
    } catch (error: unknown) {
      showFailure(t('folder.pickFailed'), ipcErrorOf(error), PICK_SOURCE);
      return;
    }
    if (choice === null) {
      change.current?.focus();
      return;
    }
    onClose();
    showFolder(choice, 'change');
  };

  // Archived semesters stay choosable, as in the semester menu; they say so.
  const options = semesters.map((candidate) => ({
    id: candidate.folder.path,
    label: candidate.archived ? t('semester.archivedOption', { name: candidate.name }) : candidate.name,
  }));

  return (
    <Page>
      <Card>
        <div className="settings-fields">
          <Field
            label={t('folder.label')}
            value={library?.root ?? ''}
            onChange={() => undefined}
            error={null}
            readOnly
            help={t('folder.help')}
            trailing={
              <Button
                ref={change}
                size="dialog"
                isDisabled={pick.isPending}
                onPress={() => {
                  void chooseFolder();
                }}
              >
                {t('folder.change')}
              </Button>
            }
          />
          <div className="settings-select-field">
            <div className="settings-select-field__row">
              {options.length > 0 ? (
                <Select
                  label={t('semester.label')}
                  aria-describedby={semesterHelp}
                  options={options}
                  selected={semester?.folder.path ?? null}
                  onChange={(path) => {
                    setCurrentSemester(path);
                  }}
                />
              ) : (
                <p className="settings-select-field__none">
                  <span className="settings-select-field__label">{t('semester.label')}</span>
                  {t('semester.none')}
                </p>
              )}
              <Button onPress={onNewSemester} isDisabled={library?.readOnly === true}>
                {t('semester.new')}
              </Button>
            </div>
            <p id={semesterHelp} className="field__help">
              {t('semester.help')}
            </p>
          </div>
        </div>
      </Card>
      <Rows>
        <Row
          label={t('deleted.label')}
          description={t('deleted.description')}
          control={() => <span className="settings-row__value">{t('deleted.value')}</span>}
        />
      </Rows>
      <RebuildCard />
    </Page>
  );
}
