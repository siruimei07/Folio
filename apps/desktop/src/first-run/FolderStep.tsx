import { Folder } from 'lucide-react';
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button } from '../components/Button/Button';
import type { Tone } from '../components/feedback';
import { MiddleTruncate } from '../components/MiddleTruncate/MiddleTruncate';
import { IpcFailure } from '../data/errors';
import { useCreateLibrary } from '../data/library';
import type { FolderChoice, IpcError } from '../ipc';
import { SIZE } from '../tokens/tokens';
import { useAwaitStatus, useChooseFolder, useOpenChosen } from './choose';
import { isNameFailure, type StepAction, type StepFooter, useStepFailure } from './failures';
import { Field } from '../components/Field/Field';
import { Frame } from './Frame';
import { checkDisplayName, hasControl, lastName, type LibraryNameCode } from '../data/names';
import { endFlow, type FolderPage, showCourses } from '../app/startFlow';
import { focusAccent, Note, StepFooterRow, StepHeader } from './Step';

/** The page a folder gets (§4.2); `notALibrary`: "Open your library…" on a folder without one. */
type PageKind = FolderChoice['content']['kind'] | 'notALibrary';

function pageKindOf({ choice, intent }: FolderPage): PageKind {
  const { kind } = choice.content;
  if (intent === 'open' && kind !== 'library' && kind !== 'insideLibrary') return 'notALibrary';
  return kind;
}

/** What step 2 a new library gets (§5): a take-over has semester folders to read. */
function stepTwo(content: FolderChoice['content']) {
  const counted = content.kind === 'folders' || content.kind === 'incomplete';
  const takeOver = counted && content.folders > 0;
  return { takeOver, noFolders: counted && !takeOver && content.files > 0 };
}

/** "4 folders and 2 files at the top level". */
function useCounts() {
  const { t } = useTranslation('first-run');
  return (folders: number, files: number) =>
    t('folder.counts', {
      folders: folders === 0 ? t('folder.noFolders') : t('folder.folders', { count: folders }),
      files: files === 0 ? t('folder.noFiles') : t('folder.files', { count: files }),
    });
}

/** The folder card (§4.1): the path, what the folder holds, and "Change…". */
function FolderCard({ choice, onChange }: { choice: FolderChoice; onChange: () => void }) {
  const { t } = useTranslation('first-run');
  const counts = useCounts();
  const { content } = choice;
  let meta: string;
  switch (content.kind) {
    case 'empty':
      meta = t('folder.empty.meta');
      break;
    case 'folders':
      meta = counts(content.folders, content.files);
      break;
    case 'library':
      meta = t('folder.library.meta', { name: content.name });
      break;
    case 'insideLibrary':
      meta = t('folder.insideLibrary.meta');
      break;
    case 'incomplete':
      meta =
        content.folders === 0 && content.files === 0
          ? t('folder.incomplete.meta')
          : t('folder.incomplete.metaCounts', { counts: counts(content.folders, content.files) });
      break;
  }
  return (
    <div className="folder-card">
      <span className="folder-card__tile" aria-hidden>
        <Folder size={SIZE.iconRail} />
      </span>
      <div className="folder-card__words">
        <span className="folder-card__path">
          <MiddleTruncate text={choice.path} />
        </span>
        <span className="folder-card__meta">{meta}</span>
      </div>
      <Button onPress={onChange}>{t('step.change')}</Button>
    </div>
  );
}

/** How Folio reads a folder it takes over, with example names below the real one (§4.2). */
function FolderMap({ choice }: { choice: FolderChoice }) {
  const { t } = useTranslation('first-run');
  const captionId = useId();
  const rows = [
    { name: lastName(choice.path) || choice.path, role: t('folder.map.library'), detail: t('folder.map.libraryRole') },
    { name: t('folder.map.semesterName'), role: t('folder.map.semester'), detail: t('folder.map.semesterRole') },
    { name: t('folder.map.courseName'), role: t('folder.map.course'), detail: t('folder.map.courseRole') },
    { name: t('folder.map.folderName'), role: t('folder.map.folder'), detail: t('folder.map.folderRole') },
  ];
  return (
    <figure className="folder-map" aria-labelledby={captionId}>
      <figcaption id={captionId} className="folder-map__caption">{t('folder.map.label')}</figcaption>
      <ul className="folder-map__rows">
        {rows.map((row, depth) => (
          <li key={row.role} className="folder-map__row" style={{ '--depth': depth } as CSSProperties}>
            <span className="folder-map__name">
              <Folder aria-hidden size={SIZE.icon} className="folder-map__icon" />
              <span className="folder-map__label">{row.name}</span>
            </span>
            <span className="folder-map__role">
              <Trans
                t={t}
                i18nKey="folder.map.roleLine"
                values={{ role: row.role, detail: row.detail }}
                components={{ strong: <strong /> }}
              />
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** The banner a folder's page shows about its content (§4.2), in its tone. */
const CONTENT_BANNERS: Partial<Record<PageKind, Tone>> = { library: 'info', insideLibrary: 'danger', incomplete: 'info' };

/** Pages whose command creates the library: new, taken over or finished (§4.2). */
const CREATES: ReadonlySet<PageKind> = new Set(['empty', 'folders', 'incomplete']);

/**
 * Step 1 (first-run handoff §4): the chosen folder, what Folio will do with it, the library
 * name, and the command that creates, takes over, finishes or opens the library.
 */
export function FolderStep({ page }: { page: FolderPage }) {
  const { t } = useTranslation(['first-run', 'shell']);
  const { choice, intent } = page;
  const { content } = choice;
  const kind = pageKindOf(page);
  const command = CREATES.has(kind) ? 'create' : kind === 'library' ? 'open' : null;

  const [name, setName] = useState(() => lastName(choice.path));
  const [nameCode, setNameCode] = useState<LibraryNameCode | null>(null);
  const [error, setError] = useState<IpcError | null>(page.error);
  const nameInput = useRef<HTMLInputElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  const create = useCreateLibrary();
  const awaitStatus = useAwaitStatus();
  const { open, opening } = useOpenChosen();
  const { choose, busy: choosing } = useChooseFolder();
  const wordFailure = useStepFailure();
  const creating = create.isPending;
  const busy = creating || opening || choosing;

  // The name: control characters while typing; the other rules on blur and submit (§8).
  const shownCode = hasControl(name) ? 'NameInvalidCharacter' : nameCode;
  const failure = error === null || isNameFailure(error) ? null : wordFailure(error, choice.path);

  // Initial focus (§9): the name with its text selected, else the step's main button. A failure
  // moves focus to the banner's main button (§4.4), a name failure to the name.
  useEffect(() => {
    const input = nameInput.current;
    if (input === null || (error !== null && !isNameFailure(error))) {
      focusAccent(footerRef);
      return;
    }
    input.focus();
    if (error === null) input.select();
  }, [error]);

  const runCreate = async () => {
    const code = checkDisplayName(name);
    if (code !== null) {
      setNameCode(code);
      nameInput.current?.focus();
      return;
    }
    setError(null);
    try {
      const opened = await create.mutateAsync({
        folder: choice.token,
        name,
        presetTags: {
          notes: t('presetTags.notes'),
          slides: t('presetTags.slides'),
          homework: t('presetTags.homework'),
          exam: t('presetTags.exam'),
          reference: t('presetTags.reference'),
        },
      });
      // Step 2 reads the new library, so the status has it open before step 2 shows.
      await awaitStatus(opened.library.id);
      showCourses({ libraryId: opened.library.id, scan: opened.scan, ...stepTwo(content) });
    } catch (failed: unknown) {
      if (!(failed instanceof IpcFailure)) throw failed;
      if (isNameFailure(failed.error)) setNameCode(failed.error.code);
      setError(failed.error);
    }
  };

  const runOpen = async () => {
    setError(null);
    const failed = await open(choice);
    if (failed !== null) setError(failed);
  };

  const run = () => {
    if (busy) return;
    if (command === 'create') void runCreate();
    else if (command === 'open') void runOpen();
  };

  const act = (action: StepAction) => () => {
    if (busy && action !== 'copyDetails') return;
    switch (action) {
      case 'back':
        endFlow();
        break;
      case 'chooseAnother':
      case 'chooseFolder':
        void choose(intent);
        break;
      case 'copyDetails':
        if (error !== null && failure !== null) copyErrorDetails(failure.title, error);
        break;
      case 'tryAgain':
      case 'useAnyway':
      case 'submit':
        run();
        break;
    }
  };

  // The footer (§4.2, §4.4): a failure's buttons, a cloud folder's, or the step's own.
  let footer: StepFooter;
  if (failure !== null) footer = failure.footer;
  else if (command !== null && choice.syncRoot !== null) footer = { start: ['back'], end: ['useAnyway', 'chooseAnother'] };
  else if (command === 'open') footer = { start: ['chooseAnother'], end: ['submit'] };
  else if (command === 'create') footer = { start: ['back'], end: ['submit'] };
  else footer = { start: ['back'], end: ['chooseAnother'] };

  const labels: Record<StepAction, string> = {
    back: t('step.back'),
    tryAgain: t('step.tryAgain'),
    chooseAnother: t('step.chooseAnother'),
    chooseFolder: t('step.chooseFolder'),
    copyDetails: t('shell:copyDetails.action'),
    useAnyway: t('step.useAnyway'),
    submit: kind === 'notALibrary' || kind === 'insideLibrary' ? '' : t(`folder.${kind}.submit`),
  };
  const title = t(`folder.${kind}.title`);
  const intro = kind === 'empty' || kind === 'folders' ? t(`folder.${kind}.intro`) : undefined;
  const contentTone = CONTENT_BANNERS[kind];
  const root = content.kind === 'insideLibrary' ? content.root : '';

  const mismatch =
    intent === 'new' && content.kind === 'folders'
      ? t('folder.notEmpty')
      : intent === 'existing' && content.kind === 'empty'
        ? t('folder.isEmpty')
        : null;
  const counted = content.kind === 'folders' || content.kind === 'incomplete' ? content : null;
  const showMap = counted !== null && counted.folders + counted.files > 0 && (kind === 'folders' || kind === 'incomplete');

  return (
    <Frame windowTitle={t('documentTitle.page', { page: title })} layout="step" busy={busy}>
      <div className="step" data-tall={showMap || undefined}>
        <StepHeader step={t('step.one')} title={title} intro={intro} />
        {mismatch !== null && <p className="step__mismatch">{mismatch}</p>}
        <FolderCard
          choice={choice}
          onChange={() => {
            if (!busy) void choose(intent);
          }}
        />
        {choice.syncRoot !== null && command !== null && (
          <Banner size="block" tone="warning" title={t(`folder.sync.${choice.syncRoot}`)} text={t('folder.sync.text')} />
        )}
        {contentTone !== undefined && (kind === 'library' || kind === 'insideLibrary' || kind === 'incomplete') && (
          <Banner
            size="block"
            tone={contentTone}
            title={t(`folder.${kind}.bannerTitle`)}
            text={t(`folder.${kind}.bannerText`, { root })}
          />
        )}
        {kind === 'notALibrary' && (
          <Banner size="block" tone="danger" announce title={t('errors.notALibrary.title')} text={t('errors.notALibrary.text')} />
        )}
        {showMap && <FolderMap choice={choice} />}
        {showMap && counted.files > 0 && <p className="step__note-line">{t('folder.topFiles', { count: counted.files })}</p>}
        {command === 'create' && (
          <Field
            label={t('name.label')}
            value={name}
            onChange={(value) => {
              setName(value);
              setNameCode(null);
            }}
            error={shownCode === null ? null : t(`name.errors.${shownCode}`)}
            help={t('name.help')}
            readOnly={busy}
            inputRef={nameInput}
            onBlur={() => {
              setNameCode(checkDisplayName(name));
            }}
            onEnter={() => {
              const main = footer.end.at(-1);
              if (main !== undefined) act(main)();
            }}
          />
        )}
        {command === 'create' && (kind === 'empty' || kind === 'folders') && <Note>{t(`folder.${kind}.note`)}</Note>}
        {failure !== null && <Banner size="block" tone={failure.tone} announce title={failure.title} text={failure.text} />}
        <StepFooterRow
          footer={footer}
          labels={labels}
          footerRef={footerRef}
          onAction={act}
          running={creating ? t('folder.creating') : opening ? t('folder.opening') : null}
        />
      </div>
    </Frame>
  );
}
