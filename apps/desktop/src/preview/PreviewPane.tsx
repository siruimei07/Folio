import './PreviewPane.css';

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewPaneProps } from '../app/panes';
import { useEntry } from '../data/entries';
import { nameOf } from '../lib/paths';
import { PreviewFile } from './PreviewFile';
import { PreviewHeader } from './PreviewHeader';
import { TagRow } from './TagRow';

/**
 * A file's preview (app-shell §5; UI architecture §10): the header with the file's place and
 * actions, its tags, and the body for its type (`PreviewFile`). A host view shows it for a file,
 * with its own actions and menus (`app/panes.ts`); a new file, or a new version of it, starts
 * afresh.
 */
export function PreviewPane({ entry, onBack, moreMenu, tagMenu, actions }: PreviewPaneProps) {
  const { t } = useTranslation('preview');
  const row = useEntry(entry);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const data = row.data;

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
      <PreviewFile
        source={{ kind: 'entry', entry }}
        actions={actions}
        onEscape={() => {
          headingRef.current?.focus();
        }}
      />
    </div>
  );
}
