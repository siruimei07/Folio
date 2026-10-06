import './PreviewPane.css';

import { CircleX, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewFileActions, PreviewFileProps, PreviewFileSource } from '../app/panes';
import { Button } from '../components/Button/Button';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useLocatedVersion } from '../data/diff';
import { useEntry } from '../data/entries';
import { contentUrl, type EntryRef, thumbnailUrl, versionUrl } from '../ipc';
import { nameOf } from '../lib/paths';
import { previewKindOf } from './kinds';
import { type FileSource, PreviewBody } from './PreviewBody';

/** Windows' thumbnail size the preview shows for HEIC and TIFF. */
const THUMBNAIL_SIZE = 256;

/**
 * Whether the preview shows the content of a version of a file with this name, rather than a card
 * that only offers "Open with default app" (which opens the file as it is now). Word, Excel and
 * PowerPoint files get the card until their previews come; a version has no Windows thumbnail.
 */
export function showsVersion(name: string): boolean {
  const { kind } = previewKindOf(name);
  return kind !== 'office' && kind !== 'other' && kind !== 'thumbnail';
}

type VersionSource = Extract<PreviewFileSource, { kind: 'version' }>;

interface BodyProps {
  actions: PreviewFileActions;
  onEscape: () => void;
}

/**
 * The body for `file`, which starts afresh for another `version` of what it shows and on "Try
 * again" (a remount).
 */
function RetryingBody({ file, version, actions, onEscape }: BodyProps & { file: FileSource; version: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <PreviewBody
      key={`${version} ${String(attempt)}`}
      file={file}
      actions={actions}
      retry={() => {
        setAttempt((count) => count + 1);
      }}
      onEscape={onEscape}
    />
  );
}

/** A file in the library: its row, then the body, which remounts for every new version of it. */
function EntryFile({ entry, actions, onEscape }: BodyProps & { entry: EntryRef }) {
  const { t } = useTranslation(['preview', 'errors']);
  const row = useEntry(entry);
  const data = row.data;
  if (data === undefined && row.error !== null) {
    return (
      <div className="preview-state">
        <StateBlock
          tone="danger"
          icon={CircleX}
          placement="preview"
          title={t('failed.title')}
          text={t(`errors:${row.error.error.code}`)}
          actions={
            <Button
              icon={RefreshCw}
              onPress={() => {
                void row.refetch();
              }}
            >
              {t('failed.tryAgain')}
            </Button>
          }
        />
      </div>
    );
  }
  if (data === undefined) return <Skeleton rows={8} />;
  const file: FileSource = {
    kind: 'entry',
    name: data.name,
    size: data.size,
    url: contentUrl(data),
    entry: { id: data.id, path: data.path },
    thumbnail: thumbnailUrl(data, THUMBNAIL_SIZE),
  };
  return (
    <RetryingBody
      file={file}
      version={`${data.id} ${data.path} ${data.modifiedMs ?? ''}`}
      actions={actions}
      onEscape={onEscape}
    />
  );
}

/**
 * A version stored in history: its bytes from the version route, and the file it belongs to now
 * (`locate_version`) for "Open with default app" and a note's images. The body waits for that
 * lookup, so Open does not appear under it later and a note's first images are not answered
 * missing. A lookup that fails shows the version without Open: what makes it fail (an undone
 * commit, a damaged history) fails the version route too, whose failure says why.
 */
function VersionFile({ version, side, actions, onEscape }: BodyProps & Omit<VersionSource, 'kind'>) {
  const located = useLocatedVersion(version);
  const row = located.data;
  if (row === undefined && located.error === null) return <Skeleton rows={8} />;
  const name = nameOf(version.path);
  const file: FileSource = {
    kind: 'version',
    name,
    size: side.size,
    url: versionUrl(side, name),
    entry: row === undefined || row === null ? null : { id: row.id, path: row.path },
    thumbnail: null,
  };
  return <RetryingBody file={file} version={`${side.hash} ${name}`} actions={actions} onEscape={onEscape} />;
}

/**
 * A file's preview without its header and tags (UI architecture §10): a skeleton while the file is
 * looked up, why it failed, or the body for its type. The body of `PREVIEW_PANE`, and "This version"
 * in the diff pane (handoff workspace-history §6.7), through `PREVIEW_FILE` in `app/panes.ts`. It
 * fills its host, which lays it out as a flex item of a column with a height.
 */
export function PreviewFile({ source, actions, onEscape }: PreviewFileProps) {
  return (
    <div className="preview-body">
      {source.kind === 'entry' ? (
        <EntryFile entry={source.entry} actions={actions} onEscape={onEscape} />
      ) : (
        <VersionFile version={source.version} side={source.side} actions={actions} onEscape={onEscape} />
      )}
    </div>
  );
}
