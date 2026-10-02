import './PreviewPane.css';

import { CircleX, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewPaneProps } from '../app/panes';
import { Button } from '../components/Button/Button';
import { Skeleton } from '../components/Skeleton/Skeleton';
import { StateBlock } from '../components/StateBlock/StateBlock';
import { useEntry } from '../data/entries';
import { nameOf } from '../lib/paths';
import { PreviewBody } from './PreviewBody';
import { PreviewHeader } from './PreviewHeader';
import { TagRow } from './TagRow';

/**
 * A file's preview (app-shell §5; UI architecture §10): the header with the file's place and
 * actions, its tags, and the body for its type. A host view shows it for a file, with its own
 * actions and menus (`app/panes.ts`); a new file, or a new version of it, starts afresh.
 */
export function PreviewPane({ entry, onBack, moreMenu, tagMenu, actions }: PreviewPaneProps) {
  const { t } = useTranslation(['preview', 'errors']);
  const row = useEntry(entry);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [attempt, setAttempt] = useState(0);
  const data = row.data;

  let body;
  if (data === undefined && row.error !== null) {
    body = (
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
  } else if (data === undefined) {
    body = <Skeleton rows={8} />;
  } else {
    body = (
      <PreviewBody
        key={`${data.id} ${data.path} ${data.modifiedMs ?? ''} ${String(attempt)}`}
        row={data}
        actions={actions}
        retry={() => {
          setAttempt((count) => count + 1);
        }}
        onEscape={() => {
          headingRef.current?.focus();
        }}
      />
    );
  }

  return (
    <div className="preview" aria-label={t('label', { name: nameOf(entry.path) })} role="group">
      <PreviewHeader
        entry={data ?? entry}
        actions={actions}
        onBack={onBack}
        moreMenu={moreMenu}
        headingRef={headingRef}
      />
      {data !== undefined && <TagRow row={data} actions={actions} tagMenu={tagMenu} />}
      <div className="preview-body">{body}</div>
    </div>
  );
}
