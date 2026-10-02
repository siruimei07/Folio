import { ArrowLeft, Ellipsis, ExternalLink, FolderSearch } from 'lucide-react';
import type { ReactElement, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { useLayout } from '../app/layout';
import type { PreviewActions } from '../app/panes';
import { FileTypeIcon } from '../components/FileTypeIcon/FileTypeIcon';
import { IconButton } from '../components/IconButton/IconButton';
import { MenuButton } from '../components/Menu/Menu';
import { useCourses } from '../data/groups';
import type { EntryRef } from '../ipc';
import { prefixOf } from '../lib/places';
import { nameOf, parentOf } from '../lib/paths';

export interface PreviewHeaderProps {
  entry: EntryRef;
  actions: PreviewActions;
  /** Narrow window: "Back" first (app-shell §2), which calls this. */
  onBack?: () => void;
  moreMenu?: ReactElement;
  /** The header's heading, where Esc in the frame returns focus (UI architecture §10.5). */
  headingRef: Ref<HTMLHeadingElement>;
}

/**
 * The file header (app-shell §5): type icon, the course and folders above the file, its name,
 * then "Open with default app", "Show in File Explorer" and "More". "View history of this file"
 * comes with the History view in M2.
 */
export function PreviewHeader({ entry, actions, onBack, moreMenu, headingRef }: PreviewHeaderProps) {
  const { t } = useTranslation('preview');
  // The narrow window keeps Open and More (app-shell §2).
  const narrow = useLayout() === 'narrow';
  const courses = useCourses().data ?? [];
  const name = nameOf(entry.path);
  const prefix = prefixOf(parentOf(entry.path), courses);
  return (
    <header className="preview-header">
      {onBack !== undefined && <IconButton icon={ArrowLeft} label={t('header.back')} onPress={onBack} />}
      <FileTypeIcon name={name} />
      <h2 className="preview-header__title" ref={headingRef} tabIndex={-1} title={`${prefix}${name}`}>
        <span className="preview-header__path">{prefix}</span>
        <span className="preview-header__name">{name}</span>
      </h2>
      <div className="preview-header__actions">
        <IconButton
          icon={ExternalLink}
          label={t('header.open')}
          onPress={() => {
            actions.open(entry);
          }}
        />
        {!narrow && (
          <IconButton
            icon={FolderSearch}
            label={t('header.reveal')}
            onPress={() => {
              actions.showInExplorer(entry);
            }}
          />
        )}
        {moreMenu !== undefined && (
          <MenuButton placement="bottom end" trigger={<IconButton icon={Ellipsis} label={t('header.more')} />}>
            {moreMenu}
          </MenuButton>
        )}
      </div>
    </header>
  );
}
