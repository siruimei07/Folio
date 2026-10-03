import '../components/Select/Select.css';
import './ImportDialog.css';

import { ChevronDown, Folder, TriangleAlert } from 'lucide-react';
import { type ComponentType, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button as AriaButton, Dialog as AriaDialog, DialogTrigger } from 'react-aria-components';

import { noteImport } from '../app/activity/notes';
import { DETAILED, showFailure, whenSettled } from '../app/feedback';
import { reportUiError } from '../app/log';
import type { DialogComponentProps } from '../app/registry';
import { copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import { PendingButton } from '../components/Button/PendingButton';
import { Checkbox } from '../components/Checkbox/Checkbox';
import { CourseBadge } from '../components/CourseBadge/CourseBadge';
import { CourseLabel } from '../components/CourseLabel/CourseLabel';
import { DialogFrame } from '../components/Dialog/Dialog';
import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { MiddleTruncate } from '../components/MiddleTruncate/MiddleTruncate';
import { Popover } from '../components/Popover/Popover';
import { Spinner } from '../components/Progress/Progress';
import { RadioGroup } from '../components/RadioGroup/RadioGroup';
import { TagToggle } from '../components/TagChip/TagChip';
import { IpcFailure } from '../data/errors';
import { useCourses } from '../data/groups';
import { useImportCheck, useImportFiles, usePickImportFiles } from '../data/import';
import { useLibrary } from '../data/library';
import { useCurrentSemester, useLibraryId } from '../data/session';
import { useTags } from '../data/tags';
import type { EntryRef, ImportCheck, ImportFiles, ImportSource, IpcError } from '../ipc';
import { sizeParts } from '../lib/format';
import { nameOf } from '../lib/paths';
import { courseIn, placeOf, placeParts } from '../lib/places';
import { SIZE } from '../tokens/tokens';
import { clashSentence, type ImportT, keepBothName, LISTED_ITEMS, moreItems } from './words';

/** The folder picker of library-actions §2.9, which the Library provides (`app/registry.ts`). */
export interface FolderPickerProps {
  semester: string | null;
  /** What is being moved; nothing for an import. */
  moving: readonly EntryRef[];
  chosen: EntryRef | null;
  onChoose: (folder: EntryRef) => void;
}

type ConflictPolicy = ImportFiles['onConflict'];

/** Why the dialog cannot go on, from `check_import` or `import_files` (§4.2). */
type Problem =
  | { kind: 'expired' }
  | { kind: 'gone' }
  | { kind: 'readOnly' }
  | { kind: 'busy' }
  | { kind: 'failed'; title: 'errors.checkFailed' | 'errors.addFailed'; error: IpcError };

function problemOf(error: IpcError, during: 'check' | 'add'): Problem {
  switch (error.code) {
    case 'ChoiceExpired':
      return { kind: 'expired' };
    case 'NotFound':
      return { kind: 'gone' };
    case 'ReadOnly':
      return { kind: 'readOnly' };
    case 'Busy':
      return { kind: 'busy' };
    default:
      return { kind: 'failed', title: during === 'check' ? 'errors.checkFailed' : 'errors.addFailed', error };
  }
}

/** "12 files in 1 folder · 48.2 MB". */
function summaryOf(t: ImportT, check: ImportCheck, language: string): string {
  const { value, unit } = sizeParts(Number(check.bytes), language);
  const size = t(`common:size.${unit}`, { value });
  const files = t('dialog.files', { count: check.files });
  return check.folders === 0
    ? t('dialog.summaryNoFolders', { files, size })
    : t('dialog.summary', { files, folders: t('dialog.folders', { count: check.folders }), size });
}

/** The first three items by name, then "and Formula sheet.pdf" or "and 7 more" (§4). */
function Items({ source }: { source: ImportSource }) {
  const { t } = useTranslation(['import', 'common', 'errors']);
  const more = moreItems(t, source.names, source.files + source.folders);
  return (
    <div className="import-items">
      <ul className="import-items__list" aria-label={t('dialog.items')}>
        {source.names.slice(0, LISTED_ITEMS).map((item, index) => (
          <li key={index} className="import-items__row">
            {item.kind === 'folder' ? (
              <Folder aria-hidden size={SIZE.icon} className="import-items__folder-icon" />
            ) : (
              <FileTypeIcon name={item.name} />
            )}
            <span className="import-items__name">
              <MiddleTruncate text={item.name} />
            </span>
            {item.kind === 'folder' && <span className="import-items__kind">{t('dialog.folder')}</span>}
          </li>
        ))}
      </ul>
      {more !== null && <p className="import-items__more">{more}</p>}
    </div>
  );
}

interface ClashesProps {
  check: ImportCheck;
  target: EntryRef;
  label: string;
  policy: ConflictPolicy;
  onChange: (policy: ConflictPolicy) => void;
}

/** One choice for every name that is taken (§4.1); Keep both comes first and is the default. */
function Clashes({ check, target, label, policy, onChange }: ClashesProps) {
  const { t } = useTranslation(['import', 'common', 'errors']);
  const headingId = useId();
  const count = check.conflictCount;
  const example = keepBothName(check.conflicts[0]?.path ?? '');
  return (
    <div className="import-clashes" role="group" aria-labelledby={headingId}>
      <div className="import-clashes__head">
        <TriangleAlert aria-hidden size={SIZE.icon} className="import-clashes__icon" />
        <div className="import-clashes__words">
          <p id={headingId} className="import-clashes__heading">
            {t('clashes.heading', { count, target: label })}
          </p>
          <p className="import-clashes__paths">{clashSentence(t, check.conflicts, count, target.path)}</p>
        </div>
      </div>
      <div className="import-clashes__choices">
        <RadioGroup<ConflictPolicy>
          label={t('clashes.label')}
          hideLabel
          selected={policy}
          onChange={onChange}
          choices={[
            { id: 'keepBoth', label: t('clashes.keepBoth'), description: t('clashes.keepBothText', { count, example }) },
            { id: 'replace', label: t('clashes.replace'), description: t('clashes.replaceText', { count, target: label }) },
            { id: 'skip', label: t('clashes.skip'), description: t('clashes.skipText', { count, target: label }) },
          ]}
        />
      </div>
    </div>
  );
}

interface ImportDialogProps extends DialogComponentProps<'import'> {
  Picker: ComponentType<FolderPickerProps>;
}

/**
 * Adding files (library-actions handoff §4): what is being added and its size, where it goes,
 * the tags it gets, one choice for every name that is taken, and whether the originals go to the
 * Recycle Bin. `check_import` runs as it opens and when the destination changes; "Add" starts
 * `import_files`, which uses up the selection, and the dialog closes for the progress toast.
 */
function ImportDialog({ isOpen, params, onClose, Picker }: ImportDialogProps) {
  const { t, i18n } = useTranslation(['import', 'common', 'errors', 'shell']);
  const library = useLibrary();
  const libraryId = useLibraryId();
  const readOnly = library?.readOnly ?? false;
  const allTags = useTags().data ?? [];
  const currentSemester = useCurrentSemester();
  const [source, setSource] = useState(params.source);
  const [target, setTarget] = useState(params.target);
  const [tags, setTags] = useState<ReadonlySet<string>>(() => new Set(readOnly ? [] : (params.tags ?? [])));
  const [policy, setPolicy] = useState<ConflictPolicy>('keepBoth');
  const [deleteOriginals, setDeleteOriginals] = useState(false);
  // Once `import_files` took the selection, the check is never asked again: it would only say
  // that the selection has expired (choices are single use, ipc-m1 §4.2). A closed dialog stays
  // mounted, and does not ask either.
  const [started, setStarted] = useState(false);
  const [addProblem, setAddProblem] = useState<Problem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const ids = { addTo: useId(), target: useId(), tags: useId(), tagsHelp: useId() };
  const asking = isOpen && !started;
  const check = useImportCheck(asking ? source.token : null, target);
  // The last answer stays while the dialog fades out.
  const [lastCheck, setLastCheck] = useState<ImportCheck | undefined>(undefined);
  if (check.data !== undefined && check.data !== lastCheck) setLastCheck(check.data);
  const importFiles = useImportFiles();
  const pick = usePickImportFiles();

  const semester = target?.path.split('/')[0] ?? currentSemester;
  const loaded = useCourses(semester).data;
  const courses = loaded ?? [];
  const course = target === null ? undefined : courseIn(target.path, courses);
  // Until the courses arrive, the folder's own name.
  const label = target === null ? null : loaded === undefined ? nameOf(target.path) : placeOf(target.path, courses);

  const checked = asking ? check.data : lastCheck;
  const problem = addProblem ?? (check.error === null ? null : problemOf(check.error.error, 'check'));
  const checking = asking && target !== null && check.isPending && problem === null;
  const files = checked?.files ?? 0;
  const adding = importFiles.isPending;

  const chooseTarget = (folder: EntryRef) => {
    setTarget(folder);
    setPickerOpen(false);
    setAddProblem(null);
  };

  // When Add can run. An expired selection is never sent again, nor files to a place that is gone:
  // the banner's button picks new files or another place first.
  const nothing = checked !== undefined && files === 0;
  const stopped = problem?.kind === 'expired' || problem?.kind === 'gone';
  const blocked = stopped || target === null || nothing || checked === undefined;

  const add = async (withTags: ReadonlySet<string> = tags) => {
    if (blocked || adding) return;
    const known = [...withTags].filter((id) => allTags.some((tag) => tag.id === id));
    setAddProblem(null);
    try {
      const id = await importFiles.mutateAsync({
        source: source.token,
        target,
        tags: known,
        onConflict: policy,
        deleteOriginals,
      });
      setStarted(true);
      if (libraryId !== null) noteImport(id, { libraryId, target, label: label ?? '', files });
      onClose();
    } catch (failure: unknown) {
      if (!(failure instanceof IpcFailure)) throw failure;
      const next = problemOf(failure.error, 'add');
      if (next.kind === 'failed' && DETAILED.has(failure.error.code)) reportUiError('command', 'import.add', failure.error);
      setAddProblem(next);
    }
  };

  const chooseFiles = () => {
    whenSettled(
      pick.mutateAsync(),
      'import.pick',
      (picked) => {
        if (picked === null) return;
        setSource(picked);
        setAddProblem(null);
      },
      (failure) => {
        showFailure(t('errors.pickFailed'), failure.error, 'import.pick');
      },
    );
  };

  /** The banner of a problem (§4.2): its tone and words, and the one button that moves on. */
  const bannerOf = (shown: Problem) => {
    switch (shown.kind) {
      case 'expired':
        return { tone: 'warning', title: t('errors.expiredTitle'), text: t('errors.expiredText'), action: t('errors.expiredAction'), onPress: chooseFiles } as const;
      case 'gone':
        return {
          tone: 'warning',
          title: t('errors.goneTitle', { target: label ?? '' }),
          text: t('errors.goneText'),
          action: t('errors.goneAction'),
          onPress: () => {
            setPickerOpen(true);
          },
        } as const;
      case 'readOnly':
        return {
          tone: 'warning',
          title: t('errors.readOnlyTitle'),
          text: t('errors.readOnlyText'),
          action: t('dialog.add', { count: files }),
          onPress: () => {
            const none = new Set<string>();
            setTags(none);
            void add(none);
          },
        } as const;
      case 'busy':
        return { tone: 'info', title: t('errors.busyTitle'), text: t('errors.busyText'), action: t('errors.busyAction'), onPress: onClose } as const;
      case 'failed': {
        const title = t(shown.title);
        return {
          tone: 'danger',
          title,
          text: t(`errors:${shown.error.code}`),
          action: t('shell:copyDetails.action'),
          onPress: () => {
            copyErrorDetails(title, shown.error);
          },
        } as const;
      }
    }
  };
  const words = problem === null ? null : bannerOf(problem);
  const banner =
    words === null ? undefined : (
      <Banner
        tone={words.tone}
        size="block"
        announce
        title={words.title}
        text={words.text}
        actions={
          <Button autoFocus onPress={words.onPress}>
            {words.action}
          </Button>
        }
      />
    );

  const primary = target === null || checking ? t('dialog.addFiles') : nothing ? t('dialog.nothing') : t('dialog.add', { count: files });

  return (
    <DialogFrame
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !adding) onClose();
      }}
      size="medium"
      className="import-dialog"
      title={label === null ? t('dialog.title') : t('dialog.titleTo', { target: label })}
      banner={banner}
      footer={
        <>
          <Button size="dialog" onPress={onClose} isDisabled={adding}>
            {t('dialog.cancel')}
          </Button>
          <PendingButton
            variant="accent"
            autoFocus
            pending={adding ? t('dialog.adding') : null}
            isPending={checking || adding}
            isDisabled={blocked && !checking}
            onPress={() => void add()}
          >
            {primary}
          </PendingButton>
        </>
      }
    >
      <section className="import-dialog__what">
        <Items source={source} />
        {target !== null && (
          <p className="import-dialog__summary" aria-live="polite">
            {checking ? (
              <>
                <Spinner size="small" />
                {t('dialog.checking')}
              </>
            ) : checked === undefined ? null : (
              summaryOf(t, checked, i18n.language)
            )}
          </p>
        )}
        {checked !== undefined && checked.skipped > 0 && (
          <p className="import-dialog__left-out">{t('dialog.leftOut', { count: checked.skipped })}</p>
        )}
      </section>

      <div className="import-dialog__row">
        <span className="import-dialog__label" id={ids.addTo}>
          {t('dialog.addTo')}
        </span>
        <DialogTrigger isOpen={pickerOpen} onOpenChange={setPickerOpen}>
          <AriaButton
            className="select__button import-dialog__target"
            aria-labelledby={`${ids.addTo} ${ids.target}`}
            aria-haspopup="dialog"
          >
            <span id={ids.target} className="import-dialog__target-name">
              {course === undefined || target === null ? (
                <span className="import-dialog__target-empty">{label ?? t('dialog.chooseTarget')}</span>
              ) : (
                <>
                  <CourseBadge course={course} />
                  <CourseLabel course={course} />
                  {/* The folders below the course: "/ Problem sets". */}
                  {placeParts(target.path, courses)
                    .slice(1)
                    .map((name, index) => (
                      <span key={index} className="import-dialog__target-folder">{`/ ${name}`}</span>
                    ))}
                </>
              )}
            </span>
            <ChevronDown aria-hidden size={SIZE.iconSmall} className="select__chevron" />
          </AriaButton>
          <Popover placement="bottom start" className="import-dialog__picker">
            <AriaDialog aria-label={t('dialog.places')} className="import-dialog__picker-dialog">
              <Picker semester={semester} moving={[]} chosen={target} onChoose={chooseTarget} />
            </AriaDialog>
          </Popover>
        </DialogTrigger>
      </div>

      {allTags.length > 0 && (
        <div className="import-dialog__row">
          <span className="import-dialog__label" id={ids.tags}>
            {t('dialog.tags')}
          </span>
          <div className="import-dialog__tags">
            <div className="import-dialog__chips" role="group" aria-labelledby={ids.tags} aria-describedby={ids.tagsHelp}>
              {allTags.map((tag) => (
                <TagToggle
                  key={tag.id}
                  tag={tag}
                  isSelected={tags.has(tag.id)}
                  isDisabled={readOnly}
                  onChange={(selected) => {
                    const next = new Set(tags);
                    if (selected) next.add(tag.id);
                    else next.delete(tag.id);
                    setTags(next);
                  }}
                />
              ))}
            </div>
            <p className="import-dialog__help" id={ids.tagsHelp}>
              {readOnly ? t('dialog.tagsReadOnly') : t('dialog.tagsHelp')}
            </p>
          </div>
        </div>
      )}

      {checked !== undefined && checked.conflictCount > 0 && target !== null && (
        <Clashes check={checked} target={target} label={label ?? ''} policy={policy} onChange={setPolicy} />
      )}

      <div className="import-dialog__originals">
        <Checkbox isSelected={deleteOriginals} onChange={setDeleteOriginals}>
          {t('dialog.originals')}
        </Checkbox>
        <p className="import-dialog__help import-dialog__help--indented">{t('dialog.originalsHelp')}</p>
      </div>
    </DialogFrame>
  );
}

/**
 * The import dialog with the folder picker it is given, for the registry (UI architecture §6.2):
 * the picker belongs to the Library, and features never import each other. Each opening starts
 * afresh.
 */
export function importDialog(Picker: ComponentType<FolderPickerProps>): ComponentType<DialogComponentProps<'import'>> {
  function ImportDialogHost({ isOpen, params, onClose }: DialogComponentProps<'import'>) {
    return <ImportDialog key={params.source.token} isOpen={isOpen} params={params} onClose={onClose} Picker={Picker} />;
  }
  return ImportDialogHost;
}
