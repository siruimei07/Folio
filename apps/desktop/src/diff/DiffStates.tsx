// The diff pane's states that are not lines (handoff §6.8): loading, a failed load, and the blocks
// for content that cannot be compared line by line. Each says what happened and what the person
// can do; "Open with default app" shows only when there is a file to open.
import type { TFunction } from 'i18next';
import {
  ArchiveX,
  Binary,
  CircleX,
  CloudOff,
  ExternalLink,
  FileText,
  FileX,
  Folder,
  FolderOpen,
  Info,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { DETAILED } from '../app/feedback';
import { copyErrorDetails } from '../app/windowErrors';
import { Banner } from '../components/Banner/Banner';
import { Button, type ButtonSize } from '../components/Button/Button';
import { skeletonWidth, useLoadingDelay } from '../components/Skeleton/Skeleton';
import { StateBlock, type StateBlockProps } from '../components/StateBlock/StateBlock';
import type { IpcError } from '../ipc';
import type { DiffBody } from './model/describe';
import { useRetryAnnouncement } from './useRetry';

/** Skeleton lines while a diff loads (§6.8: "14 skeleton lines"). */
const SKELETON_LINES = 14;

/**
 * A skeleton line's two line-number stubs and text bar, the shared skeleton's bars: in the loading
 * skeleton, and for a row whose window has not answered yet (`PendingLine`).
 */
export function SkeletonLineParts({ index }: { index: number }) {
  return (
    <>
      <span className="diff-skeleton__number">
        <span className="skeleton__bar diff-skeleton__stub" />
      </span>
      <span className="diff-skeleton__number">
        <span className="skeleton__bar diff-skeleton__stub" />
      </span>
      <span className="skeleton__bar diff-skeleton__bar" style={{ width: skeletonWidth(index) }} />
    </>
  );
}

/**
 * 14 skeleton lines, two line-number stubs and a bar each, after 150 ms (UI architecture §13).
 * Remount it (a `key`) for another diff, so the wait starts again.
 */
export function DiffLoading() {
  const { t } = useTranslation('common');
  const visible = useLoadingDelay();
  if (!visible) return null;
  return (
    <div className="diff-skeleton" role="status" aria-label={t('loading')}>
      {Array.from({ length: SKELETON_LINES }, (_, index) => (
        <span key={index} className="diff-skeleton__line" aria-hidden>
          <SkeletonLineParts index={index} />
        </span>
      ))}
    </div>
  );
}

/** A state block centred in the body; failures sit on the sunken surface. */
function Block({ surface = 'panel', ...props }: StateBlockProps & { surface?: 'panel' | 'sunken' }) {
  return (
    <div className="diff-state" data-surface={surface}>
      <StateBlock placement="preview" {...props} />
    </div>
  );
}

/** What the state blocks can offer. */
export interface StateActions {
  /** Opens the file in its own app; `null` when there is no file to open. */
  onOpen: (() => void) | null;
  /** Reads the diff again. */
  onRetry: () => void;
  /** Retries that failed again (`useRetry`): the unreadable file's block reads its title again. */
  failedAgain: number;
  /** A refresh banner shows above: it reads a retry that failed again, the newer news, not the block. */
  refreshFailed: boolean;
  /** Shows "This version" (§6.7): the too-big and formatting blocks' button; absent while it is not offered. */
  onShowVersion?: () => void;
  /** "This version" can be shown, so the too-big text may point at it. */
  versionOffered: boolean;
}

/** "Open with default app" and "Show this version" as the blocks offer them. */
function useButtons(actions: Pick<StateActions, 'onOpen' | 'onShowVersion'>) {
  const { t } = useTranslation('diff');
  const { onOpen, onShowVersion } = actions;
  const open =
    onOpen === null ? null : (
      <Button key="open" icon={ExternalLink} onPress={onOpen}>
        {t('actions.open')}
      </Button>
    );
  const version =
    onShowVersion === undefined ? null : (
      <Button key="version" onPress={onShowVersion}>
        {t('actions.showVersion')}
      </Button>
    );
  return { open, version };
}

/** The buttons that apply, or nothing, so a block without buttons has no button row. */
function row(...buttons: (ReactElement | null)[]): ReactNode {
  const shown = buttons.filter((button) => button !== null);
  return shown.length === 0 ? undefined : <>{shown}</>;
}

/**
 * "Copy details" for a code that points at a bug (`DETAILED`), whose message asks for the details
 * (library-actions §9.6); nothing for the others.
 */
function CopyDetails({ title, error, size }: { title: string; error: IpcError; size?: ButtonSize }) {
  const { t } = useTranslation('shell');
  if (!DETAILED.has(error.code)) return null;
  return (
    <Button
      size={size}
      onPress={() => {
        copyErrorDetails(title, error);
      }}
    >
      {t('copyDetails.action')}
    </Button>
  );
}

/**
 * "Couldn't show what changed" (or `title`) with the error's message, "Try again", "Open with
 * default app" and "Copy details" when they apply: a failed read, or a file on the disk that could
 * not be read. Its title is read when it appears, and again each time `failedAgain` grows: a "Try
 * again" that failed again while it stayed, which changes nothing on screen (`useRetry`). With
 * `quiet`, a refresh banner above reads that instead.
 */
export function DiffFailed({
  error,
  onRetry,
  onOpen,
  failedAgain = 0,
  quiet = false,
  title: own,
}: { error: IpcError; failedAgain?: number; quiet?: boolean; title?: string } & Pick<StateActions, 'onRetry' | 'onOpen'>) {
  const { t } = useTranslation(['diff', 'errors']);
  const { open } = useButtons({ onOpen });
  const title = own ?? t('failed.title');
  useRetryAnnouncement(title, failedAgain, { onAppear: true, quiet });
  return (
    <Block
      surface="sunken"
      tone="danger"
      icon={CircleX}
      title={title}
      text={t(`errors:${error.code}`)}
      actions={row(
        <Button key="retry" icon={RefreshCw} onPress={onRetry}>
          {t('actions.tryAgain')}
        </Button>,
        open,
        <CopyDetails key="copy" title={title} error={error} />,
      )}
    />
  );
}

/**
 * "Couldn't update what changed." with the error's message, "Try again" and "Copy details" when it
 * applies, above a diff whose refresh failed while its last answer still shows (the Problems list's
 * "Couldn't update the list" pattern). An alert: it appears while the person reads. Its title is
 * read again each time `failedAgain` grows (a "Try again" that failed again, `useRetry`): the alert
 * stays as it was.
 */
export function DiffRefreshFailed({ error, onRetry, failedAgain }: { error: IpcError; onRetry: () => void; failedAgain: number }) {
  const { t } = useTranslation(['diff', 'errors']);
  const title = t('failed.refreshTitle');
  useRetryAnnouncement(title, failedAgain);
  return (
    <div className="diff-refresh-failed">
      <Banner
        tone="danger"
        announce
        title={title}
        text={t(`errors:${error.code}`)}
        actions={
          <>
            <Button size="compact" icon={RefreshCw} onPress={onRetry}>
              {t('actions.tryAgain')}
            </Button>
            <CopyDetails title={title} error={error} size="compact" />
          </>
        }
      />
    </div>
  );
}

const STATE_KINDS = [
  'unreadable',
  'deleted',
  'notLocal',
  'binary',
  'tooLarge',
  'pruned',
  'overLimit',
  'noTextChange',
  'folder',
  'gone',
] as const satisfies readonly DiffBody['kind'][];

/** The bodies `DiffState` shows: content that is not lines, a list or a preview. */
export type StateBody = Extract<DiffBody, { kind: (typeof STATE_KINDS)[number] }>;

const STATE_BODIES: ReadonlySet<DiffBody['kind']> = new Set(STATE_KINDS);

export function isStateBody(body: DiffBody): body is StateBody {
  return STATE_BODIES.has(body.kind);
}

/** "No text changed", "Only the line endings changed", "Only the encoding changed". */
function noTextChange(body: Extract<DiffBody, { kind: 'noTextChange' }>, t: TFunction<'diff'>): { title: string; text: string } {
  const { lineEndings, encoding } = body;
  if (body.reason === 'lineEndings' && lineEndings !== null) {
    const before = t(`lineEnding.${lineEndings.before}`);
    const after = t(`lineEnding.${lineEndings.after}`);
    let text = t('state.lineEndings.text', { before, after });
    if (lineEndings.after === 'mixed') text = t('state.lineEndings.toMixed', { before });
    else if (lineEndings.before === 'mixed') text = t('state.lineEndings.fromMixed', { after });
    return { title: t('state.lineEndings.title'), text };
  }
  if (body.reason === 'encoding' && encoding !== null) {
    return {
      title: t('state.encoding.title'),
      text: t('state.encoding.text', { before: t(`encodingName.${encoding.before}`), after: t(`encodingName.${encoding.after}`) }),
    };
  }
  return { title: t('state.formatting.title'), text: t('state.formatting.text') };
}

/** "It changes 24,382 lines. Open the file …, or look at this version." */
function tooLargeText(body: Extract<DiffBody, { kind: 'tooLarge' }>, versionOffered: boolean, t: TFunction<'diff'>): string {
  if (body.lines === null) return t(versionOffered ? 'state.tooLarge.unknown' : 'state.tooLarge.unknownNoVersion');
  const unit = body.word ? 'paragraphs' : 'lines';
  return t(`state.tooLarge.${unit}${versionOffered ? '' : 'NoVersion'}`, { count: body.lines });
}

/** A folder item (Sirui's option A): what moved with it, an empty folder, or nothing to compare. */
function FolderState({ body }: { body: Extract<DiffBody, { kind: 'folder' }> }) {
  const { t } = useTranslation('diff');
  if (body.change === 'moved' && body.files === null) {
    // History does not count a folder's files: "Their content didn't change".
    return <Block icon={FolderOpen} title={t('state.folder.movedFiles')} text={t('state.folder.movedText', { count: 2 })} />;
  }
  if (body.change === 'moved' && body.files !== null && body.files > 0) {
    return (
      <Block
        icon={FolderOpen}
        title={t('state.folder.moved', { count: body.files })}
        text={t('state.folder.movedText', { count: body.files })}
      />
    );
  }
  if (body.change === 'added' || body.change === 'moved') return <Block icon={Folder} title={t('state.folder.empty')} />;
  // A folder deleted in History, or any other folder change.
  return <Block icon={Folder} title={t('state.folder.other')} text={t('state.folder.otherText')} />;
}

/** The block for content that is not lines (§6.8). */
export function DiffState({ body, actions }: { body: StateBody; actions: StateActions }) {
  const { t } = useTranslation('diff');
  const { open, version } = useButtons(actions);
  switch (body.kind) {
    case 'unreadable':
      return (
        <DiffFailed
          error={body.error}
          onRetry={actions.onRetry}
          onOpen={actions.onOpen}
          failedAgain={actions.failedAgain}
          quiet={actions.refreshFailed}
        />
      );
    case 'deleted': {
      const title =
        body.folder && body.files > 0
          ? t('state.deleted.folder', { name: body.name, count: body.files })
          : t('state.deleted.file', { name: body.name });
      return <Block icon={Trash2} title={title} text={t('state.deleted.text')} />;
    }
    case 'notLocal':
      return <Block icon={CloudOff} title={t('state.notLocal.title')} text={t('state.notLocal.text')} actions={row(open)} />;
    case 'binary':
      return <Block tone="info" icon={Binary} title={t('state.binary.title')} text={t('state.binary.text')} />;
    case 'tooLarge':
      return (
        <Block
          icon={FileText}
          title={t('state.tooLarge.title')}
          text={tooLargeText(body, actions.versionOffered, t)}
          actions={row(open, version)}
        />
      );
    case 'pruned':
      return <Block icon={ArchiveX} title={t('state.pruned.title')} text={t('state.pruned.text')} />;
    case 'overLimit':
      return <Block icon={FileText} title={t('state.overLimit.title')} text={t('state.overLimit.text')} actions={row(open)} />;
    case 'noTextChange':
      // Only formatting (Word) points at this version (§6.8); the other two say the text is the same.
      return <Block tone="info" icon={Info} {...noTextChange(body, t)} actions={body.reason === 'formatting' ? row(version) : undefined} />;
    case 'folder':
      return <FolderState body={body} />;
    case 'gone':
      return <Block icon={FileX} title={t('state.gone.title')} text={t('state.gone.text')} />;
  }
}

/**
 * In place of the preview of a file whose versions Folio does not keep, in History, when the file
 * the version belongs to has been deleted since (§6.8 "History: event-only file").
 */
export function DiffDeletedSince() {
  const { t } = useTranslation('diff');
  return <Block icon={FileX} title={t('state.deletedSince.title')} text={t('state.deletedSince.text')} />;
}
