import { ExternalLink, FileX, RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewActions } from '../app/panes';
import { Button } from '../components/Button/Button';
import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { contentUrl, type EntryRow, thumbnailUrl } from '../ipc';
import { mediaFailure, type ReadFailure, useContent } from './content';
import { previewKindOf } from './kinds';
import { LinkPopover } from './LinkPopover';
import { useNoteImages } from './noteImages';
import { PdfPill } from './PdfPill';
import { type FrameHandle, type FrameLink, type PdfState, PreviewFrame } from './PreviewFrame';
import { type FailureReason, type Renderer, SIZE_LIMITS, type WindowMessage } from './protocol';

/** Codes whose own message says better than the generic one why a file could not be read (§9.2). */
const OWN_MESSAGE: ReadonlySet<ReadFailure> = new Set(['InUse', 'NotLocal', 'AccessDenied', 'NoThumbnail']);

interface FileProps {
  row: EntryRow;
  actions: PreviewActions;
}

function OpenButton({ row, actions }: FileProps) {
  const { t } = useTranslation('preview');
  return (
    <Button
      icon={ExternalLink}
      onPress={() => {
        actions.open(row);
      }}
    >
      {t('header.open')}
    </Button>
  );
}

/** "Can't show this file" (library-actions §9.2): why, "Try again" and "Open with default app". */
function ReadFailureState({ row, actions, code, retry }: FileProps & { code: ReadFailure | null; retry: () => void }) {
  const { t } = useTranslation(['preview', 'errors']);
  return (
    <div className="preview-state">
      <StateBlock
        tone="danger"
        icon={FileX}
        placement="preview"
        title={t('failed.title')}
        text={code !== null && OWN_MESSAGE.has(code) ? t(`errors:${code}`) : t('failed.text')}
        actions={
          <>
            <Button icon={RefreshCw} onPress={retry}>
              {t('failed.tryAgain')}
            </Button>
            <OpenButton row={row} actions={actions} />
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

/** A file on the sunken surface (app-shell §5): its icon, name, why, and "Open with default app". */
function Card({ row, actions, note, picture, children }: CardProps) {
  const { t } = useTranslation('preview');
  return (
    <div className="preview-state">
      <div className="preview-card">
        {picture ?? <FileTypeIcon name={row.name} size="card" />}
        {picture === undefined && <p className="preview-card__name">{row.name}</p>}
        {note !== undefined && <p className="preview-card__note">{t(`card.${note}`)}</p>}
        {children ?? <OpenButton row={row} actions={actions} />}
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
function ImagePreview({ row, actions, retry }: MediaProps) {
  const url = contentUrl(row);
  const { failure, onError } = useMediaFailure(url);
  if (failure === 'decode') return <Card row={row} actions={actions} note="unsupported" />;
  if (failure !== null) return <ReadFailureState row={row} actions={actions} code={failure} retry={retry} />;
  return (
    <div className="preview-backdrop">
      <img className="preview-image" src={url} alt={row.name} onError={onError} />
    </div>
  );
}

/**
 * HEIC and TIFF: Chromium cannot decode them, so the preview is the thumbnail Windows makes (WIC)
 * when it can, else the card.
 */
function ThumbnailPreview({ row, actions }: FileProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Card row={row} actions={actions} note="noThumbnail" />;
  return (
    <Card
      row={row}
      actions={actions}
      note="thumbnail"
      picture={
        <img
          className="preview-card__thumbnail"
          src={thumbnailUrl(row, 256)}
          alt={row.name}
          onError={() => {
            setFailed(true);
          }}
        />
      }
    />
  );
}

/** Audio and video play in the window; the scheme answers `Range`, so long files seek (§10.1). */
function MediaPreview({ row, actions, retry, video }: MediaProps & { video: boolean }) {
  const url = contentUrl(row);
  const { failure, onError } = useMediaFailure(url);
  if (failure === 'decode') return <Card row={row} actions={actions} note="media" />;
  if (failure !== null) return <ReadFailureState row={row} actions={actions} code={failure} retry={retry} />;
  if (video) {
    return (
      <div className="preview-backdrop">
        <video className="preview-video" src={url} controls preload="metadata" aria-label={row.name} onError={onError} />
      </div>
    );
  }
  return (
    <Card row={row} actions={actions}>
      <audio className="preview-audio" src={url} controls preload="metadata" aria-label={row.name} onError={onError} />
    </Card>
  );
}

interface FramePreviewProps extends FileProps {
  renderer: Renderer;
  language: string | null;
  retry: () => void;
  /** Esc in the frame, or the link popover closing: focus goes to the preview header. */
  onEscape: () => void;
}

interface FrameHostProps extends FramePreviewProps {
  onFailed: (reason: FailureReason | 'timeout') => void;
}

/**
 * The frame and what the window draws over it. The frame starts while the bytes load, and both
 * meet in `PreviewFrame`. It unmounts when the frame fails, which lets go of the bytes.
 */
function FrameHost({ row, actions, renderer, language, retry, onEscape, onFailed }: FrameHostProps) {
  const { t } = useTranslation('preview');
  const content = useContent(contentUrl(row));
  const [rendered, setRendered] = useState(false);
  const [pdf, setPdf] = useState<PdfState | null>(null);
  const [link, setLink] = useState<FrameLink | null>(null);
  const frame = useRef<FrameHandle>(null);
  const post = useCallback((message: WindowMessage, transfer?: Transferable[]) => {
    frame.current?.post(message, transfer);
  }, []);
  const onImages = useNoteImages(row, post);
  const strings = useMemo(
    () => ({
      title: t('label', { name: row.name }),
      imageLoading: t('frame.imageLoading'),
      imageMissing: t('frame.imageMissing'),
      imageRemote: t('frame.imageRemote'),
      code: t('frame.code', { name: row.name }),
    }),
    [t, row.name],
  );

  if (content.state === 'failed') return <ReadFailureState row={row} actions={actions} code={content.code} retry={retry} />;
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
  const { row, actions, retry } = props;
  const [failure, setFailure] = useState<FailureReason | 'timeout' | null>(null);
  if (failure === 'tooLarge') return <Card row={row} actions={actions} note="tooLarge" />;
  if (failure === 'unsupported' || failure === 'corrupt') return <Card row={row} actions={actions} note="unsupported" />;
  if (failure !== null) return <ReadFailureState row={row} actions={actions} code={null} retry={retry} />;
  return <FrameHost {...props} onFailed={setFailure} />;
}

export interface PreviewBodyProps extends FileProps {
  /** Shows the file again from the start: the pane remounts the body. */
  retry: () => void;
  onEscape: () => void;
}

/** The preview's body by the file's type (UI architecture §10.1). */
export function PreviewBody({ row, actions, retry, onEscape }: PreviewBodyProps) {
  const kind = previewKindOf(row.name);
  switch (kind.kind) {
    case 'image':
      return <ImagePreview row={row} actions={actions} retry={retry} />;
    case 'thumbnail':
      return <ThumbnailPreview row={row} actions={actions} />;
    case 'audio':
    case 'video':
      return <MediaPreview row={row} actions={actions} retry={retry} video={kind.kind === 'video'} />;
    case 'frame':
      if (Number(row.size) > SIZE_LIMITS[kind.renderer]) return <Card row={row} actions={actions} note="tooLarge" />;
      return (
        <FramePreview
          row={row}
          actions={actions}
          renderer={kind.renderer}
          language={kind.language}
          retry={retry}
          onEscape={onEscape}
        />
      );
    case 'office':
      return <Card row={row} actions={actions} note="office" />;
    case 'other':
      return <Card row={row} actions={actions} note="other" />;
  }
}
