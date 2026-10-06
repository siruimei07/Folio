import { ExternalLink, FileX, RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewFileActions } from '../app/panes';
import { Button } from '../components/Button/Button';
import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { StateBlock } from '../components/StateBlock/StateBlock';
import type { EntryRef } from '../ipc';
import { mediaFailure, type ReadFailure, useContent } from './content';
import { previewKindOf } from './kinds';
import { LinkPopover } from './LinkPopover';
import { useNoteImages } from './noteImages';
import { PdfPill } from './PdfPill';
import { type FrameHandle, type FrameLink, type PdfState, PreviewFrame } from './PreviewFrame';
import { type FailureReason, type Renderer, SIZE_LIMITS, type WindowMessage } from './protocol';

/**
 * The file a preview body shows: a file in the library, or a version stored in history, whose
 * bytes come from the `folio-file` version route (ipc-m2 §11).
 */
export interface FileSource {
  kind: 'entry' | 'version';
  /** The file's name: its extension picks how it shows. */
  name: string;
  /** Bytes, in decimal, for the size limits. */
  size: string;
  /** Its bytes on the `folio-file` scheme: `contentUrl` of a file, `versionUrl` of a version. */
  url: string;
  /**
   * The library's file: what "Open with default app" opens, and where a note's images are looked
   * up. A version's is the file it belongs to now (`locate_version`); `null` when there is none,
   * so nothing offers Open and a note's images show as missing.
   */
  entry: EntryRef | null;
  /** Windows' thumbnail of a HEIC or TIFF image (`thumbnailUrl`): only a file in the library has one. */
  thumbnail: string | null;
}

/** Codes whose own message says better than the generic one why a file could not be read (§9.2). */
const OWN_MESSAGE: ReadonlySet<ReadFailure> = new Set(['InUse', 'NotLocal', 'AccessDenied', 'NoThumbnail']);

/** The version route's own codes (ipc-m2 §11), which say why a version could not be read. */
const VERSION_MESSAGE: ReadonlySet<ReadFailure> = new Set(['NotFound', 'Pruned', 'HistoryDamaged']);

interface FileProps {
  file: FileSource;
  actions: PreviewFileActions;
}

/** "Open with default app": nothing when there is no library file to open. */
function OpenButton({ file, actions }: FileProps) {
  const { t } = useTranslation('preview');
  const { entry } = file;
  if (entry === null) return null;
  return (
    <Button
      icon={ExternalLink}
      onPress={() => {
        actions.open(entry);
      }}
    >
      {t('header.open')}
    </Button>
  );
}

/**
 * "Can't show this file" (library-actions §9.2): why, "Try again" and "Open with default app".
 * A version says why with the version route's codes, else in its own words: the reasons a file on
 * the disk fails do not apply to it.
 */
function ReadFailureState({ file, actions, code, retry }: FileProps & { code: ReadFailure | null; retry: () => void }) {
  const { t } = useTranslation(['preview', 'errors']);
  const version = file.kind === 'version';
  let text: string;
  if (code !== null && (OWN_MESSAGE.has(code) || (version && VERSION_MESSAGE.has(code)))) text = t(`errors:${code}`);
  else text = version ? t('failed.versionText') : t('failed.text');
  return (
    <div className="preview-state">
      <StateBlock
        tone="danger"
        icon={FileX}
        placement="preview"
        title={version ? t('failed.versionTitle') : t('failed.title')}
        text={text}
        actions={
          <>
            <Button icon={RefreshCw} onPress={retry}>
              {t('failed.tryAgain')}
            </Button>
            <OpenButton file={file} actions={actions} />
          </>
        }
      />
    </div>
  );
}

type CardNote = 'other' | 'office' | 'tooLarge' | 'unsupported' | 'media' | 'thumbnail' | 'noThumbnail';

interface CardProps extends FileProps {
  /** Why the file shows as a card. */
  note?: CardNote;
  /** In place of the type icon, such as a reduced picture. */
  picture?: ReactNode;
  /** Under the name, such as an audio player. */
  children?: ReactNode;
}

/**
 * A file on the sunken surface (app-shell §5): its icon, name, why, and "Open with default app".
 * A version's note does not ask to open it, since Open opens the file as it is now; a version has
 * no thumbnail, so it never shows that note.
 */
function Card({ file, actions, note, picture, children }: CardProps) {
  const { t } = useTranslation('preview');
  let noteText: string | null = null;
  if (note !== undefined) noteText = file.kind === 'version' && note !== 'thumbnail' ? t(`versionCard.${note}`) : t(`card.${note}`);
  return (
    <div className="preview-state">
      <div className="preview-card">
        {picture ?? <FileTypeIcon name={file.name} size="card" />}
        {picture === undefined && <p className="preview-card__name">{file.name}</p>}
        {noteText !== null && <p className="preview-card__note">{noteText}</p>}
        {children ?? <OpenButton file={file} actions={actions} />}
      </div>
    </div>
  );
}

/**
 * Why a media element failed, asked after its `error` event: a code from the scheme, `decode`
 * when the file reads but Chromium cannot show it, `null` while it plays.
 */
function useMediaFailure(url: string) {
  const [failure, setFailure] = useState<ReadFailure | 'decode' | null>(null);
  const onError = () => {
    void mediaFailure(url).then((code) => {
      setFailure(code ?? 'decode');
    });
  };
  return { failure, onError };
}

interface MediaProps extends FileProps {
  retry: () => void;
}

/** An image in the window, by URL: an SVG in `<img>` runs no script (§10.1). */
function ImagePreview({ file, actions, retry }: MediaProps) {
  const { failure, onError } = useMediaFailure(file.url);
  if (failure === 'decode') return <Card file={file} actions={actions} note="unsupported" />;
  if (failure !== null) return <ReadFailureState file={file} actions={actions} code={failure} retry={retry} />;
  return (
    <div className="preview-backdrop">
      <img className="preview-image" src={file.url} alt={file.name} onError={onError} />
    </div>
  );
}

/**
 * HEIC and TIFF: Chromium cannot decode them, so the preview is the thumbnail Windows makes (WIC)
 * when it can, else the card. A version has no thumbnail.
 */
function ThumbnailPreview({ file, actions }: FileProps) {
  const [failed, setFailed] = useState(false);
  if (failed || file.thumbnail === null) return <Card file={file} actions={actions} note="noThumbnail" />;
  return (
    <Card
      file={file}
      actions={actions}
      note="thumbnail"
      picture={
        <img
          className="preview-card__thumbnail"
          src={file.thumbnail}
          alt={file.name}
          onError={() => {
            setFailed(true);
          }}
        />
      }
    />
  );
}

/** Audio and video play in the window; the scheme answers `Range`, so long files seek (§10.1). */
function MediaPreview({ file, actions, retry, video }: MediaProps & { video: boolean }) {
  const { failure, onError } = useMediaFailure(file.url);
  if (failure === 'decode') return <Card file={file} actions={actions} note="media" />;
  if (failure !== null) return <ReadFailureState file={file} actions={actions} code={failure} retry={retry} />;
  if (video) {
    return (
      <div className="preview-backdrop">
        <video className="preview-video" src={file.url} controls preload="metadata" aria-label={file.name} onError={onError} />
      </div>
    );
  }
  return (
    <Card file={file} actions={actions}>
      <audio className="preview-audio" src={file.url} controls preload="metadata" aria-label={file.name} onError={onError} />
    </Card>
  );
}

interface FramePreviewProps extends FileProps {
  renderer: Renderer;
  language: string | null;
  retry: () => void;
  /** Esc in the frame, or the link popover closing: focus goes to the host's heading. */
  onEscape: () => void;
}

interface FrameHostProps extends FramePreviewProps {
  onFailed: (reason: FailureReason | 'timeout') => void;
}

/**
 * The frame and what the window draws over it. The frame starts while the bytes load, and both
 * meet in `PreviewFrame`. It unmounts when the frame fails, which lets go of the bytes.
 */
function FrameHost({ file, actions, renderer, language, retry, onEscape, onFailed }: FrameHostProps) {
  const { t } = useTranslation('preview');
  const content = useContent(file.url);
  const [rendered, setRendered] = useState(false);
  const [pdf, setPdf] = useState<PdfState | null>(null);
  const [link, setLink] = useState<FrameLink | null>(null);
  const frame = useRef<FrameHandle>(null);
  const post = useCallback((message: WindowMessage, transfer?: Transferable[]) => {
    frame.current?.post(message, transfer);
  }, []);
  const onImages = useNoteImages(file.entry, post);
  const strings = useMemo(
    () => ({
      title: t('label', { name: file.name }),
      imageLoading: t('frame.imageLoading'),
      imageMissing: t('frame.imageMissing'),
      imageRemote: t('frame.imageRemote'),
      code: t('frame.code', { name: file.name }),
    }),
    [t, file.name],
  );

  if (content.state === 'failed') return <ReadFailureState file={file} actions={actions} code={content.code} retry={retry} />;
  return (
    <div className="preview-frame-host" data-renderer={renderer} aria-busy={!rendered}>
      <PreviewFrame
        ref={frame}
        renderer={renderer}
        language={language}
        bytes={content.state === 'ready' ? content.bytes : null}
        strings={strings}
        onRendered={() => {
          setRendered(true);
        }}
        onFailed={onFailed}
        onPdfState={setPdf}
        onImages={onImages}
        onLink={setLink}
        onEscape={onEscape}
      />
      {/* Over the frame, not instead of it: a hidden frame would not render its first page. */}
      {!rendered && (
        <div className="preview-loading">
          <Skeleton rows={8} />
        </div>
      )}
      {pdf !== null && pdf.pages > 0 && (
        <PdfPill
          state={pdf}
          command={(command) => {
            post({ kind: 'pdf', ...command });
          }}
        />
      )}
      <LinkPopover
        link={link}
        onClose={() => {
          setLink(null);
          // Focus goes to the header, as from Esc: focusing the frame element from the window
          // leaves the frame's own document without focus (it runs in another process), and
          // keys and clicks in it go nowhere until it is focused again.
          onEscape();
        }}
      />
    </div>
  );
}

/** Everything parsed from file content: fetched here, rendered in the sandboxed frame (§10.1). */
function FramePreview(props: FramePreviewProps) {
  const { file, actions, retry } = props;
  const [failure, setFailure] = useState<FailureReason | 'timeout' | null>(null);
  if (failure === 'tooLarge') return <Card file={file} actions={actions} note="tooLarge" />;
  if (failure === 'unsupported' || failure === 'corrupt') return <Card file={file} actions={actions} note="unsupported" />;
  if (failure !== null) return <ReadFailureState file={file} actions={actions} code={null} retry={retry} />;
  return <FrameHost {...props} onFailed={setFailure} />;
}

export interface PreviewBodyProps extends FileProps {
  /** Shows the file again from the start: the host remounts the body. */
  retry: () => void;
  onEscape: () => void;
}

/** The preview's body by the file's type (UI architecture §10.1). */
export function PreviewBody({ file, actions, retry, onEscape }: PreviewBodyProps) {
  const kind = previewKindOf(file.name);
  switch (kind.kind) {
    case 'image':
      return <ImagePreview file={file} actions={actions} retry={retry} />;
    case 'thumbnail':
      return <ThumbnailPreview file={file} actions={actions} />;
    case 'audio':
    case 'video':
      return <MediaPreview file={file} actions={actions} retry={retry} video={kind.kind === 'video'} />;
    case 'frame':
      if (Number(file.size) > SIZE_LIMITS[kind.renderer]) return <Card file={file} actions={actions} note="tooLarge" />;
      return (
        <FramePreview
          file={file}
          actions={actions}
          renderer={kind.renderer}
          language={kind.language}
          retry={retry}
          onEscape={onEscape}
        />
      );
    case 'office':
      return <Card file={file} actions={actions} note="office" />;
    case 'other':
      return <Card file={file} actions={actions} note="other" />;
  }
}
